import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { collectHealthMetrics, collectReadinessMetrics } from "../src/collectors/readiness.mjs";

async function gateway(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

const options = { timeoutMs: 1000, intervalMs: 1, probeTimeoutMs: 500 };

test("scenario readiness waits for admission while liveness already passes", async (t) => {
  let readinessRequests = 0;
  const paths = [];
  const port = await gateway(t, (request, response) => {
    paths.push(request.url);
    const ready = request.url === "/readyz" && ++readinessRequests > 1;
    response.writeHead(request.url === "/readyz" && !ready ? 503 : 200);
    response.end(JSON.stringify(request.url === "/readyz" ? { ready } : { ok: true }));
  });
  assert.equal((await collectHealthMetrics(port, 500)).ok, true);
  const result = await collectReadinessMetrics(9, {
    ...options,
    probeEndpoint: { source: "network-frontage", host: "127.0.0.1", port }
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.healthAttempts.map(({ status }) => status), [503, 200]);
  assert.deepEqual(paths, ["/health", "/readyz", "/readyz"]);
  assert.equal(result.health.source, "network-frontage");
  assert.equal(result.health.url, `http://127.0.0.1:${port}/readyz`);
});

test("a live gateway that refuses admission stays unhealthy at the deadline", async (t) => {
  const port = await gateway(t, (request, response) => {
    response.writeHead(request.url === "/readyz" ? 503 : 200);
    response.end(JSON.stringify({ ready: false }));
  });
  const result = await collectReadinessMetrics(port, { ...options, timeoutMs: 0 });
  assert.equal(result.ready, false);
  assert.equal(result.listeningReady, true);
  assert.equal(result.classification.state, "unhealthy");
  assert.equal(result.health.status, 503);
});

test("HTTP success without a readiness contract cannot admit scenario traffic", async (t) => {
  for (const body of ["<html>Control UI</html>", "null", '{"ok":true}', '{"ready":false}', '{"ready":"true"}']) {
    await t.test(body, async (t) => {
      const port = await gateway(t, (_request, response) => response.end(body));
      const result = await collectReadinessMetrics(port, { ...options, timeoutMs: 0 });
      assert.equal(result.ready, false);
      assert.equal(result.health.status, 200);
      assert.equal(result.health.bodySnippet, body);
    });
  }
});
