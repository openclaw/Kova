import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await realpath(await mkdtemp(join(tmpdir(), "kova-ocm-transport-")));
const previousHome = process.env.KOVA_HOME;
process.env.KOVA_HOME = join(root, "runner-home");
const { quoteShell, runCommand, runWithCommandEnv, checkCommand } = await import("../src/commands.mjs");
const { repoRoot } = await import("../src/paths.mjs");
try {
  const bin = join(root, "ordinary-bin");
  const home = join(root, "candidate home");
  const log = join(root, "transport.jsonl");
  const prefix = join(root, "prefix.mjs");
  const binary = join(root, "candidate-ocm");
  await mkdir(bin);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(bin, "ocm"), "#!/bin/sh\nprintf ordinary-ocm\n", { mode: 0o755 });
  await writeFile(prefix, `
import assert from "node:assert/strict";
import { appendFileSync, closeSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
assert.equal(args.shift(), "/usr/bin/env");
assert.equal(args.shift(), "-C");
const cwd = args.shift();
assert.equal(args.shift(), "-i");
const env = {};
while (args[0]?.includes("=") && !args[0].startsWith("/")) {
  const pair = args.shift(), index = pair.indexOf("=");
  env[pair.slice(0, index)] = pair.slice(index + 1);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, cwd, env, args, launchedAt: Date.now() }) + "\\n");
if (args.includes("wait-for-timeout")) {
  setInterval(() => {}, 1000);
} else if (args.includes("close-stdout-and-wait")) {
  writeSync(1, "complete-payload-without-exit");
  closeSync(1);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, stdoutClosedAt: Date.now() }) + "\\n");
  setInterval(() => {}, 1000);
} else if (args.includes("inherited-pipe")) {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1800)"], { stdio: "inherit" });
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, pipeOwnerPid: holder.pid, args }) + "\\n");
  holder.unref();
} else {
  const child = spawn(args.shift(), args, { env, cwd, stdio: "inherit" });
  child.on("error", error => { console.error(error.message); process.exitCode = 127; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? 1; });
}
`);
  const ocmLog = join(root, "ocm.jsonl");
  await writeFile(binary, `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(join(repoRoot, "tests/fixtures/ocm-transport.mjs"))} "$@"\n`, { mode: 0o755 });
  const transport = {
    prefix: [process.execPath, prefix],
    binary,
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, KOVA_TEST_LOG: ocmLog }
  };
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    SHELL: "/bin/sh",
    KOVA_OCM_TRANSPORT_JSON: JSON.stringify(transport),
    KOVA_ENV_NAME: "kova-transport-test",
    OPENCLAW_OCM_RUNTIME_BUILD_PROFILE: "runtime",
    KOVA_OPENCLAW_CONFIG_CONTRACT: "canonical",
    SECRET_MUST_NOT_CROSS: "synthetic-not-a-credential"
  };
  const result = await runWithCommandEnv(env, () => runCommand("ocm --version"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "transport-ocm", "configured transport must replace ordinary PATH OCM");
  const nested = await runCommand(
    `${quoteShell(process.execPath)} -e ${quoteShell('process.stdout.write(require("node:child_process").execFileSync("ocm", ["--version"]))')}`,
    { env }
  );
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stdout, "transport-ocm", "nested helpers must retain transport");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.cwd, home, "default cwd must be applied inside the prefix");
    assert.equal(call.env.HOME, home);
    assert.equal(call.env.KOVA_ENV_NAME, "kova-transport-test");
    assert.equal(call.env.OPENCLAW_OCM_RUNTIME_BUILD_PROFILE, "runtime");
    assert.equal(call.env.KOVA_OPENCLAW_CONFIG_CONTRACT, "canonical");
    assert.equal(call.env.SECRET_MUST_NOT_CROSS, undefined);
    assert.equal(call.env.KOVA_OCM_TRANSPORT_JSON, undefined);
    assert.deepEqual(call.args, [binary, "--version"]);
  }
  const ordinary = await runCommand("ocm --version", { env: { PATH: env.PATH, SHELL: "/bin/sh" } });
  assert.equal(ordinary.stdout, "ordinary-ocm", "unset transport preserves local operation");
  const synchronous = checkCommand("ocm", ["--version"], { env });
  assert.equal(synchronous.stdout, "transport-ocm", "setup's synchronous OCM check must use transport");
  const { captureProcessSnapshot } = await import("../src/collectors/resources.mjs");
  captureProcessSnapshot({ envName: "kova-sync-transport", commandEnv: env });
  assert.match(await readFile(ocmLog, "utf8"), /kova-sync-transport/);
  const inert = "$(touch SHOULD_NOT_EXIST); ' quoted";
  await runCommand(`ocm --version ${quoteShell(inert)}`, { env });
  const last = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(last.args.at(-1), inert);
  const aOnly = await runCommand(
    `${quoteShell(process.execPath)} -e ${quoteShell('process.stdout.write(process.env.NODE_OPTIONS ?? "A-clean")')}`,
    { env: { ...env, NODE_OPTIONS: "--import=/candidate-private/never-loaded-by-A.mjs" } }
  );
  assert.equal(aOnly.status, 0, aOnly.stderr);
  assert.equal(aOnly.stdout, "A-clean", "B instrumentation must not load into A helper processes");
  await verifyAmbientNodeOptions({ root, env, transport, log });
  for (const value of ["", "[]", "{}", JSON.stringify({ ...transport, cwd: "relative" })]) {
    await assert.rejects(runCommand("ocm --version", { env: { ...env, KOVA_OCM_TRANSPORT_JSON: value } }), /KOVA_OCM_TRANSPORT_JSON/);
  }
  const alternateCwd = join(home, "working");
  await mkdir(alternateCwd);
  const explicitCwd = { ...env, KOVA_OCM_TRANSPORT_JSON: JSON.stringify({ ...transport, cwd: alternateCwd }) };
  assert.equal((await runCommand("ocm --version", { env: explicitCwd })).status, 0);
  assert.equal(JSON.parse((await readFile(ocmLog, "utf8")).trim().split("\n").at(-1)).cwd, alternateCwd);
  await verifyActiveSnapshot({ root, env, transport });
  await verifyExports({ root, home, env, log });
  await verifyClosedStdoutDeadline({ root, env, log });
  await verifyStateWriters({ root, home, env, log });
  await verifyRuntimeHelper({ env });
  await verifyScenarioLifecycle({ root, env, ocmLog });
  console.log("PASS OCM transport command and nested-helper boundary");
} finally {
  if (previousHome === undefined) delete process.env.KOVA_HOME;
  else process.env.KOVA_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}

async function verifyAmbientNodeOptions({ root, env, transport, log }) {
  const loader = join(root, "runner-only-loader.mjs");
  await writeFile(loader, 'throw new Error("runner loader must not execute in candidate");\n');
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${JSON.stringify(loader)}`;
  try {
    const commandEnv = {
      ...env,
      KOVA_OCM_TRANSPORT_JSON: JSON.stringify({
        ...transport, env: { ...transport.env, NODE_OPTIONS: "--no-warnings" }
      })
    };
    const result = await runCommand("ocm --version", { env: commandEnv });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "transport-ocm");
    const call = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1));
    assert.equal(call.env.NODE_OPTIONS, "--no-warnings", "configured B options must not be replaced by ambient A options");
    assert.equal(checkCommand("ocm", ["--version"], { env: commandEnv }).stdout, "transport-ocm");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
}

async function verifyActiveSnapshot({ root, env, transport }) {
  const { collectStagedOcmDiagnostics, prepareOcmDiagnostics } = await import("../src/ocm/diagnostics.mjs");
  const commandEnv = {
    ...env,
    KOVA_OCM_TRANSPORT_JSON: JSON.stringify({
      ...transport, env: { ...transport.env, KOVA_TEST_APPEND_DURING_EXPORT: "1" }
    })
  };
  const envName = "kova-active-timeline";
  await runCommand(`ocm start ${envName} --runtime fixture --no-service --json`, { env: commandEnv });
  const location = await prepareOcmDiagnostics(envName, "active", { env: commandEnv, timeoutMs: 10000 });
  const prefix = '{"type":"mark","name":"before-export"}\n';
  await writeFile(location.timeline, prefix);
  const artifactDir = join(root, "active-retained");
  await collectStagedOcmDiagnostics(envName, location, artifactDir, { env: commandEnv, timeoutMs: 10000 });
  assert.equal(await readFile(join(artifactDir, "openclaw", "timeline.jsonl"), "utf8"), prefix,
    "active collection must export closed snapshot bytes, not the changing live timeline");
  assert.match(await readFile(location.timeline, "utf8"), /producer-appended/);
}

async function verifyExports({ root, home, env, log }) {
  const { exportOcmArtifact, readOcmArtifactSync } = await import("../src/ocm/transport.mjs");
  const envName = "kova-export";
  const candidate = join(home, "envs", envName);
  const target = join(root, "protected", "retained");
  await mkdir(candidate, { recursive: true });
  const payload = Buffer.from([0, 255, 65, 0, 10, 39]);
  await writeFile(join(candidate, "payload"), payload);
  const options = { env, maxBytes: payload.length, deadlineEpochMs: Date.now() + 10000 };
  await exportOcmArtifact(envName, "payload", target, options);
  assert.deepEqual(await readFile(target), payload);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(readOcmArtifactSync(envName, "payload", { env, maxBytes: payload.length }), payload);
  const pipeStartedAt = Date.now();
  try {
    await assert.rejects(async () => readOcmArtifactSync(envName, "inherited-pipe", {
      env, maxBytes: 16, timeoutMs: 200
    }), /failed|deadline/);
    assert.equal(Date.now() - pipeStartedAt < 1000, true,
      "a pipe inherited by a surviving descendant must not extend the export deadline");
  } finally {
    const { pipeOwnerPid } = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1));
    assert.equal(Number.isInteger(pipeOwnerPid), true, "the fixture must really start a pipe-holding descendant");
    while (Date.now() - pipeStartedAt < 3000) {
      try { process.kill(pipeOwnerPid, 0); } catch (error) {
        assert.equal(error.code, "ESRCH");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(pipeOwnerPid, 0), { code: "ESRCH" }, "fixture-owned descendant must finish");
  }
  for (const path of ["oversize", "partial-error"]) {
    await assert.rejects(exportOcmArtifact(envName, path, target, { ...options, maxBytes: 16 }), /exceeds|failed/);
    assert.deepEqual(await readFile(target), payload, "failed export must preserve the earlier complete artifact");
    const { pid } = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned launcher must be terminal before rejection");
    assert.deepEqual(await readdir(dirname(target)), ["retained"]);
  }
  for (const path of ["../outside", "/absolute", "a/../outside", "a\\outside", ""]) {
    await assert.rejects(exportOcmArtifact(envName, path, target, options), /relative/);
  }
  await assert.rejects(exportOcmArtifact(envName, "payload", target, { ...options, deadlineEpochMs: Date.now() - 1 }), /deadline/);
  const startedAt = Date.now();
  await assert.rejects(exportOcmArtifact(envName, "wait-for-timeout", target, {
    ...options, deadlineEpochMs: startedAt + 2000
  }), /deadline expired/);
  const timeoutCall = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1));
  assert.equal(timeoutCall.args.includes("wait-for-timeout"), true, "timeout must occur after the launcher actually starts");
  assert.throws(() => process.kill(timeoutCall.pid, 0), { code: "ESRCH" });
  assert.equal(Date.now() - startedAt < 5000, true, "export and owned cleanup must stay bounded");
  assert.deepEqual(await readdir(dirname(target)), ["retained"], "failed export must remove its temporary file");
  await writeFile(join(candidate, "empty"), "");
  await exportOcmArtifact(envName, "empty", target, { ...options, maxBytes: 0 });
  assert.equal((await readFile(target)).length, 0);
}

async function verifyClosedStdoutDeadline({ root, env, log }) {
  const target = join(root, "closed-stdout", "retained");
  const previous = "previous-complete-artifact";
  await mkdir(dirname(target));
  await writeFile(target, previous);
  const worker = spawn(process.execPath, ["--input-type=module", "-e", `
    import { exportOcmArtifact } from ${JSON.stringify(join(repoRoot, "src/ocm/transport.mjs"))};
    process.once("message", async ({ env, target }) => {
      const deadlineEpochMs = Date.now() + 500;
      process.send({ deadlineEpochMs });
      let outcome;
      try {
        await exportOcmArtifact("closed-stdout", "close-stdout-and-wait", target, {
          env, maxBytes: 64, deadlineEpochMs
        });
        outcome = { kind: "resolved" };
      } catch (error) {
        outcome = { kind: "rejected", message: error.message };
      }
      process.send({ outcome }, () => process.disconnect());
    });
  `], { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let deadlineEpochMs;
  let outcome;
  let stderr = "";
  let timer;
  let launch;
  let closed;
  let observed;
  worker.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(0, 2000); });
  worker.on("message", (message) => {
    deadlineEpochMs ??= message.deadlineEpochMs;
    outcome ??= message.outcome;
  });
  const terminal = new Promise((done) => {
    worker.once("error", (error) => done({ error: error.message }));
    worker.once("close", (code, signal) => done({ code, signal }));
  });
  worker.send({ env, target });
  try {
    const result = await Promise.race([
      terminal,
      new Promise((done) => { timer = setTimeout(() => done({ watchdog: true }), 4000); })
    ]);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    launch = calls.findLast((call) => call.args?.includes("close-stdout-and-wait"));
    closed = calls.findLast((call) => call.pid === launch?.pid && call.stdoutClosedAt);
    observed = {
      result, outcome, deadlineEpochMs, stderr,
      launcherAlive: launch ? ownedChildAlive(launch.pid) : false,
      retainedUnchanged: await readFile(target, "utf8") === previous,
      files: await readdir(dirname(target))
    };
  } finally {
    clearTimeout(timer);
    // The outer watchdog can only fail this case. It cleans up this test's
    // dedicated worker/exporter group even when the production await hangs.
    if (worker.pid) {
      try { process.kill(-worker.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    let cleanupTimer;
    try {
      const joined = await Promise.race([
        terminal.then(() => true),
        new Promise((done) => { cleanupTimer = setTimeout(() => done(false), 2000); })
      ]);
      assert.equal(joined, true, "outer test cleanup must join its worker");
    } finally {
      clearTimeout(cleanupTimer);
    }
    if (launch) {
      const cleanupDeadline = Date.now() + 2000;
      while (ownedChildAlive(launch.pid) && Date.now() < cleanupDeadline) {
        await new Promise((done) => setTimeout(done, 20));
      }
      assert.equal(ownedChildAlive(launch.pid), false, "outer test cleanup must finish its exporter");
    }
  }
  assert.ok(launch?.launchedAt < deadlineEpochMs, `launcher must start before deadline: ${stderr}`);
  assert.ok(closed?.stdoutClosedAt >= launch.launchedAt && closed.stdoutClosedAt < deadlineEpochMs,
    "the real launcher must successfully close stdout before the export deadline");
  console.log(JSON.stringify({
    case: "closed-stdout-deadline",
    launchedBeforeDeadline: true,
    stdoutClosedBeforeDeadline: true,
    watchdogFired: observed.result.watchdog === true,
    launcherAliveAtObservation: observed.launcherAlive,
    retainedUnchanged: observed.retainedUnchanged,
    temporaryFiles: observed.files.filter((file) => file.startsWith(".kova-export-")).length,
    outerCleanupConfirmed: true
  }));
  assert.equal(observed.result.watchdog, undefined,
    "export remained pending after stdout closed and its deadline expired");
  assert.equal(observed.outcome?.kind, "rejected", JSON.stringify(observed));
  assert.match(observed.outcome.message, /deadline expired/);
  assert.equal(observed.launcherAlive, false, "export must join its launcher before rejecting");
  assert.equal(observed.retainedUnchanged, true);
  assert.deepEqual(observed.files, ["retained"]);
}

function ownedChildAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function verifyStateWriters({ root, home, env, log }) {
  const envName = "kova-writers";
  await runCommand(`ocm start ${quoteShell(envName)} --runtime fixture --no-service --json`, { env });
  const portFile = join(root, "protected-port");
  await writeFile(portFile, "12345\n", { mode: 0o600 });
  const helper = join(repoRoot, "support/configure-openclaw-mock-auth.mjs");
  const result = await runCommand(
    `ocm env exec ${quoteShell(envName)} -- node ${quoteShell(helper)} --port-file ${quoteShell(portFile)} --skip-health-check`,
    { env }
  );
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(join(home, "envs", envName, ".openclaw/openclaw.json"), "utf8"));
  assert.equal(config.models.providers.openai.baseUrl, "http://127.0.0.1:12345/v1");
  const forwarded = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1));
  assert.equal(forwarded.args.includes(portFile), false);
  assert.equal(forwarded.args.includes(helper), false);
  assert.equal(forwarded.args.includes("--port"), true);
  await writeFile(portFile, "70000");
  const badPort = await runCommand(
    `ocm env exec ${quoteShell(envName)} -- node ${quoteShell(helper)} --port-file ${quoteShell(portFile)} --skip-health-check`,
    { env }
  );
  assert.notEqual(badPort.status, 0);
  assert.match(badPort.stderr, /invalid mock-provider port/);
  const pressure = await runCommand(
    `ocm env exec ${quoteShell(envName)} -- node ${quoteShell(join(repoRoot, "support/prepare-many-plugin-pressure-state.mjs"))} --expected-count 80`,
    { env }
  );
  assert.equal(pressure.status, 0, pressure.stderr);
  assert.equal((await readdir(join(home, "envs", envName, ".openclaw/fixture-plugins"))).length, 80);
  const assertion = await runCommand(
    `node ${quoteShell(join(repoRoot, "support/assert-many-plugin-pressure-state.mjs"))} --env ${envName} --expected-count 80`,
    { env }
  );
  assert.equal(assertion.status, 0, assertion.stderr);
  assert.equal(JSON.parse(assertion.stdout).ok, true);
}

async function verifyRuntimeHelper({ env }) {
  const result = await runCommand(
    `${quoteShell(process.execPath)} --input-type=module -e ${quoteShell(`
      import { prepareOpenClawRuntimeFromOcmEnv } from ${JSON.stringify(join(repoRoot, "support/openclaw-runtime.mjs"))};
      const cwd = process.cwd();
      const runtime = prepareOpenClawRuntimeFromOcmEnv("kova-runtime-helper");
      process.stdout.write(JSON.stringify({ cwdUnchanged: cwd === process.cwd(), root: runtime.root }));
    `)}`,
    { env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwdUnchanged: true, root: "/candidate-private/not-readable" });
}

async function verifyScenarioLifecycle({ env, ocmLog }) {
  const { executeScenario } = await import("../src/runner.mjs");
  const { resolveTarget } = await import("../src/targets.mjs");
  const { loadProfile } = await import("../src/registries/profiles.mjs");
  const profile = await loadProfile("release");
  for (const scenarioId of ["fresh-install", "gateway-performance", "bundled-plugin-startup", "agent-cold-warm-message"]) {
    const scenario = JSON.parse(await readFile(join(repoRoot, "scenarios", `${scenarioId}.json`), "utf8"));
    const stateId = scenarioId === "bundled-plugin-startup" ? "many-bundled-plugins" :
      scenarioId === "gateway-performance" ? "onboarded-user" :
      scenarioId === "agent-cold-warm-message" ? profile.entries.find((entry) => entry.scenario === scenarioId).state : "fresh";
    if (scenarioId === "agent-cold-warm-message") assert.equal(stateId, "mock-openai-provider");
    const state = JSON.parse(await readFile(join(repoRoot, "states", `${stateId}.json`), "utf8"));
    const context = {
      target: "runtime:fixture", targetPlan: resolveTarget("runtime:fixture", "target"),
      state, runId: `transport-${scenarioId}`, timeoutMs: 15000,
      resourceSampling: false, nodeProfile: true,
      auth: { requestedMode: "skip", redactionValues: [] },
      commandEnv: env
    };
    const record = await runWithCommandEnv(env, () => executeScenario(scenario, context));
    for (const phase of record.phases) {
      assert.equal((phase.results ?? []).every((result) => result.status === 0), true,
        `${scenarioId}/${phase.id}: ${JSON.stringify(phase.results)}`);
    }
    assert.equal(record.cleanup, "destroyed");
    assert.equal(record.teardownErrors, undefined, JSON.stringify(record.teardownErrors));
    if (stateId === "mock-openai-provider") {
      assert.equal(record.auth.applied, true);
      assert.equal(record.phases.some((phase) => phase.id === "auth-cleanup"), true);
    }
    const retainedProfiles = await Promise.all(record.postCleanupNodeProfiles.artifacts
      .filter((path) => path.endsWith(".cpuprofile"))
      .map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    assert.equal(retainedProfiles.filter((profile) => profile.testMarker === "exit-flush").length, 1,
      "the complete exit-flushed profile must be exported before destroy");
    const events = (await readFile(ocmLog, "utf8")).trim().split("\n").map(JSON.parse).filter((item) => item.envName === record.envName);
    const stop = events.findIndex((item) => item.args.slice(0, 2).join(" ") === "service stop");
    const finalExport = events.findLastIndex((item) => item.args.slice(0, 3).join(" ") === "env artifact export");
    const destroy = events.findIndex((item) => item.args.slice(0, 2).join(" ") === "env destroy");
    assert.equal(stop >= 0 && finalExport > stop && destroy > finalExport, true, "stop, final export, destroy order");
  }
}
