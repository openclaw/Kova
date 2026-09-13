import { agentCliPreProviderMarkdownRows } from "../collectors/agent-cli-attribution.mjs";
import { summarizeAgentTurnBreakdownForMarkdown } from "../collectors/agent-turns.mjs";
import { gatewaySessionPreProviderMarkdownRows } from "../collectors/gateway-session-turn-attribution.mjs";
import { compactRolePeaks, interleaveRankedRoles } from "./failure-brief.mjs";
import { firstFailedCommand, summarizeFailureReason } from "./failures.mjs";
import { markdownCodeSpan, markdownInline, markdownSafeValue, markdownTableCodeSpan } from "./markdown.mjs";
import { pushMeasurementBrief } from "./paste-summary.mjs";
import { shortCommand, statusCountsText, valueMb, valueMs, valuePercent } from "./report-values.mjs";
import { buildReportSummary, summarizeUpgradeSource } from "./summary.mjs";

export function renderMarkdownReport(report) {
  // Inline fields render from an escaped clone; code and fenced evidence retain
  // the raw report so their context-specific formatters preserve exact text.
  const rawReport = report;
  const rawSummary = buildReportSummary(report);
  const summary = markdownSafeValue(rawSummary);
  report = markdownSafeValue(rawReport);
  const verdictBand = markdownVerdictBand(summary.decision.verdict);
  const platformLine = `${summary.platform?.os ?? "unknown"} ${summary.platform?.release ?? ""} (${summary.platform?.arch ?? "unknown"}) · ${summary.platform?.node ?? "unknown"}`.trim();
  const authMode = summary.run.auth?.requestedMode ?? summary.run.auth?.live?.method ?? "unknown";
  const authProvider = summary.run.auth?.live?.providerId ?? summary.run.auth?.credentialStore?.defaultProvider ?? null;
  const authLine = `${authMode}${authProvider ? ` (${authProvider})` : ""}`;
  const statusBreakdown = Object.entries(summary.statuses).map(([status, count]) => `${status}:${count}`).join(", ") || "none";
  const lines = [
    "# Kova OpenClaw Runtime Report",
    "",
    `> ${verdictBand} — ${summary.decision.reason}`,
    "",
    "## Verdict",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Verdict | ${tableCell(summary.decision.verdict)} |`,
    `| Reason | ${tableCell(summary.decision.reason)} |`,
    `| Blocking findings | ${summary.decision.blockingFindingCount} |`,
    `| Warnings | ${summary.decision.warningFindingCount} |`,
    `| Records | ${summary.coverage.recordCount} (${tableCell(statusBreakdown)}) |`,
    "",
    ...formatProofCompletenessSection(summary.proof),
    ...formatChannelCapabilityProofSection(summary.channelCapabilities),
    "## Run",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Run ID | ${markdownTableCodeSpan(rawSummary.runId)} |`,
    `| Generated | ${tableCell(summary.generatedAt ?? "unknown")} |`,
    `| Mode | ${tableCell(summary.mode ?? "unknown")} |`,
    `| Target | ${markdownTableCodeSpan(rawSummary.target ?? "unknown")} |`,
    `| Platform | ${tableCell(platformLine)} |`,
    `| Repeat / parallel | ${tableCell(`${summary.run.repeat ?? "unknown"} / ${summary.run.parallel ?? "unknown"}`)} |`,
    `| Auth | ${tableCell(authLine)} |`,
    `| Network frontage | ${tableCell(summary.run.networkFrontage?.mode ?? "port")} |`,
    "",
    "## Coverage",
    "",
    "| Field | Value |",
    "|---|---:|",
    `| Records | ${summary.coverage.recordCount} |`,
    `| Scenarios | ${summary.coverage.scenarioCount} |`,
    `| States | ${summary.coverage.stateCount} |`,
    ...Object.entries(summary.statuses).map(([status, count]) => `| ${tableCell(status)} | ${count} |`),
    ""
  ];

  if (report.gate) {
    lines.push(...formatGateSection(report.gate, rawReport.gate));
  }

  lines.push(...formatFindingsSection(summary.findings));
  lines.push(...formatPerformanceSummaryTable(summary.groups, summary.performance, rawSummary.performance));
  lines.push(...formatSampleSummaryTable(summary.samples));
  lines.push(...formatResourceRoleSection(report.records, rawReport.records));
  lines.push(...formatChannelWorkflowResourceSection(report.records));
  lines.push(...formatSelectedSampleDetails(report.records, rawReport.records));
  lines.push(...formatArtifactSection(summary.artifacts));
  lines.push(...formatTargetCleanupSummary(report.targetCleanup, rawReport.targetCleanup));

  return `${lines.join("\n")}\n`;
}

function markdownVerdictBand(verdict) {
  const map = {
    SHIP: "**✅ [SHIP] PASS**",
    PASS: "**✅ [PASS]**",
    DO_NOT_SHIP: "**❌ [DO-NOT-SHIP] FAIL**",
    FAIL: "**❌ [FAIL]**",
    PARTIAL: "**⚠️ [PARTIAL]**",
    BLOCKED: "**⛔ [BLOCKED]**",
    INCOMPLETE: "**◐ [INCOMPLETE]**",
    DRY_RUN: "**◇ [DRY-RUN] PLANNED**"
  };
  return map[verdict] ?? `**[${verdict ?? "UNKNOWN"}]**`;
}

function formatFindingsSection(findings = []) {
  const lines = ["## Findings", ""];
  if (findings.length === 0) {
    lines.push("- No blocking findings.");
    lines.push("");
    return lines;
  }
  lines.push("| Severity | Area | Scenario | Finding | Evidence |");
  lines.push("|---|---|---|---|---|");
  for (const finding of findings.slice(0, 12)) {
    const scenario = [finding.scenario, finding.state].filter(Boolean).join("/") || "run";
    const evidence = (finding.evidence ?? []).slice(0, 2).join("; ");
    lines.push(`| ${tableCell(finding.severity)} | ${tableCell(finding.ownerArea ?? "OpenClaw")} | ${tableCell(scenario)} | ${tableCell(finding.summary)} | ${tableCell(evidence || "see JSON")} |`);
  }
  if (findings.length > 12) {
    lines.push(`| info | Kova | report | ${findings.length - 12} additional finding(s) omitted from Markdown | see summary JSON |`);
  }
  lines.push("");
  return lines;
}

function formatProofCompletenessSection(proof) {
  const lines = ["## Proof Completeness", ""];
  if (!proof || proof.recordCount === 0) {
    lines.push("- No records.");
    lines.push("");
    return lines;
  }

  const completeness = Object.entries(proof.completeness ?? {})
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ") || "none";
  lines.push(`- Completeness: ${completeness}`);
  lines.push(`- Required obligations: ${proof.requiredTotal} total, ${proof.requiredMissing} missing, ${proof.requiredFailed} failed`);
  if (Object.keys(proof.byCategory ?? {}).length > 0) {
    const categories = Object.entries(proof.byCategory)
      .map(([category, count]) => `${category}: ${count}`)
      .join(", ");
    lines.push(`- Categories: ${categories}`);
  }

  const gaps = [...(proof.missingRequired ?? []), ...(proof.failedRequired ?? [])].slice(0, 8);
  if (gaps.length > 0) {
    lines.push("");
    lines.push("| Scenario | Obligation | Status | Reason |");
    lines.push("|---|---|---|---|");
    for (const gap of gaps) {
      lines.push(`| ${tableCell(gap.scenario)} | ${tableCell(gap.id)} | ${tableCell(gap.status)} | ${tableCell(gap.reason ?? gap.summary ?? "see JSON")} |`);
    }
  }

  lines.push("");
  return lines;
}

function formatChannelCapabilityProofSection(proof) {
  if (!proof || proof.total === 0) {
    return [];
  }

  const lines = [
    "## Channel Capability Proof",
    "",
    `- Capability rows: ${proof.total} total, ${proof.required} required, ${proof.passed} passed, ${proof.failed} failed, ${proof.missing} missing`,
    "",
    "| Channel | Rows | Required | Passed | Failed | Missing |",
    "|---|---:|---:|---:|---:|---:|"
  ];
  for (const channel of proof.byChannel.slice(0, 12)) {
    lines.push(`| ${tableCell(channel.channelId)} | ${channel.total} | ${channel.required} | ${channel.passed} | ${channel.failed} | ${channel.missing} |`);
  }
  const gaps = [...proof.failedRequired, ...proof.missingRequired].slice(0, 8);
  if (gaps.length > 0) {
    if (gaps.some((gap) => gap.proofMode === "preflight")) {
      lines.push("");
      lines.push("- Preflight gaps mean the selected OpenClaw runtime package contract differs from Kova's expected channel capability catalog. Use `kova inventory plan --openclaw-repo <path> --json` to compare the catalog with source.");
    }
    lines.push("");
    lines.push("| Channel | Capability | Proof | Status | Owner | Reason |");
    lines.push("|---|---|---|---|---|---|");
    for (const gap of gaps) {
      const capability = [gap.group, gap.capabilityId].filter(Boolean).join("/") || gap.id;
      const owner = gap.failureOwner
        ? `${gap.failureOwner}${gap.ownerArea ? `: ${gap.ownerArea}` : ""}`
        : (gap.ownerArea ?? "unknown");
      lines.push(`| ${tableCell(gap.channelId)} | ${tableCell(capability)} | ${tableCell(gap.proofMode ?? "unknown")} | ${tableCell(gap.status)} | ${tableCell(owner)} | ${tableCell(gap.reason ?? gap.summary ?? "see JSON")} |`);
    }
  }
  lines.push("");
  return lines;
}

function formatPerformanceSummaryTable(groups = [], performance = null, rawPerformance = null) {
  const lines = ["## Performance Summary", ""];
  lines.push(`- Resource measurement scope: ${performance?.resourceMeasurementScope ?? "unknown"}`);
  lines.push(`- Resource headline contract: ${markdownCodeSpan(rawPerformance?.resourceHeadlineContract ?? "unknown")}`);
  if (groups.length === 0) {
    lines.push("- No aggregate performance groups were recorded.");
    lines.push("");
    return lines;
  }
  if ((performance?.resourceContractMismatchCount ?? 0) > 0) {
    lines.push(`- Resource contract mismatches: ${performance.resourceContractMismatchCount}`);
    for (const mismatch of performance.resourceContractMismatches?.slice(0, 4) ?? []) {
      lines.push(`- Resource baseline skipped: ${mismatch.scenario}/${mismatch.state ?? "none"} ${formatResourceComparison(mismatch.resourceComparison)}`);
    }
  }
  if ((performance?.instrumentedPerformanceGroupCount ?? 0) > 0) {
    lines.push(`- Instrumented baseline groups: ${performance.instrumentedPerformanceGroupCount}`);
    for (const group of performance.instrumentedPerformanceGroups?.slice(0, 4) ?? []) {
      lines.push(`- Instrumented baseline skipped: ${group.scenario}/${group.state ?? "none"} ${(group.skippedMetrics ?? []).join(", ") || "performance metrics"}`);
    }
  }
  if ((performance?.skippedMetricCount ?? 0) > 0) {
    lines.push(`- Skipped baseline metrics: ${performance.skippedMetricCount}`);
  }
  lines.push("");
  lines.push("| Scenario | Samples | Status | Health Ready | Gateway RSS | Tracked RSS | CPU | Cold Turn | Warm Turn | Cold Pre-Provider |");
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const group of groups.slice(0, 12)) {
    lines.push([
      tableCell([group.scenario, group.state].filter(Boolean).join("/") || group.key),
      group.sampleCount ?? "unknown",
      tableCell(statusCountsText(group.statuses)),
      tableCell(metricMedian(group, "readinessHealthReadyMs")),
      tableCell(metricMedian(group, "resourcePeakGatewayRssMb")),
      tableCell(metricMedian(group, "resourcePeakTrackedRssMb")),
      tableCell(metricMedian(group, "cpuPercentMax")),
      tableCell(metricMedian(group, "coldAgentTurnMs")),
      tableCell(metricMedian(group, "warmAgentTurnMs")),
      tableCell(metricMedian(group, "coldPreProviderMs"))
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  if (groups.length > 12) {
    lines.push(`| ${groups.length - 12} additional group(s) omitted |  |  |  |  |  |  |  |  |  |`);
  }
  lines.push("");
  return lines;
}

function formatSampleSummaryTable(samples = []) {
  const lines = ["## Samples", ""];
  if (samples.length === 0) {
    lines.push("- No samples were recorded.");
    lines.push("");
    return lines;
  }
  lines.push("| Sample | Status | Scenario | Upgrade From | Health Ready | Gateway RSS | Tracked RSS | Cold Turn | Warm Turn | Blocker |");
  lines.push("|---:|---|---|---|---:|---:|---:|---:|---:|---|");
  for (const sample of samples.slice(0, 20)) {
    const measurements = sample.measurements ?? {};
    const readinessNotApplicable = measurements.readiness?.classification === "not-applicable";
    const blocker = sample.violations?.[0]?.message ?? sample.failureReason ?? "";
    lines.push([
      sample.sampleIndex,
      tableCell(sample.status),
      tableCell([sample.scenario, sample.state?.id].filter(Boolean).join("/") || "unknown"),
      tableCell(sample.upgrade?.fromVersion ?? sample.upgrade?.fromLabel ?? ""),
      tableCell(valueMs(measurements.readiness?.healthReadyAtMs, readinessNotApplicable ? "n/a" : "unknown")),
      tableCell(valueMb(measurements.resources?.gatewayPeakRssMb)),
      tableCell(valueMb(measurements.resources?.trackedPeakRssMb)),
      tableCell(valueMs(measurements.agent?.coldTurnMs, "n/a")),
      tableCell(valueMs(measurements.agent?.warmTurnMs, "n/a")),
      tableCell(blocker)
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  if (samples.length > 20) {
    lines.push(`|  |  | ${samples.length - 20} additional sample(s) omitted from Markdown |  |  |  |  |  |  | see summary JSON |`);
  }
  lines.push("");
  return lines;
}

function formatSelectedSampleDetails(records = [], rawRecords = []) {
  const selected = records
    .map((record, index) => ({ record, rawRecord: rawRecords[index] ?? record }))
    .filter(({ record }) =>
      record.status !== "PASS" ||
      (record.violations?.length ?? 0) > 0 ||
      (record.measurements?.agentTurns?.length ?? 0) > 0 ||
      record.measurements?.gatewaySessionPreProviderAttribution?.count > 0 ||
      record.measurements?.agentCliPreProviderAttribution?.count > 0 ||
      record.measurements?.officialPluginEvidence?.available === true
    )
    .slice(0, 8);
  if (selected.length === 0) {
    return [];
  }

  const lines = ["## Selected Sample Details", ""];
  for (const { record, rawRecord } of selected) {
    const sample = record.repeat?.index ?? "?";
    lines.push(`### ${record.scenario ?? record.title} sample ${sample}`);
    lines.push("");
    lines.push(`- Status: ${record.status}`);
    lines.push(`- Cleanup: ${record.cleanup ?? "not-run"}`);
    const upgrade = summarizeUpgradeSource(record);
    if (upgrade) {
      lines.push(`- Upgrade from: ${upgrade.fromVersion ?? upgrade.fromLabel ?? "unknown"}${upgrade.age ? ` (${upgrade.age})` : ""}`);
    }
    if (record.collectorArtifactDirs?.root) {
      lines.push(`- Artifact root: ${record.collectorArtifactDirs.root}`);
    }
    if (record.measurements) {
      pushMeasurementBrief(lines, record.measurements, { compact: record.status === "PASS" });
    }
    if (record.violations?.length > 0) {
      lines.push("- Violations:");
      for (const violation of record.violations) {
        lines.push(`  - ${violation.message}`);
      }
    }
    const failed = firstFailedCommand(record, { includeCleanup: true });
    const rawFailed = firstFailedCommand(rawRecord, { includeCleanup: true });
    if (failed) {
      lines.push(`- Failed command: ${markdownCodeSpan(shortCommand(rawFailed?.command ?? failed.command))}`);
      lines.push(`- Failure: ${markdownInline(summarizeFailureReason(rawFailed ?? failed))}`);
    }
    pushAgentTurnDetails(lines, record, rawRecord);
    lines.push(...gatewaySessionPreProviderMarkdownRows(rawRecord.measurements?.agentTurns ?? []));
    lines.push(...agentCliPreProviderMarkdownRows(rawRecord.measurements?.agentTurns ?? []));
    lines.push("");
  }
  return lines;
}

function pushAgentTurnDetails(lines, record, rawRecord) {
  const turns = record.measurements?.agentTurns ?? [];
  const rawTurns = rawRecord.measurements?.agentTurns ?? [];
  if (turns.length === 0) {
    return;
  }
  lines.push("- Agent turns:");
  for (const [index, turn] of turns.slice(0, 4).entries()) {
    const rawTurn = rawTurns[index] ?? turn;
    const providerTiming = turn.providerAfterCommandEnd ? `; provider late ${turn.providerLateByMs} ms` : "";
    lines.push(`  - ${turn.label}: total ${valueMs(turn.totalTurnMs)}; pre-provider ${valueMs(turn.preProviderMs)}; provider ${valueMs(turn.providerFinalMs)}; post-provider ${valueMs(turn.postProviderMs)}; response ${turn.responseOk}${providerTiming}`);
    if (turn.gatewaySession) {
      const transport = turn.gatewaySession.gatewayTransportKind ?? "unknown";
      lines.push(`    - gateway session: transport ${transport}; create ${turn.gatewaySession.createSession}; session create ${valueMs(turn.gatewaySession.sessionCreateDurationMs, "n/a")}; send ${valueMs(turn.gatewaySession.sendDurationMs)}; first assistant ${valueMs(turn.gatewaySession.timeToFirstAssistantMs)}; matched assistant ${valueMs(turn.gatewaySession.timeToMatchedAssistantMs)}; polls ${turn.gatewaySession.historyPollCount ?? "unknown"} (${turn.gatewaySession.historyErrorCount ?? "unknown"} errors)`);
    }
    if (turn.channelModelTurn?.failedModelTurnCases?.length > 0) {
      lines.push("    - channel workflow failures:");
      for (const failedCase of turn.channelModelTurn.failedModelTurnCases.slice(0, 4)) {
        const atomCoverage = (failedCase.capabilities ?? [])
          .map((capability) => [capability.group, capability.id].filter(Boolean).join("/"))
          .filter(Boolean)
          .join(", ") || "unknown";
        const invariantSummary = formatChannelInvariantFailures(failedCase.failedInvariants) ?? "invariant unknown";
        const matrix = formatChannelWorkflowMatrix(failedCase.matrix);
        const workflowLabel = [
          failedCase.workflow,
          failedCase.inventoryWorkflow ? `inventory ${failedCase.inventoryWorkflow}` : null,
          matrix ? `matrix ${matrix}` : null
        ].filter(Boolean).join("; ");
        lines.push(`      - ${failedCase.id ?? "unknown"}${workflowLabel ? ` (${workflowLabel})` : ""}: ${failedCase.reason ?? "failed"}; ${invariantSummary}; atoms ${atomCoverage}`);
        for (const invariant of (failedCase.failedInvariants ?? []).slice(0, 4)) {
          if (!invariant?.id && !invariant?.reason) {
            continue;
          }
          lines.push(`        - ${invariant.id ?? "unknown"}: ${invariant.reason ?? "failed"}`);
        }
        if (failedCase.userAction) {
          lines.push(`        - user action: ${failedCase.userAction}`);
        }
        if (failedCase.ownerArea) {
          lines.push(`        - owner area: ${failedCase.ownerArea}`);
        }
      }
    }
    if (turn.turnDiagnostics) {
      lines.push(`    - active window: metadata scans ${turn.metadataScanCount ?? "unknown"} (${valueMs(turn.metadataScanTotalMs)} total, max ${valueMs(turn.metadataScanMaxMs)}); event-loop samples ${turn.turnDiagnostics.eventLoop?.sampleCount ?? "unknown"} max ${valueMs(turn.eventLoopMaxMs)}`);
    }
    const breakdown = markdownSafeValue(
      summarizeAgentTurnBreakdownForMarkdown(rawTurn.phaseBreakdown)
    );
    if (breakdown) {
      lines.push(`    - breakdown: ${breakdown}`);
    }
  }
}

function formatChannelWorkflowMatrix(matrix) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    return null;
  }
  return [
    matrix.content,
    matrix.route,
    matrix.delivery,
    matrix.lifecycle
  ].filter((item) => typeof item === "string" && item.length > 0).join("/");
}

function formatChannelInvariantFailures(invariants) {
  if (!Array.isArray(invariants) || invariants.length === 0) {
    return null;
  }
  const ids = invariants
    .map((invariant) => invariant?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) {
    return null;
  }
  const shown = ids.slice(0, 4);
  const suffix = ids.length > shown.length ? `, +${ids.length - shown.length} more` : "";
  return `${ids.length === 1 ? "invariant" : "invariants"} ${shown.join(", ")}${suffix}`;
}

function formatArtifactSection(artifacts = []) {
  if (artifacts.length === 0) {
    return [];
  }
  const lines = ["## Artifacts", ""];
  for (const artifact of artifacts.slice(0, 12)) {
    const owner = artifact.scenario ? ` ${artifact.scenario}${artifact.sampleIndex ? `#${artifact.sampleIndex}` : ""}` : "";
    lines.push(`- ${artifact.kind}${owner}: ${artifact.path}`);
  }
  if (artifacts.length > 12) {
    lines.push(`- ${artifacts.length - 12} additional artifact reference(s) omitted from Markdown. See summary JSON.`);
  }
  lines.push("");
  return lines;
}

function formatTargetCleanupSummary(targetCleanup, rawTargetCleanup = targetCleanup) {
  if (!targetCleanup) {
    return [];
  }
  const lines = ["## Target Cleanup", ""];
  lines.push(`- Runtime: ${markdownCodeSpan(rawTargetCleanup?.runtimeName ?? "unknown")}`);
  lines.push(`- Result: ${targetCleanup.status ?? "unknown"}`);
  if (targetCleanup.reason) {
    lines.push(`- Reason: ${targetCleanup.reason}`);
  }
  if (targetCleanup.result) {
    lines.push(`- Duration: ${targetCleanup.result.durationMs ?? "unknown"}ms`);
  }
  lines.push("");
  return lines;
}

function metricMedian(group, metricId) {
  const metric = group.metrics?.[metricId];
  if (!metric) {
    return "n/a";
  }
  const unit = metric.unit ?? "";
  return `${metric.median ?? "?"}${unit}`;
}

function formatResourceComparison(comparison = {}) {
  const baseline = `${comparison.baselineMeasurementScope ?? "unknown-scope"}/${comparison.baselineHeadlineContract ?? "unknown-contract"}`;
  const current = `${comparison.currentMeasurementScope ?? "unknown-scope"}/${comparison.currentHeadlineContract ?? "unknown-contract"}`;
  return `${baseline} -> ${current}`;
}

function tableCell(value) {
  return String(value ?? "unknown").replace(/\s+/g, " ").trim();
}

function formatResourceRoleSection(records = [], rawRecords = records) {
  const roles = summarizeResourceRoles(rawRecords).slice(0, 8);
  if (roles.length === 0) {
    return [];
  }

  const lines = ["## Resource Roles", ""];
  const identity = records.find((record) => record.measurements?.resourceHeadlineContract)?.measurements;
  const rawIdentity = rawRecords.find((record) => record.measurements?.resourceHeadlineContract)?.measurements;
  if (identity) {
    lines.push(`- Measurement scope: ${identity.resourceMeasurementScope ?? "unknown"}`);
    lines.push(`- Headline contract: ${markdownCodeSpan(rawIdentity?.resourceHeadlineContract ?? identity.resourceHeadlineContract)}`);
  }
  for (const role of roles) {
    lines.push(
      `- ${markdownInline(role.role)}: RSS ${role.peakRssMb ?? "unknown"} MB (${formatResourcePeakSource(role.rssSource)}); ` +
      `CPU ${role.maxCpuPercent ?? "unknown"}% (${formatResourcePeakSource(role.cpuSource)})`
    );
  }
  lines.push("");
  return lines;
}

function summarizeResourceRoles(records = []) {
  const byRole = new Map();
  for (const record of records) {
    for (const role of compactRolePeaks(record.measurements)) {
      const existing = byRole.get(role.role) ?? {
        role: role.role,
        peakRssMb: null,
        maxCpuPercent: null,
        rssSource: null,
        cpuSource: null
      };
      const rss = role.peakRssMb ?? null;
      const cpu = role.maxCpuPercent ?? null;
      if (rss !== null && (existing.peakRssMb === null || rss > existing.peakRssMb)) {
        existing.peakRssMb = rss;
        existing.rssSource = resourcePeakSource(record);
      }
      if (cpu !== null && (existing.maxCpuPercent === null || cpu > existing.maxCpuPercent)) {
        existing.maxCpuPercent = cpu;
        existing.cpuSource = resourcePeakSource(record);
      }
      byRole.set(role.role, existing);
    }
  }
  return interleaveRankedRoles([...byRole.values()]);
}

function resourcePeakSource(record) {
  return {
    scenario: record.scenario ?? "unknown",
    state: record.state?.id ?? null
  };
}

function formatResourcePeakSource(source) {
  if (!source) {
    return "source unknown";
  }
  return `scenario ${markdownInline(source.scenario)}${source.state ? `/${markdownInline(source.state)}` : ""}`;
}

function formatChannelWorkflowResourceSection(records = []) {
  const rows = summarizeChannelWorkflowResources(records).slice(0, 8);
  if (rows.length === 0) {
    return [];
  }

  const lines = ["## Channel Workflow Resources", ""];
  lines.push("| Scenario | Channel | Workflow Case | Gateway RSS | Tracked RSS | CPU | User Action |");
  lines.push("|---|---|---|---:|---:|---:|---|");
  for (const row of rows) {
    lines.push([
      tableCell(row.scenario),
      tableCell(row.channelId),
      tableCell(row.caseId),
      tableCell(valueMb(row.peakGatewayRssMb)),
      tableCell(valueMb(row.peakTrackedRssMb)),
      tableCell(valuePercent(row.maxCpuPercent)),
      tableCell(row.userAction)
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  return lines;
}

function summarizeChannelWorkflowResources(records = []) {
  const rows = [];
  for (const [index, record] of records.entries()) {
    const scenario = [record.scenario, record.state?.id].filter(Boolean).join("/") || `sample-${index + 1}`;
    for (const row of record.measurements?.channelWorkflowResourceTopByGatewayRss ?? []) {
      rows.push({
        scenario,
        channelId: row.channelId ?? "unknown",
        caseId: row.caseId ?? row.workflow ?? "unknown",
        userAction: row.userAction ?? "unknown",
        peakGatewayRssMb: row.peakGatewayRssMb ?? null,
        peakTrackedRssMb: row.peakTrackedRssMb ?? null,
        maxCpuPercent: row.maxCpuPercent ?? null
      });
    }
  }
  return rows.toSorted((left, right) => (right.peakGatewayRssMb ?? 0) - (left.peakGatewayRssMb ?? 0));
}

function formatGateSection(gate, rawGate = gate) {
  const lines = [
    "## Release Gate",
    "",
    `- Verdict: ${gate.verdict}`,
    `- Complete: ${gate.complete ? "yes" : "no"}`,
    `- Partial: ${gate.partial ? "yes" : "no"}`,
    `- Missing required coverage/items: ${gate.missingRequiredCount ?? 0}`,
    `- Blocking: ${gate.blockingCount}`,
    `- Warnings: ${gate.warningCount}`,
    `- Info: ${gate.infoCount ?? 0}`,
    ""
  ];
  if (gate.baseline) {
    lines.push("### Historical Baseline");
    lines.push("");
    lines.push(`- Regressions: ${gate.baseline.regressionCount}`);
    lines.push(`- Missing baselines: ${gate.baseline.missingBaselineCount}`);
    lines.push(`- Resource contract mismatches: ${gate.baseline.resourceContractMismatchCount ?? 0}`);
    lines.push(`- Instrumented baseline groups: ${gate.baseline.instrumentedPerformanceGroupCount ?? 0}`);
    lines.push(`- Skipped baseline metrics: ${gate.baseline.skippedMetricCount ?? 0}`);
    for (const group of (gate.baseline.resourceContractMismatches ?? []).slice(0, 4)) {
      lines.push(`- Resource baseline skipped: ${group.scenario}/${group.state ?? "none"} ${formatResourceComparison(group.resourceComparison)}`);
    }
    for (const group of (gate.baseline.instrumentedPerformanceGroups ?? []).slice(0, 4)) {
      lines.push(`- Instrumented baseline skipped: ${group.scenario}/${group.state ?? "none"} ${(group.skippedMetrics ?? []).join(", ") || "performance metrics"}`);
    }
    if (gate.baseline.regressedGroups?.length > 0) {
      for (const group of gate.baseline.regressedGroups.slice(0, 4)) {
        lines.push(`- ${group.scenario}/${group.state ?? "none"}: ${group.regressionCount} regression(s)`);
      }
    }
    lines.push("");
  }
  const visibleCards = (gate.cards ?? []).filter((card) => card.severity !== "info");
  if (gate.subsystems?.length > 0) {
    lines.push("### Subsystems");
    lines.push("");
    for (const subsystem of gate.subsystems.slice(0, 6)) {
      lines.push(`- ${subsystem.owner}: ${subsystem.blockingCount} blocking, ${subsystem.warningCount} warning`);
      if (subsystem.primary?.summary) {
        lines.push(`  - primary: ${subsystem.primary.summary}`);
      }
    }
    lines.push("");
  }
  if (gate.fixerSummaries?.length > 0) {
    lines.push("### Fixer Briefs");
    lines.push("");
    for (const fixer of gate.fixerSummaries.slice(0, 4)) {
      lines.push(`- ${fixer.owner}: ${fixer.summary}`);
    }
    lines.push("");
  }
  if (visibleCards.length > 0) {
    lines.push("### Failure Cards");
    lines.push("");
    for (const [index, card] of visibleCards.entries()) {
      const rawCard = (rawGate.cards ?? []).filter((item) => item.severity !== "info")[index] ?? card;
      lines.push(`- ${card.severity.toUpperCase()} ${card.scenario ?? "gate"}${card.state ? `/${card.state}` : ""}: ${card.summary}`);
      lines.push(`  - expected: ${card.expected}`);
      lines.push(`  - actual: ${card.actual}`);
      lines.push(`  - impact: ${card.impact}`);
      lines.push(`  - likely owner: ${card.likelyOwner}`);
      if (card.failedCommand) {
        lines.push(`  - command: ${markdownCodeSpan(rawCard.failedCommand ?? card.failedCommand)}`);
      }
    }
    lines.push("");
  }
  if ((gate.infoCount ?? 0) > 0) {
    lines.push(`Info cards omitted from Markdown: ${gate.infoCount}. See JSON report for full gate coverage details.`);
    lines.push("");
  }
  return lines;
}
