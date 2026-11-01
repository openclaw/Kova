import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export async function fixtureGateway({ onRequest } = {}) {
  const seen = [];
  const requests = [];
  const sockets = new Set();
  let connections = 0;
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization?.replace(/^Bearer /, "") ?? null);
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "KOVA_AGENT_OK" } }] }));
  });
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (value) => {
      const payload = Buffer.from(JSON.stringify(value));
      assert.ok(payload.length < 126);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    };
    send({ type: "event", event: "connect.challenge" });
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 2) return;
      if ((buffered[0] & 15) === 8) { socket.end(); return; }
      const shortLength = buffered[1] & 127;
      if (shortLength === 126 && buffered.length < 4) return;
      const length = shortLength === 126 ? buffered.readUInt16BE(2) : shortLength;
      const offset = shortLength === 126 ? 4 : 2;
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < length; index++) payload[index] ^= mask[index % 4];
      buffered = buffered.subarray(offset + 4 + length);
      const frame = JSON.parse(payload.toString());
      requests.push(frame);
      if (frame.method === "connect") seen.push(frame.params.auth.token);
      const response = onRequest?.(frame) ?? { ok: true, payload: {} };
      send({ type: "res", id: frame.id, ...response });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port, seen, requests,
    get connections() { return connections; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
