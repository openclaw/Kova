import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  activateLegacyStore, checkLegacyAliases, checkLegacyStore, legacyAliasKey,
  legacySearchWord, stageLegacyAliases, stageLegacyStore,
} from "../support/persona/legacy-store.mjs";
import { legacyAliasRows } from "../support/persona/write-legacy-alias-rows.mjs";

async function listener(t) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  t.after(async () => { if (server.listening) await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())); });
  return { port: server.address().port, close: () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())) };
}

async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), "kova-legacy-store-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  for (const path of ["agents/main/agent", "agents/main/sessions", "agents/idle/sessions", "state"]) await mkdir(join(state, path), { recursive: true });
  await writeFile(join(state, "openclaw.json"), JSON.stringify({ agents: { entries: { main: {}, idle: {} } } }));
  const database = join(state, "agents/main/agent/openclaw-agent.sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT)");
  const entry = { sessionId: "alias-session", updatedAt: 1792020000000, label: "kova-persona-legacy-aliases", delivery: { kind: "internal" }, channel: "current", lastChannel: "current", unrelated: "retained" };
  db.prepare("INSERT INTO session_nodes VALUES (?,?,?)").run(legacyAliasKey, entry.sessionId, JSON.stringify(entry));
  db.prepare("INSERT INTO session_nodes VALUES (?,?,?)").run("agent:main:unrelated", "unrelated-session", JSON.stringify({ sessionId: "unrelated-session", updatedAt: 1, label: "unrelated" }));
  db.close();
  const stateDatabase = join(state, "state/openclaw.sqlite");
  const shared = new DatabaseSync(stateDatabase);
  shared.exec("CREATE TABLE state_leases(scope TEXT, lease_key TEXT, payload_json TEXT)");
  shared.close();
  const port = await listener(t); await port.close();
  const env = { name: "source-persona", protected: true, gatewayPort: port.port };
  const legacy = await stageLegacyStore({ state, env });
  const aliases = await stageLegacyAliases({ state, env });
  return { state, database, stateDatabase, entry, legacy, aliases, env, activation: { state, env: { ...env, name: "disposable-clone", protected: false }, legacyPath: legacy.path, aliasesPath: aliases.path } };
}

function rows(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key").all().map((row) => [row.session_key, JSON.parse(row.entry_json)]); }
  finally { db.close(); }
}

async function noActiveLegacy(state) {
  for (const path of ["agents/main/sessions/sessions.json", "agents/main/sessions/kova-persona-legacy-history.jsonl", "agents/idle/sessions/sessions.json"]) await assert.rejects(readFile(join(state, path)), { code: "ENOENT" });
}

test("legacy checks inspect durable staged content without activating or weakening aliases", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await checkLegacyStore(f.state), f.legacy);
  assert.deepEqual(await legacyAliasRows(f.state), f.aliases);
  assert.equal(f.legacy.searchWord, legacySearchWord);
  assert.deepEqual(rows(f.database).find(([key]) => key === legacyAliasKey)[1], f.entry);
  await noActiveLegacy(f.state);
  const alias = JSON.parse(await readFile(f.aliases.path, "utf8"));
  assert.equal(alias.entry.provider, "kova-channel-probe");
  assert.equal(alias.entry.lastProvider, "kova-channel-probe");
  for (const field of ["delivery", "channel", "lastChannel"]) assert.equal(alias.entry[field], undefined);
  alias.entry.delivery = { kind: "internal" };
  await writeFile(f.aliases.path, JSON.stringify(alias));
  await assert.rejects(checkLegacyAliases(f.state), /already canonical/);
});

test("staged paths relocate after copying and activation retains sources and unrelated rows", async (t) => {
  const source = await fixture(t);
  const state = await mkdtemp(join(tmpdir(), "kova-legacy-clone-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await cp(source.state, state, { recursive: true });
  const legacy = await checkLegacyStore(state), aliases = await checkLegacyAliases(state);
  assert.notEqual(legacy.path, source.legacy.path);
  const activation = { ...source.activation, state, legacyPath: legacy.path, aliasesPath: aliases.path };
  await assert.rejects(activateLegacyStore({ ...activation, legacyPath: source.legacy.path }), /selected clone/);
  const database = join(state, "agents/main/agent/openclaw-agent.sqlite");
  const before = rows(database);
  assert.deepEqual(await activateLegacyStore(activation), {});
  const after = rows(database);
  const entry = after.find(([key]) => key === legacyAliasKey)[1];
  assert.equal(entry.provider, "kova-channel-probe");
  assert.equal(entry.lastProvider, "kova-channel-probe");
  assert.equal(entry.unrelated, "retained");
  for (const field of ["delivery", "channel", "lastChannel"]) assert.equal(entry[field], undefined);
  assert.deepEqual(after.find(([key]) => key !== legacyAliasKey), before.find(([key]) => key !== legacyAliasKey));
  assert.deepEqual(JSON.parse(await readFile(join(state, "agents/idle/sessions/sessions.json"), "utf8")), {});
  await assert.rejects(readFile(join(state, "agents/idle/agent/openclaw-agent.sqlite")), { code: "ENOENT" });
  const index = JSON.parse(await readFile(join(state, "agents/main/sessions/sessions.json"), "utf8"));
  assert.equal(Object.keys(index).length, 1);
  const transcript = await readFile(join(state, "agents/main/sessions/kova-persona-legacy-history.jsonl"), "utf8");
  assert.match(transcript, /KOVA_LEGACY_HISTORY/);
  assert.equal(transcript.trim().split("\n").length, 3);
  assert.deepEqual(await checkLegacyStore(state), legacy);
  assert.deepEqual(await checkLegacyAliases(state), aliases);
  await assert.rejects(activateLegacyStore(activation), /overwrite existing state/);
  await noActiveLegacy(source.state);
});

test("activation refuses protected sources, active listeners and live owner leases before writes", async (t) => {
  const f = await fixture(t), before = rows(f.database);
  await assert.rejects(activateLegacyStore({ ...f.activation, env: f.env }), /unprotected clone/);
  await assert.rejects(activateLegacyStore({ ...f.activation, env: { ...f.env, protected: false } }), /unprotected clone/);
  const live = await listener(t);
  await assert.rejects(activateLegacyStore({ ...f.activation, env: { ...f.activation.env, gatewayPort: live.port } }), /stopped Gateway/);
  const shared = new DatabaseSync(f.stateDatabase);
  shared.prepare("INSERT INTO state_leases VALUES ('gateway-owner','global',?)").run(JSON.stringify({ owner: { pid: process.pid, host: hostname() } }));
  shared.close();
  await assert.rejects(activateLegacyStore(f.activation), /live or unverifiable owner/);
  assert.deepEqual(rows(f.database), before);
  await noActiveLegacy(f.state);
});

test("activation validates every destination and staged source before mutation", async (t) => {
  const f = await fixture(t), before = rows(f.database);
  await mkdir(join(f.state, "agents/idle/agent"));
  await writeFile(join(f.state, "agents/idle/agent/openclaw-agent.sqlite"), "existing idle state");
  await assert.rejects(activateLegacyStore(f.activation), /overwrite existing state/);
  await rm(join(f.state, "agents/idle/agent/openclaw-agent.sqlite"));
  const alias = JSON.parse(await readFile(f.aliases.path, "utf8"));
  alias.entry.sessionId = "different-session";
  await writeFile(f.aliases.path, JSON.stringify(alias));
  await assert.rejects(activateLegacyStore(f.activation), /no longer match/);
  assert.deepEqual(rows(f.database), before);
  await noActiveLegacy(f.state);
});

test("failed alias update rolls back created legacy files and the database row", async (t) => {
  const f = await fixture(t), before = rows(f.database);
  await rm(join(f.state, "agents/idle/sessions"), { recursive: true });
  const db = new DatabaseSync(f.database);
  db.exec("CREATE TRIGGER refuse_fixture BEFORE UPDATE ON session_nodes BEGIN SELECT RAISE(ABORT, 'refused fixture write'); END");
  db.close();
  await assert.rejects(activateLegacyStore(f.activation), /refused fixture write/);
  await noActiveLegacy(f.state);
  assert.deepEqual(rows(f.database), before);
  assert.deepEqual(await checkLegacyAliases(f.state), f.aliases);
});

test("staged input aliases and active directory escapes are refused", async (t) => {
  const f = await fixture(t);
  await link(f.aliases.path, join(f.state, "hardlink.json"));
  await assert.rejects(checkLegacyAliases(f.state), /without hard links/);
  await rm(join(f.state, "hardlink.json"));
  await rm(join(f.state, "agents/main/sessions"), { recursive: true });
  await symlink(join(f.state, "agents/idle/sessions"), join(f.state, "agents/main/sessions"));
  await assert.rejects(activateLegacyStore(f.activation), /symbolic links/);
  await assert.rejects(readFile(join(f.state, "agents/idle/sessions/sessions.json")), { code: "ENOENT" });
});

test("legacy activation rejects missing paths and unrelated flags through the shared usage protocol", () => {
  for (const args of [[], ["activate", "--env", "unused"], ["activate", "--env", "unused", "--legacy", "relative", "--aliases", "/absolute"], ["check", "--env", "unused", "--legacy", "/absolute"]]) {
    const result = spawnSync(process.execPath, [new URL("../support/persona/legacy-store.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "usage");
  }
});
