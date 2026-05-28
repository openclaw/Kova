import { readFileSync } from "node:fs";

const SCHEMA = "kova.channelWorkflowResources.v1";
const CONFORMANCE_SCHEMA = "kova.channelConformanceArtifact.v1";
const CAPABILITY_RUN_SCHEMA = "kova.channelCapabilityRun.v1";

export function summarizeChannelWorkflowResources(results = []) {
  const rows = [];
  const artifacts = [];

  for (const result of results) {
    const payload = parseJsonObject(result?.stdout);
    if (payload?.schemaVersion !== CAPABILITY_RUN_SCHEMA ||
        payload.proofMode !== "channel-platform-conformance" ||
        !payload.artifactPath) {
      continue;
    }

    const artifact = readJsonFile(payload.artifactPath);
    if (artifact?.schemaVersion !== CONFORMANCE_SCHEMA || !Array.isArray(artifact.rows)) {
      continue;
    }

    const samples = readResourceSamples(result.resourceSamples?.artifactPath);
    if (samples.length === 0) {
      continue;
    }

    artifacts.push({
      channelId: artifact.channelId ?? payload.channelId ?? null,
      conformanceArtifactPath: payload.artifactPath,
      resourceSampleArtifactPath: result.resourceSamples?.artifactPath ?? null
    });

    for (const workflowRow of artifact.rows) {
      const summary = summarizeWorkflowRowResources({
        workflowRow,
        samples,
        commandStartedAtEpochMs: result.startedAtEpochMs,
        channelId: artifact.channelId ?? payload.channelId ?? null,
        conformanceArtifactPath: payload.artifactPath,
        resourceSampleArtifactPath: result.resourceSamples?.artifactPath ?? null
      });
      if (summary) {
        rows.push(summary);
      }
    }
  }

  const topByGatewayRss = rows
    .filter((row) => typeof row.peakGatewayRssMb === "number")
    .toSorted((left, right) => right.peakGatewayRssMb - left.peakGatewayRssMb)
    .slice(0, 8);
  const topByTrackedRss = rows
    .filter((row) => typeof row.peakTrackedRssMb === "number")
    .toSorted((left, right) => right.peakTrackedRssMb - left.peakTrackedRssMb)
    .slice(0, 8);

  return {
    schemaVersion: SCHEMA,
    available: rows.length > 0,
    caseCount: rows.length,
    attributedCaseCount: rows.filter((row) => row.sampleCount > 0).length,
    artifacts,
    topByGatewayRss,
    topByTrackedRss,
    rows
  };
}

function summarizeWorkflowRowResources({
  workflowRow,
  samples,
  commandStartedAtEpochMs,
  channelId,
  conformanceArtifactPath,
  resourceSampleArtifactPath
}) {
  const startedAtEpochMs = numberOrNull(workflowRow?.startedAtEpochMs);
  const finishedAtEpochMs = numberOrNull(workflowRow?.finishedAtEpochMs);
  if (startedAtEpochMs === null || finishedAtEpochMs === null || finishedAtEpochMs < startedAtEpochMs) {
    return null;
  }

  const commandStart = numberOrNull(commandStartedAtEpochMs);
  if (commandStart === null) {
    return null;
  }

  const windowStartedAtMs = Math.max(0, startedAtEpochMs - commandStart);
  const windowFinishedAtMs = Math.max(windowStartedAtMs, finishedAtEpochMs - commandStart);
  const intervalMs = sampleIntervalMs(samples);
  const toleranceMs = intervalMs === null ? 0 : Math.min(intervalMs, 1000);
  const windowSamples = samples.filter((sample) =>
    typeof sample.elapsedMs === "number" &&
    sample.elapsedMs >= windowStartedAtMs - toleranceMs &&
    sample.elapsedMs <= windowFinishedAtMs + toleranceMs
  );
  if (windowSamples.length === 0) {
    return null;
  }

  let peakTrackedRss = null;
  let peakGatewayRss = null;
  let maxCpu = null;
  let peakSample = null;
  let peakGatewaySample = null;

  for (const sample of windowSamples) {
    const trackedRss = sampleTotalRss(sample);
    const gatewayRss = sampleRoleRss(sample, "gateway");
    const cpu = sampleTotalCpu(sample);
    if (typeof trackedRss === "number" && (peakTrackedRss === null || trackedRss > peakTrackedRss)) {
      peakTrackedRss = trackedRss;
      peakSample = sample;
    }
    if (typeof gatewayRss === "number" && (peakGatewayRss === null || gatewayRss > peakGatewayRss)) {
      peakGatewayRss = gatewayRss;
      peakGatewaySample = sample;
    }
    if (typeof cpu === "number" && (maxCpu === null || cpu > maxCpu)) {
      maxCpu = cpu;
    }
  }

  return {
    schemaVersion: "kova.channelWorkflowResourceRow.v1",
    channelId,
    caseId: typeof workflowRow.id === "string" ? workflowRow.id : null,
    workflow: typeof workflowRow.workflow === "string" ? workflowRow.workflow : null,
    inventoryWorkflow: typeof workflowRow.inventoryWorkflow === "string" ? workflowRow.inventoryWorkflow : null,
    matrix: compactMatrix(workflowRow.matrix),
    status: typeof workflowRow.status === "string" ? workflowRow.status : null,
    userAction: typeof workflowRow.userAction === "string" ? workflowRow.userAction : null,
    durationMs: numberOrNull(workflowRow.durationMs),
    startedAtEpochMs,
    finishedAtEpochMs,
    windowStartedAtMs,
    windowFinishedAtMs,
    sampleCount: windowSamples.length,
    peakTrackedRssMb: roundNumber(peakTrackedRss),
    peakGatewayRssMb: roundNumber(peakGatewayRss),
    maxCpuPercent: roundNumber(maxCpu),
    peakTrackedRssAtMs: peakSample?.elapsedMs ?? null,
    peakGatewayRssAtMs: peakGatewaySample?.elapsedMs ?? null,
    conformanceArtifactPath,
    resourceSampleArtifactPath
  };
}

function readResourceSamples(path) {
  if (typeof path !== "string" || path.length === 0) {
    return [];
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonObject)
    .filter((sample) => sample && Array.isArray(sample.processes));
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseJsonObject(text) {
  if (typeof text !== "string" || !text.trim().startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sampleIntervalMs(samples) {
  if (samples.length < 2) {
    return null;
  }
  const first = numberOrNull(samples[0]?.elapsedMs);
  const second = numberOrNull(samples[1]?.elapsedMs);
  return first === null || second === null ? null : Math.max(0, second - first);
}

function sampleTotalRss(sample) {
  return roundNumber((sample.processes ?? []).reduce((total, process) => total + (process.rssMb ?? 0), 0));
}

function sampleRoleRss(sample, role) {
  return roundNumber((sample.processes ?? [])
    .filter((process) => processHasRole(process, role))
    .reduce((total, process) => total + (process.rssMb ?? 0), 0));
}

function sampleTotalCpu(sample) {
  return roundNumber((sample.processes ?? []).reduce((total, process) => total + (process.cpuPercent ?? 0), 0));
}

function processHasRole(process, role) {
  if (Array.isArray(process.roles)) {
    return process.roles.includes(role);
  }
  return String(process.role ?? "").split(",").includes(role);
}

function compactMatrix(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const matrix = {
    content: typeof value.content === "string" ? value.content : null,
    route: typeof value.route === "string" ? value.route : null,
    delivery: typeof value.delivery === "string" ? value.delivery : null,
    lifecycle: typeof value.lifecycle === "string" ? value.lifecycle : null
  };
  return Object.values(matrix).some(Boolean) ? matrix : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10) / 10
    : null;
}
