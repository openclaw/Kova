import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import JSON5 from "json5";
import { resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { openDirectGatewayRpcClient } from "../openclaw-runtime.mjs";
import { abortable, atomicJson, CallError, readOperation } from "./background.mjs";
import { entrypoint, nonempty, object } from "./script.mjs";

const cloneName = /^kova-(?:helpers|run)-[a-z0-9][a-z0-9-]*$/i;
const sourceKey = /^agent:([a-z0-9][a-z0-9_-]{0,63}):dashboard:([a-f0-9-]{36})$/;
const empty = () => ({ sessionKey: null, sessionId: null, restartRecoveryStatus: null, createdIds: [], elapsedMs: 0, error: null });
export const recoveryMinimumTimeoutMs = 40000;
// Reserve both the temporary process stop and a restored startup, including stop
// after a failed startup. Owned process termination has two three-second waits.
const restorationReserveMs = 30000;
const processStopReserveMs = 7000;
const resultReserveMs = 1000;

async function optionalRecord(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function recoveryStartupTimeout(request, maximumMs, now = Date.now()) {
  const remaining = request.options.overallExpiresAt - now - processStopReserveMs;
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new CallError("recovery restoration timeout", 3);
  return Math.min(maximumMs, remaining);
}

export async function requestRecovery(options, { signal, now = Date.now } = {}) {
  const startedAt = now();
  if (options.timeoutMs < recoveryMinimumTimeoutMs) throw new CallError(`recovery requires at least ${recoveryMinimumTimeoutMs}ms to reserve time for restoration`, 3);
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || operation.env !== options.env || !operation.handle) throw new CallError("recovery requires the selected environment's foreground Gateway handle");
  if (await optionalRecord(join(operation.directory, "result.json"))) throw new CallError("Gateway operation has already ended");
  const overallExpiresAt = Math.min(startedAt + options.timeoutMs, Date.parse(operation.expiresAt)) - resultReserveMs;
  if (!Number.isSafeInteger(overallExpiresAt) || overallExpiresAt - now() < restorationReserveMs + processStopReserveMs) throw new CallError("insufficient Gateway lifetime for recovery and restoration", 3);
  const id = randomUUID();
  const path = join(operation.directory, "fixture-request.json");
  const resultPath = join(operation.directory, `fixture-result-${id}.json`);
  const cancelPath = join(operation.directory, `fixture-cancel-${id}.json`);
  const cancel = () => atomicJson(cancelPath, { cancelled: true });
  let completed = false, cancellation;
  signal?.throwIfAborted();
  try {
    await atomicJson(path, {
      id, options: { ...options, overallExpiresAt }, expiresAt: overallExpiresAt - restorationReserveMs
    }, { exclusive: true });
  } catch (error) { if (error.code === "EEXIST") throw new CallError("another fixture request is pending"); throw error; }
  try {
    for (;;) {
      const result = await optionalRecord(resultPath);
      if (result) {
        completed = true;
        await unlink(resultPath);
        if (cancellation || signal?.aborted) {
          const error = cancellation ?? signal.reason;
          error.operationResult = result;
          throw error;
        }
        if (now() >= overallExpiresAt) throw new CallError("recovery overall timeout", 3);
        return result;
      }
      if (signal?.aborted && !cancellation) {
        cancellation = signal.reason ?? new CallError("recovery request interrupted", 1);
        await cancel();
      }
      if (await optionalRecord(join(operation.directory, "result.json"))) throw new Error("Gateway ended before the recovery result");
      if (now() >= overallExpiresAt) throw new CallError("recovery overall timeout; owner cleanup was not confirmed", 3);
      await sleep(Math.min(50, Math.max(1, overallExpiresAt - now())));
    }
  } finally { if (!completed) await cancel(); }
}

export function recoveryFailure(error, startedAt = Date.now(), createdIds = []) {
  return {
    output: { ...empty(), createdIds, elapsedMs: Date.now() - startedAt, error: error?.message ?? String(error) },
    exitCode: error?.exitCode ?? (error?.name === "TimeoutError" ? 3 : 1)
  };
}

export function recoverySource(record) {
  if (record?.method !== "sessions.create" || record.error !== null || record.result?.ok !== true || record.result.runStarted !== false) throw new CallError("--session-from requires a successful sessions.create without an initial turn");
  const { key, sessionId } = record.result;
  const match = typeof key === "string" && sourceKey.exec(key);
  if (!match || !nonempty(sessionId) || !Array.isArray(record.createdIds) || !record.createdIds.includes(key) || !record.createdIds.includes(sessionId)) throw new CallError("--session-from must identify a newly generated root session");
  if (record.result.sessionKey !== undefined && record.result.sessionKey !== key) throw new CallError("--session-from contains conflicting session keys");
  return { key, sessionId, agentId: match[1] };
}

/**
 * Prepare a native restart tombstone without editing session storage. On
 * OpenClaw 2026.9.9, SIGKILL during a streaming turn recovered automatically,
 * while model-policy denial cleared recovery ownership before retries exhausted.
 * Use a temporary regular-file workspace to fail ensureAgentWorkspace before
 * command execution starts, retaining interrupted ownership for native retries.
 * Only the selected clone agent's configuration changes; its original workspace
 * is untouched.
 * Restore exact configuration and remove the file before the healthy startup.
 */
export const definition = {
  id: "restart-for-recovery", url: import.meta.url,
  flags: ["env", "session-from", "gateway-handle", "out", "timeout"], empty,
  validate(options) {
    if (!cloneName.test(options.env)) throw new CallError("--env must name a disposable kova-helpers-* or kova-run-* clone");
    for (const flag of ["session-from", "gateway-handle", "out", "timeout"]) if (!options[flag]) throw new CallError(`--${flag} is required`);
  },
  async run(options, context) {
    const source = recoverySource(await context.read(options["session-from"]));
    let result;
    try { result = await (context.requestRecovery ?? requestRecovery)({
      env: options.env, "gateway-handle": options["gateway-handle"], operation: "restart-for-recovery",
      source, timeoutMs: context.remaining()
    }, { signal: context.signal }); } catch (error) {
      context.record({ createdIds: error.operationResult?.output?.createdIds ?? [] });
      throw error;
    }
    if (result.exitCode !== 0 || result.output?.error !== null) {
      const error = new CallError(result.output?.error ?? "recovery preparation failed", result.exitCode || 1);
      error.output = { createdIds: result.output?.createdIds ?? [] };
      throw error;
    }
    const observed = result.output;
    if (observed.sessionKey !== source.key || observed.sessionId !== source.sessionId || observed.restartRecoveryStatus !== "tombstoned" || !Array.isArray(observed.createdIds) || !observed.createdIds.every(nonempty)) throw new Error("recovery result does not match the created source");
    context.remaining();
    return { sessionKey: source.key, sessionId: source.sessionId, restartRecoveryStatus: "tombstoned", createdIds: observed.createdIds };
  }
};

async function regularConfig(runtime) {
  if (resolveOcmTransport()) throw new CallError("recovery preparation must run on the selected clone's host");
  if (typeof runtime?.root !== "string" || !isAbsolute(runtime.root)) throw new CallError("Gateway is missing its clone root");
  const configPath = resolve(runtime.configPath ?? join(runtime.root, ".openclaw/openclaw.json"));
  if (configPath !== join(resolve(runtime.root), ".openclaw/openclaw.json")) throw new CallError("recovery requires the clone's default configuration path");
  for (const path of [runtime.root, dirname(configPath), configPath]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (path === configPath ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new CallError("recovery configuration cannot use symbolic or hard links");
  }
  return { configPath, mode: (await lstat(configPath)).mode & 0o777 };
}

async function replaceConfig(path, bytes, mode) {
  const temporary = join(dirname(path), `.kova-recovery-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function withRecoveryControls(request, runtime, context, dependencies, callback) {
  const expired = new AbortController();
  const timeout = setTimeout(() => expired.abort(new CallError("recovery preparation timeout", 3)), Math.max(1, request.expiresAt - Date.now()));
  const signal = AbortSignal.any([context.signal, expired.signal]);
  let checking = false;
  const check = async () => {
    if (checking || signal.aborted) return;
    checking = true;
    try {
      await lstat(join(context.operation.directory, `fixture-cancel-${request.id}.json`));
      expired.abort(new CallError("recovery request interrupted", 1));
    } catch (error) { if (error.code !== "ENOENT") expired.abort(error); }
    finally { checking = false; }
  };
  const poll = setInterval(check, 50);
  let connection;
  const controls = {
    signal,
    remaining() {
      signal.throwIfAborted();
      if (Date.now() >= request.expiresAt) throw new CallError("recovery preparation timeout", 3);
      return Math.max(1, request.expiresAt - Date.now());
    },
    async connect() {
      if (!connection) {
        const opening = (dependencies.connect ?? openDirectGatewayRpcClient)(runtime, { timeoutMs: controls.remaining(), authFromRuntimeConfig: true });
        opening.then((value) => { if (signal.aborted) value.client.close(); }, () => {});
        connection = await abortable(opening, signal);
      }
      return connection.client;
    },
    async rpc(method, params) {
      const client = await controls.connect();
      return await abortable(client.request(method, params, { timeoutMs: controls.remaining() }), signal, () => client.close());
    },
    async pause() { await sleep(Math.min(100, controls.remaining()), undefined, { signal }); }
  };
  try { await check(); controls.remaining(); return await callback(controls); }
  catch (error) { throw signal.aborted ? signal.reason : error; }
  finally { clearTimeout(timeout); clearInterval(poll); connection?.client.close(); }
}

function exactSource(row, source) {
  if (row?.key !== source.key || row.sessionId !== source.sessionId || row.agentId !== source.agentId) throw new Error("recovery source identity changed");
  if (row.archived === true || row.archivedAt != null || row.parentSessionKey || row.spawnedBy || row.incognito === true || row.modelSelectionLocked === true) throw new CallError("recovery requires an unarchived ordinary root session");
  return row;
}

async function describe(controls, source) {
  return exactSource((await controls.rpc("sessions.describe", { key: source.key, agentId: source.agentId }))?.session, source);
}

function mockModel(config, row) {
  const provider = config.models?.providers?.[row.modelProvider];
  let url;
  try { url = new URL(provider?.baseUrl); } catch { throw new CallError("recovery requires a configured loopback mock model"); }
  const model = provider.models?.find((item) => item.id === row.model);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || !["openai-responses", "openai-completions"].includes(provider.api) || !model || !["input", "output", "cacheRead", "cacheWrite"].every((name) => model.cost?.[name] === 0)) throw new CallError("recovery requires a configured loopback mock model");
}

export async function prepareRecoveryRequest(request, runtime, context, dependencies = {}) {
  const startedAt = Date.now();
  const createdIds = [];
  let prepared;
  try {
    if (!cloneName.test(request.options?.env)) throw new CallError("recovery requires a disposable Kova clone");
    if (!Number.isSafeInteger(request.options.overallExpiresAt) || request.expiresAt > request.options.overallExpiresAt - restorationReserveMs) throw new CallError("recovery request must reserve time for restoration");
    const source = object(request.options.source, "recovery source");
    const match = typeof source.key === "string" && sourceKey.exec(source.key);
    if (!match || match[1] !== source.agentId || !nonempty(source.sessionId)) throw new CallError("invalid recovery source identity");
    const selected = await regularConfig(runtime);
    const original = await readFile(selected.configPath);
    let config;
    try { config = object(JSON5.parse(original.toString("utf8")), "clone configuration"); }
    catch { throw new CallError("invalid clone configuration"); }
    if (JSON.stringify(config).includes('"$include"')) throw new CallError("recovery requires directly authored configuration");
    const modified = structuredClone(config);
    modified.agents ??= {};
    modified.agents.entries ??= {};
    const agent = modified.agents.entries[source.agentId] ??= {};
    const blockerPath = join(dirname(selected.configPath), `.kova-recovery-${request.id}.workspace-blocker`);
    agent.workspace = blockerPath;
    prepared = { ...selected, original, modified: Buffer.from(`${JSON.stringify(modified, null, 2)}\n`), blockerPath, source, createdIds, startedAt };
    return await withRecoveryControls(request, runtime, context, dependencies, async (controls) => {
      const row = await describe(controls, source);
      if (row.restartRecoveryStatus || row.lastRunId || row.status && row.status !== "idle") throw new CallError("recovery source has already run");
      mockModel(config, row);
      const history = await controls.rpc("chat.history", { sessionKey: source.key, limit: 1 });
      if (history?.sessionId !== source.sessionId || !Array.isArray(history.messages) || history.messages.length || history.hasMore === true) throw new CallError("recovery source must have empty history");
      const client = await controls.connect();
      if (!client.ws?.addEventListener) throw new Error("Gateway connection does not expose streaming events");
      const runId = randomUUID();
      let streaming = false, terminal = false;
      const onMessage = (event) => {
        if (typeof event.data !== "string") return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        const value = frame?.payload;
        if (frame.type !== "event" || frame.event !== "chat" || value?.runId !== runId || value.sessionKey !== source.key) return;
        if (["final", "error", "aborted"].includes(value.state)) terminal = true;
        const content = value.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";
        if (value.state === "delta" && text.includes("KOVA_VERIFY_HOLD")) streaming = true;
      };
      client.ws.addEventListener("message", onMessage);
      try {
        await controls.rpc("sessions.messages.subscribe", { key: source.key, agentId: source.agentId });
        prepared.runId = runId;
        const receipt = await controls.rpc("chat.send", {
          sessionKey: source.key, sessionId: source.sessionId, agentId: source.agentId,
          message: 'KOVA_VERIFY_HOLD {"holdMs":300000,"progressCards":false}',
          idempotencyKey: runId, timeoutMs: 300000, deliver: false
        });
        if (receipt?.runId !== runId) throw new Error("held turn returned a different run identity");
        createdIds.push(runId);
        while (!streaming) {
          if (terminal) throw new Error("held turn ended before interruption");
          await controls.pause();
        }
        if (terminal) throw new Error("held turn ended before interruption");
        await describe(controls, source);
        controls.remaining();
        return prepared;
      } finally {
        client.ws.removeEventListener("message", onMessage);
      }
    });
  } catch (error) {
    error.output = { createdIds, elapsedMs: Date.now() - startedAt };
    if (prepared?.runId) error.prepared = prepared;
    throw error;
  }
}

async function observeTombstone(controls, source) {
  for (;;) {
    const row = await describe(controls, source);
    if (row.restartRecoveryStatus === "tombstoned") return;
    await controls.pause();
  }
}

export async function runRecoveryRequest(request, prepared, runtime, context, runGateway, dependencies = {}) {
  let result = recoveryFailure(new Error("recovery did not finish"), prepared.startedAt, prepared.createdIds);
  const backup = join(dirname(prepared.configPath), `.kova-recovery-${request.id}.backup`);
  let saved = false, changed = false, restored = false, cleanupComplete = true;
  let blockerSaved = false, blockerIdentity;
  try {
    await withRecoveryControls(request, runtime, context, dependencies, async (controls) => {
      await regularConfig(runtime);
      if (!(await readFile(prepared.configPath)).equals(prepared.original)) throw new Error("clone configuration changed before interruption");
      await writeFile(backup, prepared.original, { flag: "wx", mode: 0o600 });
      saved = true;
      controls.remaining();
      await writeFile(prepared.blockerPath, "Kova recovery workspace fixture\n", { flag: "wx", mode: 0o600 });
      blockerSaved = true;
      blockerIdentity = await lstat(prepared.blockerPath);
      controls.remaining();
      changed = true;
      await replaceConfig(prepared.configPath, prepared.modified, prepared.mode);
      const stopped = new AbortController();
      let observed = false, observationError;
      const running = await runGateway(AbortSignal.any([controls.signal, stopped.signal]), async () => {
        try { await observeTombstone(controls, prepared.source); observed = true; }
        catch (error) { observationError = error; }
        finally { stopped.abort(new Error("recovery observation finished")); }
      });
      cleanupComplete = running.cleanupComplete !== false;
      if (!cleanupComplete) throw new Error(running.cleanupError ?? "Gateway cleanup could not be confirmed");
      if (observationError) throw observationError;
      controls.remaining();
      if (!observed) throw new Error(running.output?.error ?? "Gateway stopped before recovery was observed");
      result = { output: { ...empty(), createdIds: prepared.createdIds }, exitCode: 0 };
    });
  } catch (error) { result = recoveryFailure(error, prepared.startedAt, prepared.createdIds); }
  finally {
    try {
      if (changed) {
        await regularConfig(runtime);
        await replaceConfig(prepared.configPath, prepared.original, prepared.mode);
        if (!(await readFile(prepared.configPath)).equals(prepared.original)) throw new Error("restored configuration differs from its original bytes");
      }
      if (blockerSaved) {
        const current = await lstat(prepared.blockerPath);
        if (!current.isFile() || current.nlink !== 1 || current.dev !== blockerIdentity?.dev || current.ino !== blockerIdentity?.ino) throw new Error("temporary workspace file ownership changed");
        await unlink(prepared.blockerPath);
      }
      restored = true;
      if (saved) await unlink(backup);
    } catch (error) {
      result = recoveryFailure(new Error(`${result.output.error ? `${result.output.error}; ` : ""}configuration restoration failed: ${error.message}`), prepared.startedAt, prepared.createdIds);
    }
  }
  return { ...result, restart: restored && cleanupComplete, prepared };
}

export async function finishRecoveryRequest(request, result, runtime, context, dependencies = {}) {
  const prepared = result.prepared;
  try {
    if (result.exitCode !== 0) return result;
    await withRecoveryControls({ ...request, expiresAt: request.options.overallExpiresAt }, runtime, context, dependencies, async (controls) => {
      if (!(await readFile(prepared.configPath)).equals(prepared.original)) throw new Error("configuration changed after restoration");
      const row = await describe(controls, prepared.source);
      if (row.restartRecoveryStatus !== "tombstoned") throw new Error("restored Gateway has no unrecovered source tombstone");
      controls.remaining();
    });
    return { output: { ...empty(), sessionKey: prepared.source.key, sessionId: prepared.source.sessionId, restartRecoveryStatus: "tombstoned", createdIds: prepared.createdIds, elapsedMs: Date.now() - prepared.startedAt }, exitCode: 0 };
  } catch (error) { return recoveryFailure(error, prepared.startedAt, prepared.createdIds); }
}

await entrypoint(definition);
