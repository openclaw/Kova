import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeOpaqueValue, runtimeEventContent, runtimeEventFile, runtimeEventSignature, runtimeEventEvidence, createCompletionObservations } from "../src/verify/runtime-events.mjs";
import { VerifiedValue } from "../src/verify/measurements.mjs";

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

function capturedWait(clock, form = "direct", child = "child-run", outcome = "ok") {
  const details = { status: "ok", action: "wait", reason: "completed",
    runs: [{ runId: child, sessionKey: `agent:main:${child}`, status: "terminal", outcome: { status: outcome }, deliveryStatus: "pending", startedAt: clock, endedAt: clock + 100 }],
    completed: [child], attention: [] };
  const result = { details, content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
  const message = { role: "toolResult", toolName: "subagents", toolCallId: "call-a", isError: false, timestamp: 50, ...result };
  if (form === "text-only") delete message.details;
  if (form === "wrapped") {
    const wrapper = { tool: { id: "openclaw:core:subagents", name: "subagents", source: "openclaw" }, result };
    message.toolName = "tool_call"; message.details = wrapper;
    message.content = [{ type: "text", text: JSON.stringify(wrapper, null, 2) }];
  }
  return message;
}

test("native runtime snapshots reuse guarded wait projections with typed clocks and one identity pass", () => {
  const types = [["context.compiled", "messages"], ["prompt.submitted", "messages"], ["model.completed", "messagesSnapshot"]];
  const forms = ["direct", "text-only", "wrapped", ...["runtime", "transcript"].flatMap(route =>
    ["whole", "result", "nested-details", "nested-content", "depth", "tool", "absent"].map(crop => `cropped-${route}-${crop}`))];
  for (const [type, field] of types) for (const form of forms) {
    const normalize = value => value.includes("child-run") ? value.replaceAll("child-run", "normalized-child")
      : value.includes("changed-child") ? value.replaceAll("changed-child", "normalized-child") : value.replaceAll("normalized-child", "normalized-twice");
    const cropped = form.startsWith("cropped-"), wrapped = cropped || form === "wrapped";
    const make = (clock, child = "child-run", outcome = "ok") => {
      const message = capturedWait(clock, cropped ? "wrapped" : form, child, outcome);
      if (cropped) {
        const payload = JSON.parse(message.content[0].text), { id, name, source } = payload.tool;
        payload.tool = { source, id, name };
        message.content[0].text = JSON.stringify(payload, null, form.startsWith("cropped-runtime-") ? 2 : undefined);
        Object.assign(message.details.tool, { description: "Wait for child results", input: "{action,runIds}", sourceName: "core" });
        if (form.endsWith("-absent")) delete message.details;
        else if (form.endsWith("-whole")) message.details = "[Truncated]";
        else if (form.endsWith("-result")) message.details.result = "[Truncated]";
        else if (form.endsWith("-nested-details")) message.details.result.details = "[Truncated]";
        else if (form.endsWith("-nested-content")) message.details.result.content = "[Truncated]";
        else if (form.endsWith("-depth")) message.details.result.details.runs = { truncated: true, reason: "trajectory-depth-limit", limitDepth: 6 };
        else { message.details.tool = "[Truncated]"; message.details.result = "[Truncated]"; }
      }
      return runtimeRow({ event: { type }, data: { [field]: [message], application: { startedAt: 12 } } });
    };
    const project = (row, report) => {
      let evidence;
      if (cropped) {
        const message = structuredClone(row.values.event_json.value.data[field][0]);
        message.details = JSON.parse(message.content[0].text);
        Object.assign(message.details.tool, { description: "Wait for child results", input: "{action,runIds}", sourceName: "core" });
        const companion = runtimeRow({ run: "prior-run", data: { messages: [message] } });
        evidence = runtimeEventEvidence({ ...file, rows: function* () {
          yield row;
          if (form.startsWith("cropped-runtime-")) { yield companion; yield companion; }
        } }, function* (sessions) {
          assert.deepEqual([...sessions], ["session-a"]);
          if (form.startsWith("cropped-transcript-")) yield { sessionId: "session-a", message };
        });
      }
      return runtimeEventContent(file, row, { normalize, report, evidence });
    };
    const row = make(100), original = structuredClone(row), audit = [];
    const first = project(row, item => audit.push(item));
    const signatures = [first, ...[200, 200, 300, 400].map(clock => project(make(clock, "changed-child")))].map(runtimeEventSignature);
    assert.equal(new Set(signatures).size, 1, `${type}/${form}: all five copies differ only in clocks and declared identities`);
    assert.ok(!signatures[0].includes("normalized-twice"));
    assert.equal(first.event_json.data[field][0].toolCallId, "call-a");
    assert.equal(first.event_json.data[field][0].toolName, wrapped ? "tool_call" : "subagents");
    if (form.endsWith("-absent")) {
      assert.equal(Object.hasOwn(first.event_json.data[field][0], "details"), false);
      assert.ok(!audit.some(item => item.at.startsWith(`event_json/data/${field}/0/details`)));
    }
    if (cropped) {
      const cuts = (value, path = []) => value === "[Truncated]" || value?.reason === "trajectory-depth-limit" ? [path]
        : value && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => cuts(child, [...path, key])) : [];
      for (const path of cuts(original.values.event_json.value.data[field][0].details)) {
        const at = value => path.reduce((parent, key) => parent[key], value);
        assert.deepEqual(at(first.event_json.data[field][0].details), at(original.values.event_json.value.data[field][0].details));
      }
    }
    assert.deepEqual(first.event_json.data.application, { startedAt: 12 });
    assert.deepEqual(row, original);
    const textAudit = audit.find(item => item.reason === "native captured message measurements" && item.at === `event_json/data/${field}/0/content/0/text`);
    assert.equal(textAudit.before, original.values.event_json.value.data[field][0].content[0].text);
    assert.ok(textAudit.after instanceof VerifiedValue, "the inventory retains the typed projection boundary");
    assert.notEqual(signatures[0], runtimeEventSignature(project(make(200, "changed-child", "error"))), "outcomes remain evidence");
    const extra = make(100); extra.values.event_json.value.data[field].push(structuredClone(extra.values.event_json.value.data[field][0]));
    assert.notEqual(runtimeEventSignature(first), runtimeEventSignature(project(extra)), "message multiplicity remains evidence");
  }
});

test("native runtime snapshot wait projections retain malformed text, clocks and foreign owners", () => {
  for (const [type, field] of [["context.compiled", "messages"], ["prompt.submitted", "messages"], ["model.completed", "messagesSnapshot"]]) {
    const make = message => runtimeRow({ event: { type }, data: { [field]: [message] } });
    const baseline = runtimeEventSignature(runtimeEventContent(file, make(capturedWait(100))));
    for (const clock of [null, -1, "<time>", "100ms"]) {
      const message = capturedWait(100);
      message.details.runs[0].startedAt = clock;
      message.content[0].text = JSON.stringify(message.details);
      assert.notEqual(runtimeEventSignature(runtimeEventContent(file, make(message))), baseline, `${type}: ${clock}`);
    }
    for (const mode of ["text-marker", "duplicate", "unsafe", "unknown-tool", "missing-call", "user"]) {
      const message = capturedWait(100), text = JSON.parse(message.content[0].text);
      if (mode === "text-marker") text.runs[0].startedAt = "<time>";
      message.content[0].text = JSON.stringify(text);
      if (mode === "duplicate") message.content[0].text = message.content[0].text.replace('"startedAt":100', '"startedAt":1,"startedAt":100');
      if (mode === "unsafe") message.content[0].text = message.content[0].text.replace('"startedAt":100', '"startedAt":9007199254740993');
      if (mode === "unknown-tool") message.toolName = "application";
      if (mode === "missing-call") delete message.toolCallId;
      if (mode === "user") message.role = "user";
      const result = runtimeEventContent(file, make(message));
      assert.equal(result.event_json.data[field][0].content[0].text, message.content[0].text, `${type}/${mode}: opaque text stays literal`);
      assert.notEqual(runtimeEventSignature(result), baseline);
    }
    const differingOutcome = capturedWait(100), text = JSON.parse(differingOutcome.content[0].text);
    text.runs[0].outcome.status = "error";
    differingOutcome.content[0].text = JSON.stringify(text);
    assert.notEqual(runtimeEventSignature(runtimeEventContent(file, make(differingOutcome))), baseline, "text outcome remains evidence independently of details");
    const foreign = make(capturedWait(100)); foreign.values.event_json.value.source = "application";
    const audit = [], unchanged = runtimeEventContent(file, foreign, { report: item => audit.push(item) });
    assert.deepEqual(unchanged.event_json.data[field][0], foreign.values.event_json.value.data[field][0]);
    assert.deepEqual(audit, []);
    for (const route of ["runtime", "transcript"]) for (const shape of ["cropped", "absent"]) for (const mode of ["missing", "session", "call", "clock", "error", "owner", "id", "malformed-clock", "literal-clock", "duplicate", "unsafe", "content-outcome", "extra-content", "unknown-text-field", "ambiguous", "ambiguous-metadata", "undefined-details", "null-details", "partial-result", "partial-metadata", "partial-depth", "partial-scalar", "partial-missing"]) {
      const complete = capturedWait(100, "wrapped"), captured = structuredClone(complete);
      if (shape === "absent") delete captured.details;
      else captured.details = "[Truncated]";
      let sessionId = "session-a";
      if (mode === "session") sessionId = "other-session";
      if (mode === "call") complete.toolCallId = "other-call";
      if (mode === "clock") complete.timestamp++;
      if (mode === "error") complete.isError = true;
      if (["owner", "id", "malformed-clock", "literal-clock"].includes(mode)) {
        if (mode === "owner") complete.details.tool.source = "application";
        if (mode === "id") complete.details.tool.id = "openclaw:plugin:subagents";
        if (mode.endsWith("clock")) {
          complete.details.result.details.runs[0].startedAt = mode === "literal-clock" ? "<time>" : -1;
          complete.details.result.content[0].text = JSON.stringify(complete.details.result.details);
        }
        complete.content[0].text = JSON.stringify(complete.details);
        captured.content = structuredClone(complete.content);
      }
      if (mode === "duplicate") captured.content[0].text = captured.content[0].text.replace('"startedAt": 100', '"startedAt": 1, "startedAt": 100');
      if (mode === "unsafe") captured.content[0].text = captured.content[0].text.replace('"startedAt": 100', '"startedAt": 9007199254740993');
      if (mode === "content-outcome") captured.content[0].text = capturedWait(100, "wrapped", "child-run", "error").content[0].text;
      if (mode === "extra-content") captured.content.push({ type: "text", text: "application output" });
      if (mode === "unknown-text-field") {
        complete.content[0].text = JSON.stringify({ ...JSON.parse(complete.content[0].text), extra: "application" });
        captured.content = structuredClone(complete.content);
      }
      if (mode === "undefined-details") captured.details = undefined;
      if (mode === "null-details") captured.details = null;
      if (mode.startsWith("partial-")) {
        captured.details = structuredClone(complete.details);
        captured.details.result.content = "[Truncated]";
        if (mode === "partial-result") captured.details.result.details.runs[0].outcome.status = "error";
        if (mode === "partial-metadata") captured.details.tool.description = "different catalog entry";
        if (mode === "partial-depth") captured.details.result = { truncated: true, reason: "trajectory-depth-limit", limitDepth: 6 };
        if (mode === "partial-scalar") captured.details.result.details.status = "[Truncated]";
        if (mode === "partial-missing") delete captured.details.result.details;
      }
      const row = make(captured), sources = mode === "missing" ? [] : [complete];
      if (mode === "ambiguous") sources.push(capturedWait(100, "wrapped", "child-run", "error"));
      if (mode === "ambiguous-metadata") {
        const other = structuredClone(complete); other.details.tool.description = "different catalog entry";
        sources.push(other);
      }
      const evidence = runtimeEventEvidence({ ...file, rows: function* () {
        yield row;
        if (route === "runtime") for (const message of sources) yield runtimeRow({ session: sessionId, data: { messages: [message] } });
      } }, function* () {
        if (route === "transcript") for (const message of sources) yield { sessionId, message };
      });
      const observed = runtimeEventContent(file, row, { evidence }).event_json.data[field][0];
      assert.deepEqual(observed.content, captured.content, `${type}/${route}/${shape}/${mode}: uncorroborated content stays literal`);
      assert.deepEqual(observed.details, captured.details);
      assert.equal(Object.hasOwn(observed, "details"), Object.hasOwn(captured, "details"));
    }
    for (const shape of ["cropped", "absent"]) {
      const complete = capturedWait(100, "wrapped"), captured = { ...structuredClone(complete), details: "[Truncated]" };
      if (shape === "absent") delete captured.details;
      const cropped = make(captured), source = runtimeRow({ event: { source: "application" }, data: { messages: [complete] } });
      const evidence = runtimeEventEvidence({ ...file, rows: function* () { yield cropped; yield source; } });
      assert.deepEqual(runtimeEventContent(file, cropped, { evidence }).event_json.data[field][0].content, captured.content, "foreign runtime event cannot corroborate content");
    }
  }
});

test("native runtime snapshots project exact nested activity before its outer timestamp", () => {
  const make = (clock, malformed = false) => {
    const result = capturedWait(clock), scope = "ad52f720-799d-4c3b-9e01-4ca6339c00df";
    const message = { role: "custom", customType: "openclaw.nested-tool.v1", display: true, excludeFromContext: true, content: "", timestamp: clock,
      idempotencyKey: `${scope}:nested-call`, details: { runId: "parent-run", scopeId: scope, afterEntryId: "parent-entry", startOrder: 0,
        parentToolCallId: "parent-call", toolCallId: "nested-call", toolName: "subagents", input: { action: "wait", runIds: ["child-run"] },
        result: { details: result.details, content: result.content }, isError: false, startedAt: clock, timestamp: clock + 100 } };
    if (malformed) message.details.startedAt++;
    return runtimeRow({ event: { type: "model.completed" }, data: { messagesSnapshot: [message] } });
  };
  const audit = [], before = runtimeEventContent(file, make(100), { report: item => audit.push(item) });
  assert.equal(runtimeEventSignature(before), runtimeEventSignature(runtimeEventContent(file, make(200))));
  const message = before.event_json.data.messagesSnapshot[0];
  assert.ok(message.timestamp instanceof VerifiedValue);
  assert.ok(message.details.startedAt instanceof VerifiedValue);
  assert.ok(message.details.timestamp instanceof VerifiedValue);
  assert.equal(message.details.scopeId, "ad52f720-799d-4c3b-9e01-4ca6339c00df");
  assert.deepEqual(message.details.input, { action: "wait", runIds: ["child-run"] });
  assert.equal(audit.filter(item => item.at === "event_json/data/messagesSnapshot/0/timestamp").length, 1, "outer clock is projected exactly once");
  const invalid = make(100, true), observed = runtimeEventContent(file, invalid);
  assert.equal(observed.event_json.data.messagesSnapshot[0].details.startedAt, 101);
  assert.equal(observed.event_json.data.messagesSnapshot[0].details.result.content[0].text, invalid.values.event_json.value.data.messagesSnapshot[0].details.result.content[0].text);
  assert.notEqual(runtimeEventSignature(before), runtimeEventSignature(observed));
});

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

test("native trajectory captures normalize only their producer-owned observation timestamps", () => {
  const timestamp = 1792250776676;
  const messages = [
    { role: "user", content: "keep this prompt", timestamp },
    { role: "custom", customType: "openclaw.runtime-context", content: "context", display: false, timestamp, details: { timestamp, blockChars: 360 } },
    { role: "assistant", content: [{ type: "text", text: "reply", timestamp }], api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: {}, stopReason: "stop", timestamp,
      diagnostics: [{ type: "openai_responses_terminal", timestamp, details: { eventType: "response.completed", stopReason: "stop", timestamp } }, { type: "application", timestamp }] },
    { role: "toolResult", toolCallId: "call-a", toolName: "exec", content: [], isError: false, timestamp, details: { timestamp } }
  ];
  for (const [type, field] of [["context.compiled", "messages"], ["prompt.submitted", "messages"], ["model.completed", "messagesSnapshot"]]) {
    const row = runtimeRow({ event: { type }, data: { [field]: messages, timedOut: false, blockChars: 360 } });
    const before = structuredClone(row), audit = [];
    const result = runtimeEventContent(file, row, { report: item => audit.push(item) });
    const next = result.event_json.data[field];
    assert.ok(next.every(message => message.timestamp.value === "<time>"));
    assert.equal(next[2].diagnostics[0].timestamp.value, "<time>");
    assert.equal(next[2].diagnostics[0].details.stopReason, "stop");
    assert.equal(next[2].diagnostics[0].details.timestamp, timestamp);
    assert.equal(next[2].diagnostics[1].timestamp, timestamp);
    assert.equal(next[2].content[0].timestamp, timestamp);
    assert.deepEqual(next[1].details, { timestamp, blockChars: 360 });
    assert.equal(next[3].details.timestamp, timestamp);
    assert.equal(result.event_json.data.timedOut, false);
    assert.equal(result.event_json.data.blockChars, 360);
    assert.deepEqual(row, before);
    const observed = audit.filter(item => item.at.startsWith(`event_json/data/${field}/`));
    assert.equal(observed.length, 5);
    assert.ok(observed.every(item => item.category === "measurements" && item.before === timestamp && item.after.value === "<time>"));
    const later = structuredClone(row);
    for (const message of later.values.event_json.value.data[field]) message.timestamp++;
    later.values.event_json.value.data[field][2].diagnostics[0].timestamp++;
    assert.equal(runtimeEventSignature(result), runtimeEventSignature(runtimeEventContent(file, later)));
    later.values.event_json.value.data.blockChars = 358;
    assert.notEqual(runtimeEventSignature(result), runtimeEventSignature(runtimeEventContent(file, later)));
  }
  for (const type of ["trace.metadata", "trace.artifacts"]) {
    const row = runtimeRow({ event: { type }, data: { capturedAt: "2026-10-17T15:26:16.433Z", extra: { capturedAt: "2026-10-17T15:26:16.433Z" }, finalStatus: "completed" } });
    const audit = [], result = runtimeEventContent(file, row, { report: item => audit.push(item) });
    assert.equal(result.event_json.data.capturedAt.value, "<time>");
    assert.deepEqual(result.event_json.data.extra, row.values.event_json.value.data.extra);
    assert.equal(result.event_json.data.finalStatus, "completed");
    assert.ok(audit.some(item => item.at === "event_json/data/capturedAt" && item.category === "measurements" && item.after.value === "<time>"));
  }
});

test("runtime observation rules preserve malformed, unknown and application timestamp fields", () => {
  for (const capturedAt of [null, 1792250776676, "invalid", "2026-10-17 15:26:16Z", "2026-02-30T00:00:00.000Z"]) {
    const row = runtimeRow({ event: { type: "trace.metadata" }, data: { capturedAt } });
    assert.equal(runtimeEventContent(file, row).event_json.data.capturedAt, capturedAt);
  }
  for (const timestamp of [null, "1792250776676", -1, 1.5, 9007199254740991]) {
    const row = runtimeRow({ event: { type: "prompt.submitted" }, data: { messages: [{ role: "user", content: "prompt", timestamp }] } });
    assert.equal(runtimeEventContent(file, row).event_json.data.messages[0].timestamp, timestamp);
  }
  const data = { capturedAt: "2026-10-17T15:26:16.433Z", messages: [{ role: "user", content: "prompt", timestamp: 1792250776676 }], timestamp: 1792250776676 };
  for (const overrides of [{ type: "application" }, { type: "context.compiled", source: "other" }, { type: "context.compiled", sessionId: "wrong-session" }]) {
    const row = runtimeRow({ event: overrides, data });
    assert.deepEqual(runtimeEventContent(file, row).event_json.data, data);
  }
  const malformed = [{ role: "user", timestamp: 1792250776676 }, { role: "assistant", content: [], timestamp: 1792250776676 }, { role: "application", content: "data", timestamp: 1792250776676 }];
  const row = runtimeRow({ event: { type: "context.compiled" }, data: { messages: malformed, other: { messages: data.messages }, capturedAt: data.capturedAt } });
  assert.deepEqual(runtimeEventContent(file, row).event_json.data, row.values.event_json.value.data);
});

test("cropped runtime clocks require a complete same-session native companion", () => {
  const message = { role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: {}, stopReason: "stop", responseId: "response-a", timestamp: 1000,
    diagnostics: [{ type: "openai_responses_terminal", timestamp: 999, details: { eventType: "response.completed", stopReason: "stop" } }] };
  const complete = runtimeRow({ data: { messages: [message] } });
  const cropped = runtimeRow({ event: { type: "model.completed" }, data: { messagesSnapshot: [{ ...message, usage: "[Truncated]", diagnostics: [{ ...message.diagnostics[0], details: "[Truncated]" }] }] } });
  const evidenceFor = rows => runtimeEventEvidence({ ...file, rows: function* () { yield* rows; } });
  const audit = [], evidence = evidenceFor([cropped, complete]);
  const observed = runtimeEventContent(file, cropped, { evidence, report: item => audit.push(item) }).event_json.data.messagesSnapshot[0];
  assert.equal(observed.timestamp.value, "<time>");
  assert.equal(observed.diagnostics[0].timestamp.value, "<time>");
  assert.equal(observed.usage, "[Truncated]");
  assert.equal(observed.diagnostics[0].details, "[Truncated]");
  assert.equal(audit.filter(item => item.reason.includes("observation time") && item.at.includes("messagesSnapshot")).length, 2);
  for (const mode of ["missing", "session", "response", "clock", "model", "malformed", "unknown"]) {
    const source = structuredClone(complete);
    if (mode === "session") { source.values.session_id = cell("other"); source.values.event_json.value.sessionId = "other"; source.values.event_json.value.traceId = "other"; }
    if (mode === "response") source.values.event_json.value.data.messages[0].responseId = "other";
    if (mode === "clock") source.values.event_json.value.data.messages[0].timestamp++;
    if (mode === "model") source.values.event_json.value.data.messages[0].model = "other";
    if (mode === "malformed") source.values.event_json.value.data.messages[0].usage = "[Truncated]";
    if (mode === "unknown") source.values.event_json.value.type = "application";
    const actual = runtimeEventContent(file, cropped, { evidence: evidenceFor(mode === "missing" ? [cropped] : [cropped, source]) }).event_json.data.messagesSnapshot[0];
    assert.equal(actual.timestamp, 1000, mode);
    assert.equal(actual.diagnostics[0].timestamp, 999, mode);
  }
  const otherDiagnostic = structuredClone(cropped); otherDiagnostic.values.event_json.value.data.messagesSnapshot[0].diagnostics[0].timestamp++;
  assert.equal(runtimeEventContent(file, otherDiagnostic, { evidence }).event_json.data.messagesSnapshot[0].diagnostics[0].timestamp, 1000);
  const baseline = runtimeEventSignature(runtimeEventContent(file, cropped, { evidence }));
  for (const mode of ["missing-terminal", "missing-both", "null-terminal", "literal-terminal"]) {
    const other = structuredClone(cropped), message = other.values.event_json.value.data.messagesSnapshot[0];
    if (mode.startsWith("missing")) delete message.diagnostics[0].timestamp;
    if (mode === "missing-both") delete message.timestamp;
    if (mode === "null-terminal") message.diagnostics[0].timestamp = null;
    if (mode === "literal-terminal") message.diagnostics[0].timestamp = "<time>";
    assert.notEqual(runtimeEventSignature(runtimeEventContent(file, other, { evidence })), baseline, mode);
  }
});

test("native runtime clock presence survives measurement normalization", () => {
  const cases = [
    ["trace.metadata", { capturedAt: "2026-10-17T15:00:00.000Z" }, ["capturedAt"]],
    ["trace.artifacts", { capturedAt: "2026-10-17T15:00:00.000Z" }, ["capturedAt"]],
    ["model.completed", { promptCache: { lastCacheTouchAt: 1000 } }, ["promptCache", "lastCacheTouchAt"]],
    ["context.compiled", { messages: [{ role: "user", content: "prompt", timestamp: 1000 }] }, ["messages", 0, "timestamp"]],
    ["model.completed", { messagesSnapshot: [{ role: "assistant", api: "openai-responses", provider: "openai", model: "model-a", usage: {}, stopReason: "stop", content: [], timestamp: 1000,
      diagnostics: [{ type: "openai_responses_terminal", timestamp: 999, details: { eventType: "response.completed", stopReason: "stop" } }] }] }, ["messagesSnapshot", 0, "diagnostics", 0, "timestamp"]]
  ];
  for (const [type, data, path] of cases) {
    const baseline = runtimeEventSignature(runtimeEventContent(file, runtimeRow({ event: { type }, data })));
    for (const value of [undefined, null, "<time>", { value: "<time>" }, { verifiedDerived: "<time>" }]) {
      const other = structuredClone(data), owner = path.slice(0, -1).reduce((object, key) => object[key], other), key = path.at(-1);
      if (value === undefined) delete owner[key]; else owner[key] = value;
      assert.notEqual(runtimeEventSignature(runtimeEventContent(file, runtimeRow({ event: { type }, data: other }))), baseline, `${type}/${path.join("/")}/${JSON.stringify(value)}`);
    }
  }
});

test("heartbeat prompt clocks require a unique native start in the same session and run", () => {
  const body = minute => `Read HEARTBEAT.md.\nCurrent time: Saturday, October 17th, 2026 - 5:${minute} PM (Europe/Paris)\nReference UTC: 2026-10-17 15:${minute} UTC`;
  const start = runtimeRow({ event: { type: "session.started", sessionKey: "agent:main:main:heartbeat" }, data: { trigger: "heartbeat", sessionFile: "agent:main:main:heartbeat" } });
  const prompt = minute => runtimeRow({ event: { sessionKey: "agent:main:main:heartbeat" }, data: { prompt: body(minute), messages: [], application: body("31") } });
  const evidenceFor = rows => runtimeEventEvidence({ ...file, rows: function* () { yield* rows; } });
  const evidence = evidenceFor([prompt("31"), start]);
  const before = runtimeEventContent(file, prompt("31"), { evidence }), after = runtimeEventContent(file, prompt("32"), { evidence });
  assert.equal(runtimeEventSignature(before), runtimeEventSignature(after));
  assert.equal(before.event_json.data.application, body("31"));
  for (const mode of ["missing", "duplicate", "run", "session", "trigger", "file", "key", "foreign"]) {
    const source = structuredClone(start);
    if (mode === "run") { source.values.run_id = cell("other"); source.values.event_json.value.runId = "other"; }
    if (mode === "session") { source.values.session_id = cell("other"); source.values.event_json.value.sessionId = "other"; source.values.event_json.value.traceId = "other"; }
    if (mode === "trigger") source.values.event_json.value.data.trigger = "user";
    if (mode === "file") source.values.event_json.value.data.sessionFile = "application";
    if (mode === "key") source.values.event_json.value.sessionKey = "other";
    if (mode === "foreign") source.values.event_json.value.source = "application";
    const evidence = evidenceFor(mode === "missing" ? [] : mode === "duplicate" ? [source, source] : [source]);
    assert.equal(runtimeEventContent(file, prompt("31"), { evidence }).event_json.data.prompt, body("31"), mode);
  }
});

test("native completion captures normalize cache touch time while retaining cache behavior", () => {
  const promptCache = { lastCacheTouchAt: 1792250768158, retention: "short", lastCallUsage: { cacheRead: 30 }, observation: { broke: true, changes: [{ code: "system-prompt", detail: "changed" }] } };
  for (const type of ["model.completed", "trace.artifacts"]) {
    const row = runtimeRow({ event: { type }, data: { promptCache, application: { promptCache }, timedOut: true } });
    const audit = [], result = runtimeEventContent(file, row, { report: item => audit.push(item) });
    const { lastCacheTouchAt, ...retained } = promptCache;
    assert.equal(result.event_json.data.promptCache.lastCacheTouchAt.value, "<time>");
    const { lastCacheTouchAt: observed, ...actual } = result.event_json.data.promptCache;
    assert.deepEqual(actual, retained);
    assert.deepEqual(result.event_json.data.application, { promptCache });
    assert.equal(result.event_json.data.timedOut, true);
    assert.ok(audit.some(item => item.at === "event_json/data/promptCache/lastCacheTouchAt" && item.before === lastCacheTouchAt && item.category === "measurements" && item.after.value === "<time>"));
    for (const value of [null, "1792250768158", -1, 1.5]) {
      const malformed = runtimeRow({ event: { type }, data: { promptCache: { ...promptCache, lastCacheTouchAt: value } } });
      assert.equal(runtimeEventContent(file, malformed).event_json.data.promptCache.lastCacheTouchAt, value);
    }
  }
  for (const type of ["context.compiled", "application"]) {
    const row = runtimeRow({ event: { type }, data: { promptCache } });
    assert.deepEqual(runtimeEventContent(file, row).event_json.data.promptCache, promptCache);
  }
});

test("native metadata replaces only exact recorded clone port bindings", () => {
  const config = { redacted: { gateway: { port: 21786, bind: "loopback" }, models: { providers: {
    openai: { baseUrl: "http://127.0.0.1:62434/v1?mode=kept#fragment", api: "openai-responses" },
    local: { baseUrl: "https://[::1]:443/api" },
    named: { baseUrl: "http://localhost:62435/v1" }
  } } } };
  const observationBindings = { gatewayPort: 21786, providerBaseUrls: Object.fromEntries(Object.entries(config.redacted.models.providers).map(([name, provider]) => [name, provider.baseUrl])) };
  const row = runtimeRow({ event: { type: "trace.metadata" }, data: { config, application: { config }, responseId: "historical-response" } });
  const before = structuredClone(row), audit = [];
  const result = runtimeEventContent(file, row, { observationBindings, report: item => audit.push(item) });
  assert.equal(result.event_json.data.config.redacted.gateway.port.value, "<port:gateway>");
  assert.equal(result.event_json.data.config.redacted.gateway.bind, "loopback");
  assert.equal(result.event_json.data.config.redacted.models.providers.openai.baseUrl.value, "http://127.0.0.1:<port:provider:openai>/v1?mode=kept#fragment");
  assert.equal(result.event_json.data.config.redacted.models.providers.openai.api, "openai-responses");
  assert.equal(result.event_json.data.config.redacted.models.providers.local.baseUrl.value, "https://[::1]:<port:provider:local>/api");
  assert.equal(result.event_json.data.config.redacted.models.providers.named.baseUrl.value, "http://localhost:<port:provider:named>/v1");
  assert.deepEqual(result.event_json.data.application.config, config);
  assert.equal(result.event_json.data.responseId, "historical-response");
  assert.deepEqual(row, before);
  assert.equal(audit.filter(item => item.category === "declaredIds").length, 4);
  assert.deepEqual(runtimeEventContent(file, row).event_json.data.config, config);
  for (const field of ["port", "url"]) {
    const malformed = structuredClone(row);
    malformed.values.event_json.value.data.config = structuredClone(config);
    const target = malformed.values.event_json.value.data.config.redacted;
    if (field === "port") target.gateway.port = "<port:gateway>";
    else target.models.providers.openai.baseUrl = "http://127.0.0.1:<port:provider:openai>/v1?mode=kept#fragment";
    const literal = runtimeEventContent(file, malformed, { observationBindings });
    assert.equal(JSON.stringify(literal), JSON.stringify(result), "display tokens alone do not establish verified identity");
    assert.notEqual(runtimeEventSignature(literal), runtimeEventSignature(result), field);
  }
});

test("runtime port bindings preserve other destinations, malformed values and historical configuration", () => {
  const urls = ["http://example.com:62434/v1", "http://127.0.0.1/v1", "http://127.0.0.1:70000/v1", "http://127.0.0.1:0/v1", "ftp://127.0.0.1:62434/v1", "http://127.0.0.1:62434\\other/v1", "http://127.0.0.1:62434/v1\n", "not a URL", null];
  for (const baseUrl of urls) {
    const config = { redacted: { gateway: { port: "21786" }, models: { providers: { openai: { baseUrl } } } } };
    const row = runtimeRow({ event: { type: "trace.metadata" }, data: { config } });
    assert.deepEqual(runtimeEventContent(file, row, { observationBindings: { gatewayPort: 21786, providerBaseUrls: { openai: baseUrl } } }).event_json.data.config, config);
  }
  const config = { redacted: { gateway: { port: 21787 }, models: { providers: { openai: { baseUrl: "http://127.0.0.1:62435/v1" } } } } };
  const observationBindings = { gatewayPort: 21786, providerBaseUrls: { openai: "http://127.0.0.1:62434/v1" } };
  const row = runtimeRow({ event: { type: "trace.metadata" }, data: { config } });
  assert.deepEqual(runtimeEventContent(file, row, { observationBindings }).event_json.data.config, config);
  const matching = { gatewayPort: 21787, providerBaseUrls: { openai: "http://127.0.0.1:62435/v1" } };
  for (const event of [{ type: "application" }, { type: "context.compiled" }, { type: "trace.metadata", sessionId: "wrong-session" }]) {
    const other = runtimeRow({ event, data: { config } });
    assert.deepEqual(runtimeEventContent(file, other, { observationBindings: matching }).event_json.data.config, config);
  }
});

test("native harness invocation normalizes only the exact bound Gateway port option", () => {
  const invocation = ["node", "openclaw.mjs", "gateway", "--port", "21786", "21786", "--port=21786", "--other=21786", "--port=21787"];
  const row = runtimeRow({ event: { type: "trace.metadata" }, data: { harness: { invocation }, application: { invocation } } });
  const audit = [], result = runtimeEventContent(file, row, { observationBindings: { gatewayPort: 21786 }, report: item => audit.push(item) });
  assert.equal(result.event_json.data.harness.invocation[4].value, "<port:gateway>");
  assert.equal(result.event_json.data.harness.invocation[6].value, "--port=<port:gateway>");
  assert.deepEqual(JSON.parse(JSON.stringify(result.event_json.data.harness.invocation)), ["node", "openclaw.mjs", "gateway", "--port", "<port:gateway>", "21786", "--port=<port:gateway>", "--other=21786", "--port=21787"]);
  assert.deepEqual(result.event_json.data.application.invocation, invocation);
  assert.deepEqual(audit.filter(item => item.category === "declaredIds").map(item => item.at), ["event_json/data/harness/invocation/4", "event_json/data/harness/invocation/6"]);
  assert.deepEqual(runtimeEventContent(file, row).event_json.data.harness.invocation, invocation);
  const literal = structuredClone(row);
  literal.values.event_json.value.data.harness.invocation = JSON.parse(JSON.stringify(result.event_json.data.harness.invocation));
  assert.notEqual(runtimeEventSignature(runtimeEventContent(file, literal, { observationBindings: { gatewayPort: 21786 } })), runtimeEventSignature(result));
  for (const event of [{ type: "application" }, { type: "trace.metadata", sessionId: "wrong-session" }]) {
    const other = runtimeRow({ event, data: { harness: { invocation } } });
    assert.deepEqual(runtimeEventContent(file, other, { observationBindings: { gatewayPort: 21786 } }).event_json.data.harness.invocation, invocation);
  }
});

test("scheduled prompt clocks require internal provenance and preserve timezone and authored text", () => {
  const text = (minute = "31", zone = "Europe/Paris") => `Do task session-a.\nCurrent time: Saturday, October 17th, 2026 - 5:${minute} PM (${zone})\nReference UTC: 2026-10-17 15:${minute} UTC\nKeep these instructions.`;
  const make = (body, provenance = { kind: "internal_system", sourceTool: "cron" }, type = "prompt.submitted") => runtimeRow({ event: { type }, data: { prompt: body, messages: [{ role: "user", content: [{ type: "text", text: body }], provenance }], application: { prompt: text() }, blockChars: 360, originalChars: 41908 } });
  const normalize = value => value.includes("session-a") ? value.replaceAll("session-a", "session-b") : value.replaceAll("session-b", "wrong-session");
  const audit = [], first = runtimeEventContent(file, make(text()), { normalize, report: item => audit.push(item) });
  const later = runtimeEventContent(file, make(text("32")), { normalize });
  assert.equal(runtimeEventSignature(first), runtimeEventSignature(later));
  assert.match(first.event_json.data.prompt.value, /session-b/);
  assert.doesNotMatch(first.event_json.data.prompt.value, /wrong-session/);
  assert.match(first.event_json.data.prompt.value, /Current time: <time> \(Europe\/Paris\)\nReference UTC: <time> UTC/);
  assert.equal(first.event_json.data.blockChars, 360);
  assert.equal(first.event_json.data.originalChars, 41908);
  assert.equal(audit.filter(item => item.category === "measurements" && item.reason === "native scheduled prompt current-time observation").length, 2);
  assert.notEqual(runtimeEventSignature(first), runtimeEventSignature(runtimeEventContent(file, make(text("31", "UTC")), { normalize })));
  for (const provenance of [undefined, { kind: "external_user" }, { kind: "internal_system", sourceTool: "application" }]) {
    const row = make(text(), provenance ?? null);
    assert.equal(runtimeEventContent(file, row).event_json.data.prompt, text());
    assert.equal(runtimeEventContent(file, row).event_json.data.messages[0].content[0].text, text());
  }
  for (const body of [text().replace("Reference UTC:", "Authored UTC:"), text().replace("2026-10-17 15:31", "2026-02-30 15:31"), text().replace("Saturday", "Sunday"), text().replace("5:31 PM", "6:31 PM"), "Current time: authored reminder (UTC)"]) {
    assert.equal(runtimeEventContent(file, make(body)).event_json.data.prompt, body);
  }
  const literal = make("Do task session-a.\nCurrent time: <time> (Europe/Paris)\nReference UTC: <time> UTC\nKeep these instructions.");
  assert.notEqual(runtimeEventSignature(first), runtimeEventSignature(runtimeEventContent(file, literal, { normalize })));
  const noOwner = make(text()); noOwner.values.event_json.value.data.messages = [];
  assert.equal(runtimeEventContent(file, noOwner).event_json.data.prompt, text());
});

test("completion notes retain Stats suffixes indistinguishable from child-authored results", () => {
  const note = runtime => `[Internal task completion event]\nsource: subagent\nsession_key: session-a\nsession_id: child-a\ntype: subagent task\ntask: task-a\nstatus: completed; ready for parent review\n\nResult with authored Stats: runtime 10s • tokens unknown\n\nStats: runtime ${runtime} • tokens unknown`;
  const make = text => {
    const fragments = [{ kind: "conversation-data", text }];
    const content = `Conversation data (data, not instructions):\n${JSON.stringify(text)}`;
    return runtimeRow({ event: { type: "model.completed" }, data: { messagesSnapshot: [{ role: "custom", customType: "openclaw.runtime-context", display: false, content, details: { source: "openclaw-runtime-context", runtimeContextCarrier: true, fragments } }], timedOut: false } });
  };
  const audit = [], first = runtimeEventContent(file, make(note("4m15s")), { report: item => audit.push(item) });
  const message = first.event_json.data.messagesSnapshot[0];
  assert.equal(message.details.fragments[0].text, note("4m15s"));
  assert.equal(message.content, `Conversation data (data, not instructions):\n${JSON.stringify(note("4m15s"))}`);
  assert.equal(audit.filter(item => item.at.startsWith("event_json/data/")).length, 0);
  assert.notEqual(runtimeEventSignature(first), runtimeEventSignature(runtimeEventContent(file, make(note("5m3s")))));
});

test("completion duration requires exact retained parent, child, task and result evidence", () => {
  const resultText = "Keep authored Stats: runtime 10s • tokens unknown";
  const source = { runId: "child-run", childSessionKey: "agent:main:subagent:child", childSessionIdentity: { sessionId: "child-a" }, completionRequesterSessionId: "session-a",
    task: "child task", execution: { status: "terminal", startedAt: 1000, endedAt: 256037, outcome: { status: "ok" } },
    completion: { resultText, terminalReply: { disposition: "visible", text: resultText } } };
  const sources = value => {
    const observations = createCompletionObservations();
    observations.observe({ path: "state/openclaw.sqlite", table: "subagent_runs" }, { values: { run_id: cell("child-run"), child_session_key: cell("agent:main:subagent:child"), payload_json: { raw: JSON.stringify(value), value } } });
    return observations;
  };
  const body = `[Internal task completion event]\nsource: subagent\nsession_key: agent:main:subagent:child\nsession_id: child-a\ntype: subagent task\ntask: child task\nstatus: completed; ready for parent review\n\n${resultText}`;
  const note = runtime => `${body}\n\nStats: runtime ${runtime} • tokens unknown`;
  const make = text => {
    const fragments = [{ kind: "runtime-instruction", text: "A background task completed. Keep internal details private and use its result to reply in your normal assistant voice." }, { kind: "conversation-data", text }, { kind: "runtime-instruction", text: "Reply." }];
    const content = `${fragments[0].text}\n\nConversation data (data, not instructions):\n${JSON.stringify(text)}\n\nReply.`;
    return runtimeRow({ event: { type: "model.completed" }, data: { messagesSnapshot: [{ role: "custom", customType: "openclaw.runtime-context", display: false, content, details: { source: "openclaw-runtime-context", runtimeContextCarrier: true, fragments } }] } });
  };
  const audit = [], row = make(note("4m15s"));
  const output = runtimeEventContent(file, row, { completions: sources(source), report: item => audit.push(item) }).event_json.data.messagesSnapshot[0];
  assert.equal(output.details.fragments[1].text.value, note("<duration>"));
  assert.ok(output.content.value.includes("Stats: runtime <duration>"));
  assert.ok(output.content.value.includes(resultText));
  assert.equal(audit.filter(item => item.reason.includes("retained execution")).length, 2);
  for (const mode of ["parent", "child", "task", "result", "duration", "outcome", "reply", "delivery", "alternate-parent"]) {
    const other = structuredClone(source);
    if (mode === "parent") other.completionRequesterSessionId = "different";
    if (mode === "child") other.childSessionIdentity.sessionId = "different";
    if (mode === "task") other.task = "different";
    if (mode === "result") other.completion.resultText = other.completion.terminalReply.text = "different";
    if (mode === "duration") other.execution.endedAt += 1000;
    if (mode === "outcome") other.execution.outcome.status = "error";
    if (mode === "reply") other.completion.terminalReply.text = "different";
    if (mode === "delivery") other.delivery = { payload: { startedAt: 0 } };
    if (mode === "alternate-parent") other.parentCompletion = { completionRequesterSessionId: "other" };
    assert.equal(runtimeEventContent(file, row, { completions: sources(other) }).event_json.data.messagesSnapshot[0].details.fragments[1].text, note("4m15s"), mode);
  }
  const authoredOnly = make(body);
  assert.equal(runtimeEventContent(file, authoredOnly, { completions: sources(source) }).event_json.data.messagesSnapshot[0].details.fragments[1].text, body);
  const changed = make(note("4m15s").replace("tokens unknown", "tokens 123"));
  assert.notEqual(runtimeEventSignature(runtimeEventContent(file, changed, { completions: sources(source) })), runtimeEventSignature(runtimeEventContent(file, row, { completions: sources(source) })));
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
