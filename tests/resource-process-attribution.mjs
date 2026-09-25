import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startResourceSampler, classifyRegistryRolesForProcess } from "../src/collectors/resources.mjs";
import { loadProcessRoles } from "../src/registries/process-roles.mjs";
import { checkRoleThresholds } from "../src/evaluation/violations.mjs";

const processRoles = await loadProcessRoles();

test("real Linux sampler attributes a generic title only during a local agent command", {
  skip: process.platform !== "linux"
}, async () => {
  const title = process.title;
  const dir = await fs.promises.mkdtemp(join(tmpdir(), "kova-generic-agent-"));
  try {
    for (const rootCommand of ["openclaw agent --local --message hi", "openclaw status"]) {
      const artifactPath = join(dir, rootCommand.includes("--local") ? "agent.jsonl" : "status.jsonl");
      let completion;
      try {
        process.title = "openclaw";
        completion = startResourceSampler(process.pid, { processRoles, rootCommand, artifactPath }).stop();
      } finally {
        process.title = title;
      }
      const summary = await completion;
      assert.equal(summary.cpuCoverageComplete, true, JSON.stringify(summary.errors));
      const samples = (await fs.promises.readFile(artifactPath, "utf8")).trim().split("\n").map(JSON.parse);
      const current = samples[0].processes.find((row) => row.pid === process.pid);
      assert.equal(current.command, "openclaw");
      const local = rootCommand.includes("--local");
      assert.equal(current.currentRoles.includes("agent-process"), local);
      assert.equal(current.currentRoles.includes("agent-cli"), false);
      assert.equal(current.currentRoles.includes("status-cli"), !local);
      if (local) assert.ok(summary.byRole["agent-process"].peakRssMb > 0);
      else assert.equal(summary.byRole["agent-process"], undefined);
    }
  } finally {
    process.title = title;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/frv-local-agent-census.json", import.meta.url), "utf8"));
const surface = JSON.parse(fs.readFileSync(new URL("../surfaces/agent-cli-local-turn.json", import.meta.url), "utf8"));
for (const captured of fixture.cases) test(
  "captured FRV record " + captured.record + " " + captured.phase + " attributes the generic-title agent", async () => {
    const summary = await startResourceSampler(captured.rootPid, {
      processRoles, rootCommand: captured.rootCommand,
      processLister: () => ({ ok: true, processes: captured.processes.map((row) => ({ ...row, cpuPercent: 0 })) })
    }).stop();
    const agent = captured.processes.find((row) => row.command === "openclaw");
    assert.equal(summary.byRole["agent-process"]?.peakRssMb, agent.rssMb);
    assert.equal(summary.byRole["agent-process"].peakRssProcess.pid, agent.pid);
    assert.ok(summary.byRole["agent-cli"].peakRssMb < 100);
    const violations = [];
    checkRoleThresholds(violations, summary.byRole, surface.roleThresholds);
    assert.deepEqual(violations, []);
  });

test("generic titles need command-tree ownership and a local agent invocation", () => {
  const classify = (command, rootCommand, existingRoles = ["command-tree"]) =>
    classifyRegistryRolesForProcess({ command }, { processRoles, rootCommand, existingRoles });
  assert.deepEqual(classify("openclaw", "ocm @kova -- agent --local --message hi"), ["agent-process"]);
  for (const command of ["openclaw status", "ocm @kova -- status", "openclaw agent --message hi",
    "openclaw status --message 'agent --local'", "node helper.mjs --message 'agent --local'"]) {
    assert.equal(classify("openclaw", command).includes("agent-process"), false, command);
  }
  assert.equal(classify("openclaw", "ocm @kova -- agent --local", ["gateway", "gateway-tree"]).includes("agent-process"), false);
  assert.equal(classify("openclaw", "ocm @kova -- agent --local", []).includes("agent-process"), false);
  assert.equal(classify("node /runtime/openclaw.mjs agent --local", "ocm @kova -- agent --local").includes("agent-process"), false);
  assert.equal(classify("openclaw-gateway", "ocm @kova -- agent --local").includes("agent-process"), false);
});

test("mixed helper commands use live owned ancestry, not helper-wide agent labels", async () => {
  const rootCommand = "node support/agent-network-offline.mjs --env kova-test";
  const row = (pid, ppid, command) => ({ pid, ppid, command, rssMb: 10, cpuPercent: 0 });
  const summary = await startResourceSampler(1, { processRoles, rootCommand,
    processLister: () => ({ ok: true, processes: [row(1, 0, rootCommand),
      row(2, 1, "ocm @kova-test -- agent --local --message hi"), row(3, 2, "openclaw"),
      row(4, 1, "ocm @kova-test -- status"), row(5, 4, "openclaw"),
      row(6, 99, "openclaw"), row(7, 99, "ocm @other -- agent --local")
    ] })
  }).stop();
  assert.equal(summary.byRole["agent-process"].peakProcessCount, 1);
  assert.equal(summary.byRole["agent-process"].peakRssProcess.pid, 3);
  assert.equal(summary.byRole["agent-process"].peakRssMb, 10);
});

for (const nestedCommand of [
  "ocm @kova-test -- status",
  "openclaw status",
  "node /runtime/openclaw.mjs status",
  "/usr/bin/node /runtime/openclaw.mjs status",
  "openclaw agent --message remote",
  "ocm @kova-test -- unknown-command"
]) test("nearer invocation overrides an agent root: " + nestedCommand, async () => {
  const rootCommand = "ocm @kova-test -- agent --local --message hi";
  const row = (pid, ppid, command, rssMb, cpuPercent) => ({ pid, ppid, command, rssMb, cpuPercent });
  const summary = await startResourceSampler(1, { processRoles, rootCommand,
    processLister: () => ({ ok: true, processes: [
      row(1, 0, rootCommand, 1, 0),
      row(2, 1, "openclaw", 10, 5),
      row(3, 2, nestedCommand, 1, 0),
      row(4, 3, "node helper.mjs", 1, 0),
      row(5, 4, "openclaw", 100, 50),
      row(6, 5, "node /runtime/openclaw.mjs agent --local --message status", 1, 0),
      row(7, 6, "openclaw", 20, 7)
    ] })
  }).stop();
  assert.equal(summary.byRole["agent-process"].peakProcessCount, 2);
  assert.equal(summary.byRole["agent-process"].peakRssMb, 30);
  assert.equal(summary.byRole["agent-process"].maxCpuPercent, 12);
  assert.equal(summary.byRole["agent-process"].peakRssProcess.pid, 7);
  if (nestedCommand.endsWith("status")) {
    assert.equal(summary.byRole["status-cli"].peakRssProcess.pid, 5);
    assert.equal(summary.byRole["status-cli"].maxCpuPercent, 50);
  }
});
