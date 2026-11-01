import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { checkCommand, quoteShell, spawnOwnedProcess } from "../src/commands.mjs";

const commandsHref = new URL("../src/commands.mjs", import.meta.url).href;
const cliHref = new URL("../bin/kova.mjs", import.meta.url).href;
const filename = fileURLToPath(import.meta.url);
const ownedStopCases = [
  "exited-before-stop", "exits-during-grace", "live-group", "replacement-group",
  "probe-permission", "live-child-absent-group", "probe-error", "error-event-only",
  "normal-term", "stubborn-kill", "persona-exited", "persona-live-group"
];

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
    const env = { ...process.env };
    delete env.KOVA_OCM_TRANSPORT_JSON;
    delete env.KOVA_NETWORK_FRONTAGE_ENABLED;
    for (const name of ownedStopCases) {
      const probe = await runProbe([filename, "--owned-stop-probe", name, parentDir], env);
      assert.equal(probe.status, 0, `${name}: ${probe.stderr}`);
      assert.equal(probe.stdout.trim(), `PASS ${name}`);
    }
  }
}

function processError(code) {
  return Object.assign(new Error(`synthetic ${code}`), { code, syscall: "kill" });
}

function groupAbsent(kill, pid) {
  try { kill(-pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(10);
  }
}

async function checkOwnedStopCase(name) {
  const originalKill = process.kill;
  const stubborn = name === "stubborn-kill";
  const source = `${stubborn ? "process.on('SIGTERM', () => {});" : ""}
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(99), 20000);`;
  const owned = spawnOwnedProcess(process.execPath, ["-e", source]);
  const child = owned.child;
  let childClosed = false, exitTimer;
  child.once("close", () => { childClosed = true; });
  const signals = [], probes = [];
  const denied = processError("EPERM"), observationError = processError("EIO");
  const exited = ["exited-before-stop", "replacement-group", "probe-error"].includes(name);
  const ordinary = ["normal-term", "stubborn-kill"].includes(name);
  try {
    await new Promise((accept, reject) => {
      const ready = () => { child.off("error", reject); accept(); };
      child.stdout.once("data", ready);
      child.once("error", reject);
    });
    assert.ok(Number.isInteger(child.pid) && child.pid > 1);
    if (exited) {
      child.kill("SIGTERM");
      await owned.closed;
      assert.equal(childClosed, true);
      assert.equal(groupAbsent(originalKill, child.pid), true);
    }
    if (name === "error-event-only") {
      child.emit("error", processError("EIO"));
      await owned.closed;
      assert.equal(childClosed, false, "an error event leaves the real child alive");
    }
    process.kill = (pid, signal) => {
      if (pid !== -child.pid) return originalKill(pid, signal);
      if (signal !== 0) {
        signals.push(signal);
        if (ordinary) return originalKill(pid, signal);
        if (name === "exits-during-grace" && signals.length === 1) {
          exitTimer = setTimeout(() => child.kill("SIGTERM"), 100);
        }
        throw denied;
      }
      probes.push(childClosed);
      if (name === "replacement-group") return true;
      if (name === "probe-permission") throw processError("EPERM");
      if (["live-child-absent-group", "error-event-only"].includes(name)) throw processError("ESRCH");
      if (name === "probe-error") throw observationError;
      return originalKill(pid, signal);
    };
    if (ordinary || ["exited-before-stop", "exits-during-grace"].includes(name)) {
      await owned.stop();
      assert.equal(childClosed, true, "stop must join the exact child");
      assert.equal(groupAbsent(originalKill, child.pid), true, "stop must observe actual group absence");
    } else {
      await assert.rejects(owned.stop(), (error) => {
        assert.strictEqual(error, denied, "reconciliation must preserve the initial error object");
        return true;
      });
      assert.equal(childClosed, exited);
    }
    assert.deepEqual(signals, stubborn ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"], "EPERM must never cause another nonzero signal");
    assert.ok(probes.length > 0, "settlement must inspect group existence");
    if (name === "exits-during-grace") assert.ok(probes.includes(false), "the child must still be alive when reconciliation begins");
    if (stubborn) assert.equal(child.signalCode, "SIGKILL");
    if (name === "normal-term") assert.equal(child.signalCode, "SIGTERM");
  } finally {
    process.kill = originalKill;
    clearTimeout(exitTimer);
    if (!childClosed) child.kill("SIGKILL");
    await waitUntil(() => childClosed, "probe child must close during teardown");
    await owned.stop();
  }
}

async function checkPersonaStopCase(name, parentDir) {
  const { createPersonaGateway } = await import("../src/persona/lifecycle.mjs");
  const root = await mkdtemp(join(parentDir, "persona-stop-"));
  const configPath = join(root, "openclaw.json"), bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: "synthetic-stop-auth" } } }));
  await writeFile(join(bin, "ocm"), `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(filename)} --persona-stop-child "$@"\n`, { mode: 0o755 });
  const reservation = createServer();
  await new Promise((accept, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", accept); });
  const port = reservation.address().port;
  await new Promise((accept) => reservation.close(accept));
  const originalWebSocket = globalThis.WebSocket, originalKill = process.kill;
  let connectionCloses = 0, pid;
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event", event: "connect.challenge" }) })));
    }
    send(text) {
      const request = JSON.parse(text);
      assert.ok(["connect", "config.get"].includes(request.method));
      const payload = request.method === "config.get" ? { path: configPath } : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) })));
    }
    close() { connectionCloses++; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  };
  const metadata = { name: "stop-fixture", root, stateDir: root, configPath, gatewayPort: port };
  const gateway = createPersonaGateway(metadata.name, async (command) => {
    assert.equal(command, `ocm env show ${quoteShell(metadata.name)} --json`);
    return { status: 0, stdout: JSON.stringify(metadata), stderr: "" };
  }, { env: { PATH: `${bin}${delimiter}${process.env.PATH}` }, authFromRuntimeConfig: true });
  const denied = processError("EPERM"), signals = [];
  try {
    await gateway.start();
    await gateway.assertOwned();
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    pid = (await response.json()).pid;
    assert.ok(Number.isInteger(pid) && pid > 1);
    if (name === "persona-exited") {
      originalKill(pid, "SIGTERM");
      await waitUntil(() => groupAbsent(originalKill, pid), "persona fixture must exit before stop");
    }
    process.kill = (target, signal) => {
      if (target !== -pid) return originalKill(target, signal);
      if (signal !== 0) { signals.push(signal); throw denied; }
      return originalKill(target, signal);
    };
    if (name === "persona-exited") {
      await gateway.stop();
      await gateway.stop();
    } else {
      await assert.rejects(gateway.stop(), (error) => { assert.strictEqual(error, denied); return true; });
      assert.equal(groupAbsent(originalKill, pid), false, "failed stop must retain the real process");
    }
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.ok(connectionCloses > 0, "the persona caller must close its RPC connection");
  } finally {
    process.kill = originalKill;
    try {
      await gateway.stop();
      if (pid) assert.equal(groupAbsent(originalKill, pid), true, "persona retry must join its retained process");
    } finally {
      globalThis.WebSocket = originalWebSocket;
      await rm(root, { recursive: true, force: true });
    }
  }
}

function startPersonaStopChild() {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  assert.ok(Number.isInteger(port) && port > 0);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ pid: process.pid }));
  });
  server.listen(port, "127.0.0.1");
  setTimeout(() => process.exit(99), 20000).unref();
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
  if (process.argv[2] === "--persona-stop-child") startPersonaStopChild();
  else if (process.argv[2] === "--owned-stop-probe") {
    const name = process.argv[3];
    assert.ok(ownedStopCases.includes(name));
    if (name.startsWith("persona-")) await checkPersonaStopCase(name, process.argv[4]);
    else await checkOwnedStopCase(name);
    console.log(`PASS ${name}`);
  } else {
    const root = await mkdtemp(join(tmpdir(), "kova-check-command-timeout-"));
    try {
      await runCheckCommandTimeoutChecks(root);
      console.log("PASS check command timeout and setup verdict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
