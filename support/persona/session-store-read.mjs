import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as zlib from "node:zlib";
import { EntryError } from "./common.mjs";

const MAX_EVENTS = 50000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_WINDOWS = 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const agentKey = /^agent:([a-z0-9][a-z0-9_-]{0,63}):[^\s\u0000-\u001f\u007f]+$/;
const uuidSuffix = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function requireSessionContentRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new EntryError("session content requires Node.js 22.19.0 or newer", 2);
}

export function sessionKeyShortId(key, length = 8) {
  if (typeof key !== "string" || !agentKey.test(key)) throw new Error("a canonical agent session key is required");
  if (!Number.isInteger(length) || length < 8 || length > 32) throw new Error("short session id length must be between 8 and 32");
  const match = key.match(uuidSuffix);
  if (!match) throw new Error("session key has no UUID suffix for a short session id");
  return match[1].replaceAll("-", "").toLowerCase().slice(0, length);
}

async function databasePath(state, agentId) {
  if (typeof state !== "string" || !isAbsolute(state)) throw new Error("an absolute task environment state directory is required");
  const root = await realpath(state);
  if (!(await lstat(root)).isDirectory()) throw new Error("task environment state is not a directory");
  let path = root;
  const parts = ["agents", agentId, "agent", "openclaw-agent.sqlite"];
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("session database must be a regular file inside the task environment");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      const stat = await lstat(`${path}${suffix}`);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("session database sidecar is not a regular task environment file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return path;
}

function columns(db, table, required, optional = false) {
  const found = db.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table);
  if (!found && optional) return null;
  if (found?.type !== "table") throw new Error(`required session table is absent: ${table}`);
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const name of required) if (!names.has(name)) throw new Error(`unsupported session table: ${table}.${name} is absent`);
  return names;
}

function parseRecord(json, label) {
  let value;
  try { value = JSON.parse(json); } catch { throw new Error(`${label} contains invalid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value;
}

function boundedInteger(value, max, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} must be between 1 and ${max}`);
  return value;
}

function readPayload(row) {
  if (row.json_bytes !== null) {
    boundedInteger(row.json_bytes, MAX_EVENT_BYTES, "stored event bytes");
    if (row.zstd_bytes !== null || typeof row.event_json !== "string") throw new Error("stored event has ambiguous or absent payload");
    return { json: row.event_json, bytes: row.json_bytes };
  }
  boundedInteger(row.zstd_bytes, MAX_EVENT_BYTES, "compressed event bytes");
  boundedInteger(row.event_utf8_bytes, MAX_EVENT_BYTES, "expanded event bytes");
  if (!(row.event_zstd instanceof Uint8Array) || typeof zlib.zstdDecompressSync !== "function") throw new Error("compressed event requires a zstd-capable Node runtime");
  const bytes = zlib.zstdDecompressSync(row.event_zstd, { maxOutputLength: row.event_utf8_bytes });
  if (bytes.byteLength !== row.event_utf8_bytes) throw new Error("compressed event length differs from its stored size");
  return { json: decoder.decode(bytes), bytes: bytes.byteLength };
}

export async function readStoredSession(state, key, { maxEvents = MAX_EVENTS, maxBytes = MAX_BYTES, allWindows = false } = {}) {
  requireSessionContentRuntime();
  const matched = typeof key === "string" && key.match(agentKey);
  if (!matched) throw new Error("a canonical agent session key is required");
  boundedInteger(maxEvents, MAX_EVENTS, "maximum event count");
  boundedInteger(maxBytes, MAX_BYTES, "maximum decoded bytes");
  if (typeof allWindows !== "boolean") throw new Error("allWindows must be a boolean");
  const path = await databasePath(state, matched[1]);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  let reading = false;
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    reading = true;
    columns(db, "session_nodes", ["session_key", "current_session_id", "entry_json"]);
    const windowColumns = columns(db, "session_windows", ["session_key", "session_id"]);
    const eventColumns = columns(db, "transcript_events", ["session_id", "seq", "event_json"]);
    const compressed = eventColumns.has("event_zstd");
    if (compressed !== eventColumns.has("event_utf8_bytes")) throw new Error("incomplete compressed event schema");
    const node = db.prepare(`SELECT session_key, current_session_id,
      length(CAST(entry_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(entry_json AS BLOB)) <= ? THEN entry_json END AS entry_json
      FROM session_nodes WHERE session_key = ?`).get(MAX_EVENT_BYTES, key);
    if (!node) throw new Error("stored session is absent");
    boundedInteger(node.bytes, Math.min(MAX_EVENT_BYTES, maxBytes), "session entry bytes");
    const entry = parseRecord(node.entry_json, "session entry");
    if (typeof node.current_session_id !== "string" || !node.current_session_id || entry.sessionId !== node.current_session_id) throw new Error("session entry and current window identity differ");
    const selectedColumns = ["session_id", "session_key", "previous_session_id", "reason", "created_at", "updated_at"].filter((name) => windowColumns.has(name));
    const windows = db.prepare(`SELECT ${selectedColumns.join(", ")} FROM session_windows
      WHERE session_key = ? ${allWindows ? "" : "AND session_id = ?"}
      ORDER BY ${windowColumns.has("created_at") ? "created_at, " : ""}session_id LIMIT ?`)
      .all(...(allWindows ? [key, MAX_WINDOWS + 1] : [key, node.current_session_id, MAX_WINDOWS + 1]));
    if (windows.length > MAX_WINDOWS) throw new Error("session window count exceeds the read limit");
    if (!windows.some((window) => window.session_id === node.current_session_id)) throw new Error("current session window is absent");
    const cold = columns(db, "session_transcript_cold_archives", ["session_id"], true);
    const coldWindow = cold && db.prepare("SELECT 1 FROM session_transcript_cold_archives WHERE session_id = ? LIMIT 1");
    if (cold) for (const window of windows) {
      if (coldWindow.get(window.session_id)) throw new Error("session events are archived; hot-event inspection is incomplete");
    }
    if (allWindows && columns(db, "session_transcript_archives", ["session_id", "session_key"], true)) {
      if (db.prepare(`SELECT 1 FROM session_transcript_archives archive WHERE archive.session_key = ?
        AND NOT EXISTS (SELECT 1 FROM transcript_events event WHERE event.session_id = archive.session_id) LIMIT 1`).get(key)) throw new Error("reset session events are archived; hot-event inspection is incomplete");
    }
    const payload = `length(CAST(event_json AS BLOB)) AS json_bytes,
      CASE WHEN length(CAST(event_json AS BLOB)) <= ${MAX_EVENT_BYTES} THEN event_json END AS event_json,
      ${compressed ? `length(event_zstd) AS zstd_bytes, event_utf8_bytes,
      CASE WHEN length(event_zstd) <= ${MAX_EVENT_BYTES} THEN event_zstd END AS event_zstd` : "NULL AS zstd_bytes, NULL AS event_utf8_bytes, NULL AS event_zstd"}`;
    const select = db.prepare(`SELECT seq, ${payload} FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT ?`);
    const remaining = db.prepare("SELECT 1 FROM transcript_events WHERE session_id = ? AND seq > ? LIMIT 1");
    const events = [];
    let bytes = node.bytes;
    for (const window of windows) {
      let lastSeq = -1;
      for (const row of select.iterate(window.session_id, maxEvents - events.length)) {
        if (!Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq <= lastSeq) throw new Error("invalid stored event sequence");
        const decodedSize = row.json_bytes ?? row.event_utf8_bytes;
        boundedInteger(decodedSize, MAX_EVENT_BYTES, "stored event bytes");
        if (bytes + decodedSize > maxBytes) throw new Error("session event bytes exceed the read limit");
        const decoded = readPayload(row);
        events.push(Object.freeze({ sessionId: window.session_id, seq: row.seq, event: parseRecord(decoded.json, "session event") }));
        bytes += decoded.bytes;
        lastSeq = row.seq;
      }
      if (remaining.get(window.session_id, lastSeq)) throw new Error("session event count exceeds the read limit");
    }
    return Object.freeze({ key: node.session_key, sessionId: node.current_session_id, entry, windows: Object.freeze(windows.map(Object.freeze)), events: Object.freeze(events) });
  } finally {
    try { if (reading) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}
