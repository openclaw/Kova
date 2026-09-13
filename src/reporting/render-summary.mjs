import { buildReportSummary } from "./summary.mjs";

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
