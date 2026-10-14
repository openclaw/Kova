import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { addMockTrait, readMockTraits, requestedMockTool, selectMockReply } from "../support/persona/mock-content.mjs";
import { attachPersonaReplies, createSerialAdmission } from "../support/mock-ai-provider-supervisor.mjs";

const base = { id: "base", steps: [{ id: "base-final", respond: { type: "final-text", text: "KOVA_AGENT_OK" } }] };
const held = addMockTrait(base, { "add-held-turn": true, marker: "VERIFY_HOLD", "hold-ms": "90000", "progress-card": true });
const all = addMockTrait(addMockTrait(addMockTrait(held, { "add-tool-call-model": true, "model-id": "mock-tools" }), { "add-single-slot-model": true, "model-id": "mock-serial" }), { "add-overflow-once": true, marker: "VERIFY_OVERFLOW" });
const traits = readMockTraits(all);

test("mock additions preserve base replies and reject ambiguous configuration", () => {
  assert.deepEqual(all.steps, base.steps);
  assert.equal(base.kovaPersona, undefined);
  assert.equal(traits.heldTurn.holdMs, 90000);
  assert.equal(traits.singleSlotModel.agentId, "idle");
  assert.throws(() => addMockTrait(base, { "add-held-turn": true, "add-overflow-once": true }), /exactly one/);
  assert.throws(() => readMockTraits({ kovaPersona: { version: 1, toolCallModel: {} } }), /invalid tool-call/);
});

test("tool calls honor advertised names and complete only after the matching output", () => {
  const request = { name: "exec", arguments: { command: "printf test", nested: { text: 'brace } and a " quote' } } };
  const body = { model: "mock-tools", input: [{ role: "user", content: `KOVA_TOOL_CALL ${JSON.stringify(request)}` }], tools: [{ type: "function", name: "exec" }] };
  body.input.push({ role: "user", content: [{ type: "input_text", text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nActive exec sessions: none\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>" }] });
  const reply = selectMockReply(traits, body, new Set());
  assert.equal(reply.respond.toolCalls[0].name, "exec");
  assert.equal(JSON.parse(reply.respond.toolCalls[0].arguments).command, "printf test");
  assert.throws(() => selectMockReply(traits, { ...body, tools: [] }, new Set()), /unavailable/);
  const deferred = selectMockReply(traits, { ...body, tools: [{ type: "function", name: "tool_call" }] }, new Set()).respond.toolCalls[0];
  assert.equal(deferred.name, "tool_call");
  assert.deepEqual(JSON.parse(deferred.arguments), { id: "exec", args: JSON.parse(reply.respond.toolCalls[0].arguments) });
  const output = { type: "function_call_output", call_id: reply.respond.toolCalls[0].id, output: "test" };
  assert.equal(selectMockReply(traits, { ...body, input: [...body.input, output] }, new Set()).respond.text, "KOVA_TOOL_DONE");
  assert.equal(selectMockReply(traits, { ...body, input: [...body.input, { ...output, call_id: "unrelated" }] }, new Set()).respond.type, "tool-calls");
  assert.deepEqual(requestedMockTool('Call sessions_list exactly once with {"limit":5}.'), { name: "sessions_list", arguments: { limit: 5 } });
});

test("held turns execute progress before holding and ignore older user markers", () => {
  const body = { model: "gpt-5.5", input: [{ role: "user", content: "VERIFY_HOLD" }], tools: [{ name: "progress_card", type: "function" }] };
  const call = selectMockReply(traits, body, new Set()).respond.toolCalls[0];
  assert.equal(call.name, "progress_card");
  const continued = { ...body, input: [...body.input, { type: "function_call_output", call_id: call.id, output: "ok" }] };
  assert.equal(selectMockReply(traits, continued, new Set()).holdMs, 90000);
  assert.equal(selectMockReply(traits, { ...continued, input: [...continued.input, { role: "user", content: "ordinary reply" }] }, new Set()), null);
});

test("overflow is once per user trigger without consuming unrelated replies", () => {
  const seen = new Set();
  const body = { model: "gpt-5.5", input: "VERIFY_OVERFLOW:first" };
  assert.equal(selectMockReply(traits, body, seen).respond.code, "context_length_exceeded");
  assert.equal(selectMockReply(traits, body, seen).respond.type, "final-text");
  assert.equal(selectMockReply(traits, { ...body, input: "VERIFY_OVERFLOW:second" }, seen).respond.type, "error");
  assert.equal(selectMockReply(traits, { ...body, input: "ordinary" }, seen), null);
});

test("serial admission keeps one caller and removes a cancelled waiter", async () => {
  const serial = createSerialAdmission();
  const first = await serial.acquire(new AbortController().signal);
  const controller = new AbortController();
  const abandoned = serial.acquire(controller.signal);
  let admitted = false;
  const next = serial.acquire(new AbortController().signal).then((release) => { admitted = true; return release; });
  controller.abort();
  await assert.rejects(abandoned, /abort/i);
  assert.equal(admitted, false);
  first();
  (await next)();
  const last = await serial.acquire(new AbortController().signal);
  last();
});

test("supervisor holds a real stream, cancels promptly and serializes model requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-persona-mock-"));
  const log = join(directory, "requests.jsonl");
  const script = structuredClone(all);
  script.kovaPersona.heldTurn.holdMs = 600;
  script.kovaPersona.heldTurn.progressCard = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
  });
  attachPersonaReplies(server, script, log);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const send = (body, signal) => fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal });
  const start = Date.now();
  const response = await send({ model: "gpt-5.5", input: "VERIFY_HOLD", stream: true });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes("response.output_text.delta"));
  assert.ok(!first.includes("response.completed"));
  let remainder = "";
  for (;;) { const part = await reader.read(); if (part.done) break; remainder += new TextDecoder().decode(part.value); }
  assert.ok(remainder.includes("response.completed"));
  assert.ok(Date.now() - start >= 550);
  const cancelled = new AbortController();
  const ongoing = await send({ model: "mock-serial", input: "VERIFY_HOLD", stream: true }, cancelled.signal);
  await ongoing.body.getReader().read();
  cancelled.abort();
  await Promise.all([send({ model: "mock-serial", input: "one" }).then((r) => r.text()), send({ model: "mock-serial", input: "two" }).then((r) => r.text())]);
  let records = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    records = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter((record) => record.model === "mock-serial");
    if (records.length === 2) break;
    await sleep(10);
  }
  assert.equal(records.length, 2);
  assert.ok(records[1].admittedAtEpochMs >= records[0].respondedAtEpochMs);
  const fallback = { model: "gpt-5.5", input: "ordinary" };
  assert.deepEqual(await (await send(fallback)).json(), fallback);
});
