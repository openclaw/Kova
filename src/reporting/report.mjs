import { summarizeAgentTurnBreakdownForMarkdown } from "../collectors/agent-turns.mjs";
import { agentCliPreProviderMarkdownRows } from "../collectors/agent-cli-attribution.mjs";
import { gatewaySessionPreProviderMarkdownRows } from "../collectors/gateway-session-turn-attribution.mjs";
import { healthTotalFailures, measurementMetricValue } from "../health.mjs";
import { RECORD_STATUS, findingSeverityForStatus } from "../statuses.mjs";
import { firstFailedCommand, summarizeFailureReason } from "./failures.mjs";
import { summarizeRecords } from "./records.mjs";

export { summarizeRecords } from "./records.mjs";

const SUMMARY_SCHEMA = "kova.report.summary.v1";

export function renderMarkdownReport(report) {
  const summary = buildReportSummary(report);
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
    `| Run ID | \`${tableCell(summary.runId)}\` |`,
    `| Generated | ${tableCell(summary.generatedAt ?? "unknown")} |`,
    `| Mode | ${tableCell(summary.mode ?? "unknown")} |`,
    `| Target | \`${tableCell(summary.target ?? "unknown")}\` |`,
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
    lines.push(...formatGateSection(report.gate));
  }

  lines.push(...formatFindingsSection(summary.findings));
  lines.push(...formatPerformanceSummaryTable(summary.groups, summary.performance));
  lines.push(...formatSampleSummaryTable(summary.samples));
  lines.push(...formatResourceRoleSection(report.records));
  lines.push(...formatChannelWorkflowResourceSection(report.records));
  lines.push(...formatSelectedSampleDetails(report.records));
  lines.push(...formatArtifactSection(summary.artifacts));
  lines.push(...formatTargetCleanupSummary(report.targetCleanup));

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

function formatPerformanceSummaryTable(groups = [], performance = null) {
  const lines = ["## Performance Summary", ""];
  lines.push(`- Resource measurement scope: ${performance?.resourceMeasurementScope ?? "unknown"}`);
  lines.push(`- Resource headline contract: \`${performance?.resourceHeadlineContract ?? "unknown"}\``);
  if (groups.length === 0) {
    lines.push("- No aggregate performance groups were recorded.");
    lines.push("");
    return lines;
  }
  if ((performance?.resourceContractMismatchCount ?? 0) > 0) {
    lines.push(`- Resource contract mismatches: ${performance.resourceContractMismatchCount}`);
    lines.push(`- Skipped resource metrics: ${performance.skippedMetricCount ?? 0}`);
    for (const mismatch of performance.resourceContractMismatches?.slice(0, 4) ?? []) {
      lines.push(`- Resource baseline skipped: ${mismatch.scenario}/${mismatch.state ?? "none"} ${formatResourceComparison(mismatch.resourceComparison)}`);
    }
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

function formatSelectedSampleDetails(records = []) {
  const selected = records.filter((record) =>
    record.status !== "PASS" ||
    (record.violations?.length ?? 0) > 0 ||
    (record.measurements?.agentTurns?.length ?? 0) > 0 ||
    record.measurements?.gatewaySessionPreProviderAttribution?.count > 0 ||
    record.measurements?.agentCliPreProviderAttribution?.count > 0 ||
    record.measurements?.officialPluginEvidence?.available === true
  ).slice(0, 8);
  if (selected.length === 0) {
    return [];
  }

  const lines = ["## Selected Sample Details", ""];
  for (const record of selected) {
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
    if (failed) {
      lines.push(`- Failed command: \`${shortCommand(failed.command)}\``);
      lines.push(`- Failure: ${summarizeFailureReason(failed)}`);
    }
    pushAgentTurnDetails(lines, record);
    lines.push(...gatewaySessionPreProviderMarkdownRows(record.measurements?.agentTurns ?? []));
    lines.push(...agentCliPreProviderMarkdownRows(record.measurements?.agentTurns ?? []));
    lines.push("");
  }
  return lines;
}

function pushAgentTurnDetails(lines, record) {
  const turns = record.measurements?.agentTurns ?? [];
  if (turns.length === 0) {
    return;
  }
  lines.push("- Agent turns:");
  for (const turn of turns.slice(0, 4)) {
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
    const breakdown = summarizeAgentTurnBreakdownForMarkdown(turn.phaseBreakdown);
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

function formatTargetCleanupSummary(targetCleanup) {
  if (!targetCleanup) {
    return [];
  }
  const lines = ["## Target Cleanup", ""];
  lines.push(`- Runtime: \`${targetCleanup.runtimeName ?? "unknown"}\``);
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

function statusCountsText(statuses = {}) {
  return Object.entries(statuses).map(([status, count]) => `${status}:${count}`).join(", ") || "unknown";
}

function formatResourceComparison(comparison = {}) {
  const baseline = `${comparison.baselineMeasurementScope ?? "unknown-scope"}/${comparison.baselineHeadlineContract ?? "unknown-contract"}`;
  const current = `${comparison.currentMeasurementScope ?? "unknown-scope"}/${comparison.currentHeadlineContract ?? "unknown-contract"}`;
  return `${baseline} -> ${current}`;
}

function tableCell(value) {
  return String(value ?? "unknown").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function formatResourceRoleSection(records = []) {
  const roles = summarizeResourceRoles(records).slice(0, 8);
  if (roles.length === 0) {
    return [];
  }

  const lines = ["## Resource Roles", ""];
  const identity = records.find((record) => record.measurements?.resourceHeadlineContract)?.measurements;
  if (identity) {
    lines.push(`- Measurement scope: ${identity.resourceMeasurementScope ?? "unknown"}`);
    lines.push(`- Headline contract: \`${identity.resourceHeadlineContract}\``);
  }
  for (const role of roles) {
    lines.push(`- ${role.role}: RSS ${role.peakRssMb ?? "unknown"} MB; CPU ${role.maxCpuPercent ?? "unknown"}%; scenario ${role.scenario}${role.state ? `/${role.state}` : ""}`);
  }
  lines.push("");
  return lines;
}

function summarizeResourceRoles(records = []) {
  const byRole = new Map();
  for (const record of records) {
    for (const role of compactRolePeaks(record.measurements).slice(0, 8)) {
      const existing = byRole.get(role.role) ?? {
        role: role.role,
        peakRssMb: null,
        maxCpuPercent: null,
        scenario: record.scenario,
        state: record.state?.id ?? null
      };
      const rss = role.peakRssMb ?? null;
      const cpu = role.maxCpuPercent ?? null;
      if (rss !== null && (existing.peakRssMb === null || rss > existing.peakRssMb)) {
        existing.peakRssMb = rss;
        existing.scenario = record.scenario;
        existing.state = record.state?.id ?? null;
      }
      if (cpu !== null && (existing.maxCpuPercent === null || cpu > existing.maxCpuPercent)) {
        existing.maxCpuPercent = cpu;
      }
      byRole.set(role.role, existing);
    }
  }
  return [...byRole.values()].toSorted((left, right) => {
    const leftScore = Math.max(left.peakRssMb ?? 0, left.maxCpuPercent ?? 0);
    const rightScore = Math.max(right.peakRssMb ?? 0, right.maxCpuPercent ?? 0);
    return rightScore - leftScore;
  });
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

export function buildReportSummary(report) {
  const records = report.records ?? [];
  const statuses = report.summary?.statuses ?? summarizeRecords(records).statuses;
  const findings = buildFindings(report);
  const blockingFindingCount = findings.filter((finding) =>
    finding.severity === "blocking" ||
    finding.severity === "fail" ||
    finding.severity === "incomplete" ||
    finding.severity === "blocked"
  ).length;
  const warningFindingCount = findings.filter((finding) => finding.severity === "warning").length;
  const decision = buildDecision(report, statuses, findings, blockingFindingCount, warningFindingCount);
  const samples = records.map((record, index) => summarizeSample(record, index));
  const groups = summarizeReportGroups(report, samples);
  return {
    schemaVersion: SUMMARY_SCHEMA,
    generatedAt: new Date().toISOString(),
    runId: report.runId,
    reportGeneratedAt: report.generatedAt ?? null,
    mode: report.mode,
    target: report.target,
    from: report.from ?? null,
    platform: report.platform,
    decision,
    run: {
      profile: report.profile ?? null,
      state: report.state ?? null,
      repeat: report.controls?.repeat ?? report.performance?.repeat ?? null,
      parallel: report.controls?.parallel ?? report.performance?.parallel ?? null,
      auth: report.auth ?? null,
      targetCleanup: summarizeTargetCleanup(report.targetCleanup),
      networkFrontage: report.networkFrontage ?? null
    },
    coverage: summarizeCoverage(records),
    proof: summarizeProofCompleteness(records),
    channelCapabilities: summarizeChannelCapabilityProof(records),
    gate: report.gate ?? null,
    performance: summarizePerformance(report.performance, report.baseline),
    failureBrief: buildFailureBrief(report),
    recommendedNextScenario: buildRecommendedNextScenario(report),
    statuses,
    findings,
    groups,
    samples,
    artifacts: summarizeArtifacts(report, records),
    scenarios: samples
  };
}

export function renderReportSummary(report, options = {}) {
  const summary = buildReportSummary(report);

  if (options.structured) {
    return summary;
  }

  const lines = [
    `Run: ${summary.runId}`,
    `Mode: ${summary.mode}`,
    `Target: ${summary.target}`,
    `Platform: ${summary.platform?.os ?? "unknown"} ${summary.platform?.release ?? ""} (${summary.platform?.arch ?? "unknown"})`,
    ...(summary.gate ? [
      `Gate: ${summary.gate.verdict} (${summary.gate.blockingCount} blocking, ${summary.gate.warningCount} warning)`
    ] : []),
    `Proof: ${Object.entries(summary.proof?.completeness ?? {}).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}; required ${summary.proof?.requiredTotal ?? 0}, missing ${summary.proof?.requiredMissing ?? 0}, failed ${summary.proof?.requiredFailed ?? 0}`,
    `Channel capabilities: ${summary.channelCapabilities?.total ?? 0} total, ${summary.channelCapabilities?.failed ?? 0} failed, ${summary.channelCapabilities?.missing ?? 0} missing`,
    "Statuses:",
    ...Object.entries(summary.statuses).map(([status, count]) => `- ${status}: ${count}`),
    "",
    "Scenarios:"
  ];

  for (const scenario of summary.scenarios) {
    lines.push(`- ${scenario.status} ${scenario.scenario} (${scenario.cleanup})`);
    if (scenario.failedCommand) {
      lines.push(`  failed command: ${scenario.failedCommand}`);
    }
    if (scenario.failureReason) {
      lines.push(`  reason: ${scenario.failureReason}`);
    }
    for (const violation of scenario.violations) {
      lines.push(`  violation: ${violation.message}`);
    }
  }
  if (summary.recommendedNextScenario) {
    lines.push("");
    lines.push("Recommended next scenario:");
    lines.push(`- ${summary.recommendedNextScenario.reason}`);
    lines.push(`- ${summary.recommendedNextScenario.command}`);
  }

  return lines.join("\n");
}

function buildDecision(report, statuses, findings, blockingFindingCount, warningFindingCount) {
  if (report.gate) {
    const primary = findings.find((finding) => finding.severity === "blocking") ?? findings[0] ?? null;
    return {
      verdict: report.gate.verdict,
      ok: report.gate.ok === true,
      reason: primary?.summary ?? (report.gate.verdict === "SHIP" ? "release gate accepted" : "release gate did not pass"),
      blockingFindingCount,
      warningFindingCount
    };
  }
  if ((statuses[RECORD_STATUS.BLOCKED] ?? 0) > 0) {
    const primary = findings.find((finding) => finding.severity === "blocked") ?? findings[0] ?? null;
    return {
      verdict: RECORD_STATUS.BLOCKED,
      ok: false,
      reason: primary?.summary ?? "one or more scenarios were blocked",
      blockingFindingCount,
      warningFindingCount
    };
  }
  if ((statuses[RECORD_STATUS.INCOMPLETE] ?? 0) > 0) {
    const primary = findings.find((finding) => finding.severity === "incomplete") ?? findings[0] ?? null;
    return {
      verdict: RECORD_STATUS.INCOMPLETE,
      ok: false,
      reason: primary?.summary ?? "one or more scenarios were missing required proof",
      blockingFindingCount,
      warningFindingCount
    };
  }
  if ((statuses[RECORD_STATUS.FAIL] ?? 0) > 0) {
    const primary = primaryFailFinding(findings) ?? findings[0] ?? null;
    return {
      verdict: RECORD_STATUS.FAIL,
      ok: false,
      reason: primary?.summary ?? "one or more scenarios failed",
      blockingFindingCount,
      warningFindingCount
    };
  }
  if ((statuses[RECORD_STATUS.DRY_RUN] ?? 0) > 0 && Object.keys(statuses).length === 1) {
    return {
      verdict: RECORD_STATUS.DRY_RUN,
      ok: true,
      reason: "dry-run plan rendered without executing OpenClaw",
      blockingFindingCount,
      warningFindingCount
    };
  }
  return {
    verdict: RECORD_STATUS.PASS,
    ok: true,
    reason: "all executed scenarios passed",
    blockingFindingCount,
    warningFindingCount
  };
}

function primaryFailFinding(findings) {
  const failFindings = findings.filter((finding) => finding.severity === "fail");
  return failFindings.find((finding) => finding.metric?.startsWith("channelModelTurn."))
    ?? failFindings.find((finding) => finding.metric?.startsWith("gatewayTransport."))
    ?? failFindings.find((finding) => finding.metric?.startsWith("agentFailureContainment."))
    ?? failFindings.find((finding) => !isResourceFinding(finding))
    ?? failFindings[0]
    ?? null;
}

function isResourceFinding(finding) {
  return typeof finding?.metric === "string" && (
    finding.metric.startsWith("resourceByRole.") ||
    finding.metric === "rssGrowthMb" ||
    finding.metric === "gatewayRssMb"
  );
}

function buildFindings(report) {
  const findings = [];
  for (const card of report.gate?.cards ?? []) {
    if (card.severity === "info") {
      continue;
    }
    findings.push({
      id: card.id ?? `${card.kind ?? "gate"}:${card.scenario ?? "gate"}:${card.state ?? "none"}`,
      severity: card.severity === "blocking" ? "blocking" : card.severity,
      kind: card.kind ?? "gate",
      scenario: card.scenario ?? null,
      state: card.state ?? null,
      ownerArea: card.likelyOwner ?? null,
      metric: card.metric ?? null,
      summary: card.summary ?? card.message ?? "gate finding",
      expected: card.expected ?? null,
      actual: card.actual ?? null,
      evidence: [card.impact, card.failedCommand].filter(Boolean)
    });
  }
  for (const [index, record] of (report.records ?? []).entries()) {
    const state = record.state?.id ?? null;
    for (const violation of record.violations ?? []) {
      findings.push({
        id: violation.id ?? `${record.scenario}:${state ?? "none"}:${violation.metric ?? "violation"}:${index + 1}`,
        severity: findingSeverityForStatus(record.status),
        kind: "violation",
        scenario: record.scenario ?? null,
        state,
        sampleIndex: record.repeat?.index ?? index + 1,
        ownerArea: violation.ownerArea ?? record.likelyOwner ?? null,
        metric: violation.metric ?? null,
        summary: violation.message ?? "scenario violation",
        expected: violation.threshold ?? null,
        actual: violation.actual ?? null,
        evidence: briefEvidence(record.measurements ?? {}, [
          violation.userAction ? `user action: ${violation.userAction}` : null,
          violation.workflow ? `workflow: ${violation.workflow}` : null,
          violation.failedInvariant ? `invariant: ${violation.failedInvariant}` : null,
          violation.atomCoverage ? `atoms: ${violation.atomCoverage}` : null,
          violation.message
        ].filter(Boolean))
      });
    }
    const missingSpanCount = record.measurements?.openclawMissingRequiredSpanCount ?? 0;
    const missingSpanSeverity = record.measurements?.openclawMissingRequiredSpanSeverity ?? null;
    if (missingSpanCount > 0 && ["diagnostic-gap", "warning"].includes(missingSpanSeverity)) {
      const missing = record.measurements?.openclawMissingRequiredSpans ?? [];
      findings.push({
        id: `${record.scenario}:${state ?? "none"}:diagnostic-gap:${index + 1}`,
        severity: missingSpanSeverity,
        kind: "diagnostics",
        scenario: record.scenario ?? null,
        state,
        sampleIndex: record.repeat?.index ?? index + 1,
        ownerArea: record.likelyOwner ?? null,
        metric: "openclawMissingRequiredSpanCount",
        summary: `${missingSpanCount} expected OpenClaw diagnostics span(s) were not observed; user-path verdict is based on functional and performance checks`,
        expected: "diagnostic spans available when emitted by OpenClaw",
        actual: missing.slice(0, 5).join(", "),
        evidence: missing.length > 0 ? [`missing spans: ${missing.slice(0, 5).join(", ")}`] : ["missing expected diagnostic spans"]
      });
    }
    const proofFindings = ledgerFindings(record, index, state);
    findings.push(...proofFindings);
    const failed = firstFailedCommand(record, { includeCleanup: true });
    if (record.status === RECORD_STATUS.INCOMPLETE && (record.violations ?? []).length === 0 && proofFindings.length === 0) {
      findings.push({
        id: `${record.scenario}:${state ?? "none"}:incomplete:${index + 1}`,
        severity: "incomplete",
        kind: "evidence",
        scenario: record.scenario ?? null,
        state,
        sampleIndex: record.repeat?.index ?? index + 1,
        ownerArea: record.likelyOwner ?? null,
        metric: null,
        summary: record.incompleteReason ?? "required evidence was not collected",
        expected: "all required proof obligations collected and evaluated",
        actual: "incomplete proof",
        evidence: (record.incompleteEvidence ?? []).slice(0, 3)
      });
    }
    if ((record.status === RECORD_STATUS.FAIL || record.status === RECORD_STATUS.INCOMPLETE || record.status === RECORD_STATUS.BLOCKED) && failed && (record.violations ?? []).length === 0) {
      findings.push({
        id: `${record.scenario}:${state ?? "none"}:command:${index + 1}`,
        severity: findingSeverityForStatus(record.status),
        kind: "command",
        scenario: record.scenario ?? null,
        state,
        sampleIndex: record.repeat?.index ?? index + 1,
        ownerArea: record.likelyOwner ?? null,
        metric: null,
        summary: summarizeFailureReason(failed) ?? "command failed",
        expected: "command exits successfully",
        actual: failed.timedOut ? "timed out" : `exit ${failed.status}`,
        evidence: [shortCommand(failed.command)]
      });
    }
  }
  return findings;
}

function ledgerFindings(record, index, state) {
  const findings = [];
  for (const entry of record.evidenceLedger?.entries ?? []) {
    if (!entry.required) {
      continue;
    }
    const status = normalizedEvidenceStatus(record, entry);
    if (status === "missing") {
      findings.push(ledgerFinding(record, index, state, entry, {
        severity: "incomplete",
        kind: "evidence",
        actual: "missing proof"
      }));
    } else if (status === "failed" && entry.category === "invariant") {
      findings.push(ledgerFinding(record, index, state, entry, {
        severity: "fail",
        kind: "invariant",
        actual: "invariant failed"
      }));
    } else if (status === "failed" && entry.category === "channel-capability") {
      findings.push(ledgerFinding(record, index, state, entry, {
        severity: "fail",
        kind: "channel-capability",
        actual: "capability behavior failed"
      }));
    } else if (status === "failed" && entry.category !== "command") {
      findings.push(ledgerFinding(record, index, state, entry, {
        severity: "incomplete",
        kind: "evidence",
        actual: "proof collection failed"
      }));
    }
  }
  return findings;
}

function normalizedEvidenceStatus(record, entry) {
  if (
    entry.status === "missing" &&
    record.status === RECORD_STATUS.FAIL &&
    record.surface === "upgrade-existing-user" &&
    entry.category === "invariant"
  ) {
    return "failed";
  }
  return entry.status;
}

function ledgerFinding(record, index, state, entry, { severity, kind, actual }) {
  const status = normalizedEvidenceStatus(record, entry);
  return {
    id: `${record.scenario}:${state ?? "none"}:${entry.id}:${index + 1}`,
    severity,
    kind,
    scenario: record.scenario ?? null,
    state,
    sampleIndex: record.repeat?.index ?? index + 1,
    ownerArea: entry.ownerArea ?? record.likelyOwner ?? null,
    metric: null,
    summary: `${entry.category} proof ${status}: ${entry.summary ?? entry.id}`,
    expected: "required proof obligation passes",
    actual,
    evidence: [entry.reason, entry.artifactPath].filter(Boolean).slice(0, 2)
  };
}

function summarizeCoverage(records) {
  const scenarios = new Set();
  const states = new Set();
  const surfaces = new Set();
  for (const record of records) {
    if (record.scenario) {
      scenarios.add(record.scenario);
    }
    if (record.state?.id) {
      states.add(record.state.id);
    }
    if (record.surface) {
      surfaces.add(record.surface);
    }
  }
  return {
    recordCount: records.length,
    scenarioCount: scenarios.size,
    scenarios: [...scenarios].sort(),
    stateCount: states.size,
    states: [...states].sort(),
    surfaceCount: surfaces.size,
    surfaces: [...surfaces].sort()
  };
}

function summarizeProofCompleteness(records) {
  const proof = {
    recordCount: records.length,
    completeness: {},
    requiredTotal: 0,
    requiredMissing: 0,
    requiredFailed: 0,
    byCategory: {},
    missingRequired: [],
    failedRequired: []
  };

  for (const [index, record] of records.entries()) {
    const ledger = record.evidenceLedger;
    if (!ledger) {
      continue;
    }
    for (const [category, count] of Object.entries(ledger.summary?.byCategory ?? {})) {
      proof.byCategory[category] = (proof.byCategory[category] ?? 0) + count;
    }
    if (record.status === RECORD_STATUS.DRY_RUN || record.status === RECORD_STATUS.SKIPPED) {
      proof.completeness[ledger.completeness ?? "unknown"] = (proof.completeness[ledger.completeness ?? "unknown"] ?? 0) + 1;
      proof.requiredTotal += ledger.summary?.required ?? 0;
      proof.requiredMissing += ledger.summary?.requiredMissing ?? 0;
      proof.requiredFailed += ledger.summary?.requiredFailed ?? 0;
      continue;
    }
    const requiredEntries = (ledger.entries ?? []).filter((entry) => entry.required);
    const normalizedStatuses = requiredEntries.map((entry) => normalizedEvidenceStatus(record, entry));
    const requiredMissing = normalizedStatuses.filter((status) => status === "missing").length;
    const requiredFailed = normalizedStatuses.filter((status) => status === "failed").length;
    proof.completeness[requiredMissing > 0 ? "incomplete" : "complete"] = (proof.completeness[requiredMissing > 0 ? "incomplete" : "complete"] ?? 0) + 1;
    proof.requiredTotal += requiredEntries.length;
    proof.requiredMissing += requiredMissing;
    proof.requiredFailed += requiredFailed;
    for (const entry of ledger.entries ?? []) {
      if (!entry.required) {
        continue;
      }
      const status = normalizedEvidenceStatus(record, entry);
      const item = {
        scenario: record.scenario ?? "unknown",
        state: record.state?.id ?? null,
        sampleIndex: record.repeat?.index ?? index + 1,
        id: entry.id,
        category: entry.category,
        status,
        summary: entry.summary ?? null,
        reason: entry.reason ?? null,
        artifactPath: entry.artifactPath ?? null
      };
      if (status === "missing") {
        proof.missingRequired.push(item);
      } else if (status === "failed") {
        proof.failedRequired.push(item);
      }
    }
  }

  return proof;
}

function summarizeChannelCapabilityProof(records) {
  const summary = {
    total: 0,
    required: 0,
    passed: 0,
    failed: 0,
    missing: 0,
    skipped: 0,
    byStatus: {},
    byChannel: [],
    failedRequired: [],
    missingRequired: []
  };
  const byChannel = new Map();

  for (const [index, record] of records.entries()) {
    for (const entry of record.evidenceLedger?.entries ?? []) {
      if (entry.category !== "channel-capability") {
        continue;
      }
      const channelId = entry.channelId ?? "unknown";
      const channel = byChannel.get(channelId) ?? {
        channelId,
        total: 0,
        required: 0,
        passed: 0,
        failed: 0,
        missing: 0,
        skipped: 0,
        byStatus: {}
      };
      applyChannelCapabilityCounts(summary, entry);
      applyChannelCapabilityCounts(channel, entry);
      byChannel.set(channelId, channel);

      if (entry.required && (entry.status === "failed" || entry.status === "missing")) {
        const item = {
          scenario: record.scenario ?? "unknown",
          state: record.state?.id ?? null,
          sampleIndex: record.repeat?.index ?? index + 1,
          id: entry.id,
          channelId,
          group: entry.group ?? null,
          capabilityId: entry.capabilityId ?? null,
          proofMode: entry.proofMode ?? null,
          status: entry.status,
          summary: entry.summary ?? null,
          reason: entry.reason ?? null,
          artifactPath: entry.artifactPath ?? null,
          failureOwner: entry.failureOwner ?? null,
          ownerArea: entry.ownerArea ?? record.likelyOwner ?? null
        };
        if (entry.status === "failed") {
          summary.failedRequired.push(item);
        } else {
          summary.missingRequired.push(item);
        }
      }
    }
  }

  summary.byChannel = [...byChannel.values()].toSorted((left, right) =>
    right.failed - left.failed ||
    right.missing - left.missing ||
    left.channelId.localeCompare(right.channelId)
  );
  return summary;
}

function applyChannelCapabilityCounts(target, entry) {
  target.total += 1;
  if (entry.required) {
    target.required += 1;
  }
  const status = entry.status ?? "unknown";
  target.byStatus[status] = (target.byStatus[status] ?? 0) + 1;
  if (status === "passed") {
    target.passed += 1;
  } else if (status === "failed") {
    target.failed += 1;
  } else if (status === "missing") {
    target.missing += 1;
  } else if (status === "skipped") {
    target.skipped += 1;
  }
}

function summarizeReportGroups(report, samples) {
  if (report.performance?.groups?.length > 0) {
    return report.performance.groups.map((group) => ({
      key: group.key,
      scenario: group.scenario,
      surface: group.surface ?? null,
      state: group.state ?? null,
      title: group.title ?? null,
      sampleCount: group.sampleCount,
      statuses: group.statuses ?? {},
      resourceInterpretation: group.resourceInterpretation ?? null,
      resourceMeasurementScope: group.resourceMeasurementScope ?? report.performance?.resourceMeasurementScope ?? null,
      resourceHeadlineContract: group.resourceHeadlineContract ?? report.performance?.resourceHeadlineContract ?? null,
      metrics: compactGroupMetrics(group.metrics)
    }));
  }
  const groups = new Map();
  for (const sample of samples) {
    const key = [sample.scenario ?? "unknown", sample.surface ?? "unknown", sample.state?.id ?? "none"].join("|");
    const group = groups.get(key) ?? {
      key,
      scenario: sample.scenario,
      surface: sample.surface,
      state: sample.state?.id ?? null,
      title: sample.title,
      sampleCount: 0,
      statuses: {},
      resourceInterpretation: null,
      resourceMeasurementScope: sample.measurements?.resources?.resourceMeasurementScope ?? null,
      resourceHeadlineContract: sample.measurements?.resources?.resourceHeadlineContract ?? null,
      metrics: {}
    };
    group.sampleCount += 1;
    group.statuses[sample.status] = (group.statuses[sample.status] ?? 0) + 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function compactGroupMetrics(metrics = {}) {
  return Object.fromEntries(compactPerformanceMetrics(metrics).slice(0, 12).map((metric) => [
    metric.id,
    {
      title: metric.title ?? metric.id,
      unit: metric.unit ?? "",
      count: metric.count,
      median: metric.median,
      p95: metric.p95,
      max: metric.max,
      classification: metric.classification
    }
  ]));
}

function summarizeSample(record, index) {
  const failed = firstFailedCommand(record, { includeCleanup: true });
  const sample = {
    sampleIndex: record.repeat?.index ?? index + 1,
    repeatTotal: record.repeat?.total ?? null,
    scenario: record.scenario ?? null,
    surface: record.surface ?? null,
    title: record.title ?? null,
    status: record.status,
    cleanup: record.cleanup ?? "not-run",
    target: record.target ?? null,
    state: record.state ?? null,
    ownerArea: record.likelyOwner ?? null,
    failedCommand: failed?.command ?? null,
    failureDomain: failed?.interpretation?.failureDomain ?? null,
    failureReason: failed ? summarizeFailureReason(failed) : null,
    measurements: summarizeSampleMetrics(record.measurements),
    violations: record.violations ?? [],
    artifactRoot: record.collectorArtifactDirs?.root ?? null
  };
  const upgrade = summarizeUpgradeSource(record);
  if (upgrade) {
    sample.upgrade = upgrade;
  }
  return sample;
}

function summarizeUpgradeSource(record) {
  if (record.surface !== "upgrade-existing-user") {
    return null;
  }
  const sourcePhase = (record.phases ?? []).find((phase) => phase.id === "source-runtime");
  const sourceResults = sourcePhase?.results ?? [];
  for (const result of sourceResults) {
    const parsed = parseFirstJsonObject(result?.stdout);
    if (parsed?.schemaVersion === "kova.openclawReleaseAgeUpgrade.v1") {
      return {
        fromVersion: parsed.version ?? null,
        fromLabel: parsed.age ? `${parsed.age}-ago release` : null,
        age: parsed.age ?? null,
        status: parsed.status ?? result.status ?? null,
        command: parsed.command ?? result.command ?? null
      };
    }
  }
  for (const result of sourceResults) {
    const command = result?.command ?? "";
    const version = command.match(/(?:^|\s)--version\s+'?([0-9][0-9A-Za-z.-]*)'?/)?.[1] ?? null;
    if (version) {
      return {
        fromVersion: version,
        fromLabel: null,
        age: null,
        status: result.status ?? null,
        command
      };
    }
  }
  if (record.from) {
    return {
      fromVersion: null,
      fromLabel: record.from,
      age: null,
      status: null,
      command: null
    };
  }
  return null;
}

function parseFirstJsonObject(value) {
  const text = String(value ?? "");
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function summarizeSampleMetrics(measurements) {
  if (!measurements) {
    return null;
  }
  const readiness = measurements.health?.readiness ?? null;
  return {
    readiness: {
      listeningReadyAtMs: readiness?.listeningReadyAtMs ?? null,
      healthReadyAtMs: readiness?.healthReadyAtMs ?? null,
      classification: readiness?.classification ?? null,
      reason: readiness?.reason ?? null
    },
    health: {
      startupP95Ms: measurements.health?.startupSamples?.p95Ms ?? null,
      postReadyP95Ms: measurements.health?.postReadySamples?.p95Ms ?? null,
      finalFailures: measurements.health?.final?.failureCount ?? null,
      totalFailures: measurements.health ? healthTotalFailures(measurements.health) : null,
      slowestSample: measurements.health?.slowestSample ?? null
    },
    resources: {
      peakRssMb: resourceHeadlineValue(measurements),
      cpuPercentMax: measurements.cpuPercentMax ?? null,
      resourceMeasurementScope: measurements.resourceMeasurementScope ?? null,
      resourceHeadlineContract: measurements.resourceHeadlineContract ?? null,
      measurementScopeSummary: measurements.measurementScopeSummary ?? null,
      primaryRole: measurements.resourcePrimaryRole ?? null,
      gateKind: measurements.resourceGateKind ?? null,
      sampleCount: measurements.resourceSampleCount ?? null,
      commandTreePeakRssMb: measurements.resourcePeakCommandTreeRssMb ?? null,
      gatewayPeakRssMb: measurements.resourcePeakGatewayRssMb ?? null,
      trackedPeakRssMb: measurements.resourcePeakTrackedRssMb ?? null,
      topRolesByRss: measurements.resourceTopRolesByRss?.slice(0, 4) ?? [],
      topRolesByCpu: measurements.resourceTopRolesByCpu?.slice(0, 4) ?? []
    },
    agent: {
      turnMs: measurements.agentTurnMs ?? null,
      coldTurnMs: measurements.coldAgentTurnMs ?? null,
      warmTurnMs: measurements.warmAgentTurnMs ?? null,
      coldWarmDeltaMs: measurements.agentColdWarmDeltaMs ?? null,
      coldPreProviderMs: measurements.coldPreProviderMs ?? null,
      warmPreProviderMs: measurements.warmPreProviderMs ?? null,
      providerFinalMs: measurements.agentProviderFinalMs ?? null,
      coldProviderFinalMs: measurements.coldProviderFinalMs ?? null,
      warmProviderFinalMs: measurements.warmProviderFinalMs ?? null,
      metadataScanCount: measurements.agentMetadataScanCount ?? null,
      metadataScanTotalMs: measurements.agentMetadataScanTotalMs ?? null,
      eventLoopMaxMs: measurements.agentEventLoopMaxMs ?? null,
      sessionPollCount: measurements.agentSessionPollCount ?? null,
      turns: (measurements.agentTurns ?? []).slice(0, 4).map((turn) => ({
        label: turn.label ?? null,
        totalTurnMs: turn.totalTurnMs ?? null,
        preProviderMs: turn.preProviderMs ?? null,
        providerFinalMs: turn.providerFinalMs ?? null,
        postProviderMs: turn.postProviderMs ?? null,
        responseOk: turn.responseOk ?? null,
        metadataScanCount: turn.metadataScanCount ?? null,
        metadataScanTotalMs: turn.metadataScanTotalMs ?? null,
        eventLoopMaxMs: turn.eventLoopMaxMs ?? null,
        gatewayTransportKind: turn.gatewaySession?.gatewayTransportKind ?? null
      }))
    },
    attribution: {
      gatewaySession: measurements.gatewaySessionPreProviderAttribution ? {
        count: measurements.gatewaySessionPreProviderAttribution.count ?? 0,
        coldKnownMs: measurements.coldPreProviderAttributedMs ?? null,
        warmKnownMs: measurements.warmPreProviderAttributedMs ?? null,
        coldUnattributedMs: measurements.coldPreProviderUnattributedMs ?? null,
        warmUnattributedMs: measurements.warmPreProviderUnattributedMs ?? null,
        timelineArtifacts: measurements.gatewaySessionPreProviderAttribution.timelineArtifacts ?? []
      } : null,
      agentCli: measurements.agentCliPreProviderAttribution ? {
        count: measurements.agentCliPreProviderAttribution.count ?? 0,
        coldKnownMs: measurements.coldPreProviderAttributedMs ?? null,
        warmKnownMs: measurements.warmPreProviderAttributedMs ?? null,
        coldUnattributedMs: measurements.coldPreProviderUnattributedMs ?? null,
        warmUnattributedMs: measurements.warmPreProviderUnattributedMs ?? null,
        timelineArtifacts: measurements.agentCliPreProviderAttribution.timelineArtifacts ?? []
      } : null
    },
    plugins: {
      missingDependencyErrors: measurements.missingDependencyErrors ?? null,
      pluginLoadFailures: measurements.pluginLoadFailures ?? null,
      officialPluginInstallOk: measurements.officialPluginInstallOk ?? null,
      officialPluginInstallMs: measurements.officialPluginInstallMs ?? null,
      officialPluginSecurityBlocks: measurements.officialPluginSecurityBlocks ?? null
    },
    diagnostics: {
      timelineAvailable: measurements.openclawTimelineAvailable ?? null,
      timelineEventCount: measurements.openclawTimelineEventCount ?? null,
      timelineParseErrors: measurements.openclawTimelineParseErrors ?? null,
      slowestSpanName: measurements.openclawSlowestSpanName ?? null,
      slowestSpanMs: measurements.openclawSlowestSpanMs ?? null,
      openSpanCount: measurements.openclawOpenSpanCount ?? null,
      openRequiredSpanCount: measurements.openclawOpenRequiredSpanCount ?? null,
      missingRequiredSpanCount: measurements.openclawMissingRequiredSpanCount ?? null,
      openSpans: measurements.openclawOpenSpans?.slice(0, 5) ?? [],
      eventLoopMaxMs: measurements.openclawEventLoopMaxMs ?? null,
      providerRequestMaxMs: measurements.openclawProviderRequestMaxMs ?? null
    }
  };
}

function summarizeArtifacts(report, records) {
  const artifacts = [];
  if (report.outputPaths?.markdown) {
    artifacts.push({ kind: "markdown-report", path: report.outputPaths.markdown });
  }
  if (report.outputPaths?.json) {
    artifacts.push({ kind: "json-report", path: report.outputPaths.json });
  }
  if (report.outputPaths?.summary) {
    artifacts.push({ kind: "summary-json", path: report.outputPaths.summary });
  }
  for (const record of records) {
    const dirs = record.collectorArtifactDirs;
    if (!dirs?.root) {
      continue;
    }
    artifacts.push({
      kind: "collector-root",
      scenario: record.scenario ?? null,
      state: record.state?.id ?? null,
      sampleIndex: record.repeat?.index ?? null,
      path: dirs.root
    });
  }
  return artifacts;
}

function summarizeTargetCleanup(targetCleanup) {
  if (!targetCleanup) {
    return null;
  }
  return {
    runtimeName: targetCleanup.runtimeName ?? null,
    status: targetCleanup.status ?? null,
    reason: targetCleanup.reason ?? null,
    durationMs: targetCleanup.result?.durationMs ?? null
  };
}

function summarizePerformance(performance, baseline) {
  if (!performance) {
    return null;
  }
  return {
    schemaVersion: performance.schemaVersion,
    resourceMeasurementScope: performance.resourceMeasurementScope ?? null,
    resourceHeadlineContract: performance.resourceHeadlineContract ?? null,
    repeat: performance.repeat ?? null,
    groupCount: performance.groupCount ?? 0,
    unstableGroupCount: performance.unstableGroupCount ?? 0,
    profiledRunCount: performance.profiledRunCount ?? 0,
    baselineRegressionCount: baseline?.comparison?.regressionCount ?? null,
    missingBaselineCount: baseline?.comparison?.missingBaselineCount ?? null,
    resourceContractMismatchCount: baseline?.comparison?.resourceContractMismatchCount ?? null,
    skippedMetricCount: baseline?.comparison?.skippedMetricCount ?? null,
    resourceContractMismatches: baseline?.comparison?.resourceContractMismatches?.slice(0, 10) ?? [],
    baselineReviewOk: baseline?.review?.ok ?? null,
    baselineReviewBlockerCount: baseline?.review?.blockerCount ?? null,
    savedBaselinePath: baseline?.saved?.path ?? null,
    regressions: baseline?.comparison?.regressions?.slice(0, 10) ?? []
  };
}

export function renderPasteSummary(report) {
  const records = report.records ?? [];
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

  const brief = buildFailureBrief(report);
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
  const recommended = buildRecommendedNextScenario(report);
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
    const failed = firstFailedCommand(record, { includeCleanup: true });
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
      const stderr = failed.stderr?.trim();
      const stdout = failed.stdout?.trim();
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

function selectPasteRecords(records) {
  const failing = records.filter((record) =>
    record.status !== "PASS" ||
    (record.violations?.length ?? 0) > 0 ||
    record.measurements?.officialPluginEvidence?.ok === false
  );
  if (failing.length > 0) {
    return failing.slice(0, 8);
  }
  const interestingPasses = records.filter((record) =>
    (record.measurements?.agentTurns?.length ?? 0) > 0 ||
    record.measurements?.officialPluginEvidence?.available === true ||
    record.measurements?.gatewaySessionPreProviderAttribution?.count > 0 ||
    record.measurements?.agentCliPreProviderAttribution?.count > 0
  );
  return (interestingPasses.length > 0 ? interestingPasses : records).slice(0, 4);
}

function buildFailureBrief(report) {
  const records = report.records ?? [];
  const blockingCards = (report.gate?.cards ?? []).filter((card) => card.severity === "blocking");
  const primaryCard = blockingCards.find((card) => card.kind === "openclaw-failure") ?? blockingCards[0] ?? null;
  const failedRecord = primaryCard
    ? records.find((record) => record.scenario === primaryCard.scenario && (record.state?.id ?? null) === (primaryCard.state ?? null))
    : records.find((record) =>
      record.status === RECORD_STATUS.FAIL ||
      record.status === RECORD_STATUS.INCOMPLETE ||
      record.status === RECORD_STATUS.BLOCKED
    );

  if (!primaryCard && !failedRecord) {
    return null;
  }

  const measurements = failedRecord?.measurements ?? primaryCard?.measurements ?? {};
  const violations = failedRecord?.violations?.map((violation) => violation.message) ?? primaryCard?.violations ?? [];
  const primaryBlocker = [
    primaryCard?.scenario ?? failedRecord?.scenario ?? "unknown",
    primaryCard?.state ?? failedRecord?.state?.id ?? null
  ].filter(Boolean).join("/");
  const why = primaryCard?.summary ?? violations[0] ?? summarizeFailureReason(firstFailedCommand(failedRecord ?? {}, { includeCleanup: true })) ?? "scenario failed";
  const evidence = briefEvidence(measurements, violations);
  const likelyOwner = primaryCard?.likelyOwner ?? failedRecord?.likelyOwner ?? "OpenClaw";

  return {
    decision: report.gate?.verdict ?? failedRecord?.status ?? "FAIL",
    primaryBlocker,
    why,
    evidence,
    likelyOwner,
    fixerPrompt: buildFixerPrompt({ report, primaryBlocker, why, measurements, evidence, likelyOwner })
  };
}

function buildRecommendedNextScenario(report) {
  const records = report.records ?? [];
  const card = (report.gate?.cards ?? [])
    .find((item) => item.severity === "blocking" && item.scenario) ??
    (report.gate?.cards ?? []).find((item) => item.severity === "warning" && item.scenario) ??
    null;
  const record = card
    ? records.find((item) => item.scenario === card.scenario && (item.state?.id ?? null) === (card.state ?? null))
    : records.find((item) =>
      item.status === RECORD_STATUS.FAIL ||
      item.status === RECORD_STATUS.INCOMPLETE ||
      item.status === RECORD_STATUS.BLOCKED
    );
  const scenario = card?.scenario ?? record?.scenario;
  if (!scenario) {
    return null;
  }
  const state = card?.state ?? record?.state?.id ?? null;
  const target = report.target ?? record?.target;
  const command = [
    "node bin/kova.mjs run",
    target ? `--target ${quoteCliValue(target)}` : "--target <selector>",
    `--scenario ${quoteCliValue(scenario)}`,
    state ? `--state ${quoteCliValue(state)}` : null,
    "--execute",
    "--profile-on-failure",
    "--retain-on-failure",
    "--json"
  ].filter(Boolean).join(" ");
  const reason = card?.summary ??
    record?.violations?.[0]?.message ??
    summarizeFailureReason(firstFailedCommand(record ?? {}, { includeCleanup: true })) ??
    "rerun the primary failing scenario with retained artifacts";
  return {
    scenario,
    state,
    target: target ?? null,
    reason,
    command
  };
}

function quoteCliValue(value) {
  const string = String(value);
  if (/^[A-Za-z0-9._/:=-]+$/.test(string)) {
    return string;
  }
  return `'${string.replaceAll("'", "'\\''")}'`;
}

function briefEvidence(measurements, violations) {
  const items = [];
  if (measurements.resourceMeasurementScope || measurements.resourceHeadlineContract) {
    items.push(`resourceScope: ${measurements.resourceMeasurementScope ?? "unknown"}; resourceContract: ${measurements.resourceHeadlineContract ?? "unknown"}`);
  }
  const readiness = measurements.health?.readiness ?? null;
  if (readiness?.healthReadyAtMs !== null && readiness?.healthReadyAtMs !== undefined) {
    items.push(`readinessHealthReadyMs: ${readiness.healthReadyAtMs}`);
  }
  if (readiness?.listeningReadyAtMs !== null && readiness?.listeningReadyAtMs !== undefined) {
    items.push(`readinessListeningMs: ${readiness.listeningReadyAtMs}`);
  }
  const headlineRss = resourceHeadlineValue(measurements);
  if (headlineRss !== null && headlineRss !== undefined) {
    items.push(`${resourceHeadlineEvidenceLabel(measurements)}: ${headlineRss}`);
  }
  if (measurements.cpuPercentMax !== null && measurements.cpuPercentMax !== undefined) {
    items.push(`cpuPercentMax: ${measurements.cpuPercentMax}`);
  }
  if (measurements.coldAgentTurnMs !== null && measurements.coldAgentTurnMs !== undefined) {
    items.push(`coldAgentTurnMs: ${measurements.coldAgentTurnMs}`);
  }
  if (measurements.warmAgentTurnMs !== null && measurements.warmAgentTurnMs !== undefined) {
    items.push(`warmAgentTurnMs: ${measurements.warmAgentTurnMs}`);
  }
  if (measurements.agentColdWarmDeltaMs !== null && measurements.agentColdWarmDeltaMs !== undefined) {
    items.push(`agentColdWarmDeltaMs: ${measurements.agentColdWarmDeltaMs}`);
  }
  if (measurements.agentLatencyDiagnosis?.summary) {
    items.push(measurements.agentLatencyDiagnosis.summary);
  }
  for (const role of compactRolePeaks(measurements).slice(0, 3)) {
    items.push(`${role.role}: ${role.peakRssMb ?? "unknown"}MB RSS, ${role.maxCpuPercent ?? "unknown"}% CPU`);
  }
  if (measurements.resourcePeakCpuAtMs !== null && measurements.resourcePeakCpuAtMs !== undefined) {
    items.push(`resourcePeakCpuAtMs: ${measurements.resourcePeakCpuAtMs}`);
  }
  if (measurements.nodeProfileTopFunction) {
    items.push(`topCpuFunction: ${measurements.nodeProfileTopFunction} ${measurements.nodeProfileTopFunctionMs ?? "unknown"}ms`);
  }
  if (measurements.nodeHeapTopFunction) {
    items.push(`topHeapFunction: ${measurements.nodeHeapTopFunction} ${measurements.nodeHeapTopFunctionMb ?? "unknown"}MB`);
  }
  if (measurements.missingDependencyErrors !== null && measurements.missingDependencyErrors !== undefined) {
    items.push(`missingDependencyErrors: ${measurements.missingDependencyErrors}`);
  }
  if (measurements.pluginLoadFailures !== null && measurements.pluginLoadFailures !== undefined) {
    items.push(`pluginLoadFailures: ${measurements.pluginLoadFailures}`);
  }
  if (measurements.officialPluginEvidence?.available) {
    const evidence = measurements.officialPluginEvidence;
    items.push(`officialPluginInstall: ${evidence.ok ? "ok" : "failed"}, required failures ${evidence.failedRequiredCount ?? "unknown"}`);
    const failure = evidence.failureEvidence?.[0];
    if (failure?.command) {
      const response = firstNonEmptySnippetLine(failure.command.stderrSnippet, failure.command.stdoutSnippet);
      items.push(`officialPluginFailedCommand: ${failure.command.command ?? failure.command.id}${response ? `; ${response}` : ""}`);
    }
    if (evidence.artifactPath) {
      items.push(`officialPluginArtifact: ${evidence.artifactPath}`);
    }
  }
  if (measurements.warmRuntimeDepsRestageCount !== null && measurements.warmRuntimeDepsRestageCount !== undefined) {
    items.push(`warmRuntimeDepsRestageCount: ${measurements.warmRuntimeDepsRestageCount}`);
  }
  if (measurements.warmRuntimeDepsStagingMs !== null && measurements.warmRuntimeDepsStagingMs !== undefined) {
    items.push(`warmRuntimeDepsStagingMs: ${measurements.warmRuntimeDepsStagingMs}`);
  }
  if (measurements.rssGrowthMb !== null && measurements.rssGrowthMb !== undefined) {
    items.push(`rssGrowthMb: ${measurements.rssGrowthMb}`);
  }
  if (measurements.gatewayRssGrowthMb !== null && measurements.gatewayRssGrowthMb !== undefined) {
    items.push(`gatewayRssGrowthMb: ${measurements.gatewayRssGrowthMb}`);
  }
  if (measurements.soakCommandP95Ms !== null && measurements.soakCommandP95Ms !== undefined) {
    items.push(`soakCommandP95Ms: ${measurements.soakCommandP95Ms}`);
  }
  if (measurements.openclawOpenRequiredSpanCount > 0) {
    const span = measurements.openclawOpenSpans?.[0];
    items.push(`openRequiredSpans: ${measurements.openclawOpenRequiredSpanCount}${span ? `, slowest ${span.name}` : ""}`);
  }
  for (const finding of measurements.diagnosticCorrelation?.findings?.slice(0, 3) ?? []) {
    items.push(finding.summary);
  }
  for (const violation of violations.slice(0, 3)) {
    if (!items.includes(violation)) {
      items.push(violation);
    }
  }
  return items.slice(0, 8);
}

function firstNonEmptySnippetLine(...values) {
  for (const value of values) {
    const line = String(value ?? "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (line) {
      return line;
    }
  }
  return null;
}

function compactPerformanceMetrics(metrics = {}) {
  const preferred = [
    "readinessHealthReadyMs",
    "peakRssMb",
    "cpuPercentMax",
    "openclawEventLoopMaxMs",
    "agentTurnMs",
    "coldAgentTurnMs",
    "warmAgentTurnMs",
    "agentColdWarmDeltaMs",
    "coldPreProviderMs",
    "coldPreProviderAttributedMs",
    "coldPreProviderUnattributedMs",
    "runtimeDepsStagingMs"
  ];
  const byId = new Map(Object.entries(metrics).map(([id, metric]) => [id, { id, ...metric }]));
  return [
    ...preferred.map((id) => byId.get(id)).filter(Boolean),
    ...[...byId.values()].filter((metric) => !preferred.includes(metric.id))
  ];
}

function compactRolePeaks(measurements) {
  const byRole = new Map();
  for (const role of measurements?.resourceTopRolesByRss ?? []) {
    byRole.set(role.role, { ...byRole.get(role.role), ...role });
  }
  for (const role of measurements?.resourceTopRolesByCpu ?? []) {
    byRole.set(role.role, { ...byRole.get(role.role), ...role });
  }
  if (byRole.size === 0 && measurements?.resourceByRole) {
    for (const [role, summary] of Object.entries(measurements.resourceByRole)) {
      byRole.set(role, { role, ...summary });
    }
  }
  return [...byRole.values()].toSorted((left, right) => {
    const leftScore = Math.max(left.peakRssMb ?? 0, left.maxCpuPercent ?? 0);
    const rightScore = Math.max(right.peakRssMb ?? 0, right.maxCpuPercent ?? 0);
    return rightScore - leftScore;
  });
}

function pushMeasurementBrief(lines, measurements, { compact }) {
  const readiness = measurements.health?.readiness ?? null;
  const totalHealthFailures = measurements.health ? healthTotalFailures(measurements.health) : null;
  const readinessReason = readiness?.reason ?? null;
  const readinessNotApplicable = readiness?.classification === "not-applicable";
  const noProcessSamples = !hasValue(measurements.resourceSampleCount);
  lines.push("Measurements:");
  lines.push(`- startup: listening ${valueMs(readiness?.listeningReadyAtMs, readinessNotApplicable ? "n/a" : "unknown")}; health ${valueMs(readiness?.healthReadyAtMs, readinessNotApplicable ? "n/a" : "unknown")}; readiness ${readiness?.classification ?? "unknown"}${readinessReason ? ` (${readinessReason})` : ""}; gateway ${measurements.finalGatewayState ?? "unknown"}; restarts ${measurements.gatewayRestartCount ?? (readinessNotApplicable ? "n/a" : "unknown")}`);
  if (measurements.health) {
    const healthFallback = readinessNotApplicable ? "n/a" : "not-collected";
    lines.push(`- health: startup p95 ${valueMs(measurements.health.startupSamples?.p95Ms, healthFallback)}; post-ready p95 ${valueMs(measurements.health.postReadySamples?.p95Ms, healthFallback)}; failures ${totalHealthFailures ?? healthFallback}; final failures ${measurements.health.final?.failureCount ?? healthFallback}${healthSlowestText(measurements)}`);
  } else {
    lines.push(`- health: n/a${readinessReason ? ` (${readinessReason})` : ""}`);
  }
  if (noProcessSamples && readinessNotApplicable) {
    lines.push(`- resources: scope ${measurements.resourceMeasurementScope ?? "unknown"}; contract ${measurements.resourceHeadlineContract ?? "unknown"}; n/a (${readinessReason ?? "no gateway process expected"})`);
  } else {
    lines.push(`- resources: scope ${measurements.resourceMeasurementScope ?? "unknown"}; contract ${measurements.resourceHeadlineContract ?? "unknown"}; ${resourceHeadlineText(measurements)} ${valueMb(resourceHeadlineValue(measurements))}; tracked total ${valueMb(measurements.resourcePeakTrackedRssMb)}; max CPU ${valuePercent(measurements.cpuPercentMax)}; samples ${measurements.resourceSampleCount ?? "unknown"}; roles ${rolePeakText(measurements)}`);
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

function hasValue(value) {
  return value !== null && value !== undefined;
}

function valueMs(value, defaultValue = "unknown") {
  return value === null || value === undefined ? defaultValue : `${value}ms`;
}

function valueMb(value) {
  return value === null || value === undefined ? "unknown" : `${value} MB`;
}

function valuePercent(value) {
  return value === null || value === undefined ? "unknown" : `${value}%`;
}

function formatChannelWorkflowResourceRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "no attributed workflow samples";
  }
  return rows.slice(0, 3).map((row) => {
    const label = row.caseId ?? row.workflow ?? "unknown";
    return `${label} gateway ${valueMb(row.peakGatewayRssMb)} tracked ${valueMb(row.peakTrackedRssMb)}`;
  }).join("; ");
}

function resourceHeadlineValue(measurements) {
  return measurementMetricValue(measurements, "peakRssMb");
}

function resourceHeadlineEvidenceLabel(measurements) {
  const role = measurements.resourcePrimaryRole ?? null;
  if (measurements.resourceGateKind === "role-missing") {
    return role ? `${role}RssMbNotObserved` : "resourceRoleNotObserved";
  }
  if (measurements.resourceGateKind === "tracked-total") {
    return "trackedTotalRssMb";
  }
  if (role === "gateway" || !role) {
    return "gatewayRssMb";
  }
  return `${role}RssMb`;
}

function resourceHeadlineText(measurements) {
  const role = measurements.resourcePrimaryRole ?? null;
  if (measurements.resourceGateKind === "role-missing") {
    return role ? `${role} RSS not observed` : "primary RSS not observed";
  }
  if (measurements.resourceGateKind === "tracked-total") {
    return "tracked total RSS";
  }
  if (role === "gateway" || !role) {
    return "gateway RSS";
  }
  return `${role} RSS`;
}

function healthSlowestText(measurements) {
  const slowest = measurements.health?.slowestSample;
  if (!slowest) {
    return "";
  }
  return `; slowest ${slowest.scope}/${slowest.phaseId ?? "unknown"} ${valueMs(slowest.durationMs)}`;
}

function buildFixerPrompt({ report, primaryBlocker, why, measurements, evidence, likelyOwner }) {
  const parts = [
    `Investigate OpenClaw release gate failure ${primaryBlocker}.`,
    `Kova decision was ${report.gate?.verdict ?? RECORD_STATUS.FAIL} on ${report.platform?.os ?? "unknown"}-${report.platform?.arch ?? "unknown"}.`,
    `Primary evidence: ${why}.`
  ];
  if (evidence.length > 0) {
    parts.push(`Measurements: ${evidence.join("; ")}.`);
  }
  if (measurements.missingDependencyErrors === 0 && measurements.pluginLoadFailures === 0) {
    parts.push("Dependency/plugin load errors were zero, so focus on startup, memory, CPU, gateway readiness, runtime deps staging, provider/model load, and UI asset initialization.");
  }
  parts.push(`Likely owner area: ${likelyOwner}.`);
  return parts.join(" ");
}

function formatGateSection(gate) {
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
    lines.push(`- Skipped resource metrics: ${gate.baseline.skippedMetricCount ?? 0}`);
    for (const group of (gate.baseline.resourceContractMismatches ?? []).slice(0, 4)) {
      lines.push(`- Resource baseline skipped: ${group.scenario}/${group.state ?? "none"} ${formatResourceComparison(group.resourceComparison)}`);
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
    for (const card of visibleCards) {
      lines.push(`- ${card.severity.toUpperCase()} ${card.scenario ?? "gate"}${card.state ? `/${card.state}` : ""}: ${card.summary}`);
      lines.push(`  - expected: ${card.expected}`);
      lines.push(`  - actual: ${card.actual}`);
      lines.push(`  - impact: ${card.impact}`);
      lines.push(`  - likely owner: ${card.likelyOwner}`);
      if (card.failedCommand) {
        lines.push(`  - command: \`${card.failedCommand}\``);
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

function fencedSnippet(value) {
  return ["```text", ...value.split("\n").slice(0, 30), "```"].join("\n");
}

function shortCommand(command) {
  const value = String(command ?? "").replace(/\s+/g, " ").trim();
  return value.length <= 90 ? value : `${value.slice(0, 87)}...`;
}
