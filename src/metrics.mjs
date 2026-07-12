import { runCommand } from "./commands.mjs";
import { ocmServiceStatusJson } from "./ocm/commands.mjs";
import { collectDiagnosticMetrics, collectOpenClawDiagnostics, triggerDiagnosticReport, triggerHeapSnapshot } from "./collectors/diagnostics.mjs";
import { collectHealthSamples, collectReadinessMetrics, summarizeHealthSamples } from "./collectors/readiness.mjs";
import { collectLogMetrics } from "./collectors/logs.mjs";
import { collectNodeProfileMetrics } from "./collectors/node-profiles.mjs";
import { collectTimelineMetrics } from "./collectors/timeline.mjs";
import { ENV_COLLECTOR_IDS, fullCollectionPolicy } from "./collection-policy.mjs";

export { collectNodeProfileMetrics };

export const ENV_METRICS_SCHEMA = "kova.envMetrics.v1";
export const PROCESS_METRICS_SCHEMA = "kova.processMetrics.v1";

export async function collectEnvMetrics(envName, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? 10000, 10000);
  const healthSampleCount = Math.max(1, Number(options.healthSamples ?? 3));
  const healthIntervalMs = Math.max(0, Number(options.healthIntervalMs ?? 250));
  const readinessTimeoutMs = Math.min(
    Math.max(0, Number(options.readinessTimeoutMs ?? 0)),
    Math.max(timeoutMs, Number(options.timeoutMs ?? timeoutMs))
  );
  const readinessIntervalMs = Math.max(50, Number(options.readinessIntervalMs ?? 250));
  const collectors = [];
  const collectionPolicy = options.collectionPolicy ?? fullCollectionPolicy();
  const metrics = {
    schemaVersion: ENV_METRICS_SCHEMA,
    collectedAt: new Date().toISOString(),
    artifactDir: options.artifactDir ?? null,
    collectorArtifactDirs: options.collectorArtifactDirs ?? null,
    collectionPolicy,
    collectors,
    serviceCommand: null,
    service: null,
    process: null,
    readiness: null,
    listening: null,
    health: null,
    healthSamples: [],
    healthSummary: null,
    logs: null,
    diagnostics: null,
    heapSnapshot: null,
    diagnosticReport: null,
    nodeProfiles: null,
    openclawDiagnostics: null,
    timeline: null,
    error: null
  };

  if (collectionPolicy.collectors?.service === false) {
    for (const collector of ENV_COLLECTOR_IDS) {
      recordSkippedCollector(collectors, collector, collectionPolicy.reason);
    }
    return metrics;
  }

  const service = await runCommand(ocmServiceStatusJson(envName), {
    timeoutMs,
    env: options.commandEnv
  });
  metrics.serviceCommand = {
    status: service.status,
    durationMs: service.durationMs,
    timedOut: service.timedOut
  };
  recordCollector(collectors, "service", service);

  if (service.status !== 0) {
    metrics.error = firstOutputLine(service.stderr) || firstOutputLine(service.stdout) || "service status unavailable";
    return metrics;
  }

  let serviceJson;
  try {
    serviceJson = JSON.parse(service.stdout);
  } catch (error) {
    metrics.error = `service status JSON parse failed: ${error.message}`;
    return metrics;
  }

  metrics.service = {
    gatewayState: serviceJson.gatewayState ?? null,
    running: serviceJson.running ?? null,
    desiredRunning: serviceJson.desiredRunning ?? null,
    childPid: serviceJson.childPid ?? null,
    gatewayPort: serviceJson.gatewayPort ?? null,
    runtimeReleaseVersion: serviceJson.runtimeReleaseVersion ?? null,
    runtimeReleaseChannel: serviceJson.runtimeReleaseChannel ?? null,
    issue: serviceJson.issue ?? null
  };

  if (collectorEnabled(collectionPolicy, "process")) {
    if (serviceJson.childPid) {
      metrics.process = await collectProcessMetrics(serviceJson.childPid, timeoutMs);
      recordCollector(collectors, "process", metrics.process);
    }
  } else {
    recordSkippedCollector(collectors, "process", collectionPolicy.reason);
  }

  const readinessMode = collectionPolicy.readiness ?? "wait";
  const readinessEnabled = collectorEnabled(collectionPolicy, "readiness");
  const healthEnabled = collectionPolicy.healthSamples !== false && collectorEnabled(collectionPolicy, "health");
  const probeEndpoint = activeNetworkFrontageProbeEndpoint(options.networkFrontageAllocation);
  if (serviceJson.gatewayPort && readinessEnabled && readinessMode !== "none" && shouldProbeReadiness(serviceJson, readinessTimeoutMs)) {
    await collectReadinessAndHealth(metrics, collectors, serviceJson.gatewayPort, {
      readinessTimeoutMs,
      readinessThresholdMs: options.readinessThresholdMs,
      readinessIntervalMs,
      probeTimeoutMs: timeoutMs,
      healthSampleCount,
      healthIntervalMs,
      timeoutMs,
      probeEndpoint,
      sampleHealthAfterReady: Boolean(serviceJson.childPid)
    });
  } else if (serviceJson.gatewayPort && readinessEnabled) {
    metrics.readiness = skippedReadinessMetrics(serviceJson.gatewayPort, {
      thresholdMs: options.readinessThresholdMs,
      deadlineMs: readinessTimeoutMs,
      reason: readinessMode === "none"
        ? "readiness wait disabled for this phase; collecting post-ready health samples"
        : serviceJson.childPid
        ? "readiness probe disabled for this phase"
        : "gateway process is not expected to be running for this phase"
    });
    recordCollector(collectors, "readiness", {
      commandStatus: 0,
      durationMs: 0,
      statusLabel: "INFO",
      error: null
    });
    if (healthEnabled && serviceJson.childPid && readinessMode === "none") {
      await collectPostReadyHealth(metrics, collectors, serviceJson.gatewayPort, {
        healthSampleCount,
        healthIntervalMs,
        timeoutMs,
        probeEndpoint
      });
    } else if (healthEnabled && serviceJson.childPid) {
      recordSkippedCollector(collectors, "health", "post-ready health sampling requires either a readiness wait or an explicit post-ready collection policy");
    } else if (!collectorEnabled(collectionPolicy, "health")) {
      recordSkippedCollector(collectors, "health", collectionPolicy.reason);
    }
  } else {
    if (!readinessEnabled) {
      recordSkippedCollector(collectors, "readiness", collectionPolicy.reason);
    }
    if (healthEnabled && serviceJson.gatewayPort && serviceJson.childPid) {
      await collectPostReadyHealth(metrics, collectors, serviceJson.gatewayPort, {
        healthSampleCount,
        healthIntervalMs,
        timeoutMs,
        probeEndpoint
      });
    } else if (!collectorEnabled(collectionPolicy, "health")) {
      recordSkippedCollector(collectors, "health", collectionPolicy.reason);
    }
  }

  await collectLogAndTimelineMetrics(metrics, collectors, envName, timeoutMs, options, collectionPolicy);

  if (!collectorEnabled(collectionPolicy, "heap-snapshot")) {
    recordSkippedCollector(collectors, "heap-snapshot", collectionPolicy.reason);
  } else if (options.heapSnapshot === true && serviceJson.childPid) {
    metrics.heapSnapshot = await triggerHeapSnapshot(
      envName,
      serviceJson.childPid,
      timeoutMs,
      options.artifactDir,
      options.commandEnv
    );
    recordCollector(collectors, "heap-snapshot", metrics.heapSnapshot, metrics.heapSnapshot.artifacts);
  }
  if (!collectorEnabled(collectionPolicy, "diagnostic-report")) {
    recordSkippedCollector(collectors, "diagnostic-report", collectionPolicy.reason);
  } else if (options.diagnosticReport === true && serviceJson.childPid) {
    metrics.diagnosticReport = await triggerDiagnosticReport(envName, serviceJson.childPid, timeoutMs, options.artifactDir, {
      signalAlreadySent: options.heapSnapshot === true,
      commandEnv: options.commandEnv
    });
    recordCollector(collectors, "diagnostic-report", metrics.diagnosticReport, metrics.diagnosticReport.artifacts);
  }
  await collectDiagnosticArtifactMetrics(metrics, collectors, envName, timeoutMs, options, collectionPolicy);

  return metrics;
}

function shouldProbeReadiness(serviceJson, readinessTimeoutMs) {
  if (readinessTimeoutMs <= 0) {
    return false;
  }
  if (serviceJson.childPid) {
    return true;
  }
  return serviceJson.running === true || serviceJson.desiredRunning === true || serviceJson.gatewayState === "running" || serviceJson.gatewayState === "backoff";
}

function skippedReadinessMetrics(port, { thresholdMs, deadlineMs, reason }) {
  return {
    schemaVersion: "kova.readiness.v1",
    deadlineMs,
    thresholdMs: Math.max(0, Number(thresholdMs ?? 0)),
    intervalMs: null,
    attempts: 0,
    ready: null,
    listeningReady: null,
    listeningReadyAtMs: null,
    healthReadyAtMs: null,
    classification: {
      state: "not-applicable",
      severity: "info",
      reason
    },
    listening: {
      host: "127.0.0.1",
      port: Number(port),
      ok: null,
      durationMs: null,
      error: reason
    },
    health: null,
    listeningAttempts: [],
    healthAttempts: []
  };
}

async function collectReadinessAndHealth(metrics, collectors, port, options) {
  const readinessStarted = Date.now();
  metrics.readiness = await collectReadinessMetrics(port, {
    timeoutMs: options.readinessTimeoutMs,
    thresholdMs: options.readinessThresholdMs,
    intervalMs: options.readinessIntervalMs,
    probeTimeoutMs: options.probeTimeoutMs,
    probeEndpoint: options.probeEndpoint
  });
  recordCollector(collectors, "readiness", {
    commandStatus: metrics.readiness.ready ? 0 : 1,
    durationMs: Date.now() - readinessStarted,
    timedOut: !metrics.readiness.ready && options.readinessTimeoutMs > 0,
    error: metrics.readiness.ready ? null : "readiness deadline expired"
  });

  metrics.listening = metrics.readiness.listening;
  if (options.sampleHealthAfterReady) {
    metrics.healthSamples = await collectHealthSamples(port, {
      count: options.healthSampleCount,
      intervalMs: options.healthIntervalMs,
      timeoutMs: options.timeoutMs,
      probeEndpoint: options.probeEndpoint
    });
    metrics.health = metrics.healthSamples.at(-1) ?? null;
  } else {
    metrics.health = metrics.readiness.health;
    metrics.healthSamples = metrics.readiness.healthAttempts;
  }
  metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
}

async function collectPostReadyHealth(metrics, collectors, port, options) {
  const healthStarted = Date.now();
  metrics.healthSamples = await collectHealthSamples(port, {
    count: options.healthSampleCount,
    intervalMs: options.healthIntervalMs,
    timeoutMs: options.timeoutMs,
    probeEndpoint: options.probeEndpoint
  });
  metrics.health = metrics.healthSamples.at(-1) ?? null;
  metrics.healthSummary = summarizeHealthSamples(metrics.healthSamples);
  const failureCount = metrics.healthSummary?.failureCount ?? 0;
  recordCollector(collectors, "health", {
    commandStatus: failureCount === 0 ? 0 : 1,
    durationMs: Date.now() - healthStarted,
    timedOut: false,
    error: failureCount === 0 ? null : `${failureCount} post-ready health sample(s) failed`
  });
}

function activeNetworkFrontageProbeEndpoint(allocation) {
  if (allocation?.status !== "active") {
    return null;
  }
  const host = allocation.frontageHost;
  const port = Number(allocation.frontagePort);
  if (typeof host !== "string" || host.length === 0 || !Number.isInteger(port) || port <= 0) {
    return null;
  }
  return {
    source: "network-frontage",
    host,
    port,
    url: `http://${host}:${port}`
  };
}

async function collectLogAndTimelineMetrics(metrics, collectors, envName, timeoutMs, options, collectionPolicy) {
  if (collectorEnabled(collectionPolicy, "logs")) {
    metrics.logs = await collectLogMetrics(envName, timeoutMs, options.artifactDir, options.commandEnv);
    recordCollector(collectors, "logs", metrics.logs, metrics.logs.artifacts);
  } else {
    recordSkippedCollector(collectors, "logs", collectionPolicy.reason);
  }

  if (collectorEnabled(collectionPolicy, "openclaw-diagnostics")) {
    if (metrics.logs) {
      metrics.openclawDiagnostics = collectOpenClawDiagnostics(metrics.logs);
      recordCollector(collectors, "openclaw-diagnostics", {
        commandStatus: 0,
        durationMs: 0,
        statusLabel: metrics.openclawDiagnostics.available ? "PASS" : "INFO",
        error: metrics.openclawDiagnostics.available ? null : "structured diagnostics unavailable"
      });
    } else {
      recordSkippedCollector(collectors, "openclaw-diagnostics", "OpenClaw diagnostics require collected logs");
    }
  } else {
    recordSkippedCollector(collectors, "openclaw-diagnostics", collectionPolicy.reason);
  }

  if (collectorEnabled(collectionPolicy, "timeline")) {
    metrics.timeline = await collectTimelineMetrics(options.artifactDir);
    recordCollector(collectors, "timeline", metrics.timeline, metrics.timeline.artifacts);
  } else {
    recordSkippedCollector(collectors, "timeline", collectionPolicy.reason);
  }
}

async function collectDiagnosticArtifactMetrics(metrics, collectors, envName, timeoutMs, options, collectionPolicy) {
  if (collectorEnabled(collectionPolicy, "diagnostics")) {
    metrics.diagnostics = await collectDiagnosticMetrics(
      envName,
      timeoutMs,
      options.artifactDir,
      options.commandEnv
    );
    recordCollector(collectors, "diagnostics", metrics.diagnostics, metrics.diagnostics.artifacts);
  } else {
    recordSkippedCollector(collectors, "diagnostics", collectionPolicy.reason);
  }

  if (collectorEnabled(collectionPolicy, "node-profiles")) {
    metrics.nodeProfiles = await collectNodeProfileMetrics(options.artifactDir);
    recordCollector(collectors, "node-profiles", metrics.nodeProfiles, metrics.nodeProfiles.artifacts);
  } else {
    recordSkippedCollector(collectors, "node-profiles", collectionPolicy.reason);
  }
}

function collectorEnabled(collectionPolicy, id) {
  return collectionPolicy.collectors?.[id] !== false;
}

function recordCollector(collectors, id, result, artifacts = []) {
  const status = result.statusLabel ?? collectorStatus(result);
  collectors.push({
    schemaVersion: "kova.collectorReceipt.v1",
    id,
    status,
    durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
    commandStatus: result.commandStatus ?? result.status ?? null,
    timedOut: result.timedOut === true,
    artifactCount: artifacts?.length ?? 0,
    artifacts: artifacts ?? [],
    error: result.error ?? null
  });
}

function recordSkippedCollector(collectors, id, reason) {
  collectors.push({
    schemaVersion: "kova.collectorReceipt.v1",
    id,
    status: "SKIPPED",
    durationMs: 0,
    commandStatus: null,
    timedOut: false,
    artifactCount: 0,
    artifacts: [],
    error: null,
    reason,
    required: false
  });
}

function collectorStatus(result) {
  if (result.timedOut === true) {
    return "FAIL";
  }
  const status = result.commandStatus ?? result.status;
  if (typeof status === "number" && status !== 0) {
    return "FAIL";
  }
  if (result.error) {
    return "WARN";
  }
  return "PASS";
}

async function collectProcessMetrics(pid, timeoutMs) {
  const result = await runCommand(`ps -p ${Number(pid)} -o pid= -o rss= -o %cpu= -o comm=`, { timeoutMs });
  const metrics = {
    schemaVersion: PROCESS_METRICS_SCHEMA,
    pid,
    commandStatus: result.status,
    durationMs: result.durationMs,
    rssKb: null,
    rssMb: null,
    cpuPercent: null,
    command: null,
    error: null
  };

  if (result.status !== 0) {
    metrics.error = firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "process metrics unavailable";
    return metrics;
  }

  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) {
    metrics.error = "empty ps output";
    return metrics;
  }

  const match = line.trim().match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
  if (!match) {
    metrics.error = `unexpected ps output: ${line}`;
    return metrics;
  }

  const rssKb = Number(match[2]);
  metrics.rssKb = rssKb;
  metrics.rssMb = Math.round((rssKb / 1024) * 10) / 10;
  metrics.cpuPercent = Number(match[3]);
  metrics.command = match[4];
  return metrics;
}

function firstOutputLine(value) {
  return String(value ?? "").trim().split("\n").find(Boolean);
}
