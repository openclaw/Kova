#!/usr/bin/env node
import { lstat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EntryError, runEntry } from "./common.mjs";
import { personaStoreDirectory, readPersonaFixtureFile } from "./quarantine-generation.mjs";

const lockNames = ["kova-stale-one.jsonl.lock", "kova-stale-two.jsonl.lock"];
const fixturePid = 2147483647;
const createdAt = "2000-01-01T00:00:00.000Z";

function assertExitedOwner() {
  try { process.kill(fixturePid, 0); } catch (error) {
    if (error.code === "ESRCH") return;
    throw new Error("legacy lock fixture owner is not verifiably absent");
  }
  throw new Error("legacy lock fixture PID is occupied");
}

/** Retired file-lock residue only: no live process or live-owner promise survives an export. */
export async function writeStaleLockFiles(state) {
  assertExitedOwner();
  const directory = await personaStoreDirectory(state, "sessions", { create: true });
  for (const name of lockNames) {
    try { await lstat(join(directory, name)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error("legacy lock fixture target already exists");
  }
  for (const name of lockNames) {
    const path = join(directory, name);
    await writeFile(path, `${JSON.stringify({ pid: fixturePid, createdAt })}\n`, { flag: "wx", mode: 0o600 });
    await utimes(path, new Date(createdAt), new Date(createdAt));
  }
  return {};
}

export async function checkStaleLockFiles(state) {
  assertExitedOwner();
  const directory = await personaStoreDirectory(state, "sessions");
  for (const name of lockNames) {
    const lock = JSON.parse((await readPersonaFixtureFile(join(directory, name), 1024)).toString("utf8"));
    if (lock?.pid !== fixturePid || lock.createdAt !== createdAt || Object.keys(lock).length !== 2) throw new Error("legacy lock residue is absent or changed");
  }
  return {};
}

async function main() {
  const argv = process.argv.slice(2);
  const operation = argv.shift();
  await runEntry({}, ({ state }) => operation === "write" ? writeStaleLockFiles(state) : checkStaleLockFiles(state), argv, () => {
    if (operation !== "write" && operation !== "check") throw new EntryError("expected write or check", 2);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
