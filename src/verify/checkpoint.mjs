import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand } from "../commands.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function parseOutput(text) {
  try { return { json: true, value: JSON.parse(text) }; }
  catch { return { json: false, value: text }; }
}

function inside(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function statePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid checkpoint state path: ${JSON.stringify(value)}`);
  }
  return value;
}

async function isSqlite(path) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === 16 && header.equals(Buffer.from("SQLite format 3\0"));
  } finally { await file.close(); }
}

// These generated pairing values belong only in the environment and its private
// export. Keep the surrounding rows so comparison can still observe pairing state.
const pairingColumns = new Map([
  ["device_identities", "private_key_pem"],
  ["device_auth_tokens", "token"],
  ["gateway_origin_device_tokens", "token"],
  ["device_bootstrap_tokens", "token"],
  ["device_pairing_paired", "tokens_json"]
]);

function omitPairingTokens(value) {
  try {
    const roles = JSON.parse(value);
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new Error();
    for (const entry of Object.values(roles)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      if (Object.hasOwn(entry, "token")) entry.token = "";
    }
    return JSON.stringify(roles);
  } catch { throw new Error("cannot capture malformed pairing metadata"); }
}

async function snapshotFile(root, source, target) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (!await isSqlite(source)) {
    await copyFile(source, target);
    return;
  }
  const { DatabaseSync, backup } = await import("node:sqlite");
  if (typeof backup !== "function") throw new Error("SQLite checkpoints require Node.js 22.16.0 or newer");
  // The unfiltered online backup stays inside the disposable environment as a
  // private export. No original database page is written to retained evidence.
  const temporary = await mkdtemp(join(root, ".kova-snapshot-"));
  const exported = join(temporary, "private.sqlite");
  let snapshot;
  try {
    const file = await open(exported, "wx", 0o600);
    await file.close();
    const database = new DatabaseSync(source, { readOnly: true });
    try { await backup(database, exported); }
    finally { database.close(); }
    snapshot = new DatabaseSync(exported);
    snapshot.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF");
    snapshot.function("kova_omit_pairing_tokens", omitPairingTokens);
    for (const [table, column] of pairingColumns) {
      const schema = snapshot.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table);
      if (!schema) continue;
      const columns = snapshot.prepare(`PRAGMA table_info("${table}")`).all();
      if (schema.type !== "table" || !columns.some((field) => field.name === column) ||
          snapshot.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?").get(table)) {
        throw new Error("cannot safely capture pairing metadata schema");
      }
      const value = table === "device_pairing_paired" ? `kova_omit_pairing_tokens("${column}")` : "''";
      snapshot.exec(`UPDATE "${table}" SET "${column}" = ${value} WHERE "${column}" IS NOT NULL`);
    }
    // Rebuild the file to exclude deleted pages and overwritten credential bytes.
    // VACUUM INTO preserves rowids as well as the selected non-secret values.
    snapshot.prepare("VACUUM INTO ?").run(target);
  } finally {
    snapshot?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function snapshotPath(root, source, target, ancestors = new Set()) {
  let metadata;
  try { metadata = await lstat(source); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const actual = await realpath(source);
  if (!inside(root, actual)) throw new Error(`checkpoint state escapes OpenClaw state directory: ${source}`);
  if (ancestors.has(actual)) throw new Error(`checkpoint state contains a directory cycle: ${source}`);
  if (metadata.isSymbolicLink()) metadata = await lstat(actual);
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const visited = new Set([...ancestors, actual]);
    for (const name of (await readdir(actual)).sort()) {
      // These files belong to the database's online snapshot, not separate signals.
      if (name.endsWith("-wal") || name.endsWith("-shm")) {
        const database = join(actual, name.slice(0, -4));
        try { if (await isSqlite(database)) continue; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await snapshotPath(root, join(actual, name), join(target, name), visited);
    }
  } else if (metadata.isFile()) await snapshotFile(root, actual, target);
  else throw new Error(`checkpoint state is not a file or directory: ${source}`);
}

export async function snapshotState(stateDirectory, paths, outputDirectory) {
  const root = await realpath(stateDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const selected = [...new Set(paths.map(statePath))].sort();
  for (const path of selected) {
    if (selected.some((parent) => parent !== path && path.startsWith(`${parent}/`))) continue;
    await snapshotPath(root, resolve(root, path), join(outputDirectory, path));
  }
}

export async function writeCheckpoint({ phase, directory, results, stateDirectory, collectLogs, screenPath }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase.id)) throw new Error("invalid checkpoint phase id");
  if (results.some((result) => result.outputBudget?.truncated)) throw new Error("checkpoint command output was truncated");
  const destination = join(directory, "checkpoints", phase.id);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(`${destination}.pending-`);
  let logCapture;
  try {
    const responses = {};
    const commands = results.map((result, index) => {
      const output = parseOutput(result.stdout);
      if (output.json) responses[index] = output.value;
      return {
        command: result.command, exit: result.status, stdout: output.json ? null : result.stdout,
        stderr: result.stderr, durationMs: result.durationMs, timedOut: result.timedOut === true,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.outputBudget ? { outputBudget: result.outputBudget } : {})
      };
    });
    await writeFile(join(temporary, "commands.json"), json(commands), { mode: 0o600 });
    for (const signal of phase.checkpoint) {
      if (signal === "responses") await writeFile(join(temporary, "responses.json"), json(responses), { mode: 0o600 });
      else if (signal === "timing") await writeFile(join(temporary, "timing.json"), json(results.map((result) => ({ durationMs: result.durationMs, reachedBound: result.timedOut === true || result.reachedBound === true }))), { mode: 0o600 });
      else if (signal === "logs") {
        if (!collectLogs) throw new Error("log collector is required by checkpoint");
        logCapture ??= collectLogs.prepare ? await collectLogs.prepare() : { text: await collectLogs(), commit() {} };
        await writeFile(join(temporary, "logs.txt"), logCapture.text, { mode: 0o600 });
      } else if (signal === "doctor") {
        await writeFile(join(temporary, "doctor.json"), json(results.map((result) => parseOutput(result.stdout).value)), { mode: 0o600 });
      } else if (signal === "screen") {
        if (!phase.browser || !screenPath) throw new Error("screen checkpoint requires a browser screenshot");
        const source = await open(screenPath, "r");
        try {
          const signature = Buffer.alloc(8);
          await source.read(signature, 0, 8, 0);
          if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("screen checkpoint is not a PNG");
        } finally { await source.close(); }
        await copyFile(screenPath, join(temporary, "screen.png"));
      } else if (!signal.startsWith("state:")) throw new Error(`unknown checkpoint signal: ${signal}`);
    }
    const paths = phase.checkpoint.filter((signal) => signal.startsWith("state:")).map((signal) => signal.slice(6));
    if (paths.length) await snapshotState(stateDirectory, paths, join(temporary, "state"));
    await rename(temporary, destination);
    logCapture?.commit();
    return { path: destination, incomplete: commands.some((command) => command.exit === 2) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function recordPhase(options) {
  const { phase, execute = runCommand, env, bounds = [] } = options;
  const results = [];
  for (const [index, command] of phase.commands.entries()) {
    const timeoutMs = bounds[index] ?? phase.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid phase command bound");
    results.push(await execute(command, { timeoutMs, env }));
  }
  return { ...await writeCheckpoint({ ...options, results }), results };
}

export function createLogCollector(paths, { validatePath, trackIdentity = false } = {}) {
  const offsets = new Map();
  const prepare = async ({ maxBytes = 16 * 1024 * 1024, skipExisting = false, onlyNew = false, selectedPaths } = {}) => {
    const chunks = [];
    const pendingOffsets = new Map(offsets);
    let bytes = 0;
    const selected = selectedPaths ?? (typeof paths === "function" ? await paths() : paths);
    for (const path of new Set(selected)) {
      await validatePath?.(path);
      let file;
      try {
        if (!(await lstat(path)).isFile()) throw new Error(`log is not a regular file: ${path}`);
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || (validatePath && metadata.nlink !== 1)) throw new Error(`log is not an unaliased regular file: ${path}`);
        const key = trackIdentity ? `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}` : path;
        const previous = pendingOffsets.get(key);
        if (skipExisting && onlyNew && previous) continue;
        const start = skipExisting ? metadata.size : previous && previous.dev === metadata.dev && previous.ino === metadata.ino && previous.size <= metadata.size ? previous.size : 0;
        bytes += metadata.size - start;
        if (bytes > maxBytes) throw new Error("log capture exceeds the 16 MiB output budget");
        if (metadata.size > start) {
          for await (const chunk of file.createReadStream({ start, end: metadata.size - 1, autoClose: false })) chunks.push(chunk);
        }
        pendingOffsets.set(key, { dev: metadata.dev, ino: metadata.ino, size: metadata.size });
      } finally {
        await file.close();
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error("log capture exceeds the 16 MiB output budget");
    return { text, bytes, commit() { for (const [key, value] of pendingOffsets) offsets.set(key, value); } };
  };
  return Object.assign(async () => { const result = await prepare(); result.commit(); return result.text; }, {
    prepare,
    hasIdentity: (key) => offsets.has(key),
    async seed(selectedPaths) { (await prepare({ skipExisting: true, onlyNew: true, selectedPaths })).commit(); }
  });
}

export function combineLogCollectors(collectors) {
  const prepare = async ({ maxBytes = 16 * 1024 * 1024 } = {}) => {
    const selected = typeof collectors === "function" ? await collectors() : collectors;
    const captures = [];
    let bytes = 0;
    let nonempty = false;
    for (const collect of new Set(selected)) {
      if (typeof collect.prepare !== "function") throw new Error("combined log readers must support deferred capture");
      const capture = await collect.prepare({ maxBytes: maxBytes - bytes });
      if (capture.bytes > 0) {
        bytes += capture.bytes + (nonempty ? 1 : 0);
        nonempty = true;
        if (bytes > maxBytes) throw new Error("log capture exceeds the 16 MiB output budget");
      }
      captures.push(capture);
    }
    return {
      text: captures.map((capture) => capture.text).filter(Boolean).join("\n"), bytes,
      commit() { for (const capture of captures) capture.commit(); }
    };
  };
  return Object.assign(async () => { const result = await prepare(); result.commit(); return result.text; }, { prepare });
}
