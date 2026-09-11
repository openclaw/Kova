import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
import { appendFileSync } from "node:fs";
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
  await verifyBaseAdmission({ env, log, ocmLog });
  const result = await runWithCommandEnv(env, () => runCommand("ocm --version"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "transport-ocm");
  const nested = await runCommand(
    `${quoteShell(process.execPath)} -e ${quoteShell('process.stdout.write(require("node:child_process").execFileSync("ocm", ["--version"]))')}`,
    { env }
  );
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stdout, "transport-ocm", "nested helpers must retain transport");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.cwd, home, "cwd must be applied inside the prefix");
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
  assert.equal(checkCommand("ocm", ["--version"], { env }).stdout, "transport-ocm");
  const { captureProcessSnapshot } = await import("../src/collectors/resources.mjs");
  captureProcessSnapshot({ envName: "kova-sync-transport", commandEnv: env });
  assert.match(await readFile(ocmLog, "utf8"), /kova-sync-transport/);
  const inert = "$(touch SHOULD_NOT_EXIST); ' quoted";
  await runCommand(`ocm --version ${quoteShell(inert)}`, { env });
  const last = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(last.args.at(-1), inert);
  for (const value of ["", "[]", "{}", JSON.stringify({ ...transport, cwd: "relative" })]) {
    await assert.rejects(runCommand("ocm --version", { env: { ...env, KOVA_OCM_TRANSPORT_JSON: value } }), /KOVA_OCM_TRANSPORT_JSON/);
  }
  const alternateCwd = join(home, "working");
  await mkdir(alternateCwd);
  const explicitCwd = { ...env, KOVA_OCM_TRANSPORT_JSON: JSON.stringify({ ...transport, cwd: alternateCwd }) };
  assert.equal((await runCommand("ocm --version", { env: explicitCwd })).status, 0);
  assert.equal(JSON.parse((await readFile(ocmLog, "utf8")).trim().split("\n").at(-1)).cwd, alternateCwd);
  await verifyAmbientNodeOptions({ env, transport, log });
  await verifyConfigReads({ home, env, log });
  await verifyStateWriters({ env, home, log });
  await verifyRuntimeHelper({ env });
  const { verifyRuntimeBoundaries } = await import("./ocm-runtime-boundaries.mjs");
  await verifyRuntimeBoundaries({ root, home, env, transport, binary });
  console.log("PASS OCM command/config transport and pre-provision admission");
} finally {
  if (previousHome === undefined) delete process.env.KOVA_HOME;
  else process.env.KOVA_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}

async function verifyBaseAdmission({ env, log, ocmLog }) {
  const { executeScenario } = await import("../src/runner.mjs");
  for (const scenarioId of ["fresh-install", "gateway-performance", "bundled-plugin-startup", "agent-cold-warm-message"]) {
    const scenario = JSON.parse(await readFile(join(repoRoot, "scenarios", `${scenarioId}.json`), "utf8"));
    const before = await readdir(root);
    let targetPlanningReached = false;
    await assert.rejects(executeScenario(scenario, {
      commandEnv: env,
      target: "runtime:fixture",
      runId: "base-admission",
      state: { id: "fresh" },
      auth: { requestedMode: "skip", redactionValues: [] },
      get targetPlan() {
        targetPlanningReached = true;
        throw new Error("target planning reached before transport admission");
      },
      onPhase() { throw new Error("candidate lifecycle reached before transport admission"); }
    }), /cross-user scenario execution requires diagnostic collection integration/);
    assert.equal(targetPlanningReached, false, "base admission must precede target planning");
    assert.deepEqual(await readdir(root), before, "rejection must not create runner artifacts");
  }
  await assert.rejects(readFile(log), { code: "ENOENT" });
  await assert.rejects(readFile(ocmLog), { code: "ENOENT" });
  console.log("PASS base admission: four scenarios rejected before planning, artifacts, or OCM");
}

async function verifyAmbientNodeOptions({ env, transport, log }) {
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
    assert.equal(call.env.NODE_OPTIONS, "--no-warnings");
    assert.equal(checkCommand("ocm", ["--version"], { env: commandEnv }).stdout, "transport-ocm");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
}

async function verifyConfigReads({ home, env, log }) {
  const { readOcmArtifactSync } = await import("../src/ocm/transport.mjs");
  const candidate = join(home, "envs", "kova-config", ".openclaw");
  await mkdir(candidate, { recursive: true });
  const config = Buffer.from('{"gateway":{"auth":{"token":"synthetic-config-token"}}}\n');
  await writeFile(join(candidate, "openclaw.json"), config, { mode: 0o600 });
  const options = { env, maxBytes: 1024 * 1024, timeoutMs: 10000 };
  assert.deepEqual(readOcmArtifactSync("kova-config", ".openclaw/openclaw.json", options), config);
  for (const path of ["oversize", "partial-error"]) {
    assert.throws(() => readOcmArtifactSync("kova-config", path, { ...options, maxBytes: 16 }), /failed/);
  }
  for (const path of ["../outside", "/absolute", "a/../outside", "a\\outside", ""]) {
    assert.throws(() => readOcmArtifactSync("kova-config", path, options), /relative/);
  }
  const start = Date.now();
  assert.throws(() => readOcmArtifactSync("kova-config", "wait-for-timeout", {
    ...options, timeoutMs: 500
  }), /failed/);
  const call = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1));
  assert.equal(call.args.includes("wait-for-timeout"), true);
  assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
  assert.ok(Date.now() - start < 3000, "sync config timeout must remain bounded");
}

async function verifyStateWriters({ env, home, log }) {
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
