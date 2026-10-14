import assert from "node:assert/strict";
import { test } from "node:test";
import { access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { sessionRequests, makeSession, readSessionKeys, sendSessionMessage } from "../support/persona/session-content.mjs";
import { extraRequests } from "../support/persona/session-extras.mjs";
import { workspaceRequests, workspaceSetRequest } from "../support/persona/workspace-content.mjs";
import { environmentRequests, environmentRequestCases } from "../support/persona/environment-content.mjs";
import { collectionRequests, collectionRequestCases } from "../support/persona/session-collections.mjs";
import { channelRequests, channelRequestCases, probeRequestSchemas } from "../support/persona/channel-content.mjs";
import { profileRequests } from "../support/persona/profile-content.mjs";

const revision = "7e80556f503d26ddde64e274bfb50cbbec7830f5";
const key = "agent:main:persona-schema";
const sessionId = "persona-schema-session";
const runId = "persona-schema-run";

const sessionCases = {
  create: [[key], [undefined, "kova-schema-label"], [key, undefined, "/tmp/persona-repository"], [undefined, "kova-schema-worktree", "/tmp/persona-repository"]],
  resolveLabel: [["kova-schema-label"]],
  resolveShort: [["12345678"]],
  describe: [[key]],
  send: [[key, "Notebook entry.", "persona-schema-idempotency"]],
  wait: [[runId]],
  history: [[key], [key, 0], [key, 100]],
  message: [[key, "12345678"]],
  patchModel: [[key, "openai/mock-tools"], [key, "openai/mock-overflow"]],
  compact: [[key]],
  reset: [[key]],
};

test("persona Gateway requests match the pinned OpenClaw schemas", async (t) => {
  const checkout = process.env.KOVA_OPENCLAW_CHECKOUT;
  if (!checkout) return t.skip("Set KOVA_OPENCLAW_CHECKOUT to the pinned OpenClaw checkout");
  try { await access(checkout); } catch (error) {
    if (error.code === "ENOENT") return t.skip("OpenClaw checkout is absent");
    throw error;
  }
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), revision);
  const packagePath = join(resolve(checkout), "package.json");
  const require = createRequire(packagePath);
  const { createJiti } = require("jiti");
  const jiti = createJiti(packagePath, {
    fsCache: false,
    alias: { "@openclaw/normalization-core": join(resolve(checkout), "packages/normalization-core/src") },
  });
  const schemas = await jiti.import(join(resolve(checkout), "packages/gateway-protocol/src/schema-modules.ts"));
  const { Compile } = await jiti.import("typebox/schema");
  const validators = new Map();
  const requests = [];
  const failures = [];
  function check(request, label) {
    assert.equal(typeof request.method, "string", `${label}: missing method`);
    const name = `${request.method.split(".").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}ParamsSchema`;
    const schema = probeRequestSchemas[request.method] ?? schemas[name];
    assert.ok(schema, `${label}: missing ${name}`);
    if (!validators.has(name)) validators.set(name, Compile(schema));
    const validator = validators.get(name);
    if (!validator.Check(request.params)) failures.push(`${label}: ${JSON.stringify(Array.from(validator.Errors(request.params)))}`);
    requests.push({ label, ...request });
  }
  function checkRequestCases(builders, cases, group) {
    assert.deepEqual(Object.keys(builders).sort(), Object.keys(cases).sort(), `${group}: every request builder needs argument cases`);
    for (const [name, variants] of Object.entries(cases)) {
      assert.ok(variants.length, `${group}.${name}: empty argument cases`);
      variants.forEach((args, index) => check(builders[name](...args), `${group}.${name}[${index}]`));
    }
  }
  checkRequestCases(sessionRequests, sessionCases, "sessionRequests");
  checkRequestCases(environmentRequests, environmentRequestCases, "environmentRequests");
  checkRequestCases(collectionRequests, collectionRequestCases, "collectionRequests");
  checkRequestCases(channelRequests, channelRequestCases, "channelRequests");
  checkRequestCases(profileRequests, {
    connect: [["persona-schema-build"]], self: [[]], list: [[]], config: [[]],
    visibility: [[key, "suggest"], [key, "read-only"]], members: [[key]],
    suggest: [[key]], suggestions: [[key]], unchangedLabel: [[key]], deviceList: [[]],
  }, "profileRequests");
  const queueModes = schemas.ChatSendParamsSchema.properties.queueMode.enum;
  assert.ok(Array.isArray(queueModes) && queueModes.length > 0, "chat.send queue modes are present in the pinned schema");
  checkRequestCases(extraRequests, {
    progressPut: [[key]],
    progressGet: [[key]],
    chatSend: [
      [key, "Queued notebook entry.", "persona-schema-input"],
      ...queueModes.map((mode) => [key, "Queued notebook entry.", `persona-schema-${mode}`, mode]),
    ],
    abort: [[key], [key, runId]],
    pendingHistory: [[key], [key, 1], [key, 42]],
    publicShare: [[key, sessionId]],
    publicMembers: [[key]],
    configGet: [[]],
  }, "extraRequests");
  for (const [name, value] of Object.entries(workspaceRequests(key))) {
    (Array.isArray(value) ? value : [value]).forEach((request, index) => check(request, `workspaceRequests.${name}[${index}]`));
  }
  check(workspaceSetRequest({ key, path: "notes.txt", content: "Saved notebook content.\n", expectedHash: "a".repeat(64) }), "workspaceSetRequest");

  let messagesAfterReset = 0;
  const rpc = async (request) => {
    check(request, `makeSession: ${request.method}`);
    switch (request.method) {
      case "sessions.create": return { key: request.params.key, sessionId };
      case "sessions.send": messagesAfterReset++; return { runId };
      case "agent.wait": return { runId: request.params.runId, status: "ok" };
      case "sessions.compact": assert.ok(messagesAfterReset > 0, "compaction needs content after reset"); return { compacted: true };
      case "sessions.patch": return { ok: true };
      case "sessions.reset": messagesAfterReset = 0; return { ok: true };
      case "sessions.describe": return { session: { key: request.params.key, sessionId } };
      default: assert.fail(`missing synthetic response for ${request.method}`);
    }
  };
  await makeSession(rpc, { key, messages: 1, nextModel: "openai/mock-overflow" });
  await makeSession(rpc, { key, messages: 2, cwd: "/tmp/persona-repository" });
  await makeSession(rpc, { key, messages: 4, compactEvery: 2, resetOnce: true, plantWord: "PERSONA_WORD", plantPrefix: "PERSONA_PREFIX" });
  await readSessionKeys(rpc, key);
  assert.ok(requests.some((request) => request.method === "sessions.send" && request.params.message.includes("PERSONA_WORD")));
  assert.ok(requests.some((request) => request.method === "sessions.send" && request.params.message.includes("PERSONA_PREFIX-0")));
  t.diagnostic(`${requests.length} persona Gateway requests checked at ${revision}`);
  assert.deepEqual(failures, []);
});


test("compaction retries only an explicit pre-mutation busy response", async () => {
  let compactCalls = 0, sends = 0;
  const rpc = async ({ method, params }) => {
    if (method === "sessions.create") return { key, sessionId };
    if (method === "sessions.send") { sends++; return { runId }; }
    if (method === "agent.wait") return { runId: params.runId, status: "ok" };
    if (method === "sessions.describe") return { session: { key, sessionId } };
    if (method === "sessions.compact") {
      if (++compactCalls === 1) throw new Error(`sessions.compact INVALID_REQUEST: Session ${key} has an active run; retry after it finishes.`);
      return { compacted: true };
    }
    assert.fail(method);
  };
  await makeSession(rpc, { key, messages: 2, compactEvery: 2 });
  assert.equal(compactCalls, 2);
  assert.equal(sends, 2);
  await assert.rejects(makeSession(async (request) => {
    if (request.method === "sessions.compact") throw new Error("transport disconnected after request");
    return rpc(request);
  }, { key, messages: 2, compactEvery: 2 }), /transport disconnected/);
});

test("session sends wait for the accepted run even when old history already matches", async () => {
  const acceptedRunId = "newly-accepted-run";
  let release, waiting, finished = false, historyReads = 0;
  const terminal = new Promise((resolve) => { release = resolve; });
  const waitStarted = new Promise((resolve) => { waiting = resolve; });
  const rpc = async ({ method, params }) => {
    if (method === "sessions.send") {
      assert.notEqual(params.idempotencyKey, acceptedRunId);
      return { runId: acceptedRunId };
    }
    if (method === "agent.wait") {
      assert.equal(params.runId, acceptedRunId);
      waiting();
      return terminal;
    }
    if (method === "chat.history") {
      historyReads++;
      return { messages: [{ role: "assistant", content: "KOVA_AGENT_OK", __openclaw: { runId: "older-run" } }] };
    }
    assert.fail(method);
  };
  const sent = sendSessionMessage(rpc, key, "Reply with KOVA_AGENT_OK.").then((result) => { finished = true; return result; });
  await Promise.race([waitStarted, sent.then(() => assert.fail("turn returned before waiting for its accepted run"))]);
  assert.equal(finished, false);
  release({ runId: acceptedRunId, status: "ok" });
  assert.equal(await sent, acceptedRunId);
  assert.equal(historyReads, 0);
});

test("old matching replies cannot turn a failed or unrelated run receipt into success", async (t) => {
  const acceptedRunId = "newly-accepted-run";
  const cases = [
    { name: "failed", receipt: { runId: acceptedRunId, status: "error", error: "new run failed" }, error: /did not complete: error/, exitCode: 1 },
    { name: "timed out", receipt: { runId: acceptedRunId, status: "timeout" }, error: /did not complete: timeout/, exitCode: 3 },
    { name: "pending", receipt: { runId: acceptedRunId, status: "pending" }, error: /did not complete: pending/, exitCode: 1 },
    { name: "missing run identity", receipt: { status: "ok" }, error: /does not match the accepted run/ },
    { name: "different run", receipt: { runId: "older-run", status: "ok" }, error: /does not match the accepted run/ },
    { name: "different terminal receipt", receipt: { runId: acceptedRunId, status: "ok", terminalReceipt: { runId: "older-run" } }, error: /does not match the accepted run/ }
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    let historyReads = 0, waits = 0;
    const rpc = async ({ method, params }) => {
      if (method === "sessions.send") return { runId: acceptedRunId };
      if (method === "agent.wait") {
        waits++;
        assert.equal(params.runId, acceptedRunId);
        return { terminalReply: { disposition: "visible", text: "KOVA_AGENT_OK" }, ...scenario.receipt };
      }
      if (method === "chat.history") {
        historyReads++;
        return { messages: [{ role: "assistant", content: "KOVA_AGENT_OK", __openclaw: { runId: "older-run" } }] };
      }
      assert.fail(method);
    };
    await assert.rejects(sendSessionMessage(rpc, key, "Reply with KOVA_AGENT_OK."), (error) => scenario.error.test(error.message) && (scenario.exitCode === undefined || error.exitCode === scenario.exitCode));
    assert.equal(waits, 1);
    assert.equal(historyReads, 0);
  });
});
