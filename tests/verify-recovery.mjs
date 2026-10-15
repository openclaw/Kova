import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import JSON5 from "json5";
import { atomicJson, CallError } from "../support/verify/background.mjs";
import { requestGatewayFixture } from "../support/verify/gateway-fixture-client.mjs";
import { runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";
import { definition, finishRecoveryRequest, prepareRecoveryRequest, recoverySource, runRecoveryRequest } from "../support/verify/restart-for-recovery.mjs";
import { parseScriptArgs, scriptMain } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const fields = ["sessionKey", "sessionId", "restartRecoveryStatus", "createdIds", "elapsedMs", "error"].sort();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, ".openclaw/openclaw.json");
  const config = {
    agents: { defaults: { model: { primary: "openai/gpt-5.5" } }, entries: { main: { modelPolicy: { allow: ["openai/*"] } } } },
    models: { providers: { openai: {
      api: "openai-responses", baseUrl: "http://127.0.0.1:12345/v1",
      models: [{ id: "gpt-5.5", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    } } }
  };
  const original = Buffer.from(`// Keep this formatting and comment.\n${JSON.stringify(config, null, 2)}\n`);
  await mkdir(join(root, ".openclaw"));
  await writeFile(configPath, original);
  await chmod(configPath, 0o640);
  const env = "kova-helpers-recovery";
  const source = { key: `agent:main:dashboard:${randomUUID()}`, sessionId: randomUUID(), agentId: "main" };
  const record = { method: "sessions.create", result: { ok: true, key: source.key, sessionId: source.sessionId, runStarted: false }, createdIds: [source.key, source.sessionId], error: null };
  const sourcePath = join(root, "source.json"), handlePath = join(root, "gateway.json"), outputPath = join(root, "result.json");
  await atomicJson(sourcePath, record);
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), env, entry: "foreground-gateway-start", method: "gateway.start", handlePath, directory: `${handlePath}.d`, expiresAt: new Date(Date.now() + 60000).toISOString() };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  const controller = new AbortController();
  const context = { signal: controller.signal, operation };
  const request = { id: randomUUID(), options: { env, source }, expiresAt: Date.now() + 3000 };
  const runtime = { root, configPath, gatewayPort: 19999 };
  const row = { ...source, modelProvider: "openai", model: "gpt-5.5", archived: false };
  const args = ["--env", env, "--gateway-handle", handlePath, "--session-from", sourcePath, "--out", outputPath, "--timeout", "3000"];
  return { root, runtime, config, original, source, record, sourcePath, handlePath, outputPath, operation, controller, context, request, row, args };
}

function peer(data, { describe = () => data.row, history, stream = true, onSend } = {}) {
  const calls = [];
  const connect = async () => {
    const ws = new EventTarget();
    return { client: {
      ws, close() {},
      async request(method, params) {
        schemas.check(method, params);
        calls.push({ method, params });
        if (method === "config.get") return { path: data.runtime.configPath };
        if (method === "sessions.describe") return { session: await describe() };
        if (method === "chat.history") return history ?? { sessionId: data.source.sessionId, messages: [], hasMore: false };
        if (method === "sessions.messages.subscribe") return { ok: true };
        if (method === "chat.send") {
          onSend?.();
          if (stream) queueMicrotask(() => ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
            type: "event", event: "chat", payload: {
              runId: params.idempotencyKey, sessionKey: params.sessionKey, state: "delta",
              message: { role: "assistant", content: [{ type: "text", text: "**KOVA_VERIFY_HOLD**" }] }
            }
          }) })));
          return { runId: params.idempotencyKey, status: "started" };
        }
        throw new Error(`unexpected request: ${method}`);
      }
    } };
  };
  return { connect, calls };
}

test("recovery accepts only a newly generated source and complete standalone flags", async (t) => {
  const data = await fixture(t);
  assert.deepEqual(recoverySource(data.record), data.source);
  assert.equal(parseScriptArgs(definition, data.args).timeoutMs, 3000);
  const runArgs = [...data.args];
  runArgs[1] = "kova-run-recovery";
  assert.equal(parseScriptArgs(definition, runArgs).env, "kova-run-recovery");
  for (const name of ["violet", "kova-ui-example", "kova-run-../unsafe"]) {
    const args = [...data.args]; args[1] = name;
    const result = await scriptMain(definition, args);
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.sessionKey, null);
  }
  for (const flag of ["--gateway-handle", "--session-from", "--out", "--timeout"]) {
    const args = [...data.args], index = args.indexOf(flag);
    args.splice(index, 2);
    assert.throws(() => parseScriptArgs(definition, args), CallError);
  }
  for (const patch of [{ method: "sessions.describe" }, { error: "failed" }, { createdIds: [] }, { result: { ...data.record.result, runStarted: true } }, { result: { ...data.record.result, key: "agent:main:main" } }, { result: { ...data.record.result, sessionKey: "another" } }]) assert.throws(() => recoverySource({ ...data.record, ...patch }), CallError);
  const refusal = await scriptMain(definition, data.args, { context: { requestRecovery: async () => ({ exitCode: 3, output: { sessionKey: data.source.key, error: "expired", createdIds: ["observed-run"] } }) } });
  assert.equal(refusal.exitCode, 3);
  assert.deepEqual(Object.keys(refusal.output).sort(), fields);
  assert.equal(refusal.output.sessionKey, null);
  assert.equal(refusal.output.sessionId, null);
  assert.equal(refusal.output.restartRecoveryStatus, null);
  assert.deepEqual(refusal.output.createdIds, ["observed-run"]);
});

test("held recovery preparation rejects stale, used, linked and non-mock sources before sending", async (t) => {
  const data = await fixture(t);
  for (const patch of [{ sessionId: "replacement" }, { archived: true }, { parentSessionKey: "parent" }, { modelSelectionLocked: true }, { restartRecoveryStatus: "tombstoned" }, { lastRunId: "prior" }]) {
    const server = peer(data, { describe: () => ({ ...data.row, ...patch }) });
    await assert.rejects(prepareRecoveryRequest(data.request, data.runtime, data.context, server));
    assert.equal(server.calls.some(({ method }) => method === "chat.send"), false);
  }
  const nonempty = peer(data, { history: { sessionId: data.source.sessionId, messages: [{ role: "user", content: "old" }] } });
  await assert.rejects(prepareRecoveryRequest(data.request, data.runtime, data.context, nonempty), /empty history/);
  data.config.models.providers.openai.baseUrl = "https://api.example.com/v1";
  await writeFile(data.runtime.configPath, JSON.stringify(data.config));
  await assert.rejects(prepareRecoveryRequest(data.request, data.runtime, data.context, peer(data)), /loopback mock/);
  await rm(data.runtime.configPath);
  const external = join(data.root, "external.json");
  await writeFile(external, data.original);
  await symlink(external, data.runtime.configPath);
  await assert.rejects(prepareRecoveryRequest(data.request, data.runtime, data.context, peer(data)), /links/);
});

test("native recovery observation restores exact configuration before publishing the source", async (t) => {
  const data = await fixture(t);
  const server = peer(data);
  const prepared = await prepareRecoveryRequest(data.request, data.runtime, data.context, server);
  assert.deepEqual(await readFile(data.runtime.configPath), data.original);
  assert.deepEqual(prepared.createdIds, [server.calls.find(({ method }) => method === "chat.send").params.idempotencyKey]);
  const deniedPeer = peer(data, { describe: () => ({ ...data.row, restartRecoveryStatus: "tombstoned" }) });
  const result = await runRecoveryRequest(data.request, prepared, data.runtime, data.context, async (signal, observe) => {
    const denied = JSON5.parse(await readFile(data.runtime.configPath, "utf8"));
    assert.match(denied.agents.entries.main.modelPolicy.allow[0], /^kova-recovery-[a-f0-9-]+\/\*$/);
    assert.deepEqual(denied.models, data.config.models);
    assert.deepEqual(denied.agents.defaults, data.config.agents.defaults);
    await observe();
    assert.equal(signal.aborted, true);
    return { output: { error: "stopped" }, exitCode: 1, cleanupComplete: true };
  }, deniedPeer);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.sessionKey, null);
  assert.equal(result.restart, true);
  assert.deepEqual(await readFile(data.runtime.configPath), data.original);
  assert.equal((await lstat(data.runtime.configPath)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(join(data.root, ".openclaw")), ["openclaw.json"]);
  const completed = await finishRecoveryRequest(data.request, result, data.runtime, data.context, deniedPeer);
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.output.sessionKey, data.source.key);
  assert.deepEqual(Object.keys(completed.output).sort(), fields);
  const recoveredPeer = peer(data, { describe: () => ({ ...data.row, archived: true, restartRecoveryStatus: "tombstoned" }) });
  assert.equal((await finishRecoveryRequest(data.request, result, data.runtime, data.context, recoveredPeer)).output.sessionKey, null);
});

test("failed startup, timeout and owner interruption restore configuration without publishing identities", async (t) => {
  for (const fault of ["startup", "timeout", "interruption"]) {
    const data = await fixture(t);
    const prepared = await prepareRecoveryRequest(data.request, data.runtime, data.context, peer(data));
    if (fault === "timeout") data.request.expiresAt = Date.now() + 25;
    const result = await runRecoveryRequest(data.request, prepared, data.runtime, data.context, async (signal, observe) => {
      if (fault === "startup") return { output: { error: "startup failed" }, exitCode: 1 };
      if (fault === "interruption") data.controller.abort(new Error("owner interrupted"));
      await observe();
      assert.equal(signal.aborted, true);
      return { output: { error: "stopped" }, exitCode: 1, cleanupComplete: true };
    }, peer(data));
    assert.equal(result.exitCode, fault === "timeout" ? 3 : 1);
    assert.equal(result.output.sessionKey, null);
    assert.equal(result.output.sessionId, null);
    assert.deepEqual(await readFile(data.runtime.configPath), data.original);
    assert.equal(result.restart, true);
  }
});

test("failed restoration retains the private backup and prevents another startup", async (t) => {
  const data = await fixture(t);
  const prepared = await prepareRecoveryRequest(data.request, data.runtime, data.context, peer(data));
  const unrelated = join(data.root, "unrelated.json");
  await writeFile(unrelated, "unrelated");
  const result = await runRecoveryRequest(data.request, prepared, data.runtime, data.context, async () => {
    await rm(data.runtime.configPath);
    await symlink(unrelated, data.runtime.configPath);
    return { output: { error: "startup failed" }, exitCode: 1 };
  }, peer(data));
  assert.equal(result.restart, false);
  assert.equal(result.output.sessionKey, null);
  assert.match(result.output.error, /restoration failed/);
  assert.deepEqual(await readFile(join(data.root, ".openclaw", `.kova-recovery-${data.request.id}.backup`)), data.original);
  assert.equal(await readFile(unrelated, "utf8"), "unrelated");
});

for (const mode of ["complete", "cancel-denied", "cancel-held"]) test(`foreground owner restores and starts the original configuration: ${mode}`, async (t) => {
  const data = await fixture(t);
  const cancel = mode !== "complete";
  const caller = new AbortController();
  const launches = [], stops = [];
  let tombstoned = false;
  const server = peer(data, { stream: mode !== "cancel-held", onSend: () => {
    if (mode === "cancel-held") caller.abort(new Error("caller cancelled"));
  }, describe: () => {
    const config = JSON5.parse(readFileSync(data.runtime.configPath, "utf8"));
    const denied = config.agents.entries.main.modelPolicy.allow[0].startsWith("kova-recovery-");
    if (denied && !cancel) tombstoned = true;
    return { ...data.row, ...(tombstoned ? { restartRecoveryStatus: "tombstoned" } : {}) };
  } });
  let publishStarted;
  const started = new Promise((accept) => { publishStarted = accept; });
  const running = runForegroundGateway({ env: data.request.options.env, timeoutMs: 3000 }, {
    ...data.context,
    async publish(ref) {
      await atomicJson(data.handlePath, { entry: data.operation.entry, env: data.operation.env, ref: { ...ref, id: data.operation.id, directory: data.operation.directory } });
      publishStarted();
    }
  }, {
    ...server, prepare: () => data.runtime, requireUnusedPort: async () => {},
    fetch: async () => ({ ok: true, body: { cancel: async () => {} } }),
    invocation: () => ({ file: "owned-gateway", args: [], env: {} }),
    spawn() {
      launches.push(readFileSync(data.runtime.configPath));
      const pid = launches.length;
      let finish;
      const closed = new Promise((accept) => { finish = accept; });
      const child = { pid, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null };
      if (pid === 2 && mode === "cancel-denied") caller.abort(new Error("caller cancelled"));
      return { child, closed, async stop() { stops.push(pid); child.exitCode = 0; child.stdout.end(); child.stderr.end(); finish({ status: 0 }); } };
    }
  });
  t.after(async () => { data.controller.abort(new CallError("background operation stopped", 1)); await running; });
  await started;
  const result = await scriptMain(definition, data.args, { signal: caller.signal });
  assert.equal(result.exitCode, cancel ? 1 : 0);
  assert.equal(result.output.sessionKey, cancel ? null : data.source.key);
  assert.equal(launches.length, mode === "cancel-held" ? 2 : 3);
  assert.deepEqual(launches[0], data.original);
  if (mode !== "cancel-held") assert.notDeepEqual(launches[1], data.original);
  assert.deepEqual(launches.at(-1), data.original);
  assert.deepEqual(stops, mode === "cancel-held" ? [1] : [1, 2]);
  assert.deepEqual(await readFile(data.runtime.configPath), data.original);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(data.outputPath, "utf8"))).sort(), fields);
  assert.equal(server.calls.filter(({ method }) => method === "chat.send").length, 1);
  data.controller.abort(new CallError("background operation stopped", 1));
  assert.equal((await running).exitCode, 0);
  assert.deepEqual(stops, mode === "cancel-held" ? [1, 2] : [1, 2, 3]);
});

test("recovery request fixtures match the pinned Gateway schemas", (t) => schemas.report(t));


test("cancelled recovery returns observed operation IDs only after owner completion", async (t) => {
  const data = await fixture(t);
  await atomicJson(data.handlePath, { entry: data.operation.entry, env: data.operation.env, ref: { directory: data.operation.directory, id: data.operation.id } });
  const cancelled = new AbortController();
  const owner = (async () => {
    let request;
    for (;;) {
      try { request = JSON.parse(await readFile(join(data.operation.directory, "fixture-request.json"), "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((r) => setTimeout(r, 5));
    }
    cancelled.abort(new CallError("cancelled", 3));
    for (;;) {
      try { await lstat(join(data.operation.directory, `fixture-cancel-${request.id}.json`)); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((r) => setTimeout(r, 5));
    }
    await atomicJson(join(data.operation.directory, `fixture-result-${request.id}.json`), {
      output: { sessionKey: null, sessionId: null, restartRecoveryStatus: null, createdIds: ["submitted-run"], elapsedMs: 10, error: "cancelled" }, exitCode: 3
    });
  })();
  const result = await scriptMain(definition, data.args, { context: {
    requestRecovery: (options) => requestGatewayFixture(options, { signal: cancelled.signal })
  } });
  await owner;
  assert.equal(result.exitCode, 3);
  assert.deepEqual(Object.keys(result.output).sort(), fields);
  assert.deepEqual(result.output.createdIds, ["submitted-run"]);
  assert.equal(result.output.sessionKey, null);
});
