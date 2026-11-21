import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const scenario = "gateway-cold-turn-calibration";

export async function readGatewayColdTurnCalibration(report) {
  if (report?.schemaVersion !== "kova.report.v1" || report.mode !== "execution" ||
      report.platform?.os !== "linux" || !Array.isArray(report.records)) {
    throw new Error("Expected a Kova Linux execution report");
  }
  const records = report.records.filter((record) => record.scenario === scenario);
  if (records.length === 0) throw new Error(`Report has no ${scenario} records`);

  return {
    schemaVersion: "kova.gatewayColdTurnCalibration.v1",
    runId: report.runId,
    target: report.target,
    targetIdentity: report.targetIdentity ?? null,
    platform: report.platform,
    samples: await Promise.all(records.map(readRecord))
  };
}

async function readRecord(record) {
  const fail = (reason) => {
    throw new Error(`${scenario} repeat ${record.repeat?.index}: ${reason}`);
  };
  const startup = record.phases.find(({ id }) => id === "gateway-start");
  const readiness = startup?.metrics?.readiness;
  const { pid, startTicks } = readiness?.processIdentity ?? {};
  if (!readiness?.ready || !readiness.identityMatched || !Number.isInteger(pid) ||
      pid <= 0 || !Number.isInteger(startTicks) || startTicks < 0) {
    fail("Gateway readiness identity unavailable");
  }
  const settled = startup.startupResources?.settledRss;
  const settledAt = Date.parse(settled?.sampledAt);
  if (!Number.isFinite(settledAt) || settled?.status !== "complete" || settled.targetMs !== 120000 ||
      !Number.isFinite(settled.elapsedMs) || settled.elapsedMs < settled.targetMs ||
      !Number.isFinite(settled.rssMb) || settled.rssMb <= 0) {
    fail("settled Gateway RSS unavailable");
  }

  const command = record.phases.find(({ id }) => id === "cold-gateway-session-turn")?.results?.[0];
  const turn = command?.status === 0 ? JSON.parse(command.stdout) : null;
  const { sendStartedAtEpochMs: start, activeFinishedAtEpochMs: end, firstAnswerDeltaMs } = turn ?? {};
  if (!turn?.ok || !turn.createSession || !turn.expectedTextPresent ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      settledAt > start) {
    fail("successful cold turn after the settled sample unavailable");
  }
  if (!Number.isFinite(firstAnswerDeltaMs) || firstAnswerDeltaMs < 0) {
    fail("first streamed answer unavailable");
  }
  const artifactPath = command.resourceSamples?.artifactPath;
  if (!artifactPath) fail("cold-turn resource sample artifact unavailable");

  let count = 0;
  let peakRssMb = 0;
  let maxSampleGapMs = 0;
  let previous = start;
  const lines = (await readFile(artifactPath, "utf8")).trim();
  for (const line of lines ? lines.split("\n") : []) {
    const sample = JSON.parse(line);
    const at = Date.parse(sample.timestamp);
    if (!Number.isFinite(at)) fail("resource sample timestamp unavailable");
    if (at < start || at > end) continue;

    // Linux CPU accounting retains exited processes with historical roles.
    const tree = sample.processes.filter((process) => process.currentRoles?.includes("gateway-tree"));
    if (sample.collectionStatus !== "ok" || at < previous || sample.gatewayPid !== pid ||
        !tree.some((process) => process.pid === pid && process.startTicks === startTicks) ||
        tree.some(({ rssMb }) => !Number.isFinite(rssMb) || rssMb < 0)) {
      fail("cold-turn resource sample does not identify the same Gateway tree");
    }
    peakRssMb = Math.max(peakRssMb, tree.reduce((total, { rssMb }) => total + rssMb, 0));
    maxSampleGapMs = Math.max(maxSampleGapMs, at - previous);
    previous = at;
    count += 1;
  }
  if (count === 0 || peakRssMb <= 0) fail("no active Gateway RSS samples");

  return {
    repeat: record.repeat.index,
    scenarioStatus: record.status,
    cleanup: record.cleanup,
    settledRssMb: settled.rssMb,
    settledElapsedMs: settled.elapsedMs,
    coldTurnPeakRssMb: Math.round(peakRssMb * 100) / 100,
    coldTurnSampleCount: count,
    coldTurnMaxSampleGapMs: Math.max(maxSampleGapMs, end - previous),
    firstAnswerDeltaMs
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Usage: node support/read-gateway-cold-turn-calibration.mjs <report-json>");
    }
    const report = JSON.parse(await readFile(process.argv[2], "utf8"));
    console.log(JSON.stringify(await readGatewayColdTurnCalibration(report), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
