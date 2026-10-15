#!/usr/bin/env node
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EntryError, productJson, runEntry } from "./common.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";

export const corruptFixtureSha256 = "c5568ab85c1a6013d04ce246081d840c124dc52f1b70e22621451d1bc1be6256";
const fixtureUrl = new URL("../../personas/openclaw/fixtures/corrupt-generation.sqlite", import.meta.url);
const fixtureSize = 8192;
const stagedName = "corrupt-generation.sqlite";
const recoveryName = "recovery-generation.sqlite";
const receiptName = "recovery-generation.json";
const recoveredName = /^recovery-generation\.sqlite\.corrupt-[1-9]\d{0,15}(?:\.\d{1,2})?$/;

/** Fixed paths under the selected persona; no caller-selected database can become a write target. */
export async function personaStoreDirectory(state, kind, { create = false } = {}) {
  if (typeof state !== "string" || !isAbsolute(state)) throw new EntryError("an absolute persona state directory is required", 2);
  if (kind !== "fixtures" && kind !== "sessions") throw new EntryError("unsupported persona store directory", 2);
  let directory = await realpath(state);
  if (!(await lstat(directory)).isDirectory()) throw new Error("persona state is not a directory");
  const parts = ["agents", "main", ...(kind === "fixtures" ? ["agent", "fixtures"] : ["sessions"])];
  for (const [index, part] of parts.entries()) {
    directory = join(directory, part);
    if (create && index === parts.length - 1) {
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("persona store directory must stay inside the selected state without symbolic links");
  }
  return directory;
}

export async function readPersonaFixtureFile(path, maximumBytes) {
  const observed = await lstat(path);
  if (!observed.isFile() || observed.isSymbolicLink()) throw new Error("persona fixture must be a regular file without symbolic links");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== observed.dev || info.ino !== observed.ino || info.nlink !== 1 || info.size > maximumBytes) throw new Error("persona fixture must be a bounded regular file without hard links");
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximumBytes || length !== info.size) throw new Error("persona fixture changed or exceeds its byte limit");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("persona fixture target already exists");
}

async function noSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) await absent(`${path}${suffix}`);
}

function verifyFixtureBytes(bytes) {
  if (bytes.length !== fixtureSize || bytes.subarray(0, 16).toString("binary") !== "\0QLite format 3\0" ||
      createHash("sha256").update(bytes).digest("hex") !== corruptFixtureSha256) {
    throw new Error("corrupt generation differs from the documented SQLite fixture");
  }
}

/** Integrity is checked through SQLite; opening a database alone is not a corruption check. */
export async function assertCorruptGeneration(path) {
  await noSidecars(path);
  const bytes = await readPersonaFixtureFile(path, fixtureSize);
  verifyFixtureBytes(bytes);
  requireSessionContentRuntime();
  const { DatabaseSync } = await import("node:sqlite");
  let database;
  let corrupt = false;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    const rows = database.prepare("PRAGMA integrity_check").all();
    corrupt = rows.some((row) => typeof row.integrity_check === "string" && row.integrity_check !== "ok");
  } catch (error) {
    if (error.errcode !== 11 && error.errcode !== 26 && !/database disk image is malformed|file is not a database/i.test(error.message)) throw error;
    corrupt = true;
  } finally { database?.close(); }
  if (!corrupt) throw new Error("SQLite did not report the expected corrupt generation");
  return bytes;
}

export async function stageCorruptGeneration(state, { recovery = false } = {}) {
  const directory = await personaStoreDirectory(state, "fixtures", { create: true });
  const source = recovery ? join(directory, stagedName) : fileURLToPath(fixtureUrl);
  const bytes = await assertCorruptGeneration(source);
  const path = join(directory, recovery ? recoveryName : stagedName);
  await noSidecars(path);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { path };
}

export async function checkCorruptGeneration(state) {
  const directory = await personaStoreDirectory(state, "fixtures");
  const path = join(directory, stagedName);
  await assertCorruptGeneration(path);
  return { path };
}

function recoveredPath(report, directory) {
  const target = report?.targets?.[0];
  const source = join(directory, recoveryName);
  const moved = target?.corruptRecovery?.movedFiles;
  if (report?.mode !== "recover" || report?.targets?.length !== 1 || report?.totals?.targets !== 1 || report?.totals?.issues !== 0 ||
      target?.agentId !== "main" || target.sqlitePath !== source || target.issues?.length !== 0 ||
      !Array.isArray(moved) || moved.length !== 1 || typeof moved[0] !== "string") {
    throw new Error("Doctor did not report recovery of the selected fixture only");
  }
  const name = moved[0].slice(directory.length + 1);
  if (!recoveredName.test(name) || moved[0] !== join(directory, name)) throw new Error("Doctor recovery path is outside the selected fixture generation");
  return { name, path: moved[0] };
}

/** The caller's persona lifecycle stops the foreground Gateway before this one Doctor operation. */
export async function recoverCorruptGeneration({ state, envName, run = productJson }) {
  const directory = await personaStoreDirectory(state, "fixtures");
  const source = join(directory, recoveryName);
  const receipt = join(directory, receiptName);
  await absent(receipt);
  await assertCorruptGeneration(source);
  const report = await run(envName, ["doctor", "--session-sqlite", "recover", "--session-sqlite-store", source, "--session-sqlite-agent", "main", "--json"]);
  const preserved = recoveredPath(report, directory);
  await absent(source);
  await noSidecars(source);
  await assertCorruptGeneration(preserved.path);
  await writeFile(receipt, `${JSON.stringify({ version: 1, source: recoveryName, preserved: preserved.name, sha256: corruptFixtureSha256 })}\n`, { flag: "wx", mode: 0o600 });
  return {};
}

export async function checkQuarantinedGeneration(state) {
  const directory = await personaStoreDirectory(state, "fixtures");
  const receipt = JSON.parse((await readPersonaFixtureFile(join(directory, receiptName), 1024)).toString("utf8"));
  if (receipt?.version !== 1 || receipt.source !== recoveryName || typeof receipt.preserved !== "string" ||
      !recoveredName.test(receipt.preserved) || receipt.sha256 !== corruptFixtureSha256) throw new Error("invalid recovered generation receipt");
  await absent(join(directory, recoveryName));
  await noSidecars(join(directory, recoveryName));
  await assertCorruptGeneration(join(directory, receipt.preserved));
  return {};
}

async function main() {
  const argv = process.argv.slice(2);
  const operation = argv.shift();
  const operations = ["stage-corrupt", "check-corrupt", "stage-recovery", "recover", "check-quarantine"];
  await runEntry({}, async ({ state, args }) => {
    if (operation === "stage-corrupt") return stageCorruptGeneration(state);
    if (operation === "stage-recovery") return stageCorruptGeneration(state, { recovery: true });
    if (operation === "check-corrupt") return checkCorruptGeneration(state);
    if (operation === "check-quarantine") return checkQuarantinedGeneration(state);
    return recoverCorruptGeneration({ state, envName: args.env });
  }, argv, () => { if (!operations.includes(operation)) throw new EntryError(`expected ${operations.join(", ")}`, 2); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
