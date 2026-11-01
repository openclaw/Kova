import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { ageColdFixture, checkColdFixture, coldSearchWord, coldStorageRequests, coldStorageRequestCases, inspectColdArchive, extractColdFixture } from "../support/persona/cold-storage.mjs";

const DAY = 86400000;
const key = "agent:main:kova-persona-cold", eligibleKey = "agent:main:kova-persona-cold-eligible";

function transcript(sessionId) {
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const events = [{ type: "session", id: sessionId }, ...ids.map((id, index) => ({
    type: "message", id, parentId: index ? ids[index - 1] : null,
    message: { role: index % 2 ? "assistant" : "user", content: `Notebook turn ${index}${index === 2 ? ` ${coldSearchWord}` : ""}` },
  }))];
  return { events, userEntryId: ids[2], leafEntryId: ids[3] };
}

function compressedArchive(sessionId, generated) {
  const generation = randomUUID().replaceAll("-", "");
  const events = generated.events.map((event, seq) => ({ kind: "event", row: { seq, event_json: JSON.stringify(event), created_at: 1 } }));
  const records = [
    { kind: "header", version: 1, sessionId, generation }, ...events,
    ...generated.events.map((event, seq) => ({ kind: "identity", row: { event_id: event.id, seq, parent_id: event.parentId ?? null, event_type: event.type, message_idempotency_key: null, created_at: 1 } })),
    { kind: "index", row: { indexed_seq: events.length - 1, leaf_event_id: generated.leafEntryId, needs_rebuild: 0, active_event_count: events.length, active_message_count: events.length - 1, updated_at: 1 } },
  ];
  const bytes = zstdCompressSync(Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`));
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, metadata: {
    session_id: sessionId, generation, archive_name: `${hash}.jsonl.zst`, archive_sha256: hash,
    event_count: events.length, raw_bytes: events.reduce((sum, record) => sum + Buffer.byteLength(record.row.event_json), 0) + events.length - 1,
    archive_bytes: bytes.length, last_seq: events.length - 1, archived_at: Date.now(), storage: "file", archive_blob: null,
  } };
}

async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), "kova-cold-"));
  const file = join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  t.after(async () => { db.close(); await rm(state, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, updated_at INTEGER, last_activity_at INTEGER, last_interaction_at INTEGER, status TEXT) STRICT;
    CREATE TABLE session_windows(session_id TEXT PRIMARY KEY, session_key TEXT, updated_at INTEGER, transcript_updated_at INTEGER, status TEXT) STRICT;
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT) STRICT;
    CREATE TABLE session_transcript_cold_archives(session_id TEXT PRIMARY KEY, generation TEXT, archive_name TEXT, archive_sha256 TEXT, event_count INTEGER, raw_bytes INTEGER, archive_bytes INTEGER, last_seq INTEGER, archived_at INTEGER, storage TEXT, archive_blob BLOB) STRICT;
    CREATE TABLE session_pending_inputs(session_id TEXT, state TEXT, consumed_event_id TEXT) STRICT;
  `);
  const config = { session: { maintenance: { mode: "warn", coldStorage: { enabled: false, afterDays: 30 } } } };
  const writeConfig = () => writeFile(join(state, "openclaw.json"), JSON.stringify(config));
  await writeConfig();
  const now = Date.now(), old = now - 40 * DAY;
  const add = (selectedKey, at = old) => {
    const sessionId = randomUUID(), generated = transcript(sessionId);
    const entry = { sessionId, label: selectedKey.split(":").at(-1), updatedAt: at, lastActivityAt: at, lastInteractionAt: at, sessionStartedAt: at };
    db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?, ?, NULL)").run(selectedKey, sessionId, JSON.stringify(entry), at, at, at);
    db.prepare("INSERT INTO session_windows VALUES (?, ?, ?, ?, NULL)").run(sessionId, selectedKey, at, at);
    for (const [seq, event] of generated.events.entries()) db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(sessionId, seq, JSON.stringify(event));
    return { sessionId, entry, ...generated };
  };
  const cold = add(key), eligible = add(eligibleKey);
  const archive = compressedArchive(cold.sessionId, cold);
  const path = join(state, "agents", "main", "sessions", "cold", archive.metadata.archive_name);
  const saveArchive = async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, archive.bytes);
    db.prepare("INSERT INTO session_transcript_cold_archives VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...Object.values(archive.metadata));
    db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(cold.sessionId);
  };
  const writeFixture = async ({ key: selected, sessionId, fields, maintenanceConfig }) => {
    assert.equal(maintenanceConfig.mode, "warn");
    assert.equal(maintenanceConfig.maxDiskBytes, null);
    const row = db.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ? AND current_session_id = ?").get(selected, sessionId);
    assert.ok(row);
    const entry = { ...JSON.parse(row.entry_json), ...fields };
    db.prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ?, last_activity_at = ?, last_interaction_at = ? WHERE session_key = ?").run(JSON.stringify(entry), entry.updatedAt, entry.lastActivityAt, entry.lastInteractionAt, selected);
    db.prepare("UPDATE session_windows SET updated_at = ? WHERE session_id = ?").run(entry.updatedAt, sessionId);
  };
  return { state, file, db, config, writeConfig, now, old, cold, eligible, archive, path, saveArchive, writeFixture, add };
}

test("cold check derives durable generated IDs from verified compressed content without hydration", async (t) => {
  const c = await fixture(t);
  await c.saveArchive();
  const before = await readFile(c.file), archiveBefore = await readFile(c.path);
  assert.deepEqual(await checkColdFixture({ state: c.state, key, eligibleKey, now: c.now }), {
    key, userEntryId: c.cold.userEntryId, leafEntryId: c.cold.leafEntryId, searchWord: coldSearchWord, eligibleKey,
  });
  assert.deepEqual(await readFile(c.file), before);
  assert.deepEqual(await readFile(c.path), archiveBefore);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?").get(c.cold.sessionId).count, 0);
});

test("eligibility rejects metadata-only aging, consumed state protection, and cross-generation references", async (t) => {
  const c = await fixture(t);
  await c.saveArchive();
  const check = () => checkColdFixture({ state: c.state, key, eligibleKey, now: c.now });
  c.db.prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?").run(c.now, c.eligible.sessionId);
  await assert.rejects(check(), /not genuinely eligible/);
  c.db.prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?").run(c.old, c.eligible.sessionId);
  c.db.prepare("INSERT INTO session_pending_inputs VALUES (?, 'queued', NULL)").run(c.eligible.sessionId);
  await assert.rejects(check(), /pending input/);
  c.db.prepare("UPDATE session_pending_inputs SET consumed_event_id = 'committed-input'").run();
  await check();
  const owner = c.add("agent:main:kova-persona-other");
  owner.entry.previousSessionId = c.eligible.sessionId;
  c.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE current_session_id = ?").run(JSON.stringify(owner.entry), owner.sessionId);
  await assert.rejects(check(), /cross-generation reference/);
});

test("offline age changes only the selected historical owner and transcript watermark", async (t) => {
  const c = await fixture(t);
  const beforeEvents = c.db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all();
  const other = c.db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(key);
  await ageColdFixture({ state: c.state, key: eligibleKey, now: c.now, writeFixture: c.writeFixture });
  assert.equal(c.db.prepare("SELECT transcript_updated_at FROM session_windows WHERE session_id = ?").get(c.eligible.sessionId).transcript_updated_at, c.now - 32 * DAY);
  assert.deepEqual(c.db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(), beforeEvents);
  assert.deepEqual(c.db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(key), other);
  await c.saveArchive();
  await checkColdFixture({ state: c.state, key, eligibleKey, now: c.now });
  c.config.session.maintenance.coldStorage.enabled = true;
  await c.writeConfig();
  await assert.rejects(ageColdFixture({ state: c.state, key: eligibleKey, writeFixture: c.writeFixture }), /enabled=false/);
});

test("archive verification rejects damage, wrong identity, incomplete index and wrong totals", async (t) => {
  const c = await fixture(t);
  const { bytes, metadata } = c.archive;
  assert.throws(() => inspectColdArchive(Buffer.concat([bytes, Buffer.from("damaged")]), metadata), /integrity/);
  assert.throws(() => inspectColdArchive(bytes, { ...metadata, session_id: randomUUID() }), /header identity/);
  assert.throws(() => inspectColdArchive(bytes, { ...metadata, raw_bytes: metadata.raw_bytes + 1 }), /totals/);
  const invalid = compressedArchive(c.cold.sessionId, { ...c.cold, leafEntryId: randomUUID() });
  assert.throws(() => inspectColdArchive(invalid.bytes, invalid.metadata), /complete active leaf/);
  await c.saveArchive();
  await writeFile(c.path, Buffer.concat([bytes, Buffer.from("damaged")]));
  await assert.rejects(checkColdFixture({ state: c.state, key, eligibleKey }), /integrity/);
});

test("unsafe archive paths and unsupported schemas fail before fixture metadata writes", async (t) => {
  const c = await fixture(t);
  await c.saveArchive();
  await rm(c.path);
  const outside = join(c.state, "outside.zst");
  await writeFile(outside, c.archive.bytes);
  await symlink(outside, c.path);
  await assert.rejects(checkColdFixture({ state: c.state, key, eligibleKey }), /regular file/);
  c.db.exec("ALTER TABLE session_windows RENAME COLUMN transcript_updated_at TO missing_timestamp");
  let writes = 0;
  await assert.rejects(ageColdFixture({ state: c.state, key: eligibleKey, writeFixture: async () => { writes++; } }), /unsupported cold fixture schema/);
  assert.equal(writes, 0);
  await assert.rejects(ageColdFixture({ state: c.state, key: "agent:main:main", writeFixture: async () => { writes++; } }), /exact kova-persona/);
});

for (const startupPending of [false, true]) test(`extraction waits for the selected durable archive (maintenance startup pending: ${startupPending})`, async (t) => {
  const c = await fixture(t);
  c.config.session.maintenance.coldStorage.enabled = true;
  await c.writeConfig();
  const methods = [];
  let runs = 0;
  const rpc = async ({ method }) => {
    methods.push(method);
    if (method === "config.get") return { config: c.config, path: join(c.state, "openclaw.json") };
    if (method === "sessions.storage.run") {
      if (++runs === 1 && startupPending) throw new Error("sessions.storage.run INVALID_REQUEST: Transcript maintenance is not running; wait for Gateway startup to finish");
      await c.saveArchive();
      return { maintenance: { running: true } };
    }
    if (method === "sessions.storage.status") return { maintenance: { running: false, lastCompletedAt: Date.now(), lastError: null } };
    assert.fail(method);
  };
  assert.deepEqual(await extractColdFixture({ rpc, state: c.state, key }), { key });
  assert.deepEqual(methods, ["config.get", ...(startupPending ? ["sessions.storage.run"] : []), "sessions.storage.run", "sessions.storage.status"]);
  assert.deepEqual(Object.keys(coldStorageRequests).sort(), Object.keys(coldStorageRequestCases).sort());
});

test("extraction does not retry a permanent worker refusal", async (t) => {
  const c = await fixture(t);
  c.config.session.maintenance.coldStorage.enabled = true;
  await c.writeConfig();
  const refusal = new Error("sessions.storage.run INVALID_REQUEST: Transcript cold storage is disabled");
  const methods = [];
  const rpc = async ({ method }) => {
    methods.push(method);
    if (method === "config.get") return { config: c.config, path: join(c.state, "openclaw.json") };
    throw refusal;
  };
  await assert.rejects(extractColdFixture({ rpc, state: c.state, key }), (error) => error === refusal);
  assert.deepEqual(methods, ["config.get", "sessions.storage.run"]);
});

test("extraction startup retry retains the overall deadline", async (t) => {
  const c = await fixture(t);
  c.config.session.maintenance.coldStorage.enabled = true;
  await c.writeConfig();
  let runs = 0;
  const rpc = async ({ method }) => {
    if (method === "config.get") return { config: c.config, path: join(c.state, "openclaw.json") };
    assert.equal(method, "sessions.storage.run");
    runs++;
    throw new Error("sessions.storage.run INVALID_REQUEST: Transcript maintenance is not running; wait for Gateway startup to finish");
  };
  await assert.rejects(extractColdFixture({ rpc, state: c.state, key, timeoutMs: 0 }), (error) => error.exitCode === 3 && /maintenance did not become ready/.test(error.message));
  assert.equal(runs, 1);
});
