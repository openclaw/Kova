#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import JSON5 from "json5";
import { EntryError, runEntry } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { collectionPolicy, openCollectionFixture, readCollectionRows } from "./session-collections.mjs";
import { readStoredSession, requireSessionContentRuntime, resolveSessionDatabasePath } from "./session-store-read.mjs";

const DAY = 86400000;
const MAX_ARCHIVE = 8 * 1024 * 1024;
const MAX_ENVELOPE = 16 * 1024 * 1024;
const MAX_EVENTS = 2048;
const keyPattern = /^agent:([a-z0-9][a-z0-9_-]{0,63}):kova-persona-(cold|cold-eligible)$/;
export const coldSearchWord = "KOVA_COLD_HISTORY";
export const coldStorageRequests = {
  config: () => ({ method: "config.get", params: {} }),
  run: () => ({ method: "sessions.storage.run", params: {} }),
  status: () => ({ method: "sessions.storage.status", params: {} }),
};
export const coldStorageRequestCases = { config: [[]], run: [[]], status: [[]] };

function agentFor(key) {
  const match = typeof key === "string" && key.match(keyPattern);
  if (!match) throw new EntryError("cold fixtures require an exact kova-persona-cold or kova-persona-cold-eligible key", 2);
  return match[1];
}

async function coldConfig(state, enabled) {
  const file = join(await realpath(state), "openclaw.json");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("cold fixture configuration must be a bounded regular file");
  const config = JSON5.parse(await readFile(file, "utf8"));
  const maintenance = config?.session?.maintenance;
  if (maintenance?.mode !== "warn" || maintenance.coldStorage?.enabled !== enabled) throw new Error(`cold fixture requires maintenance mode=warn and coldStorage.enabled=${enabled}`);
  const afterDays = maintenance.coldStorage.afterDays ?? 30;
  if (!Number.isSafeInteger(afterDays) || afterDays < 1 || afterDays > 3650) throw new Error("cold fixture afterDays exceeds its bound");
  if (config.session.store !== undefined) throw new Error("cold fixtures require the canonical agent store");
  return { config, afterDays };
}

function schema(db, table, required) {
  if (db.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table)?.type !== "table") throw new Error(`unsupported cold fixture schema: ${table}`);
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (required.some((name) => !names.has(name))) throw new Error(`unsupported cold fixture schema: ${table}`);
  return names;
}

async function openColdDatabase(state, agentId, writable = false) {
  requireSessionContentRuntime();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(await resolveSessionDatabasePath(state, agentId, { writable }), { readOnly: !writable, allowExtension: false });
  try {
    db.exec(`PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; ${writable ? "" : "PRAGMA query_only = ON;"}`);
    schema(db, "session_nodes", ["session_key", "current_session_id", "entry_json", "updated_at", "last_activity_at", "last_interaction_at", "status"]);
    schema(db, "session_windows", ["session_id", "session_key", "updated_at", "transcript_updated_at", "status"]);
    schema(db, "transcript_events", ["session_id", "seq", "event_json"]);
    schema(db, "session_transcript_cold_archives", ["session_id", "generation", "archive_name", "archive_sha256", "event_count", "raw_bytes", "archive_bytes", "last_seq", "archived_at", "storage", "archive_blob"]);
    return db;
  } catch (error) { db.close(); throw error; }
}

function fixtureEntry(rows, key) {
  const entry = rows.get(key);
  if (!entry || entry.label !== key.split(":").at(-1) || typeof entry.sessionId !== "string" || !entry.sessionId) throw new Error("cold fixture has no task-created session identity and label");
  return entry;
}

function windowFor(db, key, sessionId) {
  const row = db.prepare(`SELECT window.session_id, window.session_key, window.updated_at, window.transcript_updated_at,
    window.status, node.updated_at AS node_updated_at, node.last_activity_at, node.last_interaction_at,
    node.status AS node_status FROM session_windows window JOIN session_nodes node ON node.session_key = window.session_key
    WHERE window.session_key = ? AND window.session_id = ? AND node.current_session_id = window.session_id`).get(key, sessionId);
  if (!row) throw new Error("cold fixture window identity changed");
  return row;
}

function assertEligible(db, rows, key, before) {
  const entry = fixtureEntry(rows, key);
  const window = windowFor(db, key, entry.sessionId);
  const times = [window.updated_at, window.transcript_updated_at, window.node_updated_at, window.last_activity_at, window.last_interaction_at];
  if (times.some((value) => !Number.isSafeInteger(value) || value < 1 || value >= before) || window.status === "running" || window.node_status === "running") throw new Error("cold fixture is not genuinely eligible: recent activity or transcript mutation");
  if (db.prepare("SELECT 1 FROM session_transcript_cold_archives WHERE session_id = ?").get(entry.sessionId)) throw new Error("eligible cold fixture has already been archived");
  if (!db.prepare("SELECT 1 FROM transcript_events WHERE session_id = ? LIMIT 1").get(entry.sessionId)) throw new Error("eligible cold fixture has no hot transcript");
  for (const [ownerKey, owner] of rows) {
    const recovery = owner.mainRestartRecovery;
    if (ownerKey === key && (["admitted", "pending", "continue"].includes(owner.restartRecoveryBeforeAgentReplyState) || owner.restartRecoveryDeliveryReceiptState === "terminal-pending" || recovery?.reservation || recovery?.foregroundClaims)) throw new Error("cold fixture is protected by restart recovery");
    const ids = [owner.previousSessionId, ...(owner.usageFamilySessionIds ?? []).filter((id) => id !== owner.sessionId)];
    if (owner.compactionCheckpoints !== undefined && !Array.isArray(owner.compactionCheckpoints)) throw new Error("invalid legacy compaction references");
    for (const checkpoint of owner.compactionCheckpoints ?? []) {
      if (!checkpoint?.preCompaction || !checkpoint.postCompaction) throw new Error("invalid legacy compaction references");
      ids.push(checkpoint.sessionId, checkpoint.preCompaction.sessionId, checkpoint.postCompaction.sessionId);
    }
    if (ids.includes(entry.sessionId)) throw new Error("cold fixture is protected by a cross-generation reference");
  }
  const pendingColumns = schema(db, "session_pending_inputs", ["session_id", "state"]);
  if (db.prepare(`SELECT 1 FROM session_pending_inputs WHERE session_id = ? AND state IN ('queued', 'interrupted') ${pendingColumns.has("consumed_event_id") ? "AND consumed_event_id IS NULL" : ""} LIMIT 1`).get(entry.sessionId)) throw new Error("cold fixture has pending input");
  return entry;
}

/** The lifecycle owner stops the Gateway before this single, task-scoped historical fixture operation. */
export async function ageColdFixture({ env, state, key, writeFixture, now = Date.now() }) {
  const agentId = agentFor(key);
  const { config, afterDays } = await coldConfig(state, false);
  const stored = await readStoredSession(state, key, { maxEvents: MAX_EVENTS, maxBytes: MAX_ENVELOPE });
  fixtureEntry(new Map([[key, stored.entry]]), key);
  const old = now - (afterDays + 2) * DAY;
  if (!Number.isSafeInteger(old) || old < 1) throw new Error("invalid cold fixture historical date");
  // Preflight the full schema before any metadata mutation.
  const preflight = await openColdDatabase(state, agentId);
  try { windowFor(preflight, key, stored.sessionId); schema(preflight, "session_pending_inputs", ["session_id", "state"]); } finally { preflight.close(); }
  const policy = collectionPolicy(config);
  const patch = writeFixture ?? await openCollectionFixture(env, state);
  await patch({ agentId, key, sessionId: stored.sessionId, maintenanceConfig: {
    mode: "warn", maxEntries: policy.maxEntries, pruneAfterMs: policy.pruneAfter, archiveDashboardAfterMs: policy.dashboardAfter,
    modelRunPruneAfterMs: DAY, preserveRecentMs: null, resetArchiveRetentionMs: null, maxDiskBytes: null, highWaterBytes: null,
  }, fields: { updatedAt: old, lastActivityAt: old, lastInteractionAt: old, sessionStartedAt: old } });
  const db = await openColdDatabase(state, agentId, true);
  try {
    db.exec("BEGIN IMMEDIATE");
    windowFor(db, key, stored.sessionId);
    if (db.prepare("SELECT 1 FROM session_transcript_cold_archives WHERE session_id = ?").get(stored.sessionId)) throw new Error("cannot age an archived transcript");
    const changed = db.prepare("UPDATE session_windows SET updated_at = ?, transcript_updated_at = ? WHERE session_id = ? AND session_key = ?").run(old, old, stored.sessionId, key);
    if (changed.changes !== 1) throw new Error("cold fixture timestamp update lost its identity");
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; } finally { db.close(); }
  return { key, sessionId: stored.sessionId };
}

async function archiveMetadata(state, agentId, key) {
  const rows = await readCollectionRows(state, agentId), entry = fixtureEntry(rows, key);
  const db = await openColdDatabase(state, agentId);
  try {
    db.exec("BEGIN");
    windowFor(db, key, entry.sessionId);
    const archive = db.prepare(`SELECT session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
      archive_bytes, last_seq, archived_at, storage, CASE WHEN length(archive_blob) <= ? THEN archive_blob END AS archive_blob
      FROM session_transcript_cold_archives WHERE session_id = ?`).get(MAX_ARCHIVE, entry.sessionId);
    if (archive && db.prepare("SELECT 1 FROM transcript_events WHERE session_id = ? LIMIT 1").get(entry.sessionId)) throw new Error("cold fixture retains hot events beside its archive");
    return archive;
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
}

export async function extractColdFixture({ rpc, state, key, timeoutMs = 120000 }) {
  const agentId = agentFor(key);
  await coldConfig(state, true);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await rpc(coldStorageRequests.config());
    if (typeof snapshot?.path !== "string" || await realpath(dirname(snapshot.path)) !== await realpath(state)) throw new Error("cold maintenance belongs to a different environment");
    if (snapshot.config?.session?.maintenance?.coldStorage?.enabled === true && snapshot.config.session.maintenance.mode === "warn") break;
    if (Date.now() >= deadline) throw new EntryError("cold storage configuration did not become active", 3);
    await sleep(100);
  }
  for (;;) {
    try { await rpc(coldStorageRequests.run()); break; }
    catch (error) {
      if (error.message !== "sessions.storage.run INVALID_REQUEST: Transcript maintenance is not running; wait for Gateway startup to finish") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new EntryError("cold storage maintenance did not become ready", 3);
      await sleep(Math.min(100, remaining));
      if (Date.now() >= deadline) throw new EntryError("cold storage maintenance did not become ready", 3);
    }
  }
  for (;;) {
    const result = await rpc(coldStorageRequests.status());
    if (result?.maintenance?.lastError) throw new Error(`cold extraction failed: ${result.maintenance.lastError}`);
    if (result?.maintenance?.running === false && result.maintenance.lastCompletedAt && await archiveMetadata(state, agentId, key)) return { key };
    if (Date.now() >= deadline) throw new EntryError("cold extraction did not archive the selected transcript", 3);
    await sleep(100);
  }
}

function messageText(event) {
  const content = event?.message?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : "";
}

export function inspectColdArchive(bytes, archive) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ARCHIVE || bytes.length !== archive.archive_bytes || createHash("sha256").update(bytes).digest("hex") !== archive.archive_sha256) throw new Error("cold archive integrity differs from saved metadata");
  if (!Number.isSafeInteger(archive.event_count) || archive.event_count < 1 || archive.event_count > MAX_EVENTS) throw new Error("cold archive event count exceeds its bound");
  const envelope = new TextDecoder("utf-8", { fatal: true }).decode(zstdDecompressSync(bytes, { maxOutputLength: MAX_ENVELOPE }));
  const lines = envelope.trimEnd().split("\n");
  if (lines.length > MAX_EVENTS * 5 + 2 || lines.some((line) => Buffer.byteLength(line) > 4 * 1024 * 1024)) throw new Error("cold archive envelope exceeds its bound");
  const records = lines.map((line) => JSON.parse(line));
  const header = records.shift();
  if (header?.kind !== "header" || header.version !== 1 || header.sessionId !== archive.session_id || header.generation !== archive.generation) throw new Error("cold archive header identity differs");
  const events = [], identities = new Map(), indexes = [];
  let rawBytes = 0, lastSeq = -1;
  for (const record of records) {
    if (!["event", "identity", "active", "index", "fts"].includes(record?.kind) || !record.row || typeof record.row !== "object") throw new Error("invalid cold archive record");
    if (record.kind === "event") {
      const { seq, event_json: json } = record.row;
      if (!Number.isSafeInteger(seq) || seq <= lastSeq || typeof json !== "string") throw new Error("invalid cold archive event sequence");
      lastSeq = seq; rawBytes += Buffer.byteLength(json); events.push({ seq, event: JSON.parse(json) });
    } else if (record.kind === "identity") {
      if (typeof record.row.event_id !== "string" || identities.has(record.row.event_id)) throw new Error("invalid cold archive event identity");
      identities.set(record.row.event_id, record.row);
    } else if (record.kind === "index") indexes.push(record.row);
  }
  if (events.length !== archive.event_count || lastSeq !== archive.last_seq || rawBytes + events.length - 1 !== archive.raw_bytes) throw new Error("cold archive event totals differ");
  const users = events.filter(({ event }) => event.type === "message" && event.message?.role === "user");
  const assistants = events.filter(({ event }) => event.type === "message" && event.message?.role === "assistant");
  const anchors = users.filter(({ event }) => messageText(event).includes(coldSearchWord));
  if (users.length < 2 || assistants.length < 2 || anchors.length !== 1) throw new Error("cold archive lacks the saved notebook turns and unique search word");
  const user = anchors[0], index = indexes[0];
  const leaf = events.find(({ event }) => event.id === index?.leaf_event_id);
  if (indexes.length !== 1 || index.needs_rebuild !== 0 || index.indexed_seq !== archive.last_seq || !leaf) throw new Error("cold archive has no complete active leaf");
  for (const selected of [user, leaf]) if (typeof selected.event.id !== "string" || identities.get(selected.event.id)?.seq !== selected.seq) throw new Error("cold archive message identity differs");
  return { userEntryId: user.event.id, leafEntryId: leaf.event.id, searchWord: coldSearchWord };
}

async function archiveBytes(state, agentId, archive) {
  if (archive.storage === "sqlite") {
    if (!(archive.archive_blob instanceof Uint8Array)) throw new Error("cold embedded archive exceeds its byte bound or is absent");
    return archive.archive_blob;
  }
  if (archive.storage !== "file" || !/^[a-f0-9]{64}\.jsonl\.zst$/.test(archive.archive_name) || archive.archive_blob !== null) throw new Error("invalid cold archive storage locator");
  let path = await realpath(state);
  for (const [index, part] of ["agents", agentId, "sessions", "cold", archive.archive_name].entries()) {
    path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (index < 4 ? !stat.isDirectory() : !stat.isFile() || stat.size > MAX_ARCHIVE)) throw new Error("cold archive must be a bounded regular file inside the selected environment");
  }
  return readFile(path);
}

export async function checkColdFixture({ state, key, eligibleKey, now = Date.now() }) {
  const agentId = agentFor(key);
  if (agentFor(eligibleKey) !== agentId || eligibleKey === key) throw new Error("cold and eligible fixtures require distinct same-agent keys");
  const { afterDays } = await coldConfig(state, false);
  const archive = await archiveMetadata(state, agentId, key);
  if (!archive) throw new Error("saved cold transcript archive is absent");
  const keys = inspectColdArchive(await archiveBytes(state, agentId, archive), archive);
  const rows = await readCollectionRows(state, agentId);
  const db = await openColdDatabase(state, agentId);
  try {
    db.exec("BEGIN");
    assertEligible(db, rows, eligibleKey, now - afterDays * DAY);
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
  const eligible = await readStoredSession(state, eligibleKey, { maxEvents: MAX_EVENTS, maxBytes: MAX_ENVELOPE });
  if (eligible.events.filter(({ event }) => event.type === "message" && event.message?.role === "user").length < 2) throw new Error("eligible fixture has insufficient notebook content");
  return { key, ...keys, eligibleKey };
}

async function main() {
  const argv = process.argv.slice(2), operation = argv.shift();
  if (operation === "age") process.env.OPENCLAW_LOG_LEVEL = "warn";
  await runEntry({ key: { type: "string", required: true, pattern: keyPattern }, "eligible-key": { type: "string", pattern: keyPattern } }, ({ args, env, state }) => {
    if (operation === "age") return ageColdFixture({ env, state, key: args.key });
    if (operation === "extract") return withSessionClient(env, (rpc) => extractColdFixture({ rpc, state, key: args.key }));
    return checkColdFixture({ state, key: args.key, eligibleKey: args["eligible-key"] });
  }, argv, (args) => {
    requireSessionContentRuntime();
    if (!["age", "extract", "check"].includes(operation)) throw new EntryError("expected age, extract or check", 2);
    if ((operation === "check") !== (args["eligible-key"] !== undefined)) throw new EntryError("--eligible-key is required only for check", 2);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
