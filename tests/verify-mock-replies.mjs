import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createMockAiProviderServer } from "mock-ai-provider/dist/server/create-server.js";
import { parseArgs as supervisorArgs } from "../support/mock-ai-provider-supervisor.mjs";
import { parseArgs, scriptForMode } from "../support/write-mock-ai-provider-script.mjs";
import { attachVerificationReplies, selectVerificationReply, verificationRepliesEnabled, writeVerificationReply } from "../support/verify/mock-replies.mjs";

const saved = {
  id: "saved-mock",
  steps: [
    { id: "first", respond: { type: "final-text", text: "FIRST" } },
    { id: "second", respond: { type: "final-text", text: "SECOND" } }
  ],
  kovaPersona: { version: 1, heldTurn: { marker: "SAVED_HOLD", holdMs: 90000, progressCard: true } }
};
const holdText = (holdMs, progressCards = false) => `KOVA_VERIFY_HOLD ${JSON.stringify({ holdMs, progressCards })}`;
const body = (text) => ({ model: "gpt-5.5", input: [{ role: "user", content: text }] });
const toolText = `KOVA_TOOL_CALL ${JSON.stringify({ name: "session_status", arguments: { sessionKey: "agent:main:sample", nested: { text: 'brace } and a " quote' } } })}`;

test("saved persona metadata enables verification replies without new supervisor options", () => {
  const ordinary = scriptForMode(parseArgs(["--output", "unused", "--mode", "normal"]));
  const verification = scriptForMode(parseArgs(["--output", "unused", "--mode", "verification"]));
  assert.equal(verificationRepliesEnabled(ordinary), false);
  assert.equal(verificationRepliesEnabled(verification), true);
  assert.equal(verificationRepliesEnabled(saved), true);
  assert.deepEqual(verification.steps, ordinary.steps);
  assert.equal(saved.kovaPersona.heldTurn.holdMs, 90000);
  assert.deepEqual(supervisorArgs(["--script", "saved.json", "--request-log", "requests.jsonl", "--server-log", "server.log", "--pid-file", "pid"]), {
    scriptPath: "saved.json", requestLog: "requests.jsonl", serverLog: "server.log", pidFile: "pid"
  });
});

test("per-call holds override saved defaults and progress runs once for the latest user", () => {
  const snapshot = structuredClone(saved);
  const short = selectVerificationReply(body(holdText(123)), saved);
  assert.equal(short.holdMs, 123);
  assert.equal(short.respond.type, "final-text");
  const request = { ...body(holdText(456, true)), tools: [{ type: "function", name: "progress_card" }] };
  const call = selectVerificationReply(request, saved).respond.toolCalls[0];
  assert.equal(call.name, "progress_card");
  const completed = { ...request, input: [...request.input, { type: "function_call_output", call_id: call.id, output: "ok" }] };
  assert.equal(selectVerificationReply(completed, saved).holdMs, 456);
  assert.equal(selectVerificationReply(completed, saved).respond.type, "final-text");
  assert.equal(selectVerificationReply({ ...completed, input: [...completed.input, { role: "user", content: "ordinary reply" }] }, saved), null);
  const inherited = { ...body("SAVED_HOLD"), tools: request.tools };
  const inheritedCall = selectVerificationReply(inherited, saved).respond.toolCalls[0];
  assert.equal(selectVerificationReply({ ...inherited, input: [...inherited.input, { type: "function_call_output", call_id: inheritedCall.id, output: "ok" }] }, saved).holdMs, 90000);
  assert.deepEqual(saved, snapshot);
});

test("requested tools keep their call id across provider forms and ignore unrelated outputs", () => {
  const request = { model: "gpt-5.5", input: toolText, tools: [{ type: "function", name: "session_status" }] };
  const call = selectVerificationReply(request).respond.toolCalls[0];
  assert.equal(call.name, "session_status");
  assert.equal(JSON.parse(call.arguments).nested.text, 'brace } and a " quote');
  const followup = { ...request, input: [
    { role: "user", content: [{ type: "input_text", text: toolText }] },
    { role: "user", content: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nTool context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>" },
    { type: "function_call_output", call_id: "unrelated", output: "ok" }
  ] };
  assert.equal(selectVerificationReply(followup).respond.toolCalls[0].id, call.id);
  followup.input.push({ type: "function_call_output", call_id: call.id, output: "ok" });
  assert.equal(selectVerificationReply(followup).respond.text, "KOVA_TOOL_DONE");
  const chat = { model: request.model, messages: [{ role: "user", content: toolText }], tools: [{ type: "function", function: { name: "tool_call" } }] };
  const deferred = selectVerificationReply(chat).respond.toolCalls[0];
  assert.equal(deferred.id, call.id);
  assert.equal(deferred.name, "tool_call");
  assert.deepEqual(JSON.parse(deferred.arguments), { id: "session_status", args: JSON.parse(call.arguments) });
  chat.messages.push({ role: "tool", tool_call_id: deferred.id, content: "ok" });
  assert.equal(selectVerificationReply(chat).respond.text, "KOVA_TOOL_DONE");
  const nestedMarker = `KOVA_TOOL_CALL ${JSON.stringify({ name: "session_status", arguments: { text: holdText(2) } })}`;
  assert.equal(JSON.parse(selectVerificationReply({ ...request, input: nestedMarker }).respond.toolCalls[0].arguments).text, holdText(2));
  const newer = { ...followup, input: [...followup.input, { role: "user", id: "new-user-message", content: toolText }] };
  assert.notEqual(selectVerificationReply(newer).respond.toolCalls[0].id, call.id);
});

test("invalid or oversized marker payloads fail and compaction content stays with the normal provider", () => {
  for (const text of [holdText(0), holdText(300001), holdText(2, "true"),
    'KOVA_VERIFY_HOLD {"holdMs":2,"progressCards":false,"extra":1}',
    'KOVA_TOOL_CALL {"name":"session_status","arguments":[]}',
    'KOVA_TOOL_CALL {"name":"bad name","arguments":{}}',
    'KOVA_TOOL_CALL {"name":"session_status","arguments":{"text":"' + "x".repeat(65536) + '"}}',
    'KOVA_TOOL_CALL {"name":"session_status","arguments":' + '{"x":'.repeat(33) + "{}" + "}".repeat(34),
    `${holdText(2)}\n${toolText}`]) {
    assert.throws(() => selectVerificationReply(body(text), saved));
  }
  assert.throws(() => selectVerificationReply(body(toolText)), /unavailable/);
  assert.equal(selectVerificationReply({ ...body(`<conversation>\n${toolText}\n</conversation>`), instructions: "You are a context summarization assistant. ONLY output the structured summary." }, saved), null);
});

test("native provider streams honor hold duration on both APIs and retain ordinary fallback order", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-verify-mock-"));
  const requestLog = join(directory, "requests.jsonl");
  const server = await createMockAiProviderServer({ providers: ["openai"], script: saved, requestLogPath: requestLog });
  attachVerificationReplies(server, { script: saved, requestLog });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const send = (path, request) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
  });
  assert.equal((await (await send("/v1/responses", body("ordinary first"))).json()).output_text, "FIRST");
  for (const responses of [true, false]) {
    const request = responses ? body(holdText(160)) : { model: "gpt-5.5", messages: [{ role: "user", content: holdText(160) }] };
    const started = performance.now();
    const response = await send(responses ? "/v1/responses" : "/v1/chat/completions", { ...request, stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const text = await response.text();
    assert.ok(performance.now() - started >= 155);
    const events = text.split("\n\n").filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]").map((frame) => JSON.parse(frame.slice(6)));
    const parts = responses ? events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta) : events.map((event) => event.choices?.[0]?.delta?.content).filter((value) => typeof value === "string");
    assert.ok(parts.length > 1);
    assert.match(parts.join(""), /The held reply is complete/);
    assert.ok(text.includes(responses ? '"type":"response.completed"' : '"finish_reason":"stop"'));
  }
  const toolRequest = { ...body(toolText), tools: [{ type: "function", name: "session_status" }] };
  const toolResponse = await (await send("/v1/responses", toolRequest)).json();
  const call = toolResponse.output[0];
  assert.equal(call.name, "session_status");
  assert.equal((await (await send("/v1/responses", { ...toolRequest, input: [...toolRequest.input, { type: "function_call_output", call_id: call.call_id, output: "ok" }] })).json()).output_text, "KOVA_TOOL_DONE");
  assert.equal((await (await send("/v1/responses", body("ordinary second"))).json()).output_text, "SECOND");
  let rows = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    rows = (await readFile(requestLog, "utf8")).trim().split("\n").map(JSON.parse);
    if (rows.filter((row) => row.matchedScriptStep === "kova-verification").length === 4) break;
    await sleep(10);
  }
  assert.equal(rows.filter((row) => row.matchedScriptStep === "kova-verification").length, 4);
  assert.equal(rows.filter((row) => row.matchedScriptStep === "kova-verification" && row.toolCallsEmitted === 1).length, 1);
});

test("closing a response cancels a held stream and removes request listeners", { timeout: 3000 }, async () => {
  const server = new EventEmitter();
  server.on("request", () => assert.fail("unexpected provider fallback"));
  attachVerificationReplies(server, { script: saved });
  const req = Readable.from([JSON.stringify({ ...body(holdText(1000)), stream: true })]);
  Object.assign(req, { method: "POST", url: "/v1/responses", headers: {}, complete: true });
  const res = new EventEmitter();
  let closed = false, ended = false, writesAfterClose = 0;
  res.writeHead = () => { res.headersSent = true; };
  res.write = (text) => {
    if (closed) writesAfterClose++;
    if (!closed && text.includes('"type":"response.output_text.delta"')) setImmediate(() => {
      closed = true;
      res.destroyed = true;
      res.emit("close");
    });
    return true;
  };
  res.end = () => { ended = true; };
  const removed = new Promise((resolve) => {
    const off = res.off;
    res.off = function (event, listener) {
      off.call(this, event, listener);
      if (event === "close") resolve();
      return this;
    };
  });
  server.emit("request", req, res);
  await removed;
  assert.equal(closed, true);
  assert.equal(ended, false);
  assert.equal(writesAfterClose, 0);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("request reading and stream capture have finite limits", async () => {
  const server = new EventEmitter();
  server.on("request", () => assert.fail("oversized request reached fallback"));
  attachVerificationReplies(server, { script: saved });
  const req = Readable.from([Buffer.alloc(1024 * 1024 + 1, "x")]);
  Object.assign(req, { method: "POST", url: "/v1/responses", headers: {}, complete: true });
  const res = new EventEmitter();
  const result = new Promise((resolve) => {
    res.writeHead = (status) => { res.statusCode = status; };
    res.end = (text) => resolve({ status: res.statusCode, body: JSON.parse(text) });
  });
  server.emit("request", req, res);
  assert.equal((await result).status, 413);
  const response = { writeHead: () => assert.fail("oversized capture sent headers") };
  await assert.rejects(writeVerificationReply(response, { stream: true }, { respond: { type: "final-text", text: "many ".repeat(300) } }, true, new AbortController().signal), /capture limit/);
});
