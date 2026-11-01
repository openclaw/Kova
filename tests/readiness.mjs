import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  collectHealthMetrics,
  collectReadinessMetrics
} from "../src/collectors/readiness.mjs";

test("readiness waits for /readyz while health samples stay on /health", async () => {
  let ready = false;
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    if (request.url === "/health") {
      response.writeHead(200).end("live");
      return;
    }
    if (request.url === "/readyz" && ready) {
      response.writeHead(200).end("ready");
      return;
    }
    response.writeHead(503).end("starting");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    setTimeout(() => {
      ready = true;
    }, 25);
    const readiness = await collectReadinessMetrics(address.port, {
      timeoutMs: 500,
      thresholdMs: 500,
      intervalMs: 10,
      probeTimeoutMs: 100
    });
    assert.equal(readiness.ready, true);
    assert.ok(readiness.healthAttempts.length >= 2);
    assert.ok(paths.every((path) => path === "/readyz"));

    const health = await collectHealthMetrics(address.port, 100);
    assert.equal(health.ok, true);
    assert.equal(health.url.endsWith("/health"), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
