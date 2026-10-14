import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readStoredSession, sessionKeyShortId } from "../support/persona/session-store-read.mjs";

const key = "agent:main:notebook-12345678-1234-4234-8234-123456789abc";
const otherKey = "agent:main:another-notebook";
const entry = { sessionId: "current-window", compactionCount: 2, label: "Notebook" };

async function fixture(t, compressed = true) {
  const root = await mkdtemp(join(tmpdir(), "kova-stored-session-"));
  const state = join(root, "state");
  const path = join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  t.after(async () => { close(); await rm(root, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE session_nodes (
    session_key TEXT NOT NULL PRIMARY KEY, current_session_id TEXT NOT NULL,
    entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE session_windows (
    session_id TEXT NOT NULL PRIMARY KEY, session_key TEXT NOT NULL,
    previous_session_id TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (session_key) REFERENCES session_nodes(session_key)
  ) STRICT;
  CREATE TABLE transcript_events (
    session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT${compressed ? "" : " NOT NULL"},
    created_at INTEGER NOT NULL${compressed ? ", event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT" : ""},
    PRIMARY KEY (session_id, seq), FOREIGN KEY (session_id) REFERENCES session_windows(session_id)
  ) STRICT;`);
  const addNode = db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?)");
  addNode.run(key, entry.sessionId, JSON.stringify(entry), 2);
  addNode.run(otherKey, "other-window", JSON.stringify({ sessionId: "other-window" }), 1);
  const addWindow = db.prepare("INSERT INTO session_windows VALUES (?, ?, ?, ?, ?, ?)");
  addWindow.run("old-window", key, null, "initial", 1, 1);
  addWindow.run(entry.sessionId, key, "old-window", "reset", 2, 2);
  addWindow.run("other-window", otherKey, null, "initial", 1, 1);
  const addEvent = (sessionId, seq, event) => db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)").run(sessionId, seq, JSON.stringify(event), 1);
  return { root, state, path, db, close, addEvent };
}

test("stored reads select the current identity or its real reset windows without changing the database", async (t) => {
  const f = await fixture(t, false);
  const old = { type: "message", id: "old-entry", message: { role: "user", content: "Before reset" } };
  const current = { type: "compaction", id: "current-entry", summary: "Notebook summary" };
  f.addEvent("old-window", 0, old);
  f.addEvent(entry.sessionId, 3, current);
  f.addEvent("other-window", 0, { type: "message", id: "unrelated-entry" });
  const before = await readFile(f.path);
  const selected = await readStoredSession(f.state, key);
  assert.deepEqual(selected.entry, entry);
  assert.deepEqual(selected.events, [{ sessionId: entry.sessionId, seq: 3, event: current }]);
  assert.equal(selected.windows.length, 1);
  const all = await readStoredSession(f.state, key, { allWindows: true });
  assert.deepEqual(all.events, [{ sessionId: "old-window", seq: 0, event: old }, { sessionId: entry.sessionId, seq: 3, event: current }]);
  assert.equal(all.windows.find((window) => window.session_id === entry.sessionId).previous_session_id, "old-window");
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(sessionKeyShortId(key), "12345678");
  assert.equal(sessionKeyShortId(key, 16), "1234567812344234");
  assert.throws(() => sessionKeyShortId(otherKey), /no UUID suffix/);
  f.db.prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?").run("old-window", key);
  await assert.rejects(readStoredSession(f.state, key), /identity differ/);
});

test("stored reads decode real zstd events and refuse corrupt sizes and bounded reads", async (t) => {
  const f = await fixture(t);
  const event = { type: "custom", id: "cache-note", customType: "openclaw.cache-ttl", data: { text: "cached output ".repeat(100) } };
  const json = Buffer.from(JSON.stringify(event));
  f.db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes) VALUES (?, 0, NULL, 1, ?, ?)").run(entry.sessionId, zstdCompressSync(json), json.length);
  assert.deepEqual((await readStoredSession(f.state, key)).events[0].event, event);
  await assert.rejects(readStoredSession(f.state, key, { maxBytes: Buffer.byteLength(JSON.stringify(entry)) + json.length - 1 }), /bytes exceed the read limit/);
  f.addEvent(entry.sessionId, 1, { type: "message", id: "another-entry" });
  await assert.rejects(readStoredSession(f.state, key, { maxEvents: 1 }), /event count exceeds/);
  f.db.prepare("UPDATE transcript_events SET event_utf8_bytes = ? WHERE session_id = ? AND seq = 0").run(json.length + 1, entry.sessionId);
  await assert.rejects(readStoredSession(f.state, key), /length differs/);
  f.db.prepare("UPDATE transcript_events SET event_utf8_bytes = 16 WHERE session_id = ? AND seq = 0").run(entry.sessionId);
  await assert.rejects(readStoredSession(f.state, key), (error) => error.code === "ERR_BUFFER_TOO_LARGE");
  f.db.prepare("UPDATE transcript_events SET event_utf8_bytes = ?, event_zstd = zeroblob(4194305) WHERE session_id = ? AND seq = 0").run(json.length, entry.sessionId);
  await assert.rejects(readStoredSession(f.state, key), /compressed event bytes/);
});

test("stored reads fail on missing owner tables and incomplete payload schemas", async (t) => {
  const f = await fixture(t);
  await assert.rejects(readStoredSession(f.state, "agent:main:absent"), /stored session is absent/);
  f.db.exec("DROP TABLE transcript_events");
  await assert.rejects(readStoredSession(f.state, key), /required session table is absent: transcript_events/);
  f.db.exec("CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, event_zstd BLOB)");
  await assert.rejects(readStoredSession(f.state, key), /incomplete compressed event schema/);
});

test("stored reads reject key traversal and database links outside the state directory", async (t) => {
  const f = await fixture(t);
  await assert.rejects(readStoredSession(f.state, "agent:../../outside:session"), /canonical agent session key/);
  f.close();
  const outside = join(f.root, "outside.sqlite");
  await copyFile(f.path, outside);
  await rm(f.path);
  await symlink(outside, f.path);
  await assert.rejects(readStoredSession(f.state, key), /regular file inside the task environment/);
});
