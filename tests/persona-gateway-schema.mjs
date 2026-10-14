import assert from "node:assert/strict";
import { test } from "node:test";
import { access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { sessionRequests, makeSession, readSessionKeys } from "../support/persona/session-content.mjs";
import { extraRequests } from "../support/persona/session-extras.mjs";

const revision = "7e80556f503d26ddde64e274bfb50cbbec7830f5";
const key = "agent:main:persona-schema";
const sessionId = "persona-schema-session";
const runId = "persona-schema-run";

const sessionCases = {
  create: [[key], [undefined, "kova-schema-label"]],
  resolveLabel: [["kova-schema-label"]],
  resolveShort: [["12345678"]],
  describe: [[key]],
  send: [[key, "Notebook entry.", "persona-schema-idempotency"]],
  wait: [[runId]],
  history: [[key], [key, 0], [key, 100]],
  message: [[key, sessionId, "12345678"]],
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
    assert.ok(schemas[name], `${label}: missing ${name}`);
    if (!validators.has(name)) validators.set(name, Compile(schemas[name]));
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
  const queueModes = schemas.ChatSendParamsSchema.properties.queueMode.enum;
  assert.ok(Array.isArray(queueModes) && queueModes.length > 0, "chat.send queue modes are present in the pinned schema");
  checkRequestCases(extraRequests, {
    patchModel: [[key, "openai/mock-tools"]],
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

  let messagesAfterReset = 0;
  const rpc = async (request) => {
    check(request, `makeSession: ${request.method}`);
    switch (request.method) {
      case "sessions.create": return { key: request.params.key, sessionId };
      case "sessions.send": messagesAfterReset++; return { runId };
      case "agent.wait": return { status: "ok" };
      case "sessions.compact": assert.ok(messagesAfterReset > 0, "compaction needs content after reset"); return { compacted: true };
      case "sessions.reset": messagesAfterReset = 0; return { ok: true };
      case "sessions.describe": return { session: { key: request.params.key, sessionId } };
      default: assert.fail(`missing synthetic response for ${request.method}`);
    }
  };
  await makeSession(rpc, { key, messages: 1 });
  await makeSession(rpc, { key, messages: 4, compactEvery: 2, resetOnce: true, plantWord: "PERSONA_WORD", plantPrefix: "PERSONA_PREFIX" });
  await readSessionKeys(rpc, key);
  assert.ok(requests.some((request) => request.method === "sessions.send" && request.params.message.includes("PERSONA_WORD")));
  assert.ok(requests.some((request) => request.method === "sessions.send" && request.params.message.includes("PERSONA_PREFIX-0")));
  t.diagnostic(`${requests.length} persona Gateway requests checked at ${revision}`);
  assert.deepEqual(failures, []);
});
