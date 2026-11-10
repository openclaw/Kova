import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { collectEnvMetrics } from "../src/metrics.mjs";
import { ENV_COLLECTOR_IDS } from "../src/collection-policy.mjs";
import { readLinuxCpuCounters } from "../src/collectors/linux-cpu.mjs";

// The HTTP frontage remains stable while the supervisor publishes new children.
// All commands are isolated behind a fixture OCM; no real environment is touched.
async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(), ".openclaw/tmp/readiness-identity-"));
  const statePath = join(root, "service.json");
  const callsPath = join(root, "calls.jsonl");
  const children = [];
  let onProbe = async () => true;
  const server = createServer((request, response) => {
    void (async () => {
      const ready = request.url === "/readyz" ? await onProbe() : true;
      response.writeHead(ready ? 200 : 503);
      response.end(JSON.stringify({ ready }));
    })().catch((error) => response.destroy(error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }));
    await rm(root, { recursive: true, force: true });
  });
  const port = server.address().port;
  await writeFile(join(root, "ocm"), `#!${process.execPath}
const fs = await import("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") !== "service status kova-readiness-identity --json") process.exit(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + String.fromCharCode(10));
process.stdout.write(fs.readFileSync(${JSON.stringify(statePath)}));
`, { mode: 0o755 });
  async function publish(pid) {
    await writeFile(statePath, JSON.stringify({ desiredRunning: true, running: Boolean(pid),
      childPid: pid, gatewayPort: port }));
  }
  async function birth() {
    const child = spawn(process.execPath, ["-e", "process.send('born');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    await once(child, "message");
    return { pid: child.pid, startTicks: readLinuxCpuCounters(child.pid).startTicks };
  }
  await publish(null);
  return {
    birth, publish,
    onProbe(handler) { onProbe = handler; },
    async calls() { return (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse); },
    async collect(onReadiness = () => {}) {
      const result = await collectEnvMetrics("kova-readiness-identity", {
        commandEnv: { PATH: `${root}${delimiter}${process.env.PATH}`, KOVA_OCM_TRANSPORT_JSON: undefined },
        timeoutMs: 2000, readinessTimeoutMs: 2000, readinessIntervalMs: 50,
        healthSamples: 1, onReadiness,
        collectionPolicy: { readiness: "wait", healthSamples: false,
          collectors: Object.fromEntries(ENV_COLLECTOR_IDS.map((id) => [id, ["service", "readiness"].includes(id)])) }
      });
      assert.equal(result.error, null);
      return result;
    }
  };
}

const linuxOnly = { skip: process.platform !== "linux" };

test("env readiness binds a supervised child born during the wait", linuxOnly, async (t) => {
  const lab = await fixture(t);
  let identity;
  let probes = 0;
  lab.onProbe(async () => {
    if (++probes === 1) {
      identity = await lab.birth();
      await lab.publish(identity.pid);
      return false;
    }
    return true;
  });
  let callback;
  const result = await lab.collect((readiness) => { callback = readiness; });
  assert.equal(result.readiness.ready, true);
  assert.deepEqual(result.readiness.processIdentity, identity);
  assert.equal(result.readiness.identityMatched, true);
  assert.equal(callback, result.readiness);
  assert.equal(result.readiness.attempts, 2);
  assert.equal((await lab.calls()).length, 4, "initial status, two attempts, successful bracket");
  assert.ok(result.readiness.readyAt);
});

test("env readiness binds the replacement child, not the initial service snapshot", linuxOnly, async (t) => {
  const lab = await fixture(t);
  const initial = await lab.birth();
  await lab.publish(initial.pid);
  let replacement;
  let probes = 0;
  lab.onProbe(async () => {
    if (++probes === 1) {
      replacement = await lab.birth();
      await lab.publish(replacement.pid);
      return false;
    }
    return true;
  });
  const result = await lab.collect();
  assert.equal(result.service.childPid, initial.pid, "service metrics remain the initial snapshot");
  assert.deepEqual(result.readiness.processIdentity, replacement);
  assert.equal(result.readiness.identityMatched, true);
  assert.equal(result.readiness.attempts, 2);
});

test("env readiness rejects supervised PID replacement during successful HTTP", linuxOnly, async (t) => {
  const lab = await fixture(t);
  const initial = await lab.birth();
  const replacement = await lab.birth();
  await lab.publish(initial.pid);
  lab.onProbe(async () => { await lab.publish(replacement.pid); return true; });
  const result = await lab.collect();
  assert.equal(result.readiness.ready, true, "HTTP readiness is independent of identity proof");
  assert.deepEqual(result.readiness.processIdentity, initial);
  assert.equal(result.readiness.identityMatched, false);
});

test("env readiness rejects changed start ticks during successful HTTP", linuxOnly, async (t) => {
  const lab = await fixture(t);
  const identity = await lab.birth();
  await lab.publish(identity.pid);
  let changed = false;
  const original = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", (path, ...args) => {
    const value = original(path, ...args);
    if (!changed || path !== "/proc/" + identity.pid + "/stat") return value;
    const text = String(value);
    const offset = text.lastIndexOf(")") + 2;
    const fields = text.slice(offset).trim().split(/\s+/);
    fields[19] = String(Number(fields[19]) + 1);
    return text.slice(0, offset) + fields.join(" ");
  });
  syncBuiltinESMExports();
  try {
    lab.onProbe(async () => { changed = true; return true; });
    const result = await lab.collect();
    assert.equal(result.readiness.ready, true);
    assert.deepEqual(result.readiness.processIdentity, identity);
    assert.equal(result.readiness.identityMatched, false);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("ordinary readiness collection does not poll supervised identity", linuxOnly, async (t) => {
  const lab = await fixture(t);
  const identity = await lab.birth();
  await lab.publish(identity.pid);
  const result = await lab.collect(null);
  assert.equal(result.readiness.ready, true);
  assert.equal((await lab.calls()).length, 1);
  assert.equal(result.readiness.processIdentity, undefined);
});
