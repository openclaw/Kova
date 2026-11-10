import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";

// Complete runner proof: only OCM is faked; processes, /proc and HTTP are real.
await mkdir(join(process.cwd(), ".openclaw/tmp"), { recursive: true });
const root = await mkdtemp(join(process.cwd(), ".openclaw/tmp/startup-runner-"));
after(() => rm(root, { recursive: true, force: true }));
const previousHome = process.env.KOVA_HOME;
process.env.KOVA_HOME = join(root, "home");
const { executeScenario } = await import("../src/runner.mjs");
const { runWithCommandEnv } = await import("../src/commands.mjs");
const { collectResourceSummary } = await import("../src/evaluation/resources.mjs");
const { evaluateRecord } = await import("../src/evaluator.mjs");
if (previousHome === undefined) delete process.env.KOVA_HOME;
else process.env.KOVA_HOME = previousHome;

test("complete scenario records independent startup windows across a warm restart", {
  skip: process.platform !== "linux", timeout: 30000
}, async () => {
  const servicePath = join(root, "service.json");
  const birthsPath = join(root, "births.jsonl");
  const callsPath = join(root, "calls.jsonl");
  const gatewayPath = join(root, "gateway.mjs");
  await writeFile(gatewayPath, [
    "import { createServer } from 'node:http';",
    "import { writeFileSync, appendFileSync } from 'node:fs';",
    "const born = Date.now(); const readyAt = born + 2400;",
    "const server = createServer((req, res) => { const ready = Date.now() >= readyAt; res.writeHead(req.url === '/readyz' && !ready ? 503 : 200); res.end(JSON.stringify({ ready })); });",
    "server.listen(0, '127.0.0.1', () => {",
    "const state = { childPid: process.pid, gatewayPort: server.address().port, running: true, gatewayState: 'running', desiredRunning: true, born, readyAt };",
    "writeFileSync(" + JSON.stringify(servicePath) + ", JSON.stringify(state));",
    "appendFileSync(" + JSON.stringify(birthsPath) + ", JSON.stringify(state) + '\\n'); });"
  ].join("\n"));
  await writeFile(join(root, "ocm"), [
    "#!" + process.execPath,
    "import { spawn } from 'node:child_process';",
    "import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const statePath = " + JSON.stringify(servicePath) + ";",
    "const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};",
    "appendFileSync(" + JSON.stringify(callsPath) + ", JSON.stringify(args) + '\\n');",
    "if (args[0] === 'service' && args[1] === 'status') { console.log(JSON.stringify(read()));",
    "} else if (args[0] === 'service' && ['start', 'restart'].includes(args[1])) {",
    "const old = read(); if (old.childPid) { process.kill(old.childPid, 'SIGTERM'); unlinkSync(statePath); }",
    "const child = spawn(process.execPath, [" + JSON.stringify(gatewayPath) + "], { detached: true, stdio: 'ignore' }); child.unref();",
    "const deadline = Date.now() + 5000; while (read().childPid !== child.pid && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));",
    "if (read().childPid !== child.pid) process.exit(3); console.log('{}');",
    "} else if (args[0] === 'env' && args[1] === 'destroy') {",
    "const state = read(); if (state.childPid) process.kill(state.childPid, 'SIGTERM'); if (existsSync(statePath)) unlinkSync(statePath); console.log('{}');",
    "} else if (args[0]?.startsWith('@') && args.slice(1).join(' ') === '-- gateway call system.info --json') {",
    "const state = read(); console.log(JSON.stringify({ nodeVersion: process.version, pid: state.childPid, port: state.gatewayPort }));",
    "} else if (args[0] === 'logs' || (args[0] === 'env' && args[1] === 'exec')) {",
    "/* No log or diagnostic artifacts in this synthetic runtime. */",
    "} else { console.error('unexpected fixture OCM command', args); process.exit(2); }"
  ].join("\n"), { mode: 0o755 });
  const env = { PATH: root + delimiter + process.env.PATH, KOVA_OCM_TRANSPORT_JSON: undefined };
  const scenario = {
    id: "startup-runner", title: "Synthetic warm restart", surface: "gateway", auth: { mode: "none" },
    thresholds: { gatewayReadyMs: 5000, warmRestartReadyMs: 5000 },
    phases: [
      { id: "provision", title: "Start", healthScope: "readiness", measurementScope: "product",
        commands: ["ocm service start {env} --json", "ocm service status {env} --json"] },
      { id: "warm-restart", title: "Restart", healthScope: "readiness", measurementScope: "product",
        commands: ["ocm service restart {env} --json", "ocm service status {env} --json"] }
    ]
  };
  try {
    const record = await runWithCommandEnv(env, () => executeScenario(scenario, {
      runId: "startup-runner", target: "fixture", targetPlan: { kind: "fixture", value: "fixture" },
      commandEnv: env, timeoutMs: 10000, resourceSampleIntervalMs: 250,
      readinessIntervalMs: 50, healthSamples: 1, healthIntervalMs: 0, openclawDiagnostics: false
    }));
    assert.equal(record.status, "PASS", JSON.stringify({ violations: record.violations, teardownErrors: record.teardownErrors, incompleteReason: record.incompleteReason }));
    assert.equal(record.cleanup, "destroyed");
    assert.equal(record.targetRuntime.collectionStatus, "ok");
    const births = (await readFile(birthsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(births.length, 2);
    assert.notEqual(births[0].childPid, births[1].childPid);
    const phases = record.phases.filter(phase => phase.startupResourceExpected);
    assert.deepEqual(phases.map(phase => phase.id), ["provision", "warm-restart"]);
    const saved = [];
    for (const [index, phase] of phases.entries()) {
      assert.equal(phase.results.length, 2);
      const startup = phase.startupResources;
      assert.equal(startup.coverage.status, "complete", JSON.stringify(startup));
      assert.equal(startup.coverage.readyIdentity.pid, births[index].childPid);
      assert.deepEqual(startup.resources.terminal.gatewayIdentity, phase.metrics.readiness.processIdentity);
      assert.ok(Date.parse(startup.coverage.terminalAt) >= Date.parse(phase.metrics.readiness.readyAt));
      assert.ok(phase.results.at(-1).finishedAtEpochMs < births[index].readyAt,
        "HTTP readiness must cover a real post-command startup interval");
      const contents = await readFile(startup.resources.artifactPath, "utf8");
      const samples = contents.trim().split("\n").map(JSON.parse);
      assert.ok(Date.parse(samples[0].timestamp) <= phase.results[0].startedAtEpochMs);
      assert.ok(samples.some(sample => Date.parse(sample.timestamp) > phase.results.at(-1).finishedAtEpochMs &&
        Date.parse(sample.timestamp) < births[index].readyAt && sample.processes.some(p => p.pid === births[index].childPid)),
        "continuous sampler observes Gateway after command accounting ends and before ready");
      assert.ok(samples.every(sample => sample.rootPid === null && !sample.processes.some(p => p.roles.includes("command-tree"))));
      saved.push([startup.resources.artifactPath, contents]);
    }
    const commandOnly = collectResourceSummary(phases.flatMap(phase => phase.results));
    assert.equal(record.measurements.resourceSampleCount, commandOnly.sampleCount);
    assert.ok(saved.every(([path]) => !commandOnly.artifacts.includes(path)));
    // Removing independent evidence leaves the existing CPU/RSS budgets intact.
    const withoutStartup = structuredClone(record);
    for (const phase of withoutStartup.phases) { delete phase.startupResources; delete phase.startupResourceExpected; }
    evaluateRecord(withoutStartup, scenario, { requireCpuContract: true });
    assert.deepEqual(withoutStartup.thresholdPolicy, record.thresholdPolicy);
    assert.deepEqual(withoutStartup.violations, record.violations);
    assert.equal(withoutStartup.measurements.cpuPercentMax, record.measurements.cpuPercentMax);
    assert.equal(withoutStartup.measurements.resourceSampleCount, record.measurements.resourceSampleCount);
    await delay(300);
    for (const [path, contents] of saved) assert.equal(await readFile(path, "utf8"), contents, "all phase samplers stopped");
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter(args => args[0] === "env" && args[1] === "destroy").length, 1);
  } finally {
    try {
      const births = (await readFile(birthsPath, "utf8")).trim().split("\n").map(JSON.parse);
      for (const { childPid } of births) {
        try { process.kill(childPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rm(root, { recursive: true, force: true });
  }
});
