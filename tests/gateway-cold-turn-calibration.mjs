import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readGatewayColdTurnCalibration } from "../support/read-gateway-cold-turn-calibration.mjs";

test("cold-turn calibration requires the ready Gateway and a streamed answer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kova-cold-turn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifactPath = join(dir, "resources.jsonl");
  const readyAt = Date.UTC(2026, 0, 1);
  const start = readyAt + 121000;
  const targetMs = 120000;
  const identity = { pid: 42, startTicks: 300 };
  const gateway = { ...identity, currentRoles: ["gateway", "gateway-tree"], rssMb: 100 };
  const child = { pid: 43, startTicks: 310, currentRoles: ["gateway-tree"], rssMb: 50 };
  const retired = { pid: 44, startTicks: 305, roles: ["gateway-tree"], currentRoles: [], rssMb: 150 };
  const row = (offset, processes) => ({
    timestamp: new Date(start + offset).toISOString(),
    collectionStatus: "ok",
    gatewayPid: identity.pid,
    processes
  });
  const writeSamples = (...samples) => writeFile(artifactPath, samples.map((sample) => JSON.stringify(sample)).join("\n"));
  const turn = {
    ok: true,
    createSession: true,
    expectedTextPresent: true,
    sendStartedAtEpochMs: start,
    activeFinishedAtEpochMs: start + 500,
    firstAnswerDeltaMs: 220
  };
  const command = { status: 0, stdout: JSON.stringify(turn), resourceSamples: { artifactPath } };
  const settledRss = {
    status: "complete",
    sampledAt: new Date(readyAt + targetMs + 25).toISOString(),
    elapsedMs: targetMs + 25,
    targetMs,
    rssMb: 125
  };
  const report = {
    schemaVersion: "kova.report.v1",
    platform: { os: "linux" },
    mode: "execution",
    runId: "run",
    target: "npm:2026.11.6",
    records: [{
      scenario: "gateway-cold-turn-calibration",
      repeat: { index: 1 },
      status: "FAIL",
      cleanup: "destroyed",
      phases: [{
        id: "gateway-start",
        metrics: { readiness: { ready: true, identityMatched: true, processIdentity: identity } },
        startupResources: { settledRss }
      }, {
        id: "cold-gateway-session-turn",
        results: [command]
      }]
    }]
  };

  await writeSamples(row(-1, []), row(50, [gateway, child, retired]), row(310, [gateway]), row(501, []));
  const calibration = await readGatewayColdTurnCalibration(report);
  assert.deepEqual(calibration.samples, [{
    repeat: 1,
    scenarioStatus: "FAIL",
    cleanup: "destroyed",
    settledRssMb: 125,
    settledElapsedMs: 120025,
    coldTurnPeakRssMb: 150,
    coldTurnSampleCount: 2,
    coldTurnMaxSampleGapMs: 260,
    firstAnswerDeltaMs: 220
  }]);

  command.stdout = JSON.stringify({ ...turn, firstAnswerDeltaMs: null, timeToFirstAssistantMs: 300 });
  await assert.rejects(readGatewayColdTurnCalibration(report), /first streamed answer unavailable/);
  command.stdout = JSON.stringify(turn);

  await writeSamples(row(50, [gateway]), row(310, [{ ...gateway, startTicks: 301 }]));
  await assert.rejects(readGatewayColdTurnCalibration(report), /does not identify the same Gateway tree/);

  await writeSamples(row(-1, [gateway]), row(501, [gateway]));
  await assert.rejects(readGatewayColdTurnCalibration(report), /no active Gateway RSS samples/);

  settledRss.elapsedMs = 119999;
  await assert.rejects(readGatewayColdTurnCalibration(report), /settled Gateway RSS unavailable/);
});
