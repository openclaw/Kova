import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CallError, cleanupGatewayHandle, joinOperation, requestOperation, startOperation } from "../support/verify/background.mjs";
import { controlUiMain, executeControlUi, observeControlUiSocket } from "../support/verify/control-ui.mjs";
import { controlUiFlows } from "../support/verify/control-ui-flows.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../support/verify/control-ui.mjs", import.meta.url));
const backgroundUrl = new URL("../support/verify/background.mjs", import.meta.url).href;

async function invoke(args) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { timeout: 8000 });
    return { ...result, code: 0 };
  } catch (error) {
    if (error.killed || typeof error.code !== "number") throw error;
    return error;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-control-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function output(flow) {
  return { flow, steps: [{ action: "send", status: "pending" }], requests: [], createdIds: [], sessionKey: null, error: null };
}

function send(socket, id, method, params = {}) {
  socket.emit("framesent", { payload: JSON.stringify({ type: "req", id, method, params }) });
}

function reply(socket, id, payload, ok = true) {
  socket.emit("framereceived", { payload: JSON.stringify({ type: "res", id, ok, ...(ok ? { payload } : { error: payload }) }) });
}

test("Control UI CLI rejects malformed calls before opening a browser", async (t) => {
  const root = await temporary(t);
  const valid = ["--env", "fixture", "--flow", "new-session-page", "--artifact-dir", join(root, "screens")];
  const cases = [
    [],
    [...valid, "--unknown", "value"],
    [...valid, "--flow", "new-session-page"],
    [...valid, "--timeout", "0"],
    [...valid, "--background"],
    [...valid, "--session-key", "agent:main:first", "--session-from", join(root, "input.json")],
    ["--wait", join(root, "handle.json"), "--env", "fixture"],
    ["--env", "fixture", "--flow", "unlisted-flow", "--artifact-dir", root],
    ["--env", "fixture", "--flow", "reconnect-and-send", "--artifact-dir", root],
    ["--env", "fixture", "--flow", "reconnect-and-send", "--artifact-dir", root, "--background", "--handle", join(root, "browser.json")],
    ["--env", "fixture", "--flow", "open-session-keep-open", "--artifact-dir", root],
  ];
  for (const args of cases) {
    const result = await invoke(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.error, "string");
    assert.ok(report.error.length > 0);
    assert.deepEqual(report.steps, []);
    assert.deepEqual(report.requests, []);
  }
  await assert.rejects(readFile(join(root, "screens", "01-connect.png")), { code: "ENOENT" });
});

test("Control UI implements every sessions-template browser flow", async () => {
  const template = JSON.parse(await readFile(new URL("../verify/templates/sessions/template.json", import.meta.url), "utf8"));
  const names = new Set(template.phases.flatMap((phase) => phase.commands.flatMap((command) =>
    [...command.matchAll(/--flow\s+([a-z][a-z0-9-]*)\b/g)].map((match) => match[1]))));
  assert.equal(names.size, 37);
  for (const name of names) assert.equal(typeof controlUiFlows[name], "function", name);
});

test("browser request recording excludes private payloads and attributes late replies to their initiating flow", () => {
  const socket = new EventEmitter();
  const first = output("new-session-page"), second = output("open-session-keep-open");
  let current = first;
  let connected = 0, disconnected = 0;
  observeControlUiSocket(socket, () => current, {
    connected: () => { connected++; }, disconnected: () => { disconnected++; },
  });
  socket.emit("framesent", { payload: "{" });
  socket.emit("framereceived", { payload: "{" });
  socket.emit("framereceived", { payload: JSON.stringify({ type: "event", event: "chat", payload: { text: "private-event-body" } }) });
  send(socket, "connect", "connect", { auth: { token: "private-auth-token" } });
  reply(socket, "connect", { auth: { deviceToken: "private-device-token" } });
  send(socket, "create", "sessions.create", { key: "agent:main:created", message: "private-request-body" });
  current = second;
  reply(socket, "create", { key: "agent:main:created", sessionId: "created-id", runStarted: true, runId: "created-run", text: "private-response-body" });
  reply(socket, "create", { key: "agent:main:duplicate", sessionId: "duplicate-id" });
  send(socket, "read", "chat.history", { sessionKey: "agent:main:existing" });
  reply(socket, "read", { key: "agent:main:existing", sessionId: "existing-id", text: "private-history-body" });
  send(socket, "unrelated-create", "sessions.create", { key: "agent:main:unrelated" });
  reply(socket, "unrelated-create", { key: "agent:main:unrelated", sessionId: "unrelated-id" });
  send(socket, "failed", "chat.send", { message: "private-failed-body" });
  reply(socket, "failed", { code: "UNAVAILABLE", message: "private-gateway-error" }, false);
  send(socket, "pending", "chat.send", { message: "private-pending-body" });
  socket.emit("close");
  assert.equal(connected, 1);
  assert.equal(disconnected, 1);
  assert.deepEqual(first.createdIds, ["agent:main:created", "created-id", "created-run"]);
  assert.equal(first.sessionKey, "agent:main:created");
  assert.deepEqual(second.createdIds, []);
  assert.equal(second.sessionKey, null);
  assert.deepEqual(first.requests.map(({ method, status }) => [method, status]), [["connect", "result"], ["sessions.create", "result"]]);
  assert.deepEqual(second.requests.map(({ status }) => status), ["result", "result", "error", "closed"]);
  for (const request of [...first.requests, ...second.requests]) {
    assert.deepEqual(Object.keys(request).sort(), request.status === "error" ? ["elapsedMs", "errorCode", "method", "status"] : ["elapsedMs", "method", "status"]);
    assert.ok(Number.isFinite(request.elapsedMs) && request.elapsedMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify([first, second]), /private-|duplicate-id|unrelated-id|existing-id/);
  assert.equal(second.requests.find(({ status }) => status === "error").errorCode, "UNAVAILABLE");
});

test("browser creation receipts distinguish new resources from reuse and failed requests", () => {
  for (const { flow, method, response, expected } of [
    { flow: "new-session-incognito", method: "sessions.create", response: { key: "new-key", sessionId: "new-id", runStarted: false, runId: "old-run" }, expected: ["new-key", "new-id"] },
    { flow: "fork-from-message", method: "sessions.fork", response: { sessionKey: "fork-key", editorText: "Draft" }, expected: ["fork-key"] },
    { flow: "catalog-import-row", method: "sessions.catalog.import", response: { created: true, sessionKey: "import-key" }, expected: ["import-key"] },
    { flow: "catalog-import-row", method: "sessions.catalog.import", response: { created: false, sessionKey: "import-key" }, expected: [] },
    { flow: "send-then-stop", method: "chat.send", response: { status: "started", runId: "new-run" }, expected: ["new-run"] },
    { flow: "send-then-stop", method: "chat.send", response: { status: "in_flight", runId: "existing-run" }, expected: [] },
    { flow: "goal-composer-and-pill", method: "chat.send", response: { status: "started", runId: "existing-run", replayed: true }, expected: [] },
    { flow: "goal-composer-and-pill", method: "chat.send", response: { action: "start", status: "started", runId: "new-run", sessionId: "existing-session", goalId: "new-goal", operationId: "new-operation" }, expected: ["new-run", "new-goal", "new-operation"] },
    { flow: "resume-in-new-session", method: "sessions.recover", response: { ok: true, key: "recover-key", sessionId: "recover-id", continuation: null }, expected: [] },
  ]) {
    const socket = new EventEmitter(), report = output(flow);
    observeControlUiSocket(socket, report);
    send(socket, "failed", method);
    reply(socket, "failed", response, false);
    assert.deepEqual(report.createdIds, []);
    send(socket, "accepted", method);
    reply(socket, "accepted", response);
    assert.deepEqual(report.createdIds, expected, `${flow}: ${JSON.stringify(response)}`);
  }
});

test("observed browser connect and session creation inputs match pinned Gateway schemas", async (t) => {
  const schemas = await loadGatewaySchemaAssertions();
  const socket = new EventEmitter(), observed = [];
  observeControlUiSocket(socket, output("new-session-page"), {
    onRequest: (method, params) => observed.push({ method, params }),
  });
  send(socket, "connect", "connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "openclaw-control-ui", version: "fixture", platform: "web", mode: "webchat" },
    role: "operator", scopes: ["operator.admin"], auth: { token: "synthetic-browser-token" },
  });
  send(socket, "create", "sessions.create", { key: "agent:main:browser-fixture", agentId: "main", displayName: "Browser fixture" });
  assert.deepEqual(observed.map(({ method }) => method), ["connect", "sessions.create"]);
  for (const { method, params } of observed) schemas.check(method, params);
  schemas.report(t);
});

async function retainedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-ui-retained-"));
  const path = join(root, "operation.mjs"), handles = new Set();
  t.after(async () => {
    try {
      for (const handle of handles) await cleanupGatewayHandle(handle, { timeoutMs: 5000 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await writeFile(path, `
import { atomicJson, serveOperation, serveOperationRequests } from ${JSON.stringify(backgroundUrl)};
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
await serveOperation(async (options, context) => {
  let count = 0, last;
  try {
    await context.publish({ pid: process.pid, acceptsRequests: true });
    await serveOperationRequests(context, async (call, { signal }) => {
      const ordinal = ++count;
      if (call.delay) {
        await atomicJson(join(context.operation.directory, "entered.json"), { ordinal });
        try { await sleep(call.delay, undefined, { signal }); }
        finally { await atomicJson(join(context.operation.directory, "interrupted.json"), { aborted: signal.aborted }); }
      }
      last = { output: { flow: call.flow ?? "open-session-keep-open", result: { ordinal, pid: process.pid }, error: null }, exitCode: 0 };
      return last;
    });
  } catch (error) {
    if (context.signal.reason?.message === "background operation stopped") {
      return last ?? { output: { error: null }, exitCode: 0 };
    }
    throw error;
  } finally {
    await atomicJson(join(context.operation.directory, "closed.json"), { count, pid: process.pid });
  }
});
`);
  return {
    root,
    async start(name, lifetimeMs = 15000) {
      const handle = join(root, `${name}.json`);
      handles.add(handle);
      const started = await startOperation(path, { env: "fixture", handle, startupTimeoutMs: 5000 }, { entry: "control-ui", method: "control-ui", lifetimeMs });
      return { handle, started, directory: `${handle}.d` };
    },
  };
}

async function awaitJson(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the retained operation");
    await sleep(20);
  }
}

test("retained Control UI calls reuse one process and wait joins its completed cleanup", { timeout: 20000 }, async (t) => {
  const fixture = await retainedFixture(t);
  const { handle, started, directory } = await fixture.start("reused");
  const settings = { entry: "control-ui", env: "fixture", timeoutMs: 5000 };
  const first = await requestOperation(handle, { flow: "open-session-keep-open" }, settings);
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.output.result, { ordinal: 1, pid: started.ref.pid });
  await assert.rejects(requestOperation(handle, {}, { ...settings, env: "other" }), (error) => error.exitCode === 2);
  await assert.rejects(readFile(join(directory, "request", "call.json")), { code: "ENOENT" });
  const secondCall = await invoke(["--env", "fixture", "--flow", "open-session-keep-open", "--session-key", "agent:main:fixture", "--artifact-dir", join(fixture.root, "screens"), "--handle", handle, "--timeout", "5000"]);
  assert.equal(secondCall.code, 0);
  const second = JSON.parse(secondCall.stdout);
  assert.deepEqual(second.result, { ordinal: 2, pid: started.ref.pid });
  const stopped = await controlUiMain(["--wait", handle, "--timeout", "5000"]);
  assert.equal(stopped.exitCode, 0);
  assert.equal(stopped.cleanupComplete, true);
  assert.deepEqual(stopped.output, second);
  assert.deepEqual(await awaitJson(join(directory, "closed.json")), { count: 2, pid: started.ref.pid });
  assert.deepEqual(await controlUiMain(["--wait", handle, "--timeout", "5000"]), stopped);
  await assert.rejects(requestOperation(handle, {}, settings), /finished/);
});

test("retained Control UI cancellation interrupts an active call and refuses a competing caller", { timeout: 15000 }, async (t) => {
  const fixture = await retainedFixture(t);
  const { handle, directory } = await fixture.start("cancelled");
  const controller = new AbortController();
  const settings = { entry: "control-ui", env: "fixture", timeoutMs: 10000 };
  const pending = requestOperation(handle, { delay: 10000 }, { ...settings, signal: controller.signal });
  const rejection = assert.rejects(pending, /cancel browser call/);
  await awaitJson(join(directory, "entered.json"));
  await assert.rejects(requestOperation(handle, {}, settings), /already has a caller/);
  controller.abort(new CallError("cancel browser call", 3));
  await rejection;
  const stopped = await joinOperation(handle, { timeoutMs: 5000 });
  assert.equal(stopped.cleanupComplete, true);
  assert.equal(stopped.exitCode, 3);
  assert.deepEqual(await awaitJson(join(directory, "interrupted.json")), { aborted: true });
  assert.equal((await awaitJson(join(directory, "closed.json"))).count, 1);
  await assert.rejects(requestOperation(handle, {}, settings), /finished/);
});

test("retained Control UI expiry closes resources and makes the handle terminal", { timeout: 10000 }, async (t) => {
  const fixture = await retainedFixture(t);
  const { handle, started, directory } = await fixture.start("expired", 2000);
  const stopped = await joinOperation(handle, { timeoutMs: 5000 });
  assert.equal(stopped.cleanupComplete, true);
  assert.equal(stopped.exitCode, 3);
  assert.match(stopped.output.error, /lifetime timeout/);
  assert.deepEqual(await awaitJson(join(directory, "closed.json")), { count: 0, pid: started.ref.pid });
  await assert.rejects(requestOperation(handle, {}, { entry: "control-ui", env: "fixture", timeoutMs: 5000 }), /finished/);
  assert.deepEqual(await controlUiMain(["--wait", handle, "--timeout", "5000"]), stopped);
});

test("browser cancellation waits for browser.close before returning", { timeout: 10000 }, async (t) => {
  const root = await temporary(t);
  const navigation = deferred(), closeStarted = deferred(), finishClose = deferred();
  const page = new EventEmitter(), context = new EventEmitter();
  page.url = () => "about:blank";
  page.setDefaultTimeout = () => {};
  page.setDefaultNavigationTimeout = () => {};
  page.goto = async () => { navigation.resolve(); await new Promise(() => {}); };
  page.screenshot = async () => {};
  page.locator = () => ({ first() { return this; }, waitFor: async () => {} });
  context.grantPermissions = async () => {};
  context.newPage = async () => { context.emit("page", page); return page; };
  let closeCount = 0, returned = false;
  const browser = {
    newContext: async () => context,
    close: async () => { closeCount++; closeStarted.resolve(); await finishClose.promise; },
  };
  const controller = new AbortController();
  const result = executeControlUi({ env: "fixture", flow: "open-session-keep-open", "session-key": "agent:main:fixture", "artifact-dir": root, timeoutMs: 5000 }, {
    signal: controller.signal,
    prepare: () => ({ packageRoot: root }),
    ocm: () => ({ ok: true, browserUrl: "http://127.0.0.1:12345/#token=synthetic-pairing-secret" }),
    launch: async () => browser,
  }).then((value) => { returned = true; return value; });
  try {
    await navigation.promise;
    controller.abort(new CallError("cancel browser navigation", 3));
    await closeStarted.promise;
    await nextTurn();
    assert.equal(returned, false);
    assert.equal(closeCount, 1);
  } finally { finishClose.resolve(); }
  const completed = await result;
  assert.equal(completed.exitCode, 3);
  assert.equal(closeCount, 1);
  assert.doesNotMatch(JSON.stringify(completed.output), /synthetic-pairing-secret/);
});

test("navigation retires requests from the replaced Gateway socket even without a close event", async (t) => {
  const root = await temporary(t), page = new EventEmitter(), context = new EventEmitter();
  let address = "about:blank", navigations = 0;
  const addresses = [];
  page.url = () => address;
  page.setDefaultTimeout = page.setDefaultNavigationTimeout = () => {};
  page.locator = () => ({ first() { return this; }, waitFor: async () => {} });
  page.screenshot = async () => Buffer.from("synthetic capture");
  page.goto = async (url) => {
    address = url;
    addresses.push(url);
    const socket = new EventEmitter();
    page.emit("websocket", socket);
    send(socket, "connect", "connect"); reply(socket, "connect", {});
    if (++navigations === 1) send(socket, "abandoned", "sessions.patch", { key: "agent:main:previous", unread: false });
  };
  page.reload = () => page.goto(address);
  context.grantPermissions = async () => {};
  context.newPage = async () => { context.emit("page", page); return page; };
  const result = await executeControlUi({ env: "fixture", flow: "open-by-link", "session-key": "agent:main:next", "artifact-dir": root, timeoutMs: 3000 }, {
    prepare: () => ({ packageRoot: root }),
    ocm: () => ({ ok: true, browserUrl: "http://127.0.0.1:12345/console/" }),
    launch: async () => ({ newContext: async () => context, close: async () => {} }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(navigations, 2);
  assert.ok(addresses.every((url) => new URL(url).pathname.startsWith("/console/")));
  assert.equal(result.output.requests.find(({ method }) => method === "sessions.patch").status, "closed");
});

test("browser completion joins send receipts and retires a closed tab without a socket event", async (t) => {
  const root = await temporary(t), page = new EventEmitter(), context = new EventEmitter(), socket = new EventEmitter();
  let receiptReturned = false, closedAfterReceipt = false;
  const locator = { first() { return this; }, locator() { return this; }, evaluate: async () => "agent:main:fixture", fill: async () => {}, click: async () => {
    send(socket, "send", "chat.send", { sessionKey: "agent:main:fixture", message: "example" });
    const tab = new EventEmitter(), tabSocket = new EventEmitter();
    context.emit("page", tab); tab.emit("websocket", tabSocket);
    send(tabSocket, "connect", "connect"); reply(tabSocket, "connect", {});
    send(tabSocket, "history", "chat.history", { sessionKey: "agent:main:fixture" });
    tab.emit("close");
    send(tabSocket, "late-history", "chat.history", { sessionKey: "agent:main:fixture" });
    setTimeout(() => { receiptReturned = true; reply(socket, "send", { status: "started", runId: "created-run" }); }, 100);
  } };
  page.url = () => "http://127.0.0.1:12345/chat";
  page.setDefaultTimeout = page.setDefaultNavigationTimeout = () => {};
  page.locator = () => locator;
  page.screenshot = async () => Buffer.from("synthetic capture");
  context.grantPermissions = async () => {};
  context.newPage = async () => {
    context.emit("page", page); page.emit("websocket", socket);
    send(socket, "connect", "connect"); reply(socket, "connect", {});
    return page;
  };
  const result = await executeControlUi({ env: "fixture", flow: "reconnect-and-send", "session-key": "agent:main:fixture", "artifact-dir": root, timeoutMs: 3000 }, {
    prepare: () => ({ packageRoot: root }),
    ocm: () => ({ ok: true, browserUrl: "http://127.0.0.1:12345/" }),
    launch: async () => ({ newContext: async () => context, close: async () => { closedAfterReceipt = receiptReturned; } }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(closedAfterReceipt, true);
  assert.deepEqual(result.output.requests.filter(({ method }) => method === "chat.history").map(({ status }) => status), ["closed"]);
  assert.deepEqual(result.output.createdIds, ["created-run"]);
  assert.equal(result.output.requests.find(({ method }) => method === "chat.send").status, "result");
});

test("reconnect refuses a different session before sending", async () => {
  let sent = false;
  const pane = { first() { return this; }, evaluate: async () => "agent:main:actual", locator: () => ({ fill: async () => { sent = true; } }) };
  await assert.rejects(controlUiFlows["reconnect-and-send"]({
    requireSession: () => "agent:main:different", waitConnected: async () => {},
    step: async (_name, action) => action(), page: { locator: () => pane },
  }), (error) => error.exitCode === 2 && /does not match/.test(error.message));
  assert.equal(sent, false);
});
