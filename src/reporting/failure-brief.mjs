import { RECORD_STATUS } from "../statuses.mjs";
import { firstFailedCommand, summarizeFailureReason } from "./failures.mjs";
import { resourceHeadlineEvidenceLabel, resourceHeadlineValue } from "./report-values.mjs";

export function selectPasteRecords(records) {
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

export function buildFailureBrief(report) {
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

export function buildRecommendedNextScenario(report) {
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

export function briefEvidence(measurements, violations) {
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

export function compactPerformanceMetrics(metrics = {}) {
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

export function compactRolePeaks(measurements) {
  const byRole = new Map();
  // RSS- and CPU-ranked rows describe independent peaks; never let one list
  // overwrite the other's metric or rank.
  for (const [rank, role] of (measurements?.resourceTopRolesByRss ?? []).entries()) {
    const existing = byRole.get(role.role) ?? { role: role.role };
    existing.peakRssMb = role.peakRssMb ?? existing.peakRssMb ?? null;
    existing.maxCpuPercent ??= role.maxCpuPercent ?? null;
    existing.rssRank = rank;
    byRole.set(role.role, existing);
  }
  for (const [rank, role] of (measurements?.resourceTopRolesByCpu ?? []).entries()) {
    const existing = byRole.get(role.role) ?? { role: role.role };
    existing.peakRssMb ??= role.peakRssMb ?? null;
    existing.maxCpuPercent = role.maxCpuPercent ?? existing.maxCpuPercent ?? null;
    existing.cpuRank = rank;
    byRole.set(role.role, existing);
  }
  if (measurements?.resourceByRole) {
    for (const [role, summary] of Object.entries(measurements.resourceByRole)) {
      const existing = byRole.get(role) ?? { role };
      existing.peakRssMb ??= summary.peakRssMb ?? null;
      existing.maxCpuPercent ??= summary.maxCpuPercent ?? null;
      byRole.set(role, existing);
    }
  }
  return interleaveRankedRoles([...byRole.values()], {
    rssRank: (role) => role.rssRank,
    cpuRank: (role) => role.cpuRank
  });
}

export function interleaveRankedRoles(roles, ranks = {}) {
  const rssRoles = [...roles].toSorted((left, right) =>
    compareRankedRole(left, right, ranks.rssRank, "peakRssMb")
  );
  const cpuRoles = [...roles].toSorted((left, right) =>
    compareRankedRole(left, right, ranks.cpuRank, "maxCpuPercent")
  );
  const ordered = [];
  const seen = new Set();
  for (let rank = 0; rank < roles.length; rank += 1) {
    appendRankedRole(ordered, seen, rssRoles[rank]);
    appendRankedRole(ordered, seen, cpuRoles[rank]);
  }
  return ordered;
}

function compareRankedRole(left, right, explicitRank, metric) {
  if (explicitRank) {
    const leftRank = explicitRank(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = explicitRank(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
  }
  return (right[metric] ?? Number.NEGATIVE_INFINITY) - (left[metric] ?? Number.NEGATIVE_INFINITY) ||
    String(left.role).localeCompare(String(right.role));
}

function appendRankedRole(roles, seen, role) {
  if (!role || seen.has(role.role)) {
    return;
  }
  seen.add(role.role);
  roles.push(role);
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
