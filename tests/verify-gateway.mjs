import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { link, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDirectGatewayRpcClient } from "../support/openclaw-runtime.mjs";
import { atomicJson, CallError, cleanupGatewayHandle, joinOperation, startOperation } from "../support/verify/background.mjs";
import { executeGatewayCall as executeRawGatewayCall, gatewayCallMain, parseGatewayCallArgs, resolveGatewayParams as resolveRawGatewayParams } from "../support/verify/gateway-call.mjs";
import { gatewayLifecycleMain, parseGatewayLifecycleArgs, runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const exec = promisify(execFile);
const backgroundUrl = new URL("../support/verify/background.mjs", import.meta.url).href;
const requestSchemas = await loadGatewaySchemaAssertions();

async function resolveGatewayParams(options, controls) {
  const params = await resolveRawGatewayParams(options, controls);
  return requestSchemas.check(options.method, params);
}

async function executeGatewayCall(options, dependencies = {}) {
  const requests = [];
  const result = await executeRawGatewayCall(options, {
    ...dependencies,
    connect: async (...args) => {
      const connection = await (dependencies.connect ?? openDirectGatewayRpcClient)(...args);
      const request = connection.client.request.bind(connection.client);
      connection.client.request = (method, params, ...rest) => {
        requests.push({ method, params: structuredClone(params) });
        return request(method, params, ...rest);
      };
      return connection;
    }
  });
  // Check outside the caller's error handling so a schema failure cannot look
  // like an expected product refusal or timeout.
  for (const { method, params } of requests) requestSchemas.check(method, params);
  return result;
}

for (const malformed of [true, false]) test(`an uncooperative ${malformed ? "malformed-frame" : "silent"} peer cannot retain the helper process`, async (t) => {
  requestSchemas.check("health", {});
  const root = await directory(t), configPath = join(root, "config.json");
  await atomicJson(configPath, { gateway: { auth: { token: "fixture-connect-failure" } } });
  const sockets = new Set(), server = createServer();
  let upgrades = 0;
  server.on("upgrade", (request, socket) => {
    upgrades++; sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {});
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (malformed) socket.write(Buffer.from([0x81, 1, 0x7b]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const source = `import { executeGatewayCall } from ${JSON.stringify(new URL("../support/verify/gateway-call.mjs", import.meta.url).href)};
    const result = await executeGatewayCall({ env: "fixture", method: "health", params: {}, timeoutMs: 1000 }, { prepare: () => (${JSON.stringify({ root, configPath, gatewayPort: server.address().port })}) });
    console.log(JSON.stringify(result)); process.exitCode = result.exitCode;`;
  const env = { ...process.env };
  delete env.KOVA_OCM_TRANSPORT_JSON; delete env.KOVA_NETWORK_FRONTAGE_ENABLED;
  const result = await exec(process.execPath, ["--input-type=module", "-e", source], { env, timeout: 3000 }).catch((error) => error);
  assert.equal(result.code, malformed ? 1 : 3);
  assert.notEqual(result.killed, true);
  assert.equal(upgrades, 1);
  assert.equal(JSON.parse(result.stdout).exitCode, malformed ? 1 : 3);
});

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "kova-gateway-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("Gateway flags reject malformed calls and accept method-specific joins", async () => {
  for (const args of [[], ["--env", "x", "--method", "health", "--params", "[]"], ["--env", "x", "--method", "health", "--background"], ["--wait", "x", "--params", "{}"], ["--env", "x", "--method", "health", "--from", "x"]]) {
    assert.throws(() => parseGatewayCallArgs(args), CallError);
  }
  const options = parseGatewayCallArgs(["--env=x", "--method=health", "--timeout=50", "--wait=x"]);
  assert.equal(options.method, "health");
  assert.equal(options.timeoutMs, 50);
  const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url), "utf8"));
  const fromMethods = catalogue.entries.filter((entry) => entry.kind === "gateway" && entry.flags["--from"]).map((entry) => entry.wraps);
  assert.deepEqual(fromMethods.sort(), ["sessions.patchMany", "sessions.processes.stop", "sessions.search", "sessions.setInvolvement"]);
  for (const method of fromMethods) assert.equal(parseGatewayCallArgs(["--env=x", `--method=${method}`, "--from=x"]).method, method);
  assert.equal((await gatewayCallMain(["--unknown"])).exitCode, 2);
  assert.equal(parseGatewayLifecycleArgs(["start", "--env=x", "--handle=x", "--background"]).action, "start");
  assert.equal(parseGatewayLifecycleArgs(["start", "--wait=x"]).action, "start");
  for (const flag of ["--env=x", "--handle=x", "--background"]) assert.throws(() => parseGatewayLifecycleArgs(["start", "--wait=x", flag]), CallError);
  assert.throws(() => parseGatewayLifecycleArgs(["stop", "--wait=x", "--env=x"]), CallError);
});

test("foreground Gateway start joins without requesting stop", async (t) => {
  const root = await directory(t);
  const handle = join(root, "gateway.json");
  const operation = { schema: "kova.gateway.operation.v1", id: "operation", entry: "foreground-gateway-start", method: "gateway.start", handlePath: handle, directory: `${handle}.d` };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  const pending = await gatewayLifecycleMain(["start", "--wait", handle, "--timeout", "20"]);
  assert.equal(pending.exitCode, 3);
  const controller = new AbortController();
  const joining = joinOperation(handle, { timeoutMs: 10000, signal: controller.signal });
  const interrupted = assert.rejects(joining, /abort|cancel join/i);
  await sleep(20);
  controller.abort(new Error("cancel join"));
  await interrupted;
  const cancelledLifecycle = await gatewayLifecycleMain(["start", "--wait", handle, "--timeout", "10000"], { signal: controller.signal });
  assert.equal(cancelledLifecycle.exitCode, 1);
  const cancelledRpc = await gatewayCallMain(["--method", "gateway.start", "--wait", handle, "--timeout", "10000"], { signal: controller.signal });
  assert.equal(cancelledRpc.exitCode, 1);
  await assert.rejects(readFile(join(operation.directory, "stop")), (error) => error.code === "ENOENT");
  const completed = { output: { method: "gateway.stop", result: { stopped: true }, error: null, elapsedMs: 10 }, exitCode: 0, cleanupComplete: true };
  await atomicJson(join(operation.directory, "result.json"), completed);
  assert.deepEqual(await gatewayLifecycleMain(["start", "--wait", handle]), completed);
  await assert.rejects(readFile(join(operation.directory, "stop")), (error) => error.code === "ENOENT");
});

test("output aliases cannot replace saved evidence or background records", async (t) => {
  const root = await directory(t);
  const handle = join(root, "call.json");
  const operation = { schema: "kova.gateway.operation.v1", id: "operation", entry: "gateway-health", method: "health", handlePath: handle, directory: `${handle}.d` };
  const completed = { output: { method: "health", result: { ok: false }, error: null, elapsedMs: 1 }, exitCode: 0, cleanupComplete: true };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  await atomicJson(join(operation.directory, "result.json"), completed);
  await atomicJson(handle, { entry: operation.entry, ref: { id: operation.id, directory: operation.directory } });
  const evidence = join(root, "earlier.json");
  await atomicJson(evidence, { retained: true });
  await link(evidence, join(root, "hard-alias.json"));
  await symlink(evidence, join(root, "file-alias.json"));
  await symlink(root, join(root, "directory-alias"), "dir");
  const original = new Map(await Promise.all([handle, evidence, join(operation.directory, "operation.json"), join(operation.directory, "result.json")].map(async (path) => [path, await readFile(path, "utf8")])));
  const joinArgs = ["--method", "health", "--wait", handle, "--timeout", "100"];
  for (const out of [handle, join(operation.directory, "operation.json"), join(operation.directory, "result.json"), join(operation.directory, "stop"), evidence, join(root, "hard-alias.json"), join(root, "file-alias.json"), join(root, "directory-alias", "call.json"), join(root, "directory-alias", "call.json.d", "stop")]) {
    const result = await gatewayCallMain([...joinArgs, "--out", out]);
    assert.equal(result.exitCode, 2, out);
  }
  const active = join(root, "active.json.d");
  await atomicJson(join(active, "operation.json"), { ...operation, directory: active, handlePath: join(root, "active.json") });
  assert.equal((await gatewayCallMain([...joinArgs, "--out", join(active, "result.json")])).exitCode, 2);
  const nestedHandle = await gatewayLifecycleMain(["start", "--env", "unused", "--handle", join(active, "result.json"), "--timeout", "100"]);
  assert.equal(nestedHandle.exitCode, 2);
  await assert.rejects(readFile(join(active, "result.json")), { code: "ENOENT" });
  for (const [path, bytes] of original) assert.equal(await readFile(path, "utf8"), bytes);
  await assert.rejects(readFile(join(operation.directory, "stop")), { code: "ENOENT" });
  const fresh = join(root, "fresh.json");
  const aliasedFresh = join(root, "directory-alias", "fresh.json");
  const conflictingStart = await gatewayCallMain(["--env", "unused", "--method", "health", "--background", "--handle", fresh, "--out", aliasedFresh]);
  assert.equal(conflictingStart.exitCode, 2);
  await assert.rejects(readFile(join(`${fresh}.d`, "operation.json")), { code: "ENOENT" });
  const output = join(root, "new-results", "joined.json");
  const concurrent = await Promise.all([gatewayCallMain([...joinArgs, "--out", output]), gatewayCallMain([...joinArgs, "--out", output])]);
  assert.deepEqual(concurrent.map((result) => result.exitCode).sort(), [0, 2]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), completed.output);
});

test("result files preserve selectors and reject stale or ambiguous identities", async (t) => {
  const root = await directory(t);
  const session = join(root, "session.json");
  const described = join(root, "described.json");
  const processes = join(root, "processes.json");
  const merge = join(root, "merge.json");
  await atomicJson(session, { method: "sessions.create", result: { key: "session-a" }, error: null });
  await atomicJson(described, { method: "sessions.describe", result: { session: { key: "session-a", sessionId: "id-a" } }, error: null });
  await atomicJson(merge, { limit: 3, maxBytes: 4096 });
  assert.deepEqual(await resolveGatewayParams({ method: "sessions.branches.list", params: {}, "session-from": session }), { sessionKey: "session-a" });
  for (const method of ["session.members.add", "session.members.remove"]) {
    assert.deepEqual(await resolveGatewayParams({ method, params: { identityId: "member-a" }, "session-from": session }), { sessionKey: "session-a", identityId: "member-a" });
  }
  await assert.rejects(resolveGatewayParams({ method: "session.member.add", params: {}, "session-from": session }), /no single-session selector/);
  assert.deepEqual(await resolveGatewayParams({ method: "chat.history", params: { limit: 4 }, "session-from": session, "merge-from": merge }), { sessionKey: "session-a", limit: 4, maxBytes: 4096 });
  assert.deepEqual(await resolveGatewayParams({ method: "sessions.setInvolvement", params: { key: "session-a", hidden: true }, from: described }), { key: "session-a", hidden: true, expectedSessionId: "id-a" });
  await assert.rejects(resolveGatewayParams({ method: "sessions.setInvolvement", params: { key: "session-b", hidden: true }, from: described }), /does not describe/);
  await assert.rejects(resolveGatewayParams({ method: "sessions.list", params: {}, "session-from": session }), /no single-session selector/);
  const row = { processId: "p-a", instanceId: "instance-a", name: "fixture", status: "running", startedAt: 1, tail: "", truncated: true, canStop: true };
  const otherRows = [{ ...row, processId: "finished", status: "completed" }, { ...row, processId: "unavailable", canStop: false }];
  const record = { method: "sessions.processes.list", result: { sessionId: "id-a", processes: [...otherRows, row], truncated: false }, error: null };
  await atomicJson(processes, record);
  const options = { method: "sessions.processes.stop", params: { key: "session-a", sessionId: "id-a" }, from: processes };
  assert.deepEqual(await resolveGatewayParams(options), { ...options.params, processId: "p-a", instanceId: "instance-a" });
  assert.deepEqual(options.params, { key: "session-a", sessionId: "id-a" });
  await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, sessionId: "id-b" } }), /does not identify/);
  for (const identity of [{ processId: row.processId }, { instanceId: row.instanceId }, { processId: null }, { instanceId: "" }]) {
    await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, ...identity } }), /prefilled/);
  }
  for (const patch of [{ truncated: true }, { truncated: undefined }, { processes: [row, row] }, { processes: otherRows }, { processes: [{ ...row, instanceId: "" }] }, { processes: [{ ...row, processId: "" }] }]) {
    await atomicJson(processes, { ...record, result: { ...record.result, ...patch } });
    await assert.rejects(resolveGatewayParams(options), /non-truncated|exactly one process/);
  }
  for (const patch of [{ method: "sessions.describe" }, { error: "list failed" }, { error: undefined }]) {
    await atomicJson(processes, { ...record, ...patch });
    await assert.rejects(resolveGatewayParams(options), /does not identify|contains an error|error-free/);
  }
});

test("batch patch binds only the uniquely described target without changing caller params", async (t) => {
  const root = await directory(t), from = join(root, "described.json");
  const session = { key: "agent:main:first", sessionId: "id-first", agentId: "main", lifecycleRevision: "revision-first", label: "example" };
  const record = { method: "sessions.describe", result: { session }, error: null };
  await atomicJson(from, record);
  const targets = [{ key: "agent:main:second", expectedSessionId: "id-second" }, { key: session.key, agentId: "main" }];
  const options = { method: "sessions.patchMany", params: { targets, patch: { archived: true } }, from };
  const expected = { targets: [targets[0], { ...targets[1], expectedSessionId: session.sessionId }], patch: { archived: true } };
  assert.deepEqual(await resolveGatewayParams(options), expected);
  assert.equal(targets[1].expectedSessionId, undefined);
  assert.deepEqual(await resolveGatewayParams({ ...options, params: expected }), expected);
  let received;
  const result = await executeGatewayCall({ ...options, env: "fixture", timeoutMs: 1000 }, {
    prepare: () => ({}), connect: async () => ({ client: { close() {}, async request(method, params) { received = { method, params }; return { outcomes: [] }; } } })
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(received, { method: options.method, params: expected });
  for (const rows of [[], [targets[0]], [targets[1], targets[1]], [{ ...targets[1], expectedSessionId: "stale" }], [{ ...targets[1], agentId: "other" }]]) {
    await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, targets: rows } }), /matching target|conflicts/);
  }
  for (const patch of [{ method: "sessions.create" }, { result: { session: null } }, { result: { session: { key: session.key } } }, { error: "describe failed" }, { error: undefined }]) {
    await atomicJson(from, { ...record, ...patch });
    await assert.rejects(resolveGatewayParams(options), /described session|contains an error|error-free/);
  }
});

test("search reads exactly one created or imported session and refuses broader selectors", async (t) => {
  const root = await directory(t), from = join(root, "session.json");
  const key = "agent:main:example";
  const records = [
    { method: "sessions.create", result: { ok: true, key, sessionId: "id-example", runStarted: false }, error: null },
    { method: "sessions.catalog.import", result: { sessionKey: key, importedItems: 0, totalItems: 1, complete: true, created: false }, error: null }
  ];
  const options = { method: "sessions.search", params: { query: "example", limit: 5 }, from };
  const expected = { ...options.params, sessionKeys: [key] };
  for (const record of records) {
    await atomicJson(from, record);
    assert.deepEqual(await resolveGatewayParams(options), expected);
    assert.deepEqual(await resolveGatewayParams({ ...options, params: expected }), expected);
    for (const selector of [{ scope: {} }, { scope: null }, { sessionKeys: [] }, { sessionKeys: ["other"] }, { sessionKeys: [key, key] }, { sessionKeys: key }, { key }, { sessionKey: key }]) {
      await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, ...selector } }), /scope|conflicts/);
    }
  }
  for (const patch of [{ method: "sessions.describe" }, { result: {} }, { result: { key, sessionKey: "other" } }, { error: "creation failed" }, { error: undefined }]) {
    await atomicJson(from, { ...records[0], ...patch });
    await assert.rejects(resolveGatewayParams(options), /requires|contains an error/);
  }
});

test("creation output lists only identities supported by the request and result", async (t) => {
  const root = await directory(t), source = join(root, "adopted.json");
  await atomicJson(source, { key: "agent:main:adopted" });
  const created = { ok: true, key: "agent:main:generated", sessionId: "id-generated", runStarted: false };
  const imported = { sessionKey: "agent:main:imported", importedItems: 1, totalItems: 1, complete: true, created: true };
  const locator = { catalogId: "claude", hostId: "fixture-host", threadId: "fixture-thread" };
  const cases = [
    { method: "sessions.create", params: {}, result: created, ids: [created.key, created.sessionId] },
    { method: "sessions.create", params: {}, result: { ...created, sessionId: undefined }, ids: [created.key] },
    { method: "sessions.create", params: {}, result: { ...created, runStarted: true, runId: "run-new" }, ids: [created.key, created.sessionId, "run-new"] },
    { method: "sessions.create", params: {}, result: { ...created, runId: "run-reused" }, ids: [created.key, created.sessionId] },
    { method: "sessions.create", params: { key: created.key }, result: created, ids: [] },
    { method: "sessions.create", params: { key: created.key }, result: { ...created, runStarted: true, runId: "run-new" }, ids: ["run-new"] },
    { method: "sessions.create", params: {}, "merge-from": source, result: { ...created, key: "agent:main:adopted" }, ids: [] },
    { method: "sessions.catalog.import", params: locator, result: imported, ids: [imported.sessionKey] },
    { method: "sessions.catalog.import", params: locator, result: { ...imported, importedItems: 0, created: false }, ids: [] }
  ];
  for (const entry of cases) {
    const result = await executeGatewayCall({ ...entry, env: "fixture", timeoutMs: 1000 }, {
      prepare: () => ({}), connect: async () => ({ client: { close() {}, async request() { return entry.result; } } })
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output.result, entry.result);
    assert.deepEqual(result.output.createdIds, entry.ids);
  }
  for (const method of ["sessions.create", "sessions.catalog.import"]) {
    const failed = await executeGatewayCall({ method, params: method === "sessions.catalog.import" ? locator : {}, env: "fixture", timeoutMs: 1000 }, {
      prepare: () => ({}), connect: async () => ({ client: { close() {}, async request() { throw new Error("product refused"); } } })
    });
    assert.equal(failed.exitCode, 1);
    assert.deepEqual(failed.output.createdIds, []);
  }
});

test("every catalogue Gateway method has the selector defined by its pinned request contract", async (t) => {
  const root = await directory(t);
  const session = join(root, "session.json");
  await atomicJson(session, { method: "sessions.create", result: { key: "agent:main:selector" }, error: null });
  // Request selectors from gateway-protocol schemas at OpenClaw 7e80556f;
  // sessions.get also accepts key in its sessions-read-by-key handler.
  const groups = new Map([
    ["key", [
      "sessions.abort", "sessions.assignOwner", "sessions.compact", "sessions.create", "sessions.delete", "sessions.describe",
      "sessions.files.reveal", "sessions.get", "sessions.messages.subscribe", "sessions.messages.unsubscribe", "sessions.patch",
      "sessions.processes.list", "sessions.processes.stop", "sessions.recover", "sessions.reset", "sessions.resolve", "sessions.setInvolvement"
    ]],
    ["sessionKey", [
      "chat.abort", "chat.history", "chat.inject", "chat.message.get", "chat.metadata", "chat.startup",
      "progressCard.get", "progressCard.put", "progressCard.refresh",
      "session.members.add", "session.members.list", "session.members.listEvidence", "session.members.remove", "session.publicShare.set",
      "session.suggestions.add", "session.suggestions.list", "session.suggestions.resolve", "session.visibility.set",
      "sessions.branches.list", "sessions.branches.switch", "sessions.companion.ask", "sessions.companion.reset", "sessions.companion.state",
      "sessions.diff", "sessions.files.assets", "sessions.files.get", "sessions.files.list", "sessions.files.set", "sessions.fork",
      "sessions.github.options", "sessions.github.status", "sessions.rewind"
    ]],
    [null, [
      "sessions.activitySummary.ensure", "sessions.catalog.import", "sessions.cleanup", "sessions.groups.delete", "sessions.groups.list",
      "sessions.groups.put", "sessions.groups.rename", "sessions.groups.update", "sessions.list", "sessions.patchMany", "sessions.preview",
      "sessions.search", "sessions.storage.run", "sessions.storage.status", "sessions.subscribe", "sessions.title.prepare"
    ]]
  ]);
  const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url), "utf8"));
  const methods = catalogue.entries.filter((entry) => entry.kind === "gateway").map((entry) => entry.wraps);
  assert.deepEqual([...groups.values()].flat().sort(), methods.sort(), "new catalogue methods require a selector review");
  const fields = {
    "sessions.assignOwner": { owner: { type: "human", id: "fixture-owner" } },
    "sessions.delete": { expectedSessionId: "fixture-session" },
    "sessions.patch": { label: "Updated fixture" },
    "sessions.processes.stop": { sessionId: "fixture-session", processId: "fixture-process", instanceId: "fixture-instance" },
    "sessions.setInvolvement": { expectedSessionId: "fixture-session", hidden: true },
    "chat.inject": { message: "Recorded fixture" },
    "chat.message.get": { messageId: "fixture-message" },
    "progressCard.put": { markdown: "Fixture progress" },
    "progressCard.refresh": { idempotencyKey: "fixture-refresh" },
    "session.members.add": { identityId: "fixture-member" },
    "session.members.remove": { identityId: "fixture-member" },
    "session.publicShare.set": { expectedSessionId: "fixture-session", enabled: true },
    "session.suggestions.add": { text: "Fixture suggestion" },
    "session.suggestions.resolve": { id: "fixture-suggestion", resolution: "dismiss" },
    "session.visibility.set": { visibility: "suggest" },
    "sessions.branches.switch": { leafEntryId: "fixture-leaf" },
    "sessions.companion.ask": { question: "What changed?" },
    "sessions.files.assets": { path: "/fixture/page.html", refs: ["./style.css"] },
    "sessions.files.get": { path: "/fixture/notes.txt" },
    "sessions.files.set": { path: "/fixture/notes.txt", content: "Updated", expectedHash: "a".repeat(64) },
    "sessions.fork": { entryId: "fixture-entry" },
    "sessions.github.status": { requestId: "a1111111-1111-4111-8111-111111111111" },
    "sessions.rewind": { entryId: "fixture-entry" },
    "sessions.activitySummary.ensure": { sessions: [{ key: "agent:main:selector" }] },
    "sessions.catalog.import": { catalogId: "claude", hostId: "fixture-host", threadId: "fixture-thread" },
    "sessions.groups.delete": { name: "Fixture" },
    "sessions.groups.put": { names: ["Fixture"] },
    "sessions.groups.rename": { name: "Fixture", to: "Renamed fixture" },
    "sessions.groups.update": { name: "Fixture", cwd: null, worktree: false },
    "sessions.patchMany": { targets: [{ key: "agent:main:selector" }], patch: { label: "Updated fixture" } },
    "sessions.preview": { keys: ["agent:main:selector"] },
    "sessions.search": { query: "fixture" },
    "sessions.title.prepare": { agentId: "main", message: "Name this fixture" }
  };
  for (const [field, names] of groups) for (const method of names) {
    const params = fields[method] ?? {}, options = { method, params, "session-from": session };
    if (field) assert.deepEqual(await resolveGatewayParams(options), { ...params, [field]: "agent:main:selector" }, method);
    else {
      requestSchemas.check(method, params);
      await assert.rejects(resolveGatewayParams(options), /no single-session selector/, method);
    }
  }
  assert.deepEqual(await resolveGatewayParams({ method: "progressCard.refresh", params: { idempotencyKey: "refresh-one" }, "session-from": session }), { sessionKey: "agent:main:selector", idempotencyKey: "refresh-one" });
  assert.deepEqual(await resolveGatewayParams({ method: "chat.message.get", params: { messageId: "message-one" }, "session-from": session }), { sessionKey: "agent:main:selector", messageId: "message-one" });
});

test("describe responses become patch and reset identity preconditions without copying row fields", async (t) => {
  const root = await directory(t);
  const described = join(root, "described.json");
  const session = { key: "agent:main:example", sessionId: "session-one", lifecycleRevision: "revision-one", agentId: "main", kind: "direct", label: "saved label", archived: false };
  const response = { method: "sessions.describe", result: { session }, error: null, elapsedMs: 1 };
  await atomicJson(described, response);
  // These complete requests fit SessionsPatchParamsSchema and
  // SessionsResetParamsSchema at 7e80556f; reset has no lifecycle revision field.
  const cases = [
    {
      method: "sessions.patch", params: { key: session.key, archived: true },
      expected: { key: session.key, agentId: "main", archived: true, expectedSessionId: "session-one", expectedLifecycleRevision: "revision-one" }
    },
    {
      method: "sessions.reset", params: { key: session.key, reason: "new" },
      expected: { key: session.key, agentId: "main", reason: "new", expectedSessionId: "session-one" }
    }
  ];
  for (const entry of cases) {
    let received;
    const result = await executeGatewayCall({ ...entry, env: "fixture", "merge-from": described, timeoutMs: 1000 }, {
      prepare: () => ({}), connect: async () => ({ client: { close() {}, async request(method, params) { received = { method, params }; return { accepted: true }; } } })
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(received, { method: entry.method, params: entry.expected });
    assert.deepEqual(await resolveGatewayParams({ method: entry.method, params: entry.expected, "merge-from": described }), entry.expected);
  }
  const options = { method: "sessions.patch", params: { key: session.key, archived: true }, "merge-from": described };
  for (const conflicting of [{ key: "agent:main:other" }, { agentId: "other" }, { expectedSessionId: "other-session" }, { expectedLifecycleRevision: "other-revision" }]) {
    await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, ...conflicting } }), /--merge-from conflicts/);
  }
  const created = join(root, "created.json");
  await atomicJson(created, { method: "sessions.create", result: { key: session.key }, error: null });
  assert.deepEqual(await resolveGatewayParams({ ...options, params: { archived: true }, "session-from": created }), cases[0].expected);
  await atomicJson(created, { method: "sessions.create", result: { key: "agent:main:other" }, error: null });
  await assert.rejects(resolveGatewayParams({ ...options, params: { archived: true }, "session-from": created }), /--merge-from conflicts with key/);
  for (const invalid of [null, { key: session.key }, { sessionId: session.sessionId }]) {
    await atomicJson(described, { ...response, result: { session: invalid } });
    await assert.rejects(resolveGatewayParams(options), /--merge-from/);
  }
  await atomicJson(described, { ...response, error: "description failed" });
  await assert.rejects(resolveGatewayParams(options), /input file contains an error/);
  await atomicJson(described, { ...response, result: { session: { key: session.key, sessionId: session.sessionId } } });
  assert.deepEqual(await resolveGatewayParams(options), { ...options.params, expectedSessionId: session.sessionId });
  await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, agentId: "main" } }), /conflicts with agentId/);
  await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, expectedLifecycleRevision: "unobserved" } }), /conflicts with expectedLifecycleRevision/);
  await atomicJson(described, { key: session.key, archived: false, expectedSessionId: "raw-session" });
  assert.deepEqual(await resolveGatewayParams(options), { ...options.params, expectedSessionId: "raw-session" });
  await atomicJson(described, { method: "other.params", result: { label: "default label", archived: false }, error: null });
  assert.deepEqual(await resolveGatewayParams(options), { ...options.params, label: "default label" });
});

test("RPC records product results without deciding their correctness and closes clients", async () => {
  const options = parseGatewayCallArgs(["--env", "test", "--method", "health", "--timeout", "100"]);
  let closed = 0;
  let received;
  const dependencies = {
    prepare: () => ({}),
    connect: async () => ({ client: { close() { closed += 1; }, async request(method, params) { received = { method, params }; return { ok: false }; } } })
  };
  const result = await executeGatewayCall(options, dependencies);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.result, { ok: false });
  assert.deepEqual(received, { method: "health", params: {} });
  assert.equal(closed, 1);
  const rejected = await executeGatewayCall(options, { ...dependencies, connect: async () => ({ client: { close() {}, request: async () => { throw new Error("product refused"); } } }) });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.output.error, /product refused/);
  const productTimeout = await executeGatewayCall(options, { ...dependencies, connect: async () => ({ client: { close() {}, request: async () => { throw new Error("health TIMEOUT: product timed out"); } } }) });
  assert.equal(productTimeout.exitCode, 1);
  const timedOut = await executeGatewayCall({ ...options, timeoutMs: 20 }, { ...dependencies, connect: async () => ({ client: { close() {}, request: async () => sleep(60) } }) });
  assert.equal(timedOut.exitCode, 3);
  const delayed = await executeGatewayCall({ ...options, afterMs: 30, timeoutMs: 20 }, dependencies);
  assert.equal(delayed.exitCode, 0);
  assert.ok(delayed.output.elapsedMs >= 25);
});

test("public sharing credentials are omitted before response files and background joins", async (t) => {
  const root = await directory(t), token = "v1.synthetic-public-sharing-fixture";
  const share = { token, createdAt: 7 };
  for (const method of ["session.publicShare.set", "session.members.list", "session.members.listEvidence"]) {
    const original = method === "session.publicShare.set" ? { ok: true, sessionKey: "session-a", publicShare: share } : { sessionKey: "session-a", publicShare: share, members: [], identities: [], role: "owner", allowedVisibilities: ["private"] };
    const expected = { ...original, publicShare: { token: "", createdAt: 7 } };
    const options = { env: "fixture", method, params: { sessionKey: "session-a", ...(method === "session.publicShare.set" ? { expectedSessionId: "id-a", enabled: true } : {}) }, timeoutMs: 1000 };
    const result = await executeGatewayCall(options, { prepare: () => ({}), connect: async () => ({ client: { close() {}, request: async () => original } }) });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output.result, expected);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(original.publicShare.token, token);
    const handle = join(root, `${method}.json`), out = join(root, `${method}-joined.json`);
    const operation = { schema: "kova.gateway.operation.v1", id: method, entry: "sharing", method, handlePath: handle, directory: `${handle}.d` };
    await atomicJson(join(operation.directory, "operation.json"), operation);
    // Older background records can be joined without printing their credential again.
    await atomicJson(join(operation.directory, "result.json"), { ...result, output: { ...result.output, result: original }, cleanupComplete: true });
    const joined = await gatewayCallMain(["--method", method, "--wait", handle, "--out", out]);
    assert.equal(joined.exitCode, 0);
    assert.deepEqual(joined.output.result, expected);
    assert.equal((await readFile(out, "utf8")).includes(token), false);
    assert.equal(JSON.stringify(joined).includes(token), false);
    const disabled = await executeGatewayCall({ ...options, ...(method === "session.publicShare.set" ? { params: { ...options.params, enabled: false } } : {}) }, { prepare: () => ({}), connect: async () => ({ client: { close() {}, request: async () => ({ sessionKey: "session-a" }) } }) });
    assert.deepEqual(disabled.output.result, { sessionKey: "session-a" });
  }
  const userContent = { messages: [{ content: [{ type: "text", text: JSON.stringify({ publicShare: share }) }] }] };
  const ordinary = await executeGatewayCall({ env: "fixture", method: "chat.history", params: { sessionKey: "session-a" }, timeoutMs: 1000 }, { prepare: () => ({}), connect: async () => ({ client: { close() {}, request: async () => userContent } }) });
  assert.deepEqual(ordinary.output.result, userContent);
});

test("file observations share credential filtering with state capture and preserve product hashes", async (t) => {
  const root = await directory(t), marker = "synthetic-file-hook-value-0123456789";
  const config = { hooks: { token: marker, enabled: false }, note: "unchanged" };
  const policy = { ...config, hooks: { ...config.hooks, token: "" } };
  const fileDependencies = { prepare: () => ({ envName: "fixture", root: "/copied", stateDir: "/copied", runDir: "/runtime" }), readGatewayConfiguration: () => ({}) };
  const hash = "a".repeat(64), text = `// OpenClaw JSON5\n${JSON.stringify(config)}`;
  for (const [index, contentEncoding] of ["utf8", "base64"].entries()) {
    const file = { path: "alias", workspacePath: contentEncoding === "utf8" ? "openclaw.json" : "/copied/openclaw.json.bak", name: "alias", kind: "read", missing: false, content: contentEncoding === "base64" ? Buffer.from(text).toString("base64") : text, contentEncoding, hash, size: Buffer.byteLength(text) };
    const original = { sessionKey: "session-a", root: "/copied", file }, before = structuredClone({ sessionKey: "session-a", root: "/copied", file });
    const options = { env: "fixture", method: "sessions.files.get", params: { sessionKey: "session-a", path: "/copied/alias" }, timeoutMs: 1000 };
    const controls = { ...fileDependencies, connect: async () => ({ client: { close() {}, request: async () => original } }) };
    const result = await executeGatewayCall(options, controls);
    assert.equal(result.exitCode, 0);
    const observed = result.output.result.file;
    assert.deepEqual({ ...observed, content: file.content }, file);
    assert.deepEqual(JSON.parse(Buffer.from(observed.content, contentEncoding).toString()), policy);
    assert.deepEqual(original, before);
    const handle = join(root, `file-${index}.json`), out = join(root, `joined-${index}.json`);
    const operation = { schema: "kova.gateway.operation.v1", id: `file-${index}`, entry: "file-get", env: "fixture", method: options.method, handlePath: handle, directory: `${handle}.d` };
    await atomicJson(join(operation.directory, "operation.json"), operation);
    await atomicJson(join(operation.directory, "result.json"), { ...result, output: { ...result.output, result: original }, cleanupComplete: true });
    const joined = await gatewayCallMain(["--method", options.method, "--wait", handle, "--out", out], fileDependencies);
    assert.equal(joined.exitCode, 0);
    assert.deepEqual(JSON.parse(Buffer.from(joined.output.result.file.content, contentEncoding).toString()), policy);
    assert.equal((await readFile(out, "utf8")).includes(marker), false);
  }
  const method = "sessions.files.get", params = { sessionKey: "session-a", path: "/copied/openclaw.json" };
  const read = async (file) => executeGatewayCall({ env: "fixture", method, params, timeoutMs: 1000 }, { ...fileDependencies, connect: async () => ({ client: { close() {}, request: async () => ({ file }) } }) });
  for (const content of ['{"hooks":{"token":{"nested":"synthetic-file-hook-value-0123456789"}}}', "not JSON"]) {
    const result = await read({ path: params.path, content });
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.result, null);
    assert.match(result.output.error, /cannot capture malformed credential metadata/);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  const privateFile = await read({ path: "/copied/.kova-private-ABC123/patch.json", workspacePath: "/copied/.kova-private-ABC123/patch.json", content: JSON.stringify(config) });
  assert.equal(privateFile.exitCode, 1);assert.equal(JSON.stringify(privateFile).includes(marker), false);
  assert.match(privateFile.output.error, /private verification file contents/);
  const invalidUtf8 = await read({ path: params.path, content: Buffer.from([255, 0, 1]).toString("base64"), contentEncoding: "base64" });
  assert.equal(invalidUtf8.exitCode, 1);
  for (const contentEncoding of ["utf8", "base64"]) for (const path of ["/copied/guide.md", "/copied/workspace/examples/gateway/tls/gateway-key.pem", "/copied/workspace/docs/gateway/tls/gateway-key.pem"]) {
    const content = "The literal -----BEGIN PRIVATE KEY----- header appears in documentation, without a key.\n";
    const document = { path, content: contentEncoding === "base64" ? Buffer.from(content).toString("base64") : content, contentEncoding, hash };
    const result = await executeGatewayCall({ env: "fixture", method, params: { sessionKey: "session-a", path: document.path }, timeoutMs: 1000 }, { ...fileDependencies, connect: async () => ({ client: { close() {}, request: async () => ({ file: document }) } }) });
    assert.equal(result.exitCode, 0);assert.deepEqual(result.output.result.file, document);
  }
  const { generateKeyPairSync } = await import("node:crypto");
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  for (const keyPath of ["/copied/agents/main/tls-material.dat", "~/agents/main/tls-material.dat", "../copied/agents/main/tls-material.dat"]) {
    let paths;
    const configuredFile = { path: "file-alias", workspacePath: "/copied/agents/main/tls-material.dat", content: privateKey, hash };
    const dependencies = { ...fileDependencies,
      captureFilePolicy(policy) { paths = policy; },
      readGatewayConfiguration(runtime) { assert.equal(runtime.envName, "fixture"); return { tls: { keyPath } }; },
      connect: async () => ({ client: { close() {}, request: async () => ({ root: "/copied/workspace", file: configuredFile }) } })
    };
    const result = await executeGatewayCall({ env: "fixture", method, params: { sessionKey: "session-a", path: "/copied/file-alias" }, timeoutMs: 1000 }, dependencies);
    assert.equal(result.exitCode, 0);assert.ok(isDeepStrictEqual(result.output.result.file, { ...configuredFile, content: "" }), "configured key content is omitted and metadata preserved");
    assert.ok(configuredFile.content === privateKey, "source key content is unchanged");
    const handle = join(root, `configured-${Buffer.from(keyPath).toString("hex")}.json`);
    await atomicJson(join(`${handle}.d`, "operation.json"), { schema: "kova.gateway.operation.v1", id: "configured-file", entry: "file-get", env: "fixture", method, handlePath: handle, directory: `${handle}.d` });
    assert.equal(JSON.stringify(paths).includes(privateKey), false);
    const envelope = { ...result, fileCapture: { operationId: "configured-file", env: "fixture", paths }, cleanupComplete: true };
    await atomicJson(join(`${handle}.d`, "result.json"), envelope);
    const joined = await gatewayCallMain(["--method", method, "--wait", handle], { prepare: () => assert.fail("completed file joins must not need the deleted environment") });
    assert.equal(joined.exitCode, 0);assert.ok(isDeepStrictEqual(joined.output.result.file, { ...configuredFile, content: "" }), "joined key content is omitted and metadata preserved");
    await atomicJson(join(`${handle}.d`, "result.json"), { ...envelope, fileCapture: { ...envelope.fileCapture, operationId: "other-operation" } });
    const wrongOperation = await gatewayCallMain(["--method", method, "--wait", handle], dependencies);
    assert.equal(wrongOperation.exitCode, 1);assert.ok(wrongOperation.output.result === null, "mismatched operation has no result");
  }
  const plain = { path: "/copied/notes.txt", content: '{"hooks":{"token":"ordinary text"}}', hash };
  const ordinary = await executeGatewayCall({ env: "fixture", method, params: { sessionKey: "session-a", path: plain.path }, timeoutMs: 1000 }, { ...fileDependencies, connect: async () => ({ client: { close() {}, request: async () => ({ file: plain }) } }) });
  assert.deepEqual(ordinary.output.result.file, plain);
});

test("attachment RPC results preserve launch metadata without grant credentials", async () => {
  const token = "synthetic-attachment-rpc-token";
  const mcpConfig = { mcpServers: { openclaw: { type: "http", url: "http://127.0.0.1:1234/mcp", alwaysLoad: true, headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" } } } };
  const source = { sessionKey: "agent:main:main", token, expiresAtMs: 123, mcpConfig, env: { OPENCLAW_MCP_TOKEN: token } };
  const result = await executeGatewayCall({ env: "fixture", method: "attach.grant", params: { sessionKey: "agent:main:main", ttlMs: 60000 }, timeoutMs: 1000 }, { prepare: () => ({}), connect: async () => ({ client: { close() {}, request: async () => source } }) });
  assert.equal(result.exitCode, 0);assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(result.output.result, { ...source, token: "", env: { OPENCLAW_MCP_TOKEN: "" } });
  assert.deepEqual(result.output.result.mcpConfig, mcpConfig);assert.equal(source.token, token);
});

test("verification authenticates from its selected config while legacy credential precedence stays unchanged", async (t) => {
  const root = await directory(t);
  const selectedRoot = join(root, "selected"), configPath = join(selectedRoot, "custom-config.json");
  const parentConfig = join(root, "parent-config.json");
  const runtimeContext = { envName: "selected", root: selectedRoot, configPath, gatewayPort: 12345 };
  await atomicJson(join(selectedRoot, ".openclaw/openclaw.json"), { gateway: { auth: { token: "fixture-default-root" } } });
  await atomicJson(configPath, { gateway: { auth: { token: "fixture-selected-config" } } });
  await atomicJson(parentConfig, { gateway: { auth: { token: "fixture-parent-config" } } });
  const keys = ["OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "KOVA_OCM_TRANSPORT_JSON", "KOVA_NETWORK_FRONTAGE_ENABLED"];
  const previousEnv = new Map(keys.map((key) => [key, process.env[key]]));
  const previousSocket = globalThis.WebSocket;
  class Socket extends EventTarget {
    static OPEN = 1;
    static frames = [];
    constructor() {
      super();
      this.readyState = Socket.OPEN;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event", event: "connect.challenge" }) })));
    }
    send(raw) {
      const frame = JSON.parse(raw);
      requestSchemas.check(frame.method, frame.params);
      Socket.frames.push(frame);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }) })));
    }
    close() { this.readyState = 3; }
  }
  const tokenFor = async (options) => {
    const before = Socket.frames.length;
    const connection = await openDirectGatewayRpcClient(runtimeContext, options);
    try { return Socket.frames.slice(before).find((frame) => frame.method === "connect").params.auth.token; }
    finally { connection.client.close(); }
  };
  try {
    globalThis.WebSocket = Socket;
    delete process.env.KOVA_OCM_TRANSPORT_JSON;
    delete process.env.KOVA_NETWORK_FRONTAGE_ENABLED;
    process.env.OPENCLAW_CONFIG_PATH = parentConfig;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fixture-parent-env";
    const result = await executeGatewayCall({ env: "selected", method: "health", params: {}, timeoutMs: 1000 }, { prepare: () => runtimeContext, connect: openDirectGatewayRpcClient });
    assert.equal(result.exitCode, 0);
    assert.equal(Socket.frames.find((frame) => frame.method === "connect").params.auth.token, "fixture-selected-config");
    assert.equal(process.env.OPENCLAW_CONFIG_PATH, parentConfig);
    assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN, "fixture-parent-env");
    assert.equal(await tokenFor(), "fixture-parent-config");
    await atomicJson(parentConfig, { gateway: { remote: { token: "fixture-parent-remote" } } });
    assert.equal(await tokenFor(), "fixture-parent-env");
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    assert.equal(await tokenFor(), "fixture-parent-remote");
    process.env.OPENCLAW_GATEWAY_TOKEN = "fixture-parent-env";
    await atomicJson(configPath, { gateway: { remote: { token: "fixture-selected-remote" } } });
    assert.equal(await tokenFor({ authFromRuntimeConfig: true }), "fixture-selected-remote");
    await writeFile(configPath, "{ gateway: { auth: { token: 'fixture-selected-json5' } } }\n");
    assert.equal(await tokenFor({ authFromRuntimeConfig: true }), "fixture-selected-json5");
    for (const gateway of [
      { $include: "gateway.json", remote: { token: "fixture-unproven-fallback" } },
      { auth: { $include: "auth.json" }, remote: { token: "fixture-unproven-fallback" } },
      { auth: { token: "${PARENT_TOKEN}" } },
      { auth: { token: { source: "env", provider: "default", id: "PARENT_TOKEN" } } }
    ]) {
      await atomicJson(configPath, { gateway });
      await assert.rejects(tokenFor({ authFromRuntimeConfig: true }), /requires literal credentials/);
    }
    delete process.env.OPENCLAW_CONFIG_PATH;
    assert.equal(await tokenFor(), "fixture-default-root");
    await atomicJson(configPath, {});
    const before = Socket.frames.length;
    await assert.rejects(tokenFor({ authFromRuntimeConfig: true }), /requires a gateway auth token/);
    assert.equal(Socket.frames.length, before, "missing selected credentials must not fall back to parent credentials");
  } finally {
    globalThis.WebSocket = previousSocket;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("elapsed deadlines classify synchronous environment lookup failures as timeouts", async () => {
  const options = { env: "test", method: "health", params: {}, timeoutMs: 20, afterMs: 0 };
  const prepare = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    throw Object.assign(new Error("environment lookup failed"), { code: "ETIMEDOUT" });
  };
  const rpc = await executeGatewayCall(options, { prepare, connect: () => assert.fail("expired lookup must not connect") });
  assert.equal(rpc.exitCode, 3);
  const foreground = await runForegroundGateway(options, { signal: new AbortController().signal }, { prepare });
  assert.equal(foreground.exitCode, 3);
  const immediate = await executeGatewayCall({ ...options, timeoutMs: 1000 }, { prepare: () => { throw new Error("environment lookup failed"); } });
  assert.equal(immediate.exitCode, 1);
});

test("parameter file reads accept cancellation and malformed input remains distinct", async (t) => {
  const root = await directory(t);
  const path = join(root, "params.json");
  await atomicJson(path, {});
  const signal = AbortSignal.abort(new Error("cancel parameter reads"));
  const params = { key: "agent:main:fixture", sessionId: "fixture-session", processId: "fixture-process", instanceId: "fixture-instance" };
  requestSchemas.check("sessions.processes.stop", params);
  for (const flag of ["merge-from", "session-from", "from"]) {
    await assert.rejects(resolveGatewayParams({ method: "sessions.processes.stop", params, [flag]: path }, { signal }), (error) => error.name === "AbortError");
  }
  await writeFile(path, "{");
  const malformed = await executeGatewayCall({ env: "test", method: "health", params: {}, timeoutMs: 1000, "merge-from": path }, { prepare: () => assert.fail("invalid input must not prepare an environment") });
  assert.equal(malformed.exitCode, 2);
});

async function fixture(t) {
  const root = await directory(t);
  const path = join(root, "operation.mjs");
  await writeFile(path, `
import { serveOperation } from ${JSON.stringify(backgroundUrl)};
import { setTimeout as sleep } from "node:timers/promises";
await serveOperation(async (options, context) => {
  if (options.before) await sleep(options.before, undefined, { signal: context.signal });
  await context.publish({ pid: process.pid });
  await sleep(options.delay ?? 50, undefined, { signal: context.signal });
  if (options.fail) throw new Error("fixture product error");
  return { output: { method: "health", result: { ok: false }, error: null, elapsedMs: 50 }, exitCode: 0 };
});
`);
  return { root, path };
}

test("background process detaches output, refuses reuse and keeps repeatable joins", async (t) => {
  const { root, path } = await fixture(t);
  const handle = join(root, "nested", "operation.json");
  const starter = join(root, "start.mjs");
  await writeFile(starter, `
import { startOperation } from ${JSON.stringify(backgroundUrl)};
const result = await startOperation(${JSON.stringify(path)}, { env: "test", handle: ${JSON.stringify(handle)}, delay: 3000 }, { entry: "gateway-health", method: "health", lifetimeMs: 10000 });
process.stdout.write(JSON.stringify(result));
`);
  const started = JSON.parse((await exec(process.execPath, [starter], { timeout: 2000 })).stdout);
  assert.equal(started.entry, "gateway-health");
  t.after(() => cleanupGatewayHandle(handle, { timeoutMs: 2000 }));
  await assert.rejects(startOperation(path, { env: "test", handle }, { entry: "gateway-health", method: "health", lifetimeMs: 1000 }), /EEXIST/);
  await assert.rejects(joinOperation(handle, { timeoutMs: 100, method: "status" }), /does not match/);
  await assert.rejects(joinOperation(handle, { timeoutMs: 20 }), (error) => error.exitCode === 3);
  const stopped = await cleanupGatewayHandle(handle, { timeoutMs: 2000 });
  assert.equal(stopped.exitCode, 1);
  assert.deepEqual(await joinOperation(handle), stopped);
  assert.deepEqual(await cleanupGatewayHandle(handle), stopped);
  assert.equal(JSON.parse(await readFile(handle, "utf8")).ref.pid, started.ref.pid);
});

test("background errors and cancellation before handle publication remain observable", async (t) => {
  const { root, path } = await fixture(t);
  const handle = join(root, "failure.json");
  await startOperation(path, { env: "test", handle, fail: true }, { entry: "gateway-health", method: "health", lifetimeMs: 1000 });
  assert.match((await joinOperation(handle, { timeoutMs: 2000 })).output.error, /fixture product error/);
  const partial = join(root, "partial.json");
  const pending = startOperation(path, { env: "test", handle: partial, before: 5000 }, { entry: "gateway-health", method: "health", lifetimeMs: 10000 });
  const rejected = assert.rejects(pending, /abort|stopped|disconnected/i);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await readFile(join(`${partial}.d`, "operation.json")); break; } catch { await sleep(10); }
  }
  const result = await cleanupGatewayHandle(partial, { timeoutMs: 2000 });
  assert.equal(result.exitCode, 1);
  await rejected;
  assert.equal(await cleanupGatewayHandle(join(root, "absent.json")), null);
});

test("cleanup refuses to report success when owned shutdown is unresolved", async (t) => {
  const root = await directory(t);
  const handle = join(root, "failed-stop.json");
  await atomicJson(join(`${handle}.d`, "operation.json"), { schema: "kova.gateway.operation.v1", id: "operation", entry: "gateway-start", handlePath: handle, directory: `${handle}.d` });
  await atomicJson(join(`${handle}.d`, "result.json"), { output: { error: "stop failed" }, exitCode: 1, cleanupComplete: false, cleanupError: "child remains" });
  await assert.rejects(cleanupGatewayHandle(handle), /cleanup unresolved: child remains/);
});

test("foreground Gateway checks config identity, preserves logs and stops its owned process", async (t) => {
  const root = await directory(t);
  const expectedPath = join(root, "openclaw.json");
  const catalogDirectory = join(root, ".openclaw/kova-persona/claude");
  await mkdir(catalogDirectory, { recursive: true });
  const controller = new AbortController();
  const methods = [];
  let published;
  const options = { env: "test", timeoutMs: 2000 };
  const context = { signal: controller.signal, operation: { directory: root }, async publish(handle) { published = handle; await sleep(100); controller.abort(new CallError("background operation stopped", 1)); } };
  const dependencies = {
    prepare: () => ({ root, configPath: expectedPath, gatewayPort: 12345 }),
    requireUnusedPort: async () => {},
    invocation: (args) => {
      assert.deepEqual(args, ["@test", "--", "gateway", "run", "--port", "12345"]);
      return { file: process.execPath, args: ["-e", "console.log('gateway output'); console.log(JSON.stringify({catalogDirectory:process.env.CLAUDE_CONFIG_DIR})); console.error('gateway error'); setInterval(() => {}, 1000)"], env: { ...process.env, CLAUDE_CONFIG_DIR: "/unrelated/catalog" } };
    },
    fetch: async () => ({ ok: true, body: { cancel: async () => {} } }),
    connect: async (_runtime, settings) => {
      assert.equal(settings.authFromRuntimeConfig, true);
      return { client: { close() {}, async request(method, params) { requestSchemas.check(method, params); methods.push(method); return { path: expectedPath }; } } };
    }
  };
  const stopped = await runForegroundGateway(options, context, dependencies);
  assert.equal(stopped.exitCode, 0);
  assert.deepEqual(methods, ["config.get"]);
  assert.ok(published.pid > 0);
  assert.match(await readFile(published.stdoutPath, "utf8"), /gateway output/);
  assert.ok((await readFile(published.stdoutPath, "utf8")).includes(JSON.stringify({ catalogDirectory })));
  assert.match(await readFile(published.stderrPath, "utf8"), /gateway error/);
  assert.throws(() => process.kill(published.pid, 0), (error) => error.code === "ESRCH");
  const wrongRoot = join(root, "wrong");
  await mkdir(wrongRoot);
  const mismatch = await runForegroundGateway(options, { signal: new AbortController().signal, operation: { directory: wrongRoot }, publish() { assert.fail("must not publish a mismatched Gateway"); } }, { ...dependencies, connect: async () => ({ client: { close() {}, request: async (method, params) => { requestSchemas.check(method, params); return { path: join(root, "other.json") }; } } }) });
  assert.equal(mismatch.exitCode, 1);
  assert.match(mismatch.output.error, /config path does not match/);
});

test("resolved Gateway helper fixtures have pinned schema coverage", (t) => requestSchemas.report(t));
