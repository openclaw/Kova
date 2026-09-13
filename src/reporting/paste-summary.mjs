import { healthKnownFailures, healthTotalFailures, healthTotalFailuresComplete } from "../health.mjs";
import {
  buildFailureBrief,
  buildRecommendedNextScenario,
  compactRolePeaks,
  selectPasteRecords
} from "./failure-brief.mjs";
import { firstFailedCommand } from "./failures.mjs";
import { markdownSafeValue } from "./markdown.mjs";
import {
  fencedSnippet,
  formatChannelWorkflowResourceRows,
  hasValue,
  healthSlowestText,
  resourceHeadlineText,
  resourceHeadlineValue,
  valueMb,
  valueMs,
  valuePercent
} from "./report-values.mjs";

export function renderPasteSummary(report) {
  const rawReport = report;
  const brief = markdownSafeValue(buildFailureBrief(report));
  const recommended = markdownSafeValue(buildRecommendedNextScenario(report));
  report = markdownSafeValue(report);
  const records = report.records ?? [];
  const rawRecords = rawReport.records ?? [];
  const lines = [
    "Kova OpenClaw Runtime Findings",
    "",
    `Run: ${report.runId}`,
    `Target: ${report.target}`,
    `Mode: ${report.mode}`,
    `Platform: ${report.platform?.os ?? "unknown"} ${report.platform?.release ?? ""} (${report.platform?.arch ?? "unknown"})`,
    ""
  ];

  if (report.gate) {
    lines.push(`Gate: ${report.gate.verdict}`);
    lines.push(`Blocking: ${report.gate.blockingCount}`);
    lines.push(`Warnings: ${report.gate.warningCount}`);
    const visibleCards = (report.gate.cards ?? []).filter((card) => card.severity !== "info");
    for (const card of visibleCards) {
      lines.push("");
      lines.push(`${card.severity.toUpperCase()}: ${card.scenario ?? "gate"}${card.state ? `/${card.state}` : ""}`);
      lines.push(`Summary: ${card.summary}`);
      lines.push(`Expected: ${card.expected}`);
      lines.push(`Actual: ${card.actual}`);
      lines.push(`Impact: ${card.impact}`);
      lines.push(`Likely owner: ${card.likelyOwner}`);
      if (card.failedCommand) {
        lines.push(`Command: ${card.failedCommand}`);
      }
    }
    if ((report.gate.infoCount ?? 0) > 0) {
      lines.push("");
      lines.push(`Info cards omitted: ${report.gate.infoCount}. See JSON report for full gate coverage details.`);
    }
    lines.push("");
  }

  if (brief) {
    lines.push("Failure Brief");
    lines.push("");
    lines.push(`Decision: ${brief.decision}`);
    lines.push(`Primary blocker: ${brief.primaryBlocker}`);
    lines.push(`Why: ${brief.why}`);
    if (brief.evidence.length > 0) {
      lines.push("Evidence:");
      for (const item of brief.evidence) {
        lines.push(`- ${item}`);
      }
    }
    lines.push(`Likely owner: ${brief.likelyOwner}`);
    lines.push("Paste to fixer:");
    lines.push(brief.fixerPrompt);
    lines.push("");
  }
  if (recommended) {
    lines.push("Recommended next scenario");
    lines.push("");
    lines.push(`Reason: ${recommended.reason}`);
    lines.push(`Command: ${recommended.command}`);
    lines.push("");
  }

  const recordsForPaste = selectPasteRecords(records);
  const omittedRecords = records.length - recordsForPaste.length;
  if (omittedRecords > 0) {
    lines.push(`Records omitted from paste handoff: ${omittedRecords} passing/uninteresting record(s). See summary JSON for the complete sample list.`);
    lines.push("");
  }

  for (const record of recordsForPaste) {
    const rawRecord = rawRecords[records.indexOf(record)] ?? record;
    const failed = firstFailedCommand(record, { includeCleanup: true });
    const rawFailed = firstFailedCommand(rawRecord, { includeCleanup: true });
    lines.push(`Scenario: ${record.scenario}`);
    lines.push(`Result: ${record.status}`);
    lines.push(`Cleanup: ${record.cleanup ?? "not-run"}`);
    if (record.status === "PASS" || record.status === "DRY-RUN") {
      lines.push(`Evidence: ${record.phases?.length ?? 0} phases recorded.`);
      if (record.measurements) {
        pushMeasurementBrief(lines, record.measurements, { compact: true });
      }
    } else if (record.violations?.length > 0) {
      if (record.measurements) {
        pushMeasurementBrief(lines, record.measurements, { compact: true });
        if (record.measurements.mediaUnderstandingEvidence?.available) {
          lines.push(`Media: describe ${record.measurements.mediaDescribeMs ?? "unknown"}ms; timeout ${record.measurements.mediaTimeoutObserved ?? "unknown"}; status ${record.measurements.mediaStatusAfterTimeoutMs ?? "unknown"}ms.`);
        }
        if (record.measurements.networkOfflineEvidence?.available) {
          lines.push(`Network offline: turn ${record.measurements.networkTurnMs ?? "unknown"}ms; failure ${record.measurements.networkFailureObserved ?? "unknown"}; status ${record.measurements.networkStatusAfterFailureMs ?? "unknown"}ms.`);
        }
      }
      lines.push("Violations:");
      for (const violation of record.violations) {
        lines.push(`- ${violation.message}`);
      }
    } else if (failed) {
      lines.push("Failure:");
      lines.push(`- Command: ${failed.command}`);
      lines.push(`- Status: ${failed.status}${failed.timedOut ? " (timeout)" : ""}`);
      lines.push(`- Duration: ${failed.durationMs}ms`);
      const failureDomain = failed.interpretation?.failureDomain ?? null;
      if (failureDomain) {
        lines.push(`- Failure domain: ${failureDomain}`);
      }
      lines.push(`- Likely area: ${failureDomain === "kova-harness" ? "Kova harness" : record.likelyOwner ?? "OpenClaw"}`);
      const stderr = rawFailed?.stderr?.trim();
      const stdout = rawFailed?.stdout?.trim();
      if (stderr) {
        lines.push("- stderr:");
        lines.push(fencedSnippet(stderr));
      } else if (stdout) {
        lines.push("- stdout:");
        lines.push(fencedSnippet(stdout));
      }
    } else {
      lines.push("Failure: scenario did not record a failed command; inspect JSON report.");
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function pushMeasurementBrief(lines, measurements, { compact }) {
  const readiness = measurements.health?.readiness ?? null;
  const totalHealthFailures = measurements.health ? healthTotalFailures(measurements.health) : null;
  const knownHealthFailures = measurements.health ? healthKnownFailures(measurements.health) : null;
  const totalHealthFailuresComplete = measurements.health
    ? healthTotalFailuresComplete(measurements.health)
    : false;
  const readinessReason = readiness?.reason ?? null;
  const readinessNotApplicable = readiness?.classification === "not-applicable";
  const noProcessSamples = !hasValue(measurements.resourceSampleCount);
  lines.push("Measurements:");
  lines.push(`- startup: listening ${valueMs(readiness?.listeningReadyAtMs, readinessNotApplicable ? "n/a" : "unknown")}; health ${valueMs(readiness?.healthReadyAtMs, readinessNotApplicable ? "n/a" : "unknown")}; readiness ${readiness?.classification ?? "unknown"}${readinessReason ? ` (${readinessReason})` : ""}; gateway ${measurements.finalGatewayState ?? "unknown"}; restarts ${measurements.gatewayRestartCount ?? (readinessNotApplicable ? "n/a" : "unknown")}`);
  if (measurements.health) {
    const healthFallback = readinessNotApplicable ? "n/a" : "not-collected";
    const totalFailuresText = totalHealthFailuresComplete
      ? String(totalHealthFailures)
      : `at least ${knownHealthFailures}`;
    lines.push(`- health: startup p95 ${valueMs(measurements.health.startupSamples?.p95Ms, healthFallback)}; post-ready p95 ${valueMs(measurements.health.postReadySamples?.p95Ms, healthFallback)}; failures ${totalFailuresText}; final failures ${measurements.health.final?.failureCount ?? healthFallback}${healthSlowestText(measurements)}`);
  } else {
    lines.push(`- health: n/a${readinessReason ? ` (${readinessReason})` : ""}`);
  }
  if (noProcessSamples && readinessNotApplicable) {
    lines.push(`- resources: scope ${measurements.resourceMeasurementScope ?? "unknown"}; contract ${measurements.resourceHeadlineContract ?? "unknown"}; n/a (${readinessReason ?? "no gateway process expected"})`);
  } else {
    const skippedThresholdCount = Number.isInteger(measurements.performanceThresholdSkippedCount)
      ? ` ${measurements.performanceThresholdSkippedCount}`
      : "";
    const thresholdDisposition = measurements.profilingAffectsPerformanceMeasurements === true
      ? `; performance thresholds skipped${skippedThresholdCount} (instrumented)`
      : "";
    lines.push(`- resources: scope ${measurements.resourceMeasurementScope ?? "unknown"}; contract ${measurements.resourceHeadlineContract ?? "unknown"}; ${resourceHeadlineText(measurements)} ${valueMb(resourceHeadlineValue(measurements))}; tracked total ${valueMb(measurements.resourcePeakTrackedRssMb)}; max CPU ${valuePercent(measurements.cpuPercentMax)}; samples ${measurements.resourceSampleCount ?? "unknown"}; roles ${rolePeakText(measurements)}${thresholdDisposition}`);
  }
  if (measurements.channelWorkflowResources?.available) {
    lines.push(`- channel workflow resources: ${formatChannelWorkflowResourceRows(measurements.channelWorkflowResourceTopByGatewayRss ?? [])}`);
  }
  if (hasAgentSignal(measurements)) {
    lines.push(`- agent: turn ${valueMs(measurements.agentTurnMs, "not-run")}; cold/warm ${valueMs(measurements.coldAgentTurnMs, "n/a")}/${valueMs(measurements.warmAgentTurnMs, "n/a")}; cold-warm delta ${valueMs(measurements.agentColdWarmDeltaMs, "n/a")}; pre-provider ${valueMs(measurements.agentPreProviderMs, "n/a")}; provider ${valueMs(measurements.agentProviderFinalMs, "n/a")}; metadata scans ${measurements.agentMetadataScanCount ?? "n/a"} (${valueMs(measurements.agentMetadataScanTotalMs, "n/a")}); event-loop ${valueMs(measurements.agentEventLoopMaxMs, "n/a")}; polls ${measurements.agentSessionPollCount ?? "n/a"}; cleanup ${valueMs(measurements.agentCleanupMaxMs, "n/a")}; diagnosis ${measurements.agentLatencyDiagnosis?.kind ?? "n/a"}; leaks ${measurements.agentProcessLeakCount ?? "n/a"}`);
  } else {
    lines.push("- agent: not-run");
  }
  if (measurements.agentTurnStats) {
    lines.push(`- Agent turn stats: count ${measurements.agentTurnStats.count ?? measurements.agentTurnCount ?? "unknown"}; p95 ${valueMs(measurements.agentTurnP95Ms, "n/a")}; max ${valueMs(measurements.agentTurnMaxMs, "n/a")}; pre-provider p95 ${valueMs(measurements.agentPreProviderP95Ms, "n/a")}`);
  }
  if (measurements.gatewaySessionPreProviderAttribution?.count > 0) {
    lines.push(`- gateway session attribution: cold known ${valueMs(measurements.coldPreProviderAttributedMs)} / unattributed ${valueMs(measurements.coldPreProviderUnattributedMs)}; warm known ${valueMs(measurements.warmPreProviderAttributedMs)} / unattributed ${valueMs(measurements.warmPreProviderUnattributedMs)}`);
  }
  if (measurements.agentCliPreProviderAttribution?.count > 0) {
    lines.push(`- agent CLI attribution: cold known ${valueMs(measurements.coldPreProviderAttributedMs)} / unattributed ${valueMs(measurements.coldPreProviderUnattributedMs)}; warm known ${valueMs(measurements.warmPreProviderAttributedMs)} / unattributed ${valueMs(measurements.warmPreProviderUnattributedMs)}`);
  }
  lines.push(`- plugins/runtime: missing deps ${measurements.missingDependencyErrors ?? "not-observed"}; plugin failures ${measurements.pluginLoadFailures ?? "not-observed"}; runtime deps ${valueMs(measurements.runtimeDepsStagingMs, "not-observed")}${runtimeDepsPluginText(measurements)}; warm restages ${measurements.warmRuntimeDepsRestageCount ?? "n/a"}; warm reuse ${measurements.runtimeDepsWarmReuseOk ?? "n/a"}`);

  if (!compact || hasDiagnosticSignal(measurements)) {
    lines.push(`- diagnostics: timeline ${measurements.openclawTimelineAvailable ? "available" : "unavailable"}; slowest span ${measurements.openclawSlowestSpanName ?? "none"} ${valueMs(measurements.openclawSlowestSpanMs, "n/a")}; embedded traces ${measurements.embeddedRunTraceCount ?? 0}; liveness warnings ${measurements.openclawLivenessWarningCount ?? 0}; open spans ${measurements.openclawOpenSpanCount ?? 0} (${measurements.openclawOpenRequiredSpanCount ?? 0} required); node CPU/heap/trace ${measurements.nodeCpuProfileCount ?? 0}/${measurements.nodeHeapProfileCount ?? 0}/${measurements.nodeTraceEventCount ?? 0}`);
  }
  if (!compact && hasMcpSignal(measurements)) {
    lines.push(`- mcp: init ${valueMs(measurements.mcpInitializeMs)}; tools/list ${valueMs(measurements.mcpToolsListMs)}; shutdown ${valueMs(measurements.mcpShutdownMs)}; tools ${measurements.mcpToolCount ?? "unknown"}`);
  }
  if (!compact && hasBrowserSignal(measurements)) {
    lines.push(`- browser: start ${valueMs(measurements.browserStartMs)}; open ${valueMs(measurements.browserOpenMs)}; snapshot ${valueMs(measurements.browserSnapshotMs)}; tabs ${measurements.browserTabCount ?? "unknown"}; stopped ${measurements.browserStopped ?? "unknown"}`);
  }
}

function rolePeakText(measurements) {
  const text = compactRolePeaks(measurements).slice(0, 4)
    .map((role) => `${role.role} ${role.peakRssMb ?? "?"}MB/${role.maxCpuPercent ?? "?"}%`)
    .join(", ");
  return text || "none";
}

function runtimeDepsPluginText(measurements) {
  return measurements.runtimeDepsStagingPluginId ? ` (${measurements.runtimeDepsStagingPluginId})` : "";
}

function hasDiagnosticSignal(measurements) {
  return measurements.openclawTimelineAvailable ||
    measurements.openclawSlowestSpanName ||
    measurements.openclawOpenSpanCount !== undefined ||
    measurements.embeddedRunTraceCount > 0 ||
    measurements.openclawLivenessWarningCount > 0 ||
    measurements.nodeCpuProfileCount !== undefined ||
    measurements.nodeHeapProfileCount !== undefined ||
    measurements.nodeTraceEventCount !== undefined;
}

function hasMcpSignal(measurements) {
  return measurements.mcpBridgeEvidence?.available ||
    hasValue(measurements.mcpInitializeMs) ||
    hasValue(measurements.mcpToolsListMs) ||
    hasValue(measurements.mcpShutdownMs);
}

function hasBrowserSignal(measurements) {
  return measurements.browserAutomationEvidence?.available ||
    hasValue(measurements.browserStartMs) ||
    hasValue(measurements.browserOpenMs) ||
    hasValue(measurements.browserSnapshotMs);
}

function hasAgentSignal(measurements) {
  return hasValue(measurements.agentTurnMs) ||
    hasValue(measurements.coldAgentTurnMs) ||
    hasValue(measurements.warmAgentTurnMs) ||
    (measurements.agentTurns?.length ?? 0) > 0 ||
    (measurements.agentTurnStats?.count ?? 0) > 0 ||
    hasValue(measurements.agentPreProviderMs) ||
    hasValue(measurements.agentProviderFinalMs);
}
