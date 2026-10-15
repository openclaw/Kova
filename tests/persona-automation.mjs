import { loadCatalogue } from "../src/catalogue.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, lstat, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  automationContent, automationRequests, automationRequestCases, automationHookBody,
  automationHookConfiguration, configureAutomationHook,
  hasCompletedAutomationContent, runAutomationCron, runAutomationHeartbeat, runAutomationHook,
  createModelRunFixture, populateModelRunFixture, ageModelRunFixture, checkAutomationRows,
} from "../support/persona/make-automation-rows.mjs";

async function declaredCreates(operation, result, existing = []) {
  const { catalogue } = await loadCatalogue("openclaw");
  assert.deepEqual(catalogue.entries.find((entry) => entry.id === `persona-automation-${operation}`).creates.toSorted(), Object.keys(result).filter((key) => !existing.includes(key)).map((key) => `/${key}`).toSorted());
  return result;
}

const jobId = "persona-cron-id";
const runId = "accepted-cron-run";
const cronKey = `agent:main:cron:${jobId}`;
const cronRunKey = `${cronKey}:run:cron-session-id`;
const modelKey = "agent:main:explicit:model-run-12345678-1234-4234-8234-123456789abc";
const modelId = "historical-model-session";
const day = 86400000;
const terminal = { jobId, runId, action: "finished", status: "ok", deliveryStatus: "delivered", sessionKey: cronRunKey, sessionId: "cron-session-id" };
const messages = (marker) => [
  { seq: 0, event: { type: "message", message: { role: "user", content: marker ?? "Reply with KOVA_AGENT_OK." } } },
  { seq: 1, event: { type: "message", message: { role: "assistant", content: [{ type: "text", text: "KOVA_AGENT_OK" }], stopReason: "stop" } } },
];
const stored = (key, sessionId, marker, fields = {}) => ({ key, sessionId, entry: { sessionId, ...fields }, events: messages(marker) });
const noWait = { timeoutMs: 1, now: () => 1, pause: async () => assert.fail("unexpected poll") };

// The shared schema test imports these builders. Keep the cases total as operations evolve.
test("automation request builders expose all supported schema cases", () => {
  assert.deepEqual(Object.keys(automationRequests).sort(), Object.keys(automationRequestCases).sort());
  assert.deepEqual(automationRequests.cronRun(jobId), { method: "cron.run", params: { id: jobId, mode: "force" } });
  assert.equal(automationRequests.wake().params.sessionKey, automationContent.heartbeatBaseKey);
});

test("cron builder waits for the accepted run and verifies persisted completion", async () => {
  const calls = [];
  const rpc = async (request) => {
    calls.push(request);
    if (request.method === "cron.run") return { ok: true, enqueued: true, runId };
    assert.equal(request.method, "cron.runs");
    assert.equal(request.params.runId, runId);
    return { entries: [terminal] };
  };
  assert.deepEqual(await declaredCreates("cron", await runAutomationCron({ rpc, jobId, state: "/unused", readSession: async (_, key) => {
    assert.equal(key, cronKey);
    return stored(cronKey, terminal.sessionId);
  }, waitOptions: noWait })), { key: cronKey, sessionId: terminal.sessionId, runId });
  assert.deepEqual(calls.map(({ method }) => method), ["cron.run", "cron.runs"]);
  for (const patch of [{ status: "error" }, { deliveryStatus: "error" }, { sessionKey: "agent:main:cron:fake" }]) {
    await assert.rejects(runAutomationCron({ rpc: async (request) => request.method === "cron.run" ? { ok: true, enqueued: true, runId } : { entries: [{ ...terminal, ...patch }] }, jobId, waitOptions: noWait, readSession: async () => assert.fail("invalid run must not read content") }), /did not finish|no exact persisted/);
  }
});

test("an old successful cron receipt cannot satisfy the newly accepted run", async () => {
  let time = 0;
  await assert.rejects(runAutomationCron({
    jobId, rpc: async (request) => request.method === "cron.run" ? { ok: true, enqueued: true, runId } : { entries: [{ ...terminal, runId: "older-run" }] },
    waitOptions: { timeoutMs: 1, now: () => time++, pause: async () => {} },
    readSession: async () => assert.fail("old cron result must not read content"),
  }), (error) => error.exitCode === 3 && /accepted cron run/.test(error.message));
});

test("heartbeat builder requires runner-owned metadata and a new completed wake", async () => {
  const key = automationContent.heartbeatKey;
  const old = stored(key, "old-heartbeat", automationContent.heartbeatMarker, { heartbeatIsolatedBaseSessionKey: automationContent.heartbeatBaseKey });
  let reads = 0, mutations = 0, time = 0;
  const rpc = async ({ method }) => {
    if (method === "config.get") return { config: { agents: { defaults: { heartbeat: { every: "1m", isolatedSession: true } } } } };
    assert.equal(method, "wake"); mutations++;
    return { ok: true };
  };
  assert.deepEqual(await declaredCreates("heartbeat", await runAutomationHeartbeat({ rpc, readSession: async () => ++reads < 3 ? old : { ...old, sessionId: "new-heartbeat", entry: { ...old.entry, sessionId: "new-heartbeat" }, events: messages(undefined) }, waitOptions: { timeoutMs: 1000, now: () => time++, pause: async () => {} } })), { key, sessionId: "new-heartbeat" });
  assert.equal(mutations, 1);
  assert.equal(reads, 3);
  await assert.rejects(runAutomationHeartbeat({ rpc, readSession: async () => old, waitOptions: { timeoutMs: 1, now: () => time++, pause: async () => {} } }), (error) => error.exitCode === 3);
  await assert.rejects(runAutomationHeartbeat({ rpc, readSession: async () => ({ ...old, entry: { sessionId: old.sessionId } }) }), /not owned by the isolated heartbeat runner/);
});

test("hook uses the existing credential only at the selected loopback Gateway and requires completed persisted content", async () => {
  const hooks = { enabled: true, token: "private-persona-hook", allowRequestSessionKey: true, allowedSessionKeyPrefixes: ["hook:kova-persona-"] };
  let reads = 0;
  const options = {
    env: { gatewayPort: 19431 }, state: "/unused", readConfig: async () => hooks,
    readSession: async () => {
      if (++reads === 1) throw new Error("stored session is absent");
      return stored(automationContent.hookKey, "new-hook-session", automationContent.hookMarker, { hookExternalContentSource: "webhook" });
    },
    send: async (url, request) => {
      assert.equal(url, "http://127.0.0.1:19431/hooks/agent");
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.Authorization, "Bearer private-persona-hook");
      assert.deepEqual(JSON.parse(request.body), automationHookBody());
      return new Response(JSON.stringify({ ok: true, runId: "hook-run", completion: { status: "ok" } }));
    },
  };
  assert.deepEqual(await declaredCreates("hook", await runAutomationHook(options)), { key: automationContent.hookKey, sessionId: "new-hook-session", runId: "hook-run" });
  await assert.rejects(runAutomationHook(options), /no newly completed/);
  await assert.rejects(runAutomationHook({ ...options, readConfig: async () => ({ ...hooks, token: undefined }), send: async () => assert.fail("missing credential must not send") }), /configured persona hook credential/);
  for (const name of ["Error", "TimeoutError"]) {
    await assert.rejects(runAutomationHook({ ...options, send: async () => { const error = new Error(hooks.token); error.name = name; throw error; } }), (error) => !error.message.includes(hooks.token) && error.exitCode === (name === "TimeoutError" ? 3 : 1));
  }
  await assert.rejects(runAutomationHook({ ...options, send: async () => new Response(JSON.stringify({ ok: true, runId: "hook-run", completion: { status: "error" } })) }), /did not report completed/);
});

const fixtureOnlyToken = "fixture-only-not-an-actual-credential-value";
async function hookConfigFixture(t, custom = false) {
  const root = await mkdtemp(join(tmpdir(), "kova-hook-config-"));
  const state = join(root, ".openclaw");
  const configPath = join(state, ...(custom ? ["settings", "persona.json"] : ["openclaw.json"]));
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const config = { gateway: { bind: "loopback", auth: { mode: "token", token: "synthetic-gateway-fixture" } }, agents: { defaults: { model: "openai/gpt-5.5" } }, hooks: { internal: { enabled: true } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { name: `kova-persona-test-mv8wbrue-${"a".repeat(32)}`, root, stateDir: state, configPath, protected: false, serviceEnabled: false, serviceRunning: false, gatewayPort: 19431 };
  return { root, state, env, config, configPath };
}

test("hook token generation stays in memory until guarded environment configuration", () => {
  const base = { gateway: { bind: "loopback" }, agents: { defaults: { heartbeat: { every: "1m" } } } };
  const generated = automationHookConfiguration(base);
  assert.ok(/^[a-f0-9]{64}$/.test(generated.hooks.token));
  assert.ok(automationHookConfiguration(generated, () => assert.fail("must not rotate an existing token")) === generated);
  assert.deepEqual(generated.gateway, base.gateway);
  assert.deepEqual(generated.agents, base.agents);
  assert.deepEqual(generated.hooks.allowedSessionKeyPrefixes, ["hook:kova-persona-"]);
  assert.equal(generated.hooks.defaultSessionKey, automationHookBody().sessionKey);
  assert.deepEqual(generated.hooks.allowedAgentIds, ["main"]);
  assert.equal(generated.hooks.path, "/hooks");
  for (const hooks of [{ token: fixtureOnlyToken }, { mappings: [] }, { enabled: true }, { ...generated.hooks, allowedSessionKeyPrefixes: ["hook:"] }, { ...generated.hooks, defaultSessionKey: undefined }, { ...generated.hooks, defaultSessionKey: "hook:kova-persona-other" }]) {
    assert.throws(() => automationHookConfiguration({ ...base, hooks }), /bounded persona policy/);
  }
  assert.throws(() => automationHookConfiguration({ ...base, gateway: { bind: "lan" } }), /loopback/);
  assert.throws(() => automationHookConfiguration({ ...base, agents: { $include: "outside.json" } }), /included configuration/);
});

test("configure-hook atomically preserves settings and reuses a valid token without outputting it", async (t) => {
  const f = await hookConfigFixture(t, true);
  let checks = 0;
  const options = { ...f, assertStopped: async (port) => { assert.equal(port, f.env.gatewayPort); checks++; }, newToken: () => fixtureOnlyToken };
  assert.deepEqual(await declaredCreates("configure-hook", await configureAutomationHook(options)), {});
  assert.equal(checks, 2);
  const after = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(after.gateway, f.config.gateway);
  assert.deepEqual(after.agents, f.config.agents);
  assert.deepEqual(after.hooks.internal, f.config.hooks.internal);
  assert.ok(after.hooks.token === fixtureOnlyToken);
  assert.equal(after.hooks.defaultSessionKey, automationHookBody().sessionKey);
  assert.equal((await lstat(f.configPath)).mode & 0o777, 0o600);
  const identity = await lstat(f.configPath);
  assert.deepEqual(await configureAutomationHook({ ...options, newToken: () => assert.fail("must not rotate") }), {});
  assert.equal((await lstat(f.configPath)).ino, identity.ino);
  assert.deepEqual(await readdir(dirname(f.configPath)), ["persona.json"]);
});

test("configure-hook refuses protected or running state before credential generation", async (t) => {
  const f = await hookConfigFixture(t);
  const before = await readFile(f.configPath);
  for (const patch of [{ protected: true }, { protected: undefined }, { serviceEnabled: true }, { serviceRunning: true }, { name: "main-live" }, { gatewayPort: 0 }]) {
    await assert.rejects(configureAutomationHook({ ...f, env: { ...f.env, ...patch }, assertStopped: async () => assert.fail("metadata guard must run first"), newToken: () => assert.fail("must not generate") }), /could not configure/);
  }
  await assert.rejects(configureAutomationHook({ ...f, assertStopped: async () => { throw new Error(fixtureOnlyToken); }, newToken: () => assert.fail("must not generate") }), (error) => error.exitCode === 1 && !error.message.includes(fixtureOnlyToken));
  await assert.rejects(configureAutomationHook({ ...f, assertStopped: async () => { const error = new Error(fixtureOnlyToken); error.exitCode = 3; throw error; } }), (error) => error.exitCode === 3 && !error.message.includes(fixtureOnlyToken));
  assert.deepEqual(await readFile(f.configPath), before);
});

test("hook config paths reject symlinks, hardlinks and custom paths outside the state directory", async (t) => {
  const f = await hookConfigFixture(t);
  const before = await readFile(f.configPath);
  const outside = join(f.root, "outside.json");
  await writeFile(outside, before);
  const options = { ...f, assertStopped: async () => {}, newToken: () => assert.fail("unsafe path must not generate") };
  await assert.rejects(configureAutomationHook({ ...options, env: { ...f.env, configPath: outside } }), /could not configure/);
  await rm(f.configPath);
  await symlink(outside, f.configPath);
  await assert.rejects(configureAutomationHook(options), /could not configure/);
  await rm(f.configPath);
  await link(outside, f.configPath);
  await assert.rejects(configureAutomationHook(options), /could not configure/);
  await rm(f.configPath);
  await symlink(f.root, join(f.state, "linked"));
  await assert.rejects(configureAutomationHook({ ...options, env: { ...f.env, configPath: join(f.state, "linked", "outside.json") } }), /could not configure/);
  assert.deepEqual(await readFile(outside), before);
});

test("hook config replacement rechecks stopped state and concurrent file changes without leaking error values", async (t) => {
  const f = await hookConfigFixture(t);
  let checks = 0;
  const changed = { ...f.config, concurrentSetting: true };
  await assert.rejects(configureAutomationHook({ ...f, newToken: () => fixtureOnlyToken, assertStopped: async () => {
    if (++checks === 2) await writeFile(f.configPath, JSON.stringify(changed));
  } }), /could not configure/);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, "utf8")), changed);
  assert.deepEqual(await readdir(f.state), ["openclaw.json"]);
  await assert.rejects(configureAutomationHook({ ...f, newToken: () => { throw new Error(fixtureOnlyToken); }, assertStopped: async () => {} }), (error) => !error.message.includes(fixtureOnlyToken));
});

test("historical model-run fixture uses a strict identity, completed content and SDK metadata aging", async () => {
  const rows = new Map([[modelKey, { sessionId: modelId, label: automationContent.modelLabel }]]);
  const readRows = async () => rows;
  assert.deepEqual(await declaredCreates("create-model-run-fixture", await createModelRunFixture({ uuid: () => modelKey.split("model-run-")[1], rpc: async (request) => {
    assert.deepEqual(request, automationRequests.createModelFixture(modelKey));
    return { key: modelKey, sessionId: modelId };
  } })), { key: modelKey, sessionId: modelId });
  const calls = [];
  assert.deepEqual(await declaredCreates("populate-model-run-fixture", await populateModelRunFixture({ readRows, rpc: async (request) => {
    calls.push(request);
    if (request.method === "sessions.send") return { runId: "fixture-population-run" };
    assert.equal(request.method, "agent.wait");
    return { runId: request.params.runId, status: "ok" };
  } }), ["key", "sessionId"]), { key: modelKey, sessionId: modelId, runId: "fixture-population-run" });
  assert.ok(calls[0].params.message.includes(automationContent.modelMarker));
  const now = 2000000000000;
  let mutation;
  await ageModelRunFixture({ now, readRows, rpc: async () => ({ config: { session: { maintenance: { mode: "warn" } } } }), readSession: async () => stored(modelKey, modelId, automationContent.modelMarker), writeFixture: async (request) => { mutation = request; } });
  assert.equal(mutation.key, modelKey);
  assert.equal(mutation.sessionId, modelId);
  assert.equal(mutation.fields.updatedAt, now - 60 * day);
  assert.equal(mutation.maintenanceConfig.mode, "warn");
  await assert.rejects(ageModelRunFixture({ readRows, rpc: async () => ({ config: {} }), writeFixture: async () => assert.fail("must not mutate without warning policy") }), /warning maintenance/);
});

test("completed content excludes errors, absent terminals and replies before the requested input", () => {
  const value = stored(modelKey, modelId, automationContent.modelMarker);
  assert.equal(hasCompletedAutomationContent(value, automationContent.modelMarker), true);
  assert.equal(hasCompletedAutomationContent(value, automationContent.modelMarker, 1), false);
  assert.equal(hasCompletedAutomationContent({ ...value, events: [...value.events].reverse() }, automationContent.modelMarker), false);
  for (const stopReason of [undefined, "error", "aborted", "toolUse"]) {
    const events = structuredClone(value.events);
    events[1].event.message.stopReason = stopReason;
    assert.equal(hasCompletedAutomationContent({ ...value, events }, automationContent.modelMarker), false);
  }
});

test("automation check reads persisted rows without mutating them and rejects name-only fixtures", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "kova-automation-"));
  const path = join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); await rm(state, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT);
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, PRIMARY KEY (session_id, seq));`);
  const now = Date.now();
  const values = [
    stored(cronKey, terminal.sessionId),
    stored(automationContent.heartbeatKey, "heartbeat-session", undefined, { heartbeatIsolatedBaseSessionKey: automationContent.heartbeatBaseKey }),
    stored(automationContent.hookKey, "hook-session", automationContent.hookMarker, { hookExternalContentSource: "webhook" }),
    stored(modelKey, modelId, automationContent.modelMarker, { label: automationContent.modelLabel, updatedAt: now - 60 * day }),
  ];
  for (const value of values) {
    db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(value.key, value.sessionId, JSON.stringify(value.entry));
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(value.sessionId, value.key);
    for (const { seq, event } of value.events) db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(value.sessionId, seq, JSON.stringify(event));
  }
  const rpc = async (request) => {
    assert.deepEqual(request, automationRequests.cronRuns(jobId));
    return { entries: [terminal] };
  };
  const before = await readFile(path);
  assert.deepEqual(await checkAutomationRows({ rpc, state, jobId, now }), {});
  assert.deepEqual(await readFile(path), before);
  db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(JSON.stringify({ sessionId: "hook-session" }), automationContent.hookKey);
  await assert.rejects(checkAutomationRows({ rpc, state, jobId, now }), /completed hook content is absent/);
  db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(JSON.stringify(values[2].entry), automationContent.hookKey);
  db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(modelId);
  await assert.rejects(checkAutomationRows({ rpc, state, jobId, now }), /historical model-run fixture content or age differs/);
});
