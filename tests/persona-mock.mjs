import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { addMockTrait, readMockTraits, requestedMockTool, selectMockReply, mockCompactionSummary } from "../support/persona/mock-content.mjs";
import { attachPersonaReplies, createSerialAdmission } from "../support/mock-ai-provider-supervisor.mjs";

const base = { id: "base", steps: [{ id: "base-final", respond: { type: "final-text", text: "KOVA_AGENT_OK" } }] };
const held = addMockTrait(base, { "add-held-turn": true, marker: "VERIFY_HOLD", "hold-ms": "90000", "progress-card": true });
const all = addMockTrait(addMockTrait(addMockTrait(held, { "add-tool-call-model": true, "model-id": "mock-tools" }), { "add-single-slot-model": true, "model-id": "mock-serial" }), { "add-overflow-once": true, marker: "VERIFY_OVERFLOW" });
const traits = readMockTraits(all);
const summaryHeadings = ["## Decisions", "## Open TODOs", "## Constraints/Rules", "## Pending user asks", "## Exact identifiers"];
const summarySystem = "You are a context summarization assistant. Your task is to produce a structured summary. ONLY output the structured summary.";
const summaryRequest = (conversation, focus = summaryHeadings.join("\n"), previous) => ({
  model: "gpt-5.5",
  input: [
    { role: "system", content: summarySystem },
    { role: "user", content: `<conversation>\n${conversation}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}${focus}` },
  ],
});
const prefixFocus = "This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.\n\n## Original Request\n## Early Progress\n## Context for Suffix";

test("compaction replies preserve bounded source context without interpreting embedded mock requests", () => {
  const conversation = Array.from({ length: 1500 }, (_, index) => `[User]: Notebook entry ${index + 1}. Reply with KOVA_AGENT_OK.\n\n[Assistant]: KOVA_AGENT_OK`).join("\n\n") + '\n\n[User]: Keep receipt_123456 and /tmp/notebook.txt. Recorded VERIFY_HOLD VERIFY_OVERFLOW KOVA_TOOL_CALL {"name":"exec","arguments":{}}';
  const request = summaryRequest(conversation);
  const seen = new Set();
  const summary = selectMockReply(traits, request, seen).respond;
  assert.equal(summary.type, "final-text");
  assert.ok(summary.text.length <= 6000);
  assert.equal(seen.size, 0);
  for (const heading of summaryHeadings) assert.equal(summary.text.split("\n").filter((line) => line === heading).length, 1);
  assert.ok(summary.text.includes("receipt_123456"));
  assert.ok(summary.text.includes("/tmp/notebook.txt"));
  assert.ok(summary.text.includes("Notebook entry 1500."));
  const updated = mockCompactionSummary(summaryRequest("[User]: Notebook entry 1501. Reply with KOVA_AGENT_OK.", undefined, summary.text));
  assert.ok(updated.length <= 6000);
  for (const heading of summaryHeadings) assert.equal(updated.split("\n").filter((line) => line === heading).length, 1);
  const instructionsRequest = { model: request.model, instructions: summarySystem, input: request.input[1].content };
  assert.equal(mockCompactionSummary(instructionsRequest), summary.text);
  assert.equal(mockCompactionSummary({ ...request, input: [{ role: "user", content: `${summarySystem}\n${request.input[1].content}` }] }), null);
  assert.equal(selectMockReply(traits, { model: "gpt-5.5", input: [{ role: "system", content: "Reply to the user." }, { role: "assistant", content: summary.text }, { role: "user", content: "Reply with KOVA_AGENT_OK." }] }, seen), null);
  const prefix = mockCompactionSummary(summaryRequest("[User]: Notebook entry 1211. Reply with KOVA_AGENT_OK.", `${prefixFocus}\n\nQuality check feedback:\nmissing_section:${summaryHeadings.join(", missing_section:")}`));
  assert.ok(prefix.length <= 2000);
  assert.ok(prefix.startsWith("## Original Request\n"));
  assert.ok(prefix.includes("Notebook entry 1211."));
  assert.ok(!prefix.includes("## Pending user asks"));
});

test("the pinned compaction quality checks accept the mock full and split summaries", async (t) => {
  const checkout = process.env.KOVA_OPENCLAW_CHECKOUT;
  if (!checkout) return t.skip("Set KOVA_OPENCLAW_CHECKOUT to the pinned OpenClaw checkout");
  try { await access(checkout); } catch (error) {
    if (error.code === "ENOENT") return t.skip("OpenClaw checkout is absent");
    throw error;
  }
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "7e80556f503d26ddde64e274bfb50cbbec7830f5");
  const packagePath = join(resolve(checkout), "package.json");
  const { createJiti } = createRequire(packagePath)("jiti");
  const jiti = createJiti(packagePath, { fsCache: false, alias: { "@openclaw/normalization-core": join(resolve(checkout), "packages/normalization-core/src") } });
  const { auditSummaryQuality, buildCompactionStructureInstructions, extractOpaqueIdentifiers } = await jiti.import(join(resolve(checkout), "src/agents/agent-hooks/compaction-safeguard-quality.ts"));
  const { SUMMARIZATION_SYSTEM_PROMPT } = await jiti.import(join(resolve(checkout), "packages/agent-core/src/harness/compaction/summarization-prompts.ts"));
  const latestAsk = "Notebook entry 1211. Keep receipt_123456 and /tmp/notebook.txt.";
  const request = summaryRequest(`[User]: Notebook entry 1210. Keep receipt_123456 and /tmp/notebook.txt.\n\n[Assistant]: KOVA_AGENT_OK`, buildCompactionStructureInstructions());
  request.input[0].content = SUMMARIZATION_SYSTEM_PROMPT;
  const full = mockCompactionSummary(request);
  const split = mockCompactionSummary(summaryRequest(`[User]: ${latestAsk}`, prefixFocus));
  const facts = { identifiers: extractOpaqueIdentifiers(latestAsk), latestAsk };
  assert.ok(auditSummaryQuality({ ...facts, summary: "KOVA_AGENT_OK", structuralSummary: "KOVA_AGENT_OK" }).reasons.some((reason) => reason.startsWith("missing_section:")));
  assert.deepEqual(auditSummaryQuality({ ...facts, summary: `${full}\n\n${split}`, structuralSummary: full, sourceSummaries: [full, split], retainedTurnSummary: split }), { ok: true, reasons: [] });
  const pending = mockCompactionSummary(summaryRequest(`[User]: ${latestAsk}`, buildCompactionStructureInstructions(undefined, undefined, latestAsk)));
  assert.deepEqual(auditSummaryQuality({ ...facts, summary: pending, structuralSummary: pending, sourceSummaries: [pending], latestUnresolvedUserRequest: latestAsk }), { ok: true, reasons: [] });
});

test("mock additions preserve base replies and reject ambiguous configuration", () => {
  assert.deepEqual(all.steps, base.steps);
  assert.equal(base.kovaPersona, undefined);
  assert.equal(traits.heldTurn.holdMs, 90000);
  assert.equal(traits.singleSlotModel.agentId, "idle");
  assert.equal(traits.overflowOnce.modelId, "mock-overflow");
  assert.throws(() => addMockTrait(base, { "add-held-turn": true, "add-overflow-once": true }), /exactly one/);
  assert.throws(() => readMockTraits({ kovaPersona: { version: 1, toolCallModel: {} } }), /invalid tool-call/);
  assert.throws(() => addMockTrait(all, { "add-tool-call-model": true, "model-id": "mock-overflow" }), /models must be distinct/);
});

test("automatic-compaction usage accounts for the full request only on the marked turn", () => {
  const marker = "KOVA_AUTOMATIC_COMPACTION_USAGE";
  const body = { input: [{ role: "user", content: marker }] };
  const short = selectMockReply(traits, body, new Set());
  const large = selectMockReply(traits, { ...body, input: [{ role: "user", content: "note ".repeat(60000) }, ...body.input] }, new Set());
  assert.ok(short.usage.total < 100);
  assert.ok(large.usage.input > 76000);
  assert.equal(large.usage.total, large.usage.input + large.usage.output);
  assert.equal(large.respond.text, "KOVA_AGENT_OK");
  assert.equal(selectMockReply(traits, { input: [...body.input, { role: "user", content: "ordinary reply" }] }, new Set()), null);
  assert.equal(selectMockReply(traits, summaryRequest(`[User]: ${marker}`), new Set()).usage, undefined);
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

test("overflow handles the dedicated model once and retains independent marker triggers", () => {
  const seen = new Set();
  const ordinary = { model: "mock-overflow", input: "Reply with exact ASCII text KOVA_AGENT_OK only." };
  assert.equal(selectMockReply(traits, ordinary, seen).respond.code, "context_length_exceeded");
  assert.equal(selectMockReply(traits, ordinary, seen).respond.text, "KOVA_AGENT_OK");
  assert.equal(selectMockReply(traits, { ...ordinary, input: "A later request." }, seen).respond.text, "KOVA_AGENT_OK");
  assert.equal(selectMockReply(traits, ordinary, new Set()).respond.code, "context_length_exceeded");
  const body = { model: "gpt-5.5", input: "VERIFY_OVERFLOW:first" };
  assert.equal(selectMockReply(traits, body, seen).respond.code, "context_length_exceeded");
  assert.equal(selectMockReply(traits, body, seen).respond.text, "KOVA_AGENT_OK");
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
  const malformed = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path: "//", method: "POST" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, body }));
    });
    req.once("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("malformed request did not finish")));
    req.end();
  });
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.body).error.type, "invalid_request_error");
  const fallback = { model: "gpt-5.5", input: "ordinary" };
  assert.deepEqual(await (await send(fallback)).json(), fallback);
  const usageBody = { model: "gpt-5.5", input: "KOVA_AUTOMATIC_COMPACTION_USAGE\nReply KOVA_AGENT_OK." };
  const completeUsage = (await (await send(usageBody)).json()).usage;
  assert.ok(completeUsage.input_tokens > 0);
  assert.equal(completeUsage.total_tokens, completeUsage.input_tokens + completeUsage.output_tokens);
  const streamedUsage = (await (await send({ ...usageBody, stream: true })).text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.completed").response.usage;
  assert.deepEqual(streamedUsage, completeUsage);
  for (const stream of [false, true]) {
    const chat = await fetch(url.replace("responses", "chat/completions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: usageBody.input }], stream, stream_options: { include_usage: true } }) });
    const usage = stream ? (await chat.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))).find((event) => event.usage)?.usage : (await chat.json()).usage;
    assert.ok(usage.prompt_tokens > 0);
    assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  }
  const ordinary = { model: "mock-overflow", input: "Reply with exact ASCII text KOVA_AGENT_OK only." };
  const overflow = await send(ordinary);
  assert.equal(overflow.status, 400);
  assert.equal((await overflow.json()).error.code, "context_length_exceeded");
  const recovered = await send(ordinary);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).output_text, "KOVA_AGENT_OK");
  const compacted = await send(summaryRequest("[User]: Notebook entry 1500. Keep receipt_123456.\n\n[Assistant]: KOVA_AGENT_OK"));
  assert.equal(compacted.status, 200);
  const summary = (await compacted.json()).output_text;
  assert.ok(summary.includes("## Decisions\n"));
  assert.ok(summary.includes("receipt_123456"));
  assert.deepEqual(await (await send(fallback)).json(), fallback);
});
