import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommand } from "../src/commands.mjs";

const commandsHref = new URL("../src/commands.mjs", import.meta.url).href;
const cliHref = new URL("../bin/kova.mjs", import.meta.url).href;

export async function runCheckCommandTimeoutChecks(parentDir) {
  const probeScript = join(parentDir, "probe.mjs");
  await writeFile(probeScript, `import { checkCommand } from ${JSON.stringify(commandsHref)};
const results = [];
for (const handler of [null, "process.exit(0)", ""]) {
  const source = (handler === null ? "" : "process.on('SIGTERM', () => {" + handler + "});")
    + "setInterval(() => {}, 1000);";
  const result = checkCommand(process.execPath, ["-e", source], { timeoutMs: 1000 });
  results.push({ status: result.status, timedOut: result.timedOut, errorCode: result.error?.code });
}
console.log(JSON.stringify(results));
`, "utf8");

  const probe = await runProbe([probeScript]);
  assert.equal(probe.status, 0, probe.stderr);
  const results = JSON.parse(probe.stdout);
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.timedOut, true, "even SIGTERM handlers must not prevent the deadline");
    assert.notEqual(result.status, 0, "timed-out helpers must not report success");
    assert.equal(result.errorCode, "ETIMEDOUT");
  }

  const healthy = checkCommand(process.execPath, ["--version"]);
  assert.equal(healthy.status, 0, "node --version must still succeed");
  assert.equal(healthy.timedOut, false);
  assert.equal(healthy.timeoutMs, 30000);
  assert.match(healthy.stdout, /^v\d+/);
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => checkCommand(process.execPath, ["--version"], { timeoutMs }), /positive integer/);
  }

  if (process.platform !== "win32") {
    await checkSetupTimeoutVerdict(parentDir);
  }
}

async function checkSetupTimeoutVerdict(parentDir) {
  const binDir = join(parentDir, "bin");
  await mkdir(binDir);
  await writeFile(join(binDir, "ocm"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o755 });
  const setupScript = join(parentDir, "setup-probe.mjs");
  // A timeout error must win even if the OS reports a successful child exit.
  await writeFile(setupScript, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const original = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => command === "ocm" && args[0] === "--version"
  ? { status: 0, stdout: "ocm fixture", stderr: "", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }
  : original(command, args, options);
syncBuiltinESMExports();
await import(${JSON.stringify(cliHref)});
`, "utf8");
  const env = {
    ...process.env,
    KOVA_HOME: join(parentDir, "kova-home"),
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    SHELL: "/bin/sh"
  };
  const json = await runProbe([setupScript, "setup", "--ci", "--json"], env);
  assert.equal(json.status, 1, "setup must exit nonzero on timeout despite status zero");
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, false);
  const failed = report.checks.filter((check) => check.required && check.status !== "PASS");
  assert.deepEqual(failed.map((check) => check.id), ["ocm-available"]);
  assert.equal(failed[0].message, "timed out after 30000ms");
  const plain = await runProbe([setupScript, "setup", "--ci", "--plain"], env);
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /FAIL ocm-available: timed out after 30000ms/);
}

async function runProbe(args, env = process.env) {
  const child = spawn(process.execPath, args, {
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let expired = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    expired = true;
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  }, 60000);
  try {
    const status = await new Promise((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", resolveStatus);
    });
    assert.equal(expired, false, "probe must finish without the outer watchdog");
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const root = await mkdtemp(join(tmpdir(), "kova-check-command-timeout-"));
  try {
    await runCheckCommandTimeoutChecks(root);
    console.log("PASS check command timeout and setup verdict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
