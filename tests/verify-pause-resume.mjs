import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { atomicJson, CallError } from "../support/verify/background.mjs";
import { gatewayLifecycleMain, parseGatewayLifecycleArgs, runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";
import { definition as doctor } from "../support/verify/doctor-repair.mjs";
import { scriptMain } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-pause-"));
  const env = "kova-scripts-pause-test", handlePath = join(root, "gateway.json");
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), entry: "foreground-gateway-start", method: "gateway.start", env, directory: `${handlePath}.d`, handlePath, expiresAt: new Date(Date.now() + 180000).toISOString() };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  const runtime = { root, configPath: join(root, ".openclaw/openclaw.json"), gatewayPort: 19313 };
  const controller = new AbortController();
  const children = [], events = [];
  let mode = "ready", published;
  const started = new Promise((resolve) => { published = resolve; });
  const running = runForegroundGateway({ env, timeoutMs: 300 }, {
    operation, signal: controller.signal,
    async publish(ref) {
      await atomicJson(handlePath, { entry: operation.entry, env, ref: { id: operation.id, directory: operation.directory, ...ref } });
      published();
    }
  }, {
    prepare: () => runtime,
    requireUnusedPort: async () => { assert.ok(children.every((x) => x.stopped)); },
    invocation: () => ({ file: "gateway", args: [], env: {} }),
    fetch: async () => ({ ok: mode === "ready", body: { cancel: async () => {} } }),
    connect: async () => ({ client: { close() {}, async request(method, params) {
      schemas.check(method, params);
      assert.equal(method, "config.get");
      return { path: runtime.configPath };
    } } }),
    doctorHelper: async () => {
      assert.ok(children.every((x) => x.stopped));
      events.push("doctor");
      mode = "ready";
      return { status: 0, value: { status: 0, doctorFixSucceeded: true, doctorUnrepairedFindingCount: 0, stdoutSnippet: "repaired" } };
    },
    spawn() {
      const child = { pid: 1000 + children.length, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null };
      const record = { child, stopped: false };
      children.push(record);
      let finish;
      const closed = new Promise((resolve) => { finish = resolve; });
      setImmediate(() => {
        if (mode === "legacy") child.stderr.write(`Legacy session store requires migration: ${root}/.openclaw/agents/main/sessions/sessions.json. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.\n`);
        if (mode === "unrelated") { child.exitCode = 1; finish({ status: 1 }); }
      });
      return { child, closed, async stop() {
        if (record.stopped) return;
        record.stopped = true;
        child.exitCode ??= 0;
        child.stdout.end(); child.stderr.end(); finish({ status: child.exitCode });
      } };
    }
  });
  t.after(async () => { controller.abort(new CallError("background operation stopped", 1)); await running; await rm(root, { recursive: true, force: true }); });
  await started;
  const call = (action, extra = []) => gatewayLifecycleMain([action, "--env", env, "--gateway-handle", handlePath, "--timeout", "60000", ...extra]);
  return { root, env, handlePath, operation, children, events, call, setMode(value) { mode = value; } };
}

test("pause and resume retain the original owner and operation", async (t) => {
  const f = await fixture(t);
  const paused = await f.call("pause");
  assert.equal(paused.exitCode, 0, JSON.stringify(paused));
  assert.equal(paused.output.result.paused, true);
  assert.ok(f.children.every((x) => x.stopped));
  const again = await f.call("pause");
  assert.equal(again.exitCode, 0);
  assert.equal(f.children.length, 1);
  const resumed = await f.call("resume");
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.output.result.ready, true);
  assert.notEqual(resumed.output.result.pid, paused.output.result.previousPid);
  const handle = JSON.parse(await readFile(f.handlePath, "utf8"));
  assert.equal(handle.ref.id, f.operation.id);
  assert.equal(handle.ref.ownerPid, process.pid);
  assert.equal(handle.ref.lifecycleState, "running");
  assert.equal((await f.call("resume")).exitCode, 2);
});

test("legacy refusal retains the paused owner for Doctor and healthy restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("pause")).exitCode, 0);
  f.setMode("legacy");
  const refused = await f.call("resume", ["--expect-refusal"]);
  assert.equal(refused.exitCode, 0, JSON.stringify(refused));
  assert.equal(refused.output.result.refused, true);
  assert.equal(refused.output.result.paused, true);
  assert.ok(f.children.every((x) => x.stopped));
  const repaired = await scriptMain(doctor, ["--env", f.env, "--gateway-handle", f.handlePath, "--timeout", "60000"]);
  assert.equal(repaired.exitCode, 0, JSON.stringify(repaired));
  assert.equal(repaired.output.repairs.gateway.ready, true);
  assert.deepEqual(f.events, ["doctor"]);
  assert.equal(JSON.parse(await readFile(f.handlePath, "utf8")).ref.id, f.operation.id);
});

for (const [mode, code] of [["ready", 1], ["unrelated", 1], ["timeout", 3]]) {
  test(`expected refusal rejects ${mode} and preserves a stopped owner`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.call("pause")).exitCode, 0);
    f.setMode(mode);
    const result = await f.call("resume", ["--expect-refusal"]);
    assert.equal(result.exitCode, code, JSON.stringify(result));
    assert.equal(result.output.result.refused, false);
    assert.equal(result.output.result.paused, true);
    assert.ok(f.children.every((x) => x.stopped));
    f.setMode("ready");
    assert.equal((await f.call("resume")).exitCode, 0);
  });
}

test("refusal evidence cannot carry over from a previous resume", async (t) => {
  const f = await fixture(t);
  await f.call("pause");
  f.setMode("legacy");
  assert.equal((await f.call("resume", ["--expect-refusal"])).exitCode, 0);
  f.setMode("unrelated");
  assert.equal((await f.call("resume", ["--expect-refusal"])).exitCode, 1);
});

test("pause and resume parse only their declared forms", () => {
  const common = ["--env", "kova-scripts-pause-test", "--gateway-handle", "gateway.json", "--timeout", "30000"];
  assert.equal(parseGatewayLifecycleArgs(["pause", ...common]).action, "pause");
  assert.equal(parseGatewayLifecycleArgs(["resume", ...common, "--expect-refusal"])["expect-refusal"], true);
  assert.throws(() => parseGatewayLifecycleArgs(["pause", ...common, "--expect-refusal"]), /unknown flag/);
  assert.throws(() => parseGatewayLifecycleArgs(["resume", "--env", "kova-scripts-pause-test"]), /gateway-handle/);
});

test("pause/resume Gateway requests match pinned schemas", (t) => schemas.report(t));
