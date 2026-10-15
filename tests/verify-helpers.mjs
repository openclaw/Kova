import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { prepareWorkflowFixtures } from "../support/channel-conformance/fixtures.mjs";

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

for (const [definition, flags] of [[doctor, []], [session, ["--session-key", "agent:main:resistant"]], [tui, ["--session", "resistant", "--message", "hello"]]]) {
  test(`${definition.id} includes resistant descendant termination in its timeout`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "kova-helper-resistant-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const pidPath = join(directory, "descendant.pid"), signalPath = join(directory, "terminated.txt");
    const descendant = `const fs = require("node:fs"); process.on("SIGTERM", () => fs.writeFileSync(process.env.TEST_SIGNAL, "SIGTERM")); fs.writeFileSync(process.env.TEST_PID, String(process.pid)); setInterval(() => {}, 1000);`;
    const executable = join(directory, "ocm");
    await writeFile(executable, `#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\nprocess.on("SIGTERM", () => {});\nspawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });\n`);
    await chmod(executable, 0o755);
    const started = Date.now();
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(definition.url), "--env", env, "--timeout", "2000", ...flags], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_PID: pidPath, TEST_SIGNAL: signalPath }, timeout: 8000
    }).catch((error) => error);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    keys(definition.id, output);
    assert.equal(output.error, "verification timeout");
    assert.equal(result.stderr, "");
    assert.equal(await readFile(signalPath, "utf8"), "SIGTERM", "the descendant must resist graceful termination before the hard cutoff");
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.ok(elapsed < 2500, `timeout plus process startup allowance exceeded: ${elapsed}ms`);
  });
}

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


test("ensure refuses artifact overlap before contacting the foreground owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-helpers-overlap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = join(directory, "gateway-ready.json");
  const alias = directory + "-alias";
  await symlink(directory, alias);
  t.after(() => rm(alias));
  await writeFile(handle, "preserved handle bytes");
  for (const artifact of [directory, alias]) {
    const result = await run(ensure, ["--gateway-handle", handle, "--artifact-dir", artifact], {
      context: { operation: () => assert.fail("overlap must be refused before owner lookup") },
      rpc: () => assert.fail("overlap must be refused before RPC")
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.output.error, /overlaps/);
    assert.equal(result.output.ready, false);
  }
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(ensure.url), "--env", env, "--gateway-handle", handle, "--artifact-dir", directory]), (error) => {
    assert.equal(error.code, 2);
    keys(ensure.id, JSON.parse(error.stdout));
    assert.match(JSON.parse(error.stdout).error, /overlaps/);
    return true;
  });
  assert.equal(await readFile(handle, "utf8"), "preserved handle bytes");
});

test("helper artifact directories are absolute before runtime working-directory changes", async () => {
  for (const [definition, extra] of [[channel, ["--case", "text-final"]], [cron, []]]) {
    let path;
    await run(definition, [...extra, "--artifact-dir", "relative-artifacts"], { context: {
      helper: async (_name, args) => { path = args[args.indexOf("--artifact-dir") + 1]; return { status: 0, value: { ok: true } }; }
    } });
    assert.equal(path, join(process.cwd(), "relative-artifacts"));
  }
});

test("cancellable fixture preparation removes partial acquisition and preserves an existing file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-helper-fixtures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const created = join(directory, "new.txt"), borrowed = join(directory, "existing.txt");
  await writeFile(borrowed, "preserve these bytes");
  await assert.rejects(prepareWorkflowFixtures({ fixtures: { mediaPaths: [created, borrowed] } }, {
    envName: env, envRoot: directory, signal: new AbortController().signal
  }), { code: "EEXIST" });
  await assert.rejects(readFile(created), { code: "ENOENT" });
  assert.equal(await readFile(borrowed, "utf8"), "preserve these bytes");
});

for (const [held, interrupted] of [["add", false], ["run", false], ["add", true]]) test(`cron ${interrupted ? "SIGTERM" : "deadline"} cancellation removes its job while ${held} is pending`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-helper-cron-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json"), jobs = join(directory, "jobs.json"), descendant = join(directory, "descendant.pid");
  const borrowed = { id: "foreign-job", name: "kova-cron-runtime-foreign" };
  await writeFile(config, "{}");
  await writeFile(jobs, JSON.stringify([borrowed]));
  await writeFile(join(directory, "ocm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2), path = process.env.TEST_JOBS;
const jobs = JSON.parse(fs.readFileSync(path, "utf8"));
const save = (value) => { fs.writeFileSync(path + ".next", JSON.stringify(value)); fs.renameSync(path + ".next", path); };
let value;
if (args[0] === "env") value = { configPath: process.env.TEST_CONFIG };
else if (args[3] === "status") value = { enabled: true };
else if (args[3] === "add") {
  jobs.push({ id: "owned-job", name: args[args.indexOf("--name") + 1] });
  save(jobs);
  value = { id: "owned-job" };
} else if (args[3] === "list") value = { jobs };
else if (args[3] === "rm") {
  save(jobs.filter((job) => job.id !== args[4]));
  value = { removed: true };
} else value = { status: "ok" };
if (args[3] === process.env.TEST_HELD) {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
  fs.writeFileSync(process.env.TEST_DESCENDANT, String(child.pid));
  child.on("exit", () => process.exit(0));
} else console.log(JSON.stringify(value));
`);
  await chmod(join(directory, "ocm"), 0o755);
  const started = Date.now();
  let child;
  const completion = new Promise((resolve) => {
    child = execFile(process.execPath, [fileURLToPath(cron.url), "--env", env, "--artifact-dir", directory, "--timeout", "6000"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_JOBS: jobs, TEST_CONFIG: config, TEST_HELD: held, TEST_DESCENDANT: descendant }, timeout: 8000
    }, (error, stdout, stderr) => resolve(Object.assign(error ?? {}, { stdout, stderr })));
  });
  if (interrupted) {
    while (!JSON.parse(await readFile(jobs, "utf8")).some((job) => job.id === "owned-job") || !await readFile(descendant, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; })) {
      assert.ok(Date.now() - started < 4000, "cron registration did not complete");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill("SIGTERM");
  }
  const result = await completion;
  assert.equal(result.code, interrupted ? 143 : 3, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).error, interrupted ? "interrupted by SIGTERM" : "verification timeout");
  const artifact = JSON.parse(await readFile(join(directory, "cron-runtime-smoke.json"), "utf8"));
  assert.equal(artifact.cancelled, true);
  assert.equal(artifact.cleanupComplete, true, artifact.cleanupError);
  assert.ok(artifact.commands.some((command) => command.label === "cron rm"));
  assert.deepEqual(JSON.parse(await readFile(jobs, "utf8")), [borrowed]);
  const pid = Number(await readFile(descendant, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the held CLI descendant must be reaped");
  assert.ok(Date.now() - started < 7000, "cleanup must fit inside the call budget with process startup allowance");
});

for (const [budget, admitted] of [[600, false], [6000, true]]) test(`cron reserves cleanup process termination inside a ${budget}ms budget`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-helper-short-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json"), job = join(directory, "job.json");
  const pidPath = join(directory, "cleanup.pid"), signals = join(directory, "signals.txt"), commands = join(directory, "commands.txt");
  await writeFile(config, "{}");
  await writeFile(commands, "");
  await writeFile(job, "null");
  await writeFile(join(directory, "ocm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_COMMANDS, args.join(" ") + "\\n");
let value;
if (args[0] === "env") value = { configPath: process.env.TEST_CONFIG };
else if (args[3] === "add") {
  value = { id: "owned-job", name: args[args.indexOf("--name") + 1] };
  fs.writeFileSync(process.env.TEST_JOB, JSON.stringify(value));
} else if (args[3] === "rm") {
  fs.writeFileSync(process.env.TEST_JOB, "null");
  process.on("SIGTERM", () => fs.writeFileSync(process.env.TEST_SIGNALS, "SIGTERM"));
  fs.writeFileSync(process.env.TEST_PID, String(process.pid));
  setInterval(() => {}, 1000);
} else value = { status: "ok", runId: "run", cronId: "owned-job" };
if (value) console.log(JSON.stringify(value));
`);
  await chmod(join(directory, "ocm"), 0o755);
  const started = Date.now();
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(cron.url), "--env", env, "--artifact-dir", directory, "--timeout", String(budget)], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_COMMANDS: commands, TEST_CONFIG: config, TEST_JOB: job, TEST_PID: pidPath, TEST_SIGNALS: signals }, timeout: 8000
  }).catch((error) => error);
  assert.equal(result.code, 3, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  keys(cron.id, output);
  const artifact = JSON.parse(await readFile(join(directory, "cron-runtime-smoke.json"), "utf8"));
  assert.equal(artifact.cancelled, true);
  assert.equal(artifact.cleanupComplete, !admitted);
  assert.equal(JSON.parse(await readFile(job, "utf8")), null);
  if (admitted) {
    assert.match(output.error, /^verification timeout; cleanup incomplete:/);
    assert.equal(await readFile(signals, "utf8"), "SIGTERM");
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the detached cleanup process must be gone before the helper returns");
  } else {
    assert.equal(output.error, "verification timeout");
    assert.equal(await readFile(commands, "utf8"), "", "an insufficient budget must refuse command acquisition");
    await assert.rejects(readFile(pidPath), { code: "ENOENT" });
  }
  assert.ok(Date.now() - started < budget + 500, "termination and output must fit inside the budget with startup allowance");
});

test("channel cancellation interrupts a pending provider reset and removes its acquired fixture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-helper-channel-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, "artifacts"), bin = join(root, "bin");
  const requests = join(root, "requests.jsonl"), commands = join(root, "commands.jsonl");
  const fixturePath = join(root, ".openclaw", "workspace", "kova-source-delivery-attachment.txt");
  await Promise.all([bin, join(root, "runtime"), join(root, ".openclaw"), join(artifacts, "mock-openai")].map((path) => mkdir(path, { recursive: true })));
  await copyFile(new URL("./fixtures/verify-helper-ocm.mjs", import.meta.url), join(bin, "ocm"));
  await chmod(join(bin, "ocm"), 0o755);
  await writeFile(join(bin, "package.json"), '{"type":"module"}');
  await writeFile(join(root, ".openclaw", "openclaw.json"), JSON.stringify({ gateway: { auth: { token: "synthetic-cancellation-token" } } }));
  await Promise.all([requests, commands].map((path) => writeFile(path, "")));
  let acquired = false;
  const provider = createServer(async (request) => {
    request.resume();
    acquired = (await readFile(fixturePath, "utf8")).includes("attachment fixture");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); return new Promise((resolve) => provider.close(resolve)); });
  await writeFile(join(artifacts, "mock-openai", "port"), String(provider.address().port));
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCLAW_") && !key.startsWith("KOVA_OCM_") && !key.startsWith("KOVA_NETWORK_FRONTAGE_")));
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(channel.url), "--env", "kova-helpers-subprocess", "--case", "source-visible-delivery.attachment.message-tool-only", "--artifact-dir", artifacts, "--timeout", "5000"], {
    env: { ...childEnv, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${new URL("./fixtures/verify-helper-socket.mjs", import.meta.url).href}`, KOVA_HELPER_ROOT: root, KOVA_HELPER_REQUESTS: requests, KOVA_HELPER_COMMANDS: commands }, timeout: 8000
  }).catch((error) => error);
  assert.equal(result.code, 3, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).error, "verification timeout");
  assert.equal(acquired, true, "cancellation must happen after fixture acquisition");
  await assert.rejects(readFile(fixturePath), { code: "ENOENT" });
  const artifact = JSON.parse(await readFile(join(artifacts, "channel-probe-turn-source-visible-delivery.attachment.message-tool-only.json"), "utf8"));
  assert.equal(artifact.cancelled, true);
  assert.equal(artifact.cleanupComplete, true, artifact.cleanupError);
  assert.doesNotMatch(await readFile(requests, "utf8"), /kova\.channelProbe\.inject/);
});
