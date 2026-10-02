import assert from "node:assert/strict";
import { DirectGatewayRpcClient } from "../support/openclaw-runtime.mjs";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static latest = null;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    FakeSocket.latest = this;
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }
}

export async function runGatewayRpcFrameChecks() {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  const client = new DirectGatewayRpcClient({ url: "ws://127.0.0.1/gateway", token: "fixture" });
  try {
    const connected = client.connect(2000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = FakeSocket.latest;
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "event", event: "connect.challenge" })
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectFrame = socket.sent.find((frame) => frame.method === "connect");
    assert.ok(connectFrame, "client must answer the connect challenge");
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "res", id: connectFrame.id, ok: true, payload: {} })
    }));
    await connected;
    for (const data of ["not-json{", new Blob(["not-json{"])]) {
      const requests = ["health", "status"].map((method) =>
        assert.rejects(client.request(method, {}, { timeoutMs: 2000 }), SyntaxError));
      socket.dispatchEvent(new MessageEvent("message", { data }));
      await Promise.all(requests);
      assert.equal(client.pending.size, 0);
      const recovered = client.request("health", {}, { timeoutMs: 2000 });
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "res", id: socket.sent.at(-1).id, ok: true, payload: { ok: true } })
      }));
      assert.deepEqual(await recovered, { ok: true });
    }
    socket.dispatchEvent(new MessageEvent("message", { data: "idle malformed frame" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    client.close();
    process.off("unhandledRejection", onRejection);
    globalThis.WebSocket = previous;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runGatewayRpcFrameChecks();
  console.log("PASS bad gateway frame does not exit the process");
}
