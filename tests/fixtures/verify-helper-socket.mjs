import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

// Replace only the transport. The adapter, subprocess helper and RPC client
// still construct and serialize every captured request themselves.
class FixtureSocket extends EventTarget {
  static OPEN = 1;

  constructor(url) {
    super();
    assert.equal(url, "ws://127.0.0.1:18789");
    this.readyState = FixtureSocket.OPEN;
    this.observations = [];
    queueMicrotask(() => this.receive({ type: "event", event: "connect.challenge" }));
  }

  receive(frame) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  send(raw) {
    const frame = JSON.parse(raw);
    appendFileSync(process.env.KOVA_HELPER_REQUESTS, JSON.stringify({ producer: process.argv[1], cwd: process.cwd(), frame }) + "\n");
    let payload;
    switch (frame.method) {
      case "connect":
      case "device.pair.approve":
      case "kova.channelProbe.status":
      case "kova.channelProbe.reset":
        payload = { ok: true };
        break;
      case "sessions.create":
        payload = { key: `${frame.params.key}:canonical` };
        break;
      case "sessions.send":
        this.runId = frame.params.idempotencyKey;
        payload = { runId: this.runId };
        break;
      case "agent.wait":
        payload = { runId: frame.params.runId, status: "ok" };
        break;
      case "chat.history":
        payload = { messages: [{ role: "assistant", content: "KOVA_AGENT_OK", __openclaw: { runId: this.runId } }] };
        break;
      case "kova.channelProbe.inject": {
        const observation = {
          inboundEvent: { id: frame.params.inboundEventId },
          dispatched: true,
          outboundRecords: [{
            kind: "text", text: "KOVA_AGENT_OK", messageId: "fixture-message",
            replyToId: frame.params.replyToId
          }],
          modelTurnRecords: [{ stage: "dispatch", event: "start" }, { stage: "dispatch", event: "done" }]
        };
        this.observations.push(observation);
        appendFileSync(process.env.KOVA_HELPER_PROVIDER_REQUESTS, "{}\n");
        payload = { ok: true, observation };
        break;
      }
      case "kova.channelProbe.observations":
        payload = { observations: this.observations };
        break;
      default:
        throw new Error(`unexpected fixture request: ${frame.method}`);
    }
    queueMicrotask(() => this.receive({ type: "res", id: frame.id, ok: true, payload }));
  }

  close() {
    this.readyState = 3;
  }
}

globalThis.WebSocket = FixtureSocket;
