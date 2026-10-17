import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeEventIdentities } from "../src/verify/runtime-events.mjs";

const file = { path: "agents/main/agent/openclaw-agent.sqlite", table: "trajectory_runtime_events" };
const runId = "4cdc278f-266c-48e5-a34d-d322c5b89046";
const cell = value => ({ raw: value, value });
function row(type, data) {
  const event = { traceSchema: "openclaw-trajectory", schemaVersion: 1, source: "runtime", type,
    traceId: "session-a", sessionId: "session-a", runId, seq: 1, sourceSeq: 1, ts: "2026-10-17T15:00:00.000Z", data };
  return { rowid: 1, values: { session_id: cell("session-a"), run_id: cell(runId), seq: cell(1),
    created_at: cell(Date.parse(event.ts)), event_json: { raw: JSON.stringify(event), value: event } } };
}
function assistant() {
  return { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: {}, stopReason: "toolUse",
    responseId: "resp_new", content: [
      { type: "text", text: "reply", textSignature: JSON.stringify({ v: 1, id: "msg_new", phase: "final_answer", extra: { preserve: true } }) },
      { type: "toolCall", id: "call_new|fc_new", name: "exec", arguments: { responseId: "application-response", id: "application-id" } }
    ] };
}

test("native captured messages expose stable identity families without modifying payloads", () => {
  const messages = [assistant(), { role: "toolResult", toolName: "exec", toolCallId: "call_new|fc_new", isError: false, content: [] },
    { role: "user", content: "keep this prompt", idempotencyKey: `${runId}:user` }, assistant()];
  for (const [type, field] of [["context.compiled", "messages"], ["prompt.submitted", "messages"], ["model.completed", "messagesSnapshot"]]) {
    const source = row(type, { [field]: messages, nested: { messages: [assistant()] } }), before = structuredClone(source);
    assert.deepEqual(runtimeEventIdentities(file, source), [
      { field: "responseId", id: "resp_new" }, { field: "textSignatureId", id: "msg_new" },
      { field: "toolCallId", id: "call_new|fc_new" }, { field: "runId", id: runId }
    ]);
    assert.deepEqual(source, before);
    assert.equal(source.values.event_json.value.data[field][2].idempotencyKey, `${runId}:user`);
    assert.deepEqual(JSON.parse(messages[0].content[0].textSignature), { v: 1, id: "msg_new", phase: "final_answer", extra: { preserve: true } });
  }
  const sameSpelling = assistant();
  sameSpelling.responseId = "shared-id";
  sameSpelling.content[0].textSignature = JSON.stringify({ v: 1, id: "shared-id" });
  sameSpelling.content[1].id = "shared-id";
  assert.deepEqual(runtimeEventIdentities(file, row("context.compiled", { messages: [sameSpelling] })), [
    { field: "responseId", id: "shared-id" }, { field: "textSignatureId", id: "shared-id" }, { field: "toolCallId", id: "shared-id" }
  ], "only identical family and identity pairs are deduplicated");
});

test("runtime identity extraction requires the native event and exact owned capture fields", () => {
  for (const other of [{ ...file, path: "files/openclaw-agent.sqlite" }, { ...file, table: "application_events" }]) {
    assert.deepEqual(runtimeEventIdentities(other, row("model.completed", { messagesSnapshot: [assistant()] })), []);
  }
  for (const alter of [
    source => { source.values.event_json.encoded = true; },
    source => { source.values.event_json.value.source = "application"; },
    source => { source.values.event_json.value.schemaVersion = 2; },
    source => { source.values.session_id.raw = "different"; },
    source => { source.values.run_id.raw = "different"; },
    source => { source.values.created_at.raw++; },
    source => { source.values.event_json.value.seq = "1"; }
  ]) {
    const source = row("context.compiled", { messages: [assistant()] }); alter(source);
    assert.deepEqual(runtimeEventIdentities(file, source), []);
  }
  for (const type of ["application", "trace.metadata", "constructor", "__proto__"]) {
    assert.deepEqual(runtimeEventIdentities(file, row(type, { messages: [assistant()], messagesSnapshot: [assistant()] })), []);
  }
  assert.deepEqual(runtimeEventIdentities(file, row("model.completed", { messages: [assistant()], nested: { messagesSnapshot: [assistant()] } })), []);
});

test("unknown message and signature variants never supply runtime identity candidates", () => {
  const signatureControls = ["plain-signature", "{broken", '{"v":2,"id":"msg_new"}', '{"v":1,"id":42}',
    '{"v":1,"id":"msg_new","phase":"other"}', '{"v":1,"id":"earlier","id":"msg_new"}', '{"v":1,"id":""}'];
  for (const signature of signatureControls) {
    const message = assistant();
    delete message.responseId;
    message.content = [{ type: "text", text: "reply", textSignature: signature }];
    assert.deepEqual(runtimeEventIdentities(file, row("model.completed", { messagesSnapshot: [message] })), [], signature);
  }
  for (const alter of [
    message => { message.role = "user"; },
    message => { message.api = "application"; },
    message => { message.provider = null; },
    message => { message.model = ""; },
    message => { message.usage = null; },
    message => { message.content = "[Truncated]"; }
  ]) {
    const message = assistant(); alter(message);
    assert.deepEqual(runtimeEventIdentities(file, row("context.compiled", { messages: [message] })), []);
  }
  const message = assistant();
  message.responseId = " ";
  message.content = [{ type: "toolCall", id: "call_bad", name: "exec", arguments: [] },
    { type: "application", id: "call_nested", payload: assistant() }, { type: "text", text: 42, textSignature: '{"v":1,"id":"msg_bad"}' }];
  assert.deepEqual(runtimeEventIdentities(file, row("context.compiled", { messages: [message] })), []);
  for (const key of [`${runId}:application`, `${runId}:user:extra`, "not-a-uuid:user", `${runId}:user `]) {
    assert.deepEqual(runtimeEventIdentities(file, row("context.compiled", { messages: [{ role: "user", content: "payload", idempotencyKey: key }] })), []);
  }
});

test("terminal tool metadata yields only native call references in first-seen order", () => {
  const source = row("trace.artifacts", { capturedAt: "2026-10-17T15:00:01.000Z", finalStatus: "completed", toolMetas: [
    { toolName: "exec", replaySafe: false, toolCallId: "call_b", isError: true, payload: { toolCallId: "nested" } },
    { toolName: "read", replaySafe: true, toolCallId: "call_a" }, { toolName: "exec", replaySafe: false, toolCallId: "call_b" },
    { toolName: "read", toolCallId: "unrecognized" }, { toolName: null, replaySafe: true, toolCallId: "malformed" }
  ] }), before = structuredClone(source);
  assert.deepEqual(runtimeEventIdentities(file, source), [{ field: "toolCallId", id: "call_b" }, { field: "toolCallId", id: "call_a" }]);
  assert.deepEqual(source, before);
  source.values.event_json.value.data.capturedAt = "not native time";
  assert.deepEqual(runtimeEventIdentities(file, source), []);
});
