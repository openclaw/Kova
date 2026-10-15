#!/usr/bin/env node
import { createServer } from "node:net";
import { hostname } from "node:os";
import { lstat, mkdir, open, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";
import { EntryError, runEntry } from "./common.mjs";
import { personaStoreDirectory, readPersonaFixtureFile } from "./quarantine-generation.mjs";
import { requireSessionContentRuntime, resolveSessionDatabasePath } from "./session-store-read.mjs";

export const legacyAliasKey = "agent:main:kova-persona-legacy-aliases";
export const legacySearchWord = "KOVA_LEGACY_HISTORY";
const aliasLabel = "kova-persona-legacy-aliases";
const provider = "kova-channel-probe";
const legacyName = "legacy-store.json";
const aliasesName = "legacy-aliases.json";
const historyId = "kova-persona-legacy-history";
const historyKey = `agent:main:${historyId}`;
const transcriptName = `${historyId}.jsonl`;
const timestamp = "2026-08-30T00:00:00.000Z";
const entryLimit = 262144;
const envPattern = /^[a-z][a-z0-9-]{0,127}$/;
const json = (value) => `${JSON.stringify(value)}\n`;

function sourceName(env) {
  if (!envPattern.test(env?.name ?? "")) throw new EntryError("a selected persona environment name is required", 2);
  return env.name;
}

function legacyContent(sourceEnv) {
  const updatedAt = Date.parse(timestamp);
  return {
    version: 1, sourceEnv,
    index: { [historyKey]: { sessionId: historyId, sessionFile: transcriptName, updatedAt, sessionStartedAt: updatedAt, lastInteractionAt: updatedAt, label: historyId, modelProvider: "openai", model: "gpt-5.5" } },
    transcript: [
      { type: "session", version: 3, id: historyId, timestamp, cwd: "." },
      { type: "message", id: "kova-legacy-user", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: `${legacySearchWord}: retain this notebook history.` }], timestamp: updatedAt } },
      { type: "message", id: "kova-legacy-assistant", parentId: "kova-legacy-user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "The notebook history is retained." }], api: "openai-responses", provider: "openai", model: "gpt-5.5", stopReason: "stop", timestamp: updatedAt } },
    ],
    idle: { agentId: "idle", index: {} },
  };
}

async function stagedFile(state, name, supplied, create = false) {
  const directory = await personaStoreDirectory(state, "fixtures", { create });
  const path = join(directory, name);
  if (supplied !== undefined && (typeof supplied !== "string" || !isAbsolute(supplied) || resolve(supplied) !== path)) throw new EntryError("legacy fixture path must name the selected clone's staged file", 2);
  return path;
}

async function readLegacy(state, supplied) {
  const path = await stagedFile(state, legacyName, supplied);
  const record = JSON.parse((await readPersonaFixtureFile(path, 16384)).toString("utf8"));
  if (!envPattern.test(record?.sourceEnv ?? "") || !isDeepStrictEqual(record, legacyContent(record.sourceEnv))) throw new Error("staged pending legacy history is absent or changed");
  return { path, record };
}

function validateAliases(record) {
  const entry = record?.entry;
  if (record?.version !== 1 || !envPattern.test(record.sourceEnv ?? "") || record.sessionKey !== legacyAliasKey ||
      !entry || typeof entry.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(entry.sessionId) ||
      !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 1 || entry.label !== aliasLabel ||
      entry.provider !== provider || entry.lastProvider !== provider ||
      Object.keys(record).sort().join(",") !== "entry,sessionKey,sourceEnv,version" ||
      Object.keys(entry).sort().join(",") !== "label,lastProvider,provider,sessionId,updatedAt") throw new Error("staged provider aliases are absent, changed or already canonical");
  return record;
}

async function readAliases(state, supplied) {
  const path = await stagedFile(state, aliasesName, supplied);
  const record = validateAliases(JSON.parse((await readPersonaFixtureFile(path, 16384)).toString("utf8")));
  return { path, record };
}

function readAliasRow(db) {
  const row = db.prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ? AND length(CAST(entry_json AS BLOB)) <= ?").get(legacyAliasKey, entryLimit);
  if (!row) throw new Error("task-created alias session is absent or oversized");
  const entry = JSON.parse(row.entry_json);
  if (entry?.sessionId !== row.current_session_id || entry?.label !== aliasLabel || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 1) throw new Error("task-created alias session identity differs");
  return { row, entry };
}

export async function stageLegacyStore({ state, env }) {
  const path = await stagedFile(state, legacyName, undefined, true);
  await writeFile(path, json(legacyContent(sourceName(env))), { flag: "wx", mode: 0o600 });
  return { path, searchWord: legacySearchWord };
}

export async function checkLegacyStore(state) {
  const { path } = await readLegacy(state);
  return { path, searchWord: legacySearchWord };
}

export async function stageLegacyAliases({ state, env }) {
  requireSessionContentRuntime();
  const path = await stagedFile(state, aliasesName, undefined, true);
  const database = await resolveSessionDatabasePath(state, "main");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true, allowExtension: false });
  let record;
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    const { entry } = readAliasRow(db);
    record = validateAliases({ version: 1, sourceEnv: sourceName(env), sessionKey: legacyAliasKey, entry: {
      sessionId: entry.sessionId, updatedAt: entry.updatedAt, label: aliasLabel, provider, lastProvider: provider,
    } });
  } finally { db.close(); }
  await writeFile(path, json(record), { flag: "wx", mode: 0o600 });
  return { path };
}

export async function checkLegacyAliases(state) {
  const { path } = await readAliases(state);
  return { path };
}

async function requireAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("legacy activation would overwrite existing state");
}

async function checkedDirectory(root, parts, { allowMissingLeaf = false } = {}) {
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let stat;
    try { stat = await lstat(path); } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error.code === "ENOENT") return { path, missing: true };
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("legacy activation directory must be owned and free of symbolic links");
  }
  return { path, missing: false };
}

async function requireStoppedLease(state) {
  const directory = await checkedDirectory(state, ["state"]);
  const path = join(directory.path, "openclaw.sqlite");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Gateway ownership database must be a regular unaliased file");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      const sidecar = await lstat(`${path}${suffix}`);
      if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1) throw new Error("Gateway ownership sidecar is not a regular unaliased file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='state_leases'").get()) return;
    const row = db.prepare("SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 16384 THEN payload_json END AS payload_json FROM state_leases WHERE scope='gateway-owner' AND lease_key='global'").get();
    if (!row) return;
    const owner = JSON.parse(row.payload_json ?? "null")?.owner;
    if (owner?.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") return; }
    }
    throw new Error("legacy activation requires a stopped Gateway with no live or unverifiable owner");
  } finally { db.close(); }
}

async function reserveGatewayPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("legacy activation requires the clone's Gateway port");
  const server = createServer((socket) => socket.destroy());
  await new Promise((accept, reject) => {
    server.once("error", (error) => reject(new Error(error.code === "EADDRINUSE" ? "legacy activation requires a stopped Gateway" : "Gateway port ownership could not be established")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, accept);
  });
  return () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
}

/** Activate both staged conditions on a stopped disposable clone; retain every staged source. */
export async function activateLegacyStore({ state, env, legacyPath, aliasesPath }) {
  requireSessionContentRuntime();
  if (!isAbsolute(legacyPath ?? "") || !isAbsolute(aliasesPath ?? "")) throw new EntryError("activate requires absolute --legacy and --aliases fixture paths", 2);
  const cloneName = sourceName(env);
  const root = await realpath(state);
  const legacy = await readLegacy(root, legacyPath);
  const aliases = await readAliases(root, aliasesPath);
  if (env.protected !== false || cloneName === legacy.record.sourceEnv || cloneName === aliases.record.sourceEnv ||
      legacy.record.sourceEnv !== aliases.record.sourceEnv) throw new Error("legacy activation requires an unprotected clone of both staged fixtures");
  const config = JSON5.parse((await readPersonaFixtureFile(join(root, "openclaw.json"), 2 * 1024 * 1024)).toString("utf8"));
  if (!config?.agents?.entries?.main || !config.agents.entries.idle || config.session?.store || config.agents.defaults?.sessionStore) throw new Error("legacy activation requires configured main and idle agents with default stores");
  for (const id of ["main", "idle"]) {
    const agentDir = config.agents.entries[id].agentDir;
    if (agentDir !== undefined && resolve(agentDir) !== join(root, "agents", id, "agent")) throw new Error("legacy activation cannot use a custom agent database directory");
  }
  const main = await checkedDirectory(root, ["agents", "main", "sessions"], { allowMissingLeaf: true });
  const idle = await checkedDirectory(root, ["agents", "idle", "sessions"], { allowMissingLeaf: true });
  await checkedDirectory(root, ["agents", "idle", "agent"], { allowMissingLeaf: true });
  const idleDatabase = join(root, "agents", "idle", "agent", "openclaw-agent.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await requireAbsent(`${idleDatabase}${suffix}`);
  if (!idle.missing && (await readdir(idle.path)).some((name) => name.endsWith(".jsonl"))) throw new Error("idle agent already contains legacy history");
  const destinations = [
    { path: join(main.path, transcriptName), content: legacy.record.transcript.map(JSON.stringify).join("\n") + "\n" },
    { path: join(main.path, "sessions.json"), content: json(legacy.record.index) },
    { path: join(idle.path, "sessions.json"), content: json(legacy.record.idle.index) },
  ];
  for (const destination of destinations) await requireAbsent(destination.path);
  const database = await resolveSessionDatabasePath(root, "main", { writable: true });
  await requireStoppedLease(root);
  const releasePort = await reserveGatewayPort(Number(env.gatewayPort));
  const { DatabaseSync } = await import("node:sqlite");
  let db, transaction = false, committed = false;
  const created = [], createdDirectories = [];
  try {
    await requireStoppedLease(root);
    db = new DatabaseSync(database, { allowExtension: false });
    db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    transaction = true;
    const { row, entry } = readAliasRow(db);
    if (entry.sessionId !== aliases.record.entry.sessionId) throw new Error("staged aliases no longer match the task-created session");
    if (db.prepare("SELECT 1 FROM session_nodes WHERE session_key = ? OR current_session_id = ? LIMIT 1").get(historyKey, historyId)) throw new Error("pending legacy history is already active or imported");
    const replacement = { ...entry, provider: aliases.record.entry.provider, lastProvider: aliases.record.entry.lastProvider };
    for (const key of ["delivery", "channel", "lastChannel"]) delete replacement[key];
    for (const directory of [main, idle]) if (directory.missing) {
      await mkdir(directory.path, { mode: 0o700 });
      createdDirectories.push(directory.path);
    }
    for (const destination of destinations) {
      const file = await open(destination.path, "wx", 0o600);
      try {
        const stat = await file.stat();
        created.push({ path: destination.path, dev: stat.dev, ino: stat.ino });
        await file.writeFile(destination.content);
        await file.sync();
      } finally { await file.close(); }
    }
    const changed = db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ? AND current_session_id = ? AND entry_json = ?").run(JSON.stringify(replacement), legacyAliasKey, entry.sessionId, row.entry_json);
    if (Number(changed.changes) !== 1) throw new Error("task-created alias session changed during activation");
    await requireStoppedLease(root);
    db.exec("COMMIT");
    transaction = false;
    committed = true;
    return {};
  } finally {
    try {
      if (transaction) db.exec("ROLLBACK");
    } finally {
      try { db?.close(); } finally {
        try {
          if (!committed) {
            for (const file of created.toReversed()) {
              const current = await lstat(file.path);
              if (current.dev !== file.dev || current.ino !== file.ino) throw new Error("legacy activation rollback found a replaced file");
              await rm(file.path);
            }
            for (const directory of createdDirectories.toReversed()) await rmdir(directory);
          }
        } finally { await releasePort(); }
      }
    }
  }
}

async function main() {
  const argv = process.argv.slice(2), operation = argv.shift();
  await runEntry({ legacy: { type: "string" }, aliases: { type: "string" } }, async ({ state, env, args }) => {
    if (operation === "stage") return stageLegacyStore({ state, env });
    if (operation === "check") return checkLegacyStore(state);
    return activateLegacyStore({ state, env, legacyPath: args.legacy, aliasesPath: args.aliases });
  }, argv, (args) => {
    if (!["stage", "check", "activate"].includes(operation)) throw new EntryError("expected stage, check or activate", 2);
    if (operation === "activate") {
      if (!isAbsolute(args.legacy ?? "") || !isAbsolute(args.aliases ?? "")) throw new EntryError("activate requires absolute --legacy and --aliases fixture paths", 2);
    } else if (args.legacy !== undefined || args.aliases !== undefined) throw new EntryError("fixture paths are only accepted by activate", 2);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
