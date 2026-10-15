import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { setImmediate as nextTick } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createCollectionSessions, patchStaleCollection, writeCollectionHistory, checkSessionCollection, collectionPolicy,
  collectionRequiredConfig, collectionRequests, collectionRequestCases, openCollectionFixture, readCollectionRows,
} from "../support/persona/session-collections.mjs";

const DAY = 86400000;
const agentId = "research";
const key = (name) => `agent:${agentId}:dashboard:kova-persona-${name}`;
const ordinaryKey = (name) => `agent:${agentId}:kova-persona-${name}`;
const config = () => ({ ...structuredClone(collectionRequiredConfig), agents: { entries: { main: {}, research: {}, idle: {} } } });
const saved = (label, fields = {}) => ({ sessionId: `saved-${label}`, updatedAt: Date.now(), label, ...fields });

async function context(t, rows = new Map()) {
  const state = await mkdtemp(join(tmpdir(), "kova-collections-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const value = config();
  const rpc = async ({ method, params }) => {
    if (method === "config.get") return { config: value, path: join(state, "openclaw.json") };
    if (method === "sessions.describe") return { session: { key: params.key, ...rows.get(params.key) } };
    assert.fail(`unexpected ${method}`);
  };
  return { rpc, state, agentId, rows, config: value, readRows: async () => rows };
}

function addNear(rows, count = 5100) {
  for (let index = 0; index < count; index++) rows.set(ordinaryKey(`many-${String(index).padStart(5, "0")}`), saved(`kova-persona-many-${index}`));
}

test("collection counts follow effective caps and every request builder has schema arguments", () => {
  assert.deepEqual(Object.keys(collectionRequests).sort(), Object.keys(collectionRequestCases).sort());
  assert.equal(collectionPolicy(config()).nearCount, 5100);
  const larger = config();
  larger.session.maintenance.maxEntries = 6000;
  assert.equal(collectionPolicy(larger).nearCount, 6120);
  larger.session.maintenance.mode = "enforce";
  assert.throws(() => collectionPolicy(larger), /mode=warn/);
  larger.session.maintenance.mode = "warn";
  larger.session.maintenance.archiveDashboardAfter = false;
  assert.throws(() => collectionPolicy(larger), /duration/);
});

test("near-cap checks require the whole active collection rather than a total that includes archives", async (t) => {
  const c = await context(t);
  addNear(c.rows);
  const options = { ...c, kind: "sessions-thousands-near-cap" };
  assert.deepEqual(await checkSessionCollection(options), { agentId });
  c.rows.get(ordinaryKey("many-00050")).archivedAt = Date.now();
  await assert.rejects(checkSessionCollection(options), /ordinary unarchived/);
  c.rows.delete(ordinaryKey("many-00050"));
  c.rows.set(key("unrelated"), saved("unrelated"));
  await assert.rejects(checkSessionCollection(options), /saved collection session is absent/);
});

test("stale over-cap checks require old activity, five pins, fifty archives and eligible ordinary rows", async (t) => {
  const c = await context(t);
  addNear(c.rows);
  const old = Date.now() - 45 * DAY;
  for (let index = 0; index < 400; index++) c.rows.set(ordinaryKey(`stale-${String(index).padStart(5, "0")}`), saved(`kova-persona-stale-${index}`, {
    updatedAt: old, lastInteractionAt: old, lastActivityAt: old, sessionStartedAt: old,
    ...(index < 5 ? { pinnedAt: old } : index < 55 ? { archivedAt: old, archiveReason: "manual" } : {}),
  }));
  const options = { ...c, kind: "store-stale-sessions-over-cap" };
  assert.deepEqual(await checkSessionCollection(options), { agentId });
  for (const [index, field, value, error] of [
    [0, "pinnedAt", undefined, /pinned session/],
    [5, "archiveReason", "age-retention", /manual archive/],
    [55, "lastActivityAt", Date.now(), /historical activity/],
    [55, "pinnedAt", old, /eligible active session/],
  ]) {
    const entry = c.rows.get(ordinaryKey(`stale-${String(index).padStart(5, "0")}`)), previous = entry[field];
    entry[field] = value;
    await assert.rejects(checkSessionCollection(options), error);
    entry[field] = previous;
  }
});

test("bulk historical construction stays outside the dashboard archive selector", async (t) => {
  const c = await context(t);
  addNear(c.rows);
  const created = [];
  const rpc = async (request) => {
    const { method, params } = request;
    if (method === "sessions.create") {
      created.push(params.key);
      c.rows.set(params.key, saved(params.label));
      return { key: params.key, sessionId: c.rows.get(params.key).sessionId };
    }
    if (method === "sessions.patch") {
      const entry = c.rows.get(params.key);
      assert.equal(params.expectedSessionId, entry.sessionId);
      if (params.pinned) entry.pinnedAt = Date.now();
      if (params.archived) Object.assign(entry, { archivedAt: Date.now(), archiveReason: "manual" });
      return { entry };
    }
    return c.rpc(request);
  };
  const options = { ...c, rpc, kind: "store-stale-sessions-over-cap" };
  const result = await createCollectionSessions(options);
  assert.equal(result.sessionIds.length, 400);
  assert.ok([...c.rows.values()].every((entry) => entry.pinnedAt === undefined && entry.archivedAt === undefined));
  await patchStaleCollection({ ...options, start: 0, count: 5, fields: { pinned: true } });
  assert.equal([...c.rows.values()].filter((entry) => entry.pinnedAt).length, 5);
  assert.ok([...c.rows.values()].every((entry) => entry.archivedAt === undefined));
  await patchStaleCollection({ ...options, start: 5, count: 50, fields: { archived: true } });
  await writeCollectionHistory({ ...options, writeFixture: async ({ key: selectedKey, fields }) => {
    Object.assign(c.rows.get(selectedKey), fields);
  } });
  assert.deepEqual(await checkSessionCollection(options), { agentId });
  assert.equal(created.length, 400);
  assert.ok(created.every((selected) => selected.startsWith(`agent:${agentId}:kova-persona-stale-`)));
  assert.ok([...c.rows.keys()].every((selected) => !selected.startsWith(`agent:${agentId}:dashboard:`)));
  const firstKey = ordinaryKey("stale-00000"), first = c.rows.get(firstKey);
  c.rows.delete(firstKey);
  c.rows.set(key("stale-00000"), first);
  await assert.rejects(checkSessionCollection({ ...c, kind: "store-stale-sessions-over-cap" }), /saved collection session is absent/);
});

test("dashboard construction ages every signal through the fixture writer and checks reject refreshed metadata", async (t) => {
  const c = await context(t);
  const expectedKey = key("stale-dashboard");
  const requests = [], replacements = [];
  const rpc = async (request) => {
    requests.push(request);
    if (request.method === "sessions.create") {
      assert.equal(request.params.key, expectedKey);
      c.rows.set(expectedKey, saved(request.params.label));
      return { key: expectedKey, sessionId: c.rows.get(expectedKey).sessionId };
    }
    return c.rpc(request);
  };
  const options = { ...c, rpc, kind: "sessions-stale-dashboard" };
  await createCollectionSessions(options);
  assert.equal(c.rows.get(expectedKey).lastActivityAt, undefined);
  await writeCollectionHistory({ ...options, writeFixture: async (replacement) => {
    replacements.push(replacement);
    assert.equal(replacement.sessionId, c.rows.get(expectedKey).sessionId);
    Object.assign(c.rows.get(expectedKey), replacement.fields);
  } });
  assert.deepEqual(await checkSessionCollection(options), { key: expectedKey });
  assert.equal(replacements.length, 1);
  assert.equal(new Set(Object.values(replacements[0].fields)).size, 1);
  assert.ok(requests.every((request) => !Object.hasOwn(request.params, "updatedAt")));
  const entry = c.rows.get(expectedKey), old = entry.updatedAt;
  for (const field of ["updatedAt", "lastActivityAt", "lastInteractionAt", "sessionStartedAt"]) {
    entry[field] = Date.now();
    await assert.rejects(checkSessionCollection(options), /not eligible/);
    entry[field] = old;
  }
  entry.archivedAt = Date.now();
  await assert.rejects(checkSessionCollection(options), /not eligible/);
});

test("installed SDK imports and deferred callbacks retain the selected environment and receive an explicit warning policy", async () => {
  const previousCwd = process.cwd();
  const selectors = ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"];
  const previous = Object.fromEntries(selectors.map((name) => [name, process.env[name]]));
  const temporary = await mkdtemp(join(tmpdir(), "kova-collection-sdk-"));
  try {
    const selectedRoot = join(temporary, "environment"), state = join(selectedRoot, ".openclaw");
    const runtime = join(temporary, "runtime"), binaryPath = join(runtime, "openclaw.mjs");
    const storePath = join(state, "agents", agentId, "agent", "openclaw-agent.sqlite");
    await mkdir(dirname(storePath), { recursive: true });
    await mkdir(runtime);
    await writeFile(storePath, "SDK boundary fixture");
    await writeFile(binaryPath, "");
    await writeFile(join(runtime, "session-sdk.mjs"), "");
    await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "openclaw", exports: { "./plugin-sdk/session-store-runtime": "./session-sdk.mjs" } }));
    for (const name of selectors) process.env[name] = join(temporary, "host-must-not-be-used");
    const expected = { OPENCLAW_HOME: await realpath(selectedRoot), OPENCLAW_STATE_DIR: await realpath(state), OPENCLAW_CONFIG_PATH: join(await realpath(state), "openclaw.json") };
    const observedScope = () => Object.fromEntries(selectors.map((name) => [name, process.env[name]]));
    const rows = new Map(), calls = [];
    let importScope, deferredScope;
    const writeFixture = await openCollectionFixture({ name: "selected", root: selectedRoot }, state, {
      resolveRuntime: async (args) => {
        assert.deepEqual(args, ["env", "resolve", "selected", "--json", "--", "status"]);
        return { binaryPath };
      },
      loadSdk: async () => {
        importScope = observedScope();
        return { patchSessionEntry: async (params) => {
          calls.push(params);
          const entry = rows.get(params.sessionKey);
          const next = await params.update(entry, { existingEntry: entry });
          rows.set(params.sessionKey, next);
          void nextTick().then(() => { deferredScope = observedScope(); });
          return next;
        } };
      },
    });
    assert.deepEqual(importScope, expected);
    const policy = config();
    policy.session.maintenance.maxEntries = 6000;
    policy.session.maintenance.pruneAfter = "31d";
    policy.session.maintenance.archiveDashboardAfter = "6d";
    const rpc = async ({ method, params }) => {
      if (method === "config.get") return { config: policy, path: expected.OPENCLAW_CONFIG_PATH };
      if (method === "sessions.create") {
        const entry = saved(params.label);
        rows.set(params.key, entry);
        return { key: params.key, sessionId: entry.sessionId };
      }
      if (method === "sessions.describe") return { session: { key: params.key, ...rows.get(params.key) } };
      assert.fail(method);
    };
    const options = { rpc, kind: "sessions-stale-dashboard", agentId, state, writeFixture, readRows: async () => rows };
    await createCollectionSessions(options);
    assert.equal(calls.length, 0);
    await writeCollectionHistory(options);
    assert.deepEqual(await checkSessionCollection(options), { key: key("stale-dashboard") });
    await nextTick();
    assert.deepEqual(deferredScope, expected);
    assert.deepEqual(observedScope(), expected);
    assert.equal(process.cwd(), expected.OPENCLAW_HOME);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.storePath, await realpath(storePath));
    for (const name of selectors) assert.equal(call.env[name], expected[name]);
    assert.deepEqual(call.maintenanceConfig, {
      mode: "warn", maxEntries: 6000, pruneAfterMs: 31 * DAY, archiveDashboardAfterMs: 6 * DAY,
      modelRunPruneAfterMs: DAY, preserveRecentMs: null, resetArchiveRetentionMs: null,
      maxDiskBytes: null, highWaterBytes: null,
    });
    assert.equal(call.replaceEntry, true);
    assert.equal(call.skipMaintenance, true);
  } finally {
    process.chdir(previousCwd);
    for (const name of selectors) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

test("global rows must have separate physical and Gateway identities in their explicit agent", async (t) => {
  const c = await context(t, new Map([
    ["global", saved("kova-persona-global")],
    [`agent:${agentId}:global`, saved("kova-persona-qualified-global")],
  ]));
  const options = { ...c, kind: "agents-multiple-with-global-key" };
  assert.deepEqual(await checkSessionCollection(options), { agentId });
  await assert.rejects(checkSessionCollection({ ...options, rpc: async (request) => request.method === "sessions.describe" ? { session: { key: "global", ...c.rows.get("global") } } : c.rpc(request) }), /ownership differs/);
  c.rows.get(`agent:${agentId}:global`).sessionId = c.rows.get("global").sessionId;
  await assert.rejects(checkSessionCollection(options), /not distinct/);
});

test("organized checks require all archive causes, exact child ancestry and the key-derived fork short id", async (t) => {
  const c = await context(t), now = Date.now();
  const add = (name, fields) => c.rows.set(key(`organized-${name}`), saved(`kova-persona-organized-${name}`, fields));
  add("pinned", { pinnedAt: now });
  add("snoozed", { snoozedAt: now, snoozedUntil: now + DAY });
  add("grouped", { category: "Verification notebook", color: "purple" });
  add("unread", { markedUnreadAt: now });
  for (const archiveReason of ["manual", "active-session-cap", "age-retention", "stale-dashboard", "restart-recovery"]) add(`archive-${archiveReason}`, { archivedAt: now, archiveReason });
  add("parent", {});
  const parentKey = key("organized-parent"), parent = c.rows.get(parentKey);
  add("child", { parentSessionKey: parentKey, parentSessionId: parent.sessionId });
  const forkKey = `agent:${agentId}:dashboard:12345678-abcd-4567-89ab-123456789abc`;
  const fork = saved("kova-persona-organized-fork", { sessionId: "unrelated-transcript-id", parentSessionKey: parentKey, forkSource: { sessionKey: parentKey, sessionId: parent.sessionId, entryId: "user-cut" } });
  c.rows.set(forkKey, fork);
  const rpc = async (request) => {
    if (request.method === "sessions.groups.list") return { groups: [{ name: "Verification notebook", position: 0 }] };
    if (request.method === "sessions.resolve") {
      assert.deepEqual(request.params, { agentId, shortId: "12345678" });
      return { key: forkKey };
    }
    return c.rpc(request);
  };
  const history = { sessionId: fork.sessionId, events: [{ event: { type: "message", message: { role: "user", content: [{ type: "text", text: "KOVA_ORGANIZED_PARENT" }] } } }] };
  const options = { ...c, rpc, kind: "sessions-organized-mixed", readSession: async () => history };
  const result = await checkSessionCollection(options);
  assert.equal(result.forkKey, forkKey);
  assert.equal(result.shortId, "12345678");
  delete c.rows.get(key("organized-archive-restart-recovery")).archiveReason;
  await assert.rejects(checkSessionCollection(options), /restart-recovery/);
  c.rows.get(key("organized-archive-restart-recovery")).archiveReason = "restart-recovery";
  c.rows.get(key("organized-child")).parentSessionId = "replaced-parent";
  await assert.rejects(checkSessionCollection(options), /child lineage/);
  c.rows.get(key("organized-child")).parentSessionId = parent.sessionId;
  history.events = [];
  await assert.rejects(checkSessionCollection(options), /copied notebook history/);
});

test("collection reads retain literal global rows and reject oversized metadata and database links without writes", async (t) => {
  const c = await context(t);
  const file = join(c.state, "agents", agentId, "agent", "openclaw-agent.sqlite");
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let closed = false;
  t.after(() => { if (!closed) db.close(); });
  db.exec("CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL, entry_json TEXT NOT NULL) STRICT");
  const insert = db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)");
  for (const selected of ["global", `agent:${agentId}:global`]) {
    const entry = saved(selected);
    insert.run(selected, entry.sessionId, JSON.stringify(entry));
  }
  const before = await readFile(file);
  assert.deepEqual([...await readCollectionRows(c.state, agentId)].map(([selected]) => selected), [`agent:${agentId}:global`, "global"]);
  assert.deepEqual(await readFile(file), before);
  insert.run(key("oversized"), "oversized", JSON.stringify({ sessionId: "oversized", label: "x".repeat(256 * 1024) }));
  await assert.rejects(readCollectionRows(c.state, agentId), /metadata byte limit/);
  db.close(); closed = true;
  await rm(file);
  await symlink(join(c.state, "elsewhere.sqlite"), file);
  await assert.rejects(readCollectionRows(c.state, agentId), /regular file inside/);
});


test("collection creation waits for the configured warning policy before mutating sessions", async (t) => {
  const c = await context(t);
  let reads = 0, created = 0;
  const rpc = async (request) => {
    if (request.method === "config.get") {
      reads++;
      const value = structuredClone(c.config);
      if (reads === 1) value.session.maintenance.mode = "enforce";
      return { config: value, path: join(c.state, "openclaw.json") };
    }
    if (request.method === "sessions.create") {
      assert.ok(reads >= 2, "must observe the warning policy before creating rows");
      created++;
      c.rows.set(request.params.key, saved(request.params.label));
      return { key: request.params.key, sessionId: c.rows.get(request.params.key).sessionId };
    }
    return c.rpc(request);
  };
  await createCollectionSessions({ ...c, rpc, kind: "sessions-stale-dashboard" });
  assert.equal(created, 1);
});
