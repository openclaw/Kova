import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";
import { runWithShutdownScope, spawnOwnedProcess } from "../../src/commands.mjs";
import { ocmInvocation, resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { abortable, atomicJson, CallError, parseFlags, positiveMs, readJson, readOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";
import { requestGatewayFixture } from "./gateway-fixture-client.mjs";

const suffixes = ["", "-wal", "-shm", "-journal"];
const backupName = ".kova-session-store-backup";
const schema = "kova.session-store-backup.v1";
const receiptSchema = "kova.session-store-swap.v1";

export function parseFixtureArgs(argv) {
  const options = parseFlags(argv, ["restore"]);
  for (const name of Object.keys(options)) if (!["env", "agent", "fixture", "gateway-handle", "restore", "timeout", "out", "from"].includes(name)) throw new CallError(`unknown flag: --${name}`);
  if (!/^kova-(?:run|scripts|ui)-[a-z0-9][a-z0-9-]*$/i.test(options.env ?? "")) throw new CallError("--env must name a disposable Kova clone");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.agent ?? "")) throw new CallError("--agent requires a canonical agent id");
  if (!options["gateway-handle"]) throw new CallError("--gateway-handle is required");
  if (options.restore ? options.fixture !== undefined : !options.fixture) throw new CallError("use --fixture for a swap or --restore without --fixture");
  if (options.from !== undefined && (!options.restore || !options.from)) throw new CallError("--from requires --restore and a successful swap result");
  if (options.out !== undefined && (options.restore || !options.out)) throw new CallError("--out requires a fixture swap and a new result path");
  options["gateway-handle"] = resolve(options["gateway-handle"]);
  if (options.fixture) options.fixture = resolve(options.fixture);
  if (options.out) options.out = resolve(options.out);
  if (options.from) options.from = resolve(options.from);
  options.timeoutMs = positiveMs(options.timeout, 120000);
  return options;
}

async function statOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function ownedPath(root, path, { directory = false, optional = false } = {}) {
  const suffix = relative(root, resolve(path));
  if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new CallError("fixture paths must stay inside the selected clone");
  let current = root;
  const parts = suffix.split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await statOrNull(current);
    if (!stat) {
      if (optional) return resolve(path);
      throw new CallError("required fixture path is missing");
    }
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new CallError("fixture paths cannot use symbolic or hard links");
    if (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile()) throw new CallError("fixture paths require regular files and directories");
  }
  return current;
}

export async function inspectFixtureTarget(options, runtime) {
  if (resolveOcmTransport()) throw new CallError("fixture preparation must run on the selected clone's host");
  if (typeof runtime?.root !== "string" || !isAbsolute(runtime.root)) throw new CallError("Gateway handle is missing its clone root");
  const rootStat = await lstat(runtime.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CallError("clone root must be an unaliased directory");
  const root = await realpath(runtime.root);
  const canonical = (path) => {
    const suffix = relative(resolve(runtime.root), resolve(path));
    return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`) ? join(root, suffix) : resolve(path);
  };
  const state = join(root, ".openclaw");
  const configPath = canonical(runtime.configPath ?? join(root, ".openclaw/openclaw.json"));
  if (configPath !== join(state, "openclaw.json")) throw new CallError("fixture preparation requires the clone's default state directory");
  await ownedPath(root, configPath);
  let config;
  try { config = JSON5.parse(await readFile(configPath, "utf8")); }
  catch { throw new CallError("invalid clone configuration"); }
  if (!config || typeof config !== "object" || Array.isArray(config) || JSON.stringify(config).includes('"$include"')) throw new CallError("fixture preparation requires directly authored configuration");
  const db = join(state, "agents", options.agent, "agent", "openclaw-agent.sqlite");
  const store = config.session?.store;
  // The pinned product maps a canonical per-agent sessions.json selector to
  // this database. Shared, relative, and custom selectors have different owners.
  if (store !== undefined) {
    if (typeof store !== "string" || !isAbsolute(store) || store.includes("${")) throw new CallError("unsupported configured session store");
    const selected = canonical(store.replaceAll("{agentId}", options.agent));
    if (![db, join(state, "agents", options.agent, "sessions", "sessions.json")].includes(selected)) throw new CallError("fixture preparation does not support a shared or custom session store");
  }
  const agentDir = await ownedPath(root, dirname(db), { directory: true });
  if (!options.restore) await ownedPath(root, db);
  for (const suffix of suffixes) await ownedPath(root, `${db}${suffix}`, { optional: true });
  let fixture;
  if (!options.restore) {
    fixture = await ownedPath(root, canonical(options.fixture));
    const fixtureSuffix = relative(agentDir, fixture);
    if (isAbsolute(fixtureSuffix) || fixtureSuffix === ".." || fixtureSuffix.startsWith(`..${sep}`) || suffixes.some((suffix) => fixture === `${db}${suffix}`) || basename(fixture).startsWith(".kova-")) throw new CallError("fixture must be a separate staged file inside the selected agent directory");
    for (const suffix of suffixes.slice(1)) await ownedPath(root, `${fixture}${suffix}`, { optional: true });
  }
  const backup = join(agentDir, backupName);
  if (options.restore) await readBackup({ root, db, backup }, options);
  else if (await statOrNull(backup)) throw new CallError("a session store backup already exists; restore it first");
  return { root, db, backup, fixture };
}

async function readBackup(target, options) {
  await ownedPath(target.root, target.backup, { directory: true });
  const manifestPath = await ownedPath(target.root, join(target.backup, "backup.json"));
  const record = JSON.parse(await readFile(manifestPath, "utf8"));
  if (record.schema !== schema || record.env !== options.env || record.agent !== options.agent || record.db !== target.db || !Array.isArray(record.files) || new Set(record.files).size !== record.files.length || !record.files.every((suffix) => suffixes.includes(suffix))) throw new CallError("session store backup does not match the selected clone and agent");
  if (!record.files.includes("")) throw new CallError("session store backup is missing the primary database");
  const expected = new Set(record.files.map((suffix) => `original${suffix}`));
  const retained = (await readdir(target.backup)).filter((name) => name.startsWith("original"));
  if (retained.length !== expected.size || retained.some((name) => !expected.has(name))) throw new CallError("session store backup does not match its retained original files");
  for (const suffix of record.files) await ownedPath(target.root, join(target.backup, `original${suffix}`));
  if (options.from) {
    let source;
    try { source = await readJson(options.from); }
    catch { throw new CallError("--from must contain a readable successful swap result"); }
    const receipt = source?.staged?.receipt;
    const operation = await fixtureOperation(options);
    if (source?.error !== null || source.started !== true || source.staged?.restored !== false || source.staged.path !== target.db || source.staged.backup !== target.backup || !receipt || receipt.schema !== receiptSchema || typeof receipt.id !== "string" || !/^[a-f0-9-]{36}$/.test(receipt.id) || receipt.env !== options.env || receipt.agent !== options.agent || receipt.gatewayId !== operation.id || receipt.gatewayHandle !== operation.handlePath || !isDeepStrictEqual(receipt, record.receipt)) throw new CallError("--from does not identify this successful swap and its active backup");
  }
  return record;
}

async function fixtureOperation(options) {
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.env !== options.env || operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || !operation.handle?.ref) throw new CallError("fixture requires the selected environment's foreground Gateway handle");
  return operation;
}

async function saveBackup(target, options, check) {
  await mkdir(target.backup, { mode: 0o700 });
  try {
    const files = [];
    for (const suffix of suffixes) {
      check();
      const source = `${target.db}${suffix}`;
      if (!await statOrNull(source)) continue;
      await ownedPath(target.root, source);
      await copyFile(source, join(target.backup, `original${suffix}`), constants.COPYFILE_EXCL);
      files.push(suffix);
    }
    check();
    let receipt;
    if (options.out) {
      const operation = await fixtureOperation(options);
      receipt = { schema: receiptSchema, id: randomUUID(), env: options.env, agent: options.agent, gatewayId: operation.id, gatewayHandle: operation.handlePath };
    }
    await atomicJson(join(target.backup, "backup.json"), { schema, env: options.env, agent: options.agent, db: target.db, files, ...(receipt ? { receipt } : {}) }, { exclusive: true });
    return receipt;
  } catch (error) { await rm(target.backup, { recursive: true, force: true }); throw error; }
}

async function quarantineInventory(target) {
  const files = new Map();
  for (const name of await readdir(dirname(target.db))) {
    for (const [role, suffix] of suffixes.entries()) {
      const prefix = `${basename(target.db)}${suffix}.corrupt-`;
      if (!name.startsWith(prefix) || !/^\d+(?:\.\d+)?$/.test(name.slice(prefix.length))) continue;
      const path = await ownedPath(target.root, join(dirname(target.db), name));
      files.set(path, { name, role });
    }
  }
  return files;
}

async function createdQuarantines(target, options, before, doctor) {
  // Doctor's native recovery report names the moved files. Directory snapshots
  // distinguish this call's additions from retained files and collision suffixes.
  const after = await quarantineInventory(target);
  const added = [...after.keys()].filter((path) => !before.has(path));
  let report;
  try { report = JSON.parse(doctor.stdout); }
  catch {
    // Older callers may supply a Doctor adapter without structured output.
    if (!options.out && added.length === 0) return [];
    throw new CallError("Doctor did not return a structured recovery report", 1);
  }
  if (report?.mode !== "recover" || !Array.isArray(report.targets)) throw new CallError("Doctor recovery report is invalid", 1);
  const matches = report.targets.filter((row) => row?.agentId === options.agent && row.sqlitePath === target.db);
  if (matches.length !== 1) throw new CallError("Doctor recovery report does not identify the selected database", 1);
  const moved = matches[0].corruptRecovery?.movedFiles ?? [];
  if (!Array.isArray(moved) || new Set(moved).size !== moved.length || moved.some((path) => typeof path !== "string" || !after.has(path))) throw new CallError("Doctor reported invalid quarantine files", 1);
  if (added.some((path) => !moved.includes(path))) throw new CallError("new quarantine files are absent from Doctor's recovery report", 1);
  return moved.filter((path) => !before.has(path)).map((path) => after.get(path)).sort((left, right) => left.role - right.role || left.name.localeCompare(right.name)).map((file) => file.name);
}

async function restoreBackup(target, options) {
  const record = await readBackup(target, options);
  // Keep every original until the entire set is restored, so interruption can
  // retry the restore without relying on a partly consumed backup.
  for (const suffix of record.files) {
    const temporary = join(target.backup, `restore${suffix}`);
    await ownedPath(target.root, temporary, { optional: true });
    await copyFile(join(target.backup, `original${suffix}`), temporary);
  }
  for (const suffix of suffixes) {
    await ownedPath(target.root, `${target.db}${suffix}`, { optional: true });
    await rm(`${target.db}${suffix}`, { force: true });
  }
  for (const suffix of [...record.files.filter(Boolean), ...record.files.filter((value) => value === "")]) await rename(join(target.backup, `restore${suffix}`), `${target.db}${suffix}`);
  await rm(target.backup, { recursive: true });
}

async function installFixture(target, options, check) {
  const files = [];
  for (const suffix of suffixes) {
    check();
    const source = `${target.fixture}${suffix}`;
    if (!await statOrNull(source)) continue;
    await ownedPath(target.root, source);
    await copyFile(source, join(target.backup, `fixture${suffix}`), constants.COPYFILE_EXCL);
    files.push(suffix);
  }
  check();
  for (const suffix of suffixes) await rm(`${target.db}${suffix}`, { force: true });
  for (const suffix of [...files.filter(Boolean), ""]) await rename(join(target.backup, `fixture${suffix}`), `${target.db}${suffix}`);
}

async function runDoctor(options, signal) {
  const invocation = ocmInvocation([`@${options.env}`, "--", "doctor", "--session-sqlite", "recover", "--session-sqlite-agent", options.agent, "--json"]);
  const owned = spawnOwnedProcess(invocation.file, invocation.args, { env: invocation.env });
  let stdout = "", stderr = "";
  const capture = (value, chunk) => (value + chunk.toString("utf8")).slice(-65536);
  owned.child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
  owned.child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });
  try {
    const result = await abortable(owned.closed, signal);
    if (result.error) throw result.error;
    return { status: result.status, signal: result.signal, stdout, stderr };
  } finally { await owned.stop(); }
}

export async function executePausedFixture(options, runtime, { signal, expiresAt = Date.now() + options.timeoutMs, doctor = runDoctor } = {}) {
  const output = { staged: null, doctor: null, started: false, createdIds: [], error: null };
  let target, backupSaved = false;
  const restoring = options.restore === true;
  const timeout = AbortSignal.timeout(Math.max(1, expiresAt - Date.now()));
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const check = () => { activeSignal.throwIfAborted(); if (Date.now() >= expiresAt) throw new CallError("fixture preparation timeout", 3); };
  try {
    check();
    target = await inspectFixtureTarget(options, runtime);
    check();
    if (options.restore) {
      await restoreBackup(target, options);
      output.staged = { restored: true, path: target.db };
    } else {
      const receipt = await saveBackup(target, options, check);
      backupSaved = true;
      await installFixture(target, options, check);
      output.staged = { restored: false, path: target.db, backup: target.backup, ...(receipt ? { receipt } : {}) };
      const before = await quarantineInventory(target);
      check();
      output.doctor = await doctor(options, activeSignal);
      check();
      if (output.doctor.status !== 0) throw new CallError("Doctor failed", 1);
      output.createdIds = await createdQuarantines(target, options, before, output.doctor);
    }
    return { output, exitCode: 0, restart: true };
  } catch (error) {
    let restart = !restoring;
    output.error = error.message;
    const exitCode = timeout.aborted || Date.now() >= expiresAt ? 3 : error.exitCode ?? 1;
    if (backupSaved) {
      try { await restoreBackup(target, options); output.staged = { restored: true, path: target.db }; }
      catch (restoreError) { restart = false; output.error += `; restore failed: ${restoreError.message}`; }
    }
    return { output, exitCode, restart };
  }
}

export async function stageSessionStoreFixtureMain(argv, { signal, request = requestGatewayFixture } = {}) {
  let options, result;
  try {
    options = parseFixtureArgs(argv);
    if (options.out) options.out = await validateGatewayOutput(options);
    const operation = await fixtureOperation(options);
    await inspectFixtureTarget(options, operation.handle.ref);
    result = await request(options, { signal });
    if (options.out && result.exitCode === 0 && result.output.error === null && result.output.started === true && result.output.staged?.restored === false) {
      try { await writeGatewayOutput(options, result.output); }
      catch (error) {
        let restored;
        try { restored = await request({ ...options, out: undefined, fixture: undefined, restore: true }, {}); } catch {}
        const restoredOk = restored?.exitCode === 0 && restored.output.staged?.restored === true;
        result.output.error = `could not write the successful swap result${restoredOk ? "" : "; fixture restoration incomplete; original backup retained"}`;
        if (restored?.output.staged) result.output.staged = restored.output.staged;
        result.exitCode = error.exitCode ?? 1;
      }
    } else if (options.out && result.exitCode === 0) {
      result.output.error = "fixture swap did not complete; successful result was not written";
      result.exitCode = 1;
    }
    return result;
  } catch (error) {
    if (error?.operationResult?.output) {
      const completed = error.operationResult;
      return { ...completed, output: { createdIds: [], ...completed.output, error: error.message }, exitCode: error.exitCode ?? 1 };
    }
    return { output: { staged: null, doctor: null, started: false, createdIds: [], error: error.message }, exitCode: error.exitCode ?? 1 };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runWithShutdownScope((signal) => stageSessionStoreFixtureMain(process.argv.slice(2), { signal }));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}
