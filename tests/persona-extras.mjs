import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionExtras, checkSessionExtra, extraRequests } from "../support/persona/session-extras.mjs";

const key = "agent:main:persona-example";
const sessionId = "persisted-session-id";

function fixture(handler, fields = {}) {
  return async (request) => request.method === "sessions.describe"
    ? { session: { key, sessionId, ...fields } }
    : handler(request);
}

test("goal check returns the saved goal identity and refuses terminal goals", async () => {
  const goal = { id: "persisted-goal-id", status: "active", objective: "Keep the project notebook current." };
  const rpc = fixture(() => assert.fail("unexpected request"), { goal });
  assert.deepEqual(await checkSessionExtra({ rpc, key, kind: "session-goal-active" }), { key, goalId: goal.id });
  goal.status = "complete";
  await assert.rejects(checkSessionExtra({ rpc, key, kind: "session-goal-active" }), /goal is absent or differs/);
});

test("progress card check requires persisted plan states as well as markdown", async () => {
  const input = extraRequests.progressPut(key).params;
  const saved = { revision: 3, markdown: input.markdown, steps: input.plan };
  const rpc = fixture(async ({ method }) => {
    assert.equal(method, "progressCard.get");
    return { card: saved };
  });
  assert.deepEqual(await checkSessionExtra({ rpc, key, kind: "session-progress-card" }), { key });
  saved.steps[1].status = "completed";
  await assert.rejects(checkSessionExtra({ rpc, key, kind: "session-progress-card" }), /progress card is absent or differs/);
});

test("pending creation uses acknowledged run ids and leaves restart settlement to its caller", async () => {
  const inputs = [];
  const stopped = [];
  let sent = 0;
  const rpc = fixture(async ({ method, params }) => {
    if (method === "chat.send") {
      const runId = `acknowledged-${++sent}`;
      if (sent > 1) {
        assert.equal(params.queueMode, "followup");
        inputs.push({ runId, state: "queued", queued: true, message: { role: "user", content: params.message } });
      }
      return { runId };
    }
    if (method === "progressCard.get") return { card: { markdown: "Mock reply is streaming; completion is pending." } };
    if (method === "chat.history") return { pendingInputs: { items: inputs, total: inputs.length } };
    if (method === "chat.abort") {
      stopped.push(params.runId);
      const input = inputs.find((input) => input.runId === params.runId);
      assert.ok(input);
      input.state = "cancelled";
      delete input.queued;
      return { aborted: true };
    }
    assert.fail(`unexpected request ${method}`);
  });
  assert.deepEqual(await buildSessionExtras({ rpc, key, options: { kind: "session-interrupted-inputs" } }), { key });
  assert.deepEqual(stopped, ["acknowledged-2"]);
  await assert.rejects(checkSessionExtra({ rpc, key, kind: "session-interrupted-inputs" }), /interrupted input is absent or still queued/);
  inputs[1].state = "interrupted";
  delete inputs[1].queued;
  assert.deepEqual(await checkSessionExtra({ rpc, key, kind: "session-interrupted-inputs" }), { key });
  inputs.splice(0, 1);
  await assert.rejects(checkSessionExtra({ rpc, key, kind: "session-interrupted-inputs" }), /cancelled input is absent/);
});

test("public sharing checks never return bearer tokens or propagate token-bearing errors", async () => {
  const token = "v1.private-test-token";
  const rpc = fixture(async ({ method, params }) => {
    assert.ok(["session.publicShare.set", "session.members.list"].includes(method));
    if (method === "session.publicShare.set") assert.equal(params.expectedSessionId, sessionId);
    return { ok: true, sessionKey: key, publicShare: { token, createdAt: 1 } };
  });
  const built = await buildSessionExtras({ rpc, key, options: { kind: "session-public-shared" } });
  assert.deepEqual(built, { key });
  assert.ok(!JSON.stringify(built).includes(token));
  const rejected = fixture(async () => { throw new Error(token); });
  await assert.rejects(checkSessionExtra({ rpc: rejected, key, kind: "session-public-shared" }), (error) => !error.message.includes(token) && /could not read/.test(error.message));
});

test("idle check requires elapsed time and a saved completed turn", async () => {
  const old = Date.now() - 61000;
  const fields = { lastInteractionAt: old, updatedAt: old };
  const messages = [
    { role: "user", content: "KOVA_PERSONA_IDLE_ENTRY", timestamp: old },
    { role: "assistant", content: "KOVA_AGENT_OK", timestamp: old }
  ];
  const rpc = fixture(async ({ method }) => {
    if (method === "config.get") return { config: { session: { reset: { mode: "idle", idleMinutes: 1 } } } };
    if (method === "chat.history") return { messages };
    assert.fail(`unexpected request ${method}`);
  }, fields);
  assert.deepEqual(await checkSessionExtra({ rpc, key, kind: "session-idle-expired" }), { key });
  fields.updatedAt = Date.now();
  await assert.rejects(checkSessionExtra({ rpc, key, kind: "session-idle-expired" }), /not reached/);
  fields.updatedAt = old;
  messages.pop();
  await assert.rejects(checkSessionExtra({ rpc, key, kind: "session-idle-expired" }), /completed notebook turn/);
});
