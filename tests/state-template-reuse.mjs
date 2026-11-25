import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";

// Only OCM is faked: the real runner decides which commands each repeat runs.
await mkdir(join(process.cwd(), ".openclaw/tmp"), { recursive: true });
const root = await mkdtemp(join(process.cwd(), ".openclaw/tmp/state-template-"));
after(() => rm(root, { recursive: true, force: true }));
const previousHome = process.env.KOVA_HOME;
process.env.KOVA_HOME = join(root, "home");
const { runScenarioRepeats } = await import("../src/run/engine.mjs");
const { runWithCommandEnv } = await import("../src/commands.mjs");
if (previousHome === undefined) delete process.env.KOVA_HOME;
else process.env.KOVA_HOME = previousHome;

const callsPath = join(root, "calls.jsonl");
await writeFile(join(root, "ocm"), [
  "#!" + process.execPath,
  "import { appendFileSync } from 'node:fs';",
  "const args = process.argv.slice(2);",
  "appendFileSync(" + JSON.stringify(callsPath) + ", JSON.stringify(args) + '\\n');",
  "if (args[0] === 'env' && args[1] === 'exec') process.exit(0);",
  "console.log('{}');"
].join("\n"), { mode: 0o755 });
const env = { PATH: root + delimiter + process.env.PATH, KOVA_OCM_TRANSPORT_JSON: undefined };

const scenario = {
  id: "template-reuse", title: "Synthetic state reuse", surface: "gateway", auth: { mode: "none" },
  thresholds: {},
  phases: [
    { id: "env-create", title: "Create", measurementScope: "harness",
      commands: ["ocm start {env} --runtime fixture --no-service --json"] }
  ]
};
const state = {
  id: "slow-plugins", title: "Slow plugins", objective: "synthetic",
  setup: [{
    id: "install", title: "Install", intent: "Install fixtures", afterPhases: ["env-create"],
    commands: ["ocm @{env} -- plugins install first", "ocm @{env} -- plugins install second"],
    repeatRestoreCommands: ["ocm @{env} -- plugins list --json"],
    evidence: []
  }]
};

async function run(repeat) {
  await writeFile(callsPath, "");
  const records = await runWithCommandEnv(env, () => runScenarioRepeats({
    scenario,
    repeat,
    context: {
      runId: "kova-template-run", target: "fixture", targetPlan: { kind: "fixture", value: "fixture" },
      state, execute: true, commandEnv: env, timeoutMs: 10000, resourceSampling: false,
      healthSamples: 1, healthIntervalMs: 0, openclawDiagnostics: false
    }
  }));
  const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { records, calls };
}

test("later repeats restore the prepared state instead of rerunning its setup", { timeout: 30000 }, async () => {
  const { records, calls } = await run(3);
  const installs = calls.filter((args) => args.slice(1).join(" ").startsWith("-- plugins install"));
  assert.equal(installs.length, 2, "setup runs once");
  assert.equal(installs[0][0], `@${records[0].envName}`);

  const clones = calls.filter((args) => args[0] === "env" && args[1] === "clone");
  const template = clones[0][3];
  assert.match(template, /^kova-.*template/);
  assert.deepEqual(clones.map((args) => args.slice(2, 4)), [
    [records[0].envName, template],
    [template, records[1].envName],
    [template, records[2].envName]
  ]);
  for (const record of records.slice(1)) {
    const phase = record.phases.find((candidate) => candidate.id === "state-env-create");
    assert.equal(phase.restoredFromStateTemplate, template);
    assert.deepEqual(phase.results.map((result) => result.status), [0, 0, 0]);
    assert.equal(phase.commands.at(-1).endsWith("-- plugins list --json"), true);
  }
  const destroyed = calls.filter((args) => args[0] === "env" && args[1] === "destroy").map((args) => args[2]);
  assert.equal(destroyed.filter((name) => name === template).length, 1, "template removed once");
  assert.equal(destroyed.at(-1), template, "template outlives every repeat");
});

test("a single repeat never creates a template", { timeout: 30000 }, async () => {
  const { calls } = await run(1);
  assert.equal(calls.some((args) => args[0] === "env" && args[1] === "clone"), false);
  assert.equal(calls.filter((args) => args.slice(1).join(" ").startsWith("-- plugins install")).length, 2);
});
