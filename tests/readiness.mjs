import "./readiness-identity.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
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

async function runGatewayHelper(t, handler, timeoutMs) {
  const port = await gateway(t, handler);
  const bin = await mkdtemp(join(tmpdir(), "kova-ready-helper-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "ocm"), `#!${process.execPath}
if (process.argv.slice(2).join(" ") !== "service status kova-readiness-test --json") process.exit(2);
console.log(JSON.stringify({ running: true, gatewayPort: ${port} }));
`, { mode: 0o755 });
  const helper = fileURLToPath(new URL("../support/ensure-gateway-running.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, "--env", "kova-readiness-test", "--timeout-ms", String(timeoutMs), "--interval-ms", "1"], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, KOVA_NETWORK_FRONTAGE_ENABLED: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null, stderr);
        resolve({ status, summary: JSON.parse(stdout) });
      } catch (error) { reject(error); }
    });
  });
}

test("service helper waits for admission while the running gateway is live", async (t) => {
  const paths = [];
  let probes = 0;
  const result = await runGatewayHelper(t, (request, response) => {
    paths.push(request.url);
    const ready = request.url === "/readyz" && ++probes > 1;
    response.writeHead(request.url === "/readyz" && !ready ? 503 : 200);
    response.end(JSON.stringify(request.url === "/readyz" ? { ready } : { ok: true }));
  }, 3000);
  assert.equal(result.status, 0, JSON.stringify({ summary: result.summary, paths }));
  assert.deepEqual(paths, ["/readyz", "/readyz"]);
  assert.equal(result.summary.attemptCount, 2);
  assert.equal(result.summary.startCommandCount, 0);
});

test("service helper refuses successful HTTP responses without admission", async (t) => {
  for (const body of ['{"ready":false}', "<html>Control UI</html>"]) {
    await t.test(body, async (t) => {
      const result = await runGatewayHelper(t, (_request, response) => response.end(body), 100);
      assert.equal(result.status, 1);
      assert.equal(result.summary.ok, false);
      assert.ok(result.summary.attemptCount > 0);
      assert.equal(result.summary.startCommandCount, 0);
    });
  }
});
