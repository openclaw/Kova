import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadCatalogue } from "../src/catalogue.mjs";
import { channelContent } from "../support/persona/channel-content.mjs";
import { linkedPeer } from "../support/persona/environment-content.mjs";
import { createStaleDmPeer, checkStaleDmPeers, staleDmPeers } from "../support/persona/make-stale-dm-rows.mjs";
import { validateProbeRequest } from "../support/plugins/kova-channel-probe/protocol.js";

async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), "kova-stale-dm-"));
  const file = join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  t.after(async () => { db.close(); await rm(state, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT) STRICT;
    CREATE TABLE session_windows(session_id TEXT PRIMARY KEY, session_key TEXT) STRICT;
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT) STRICT;`);
  const config = { session: { dmScope: "per-channel-peer", identityLinks: {
    "persona-peer": [`${channelContent.channel}:${linkedPeer}`],
    ...Object.fromEntries(staleDmPeers.map((peer) => [peer.identityId, [`${channelContent.channel}:${peer.peer}`]])),
  } } };
  const requests = [], pending = new Map();
  const add = (peer, message, routedKey = peer.key) => {
    const sessionId = randomUUID();
    const entry = { sessionId, updatedAt: Date.now(), status: "done", delivery: { kind: "external", origin: { provider: channelContent.channel, chatType: "direct", to: peer.peer } } };
    db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(routedKey, sessionId, JSON.stringify(entry));
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(sessionId, routedKey);
    db.prepare("INSERT INTO transcript_events VALUES (?, 0, ?)").run(sessionId, JSON.stringify({ type: "session", id: sessionId }));
    db.prepare("INSERT INTO transcript_events VALUES (?, 1, ?)").run(sessionId, JSON.stringify({ type: "message", id: randomUUID(), message: { role: "user", content: message } }));
    return sessionId;
  };
  const complete = (sessionId, content = "KOVA_AGENT_OK") => db.prepare("INSERT INTO transcript_events VALUES (?, 2, ?)").run(sessionId, JSON.stringify({ type: "message", id: randomUUID(), message: { role: "assistant", content: [{ type: "text", text: content }], stopReason: "stop" } }));
  const rpc = async (request) => {
    requests.push(request);
    const { method, params } = request;
    if (method === "config.get") return { config, path: join(state, "openclaw.json") };
    if (method === "kova.channelProbe.status") return { ok: true, channelId: channelContent.channel, accountId: channelContent.account, dmScope: config.session.dmScope };
    if (method === "kova.channelProbe.inject") {
      validateProbeRequest(method, params);
      const peer = staleDmPeers.find((value) => value.peer === params.targetId);
      assert.ok(peer);
      assert.equal(params.chatType, "direct");
      const sessionId = add(peer, params.message), runId = randomUUID();
      pending.set(runId, sessionId);
      return { ok: true, observation: { inboundEvent: { id: params.inboundEventId }, dispatched: true, routeSessionKey: peer.key, runId } };
    }
    assert.equal(method, "agent.wait");
    assert.ok(pending.has(params.runId));
    complete(pending.get(params.runId));
    pending.delete(params.runId);
    return { runId: params.runId, status: "ok" };
  };
  const edit = (peer, update) => {
    const row = db.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(peer.key);
    const entry = JSON.parse(row.entry_json);
    update(entry);
    db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(JSON.stringify(entry), peer.key);
  };
  const build = async () => {
    const results = [];
    for (const peer of staleDmPeers) results.push(await createStaleDmPeer({ rpc, state, peerIndex: peer.index }));
    return results;
  };
  return { state, file, db, config, requests, rpc, add, complete, edit, build };
}

test("each DM operation admits one native channel input and returns only its durable created identities", async (t) => {
  const c = await fixture(t), configBefore = structuredClone(c.config);
  const results = await c.build();
  assert.equal(new Set(results.map((result) => result.sessionId)).size, 3);
  assert.deepEqual(results.map((result) => result.key), staleDmPeers.map((peer) => peer.key));
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), ["key", "sessionId"]);
    assert.equal(c.db.prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?").get(result.key).current_session_id, result.sessionId);
    // These native keys satisfy cleanup's channel:direct:<single peer> shape.
    assert.match(result.key, /^agent:main:[^:]+:direct:[^:]+$/);
  }
  const { catalogue } = await loadCatalogue("openclaw");
  const createEntry = catalogue.entries.find((entry) => entry.command.includes("make-stale-dm-rows.mjs create "));
  const checkEntry = catalogue.entries.find((entry) => entry.command.includes("make-stale-dm-rows.mjs check "));
  assert.ok(createEntry && checkEntry, "both DM operations require catalogue entries");
  assert.deepEqual(createEntry.creates.toSorted(), Object.keys(results[0]).map((name) => `/${name}`).toSorted());
  assert.deepEqual(checkEntry.creates, []);
  assert.equal(c.requests.filter(({ method }) => method === "kova.channelProbe.inject").length, 3);
  assert.equal(c.requests.filter(({ method }) => method === "agent.wait").length, 3);
  assert.ok(c.requests.every(({ method }) => ["config.get", "kova.channelProbe.status", "kova.channelProbe.inject", "agent.wait"].includes(method)));
  const bytesBefore = await readFile(c.file);
  c.requests.length = 0;
  assert.deepEqual(await checkStaleDmPeers({ rpc: c.rpc, state: c.state }), {});
  assert.deepEqual(c.requests.map(({ method }) => method), ["config.get"]);
  assert.deepEqual(await readFile(c.file), bytesBefore);
  assert.deepEqual(c.config, configBefore, "construction and checks retain isolated routing and the earlier linked peer");
});

test("metadata-only rows, incomplete replies and archived or internal rows do not qualify", async (t) => {
  const c = await fixture(t);
  const results = await c.build(), peer = staleDmPeers[1], selected = results[1];
  const check = () => checkStaleDmPeers({ rpc: c.rpc, state: c.state });
  const events = c.db.prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq").all(selected.sessionId);
  c.db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(selected.sessionId);
  await assert.rejects(check(), /unique synthetic notebook input/);
  for (const event of events.filter((event) => event.seq < 2)) c.db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(selected.sessionId, event.seq, event.event_json);
  await assert.rejects(check(), /completed synthetic notebook reply/);
  c.complete(selected.sessionId);
  c.edit(peer, (entry) => { entry.archivedAt = Date.now(); });
  await assert.rejects(check(), /active external direct-message row/);
  c.edit(peer, (entry) => { delete entry.archivedAt; entry.delivery.kind = "internal"; });
  await assert.rejects(check(), /active external direct-message row/);
});

test("input must finish successfully and route to a cleanup-compatible peer key", async (t) => {
  const c = await fixture(t);
  const rpc = async (request) => request.method === "agent.wait" ? { runId: request.params.runId, status: "error" } : c.rpc(request);
  await assert.rejects(createStaleDmPeer({ rpc, state: c.state, peerIndex: 1 }), /channel input did not complete/);
  assert.equal(c.requests.filter(({ method }) => method === "kova.channelProbe.inject").length, 1);
  const wrongRoute = async (request) => {
    const result = await c.rpc(request);
    if (request.method === "kova.channelProbe.inject") result.observation.routeSessionKey = `agent:main:kova-channel-probe:direct:${staleDmPeers[1].peer}`;
    return result;
  };
  await assert.rejects(createStaleDmPeer({ rpc: wrongRoute, state: c.state, peerIndex: 2 }), /isolated cleanup candidate/);
});

test("scope changes, missing linked identity and ambiguous aliases fail before inbound mutation", async (t) => {
  const c = await fixture(t);
  const create = () => createStaleDmPeer({ rpc: c.rpc, state: c.state, peerIndex: 1 });
  c.config.session.dmScope = "main";
  await assert.rejects(create(), /existing isolated scope/);
  c.config.session.dmScope = "per-channel-peer";
  const original = c.config.session.identityLinks["persona-peer"];
  delete c.config.session.identityLinks["persona-peer"];
  await assert.rejects(create(), /existing isolated scope/);
  c.config.session.identityLinks["persona-peer"] = original;
  c.config.session.identityLinks["another-peer"] = [staleDmPeers[0].peer];
  await assert.rejects(create(), /absent or ambiguous/);
  assert.ok(c.requests.every(({ method }) => method === "config.get"));
  for (const peerIndex of [0, 4, 1.5, NaN]) await assert.rejects(createStaleDmPeer({ rpc: c.rpc, state: c.state, peerIndex }), (error) => error.exitCode === 2);
});

test("duplicate construction and changed stored peer identities are rejected", async (t) => {
  const c = await fixture(t);
  await c.build();
  c.requests.length = 0;
  await assert.rejects(createStaleDmPeer({ rpc: c.rpc, state: c.state, peerIndex: 1 }), /already exists/);
  assert.ok(!c.requests.some(({ method }) => method === "kova.channelProbe.inject"));
  c.edit(staleDmPeers[0], (entry) => { entry.delivery.origin.to = staleDmPeers[1].peer; });
  await assert.rejects(checkStaleDmPeers({ rpc: c.rpc, state: c.state }), /external direct-message row/);
});
