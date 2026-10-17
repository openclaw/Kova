import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CallError, cleanupGatewayHandle, joinOperation, requestOperation, startOperation } from "../support/verify/background.mjs";
import { controlUiMain, createControlUiBrowser, executeControlUi, observeControlUiSocket as observeSelectedSocket, resolveControlUiSession, runRetainedBrowser } from "../support/verify/control-ui.mjs";
import { controlUiFlows } from "../support/verify/control-ui-flows.mjs";
import { observeControlUiHttp, redactControlUiParams } from "../support/verify/control-ui-requests.mjs";
import { controlUiException, startupFailure } from "../support/verify/control-ui-errors.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../support/verify/control-ui.mjs", import.meta.url));
const backgroundUrl = new URL("../support/verify/background.mjs", import.meta.url).href;
const controlUiUrl = new URL("../support/verify/control-ui.mjs", import.meta.url).href;

async function invoke(args) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { timeout: 8000 });
    return { ...result, code: 0 };
  } catch (error) {
    if (error.killed || typeof error.code !== "number") throw error;
    return error;
  }
}

function observeControlUiSocket(socket, report, options = {}) {
  socket.url ??= () => "ws://127.0.0.1:12345/";
  return observeSelectedSocket(socket, report, { gatewayEndpoints: new Set(["http://127.0.0.1:12345"]), ...options });
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
    ["PRIVATE_STARTUP_CANARY"],
    [...valid, "--PRIVATE_STARTUP_CANARY", "value"],
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
    assert.doesNotMatch(result.stdout, /PRIVATE_STARTUP_CANARY/);
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

for (const stage of ["prepare", "pairing"]) {
  for (const delayMs of [0, 60]) test(`foreground ${stage} failure ${delayMs ? "after" : "before"} the startup deadline`, async () => {
    const calls = [];
    const fail = () => {
      if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      throw new Error("Synthetic startup failure");
    };
    const result = await executeControlUi({ env: "fixture", flow: "new-session-page", timeoutMs: 20 }, {
      prepare: () => {
        calls.push("prepare");
        if (stage === "prepare") fail();
        return { packageRoot: "/unused" };
      },
      ocm: () => { calls.push("pairing"); fail(); },
      launch: async () => { assert.fail("A startup failure must not launch a browser"); },
    });
    assert.equal(result.exitCode, delayMs ? 3 : 1);
    assert.match(result.output.error, new RegExp(`^Control UI ${delayMs ? "timeout" : "startup failed"} at ${stage === "prepare" ? "runtime" : "dashboard"}:`));
    assert.match(result.output.error, /"exception":\{"name":"Error"\}/);
    await assertControlUiPrints(result.output);
    assert.deepEqual(result.output.steps, []);
    assert.deepEqual(calls, stage === "prepare" ? ["prepare"] : ["prepare", "pairing"]);
  });
}

test("retained browser startup honors elapsed expiry before an abort timer can run", async () => {
  const result = await runRetainedBrowser({ env: "fixture", flow: "open-session-keep-open", timeoutMs: 20 }, {
    signal: new AbortController().signal,
    operation: { expiresAt: new Date(Date.now() + 20).toISOString() },
    publish: async () => { assert.fail("Expired startup must not publish a browser handle"); },
  }, {
    createBrowser: async () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      throw new Error("Synthetic retained startup failure");
    },
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.output.flow, "open-session-keep-open");
  assert.match(result.output.error, /^Control UI timeout at browser:/);
  assert.deepEqual(result.output.steps, []);
});

test("startup diagnostics retain safe exception identity through bounded causes", () => {
  const secret = "PRIVATE_STARTUP_CANARY";
  const native = Object.assign(new Error(`browserType.launch: https://example.invalid/#token=${secret}`), {
    code: "EACCES", status: 127, signal: "SIGKILL", stdout: JSON.stringify({ ok: false, reason: "Gateway is not healthy.", token: secret }),
    stderr: `ocm: runtime "${secret}" is busy with another operation; retry after it finishes\nRun "ocm help" for usage.\n`,
  });
  native.stack = secret;
  const wrapper = Object.assign(new Error(secret, { cause: native }), { ocmCommand: "dashboard", exitCode: 0 });
  const failure = startupFailure("dashboard", wrapper);
  assert.equal(failure.exitCode, 1);
  assert.deepEqual(failure.exception, {
    name: "Error", command: "dashboard", dashboardReason: { category: "not-healthy" },
    cause: { name: "Error", code: "EACCES", status: 127, signal: "SIGKILL", operation: "browserType.launch", ocmRefusal: "runtime-busy" },
  });
  assert.doesNotMatch(failure.describe(), new RegExp(`${secret}|https:|example.invalid`));
  for (const exitCode of [0, -1, 99, "3"]) assert.equal(startupFailure("runtime", { exitCode }).exitCode, 1);
  assert.equal(startupFailure("runtime", new Error(secret, { cause: { code: "ETIMEDOUT" } })).exitCode, 3);
  wrapper.cause = wrapper;
  assert.deepEqual(controlUiException(wrapper).cause, { causeTruncated: true });
  let reads = 0;
  assert.deepEqual(controlUiException({ get name() { return ++reads === 1 ? "Error" : secret; }, get code() { throw new Error(secret); } }), { name: "Error" });
  assert.deepEqual(controlUiException({ name: secret, code: secret, signal: secret, status: 999, message: secret }), { name: "Error" });
  assert.equal(controlUiException({ stderr: native.stderr + secret }).ocmRefusal, undefined);
  assert.equal(controlUiException({ stderr: native.stderr.repeat(200) }).ocmRefusal, undefined);
  assert.equal(controlUiException({ ocmCommand: "dashboard", cause: { stdout: "x".repeat(1024 * 1024 + 1) } }).dashboardReason, undefined);
});

for (const stage of ["browser-launch", "browser-context", "browser-permissions", "browser-page", "session-input", "artifact-directory", "first-step", "first-step-timeout"]) {
  test(`pre-action ${stage} failure retains its diagnostic and closes the browser`, async (t) => {
    const root = await temporary(t), page = new EventEmitter(), context = new EventEmitter();
    let closed = 0;
    const fail = () => { throw Object.assign(new Error("PRIVATE_BROWSER_CANARY"), { code: "EACCES" }); };
    page.url = () => "about:blank";
    page.setDefaultTimeout = stage.startsWith("first-step") ? () => {
      if (stage === "first-step-timeout") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      fail();
    } : () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.screenshot = async () => Buffer.from("synthetic error capture");
    context.grantPermissions = async () => { if (stage === "browser-permissions") fail(); };
    context.newPage = async () => { if (stage === "browser-page") fail(); context.emit("page", page); return page; };
    const browser = {
      newContext: async () => { if (stage === "browser-context") fail(); return context; },
      close: async () => { closed++; if (["browser-context", "first-step-timeout"].includes(stage)) throw Object.assign(new Error("PRIVATE_CLOSE_CANARY"), { code: "EIO" }); },
    };
    const artifactDir = join(root, "screens");
    if (stage === "artifact-directory") await writeFile(artifactDir, "occupied");
    const result = await executeControlUi({ env: "fixture", flow: "new-session-page", "artifact-dir": artifactDir,
      ...(stage === "session-input" ? { "session-from": join(root, "absent.json") } : {}), timeoutMs: stage === "first-step-timeout" ? 1000 : 2000 }, {
      prepare: () => ({ packageRoot: root }),
      ocm: () => ({ ok: true, browserUrl: "http://127.0.0.1:12345/#token=PRIVATE_URL_CANARY" }),
      launch: async () => { if (stage === "browser-launch") fail(); return browser; },
    });
    assert.equal(result.exitCode, stage === "first-step-timeout" ? 3 : stage === "session-input" ? 2 : 1);
    assert.match(result.output.error, new RegExp(`^Control UI ${stage === "first-step-timeout" ? "timeout at first-step" : `startup failed at ${stage}`}:`));
    assert.match(result.output.error, /"code":"(?:EACCES|ENOENT|EEXIST)"/);
    if (stage === "browser-context") assert.match(result.output.error, /"cleanup":\{"name":"Error","code":"EIO"\}/);
    if (stage === "first-step-timeout") assert.match(result.output.error, /Browser cleanup failed:.*"code":"EIO"/);
    if (["browser-context", "first-step-timeout"].includes(stage)) assert.equal(result.cleanupComplete, false);
    assert.deepEqual(result.output.steps, []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_.*_CANARY/);
    assert.equal(closed, stage === "browser-launch" ? 0 : 1);
    await assertControlUiPrints(result.output);
  });
}

test("retained startup keeps the first failure when closing also fails", async () => {
  const result = await runRetainedBrowser({ env: "fixture", flow: "new-session-page" }, {
    signal: new AbortController().signal, operation: { expiresAt: new Date(Date.now() + 2000).toISOString() },
  }, { createBrowser: async () => ({
    run: async () => { throw startupFailure("session-input", Object.assign(new Error("PRIVATE_INPUT_CANARY"), { code: "ENOENT" })); },
    close: async () => { throw Object.assign(new Error("PRIVATE_CLOSE_CANARY"), { code: "EIO" }); },
  }) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.cleanupComplete, false);
  assert.match(result.output.error, /at session-input:.*ENOENT.*Browser cleanup failed:.*EIO/);
  assert.doesNotMatch(result.output.error, /PRIVATE_/);
  await assertControlUiPrints(result.output);
});

for (const [failure, background] of [["env-status", false], ["env-status", true], ["env-resolve", false], ["dashboard", false], ["invalid-json", false], ["timeout", true]]) test(`native CLI ${background ? "background" : "foreground"} startup preserves ${failure}`, async (t) => {
  const root = await temporary(t), handle = join(root, "browser.json");
  await writeFile(join(root, "ocm"), `#!/usr/bin/env node
const command = process.argv[2] === "env" ? "env-" + process.argv[3] : "dashboard";
const failure = ${JSON.stringify(failure)};
if (failure === "timeout") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); process.exit(0); }
if (failure === "invalid-json") { process.stdout.write("PRIVATE_OCM_CANARY"); process.exit(0); }
if (command === failure) {
  if (command === "dashboard") process.stdout.write(JSON.stringify({ ok: false, reason: "Gateway is not healthy.", token: "PRIVATE_OCM_CANARY" }));
  process.stderr.write("PRIVATE_OCM_CANARY"); process.exit(command === "dashboard" ? 1 : 127);
}
process.stdout.write(JSON.stringify(command === "env-status" ? { root: ${JSON.stringify(root)}, gatewayPort: 12345 } : { binaryPath: ${JSON.stringify(join(root, "openclaw.mjs"))} }));
`, { mode: 0o755 });
  const args = [cli, "--env", "fixture", "--flow", "new-session-page", "--artifact-dir", join(root, "screens"), "--timeout", failure === "timeout" ? "1000" : "5000",
    ...(background ? ["--background", "--handle", handle] : [])];
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  delete env.KOVA_OCM_TRANSPORT_JSON;
  const result = await exec(process.execPath, args, { timeout: 10000, env }).catch((error) => error);
  assert.equal(result.code, failure === "timeout" ? 3 : 1);
  const report = JSON.parse(result.stdout);
  assert.match(report.error, new RegExp(`^Control UI ${failure === "timeout" ? "timeout" : "startup failed"} at ${failure === "dashboard" ? "dashboard" : "runtime"}:`));
  assert.match(report.error, new RegExp(`"command":"${["invalid-json", "timeout"].includes(failure) ? "env-status" : failure}"`));
  if (failure === "timeout") assert.match(report.error, /"code":"ETIMEDOUT"/);
  else if (failure === "invalid-json") assert.match(report.error, /"cause":\{"name":"SyntaxError"\}/);
  else assert.match(report.error, new RegExp(`"cause":\\{"name":"Error","status":${failure === "dashboard" ? 1 : 127}\\}`));
  if (failure === "dashboard") assert.match(report.error, /"dashboardReason":\{"category":"not-healthy"\}/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_OCM_CANARY/);
  assert.deepEqual(report.steps, []);
  await assertControlUiPrints(report);
  if (background) assert.equal(JSON.parse(await readFile(`${handle}.d/result.json`, "utf8")).cleanupComplete, true);
});

for (const retained of [false, true]) test(`${retained ? "retained" : "foreground"} output-write failure preserves the startup cause`, async (t) => {
  const root = await temporary(t), out = join(root, "result.json");
  const fail = () => { throw Object.assign(new Error("PRIVATE_ORIGINAL_CANARY"), { code: "EACCES" }); };
  let result;
  if (retained) {
    const failure = await executeControlUi({ env: "fixture", flow: "new-session-page", timeoutMs: 2000 }, { prepare: fail });
    result = await runRetainedBrowser({ env: "fixture", flow: "new-session-page", out }, {
      signal: new AbortController().signal, operation: { expiresAt: new Date(Date.now() + 2000).toISOString() },
    }, { createBrowser: async () => ({ run: async () => { mkdirSync(out); return failure; }, close: async () => {} }) });
  } else {
    result = await controlUiMain(["--env", "fixture", "--flow", "new-session-page", "--artifact-dir", join(root, "screens"), "--out", out], {
      prepare: () => { mkdirSync(out); fail(); },
    });
  }
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /at runtime:.*EACCES.*at output-write:.*--out already exists/);
  assert.doesNotMatch(result.output.error, /PRIVATE_ORIGINAL_CANARY/);
  assert.deepEqual(result.output.steps, []);
  await assertControlUiPrints(result.output);
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
  assert.deepEqual(second.requests.map(({ status }) => status), ["result", "result", "error", "error"]);
  for (const request of [...first.requests, ...second.requests]) {
    assert.deepEqual(Object.keys(request).sort(), request.errorReason ? ["elapsedMs", "errorCode", "errorReason", "method", "params", "status", "transport"] : request.status === "error" ? ["elapsedMs", "errorCode", "method", "params", "status", "transport"] : ["elapsedMs", "method", "params", "status", "transport"]);
    assert.equal(request.transport, "gateway");
    assert.ok(Number.isFinite(request.elapsedMs) && request.elapsedMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify([first, second]), /private-|duplicate-id|unrelated-id|existing-id/);
  assert.equal(second.requests.find(({ status }) => status === "error").errorCode, "UNAVAILABLE");
  assert.equal(second.requests.at(-1).errorReason, "gateway-disconnected");
  assert.equal(second.error, "Gateway connection closed before replying");
});

for (const expected of [false, true]) test(`Gateway closure ${expected ? "after explicit retirement" : "without retirement"} keeps its original call attribution`, () => {
  const socket = new EventEmitter(), first = output("reconnect-and-send"), second = output("open-by-link");
  let current = first;
  const retire = observeControlUiSocket(socket, () => current);
  send(socket, "pending", "chat.send", { sessionKey: "agent:main:first" });
  current = second;
  if (expected) retire();
  socket.emit("close");
  retire();
  reply(socket, "pending", { status: "started", runId: "must-not-create" });
  assert.equal(first.requests[0].status, expected ? "closed" : "error");
  assert.equal(first.error, expected ? null : "Gateway connection closed before replying");
  assert.equal(second.error, null);
  assert.deepEqual(first.createdIds, []);
});

test("request audit client identity belongs to its socket and updates on reconnect without persisting authentication", () => {
  const first = new EventEmitter(), second = new EventEmitter();
  const reports = [output("reconnect-and-send"), output("open-by-link")], observed = [];
  for (const [index, socket] of [first, second].entries()) {
    observeControlUiSocket(socket, reports[index], {
      onRequest: (method, params, metadata) => observed.push({ index, method, params, clientInfo: metadata.clientInfo }),
    });
  }
  const request = { sessionKey: "agent:main:fixture", message: "private-request-body", __controlUiReconnectResume: true };
  const original = structuredClone(request);
  send(first, "first-connect", "connect", {
    client: { id: "openclaw-control-ui", mode: "webchat", version: "fixture" },
    auth: { token: "private-auth-first" },
  });
  reply(first, "first-connect", {});
  send(first, "first-send", "chat.send", request);
  send(second, "before-connect", "chat.send", request);
  send(second, "second-connect", "connect", {
    client: { id: "openclaw-tui", mode: "cli" }, auth: { deviceToken: "private-auth-second" },
  });
  reply(second, "second-connect", {});
  send(second, "second-send", "chat.send", request);
  send(first, "reconnect", "connect", {
    client: { id: "gateway-client", mode: "backend" }, auth: { token: "private-auth-reconnect" },
  });
  reply(first, "reconnect", {});
  send(first, "after-reconnect", "chat.send", request);
  send(second, "still-second", "chat.send", request);
  const sends = observed.filter(({ method }) => method === "chat.send");
  assert.deepEqual(sends.map(({ index, clientInfo }) => ({ index, clientInfo })), [
    { index: 0, clientInfo: { id: "openclaw-control-ui", mode: "webchat" } },
    { index: 1, clientInfo: undefined },
    { index: 1, clientInfo: { id: "openclaw-tui", mode: "cli" } },
    { index: 0, clientInfo: { id: "gateway-client", mode: "backend" } },
    { index: 1, clientInfo: { id: "openclaw-tui", mode: "cli" } },
  ]);
  for (const { params } of sends) assert.deepEqual(params, original);
  assert.deepEqual(request, original);
  for (const report of reports) {
    for (const record of report.requests) {
      assert.equal(Object.hasOwn(record, "clientInfo"), false);
      if (record.method === "connect") assert.equal(record.params, "[redacted authentication]");
    }
  }
  assert.doesNotMatch(JSON.stringify(reports), /private-auth-|private-request-body|clientInfo|openclaw-control-ui|openclaw-tui|gateway-client/);
});

test("malformed browser envelopes leave pending requests and connection callbacks intact", () => {
  const socket = new EventEmitter(), report = output("new-session-page"), observed = [];
  let connecting = 0, connected = 0, disconnected = 0;
  observeControlUiSocket(socket, report, {
    onRequest: (method) => observed.push(method),
    connecting: () => { connecting++; },
    connected: () => { connected++; },
    disconnected: () => { disconnected++; },
  });
  send(socket, "connect", "connect");
  for (const payload of ["{", "null", "true", "42", '"text"', "[]", '[{"type":"req","id":"extra","method":"sessions.create"}]', '[{"type":"res","id":"connect","ok":true}]']) {
    for (const event of ["framesent", "framereceived"]) {
      assert.doesNotThrow(() => socket.emit(event, { payload }), `${event}: ${payload}`);
    }
  }
  assert.deepEqual(observed, ["connect"]);
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0].status, "pending");
  assert.deepEqual(report.createdIds, []);
  assert.deepEqual({ connecting, connected, disconnected }, { connecting: 1, connected: 0, disconnected: 0 });
  reply(socket, "connect", {});
  assert.equal(report.requests[0].status, "result");
  assert.deepEqual({ connecting, connected, disconnected }, { connecting: 1, connected: 1, disconnected: 0 });
});

test("Markdown export refuses an existing file before any browser interaction", async (t) => {
  const root = await temporary(t), destination = join(root, "conversation.md");
  const original = Buffer.from("# Earlier export\n\nKeep this saved content.\n");
  await writeFile(destination, original);
  const actions = [];
  await assert.rejects(controlUiFlows["export-markdown-and-copy"]({
    options: { env: "fixture", "artifact-dir": root },
    requireSession: () => "agent:main:fixture",
    step: async (name) => {
      actions.push(name);
      throw new Error("Export interacted with the browser before checking its destination");
    },
  }), (error) => error instanceof CallError && error.exitCode === 2 && /already exists/.test(error.message));
  assert.deepEqual(actions, []);
  assert.deepEqual(await readFile(destination), original);
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

test("request parameters preserve selectors while removing private bodies and authentication", () => {
  const raw = {
    sessionKey: "agent:main:fixture", limit: 5, includeTools: true,
    auth: { token: "private-auth-token" }, raw: "private-config-body", message: "private-message-body",
    attachments: [{ content: "private-attachment-body" }],
    nested: { cursor: "next-page", credential: "private-credential", id: "https://private.invalid/capability", extra: "private-arbitrary-string" },
    targets: [{ key: "agent:main:child", expectedSessionId: "child-id" }],
    providerId: "sk-private-provider-secret",
  };
  const original = structuredClone(raw);
  const saved = redactControlUiParams(raw);
  assert.equal(saved.sessionKey, raw.sessionKey);
  assert.equal(saved.limit, 5);
  assert.equal(saved.includeTools, true);
  assert.equal(saved.nested.cursor, "next-page");
  assert.deepEqual(saved.targets, raw.targets);
  assert.doesNotMatch(JSON.stringify(saved), /private-|private\.invalid/);
  assert.deepEqual(raw, original);
  const cyclic = { sessionKey: "agent:main:fixture" };
  cyclic.nested = cyclic;
  assert.doesNotThrow(() => JSON.stringify(redactControlUiParams(cyclic)));
});

function httpRequest(url, { method = "GET", body = null, resourceType = "fetch" } = {}) {
  return {
    url: () => url, method: () => method, postData: () => body, resourceType: () => resourceType,
    headers: () => { assert.fail("HTTP recording must not read authentication headers"); },
    allHeaders: () => { assert.fail("HTTP recording must not read authentication headers"); },
  };
}

test("HTTP recording redacts private inputs and attaches late responses to their original flow", () => {
  const context = new EventEmitter(), first = output("open-by-link"), second = output("reconnect-and-send");
  const observed = [], origin = "http://127.0.0.1:12345";
  let current = first;
  observeControlUiHttp(context, () => current, {
    gatewayOrigins: new Set([origin]),
    onHttpRequest: (request, metadata) => observed.push({ request, flow: metadata.flow, gatewayOrigin: metadata.gatewayOrigin }),
  });
  const original = httpRequest(`${origin}/__openclaw__/session-entry?token=private-query-token&sessionKey=one&sessionKey=two&__proto__=private-prototype`, {
    method: "POST", body: JSON.stringify({ auth: { token: "private-body-token" }, message: "private-body-message", sessionKey: "agent:main:fixture" }),
  });
  context.emit("request", original);
  current = second;
  context.emit("response", { request: () => original, status: () => 403 });
  context.emit("requestfinished", original);
  const external = httpRequest("https://external.invalid/private-capability-path?signature=private-signature", { method: "POST", body: "private-opaque-body" });
  context.emit("request", external);
  context.emit("requestfailed", external);
  const unfinished = httpRequest(`${origin}/healthz`);
  context.emit("request", unfinished);
  context.emit("request", { url: () => "data:text/plain,private-data-body" });
  context.emit("close");
  assert.equal(first.requests.length, 1);
  assert.deepEqual(first.requests[0].params, { query: "[redacted]", body: "[redacted]" });
  assert.equal(first.requests[0].status, "result");
  assert.equal(first.requests[0].statusCode, 403);
  assert.equal(first.requests[0].origin, "gateway");
  assert.deepEqual(second.requests.map(({ status }) => status), ["failed", "closed"]);
  assert.equal(second.requests[0].origin, "external");
  assert.equal(second.requests[0].endpoint, "/[redacted]");
  assert.equal(second.requests[0].pathRedacted, true);
  assert.deepEqual(second.requests[0].params, { query: "[redacted]", body: "[redacted]" });
  assert.deepEqual(second.requests[1].params, { query: {}, body: null });
  assert.equal(observed[0].flow, first.flow);
  assert.equal(observed[0].request.url, original.url());
  assert.deepEqual(observed[0].request.body, JSON.parse(original.postData()));
  assert.deepEqual(observed.map(({ gatewayOrigin }) => gatewayOrigin), [origin, null, origin]);
  assert.doesNotMatch(JSON.stringify([first, second]), /private-|external\.invalid|127\.0\.0\.1/);
});

test("HTTP evidence hides credentials in generic query keys, bodies and external chat paths", () => {
  const context = new EventEmitter(), report = output("open-by-link"), observed = [];
  const origin = "http://127.0.0.1:12345";
  observeControlUiHttp(context, report, {
    gatewayOrigins: new Set([origin]),
    onHttpRequest: (request) => observed.push(request),
  });
  const cases = [
    { url: `${origin}/chat?key=SYNTHETIC_CREDENTIAL`, body: JSON.stringify({ key: "SYNTHETIC_CREDENTIAL" }) },
    { url: "https://external.invalid/chat?key=SYNTHETIC_CREDENTIAL", body: "key=SYNTHETIC_CREDENTIAL" },
    { url: "https://external.invalid/chat/SYNTHETIC_PATH_CREDENTIAL?key=SYNTHETIC_CREDENTIAL", body: JSON.stringify({ id: "SYNTHETIC_CREDENTIAL" }) },
  ];
  for (const { url, body } of cases) {
    const request = httpRequest(url, { method: "POST", body });
    context.emit("request", request);
    context.emit("requestfinished", request);
  }
  assert.equal(report.requests.length, cases.length);
  assert.deepEqual(report.requests.map(({ params }) => params), cases.map(() => ({ query: "[redacted]", body: "[redacted]" })));
  assert.equal(report.requests[0].endpoint, "/chat");
  for (const request of report.requests.slice(1)) {
    assert.equal(request.endpoint, "/[redacted]");
    assert.equal(request.pathRedacted, true);
    assert.equal(request.origin, "external");
  }
  assert.deepEqual(observed, cases.map(({ url, body }, index) => ({
    method: "POST", url, body: index === 1 ? body : JSON.parse(body), resourceType: "fetch",
  })));
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_(?:PATH_)?CREDENTIAL|external\.invalid/);
});

for (const transport of ["gateway", "http"]) test(`${transport} asynchronous audit rejection stays with the initiating flow and hides its exception`, async () => {
  const source = new EventEmitter(), first = output("open-by-link"), second = output("reconnect-and-send");
  const release = deferred(), pendingAudits = new Set();
  let current = first;
  const audit = async (...args) => {
    assert.equal(args.at(-1).flow, first.flow);
    await release.promise;
    throw new Error("private-audit-exception");
  };
  if (transport === "gateway") {
    observeControlUiSocket(source, () => current, { onRequest: audit, pendingAudits });
    send(source, "read", "chat.history", { sessionKey: "agent:main:fixture" });
    reply(source, "read", {});
  } else {
    observeControlUiHttp(source, () => current, { onHttpRequest: audit, pendingAudits });
    const request = httpRequest("http://127.0.0.1:12345/healthz");
    source.emit("request", request);
    source.emit("requestfinished", request);
  }
  current = second;
  assert.equal(pendingAudits.size, 1);
  const audits = [...pendingAudits];
  release.resolve();
  await Promise.all(audits);
  assert.equal(pendingAudits.size, 0);
  assert.deepEqual(first.requests[0].validation, { status: "invalid", code: "OBSERVER_FAILED" });
  assert.equal(first.error, "Control UI request validation failed");
  assert.equal(second.error, null);
  assert.deepEqual(second.requests, []);
  assert.doesNotMatch(JSON.stringify([first, second]), /private-audit-exception/);
});

test("saved live Control UI audit covers all flows with matching request counts", async (t) => {
  const configured = process.env.KOVA_CONTROL_UI_PROOF_DIR;
  if (!configured) return t.skip("Set KOVA_CONTROL_UI_PROOF_DIR to inspect saved live schema-audit results");
  const root = resolve(configured);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const summary = manifest.summary;
  assert.equal(summary.revision, "7e80556f503d26ddde64e274bfb50cbbec7830f5");
  assert.equal(summary.pending, 0);
  assert.equal(summary.invalid, 0);
  assert.equal(summary.unmapped, 0);
  const template = JSON.parse(await readFile(new URL("../verify/templates/sessions/template.json", import.meta.url), "utf8"));
  const expectedFlows = new Set(template.phases.flatMap((phase) => phase.commands.flatMap((command) =>
    [...command.matchAll(/--flow\s+([a-z][a-z0-9-]*)\b/g)].map((match) => match[1]))));
  assert.equal(expectedFlows.size, 37);
  assert.ok(Array.isArray(manifest.outputs) && manifest.outputs.length >= expectedFlows.size);
  const emptyCounts = () => ({ requests: 0, valid: 0, invalid: 0, unmapped: 0 });
  const totals = emptyCounts(), http = emptyCounts(), methods = {}, flows = {};
  const add = (target, counts) => {
    for (const key of Object.keys(totals)) {
      assert.ok(Number.isSafeInteger(counts[key]) && counts[key] >= 0);
      target[key] += counts[key];
    }
    return target;
  };
  const counted = { requests: 1, valid: 1, invalid: 0, unmapped: 0 };
  for (const file of manifest.outputs) {
    assert.equal(typeof file, "string");
    assert.equal(isAbsolute(file), false);
    const path = resolve(root, file), fromRoot = relative(root, path);
    assert.ok(fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
    const saved = JSON.parse(await readFile(path, "utf8"));
    const result = saved.output ?? saved;
    await assertControlUiPrints(result);
    assert.ok(expectedFlows.has(result.flow), result.flow);
    assert.ok(Array.isArray(result.requests) && result.requests.length > 0);
    for (const request of result.requests) {
      assert.ok(["gateway", "http"].includes(request.transport));
      assert.ok(Object.hasOwn(request, "params"));
      assert.equal(request.validation?.status, "valid", `${result.flow}: ${request.method}`);
      assert.ok(["schema", "handler", "no-schema"].includes(request.validation.kind));
      assert.ok(typeof request.validation.source === "string" && request.validation.source.length > 0);
      assert.deepEqual(request.validation.errors, []);
      add(totals, counted);
      add(flows[result.flow] ??= emptyCounts(), counted);
      if (request.transport === "gateway") add(methods[request.method] ??= emptyCounts(), counted);
      else add(http, counted);
    }
  }
  assert.deepEqual(Object.keys(flows).sort(), [...expectedFlows].sort());
  const declaredFlows = { ...summary.flows }, unattributed = declaredFlows["<unattributed>"] ?? emptyCounts();
  delete declaredFlows["<unattributed>"];
  assert.deepEqual(declaredFlows, flows);
  const idle = manifest.idleSummary ?? { ...emptyCounts(), methods: {}, http: {} };
  assert.deepEqual(Object.fromEntries(Object.keys(totals).map((key) => [key, idle[key]])), unattributed);
  assert.equal(idle.invalid, 0);
  assert.equal(idle.unmapped, 0);
  add(totals, idle);
  for (const [method, counts] of Object.entries(idle.methods)) add(methods[method] ??= emptyCounts(), counts);
  const idleHttp = Object.values(idle.http).reduce((sum, counts) => add(sum, counts), emptyCounts());
  const idleMethods = Object.values(idle.methods).reduce((sum, counts) => add(sum, counts), emptyCounts());
  assert.deepEqual(add(idleMethods, idleHttp), unattributed);
  add(http, idleHttp);
  assert.deepEqual(Object.fromEntries(Object.keys(totals).map((key) => [key, summary[key]])), totals);
  assert.deepEqual(summary.methods, methods);
  assert.deepEqual(Object.values(summary.http).reduce((sum, counts) => add(sum, counts), emptyCounts()), http);
  assert.ok(Object.keys(methods).length > 0 && http.requests > 0);
  t.diagnostic("Checked saved live audit receipts and counts; redacted request bodies were not revalidated.");
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

test("waiting for a timed-out retained follow-up preserves its evidence after browser cleanup", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-ui-timeout-"));
  const path = join(root, "browser-operation.mjs"), handle = join(root, "browser.json");
  const directory = `${handle}.d`;
  t.after(async () => {
    try { await cleanupGatewayHandle(handle, { timeoutMs: 5000 }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const failedOutput = {
    flow: "reconnect-and-send",
    steps: [
      { action: "reconnect-existing-page", status: "result", elapsedMs: 1 },
      { action: "send-after-reconnect", status: "error", elapsedMs: 999 },
    ],
    screens: ["synthetic-before-timeout.png"],
    requests: [{ method: "chat.send", status: "unanswered", elapsedMs: 1000 }],
    elapsedMs: 1000,
    createdIds: [],
    sessionKey: "agent:main:fixture",
    url: null,
    handoff: null,
    error: "Control UI timeout",
  };
  await writeFile(path, `
import { atomicJson, serveOperation } from ${JSON.stringify(backgroundUrl)};
import { runRetainedBrowser } from ${JSON.stringify(controlUiUrl)};
import { join } from "node:path";
await serveOperation((options, context) => runRetainedBrowser(options, context, {
  createBrowser: async () => {
    let calls = 0;
    return {
      async run(call, controls) {
        if (++calls === 1) return {
          output: { flow: call.flow, steps: [{ action: "opening", status: "result" }], screens: [], requests: [], createdIds: [], elapsedMs: 0, error: null },
          exitCode: 0,
        };
        await atomicJson(join(context.operation.directory, "followup-entered.json"), { flow: call.flow });
        if (!controls.signal.aborted) await new Promise((resolve) => controls.signal.addEventListener("abort", resolve, { once: true }));
        return { output: ${JSON.stringify(failedOutput)}, exitCode: 3 };
      },
      async close() {
        await atomicJson(join(context.operation.directory, "closed.json"), { calls });
      },
    };
  },
}));
`);
  await startOperation(path, {
    env: "fixture", flow: "open-session-keep-open", handle,
    "session-key": "agent:main:fixture", "artifact-dir": join(root, "opening"),
    timeoutMs: 10000, startupTimeoutMs: 5000,
  }, { entry: "control-ui", method: "control-ui", lifetimeMs: 10000 });
  const requested = requestOperation(handle, {
    env: "fixture", flow: "reconnect-and-send", handle,
    "session-key": "agent:main:fixture", "artifact-dir": join(root, "followup"), timeout: "1000",
  }, { entry: "control-ui", env: "fixture", timeoutMs: 1000 }).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  assert.deepEqual(await awaitJson(join(directory, "followup-entered.json")), { flow: "reconnect-and-send" });
  const receipt = await requested;
  // The caller can reach its own deadline just before the result file appears.
  if (receipt.error) assert.equal(receipt.error.exitCode, 3);
  else assert.equal(receipt.result.exitCode, 3);
  const completed = await joinOperation(handle, { timeoutMs: 5000 });
  assert.equal(completed.exitCode, 3);
  assert.equal(completed.cleanupComplete, true);
  assert.equal(completed.output.flow, failedOutput.flow);
  assert.equal(completed.output.error, failedOutput.error);
  assert.deepEqual(completed.output.steps, failedOutput.steps);
  assert.deepEqual(completed.output.screens, failedOutput.screens);
  assert.deepEqual(completed.output.requests, failedOutput.requests);
  assert.deepEqual(await awaitJson(join(directory, "closed.json")), { calls: 2 });
  assert.deepEqual(await controlUiMain(["--wait", handle, "--timeout", "5000"]), completed);
});

test("retained browser closes when its caller cancels after response publication before acknowledgement", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-ui-response-cancel-"));
  const path = join(root, "browser-operation.mjs"), handle = join(root, "browser.json");
  const directory = `${handle}.d`;
  t.after(async () => {
    try { await cleanupGatewayHandle(handle, { timeoutMs: 5000 }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const followupOutput = {
    flow: "open-by-link",
    steps: [{ action: "open-session", status: "result", elapsedMs: 1 }],
    screens: ["synthetic-followup.png"],
    requests: [{ method: "chat.history", status: "result", elapsedMs: 1 }],
    elapsedMs: 1, createdIds: [], sessionKey: "agent:main:fixture", error: null,
  };
  await writeFile(path, `
import { atomicJson, serveOperation } from ${JSON.stringify(backgroundUrl)};
import { runRetainedBrowser } from ${JSON.stringify(controlUiUrl)};
import { join } from "node:path";
await serveOperation((options, context) => runRetainedBrowser(options, context, {
  createBrowser: async () => {
    let calls = 0;
    return {
      async run(call) {
        if (++calls === 1) return { output: { flow: call.flow, steps: [], screens: [], requests: [], createdIds: [], elapsedMs: 0, error: null }, exitCode: 0 };
        return { output: { ...${JSON.stringify(followupOutput)}, flow: call.flow }, exitCode: 0 };
      },
      async close() {
        await atomicJson(join(context.operation.directory, "closed.json"), { calls, pid: process.pid });
      },
    };
  },
}));
`);
  const started = await startOperation(path, {
    env: "fixture", flow: "open-session-keep-open", handle,
    "session-key": "agent:main:fixture", "artifact-dir": join(root, "opening"),
    timeoutMs: 15000, startupTimeoutMs: 5000,
  }, { entry: "control-ui", method: "control-ui", lifetimeMs: 15000 });
  const controller = new AbortController();
  const cancellation = new CallError("cancel after response publication", 3);
  const callPath = join(directory, "request", "call.json");
  const responsePath = join(directory, "request", "result.json");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let cancelledAfterResponse = false;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value() {
      if (!this.aborted && existsSync(callPath)) {
        // The separate process can publish while this caller stays exactly
        // before its response read; no timer races the acknowledgement.
        const deadline = Date.now() + 5000;
        while (!existsSync(responsePath) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 5);
        assert.ok(existsSync(responsePath), "The retained call must publish its response");
        cancelledAfterResponse = true;
        controller.abort(cancellation);
      }
      return AbortSignal.prototype.throwIfAborted.call(this);
    },
  });
  await assert.rejects(requestOperation(handle, {
    env: "fixture", flow: "open-by-link", handle,
    "session-key": "agent:main:fixture", "artifact-dir": join(root, "followup"), timeout: "10000",
  }, { entry: "control-ui", env: "fixture", timeoutMs: 10000, signal: controller.signal }), (error) => error === cancellation);
  assert.equal(cancelledAfterResponse, true);
  // Join without requesting stop: cancellation must close the browser well
  // before the original 15-second lifetime expires.
  const completed = await joinOperation(handle, { timeoutMs: 3000 });
  assert.equal(completed.exitCode, 3);
  assert.equal(completed.cleanupComplete, true);
  assert.equal(completed.output.flow, followupOutput.flow);
  assert.deepEqual(completed.output.steps, followupOutput.steps);
  assert.deepEqual(completed.output.screens, followupOutput.screens);
  assert.deepEqual(completed.output.requests, followupOutput.requests);
  assert.deepEqual(await awaitJson(join(directory, "closed.json")), { calls: 2, pid: started.ref.pid });
  assert.deepEqual(await controlUiMain(["--wait", handle, "--timeout", "5000"]), completed);
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
    socket.url = () => "ws://127.0.0.1:12345/console/";
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

test("browser completion keeps send receipts when another tab closes unexpectedly", async (t) => {
  const root = await temporary(t), page = new EventEmitter(), context = new EventEmitter(), socket = new EventEmitter();
  socket.url = () => "ws://127.0.0.1:12345/";
  let receiptReturned = false, closedAfterReceipt = false;
  const locator = { first() { return this; }, locator() { return this; }, evaluate: async () => "agent:main:fixture", fill: async () => {}, click: async () => {
    send(socket, "send", "chat.send", { sessionKey: "agent:main:fixture", message: "example" });
    const tab = new EventEmitter(), tabSocket = new EventEmitter();
    tabSocket.url = () => "ws://127.0.0.1:12345/";
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
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, "Gateway connection closed before replying");
  assert.equal(closedAfterReceipt, true);
  assert.deepEqual(result.output.requests.filter(({ method }) => method === "chat.history").map(({ status }) => status), ["error"]);
  assert.deepEqual(result.output.createdIds, ["created-run"]);
  assert.equal(result.output.requests.find(({ method }) => method === "chat.send").status, "result");
});

for (const mode of ["reply", "disconnect", "replace", "page-close", "reply-then-close", "reply-after-same-socket-connect"]) test(`browser send completion classifies ${mode}`, async (t) => {
  const root = await temporary(t), page = new EventEmitter(), context = new EventEmitter(), socket = new EventEmitter();
  socket.url = () => "ws://127.0.0.1:12345/";
  const locator = { first() { return this; }, locator() { return this; }, evaluate: async () => "agent:main:fixture", fill: async () => {}, click: async () => {
    send(socket, "send", "chat.send", { sessionKey: "agent:main:fixture" });
    setTimeout(() => {
      if (mode === "reply-after-same-socket-connect") { send(socket, "connect-again", "connect"); reply(socket, "connect-again", {}); }
      if (mode.startsWith("reply")) reply(socket, "send", { status: "started", runId: "acknowledged-run" });
      if (["disconnect", "reply-then-close"].includes(mode)) socket.emit("close");
      if (mode === "page-close") page.emit("close");
      if (mode === "replace") {
        const replacement = new EventEmitter(); replacement.url = socket.url;
        page.emit("websocket", replacement); send(replacement, "connect", "connect"); reply(replacement, "connect", {});
      }
    }, 30);
  } };
  page.url = () => "http://127.0.0.1:12345/chat";
  page.setDefaultTimeout = page.setDefaultNavigationTimeout = () => {};
  page.locator = () => locator; page.screenshot = async () => Buffer.from("synthetic capture");
  context.grantPermissions = async () => {};
  context.newPage = async () => { context.emit("page", page); page.emit("websocket", socket); send(socket, "connect", "connect"); reply(socket, "connect", {}); return page; };
  let closes = 0;
  const result = await executeControlUi({ env: "fixture", flow: "reconnect-and-send", "session-key": "agent:main:fixture", "artifact-dir": root, timeoutMs: 3000 }, {
    prepare: () => ({ packageRoot: root }), ocm: () => ({ ok: true, browserUrl: "http://127.0.0.1:12345/" }),
    launch: async () => ({ newContext: async () => context, close: async () => { closes++; page.emit("close"); } }),
  });
  const acknowledged = mode.startsWith("reply"), request = result.output.requests.find((request) => request.method === "chat.send");
  assert.equal(result.exitCode, acknowledged ? 0 : 1);
  assert.equal(result.output.error, acknowledged ? null : "Gateway connection closed before replying");
  assert.equal(request.status, acknowledged ? "result" : "error");
  if (!acknowledged) { assert.equal(request.errorCode, null); assert.equal(request.errorReason, "gateway-disconnected"); }
  assert.equal(closes, 1);
  await assertControlUiPrints(result.output);
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

let controlUiPrints;
async function assertControlUiPrints(actual) {
  const expected = await (controlUiPrints ??= readFile(new URL("../catalogue/openclaw.json", import.meta.url), "utf8").then((text) => {
    const entries = JSON.parse(text).entries.filter((entry) => entry.id === "control-ui");
    assert.equal(entries.length, 1);
    const fields = entries[0].prints;
    assert.equal(fields.length, 10, "Control UI declares ten printed fields");
    assert.equal(new Set(fields).size, fields.length);
    return [...fields].sort();
  }));
  assert.ok(actual && typeof actual === "object" && !Array.isArray(actual));
  assert.deepEqual(Object.keys(actual).sort(), expected);
}

// This replaces browser I/O only; the real driver constructs every result.
function outputContractBrowser(root, { failReload = false, onClose = async () => {}, onSocket = () => {} } = {}) {
  const page = new EventEmitter(), context = new EventEmitter();
  let address = "about:blank";
  page.url = () => address;
  page.setDefaultTimeout = page.setDefaultNavigationTimeout = () => {};
  page.locator = () => ({ first() { return this; }, waitFor: async () => {} });
  page.screenshot = async () => Buffer.from("synthetic capture");
  page.goto = async (url) => {
    address = url;
    const socket = new EventEmitter();
    socket.url = () => "ws://127.0.0.1:12345/";
    onSocket(socket, page);
    page.emit("websocket", socket);
    socket.emit("framesent", { payload: JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }) });
    socket.emit("framereceived", { payload: JSON.stringify({ type: "res", id: "connect", ok: true, payload: {} }) });
  };
  page.reload = async () => {
    if (failReload) throw new Error("Synthetic browser reload failure");
    await page.goto(address);
  };
  context.grantPermissions = async () => {};
  context.newPage = async () => { context.emit("page", page); return page; };
  return {
    prepare: () => ({ packageRoot: root }),
    ocm: () => ({ ok: true, browserUrl: "http://127.0.0.1:12345/" }),
    launch: async () => ({ newContext: async () => context, close: async () => { page.emit("close"); await onClose(); } }),
  };
}

for (const failReload of [false, true]) test(`browser ${failReload ? "failure" : "success"} joins asynchronous request validation`, async (t) => {
  const root = await temporary(t);
  const result = await executeControlUi({ env: "fixture", flow: "open-by-link", "session-key": "agent:main:fixture", "artifact-dir": root, timeoutMs: 5000 }, {
    ...outputContractBrowser(root, { failReload }),
    onRequest: async (_method, _params, { record }) => {
      await sleep(40);
      record.validation = { status: "valid", kind: "handler", source: "synthetic-request-check", errors: [] };
    },
  });
  assert.equal(result.exitCode, failReload ? 1 : 0);
  assert.ok(result.output.requests.length > 0);
  for (const request of result.output.requests) assert.equal(request.validation?.status, "valid");
});

for (const status of ["invalid", "unmapped", "pending", "rejected", "reply-pending", "delayed-reply"]) test(`browser completion drains late requests: ${status}`, { timeout: 10000 }, async (t) => {
  const root = await temporary(t), firstAudit = deferred(), secondAudit = deferred();
  const timeoutMs = ["pending", "reply-pending"].includes(status) ? 1200 : 5000;
  let socket, scheduled = false, requests = 0, closes = 0;
  const running = executeControlUi({ env: "fixture", flow: "open-session-keep-open", "session-key": "agent:main:fixture", "artifact-dir": root, timeoutMs }, {
    ...outputContractBrowser(root, {
      onSocket: (value) => { socket = value; },
      onClose: async () => { closes++; },
    }),
    onRequest: (method, _params, { record }) => {
      requests++;
      if (method === "connect") {
        let recordedStatus = record.status;
        // Screenshot completion still has file I/O pending. Schedule from the
        // terminal response check to enter after the first audit snapshot,
        // preserving the recorder's normal writable status property.
        Object.defineProperty(record, "status", {
          enumerable: true, configurable: true,
          get() {
            if (recordedStatus === "result" && !scheduled) {
              scheduled = true;
              queueMicrotask(() => {
                send(socket, "late-read", "chat.history", { sessionKey: "agent:main:fixture" });
                if (!["rejected", "reply-pending", "delayed-reply"].includes(status)) reply(socket, "late-read", {});
                firstAudit.resolve();
                if (status !== "pending") void nextTurn().then(() => secondAudit.resolve());
                if (["rejected", "delayed-reply"].includes(status)) void secondAudit.promise.then(nextTurn).then(() => {
                  reply(socket, "late-read", status === "rejected" ? { code: "FORBIDDEN" } : {}, status !== "rejected");
                });
              });
            }
            return recordedStatus;
          },
          set(value) { recordedStatus = value; },
        });
        return firstAudit.promise.then(() => {
          record.validation = { status: "valid", kind: "handler", source: "synthetic-request-check", errors: [] };
        });
      }
      assert.equal(method, "chat.history");
      return secondAudit.promise.then(() => {
        record.validation = !["invalid", "unmapped"].includes(status)
          ? { status: "valid", kind: "schema", source: "synthetic-request-check", errors: [] }
          : { status, kind: "schema", source: "synthetic-request-check", errors: [{ path: "$", code: "synthetic-validation-failure" }] };
      });
    },
  });
  try {
    const result = await running;
    assert.equal(scheduled, true);
    assert.equal(requests, 2);
    assert.equal(result.output.requests.length, 2);
    assert.equal(closes, 1);
    if (!["rejected", "reply-pending"].includes(status)) assert.ok(result.output.requests.every((request) => request.status === "result"));
    assert.equal(result.output.requests.find((request) => request.method === "connect").validation.status, "valid");
    const second = result.output.requests.find((request) => request.method === "chat.history");
    if (status === "pending") {
      assert.equal(result.exitCode, 3);
      assert.equal(result.output.error, "Control UI timeout");
      assert.deepEqual(second.validation, { status: "invalid", code: "OBSERVER_INCOMPLETE" });
      const returned = structuredClone(result);
      secondAudit.resolve();
      await nextTurn();
      assert.deepEqual(result, returned);
      assert.equal(closes, 1);
    } else if (["rejected", "reply-pending", "delayed-reply"].includes(status)) {
      assert.equal(result.exitCode, status === "rejected" ? 1 : status === "reply-pending" ? 3 : 0);
      assert.equal(result.output.error, status === "rejected" ? "Gateway returned an error" : status === "reply-pending" ? "Control UI timeout" : null);
      assert.equal(second.status, status === "rejected" ? "error" : status === "reply-pending" ? "closed" : "result");
      assert.equal(second.validation.status, "valid");
    } else {
      assert.equal(result.exitCode, 1);
      assert.equal(result.output.error, "Control UI request validation failed");
      assert.equal(second.validation.status, status);
    }
  } finally {
    firstAudit.resolve();
    secondAudit.resolve();
  }
});

test("completed plain request observers do not require schema receipts", async (t) => {
  const root = await temporary(t);
  for (const asynchronous of [false, true]) {
    const observed = [];
    const result = await executeControlUi({ env: "fixture", flow: "open-by-link", "session-key": "agent:main:fixture", "artifact-dir": join(root, String(asynchronous)), timeoutMs: 5000 }, {
      ...outputContractBrowser(root),
      onRequest: asynchronous
        ? async (method) => { await nextTurn(); observed.push(method); }
        : (method) => { observed.push(method); },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(observed, result.output.requests.map(({ method }) => method));
    assert.ok(observed.length > 0);
    for (const request of result.output.requests) assert.equal(Object.hasOwn(request, "validation"), false);
  }
});

test("browser abort records unfinished audits without permitting late result changes", { timeout: 10000 }, async (t) => {
  const root = await temporary(t), entered = deferred(), release = deferred(), controller = new AbortController();
  const running = executeControlUi({ env: "fixture", flow: "open-by-link", "session-key": "agent:main:fixture", "artifact-dir": root, timeoutMs: 5000 }, {
    ...outputContractBrowser(root), signal: controller.signal,
    onRequest: async (_method, _params, { record }) => {
      entered.resolve();
      await release.promise;
      record.validation = { status: "valid", kind: "handler", source: "synthetic-request-check", errors: [] };
    },
  });
  try {
    await entered.promise;
    controller.abort(new CallError("cancel pending request audit", 3));
    const result = await running;
    assert.equal(result.exitCode, 3);
    assert.ok(result.output.requests.length > 0);
    for (const request of result.output.requests) {
      assert.deepEqual(request.validation, { status: "invalid", code: "OBSERVER_INCOMPLETE" });
    }
    const returned = structuredClone(result);
    release.resolve();
    await nextTurn();
    assert.deepEqual(result, returned);
  } finally { release.resolve(); }
});

test("foreground Control UI success and failure print exactly the catalogue fields", async (t) => {
  const root = await temporary(t);
  for (const failReload of [false, true]) {
    const result = await controlUiMain([
      "--env", "fixture", "--flow", "open-by-link", "--session-key", "agent:main:fixture",
      "--artifact-dir", join(root, failReload ? "failure" : "success"), "--timeout", "5000",
    ], outputContractBrowser(root, { failReload }));
    assert.equal(result.exitCode, failReload ? 1 : 0);
    assert.equal(result.output.steps.some((step) => step.status === "error"), failReload);
    await assertControlUiPrints(result.output);
  }
  const malformed = await invoke(["--unknown", "value"]);
  assert.equal(malformed.code, 2);
  await assertControlUiPrints(JSON.parse(malformed.stdout));
});

for (const failReload of [false, true]) test(`joined Control UI ${failReload ? "failure" : "success"} prints exactly the catalogue fields`, { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-ui-output-"));
  const path = join(root, "browser-operation.mjs"), handle = join(root, "browser.json");
  t.after(async () => {
    try { await cleanupGatewayHandle(handle, { timeoutMs: 5000 }); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await writeFile(path, `
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { atomicJson, serveOperation } from ${JSON.stringify(backgroundUrl)};
import { createControlUiBrowser, runRetainedBrowser } from ${JSON.stringify(controlUiUrl)};
${outputContractBrowser.toString()}
await serveOperation((options, context) => runRetainedBrowser(options, context, {
  createBrowser: (call, controls) => createControlUiBrowser(call, {
    ...controls,
    ...outputContractBrowser(options["artifact-dir"], {
      failReload: options.failReload,
      onClose: () => atomicJson(join(context.operation.directory, "closed.json"), { closed: true }),
    }),
  }),
}));
`);
  await startOperation(path, {
    env: "fixture", flow: "open-session-keep-open", handle, failReload,
    "session-key": "agent:main:fixture", "artifact-dir": join(root, "opening"),
    timeoutMs: 15000, startupTimeoutMs: 5000,
  }, { entry: "control-ui", method: "control-ui", lifetimeMs: 15000 });
  const followup = await requestOperation(handle, {
    env: "fixture", flow: "open-by-link", handle,
    "session-key": "agent:main:fixture", "artifact-dir": join(root, "followup"), timeout: "5000",
  }, { entry: "control-ui", env: "fixture", timeoutMs: 5000 });
  assert.equal(followup.exitCode, failReload ? 1 : 0);
  await assertControlUiPrints(followup.output);
  const joined = await invoke(["--wait", handle, "--timeout", "5000"]);
  assert.equal(joined.code, failReload ? 1 : 0);
  const printed = JSON.parse(joined.stdout);
  await assertControlUiPrints(printed);
  assert.deepEqual(printed, followup.output);
  assert.deepEqual(await awaitJson(join(`${handle}.d`, "closed.json")), { closed: true });
});

for (const failSwitch of [false, true]) test(`retained browser rejects its original environment after ${failSwitch ? "failed" : "successful"} Gateway switching`, { timeout: 10000 }, async (t) => {
  const root = await temporary(t), page = new EventEmitter(), context = new EventEmitter();
  const actions = [], pairedEnvironments = [], auditedOrigins = [];
  let address = "about:blank", closeCount = 0;
  const locator = {
    first() { return this; },
    locator() { return this; },
    getByRole() { return this; },
    waitFor: async () => { actions.push("wait-for-control"); },
    isVisible: async () => true,
    click: async () => { actions.push("click"); },
  };
  page.url = () => address;
  page.setDefaultTimeout = page.setDefaultNavigationTimeout = () => {};
  page.locator = page.getByRole = () => locator;
  page.keyboard = { press: async (key) => { actions.push(`key:${key}`); } };
  page.screenshot = async () => { actions.push("screenshot"); return Buffer.from("synthetic capture"); };
  page.goto = async (url) => {
    actions.push(`navigate:${url}`);
    address = url;
    const request = httpRequest(url, { resourceType: "document" });
    context.emit("request", request);
    if (failSwitch && new URL(url).port === "13002") {
      context.emit("requestfailed", request);
      throw new Error("Second Gateway navigation failed");
    }
    context.emit("response", { request: () => request, status: () => 200 });
    context.emit("requestfinished", request);
    const socket = new EventEmitter();
    socket.url = () => `${new URL(url).origin.replace(/^http/, "ws")}/`;
    page.emit("websocket", socket);
    send(socket, "connect", "connect");
    reply(socket, "connect", {});
  };
  context.grantPermissions = async () => {};
  context.newPage = async () => { context.emit("page", page); return page; };
  const options = {
    env: "gateway-a", flow: "delete-then-switch-gateway", "gateway-env": "gateway-b",
    "session-key": "agent:main:same-key", "artifact-dir": join(root, "switch"), timeoutMs: 5000,
  };
  const session = await createControlUiBrowser(options, {
    prepare: () => ({ packageRoot: root }),
    ocm: ([environment]) => {
      pairedEnvironments.push(environment);
      assert.ok(["@gateway-a", "@gateway-b"].includes(environment));
      return { ok: true, browserUrl: `http://127.0.0.1:${environment === "@gateway-a" ? "13001" : "13002"}/` };
    },
    onHttpRequest: (_request, { gatewayOrigin, flow, record }) => {
      auditedOrigins.push(gatewayOrigin);
      assert.equal(flow, "delete-then-switch-gateway");
      record.validation = { status: "valid", kind: "handler", source: "synthetic-http-check", errors: [] };
    },
    launch: async () => ({ newContext: async () => context, close: async () => { closeCount++; } }),
  });
  try {
    const switched = await session.run(options);
    assert.equal(switched.exitCode, failSwitch ? 1 : 0);
    assert.deepEqual(pairedEnvironments, ["@gateway-a", "@gateway-b"]);
    assert.deepEqual([...new Set(auditedOrigins)], ["http://127.0.0.1:13001", "http://127.0.0.1:13002"]);
    assert.ok(switched.output.requests.filter((request) => request.transport === "http").every((request) => request.origin === "gateway" && request.validation.status === "valid"));
    assert.equal(new URL(address).port, "13002");
    assert.equal(closeCount, 0);
    const beforeReuse = [...actions];
    await assert.rejects(session.run({
      ...options, flow: "open-by-link", "artifact-dir": join(root, "reuse"),
    }), (error) => error instanceof CallError && error.exitCode === 2 && /--wait/.test(error.message));
    assert.deepEqual(actions, beforeReuse);
    assert.deepEqual(pairedEnvironments, ["@gateway-a", "@gateway-b"]);
  } finally { await session.close(); }
  assert.equal(closeCount, 1);
});


test("Gateway observation requires the selected WebSocket endpoint", () => {
  for (const url of ["wss://external.invalid/service", "ws://127.0.0.1:12346/", "ws://127.0.0.1:12345/plugin", "https://127.0.0.1:12345/", "invalid"]) {
    const socket = new EventEmitter(), report = output("open-by-link");
    socket.url = () => url;
    let callbacks = 0;
    observeSelectedSocket(socket, report, {
      gatewayEndpoints: new Set(["http://127.0.0.1:12345"]),
      onRequest: () => callbacks++, connecting: () => callbacks++, connected: () => callbacks++, disconnected: () => callbacks++,
    });
    send(socket, "connect", "connect"); reply(socket, "connect", {});
    send(socket, "auth", "authenticate", { key: "SYNTHETIC_CREDENTIAL" });
    socket.emit("close");
    assert.deepEqual(report.requests, [], url);
    assert.equal(callbacks, 0, url);
  }
  const socket = new EventEmitter(), report = output("open-by-link");
  socket.url = () => "ws://127.0.0.1:12345/";
  observeSelectedSocket(socket, report);
  send(socket, "auth", "authenticate", { key: "SYNTHETIC_CREDENTIAL" });
  assert.deepEqual(report.requests, [], "an undeclared endpoint is refused");
  for (const [selected, url] of [["http://127.0.0.1:12345", "ws://127.0.0.1:12345/"], ["https://gateway.invalid/console", "wss://gateway.invalid/console/"]]) {
    const selectedSocket = new EventEmitter(), selectedReport = output("open-by-link");
    selectedSocket.url = () => url;
    observeSelectedSocket(selectedSocket, selectedReport, { gatewayEndpoints: new Set([selected]) });
    send(selectedSocket, "describe", "sessions.describe", { key: "agent:main:fixture" });
    reply(selectedSocket, "describe", {});
    assert.equal(selectedReport.requests[0].params.key, "agent:main:fixture");
    assert.equal(selectedReport.requests[0].status, "result");
  }
});

test("browser observation ignores foreign sockets without replacing its Gateway connection", async (t) => {
  const root = await temporary(t);
  let audits = 0;
  const result = await executeControlUi({ env: "fixture", flow: "open-by-link", "session-key": "agent:main:fixture", "artifact-dir": root, timeoutMs: 3000 }, {
    ...outputContractBrowser(root, { onSocket(_socket, page) {
      for (const url of ["wss://external.invalid/service", "ws://127.0.0.1:12345/plugin"]) {
        const foreign = new EventEmitter(); foreign.url = () => url;
        page.emit("websocket", foreign);
        send(foreign, "connect", "connect"); reply(foreign, "connect", {});
        send(foreign, "auth", "authenticate", { key: "SYNTHETIC_CREDENTIAL" });
      }
    } }),
    onRequest() { audits++; },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(audits > 0, "the selected Gateway is still observed");
  assert.ok(result.output.requests.every((request) => request.method === "connect"));
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_CREDENTIAL|authenticate/);
});

function incognitoDiscoveryBrowser(root, {
  error = { code: "FORBIDDEN", message: "This operation requires a canonical, non-incognito sessionKey and its matching agentId.", details: { code: "SESSION_ACCESS_CHANGED" } },
  method = "mcp.app.discover", discoveryKey = "agent:main:dashboard:incognito-created", agentId = "main", failCreation = false,
} = {}) {
  const key = "agent:main:dashboard:incognito-created";
  return outputContractBrowser(root, { onSocket(socket, page) {
    const discover = (id) => {
      send(socket, `discover-${id}`, method, { sessionKey: discoveryKey, agentId });
      reply(socket, `discover-${id}`, error, false);
    };
    page.getByRole = () => ({ click: async () => discover("before-create") });
    page.locator = (selector) => ({
      first() { return this; }, waitFor: async () => {}, fill: async () => {},
      click: async () => {
        assert.equal(selector, ".new-session-page__start-submit");
        send(socket, "create", "sessions.create", { agentId: "main", incognito: true });
        reply(socket, "create", failCreation ? { code: "FORBIDDEN" } : { key, sessionId: "created-id" }, !failCreation);
        discover("after-create"); discover("after-navigation");
      },
    });
    page.waitForURL = async () => { page.url = () => `http://127.0.0.1:12345/chat/${key}`; };
  } });
}

for (const [name, setup, flow, invalidAudit, expected] of [
  ["known incognito refusal", {}, "new-session-incognito", false, 0],
  ["missing write scope", { error: { code: "FORBIDDEN", message: "missing scope: operator.write" } }, "new-session-incognito", false, 1],
  ["revoked access", { error: { code: "FORBIDDEN", message: "Session access changed; reopen the session before continuing.", details: { code: "SESSION_ACCESS_CHANGED" } } }, "new-session-incognito", false, 1],
  ["unavailable discovery", { error: { code: "UNAVAILABLE", message: "Discovery unavailable" } }, "new-session-incognito", false, 1],
  ["ordinary session discovery", { discoveryKey: "agent:main:ordinary" }, "new-session-incognito", false, 1],
  ["another incognito session", { discoveryKey: "agent:main:dashboard:incognito-other" }, "new-session-incognito", false, 1],
  ["mismatched discovery agent", { agentId: "other" }, "new-session-incognito", false, 1],
  ["another MCP operation", { method: "mcp.app.launch" }, "new-session-incognito", false, 1],
  ["ordinary creation flow", {}, "new-session-page", false, 1],
  ["failed session creation", { failCreation: true }, "new-session-incognito", false, 1],
  ["invalid discovery request", {}, "new-session-incognito", true, 1],
]) test(`incognito creation classifies ${name}`, async (t) => {
  const root = await temporary(t);
  const result = await controlUiMain(["--env", "fixture", "--flow", flow, "--artifact-dir", root, "--timeout", "3000", "--out", join(root, "result.json")], {
    ...incognitoDiscoveryBrowser(root, setup),
    onRequest(method, _params, { record }) {
      record.validation = { status: invalidAudit && method === "mcp.app.discover" ? "invalid" : "valid" };
    },
  });
  assert.equal(result.exitCode, expected);
  await assertControlUiPrints(result.output);
  const saved = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
  assert.deepEqual(saved, result.output);
  if (expected === 0) {
    assert.equal(saved.error, null);
    assert.equal(await resolveControlUiSession({ "session-from": join(root, "result.json") }), saved.sessionKey);
    assert.equal(saved.sessionKey, "agent:main:dashboard:incognito-created");
    const errors = saved.requests.filter((request) => request.status === "error");
    assert.equal(errors.length, 3);
    assert.ok(errors.every((request) => request.errorCode === "FORBIDDEN" && request.errorReason === "incognito-session"));
    assert.ok(saved.steps.every((step) => step.status === "result"));
  } else assert.ok(saved.error);
});
