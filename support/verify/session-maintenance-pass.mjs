import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, utimes } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import JSON5 from "json5";
import { resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { abortable, CallError, readOperation } from "./background.mjs";
import { executeGatewayCall } from "./gateway-call.mjs";
import { gatewayLifecycleMain } from "./gateway-lifecycle.mjs";
import { disposableEnv } from "./helper.mjs";
import { entrypoint } from "./script.mjs";

const DAY = 86400000;
const MAX_ROWS = 20000;
const MAX_FILLERS = 2048;
const RESTORE_MS = 120000;
const PRESSURE_BYTES = 8 * 1024 * 1024;
const active = (entry) => entry?.archivedAt === undefined;
const activity = (entry) => Math.max(...["updatedAt", "lastInteractionAt", "lastActivityAt", "sessionStartedAt"].map((field) => entry?.[field] ?? 0));
const oldFields = (time) => Object.fromEntries(["updatedAt", "lastInteractionAt", "lastActivityAt", "sessionStartedAt"].map((field) => [field, time]));
const warnMaintenance = { mode: "warn", maxEntries: MAX_ROWS, pruneAfterMs: 1000000 * DAY, archiveDashboardAfterMs: null, modelRunPruneAfterMs: DAY, preserveRecentMs: null, resetArchiveRetentionMs: null, maxDiskBytes: null, highWaterBytes: null };

async function statOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function ownedPath(root, path, { directory = false, optional = false } = {}) {
  const suffix = relative(root, path);
  if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new CallError("maintenance path is outside the selected clone");
  let current = root;
  const parts = suffix.split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await statOrNull(current);
    if (!stat && optional) return path;
    if (!stat || stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) throw new CallError("maintenance requires regular, unaliased clone files");
  }
  return path;
}

export async function inspectMaintenanceTarget(options, runtime) {
  if (resolveOcmTransport()) throw new CallError("maintenance must run on the selected clone's host");
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.env !== options.env || operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || !operation.handle?.ref) throw new CallError("maintenance requires the selected environment's foreground Gateway handle");
  const ref = operation.handle.ref;
  if (!isAbsolute(runtime.root ?? "") || resolve(ref.root ?? "") !== resolve(runtime.root) || resolve(ref.configPath ?? "") !== resolve(runtime.configPath) || ref.port !== runtime.gatewayPort) throw new CallError("Gateway handle and selected runtime differ");
  if ((await lstat(runtime.root)).isSymbolicLink()) throw new CallError("clone root cannot be a symbolic link");
  const root = await realpath(runtime.root);
  const state = join(root, ".openclaw"), configPath = join(state, "openclaw.json");
  if (await realpath(runtime.configPath) !== configPath) throw new CallError("maintenance requires the clone's default configuration path");
  await ownedPath(root, configPath);
  const db = join(state, "agents", options.agent, "agent", "openclaw-agent.sqlite");
  await ownedPath(root, db);
  for (const suffix of ["-wal", "-shm", "-journal"]) await ownedPath(root, `${db}${suffix}`, { optional: true });
  const sessions = join(state, "agents", options.agent, "sessions");
  await ownedPath(root, sessions, { directory: true, optional: true });
  return { root, state, configPath, db, sessions, agentId: options.agent, runtime };
}

function parseConfig(bytes, target) {
  let config;
  try { config = JSON5.parse(bytes.toString("utf8")); } catch { throw new CallError("invalid clone configuration"); }
  if (!config || typeof config !== "object" || Array.isArray(config) || JSON.stringify(config).includes('"$include"')) throw new CallError("maintenance requires directly authored configuration");
  const store = config.session?.store;
  if (store !== undefined && (typeof store !== "string" || !isAbsolute(store) || ![target.db, join(target.sessions, "sessions.json")].includes(store.replaceAll("{agentId}", target.agentId)))) throw new CallError("maintenance does not support a shared or custom session store");
  return config;
}

// The foreground Gateway is stopped for every write. Original bytes remain
// only in memory, including JSON5 comments and any authentication settings.
async function replaceConfig(target, bytes) {
  await ownedPath(target.root, target.configPath);
  const file = await open(target.configPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

export async function readMaintenanceRows(target) {
  await ownedPath(target.root, target.db);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(target.db, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    const rows = new Map();
    let bytes = 0;
    for (const row of db.prepare(`SELECT session_key, current_session_id,
      length(CAST(entry_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(entry_json AS BLOB)) <= 131072 THEN entry_json END AS entry_json
      FROM session_nodes LIMIT ?`).iterate(MAX_ROWS + 1)) {
      if (rows.size >= MAX_ROWS || !Number.isSafeInteger(row.bytes) || row.bytes > 131072 || (bytes += row.bytes) > 64 * 1024 * 1024) throw new CallError("session metadata exceeds the maintenance observation bound");
      const entry = JSON.parse(row.entry_json);
      if (!entry || !entry.sessionId || entry.sessionId !== row.current_session_id || (row.session_key !== "global" && row.session_key !== "unknown" && !row.session_key.startsWith(`agent:${target.agentId}:`))) throw new CallError("session metadata has an unexpected identity");
      rows.set(row.session_key, entry);
    }
    return rows;
  } finally { db.close(); }
}

async function runFixtureWorker(target, operations, controls) {
  controls.remaining();
  const worker = new Worker(new URL(import.meta.url), {
    execArgv: [], stdout: true, stderr: true,
    env: { ...process.env, OPENCLAW_HOME: target.root, OPENCLAW_STATE_DIR: target.state, OPENCLAW_CONFIG_PATH: target.configPath, OPENCLAW_LOG_LEVEL: "silent", OPENCLAW_GATEWAY_TOKEN: "", OPENCLAW_GATEWAY_PASSWORD: "" },
    workerData: { maintenanceFixtures: true, target, operations }
  });
  worker.stdout.resume(); worker.stderr.resume();
  try {
    await abortable(new Promise((accept, reject) => {
      worker.once("message", (message) => message.ok ? accept() : reject(new CallError("selected runtime could not apply maintenance fixtures")));
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new CallError(`maintenance fixture worker ended before its result (${code})`)));
    }), controls.signal);
  } finally { await worker.terminate(); }
}

async function applyFixtures({ target, operations }) {
  const packagePath = join(dirname(await realpath(target.runtime.binaryPath)), "package.json");
  if (JSON.parse(await readFile(packagePath, "utf8")).name !== "openclaw") throw new Error("selected runtime is not OpenClaw");
  const sdkPath = await realpath(createRequire(packagePath).resolve("openclaw/plugin-sdk/session-store-runtime"));
  const within = relative(dirname(packagePath), sdkPath);
  if (within.startsWith("..") || isAbsolute(within)) throw new Error("session SDK is outside the selected runtime");
  const sdk = await import(pathToFileURL(sdkPath).href);
  if (typeof sdk.patchSessionEntry !== "function" || typeof sdk.deleteSessionEntry !== "function") throw new Error("selected runtime lacks session fixture support");
  for (const item of operations) {
    if (!item.key.startsWith(`agent:${target.agentId}:`) || !item.key.includes(`kova-maintenance-${item.id}-`) || !item.label.startsWith(`kova-maintenance-${item.id}-`) || !item.sessionId) throw new Error("invalid maintenance fixture identity");
    const params = { agentId: target.agentId, sessionKey: item.key, storePath: target.db, env: process.env };
    if (item.remove) {
      if (!await sdk.deleteSessionEntry({ ...params, expectedSessionId: item.sessionId, archiveTranscript: false })) throw new Error("maintenance fixture deletion failed");
    } else {
      const result = await sdk.patchSessionEntry({
        ...params, maintenanceConfig: warnMaintenance, replaceEntry: true, skipMaintenance: true, requireWriteSuccess: true,
        update(entry) {
          if (entry.sessionId !== item.sessionId || entry.label !== item.label) throw new Error("maintenance fixture identity changed");
          return { ...entry, ...item.fields };
        }
      });
      if (result?.sessionId !== item.sessionId) throw new Error("maintenance fixture replacement failed");
    }
  }
}

// Match the pinned SQLite accounting boundary: main/WAL, session files, cold
// archives and prompt blobs. No file contents are read or returned.
export async function maintenanceDiskBytes(target) {
  let bytes = 0, count = 0, oldest = Date.now();
  const add = async (path) => {
    const stat = await statOrNull(path);
    if (!stat) return;
    await ownedPath(target.root, path);
    if (++count > 20000) throw new CallError("session artifact inventory exceeds the observation bound");
    bytes += stat.size; oldest = Math.min(oldest, stat.mtimeMs);
  };
  const files = async (path, predicate = () => true) => {
    if (!await statOrNull(path)) return;
    await ownedPath(target.root, path, { directory: true });
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new CallError("session artifacts cannot use symbolic links");
      if (item.isFile() && predicate(item.name) && !/\.migrated(?:\.\d+)?$|\.jsonl\.pre-doctor-(?:branch|openai-codex)-repair-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/u.test(item.name)) await add(join(path, item.name));
    }
  };
  await add(target.db); await add(`${target.db}-wal`);
  await files(target.sessions); await files(join(target.sessions, "cold"));
  const prompts = join(target.sessions, "skills-prompts", "sha256");
  if (await statOrNull(prompts)) {
    await ownedPath(target.root, prompts, { directory: true });
    for (const prefix of await readdir(prompts)) if (/^[a-f0-9]{2}$/.test(prefix)) await files(join(prompts, prefix), (name) => /^[a-f0-9]{64}\.txt(?:\.(?:\d+\.)?[a-f0-9-]{36}\.tmp)?$/.test(name));
  }
  return { bytes, oldest };
}

async function pressureArchive(target, source, before) {
  await mkdir(target.sessions, { recursive: true, mode: 0o700 });
  await ownedPath(target.root, target.sessions, { directory: true });
  const time = before.oldest - DAY;
  const stamp = new Date(time).toISOString().replaceAll(":", "-");
  const path = join(target.sessions, `${source.sessionId}.jsonl.reset.${stamp}`);
  const file = await open(path, "wx", 0o600);
  try {
    let bytes = 0, parentId = null;
    const append = async (event) => { const line = `${JSON.stringify(event)}\n`; await file.write(line); bytes += Buffer.byteLength(line); };
    await append({ type: "session", version: 3, id: source.sessionId, timestamp: new Date(time).toISOString(), cwd: target.root });
    for (let index = 0; bytes < PRESSURE_BYTES; index++) {
      const id = `maintenance-${index}`;
      await append({ type: "message", id, parentId, timestamp: new Date(time).toISOString(), message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: "KOVA_RETAINED_NOTE ".repeat(2048) }] } });
      parentId = id;
    }
    await file.sync();
    await utimes(path, new Date(time), new Date(time));
  } catch (error) {
    await file.close();
    await rm(path);
    throw error;
  } finally { await file.close(); }
  return path;
}

export function maintenanceCapSize(activeCount) {
  if (!Number.isSafeInteger(activeCount) || activeCount < 1 || activeCount >= MAX_ROWS) throw new CallError("invalid active session count");
  const fillers = Math.max(25, Math.ceil(activeCount * 0.1)) + 1;
  if (fillers > MAX_FILLERS || activeCount + fillers >= MAX_ROWS) throw new CallError("fresh cap candidates exceed the maintenance fixture bound");
  return { maxEntries: activeCount, fillers };
}

export async function runMaintenancePass(options, context, dependencies = {}) {
  const remainingAtStart = context.remaining();
  if (remainingAtStart <= RESTORE_MS + 1000) throw new CallError("maintenance requires time for fixture preparation and exact policy restoration", 3);
  const end = Date.now() + remainingAtStart;
  const workSignal = AbortSignal.any([context.signal, AbortSignal.timeout(remainingAtStart - RESTORE_MS)]);
  const controls = { signal: workSignal, remaining() { workSignal.throwIfAborted(); return Math.max(1, end - RESTORE_MS - Date.now()); } };
  const target = await (dependencies.inspect ?? inspectMaintenanceTarget)(options, context.runtime());
  const readRows = () => (dependencies.readRows ?? readMaintenanceRows)(target);
  const fixtures = (items, control = controls) => (dependencies.fixtures ?? runFixtureWorker)(target, items, control);
  const bytes = () => (dependencies.diskBytes ?? maintenanceDiskBytes)(target);
  const rpc = async (method, params) => {
    controls.remaining();
    if (dependencies.rpc) return dependencies.rpc(method, params, controls);
    const result = await executeGatewayCall({ env: options.env, method, params, timeoutMs: controls.remaining() }, { signal: controls.signal, prepare: () => target.runtime });
    if (result.exitCode || result.output.error) throw new CallError(result.output.error ?? "Gateway request failed", result.exitCode || 1);
    return result.output.result;
  };
  let paused = false, original, config, expectedConfig, pressure;
  const id = randomUUID(), prefix = `kova-maintenance-${id}-`;
  const output = { mode: options["disk-budget"] ? "disk-budget" : "ordinary", agentId: options.agent, createdIds: [], observations: null, policyRestored: false, fixturesRemoved: false, gatewayReady: false };
  context.record(output);
  const lifecycle = async (action, control = controls) => {
    const result = await (dependencies.lifecycle ?? gatewayLifecycleMain)([action, "--env", options.env, "--gateway-handle", options["gateway-handle"], "--timeout", String(control.remaining())], { signal: control.signal });
    const state = result.output?.result;
    if (result.exitCode !== 0 || result.output?.error !== null || (action === "pause" ? state?.paused !== true : state?.ready !== true) || state?.refused === true) throw new CallError(result.output?.error ?? `Gateway ${action} was not confirmed`, result.exitCode || 1);
    paused = action === "pause";
    output.gatewayReady = !paused;
  };
  const setPolicy = async (overrides) => {
    if (!paused) throw new Error("maintenance policy requires a paused Gateway");
    const current = await readFile(target.configPath);
    if (!current.equals(expectedConfig)) throw new CallError("clone configuration changed during maintenance");
    const next = { ...config, session: { ...config.session, maintenance: { ...config.session?.maintenance, coldStorage: { enabled: false }, mode: "warn", maxEntries: MAX_ROWS, pruneAfter: "1000000d", archiveDashboardAfter: false, preserveRecent: false, resetArchiveRetention: false, maxDiskBytes: false, ...overrides } } };
    expectedConfig = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    await replaceConfig(target, expectedConfig);
  };
  const create = async (name, dashboard = false) => {
    const item = { id, key: `agent:${options.agent}:${dashboard ? "dashboard:" : ""}${prefix}${name}`, label: `${prefix}${name}` };
    const result = await rpc("sessions.create", { agentId: options.agent, key: item.key, label: item.label });
    if (result?.key !== item.key || typeof result.sessionId !== "string" || !result.sessionId) throw new CallError("fresh maintenance session has no exact identity");
    item.sessionId = result.sessionId;
    output.createdIds.push(item.key, item.sessionId); context.record(output);
    return item;
  };
  const entry = (rows, item) => {
    const found = rows.get(item.key);
    if (found?.sessionId !== item.sessionId) throw new CallError("maintenance candidate identity changed or disappeared");
    return found;
  };
  const pinnedIntact = (rows, pin) => {
    const value = entry(rows, pin);
    if (!active(value) || !Number.isFinite(value.pinnedAt) || value.pinnedAt <= 0) throw new CallError("maintenance did not preserve the pinned control");
  };
  const observe = async (predicate) => {
    for (;;) {
      controls.remaining();
      const value = await predicate();
      if (value) return value;
      await sleep(100, undefined, { signal: controls.signal });
    }
  };
  let failure;
  try {
    await lifecycle("pause");
    original = await readFile(target.configPath); expectedConfig = original;
    config = parseConfig(original, target);
    await setPolicy({});
    await lifecycle("resume");
    const pin = await create("pinned");
    await rpc("sessions.patch", { agentId: options.agent, key: pin.key, expectedSessionId: pin.sessionId, pinned: true });
    if (options["disk-budget"]) {
      const victim = await create("victim"), source = await create("archive");
      await lifecycle("pause");
      const baseline = await bytes();
      pressure = await (dependencies.pressureArchive ?? pressureArchive)(target, source, baseline);
      const maxDiskBytes = baseline.bytes + PRESSURE_BYTES / 2;
      await setPolicy({ mode: "enforce", maxDiskBytes, highWaterBytes: baseline.bytes + PRESSURE_BYTES / 4 });
      await lifecycle("resume");
      const before = await bytes(), rows = await readRows();
      pinnedIntact(rows, pin); entry(rows, victim); entry(rows, source);
      const pressureBefore = await lstat(pressure);
      if (!pressureBefore.isFile() || pressureBefore.isSymbolicLink() || pressureBefore.size < PRESSURE_BYTES || before.bytes <= maxDiskBytes) throw new CallError("fresh disk pressure is absent before session deletion");
      const removed = await rpc("sessions.delete", { agentId: options.agent, key: victim.key, expectedSessionId: victim.sessionId, deleteTranscript: true });
      if (removed?.ok !== true || removed.deleted !== true) throw new CallError("fresh disk-budget victim was not deleted");
      const after = await observe(async () => {
        const current = await readRows(); pinnedIntact(current, pin); entry(current, source);
        if (current.has(victim.key)) throw new CallError("deleted victim is still present");
        if (await statOrNull(pressure)) return null;
        const measured = await bytes();
        return measured.bytes < before.bytes ? measured : null;
      });
      output.observations = { trigger: "sessions.delete", victimKey: victim.key, victimSessionId: victim.sessionId, pressureSessionId: source.sessionId, pressureArchive: pressure.split(sep).at(-1), pressureBytes: pressureBefore.size, bytesBefore: before.bytes, bytesAfter: after.bytes, maxDiskBytes, nonVictimReclaimed: true, pinnedKey: pin.key, pinnedPreserved: true };
    } else {
      const age = await create("age"), dashboard = await create("dashboard", true), trigger = await create("write");
      await lifecycle("pause");
      const now = Date.now();
      await fixtures([{ ...age, fields: oldFields(now - 60 * DAY) }, { ...dashboard, fields: oldFields(now - 10 * DAY) }, { ...pin, fields: oldFields(now - 60 * DAY) }]);
      await setPolicy({ mode: "enforce", pruneAfter: "30d", archiveDashboardAfter: "7d" });
      await lifecycle("resume");
      const before = await readRows(); pinnedIntact(before, pin);
      if (!active(entry(before, age)) || !active(entry(before, dashboard))) throw new CallError("fresh age candidates changed before the ordinary write");
      await rpc("sessions.patch", { agentId: options.agent, key: trigger.key, expectedSessionId: trigger.sessionId, label: `${trigger.label}-age-trigger` });
      await observe(async () => {
        const rows = await readRows(); pinnedIntact(rows, pin);
        const a = entry(rows, age), d = entry(rows, dashboard);
        if ((!active(a) && a.archiveReason !== "age-retention") || (!active(d) && d.archiveReason !== "stale-dashboard")) throw new CallError("fresh candidates were archived for a different reason");
        return !active(a) && !active(d);
      });
      await lifecycle("pause"); await setPolicy({}); await lifecycle("resume");
      const baselineRows = await readRows();
      const baseline = new Map([...baselineRows].filter(([, value]) => active(value)).map(([key, value]) => [key, value.sessionId]));
      if ([...baselineRows.values()].some((value) => active(value) && activity(value) < 1)) throw new CallError("existing session activity cannot be ordered ahead of fresh cap candidates");
      const cap = maintenanceCapSize(baseline.size), fillers = [];
      for (let index = 0; index < cap.fillers; index++) fillers.push(await create(`cap-${index}`));
      await lifecycle("pause");
      await fixtures(fillers.map((item) => ({ ...item, fields: oldFields(1) })));
      await setPolicy({ mode: "enforce", maxEntries: cap.maxEntries });
      await lifecycle("resume");
      const capBefore = await readRows(); pinnedIntact(capBefore, pin);
      if (fillers.some((item) => !active(entry(capBefore, item)))) throw new CallError("fresh cap candidates changed before the ordinary write");
      for (const [key, sessionId] of baseline) if (capBefore.get(key)?.sessionId !== sessionId || !active(capBefore.get(key))) throw new CallError("existing active sessions changed during cap preparation");
      if ([...capBefore.values()].filter(active).length < cap.maxEntries + cap.fillers) throw new CallError("fresh candidates do not establish cap pressure");
      await rpc("sessions.patch", { agentId: options.agent, key: trigger.key, expectedSessionId: trigger.sessionId, label: `${trigger.label}-cap-trigger` });
      const capAfter = await observe(async () => {
        const rows = await readRows(); pinnedIntact(rows, pin);
        for (const [key, sessionId] of baseline) if (rows.get(key)?.sessionId !== sessionId || !active(rows.get(key))) throw new CallError("cap maintenance changed a pre-existing active session");
        const candidates = fillers.map((item) => entry(rows, item));
        if (candidates.some((value) => !active(value) && value.archiveReason !== "active-session-cap")) throw new CallError("fresh cap candidate was archived for a different reason");
        return candidates.every((value) => !active(value)) ? rows : null;
      });
      output.observations = { trigger: "sessions.patch", ageKey: age.key, ageReason: "age-retention", dashboardKey: dashboard.key, dashboardReason: "stale-dashboard", capCandidates: fillers.length, capReason: "active-session-cap", maxEntries: cap.maxEntries, activeBefore: [...capBefore.values()].filter(active).length, activeAfter: [...capAfter.values()].filter(active).length, existingActivePreserved: true, pinnedKey: pin.key, pinnedPreserved: true };
    }
    context.record(output);
  } catch (error) { failure = error; }
  finally {
    const restoreSignal = AbortSignal.timeout(Math.max(1, end - Date.now()));
    const restore = { signal: restoreSignal, remaining() { restoreSignal.throwIfAborted(); return Math.max(1, end - Date.now()); } };
    const errors = [];
    try { if (!paused) await lifecycle("pause", restore); } catch { errors.push("Gateway pause was not confirmed for restoration"); }
    if (paused && original) {
      try {
        // Cleanup uses warning mode and exact fresh identities. It runs only
        // after observations have been captured, including on a failed check.
        await setPolicy({});
        const rows = await readRows();
        const leftovers = [...rows].filter(([key]) => key.startsWith(`agent:${options.agent}:`) && key.includes(prefix)).map(([key, value]) => ({ id, key, label: value.label, sessionId: value.sessionId, remove: true }));
        await fixtures(leftovers, restore);
        if (pressure && await statOrNull(pressure)) { await ownedPath(target.root, pressure); await rm(pressure); }
        output.fixturesRemoved = ![...(await readRows()).keys()].some((key) => key.includes(prefix));
        if (!output.fixturesRemoved) throw new Error("fresh maintenance sessions remain");
      } catch { errors.push("fresh maintenance fixture cleanup failed"); }
      try { await replaceConfig(target, original); output.policyRestored = (await readFile(target.configPath)).equals(original); if (!output.policyRestored) throw new Error(); }
      catch { errors.push("exact maintenance configuration restoration failed"); }
    }
    if (paused && (!original || output.policyRestored)) {
      try { await lifecycle("resume", restore); } catch { errors.push("Gateway resume was not confirmed after restoration"); }
    }
    if (original && output.gatewayReady) {
      try {
        output.policyRestored = (await readFile(target.configPath)).equals(original);
        if (!output.policyRestored) errors.push("configuration changed while the restored Gateway resumed");
      } catch { output.policyRestored = false; errors.push("restored configuration could not be confirmed"); }
    }
    context.record(output);
    if (errors.length) {
      if (!failure) failure = new CallError("maintenance restoration failed");
      failure.cleanupError = errors.join("; ");
    }
  }
  if (failure) throw failure;
  return output;
}

export const definition = {
  id: "session-maintenance-pass", url: import.meta.url, timeoutMs: 1200000,
  flags: ["env", "agent", "gateway-handle", "disk-budget", "out", "timeout"], booleans: ["disk-budget"],
  empty: () => ({ mode: null, agentId: null, createdIds: [], observations: null, policyRestored: false, fixturesRemoved: false, gatewayReady: false }),
  validate(options) {
    disposableEnv(options);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.agent ?? "")) throw new CallError("--agent requires a canonical agent id");
    if (!options["gateway-handle"]) throw new CallError("--gateway-handle is required");
  },
  run: runMaintenancePass
};

if (!isMainThread && workerData?.maintenanceFixtures) {
  try { await applyFixtures(workerData); parentPort.postMessage({ ok: true }); }
  catch { parentPort.postMessage({ ok: false }); }
} else await entrypoint(definition);
