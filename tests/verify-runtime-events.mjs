import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeOpaqueValue, runtimeEventContent, runtimeEventFile, runtimeEventSignature } from "../src/verify/runtime-events.mjs";

const file = { path: "agents/main/agent/openclaw-agent.sqlite", table: "trajectory_runtime_events" };
const cell = (value) => ({ raw: value, value });
function runtimeRow({ timestamp = "2026-10-15T18:00:00.000Z", storageSeq = 42, eventSeq = 3, rowid = 10, session = "session-a", run = "run-a", data = {}, event: overrides = {} } = {}) {
  const event = {
    traceSchema: "openclaw-trajectory", schemaVersion: 1, source: "runtime", type: "context.compiled",
    traceId: session, sessionId: session, runId: run, seq: eventSeq, sourceSeq: eventSeq, ts: timestamp,
    data, ...overrides
  };
  return { rowid, values: {
    session_id: cell(session), seq: cell(storageSeq), run_id: cell(run ?? null),
    event_json: { raw: JSON.stringify(event), value: event }, created_at: cell(Date.parse(timestamp))
  } };
}

test("runtime content ignores native storage and recorder metadata, preserving nested payload", () => {
  const data = { seq: 19, sourceSeq: 7, ts: "application timestamp", created_at: 12, originalChars: 360, blockChars: 358 };
  const baseline = runtimeRow({ data });
  const changed = runtimeRow({ data, rowid: 100, storageSeq: 72, eventSeq: 11, timestamp: "2026-10-15T19:15:01.005Z" });
  const before = structuredClone(baseline), removed = [];
  const content = runtimeEventContent(file, baseline, { report: item => removed.push(item) });
  assert.deepEqual(content, runtimeEventContent(file, changed));
  assert.deepEqual(baseline, before);
  assert.deepEqual(content.event_json.data, data);
  assert.deepEqual(Object.keys(content), ["session_id", "run_id", "event_json"]);
  assert.deepEqual(removed.map(item => item.at).sort(), ["created_at", "event_json/seq", "event_json/sourceSeq", "event_json/ts", "seq"]);
  assert.ok(removed.every(item => item.reason && item.after.absent));
  assert.equal(removed.filter(item => item.category === "derived").length, 3);
  assert.equal(removed.filter(item => item.category === "measurements").length, 2);
});

test("runtime content normalizes declared identities and ordinary keys exactly once", () => {
  const substitutions = new Map([["session-a", "session-b"], ["session-b", "wrong-session"], ["run-a", "run-b"], ["run-b", "wrong-run"], ["/source", "/normalized"], ["/normalized", "/wrong"]]);
  const data = { "session-a": ["run-a", { path: "/source" }] };
  const calls = [];
  const result = runtimeEventContent(file, runtimeRow({ data }), { normalize: (text, at) => {
    calls.push([text, at]);
    return substitutions.get(text) ?? text;
  } });
  assert.equal(result.session_id, "session-b");
  assert.equal(result.run_id, "run-b");
  assert.equal(result.event_json.sessionId, "session-b");
  assert.equal(result.event_json.traceId, "session-b");
  assert.deepEqual(result.event_json.data, { "session-b": ["run-b", { path: "/normalized" }] });
  assert.ok(calls.some(([text, at]) => text === "session-a" && at === "event_json/data/session-a"));
  assert.ok(calls.some(([text, at]) => text === "/source" && at === "event_json/data/session-a/1/path"));
});

test("runtime content retains application changes and unknown columns", () => {
  const before = runtimeRow({ data: { originalChars: 360, skills: { blockChars: 360 } } });
  const after = runtimeRow({ data: { originalChars: 358, skills: { blockChars: 358 } } });
  before.values.extra = cell({ seq: 99, ts: "user value" });
  after.values.extra = cell({ seq: 99, ts: "changed user value" });
  const content = runtimeEventContent(file, before), changed = runtimeEventContent(file, after);
  assert.equal(content.event_json.data.originalChars, 360);
  assert.equal(changed.event_json.data.skills.blockChars, 358);
  assert.deepEqual(content.extra, { seq: 99, ts: "user value" });
  assert.notDeepEqual(content, changed);
});

test("runtime content preserves malformed and inconsistent native metadata", () => {
  const cases = [
    row => { row.values.event_json.value.traceSchema = "other"; },
    row => { row.values.event_json.value.schemaVersion = 2; },
    row => { row.values.event_json.value.source = "transcript"; },
    row => { delete row.values.event_json.value.type; },
    row => { row.values.event_json.value.traceId = "another-session"; },
    row => { row.values.event_json.value.sessionId = "another-session"; },
    row => { row.values.event_json.value.runId = "another-run"; },
    row => { row.values.event_json.value.sourceSeq = 999; },
    row => { row.values.event_json.value.seq = "3"; },
    row => { row.values.seq = cell(-1); },
    row => { row.values.created_at.raw++; row.values.created_at.value++; },
    row => { row.values.event_json.value.ts = "invalid"; },
    row => { row.values.event_json.value.ts = "2026-10-15 18:00:00Z"; },
    row => { row.values.event_json = cell("{broken json"); },
    row => { delete row.values.run_id; }
  ];
  for (const change of cases) {
    const row = runtimeRow(), audit = [];
    change(row);
    const result = runtimeEventContent(file, row, { report: item => audit.push(item) });
    assert.deepEqual(result, Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, value.value])));
    assert.deepEqual(audit, []);
  }
  const wrongType = runtimeRow();
  wrongType.values.seq = { raw: "42", value: 42 };
  assert.equal(runtimeEventContent(file, wrongType).seq, "42");
});

test("runtime content preserves encoded evidence without normalizing decoder markers", () => {
  const row = runtimeRow();
  const marker = { invalidText: { sha256: "session-a" } };
  row.values.event_json = { raw: marker, value: marker, encoded: true };
  row.values.extra = { raw: { integer: "9007199254740993" }, value: { integer: "9007199254740993" }, encoded: true };
  const result = runtimeEventContent(file, row, { normalize: value => value === "session-a" ? "normalized" : value });
  assert.equal(result.session_id, "normalized");
  assert.ok(result.event_json instanceof RuntimeOpaqueValue);
  assert.equal(result.event_json.value, marker);
  assert.equal(result.seq, 42);
  assert.deepEqual(result.extra.value, { integer: "9007199254740993" });
  const literal = runtimeRow();
  literal.values.event_json = cell(marker);
  literal.values.extra = cell({ integer: "9007199254740993" });
  const encoded = runtimeEventContent(file, row), ordinary = runtimeEventContent(file, literal);
  assert.equal(JSON.stringify(encoded), JSON.stringify(ordinary));
  assert.notEqual(runtimeEventSignature(encoded), runtimeEventSignature(ordinary));
  assert.equal(runtimeEventSignature({ a: 1, b: ["x", null] }), runtimeEventSignature({ b: ["x", null], a: 1 }));
});

test("runtime content supports missing optional run ids and rejects normalized key collisions", () => {
  const row = runtimeRow({ run: undefined });
  row.values.run_id = cell(null);
  delete row.values.event_json.value.runId;
  assert.equal(runtimeEventContent(file, row).run_id, null);
  assert.equal(Object.hasOwn(runtimeEventContent(file, row), "seq"), false);
  row.values.event_json.value.data = { a: "one", b: "two" };
  assert.throws(() => runtimeEventContent(file, row, { normalize: value => ["a", "b"].includes(value) ? "same" : value }), /duplicate JSON keys/);
});

test("runtime content applies only to the native agent table", () => {
  assert.equal(runtimeEventFile(file), true);
  for (const other of [
    { ...file, path: "files/openclaw-agent.sqlite" },
    { ...file, path: "agents/main/agent/openclaw-agent.sqlite.backup" },
    { ...file, table: "trajectory_runtime_events_copy" },
    { ...file, table: "transcript_events" }
  ]) {
    assert.equal(runtimeEventFile(other), false);
    assert.equal(runtimeEventContent(other, runtimeRow()), undefined);
  }
});
