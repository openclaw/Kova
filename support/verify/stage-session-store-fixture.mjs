import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { runWithShutdownScope, spawnOwnedProcess } from "../../src/commands.mjs";
import { ocmInvocation, resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { abortable, atomicJson, CallError, parseFlags, positiveMs, readOperation } from "./background.mjs";
import { requestGatewayFixture } from "./gateway-fixture-client.mjs";

const suffixes = ["", "-wal", "-shm", "-journal"];
const backupName = ".kova-session-store-backup";
const schema = "kova.session-store-backup.v1";

export function parseFixtureArgs(argv) {
  const options = parseFlags(argv, ["restore"]);
  for (const name of Object.keys(options)) if (!["env", "agent", "fixture", "gateway-handle", "restore", "timeout"].includes(name)) throw new CallError(`unknown flag: --${name}`);
  if (!/^kova-(?:run|scripts|ui)-[a-z0-9][a-z0-9-]*$/i.test(options.env ?? "")) throw new CallError("--env must name a disposable Kova clone");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.agent ?? "")) throw new CallError("--agent requires a canonical agent id");
  if (!options["gateway-handle"]) throw new CallError("--gateway-handle is required");
  if (options.restore ? options.fixture !== undefined : !options.fixture) throw new CallError("use --fixture for a swap or --restore without --fixture");
  options["gateway-handle"] = resolve(options["gateway-handle"]);
  if (options.fixture) options.fixture = resolve(options.fixture);
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
  for (const suffix of record.files) await ownedPath(target.root, join(target.backup, `original${suffix}`));
  return record;
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
    await atomicJson(join(target.backup, "backup.json"), { schema, env: options.env, agent: options.agent, db: target.db, files }, { exclusive: true });
  } catch (error) { await rm(target.backup, { recursive: true, force: true }); throw error; }
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
  const output = { staged: null, doctor: null, started: false, error: null };
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
      await saveBackup(target, options, check);
      backupSaved = true;
      await installFixture(target, options, check);
      output.staged = { restored: false, path: target.db, backup: target.backup };
      check();
      output.doctor = await doctor(options, activeSignal);
      check();
      if (output.doctor.status !== 0) throw new CallError("Doctor failed", 1);
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

export async function stageSessionStoreFixtureMain(argv, { signal } = {}) {
  try {
    const options = parseFixtureArgs(argv);
    const operation = await readOperation(options["gateway-handle"]);
    if (operation.env !== options.env || operation.entry !== "foreground-gateway-start" || !operation.handle?.ref) throw new CallError("fixture requires the selected environment's foreground Gateway handle");
    await inspectFixtureTarget(options, operation.handle.ref);
    return await requestGatewayFixture(options, { signal });
  } catch (error) {
    return { output: { staged: null, doctor: null, started: false, error: error.message }, exitCode: error.exitCode ?? 1 };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runWithShutdownScope((signal) => stageSessionStoreFixtureMain(process.argv.slice(2), { signal }));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}
