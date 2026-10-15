import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionInput, prepareAutomaticCompaction, CompactionInputError } from "../support/automatic-compaction.mjs";

const key = "agent:main:threshold";
const session = (headroom = 4978) => ({ key, sessionId: "window", contextBudgetStatus: { sessionId: "window", estimatedPromptTokens: 76000 - headroom, promptBudgetBeforeReserve: 76000, route: "fits", shouldCompact: false } });
const record = (seq, id, extra = {}) => ({ seq, sessionId: "window", event: { type: "compaction", id, ...extra } });
const stored = (events = []) => ({ key, sessionId: "window", events });
const prepare = async (before, after, description = session()) => {
  let reads = 0;
  return prepareAutomaticCompaction({ key, state: "/fixture", message: "Reply KOVA_AGENT_OK.",
    request: async (method, params) => { assert.equal(method, "sessions.describe"); assert.deepEqual(params, { key }); return { session: description }; },
    readSession: async (state, selected) => { assert.equal(state, "/fixture"); assert.equal(selected, key); return reads++ === 0 ? before : after; }
  });
};

test("compaction input crosses the measured headroom and preserves the reply instruction", () => {
  for (const headroom of [0, 300, 4978, 20000]) {
    const result = compactionInput(session(headroom), key, "Reply KOVA_AGENT_OK.");
    assert.equal(result.headroom, headroom);
    assert.ok(result.fillerCharacters / 4 > headroom);
    assert.equal(result.inputCharacters, result.message.length);
    assert.ok(result.message.endsWith("\nReply KOVA_AGENT_OK."));
    assert.ok(result.message.length <= 1000000);
  }
});

test("invalid, stale or excessive budgets refuse before constructing input", () => {
  for (const edit of [
    (s) => { s.key = "agent:main:other"; },
    (s) => { s.contextBudgetStatus.sessionId = "old-window"; },
    (s) => { s.contextBudgetStatus.estimatedPromptTokens = NaN; },
    (s) => { s.contextBudgetStatus.estimatedPromptTokens = -1; },
    (s) => { s.contextBudgetStatus.promptBudgetBeforeReserve = 100; },
    (s) => { s.contextBudgetStatus.promptBudgetBeforeReserve = 1000000; },
    (s) => { s.contextBudgetStatus.shouldCompact = true; },
    (s) => { s.contextBudgetStatus.route = "compact"; },
  ]) {
    const value = session(); edit(value);
    assert.throws(() => compactionInput(value, key, "Reply."), CompactionInputError);
  }
});

test("a completed turn must add a fresh native compaction after the observed sequence", async () => {
  const before = stored([record(2, "old"), { seq: 10, event: { type: "message", id: "last" } }]);
  const after = stored([...before.events, record(11, "new")]);
  const control = await prepare(before, after);
  const result = await control.finish("submitted-run");
  assert.equal(result.runId, "submitted-run");
  assert.deepEqual(result.newEntryIds, ["new"]);
  assert.equal(result.newAutomaticCompactions, 1);
  assert.equal(result.before.compactions, 1);
  assert.equal(result.after.compactions, 2);
  assert.equal(result.before.lastSeq, 10);
  assert.equal(result.message, undefined);
  for (const events of [before.events, [...before.events, record(11, "old")], [...before.events, record(11, "hook", { fromHook: true })], [...before.events, record(9, "earlier")]]) {
    const failed = await prepare(before, stored(events));
    await assert.rejects(failed.finish("submitted-run"), (error) => error.compaction.newAutomaticCompactions === 0 && /without a new native/.test(error.message));
  }
});

test("session identity changes cannot satisfy the compaction assertion", async () => {
  await assert.rejects(prepare({ ...stored(), sessionId: "other" }, stored()), CompactionInputError);
  const control = await prepare(stored(), { ...stored([record(1, "new")]), sessionId: "other" });
  await assert.rejects(control.finish("submitted-run"), /identity changed/);
});
