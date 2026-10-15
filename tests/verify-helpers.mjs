import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { scriptMain } from "../support/verify/script.mjs";
import { definition as ensure } from "../support/verify/ensure-gateway-running.mjs";
import { definition as session } from "../support/verify/session-send-turn.mjs";
import { definition as tui } from "../support/verify/tui-message-turn.mjs";
import { definition as doctor } from "../support/verify/doctor-repair.mjs";
import { definition as channel } from "../support/verify/channel-probe-turn.mjs";
import { definition as cron } from "../support/verify/cron-runtime-smoke.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url), "utf8"));
const env = "kova-helpers-test";
const cases = [
  [session, ["--session-key", "agent:main:test", "--create-session", "false", "--message", "hello"], "run-gateway-session-send-turn", { ok: true, sessionKey: "agent:main:test", runId: "run-a", finalAssistantVisibleText: "reply" }, { sessionKey: "agent:main:test", createdIds: ["run-a"], reply: "reply" }],
  [tui, ["--session", "example", "--message", "hello"], "run-tui-message-turn", { ok: true, matchedText: "reply" }, { reply: "reply" }],
  [doctor, [], "run-doctor-repair", { status: 0, doctorFixSucceeded: true, doctorUnrepairedFindingCount: 0, stdoutSnippet: "done" }, { repairs: { status: 0, succeeded: true, unrepairedFindingCount: 0, stdout: "done", stderr: "" } }],
  [channel, ["--case", "text-final", "--artifact-dir", "/tmp/example"], "run-channel-probe-turn", { ok: true, artifactPath: "/tmp/result.json" }, { case: "text-final", reply: [{ outboundRecords: [{ text: "reply" }] }] }],
  [cron, ["--artifact-dir", "/tmp/example"], "run-cron-runtime-smoke", { cronId: "job-a", runId: "run-a", runStatus: "ok", cronRunCompleted: true }, { jobs: [{ id: "job-a", runId: "run-a", status: "ok", completed: true, timedOut: false, triggerAttributed: false }] }]
];
function keys(id, output) {
  const entry = catalogue.entries.find((e) => e.id === id);
  assert.equal(entry.status, "existing");
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(output))).sort(), [...entry.prints].sort());
}
async function run(definition, flags, dependencies = {}) {
  const result = await scriptMain(definition, ["--env", env, ...flags], dependencies);
  keys(definition.id, result.output);
  return result;
}

for (const [definition, flags, helper, value, expected] of cases) {
  test(`${definition.id} translates its helper without changing its caller`, async () => {
    let called;
    const result = await run(definition, [...flags, "--timeout", "2000"], { context: {
      helper(name, args) { called = { name, args }; return { value: structuredClone(value), status: 0 }; },
      read: async () => ({ observations: expected.reply })
    } });
    assert.equal(result.exitCode, 0, result.output.error);
    assert.equal(called.name, helper);
    for (const [name, data] of Object.entries(expected)) assert.deepEqual(result.output[name], data);
    assert.equal(called.args[called.args.indexOf("--env") + 1], env);
    if (definition !== doctor) {
      const flag = [channel, cron].includes(definition) ? "--timeout-ms" : "--timeout";
      const timeout = Number(called.args[called.args.indexOf(flag) + 1]);
      assert.ok(timeout > 0 && timeout <= 2000);
    }
    if (definition === session) assert.equal(called.args[called.args.indexOf("--create-session") + 1], "false");
  });
  test(`${definition.id} keeps failure fields and classifies malformed calls`, async () => {
    const result = await run(definition, flags, { context: { helper: async () => ({ value: { ok: false, error: "product error" }, status: 1 }) } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.error, "product error");
    const bad = await run(definition, [...flags, "--unknown", "value"]);
    assert.equal(bad.exitCode, 2);
    const timeout = await run(definition, [...flags, "--timeout", "0"]);
    assert.equal(timeout.exitCode, 2);
  });
}

test("session-send-turn passes through fail-closed BLOCKED results after a helper update", async () => {
  const result = await run(session, ["--session-key", "agent:main:test"], { context: { helper: async () => ({ status: 1, value: {
    ok: false, recordStatus: "BLOCKED", error: "no authoritative association for queued input on this runtime", runId: "submitted"
  } }) } });
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /^BLOCKED: no authoritative association/);
  assert.equal(result.output.reply, null);
  assert.deepEqual(result.output.createdIds, ["submitted"]);
});

test("cron-runtime-smoke propagates structured errors even when the helper exits zero", async () => {
  const result = await run(cron, ["--artifact-dir", "/tmp/example"], { context: { helper: async () => ({ status: 0, value: { errors: ["cron run failed"] } }) } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, "cron run failed");
});

test("ensure-gateway-running starts or reuses only the selected foreground owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-helpers-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = join(directory, "gateway.json");
  let started = false, starts = 0;
  const requests = [];
  const dependencies = {
    rpc: async (method, params) => { schemas.check(method, params); requests.push(method); return method === "config.get" ? { path: "/clone/openclaw.json" } : { ok: true }; },
    context: {
      operation: async () => { if (!started) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return {
        directory, entry: "foreground-gateway-start", method: "gateway.start", env, handle: { ref: { configPath: "/clone/openclaw.json" } }
      }; },
      lifecycle: async (args) => { assert.deepEqual(args.slice(0, 5), ["start", "--env", env, "--handle", handle]); started = true; starts++; return { exitCode: 0 }; }
    }
  };
  for (let i = 0; i < 2; i++) {
    const result = await run(ensure, ["--gateway-handle", handle], dependencies);
    assert.equal(result.exitCode, 0, result.output.error);
    assert.equal(result.output.ready, true);
  }
  assert.equal(starts, 1);
  assert.deepEqual(requests, ["config.get", "health", "config.get", "health"]);
  const wrong = await run(ensure, ["--gateway-handle", handle], { ...dependencies, rpc: async () => ({ path: "/different/openclaw.json" }) });
  assert.equal(wrong.exitCode, 1);
  assert.equal(wrong.output.ready, false);
  await writeFile(join(directory, "result.json"), "{}");
  const ended = await run(ensure, ["--gateway-handle", handle], dependencies);
  assert.equal(ended.exitCode, 1);
  assert.equal(starts, 1);
});

test("helper CLI bounds the real subprocess and prints only declared JSON on timeout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-helpers-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "ocm");
  await writeFile(executable, "#!/bin/sh\nsleep 30\n");
  await chmod(executable, 0o755);
  const start = Date.now();
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(doctor.url), "--env", env, "--timeout", "300"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SHELL: "/bin/bash" }, timeout: 10000
    });
    assert.fail("expected timeout");
  } catch (error) {
    assert.equal(error.code, 3, error.stderr);
    const output = JSON.parse(error.stdout);
    keys(doctor.id, output);
    assert.equal(output.error, "verification timeout");
    assert.equal(error.stderr, "");
    assert.ok(Date.now() - start < 10000);
  }
});

test("helper adapter Gateway requests satisfy the pinned schemas", (t) => schemas.report(t));

test("ensure-gateway-running refuses an absent handle argument and a foreign owner", async () => {
  const absent = await run(ensure, []);
  assert.equal(absent.exitCode, 2);
  const foreign = await run(ensure, ["--gateway-handle", "/tmp/foreign.json"], { context: {
    operation: async () => ({ entry: "foreground-gateway-start", method: "gateway.start", env: "kova-helpers-other", handle: { ref: {} } })
  }, rpc: () => assert.fail("must not contact a foreign owner") });
  assert.equal(foreign.exitCode, 2);
  assert.equal(foreign.output.ready, false);
});


test("channel-probe-turn accepts one known case and rejects batches before calling its helper", async () => {
  for (const name of ["all", "text-final,text-final", "unknown-case"]) {
    const result = await run(channel, ["--case", name, "--artifact-dir", "/tmp/example"], { context: {
      helper: () => assert.fail("invalid case must be refused before execution")
    } });
    assert.equal(result.exitCode, 2);
  }
});
