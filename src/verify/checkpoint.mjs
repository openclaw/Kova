import { createReadStream } from "node:fs";
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

async function snapshotFile(source, target) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (!await isSqlite(source)) {
    await copyFile(source, target);
    return;
  }
  // Copy through SQLite, including committed WAL pages, without writing to the source.
  const { DatabaseSync, backup } = await import("node:sqlite");
  if (typeof backup !== "function") throw new Error("SQLite checkpoints require Node.js 22.16.0 or newer");
  const database = new DatabaseSync(source, { readOnly: true });
  try { await backup(database, target); }
  finally { database.close(); }
  // The snapshot is standalone: reading it must not create WAL side files.
  const snapshot = new DatabaseSync(target);
  try { snapshot.exec("PRAGMA journal_mode=DELETE"); }
  finally { snapshot.close(); }
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
  } else if (metadata.isFile()) await snapshotFile(actual, target);
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
        await writeFile(join(temporary, "logs.txt"), await collectLogs(), { mode: 0o600 });
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

export function createLogCollector(paths) {
  const offsets = new Map();
  return async () => {
    const chunks = [];
    for (const path of paths) {
      let metadata;
      try { metadata = await lstat(path); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!metadata.isFile()) throw new Error(`log is not a regular file: ${path}`);
      const previous = offsets.get(path);
      const start = previous && previous.ino === metadata.ino && previous.size <= metadata.size ? previous.size : 0;
      if (metadata.size > start) {
        for await (const chunk of createReadStream(path, { start, end: metadata.size - 1 })) chunks.push(chunk);
      }
      offsets.set(path, { ino: metadata.ino, size: metadata.size });
    }
    return Buffer.concat(chunks).toString("utf8");
  };
}
