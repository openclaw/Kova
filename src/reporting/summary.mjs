import { healthTotalFailures } from "../health.mjs";
import { RECORD_STATUS, findingSeverityForStatus } from "../statuses.mjs";
import {
  briefEvidence,
  buildFailureBrief,
  buildRecommendedNextScenario,
  compactPerformanceMetrics
} from "./failure-brief.mjs";
import { firstFailedCommand, summarizeFailureReason } from "./failures.mjs";
import { summarizeRecords } from "./records.mjs";
import { resourceHeadlineValue, shortCommand } from "./report-values.mjs";

const SUMMARY_SCHEMA = "kova.report.summary.v1";

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
    const interruptedRestartSpanCount = record.measurements?.openclawInterruptedRestartSpanCount ?? 0;
    if (interruptedRestartSpanCount > 0) {
      const interrupted = record.measurements?.openclawInterruptedRestartSpans ?? [];
      const first = interrupted[0];
      findings.push({
        id: `${record.scenario}:${state ?? "none"}:restart-interrupted-spans:${index + 1}`,
        severity: "warning",
        kind: "diagnostics",
        scenario: record.scenario ?? null,
        state,
        sampleIndex: record.repeat?.index ?? index + 1,
        ownerArea: record.likelyOwner ?? null,
        metric: "openclawInterruptedRestartSpanCount",
        summary: `${interruptedRestartSpanCount} OpenClaw diagnostics span(s) from a prior gateway PID were interrupted by an intentional restart`,
        expected: "terminal gateway PID spans close normally",
        actual: first ? `${first.name} pid ${first.pid}` : "prior gateway PID span",
        evidence: interrupted.slice(0, 5).map((span) => `${span.name} pid ${span.pid}`)
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

export function summarizeUpgradeSource(record) {
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
      interruptedRestartSpanCount: measurements.openclawInterruptedRestartSpanCount ?? null,
      interruptedRestartSpans: measurements.openclawInterruptedRestartSpans?.slice(0, 5) ?? [],
      terminalGatewayPid: measurements.openclawTerminalGatewayPid ?? null,
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
    instrumentedPerformanceGroupCount:
      baseline?.comparison?.instrumentedPerformanceGroupCount ?? null,
    skippedMetricCount: baseline?.comparison?.skippedMetricCount ?? null,
    resourceContractMismatches: baseline?.comparison?.resourceContractMismatches?.slice(0, 10) ?? [],
    instrumentedPerformanceGroups:
      baseline?.comparison?.instrumentedPerformanceGroups?.slice(0, 10) ?? [],
    baselineReviewOk: baseline?.review?.ok ?? null,
    baselineReviewBlockerCount: baseline?.review?.blockerCount ?? null,
    savedBaselinePath: baseline?.saved?.path ?? null,
    regressions: baseline?.comparison?.regressions?.slice(0, 10) ?? []
  };
}
