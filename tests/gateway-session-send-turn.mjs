import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../support/run-gateway-session-send-turn.mjs", import.meta.url));
let submittedRunId;
const queuedRunId = "queued-execution";

export function runGatewaySessionSendTurnChecks() {
  for (const scenario of ["stale-ack", "overflow", "early-error", "success", "new-session", "early-reply", "injected", "blank-reply", "wrong-reply", "min-count", "missing-run", "wrong-wait-run", "queued", "queued-paged", "collected", "queued-error", "queued-other-input", "queued-old-reply", "timeout"]) {
    const result = spawnSync(process.execPath, [
      "--import", fileURLToPath(import.meta.url), helper,
      "--env", "fixture", "--session-key", "existing-session",
      "--expected-text", scenario === "blank-reply" ? "" : "KOVA_AGENT_OK",
      "--create-session", scenario === "new-session" ? "true" : "false",
      "--min-assistant-count", scenario === "new-session" || scenario === "queued-paged" ? "1" : scenario === "min-count" ? "6" : "2", "--timeout", "1500"
    ], {
      encoding: "utf8", timeout: 10000,
      env: {
        ...process.env,
        KOVA_OCM_TRANSPORT_JSON: undefined,
        KOVA_NETWORK_FRONTAGE_ENABLED: "0",
        OPENCLAW_CONFIG_PATH: "/nonexistent/kova-send-turn-fixture.json",
        OPENCLAW_GATEWAY_TOKEN: "fixture",
        KOVA_SEND_TURN_FIXTURE: scenario
      }
    });
    assert.ifError(result.error);
    const receipt = JSON.parse(result.stdout);
    if (["success", "queued", "queued-paged", "collected", "new-session", "early-reply", "injected"].includes(scenario)) {
      assert.equal(result.status, 0, `${scenario}: ${receipt.error}`);
      assert.equal(receipt.ok, true);
      assert.match(receipt.runId, /^kova-gateway-session-[a-f0-9-]+$/);
      assert.equal(receipt.replyRunId, scenario.startsWith("queued") || scenario === "collected" ? queuedRunId : receipt.runId);
      assert.equal(receipt.finalAssistantVisibleText, "KOVA_AGENT_OK");
      assert.equal(receipt.assistantMessageCount, scenario === "new-session" || scenario === "queued-paged" ? 1 : 5);
      assert.ok(receipt.activeTurnMs >= 100, "wait for the submitted run to finish");
      if (scenario === "early-reply") {
        assert.ok(receipt.assistantFirstSeenAtEpochMs < receipt.activeFinishedAtEpochMs);
        assert.ok(receipt.assistantMatchedAtEpochMs < receipt.activeFinishedAtEpochMs);
      }
    } else {
      assert.equal(receipt.ok, false, `${scenario}: historical replies must never satisfy a new run`);
      assert.equal(result.status, 1);
      if (scenario === "missing-run" || scenario === "stale-ack") assert.equal(receipt.runId, null);
      else assert.match(receipt.runId, /^kova-gateway-session-[a-f0-9-]+$/);
      assert.equal(receipt.failureDomain, "openclaw");
      assert.equal(receipt.recordStatus, "FAIL");
      if (["overflow", "early-error", "queued-error"].includes(scenario)) assert.equal(receipt.error, "context overflow from submitted run");
      if (["wrong-reply", "blank-reply", "min-count", "queued-other-input", "queued-old-reply"].includes(scenario)) assert.match(receipt.error, /timed out/);
      if (scenario === "missing-run" || scenario === "stale-ack") assert.match(receipt.error, /run id/i);
      if (scenario === "wrong-wait-run") assert.match(receipt.error, /run id/i);
      if (scenario === "timeout") assert.match(receipt.error, /timed out/);
    }
    console.log(`PASS Gateway session send ${scenario}`);
  }
}

// Only the child replaces the external OCM and WebSocket boundaries. The actual
// helper, request client, history extraction and JSON reporting still execute.
if (process.env.KOVA_SEND_TURN_FIXTURE) {
  const scenario = process.env.KOVA_SEND_TURN_FIXTURE;
  const queued = scenario.startsWith("queued") || scenario === "collected";
  childProcess.execFileSync = (file, args) => {
    assert.equal(file, "ocm");
    assert.equal(args[0], "env");
    if (args[1] === "status") return JSON.stringify({ root: "/nonexistent", gatewayPort: 18789 });
    assert.equal(args[1], "resolve");
    return JSON.stringify({ binaryPath: helper });
  };
  syncBuiltinESMExports();
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    completed = false;
    waitCount = 0;
    constructor() {
      super();
      setTimeout(() => this.frame({ type: "event", event: "connect.challenge" }), 0);
    }
    frame(frame) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      const reply = (payload) => this.frame({ type: "res", id, ok: true, payload });
      const assistant = (runId, text = "KOVA_AGENT_OK") => ({
        role: "assistant", content: [{ type: "text", text }],
        __openclaw: { runId }, timestamp: 1
      });
      if (method === "connect") return queueMicrotask(() => reply({}));
      if (method === "sessions.create") return queueMicrotask(() => reply({ key: "canonical-session" }));
      if (method === "sessions.send") {
        assert.equal(params.key, scenario === "new-session" ? "canonical-session" : "existing-session");
        submittedRunId = params.idempotencyKey;
        return queueMicrotask(() => reply(scenario === "missing-run" ? {} : { runId: scenario === "stale-ack" ? "historical-0" : submittedRunId }));
      }
      if (method === "agent.wait") {
        assert.ok(params.runId === submittedRunId || (queued && params.runId === queuedRunId) || (scenario === "stale-ack" && params.runId === "historical-0"));
        this.waitCount += 1;
        const failed = scenario === "overflow" || scenario === "early-error" || (scenario === "queued-error" && params.runId === queuedRunId);
        return setTimeout(() => {
          this.completed = true;
          reply({
            runId: scenario === "wrong-wait-run" ? "another-run" : params.runId,
            status: failed ? "error" : scenario === "timeout" ? "timeout" :
              scenario === "queued" && this.waitCount === 1 ? "pending" : "ok",
            ...(failed ? { error: "context overflow from submitted run" } : {})
          });
        }, 120);
      }
      assert.equal(method, "chat.history");
      const messages = Array.from({ length: scenario === "new-session" ? 0 : 4 }, (_, i) => assistant(scenario === "queued-old-reply" ? queuedRunId : `historical-${i}`));
      if (this.completed || scenario === "early-reply" || scenario === "early-error") {
        if (queued) {
          messages.push({ role: "user", content: "new input", __openclaw: { id: "input-event", idempotencyKey: scenario === "collected" ? "aggregate:user" : `${submittedRunId}:user` } });
          if (scenario === "queued-other-input") messages.push({ role: "user", content: "another input" });
          if (scenario === "queued-paged") messages.push(...Array.from({ length: 20 }, () => ({ role: "toolResult", content: "tool output" })));
        }
        const message = assistant(queued ? queuedRunId : submittedRunId, ["wrong-reply", "queued-old-reply", "queued-error"].includes(scenario) ? "WRONG" : "KOVA_AGENT_OK");
        if (scenario === "blank-reply") message.content = [];
        if (scenario === "injected") message.__openclaw = { idempotencyKey: submittedRunId };
        messages.push(message);
      }
      const offset = params.offset ?? 0;
      const end = Math.max(0, messages.length - offset);
      const inputReceipts = scenario === "collected" ? [{ runId: submittedRunId, state: "consumed", consumedByEventId: "input-event" }] : [];
      const pageLimit = scenario === "queued-paged" ? 7 : params.limit;
      const start = Math.max(0, end - pageLimit);
      return queueMicrotask(() => reply({
        sessionId: "physical-session", inputReceipts,
        messages: messages.slice(start, end), hasMore: start > 0,
        nextOffset: start > 0 ? offset + (end - start) : null
      }));
    }
    close() { this.readyState = 3; }
  };
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGatewaySessionSendTurnChecks();
}
