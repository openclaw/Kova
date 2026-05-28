export function checkDuration(violations, results, metric, threshold, predicate) {
  if (typeof threshold !== "number") {
    return;
  }

  for (const result of results) {
    if (!predicate(result.command)) {
      continue;
    }
    if (result.durationMs > threshold) {
      violations.push({
        kind: "threshold",
        metric,
        command: result.command,
        expected: `<= ${threshold}`,
        actual: result.durationMs,
        message: `${result.command} took ${result.durationMs}ms, over threshold ${threshold}ms`
      });
    }
  }
}

export function checkEvidenceThreshold(violations, kind, metric, actual, threshold, label) {
  if (typeof threshold !== "number" || actual === null) {
    return;
  }
  if (actual > threshold) {
    violations.push({
      kind,
      metric,
      expected: `<= ${threshold}`,
      actual,
      message: `${label} took ${actual}ms, over threshold ${threshold}ms`
    });
  }
}

export function checkRoleThresholds(violations, byRole, roleThresholds) {
  for (const [role, thresholds] of Object.entries(roleThresholds)) {
    const summary = byRole?.[role];
    if (!summary) {
      continue;
    }
    if (typeof thresholds.peakRssMb === "number" && typeof summary.peakRssMb === "number" &&
      summary.peakRssMb > thresholds.peakRssMb) {
      violations.push({
        kind: "resource",
        metric: `resourceByRole.${role}.peakRssMb`,
        role,
        expected: `<= ${thresholds.peakRssMb}`,
        actual: summary.peakRssMb,
        attribution: resourceAttribution(role, summary),
        message: `${role} peak RSS ${summary.peakRssMb} MB exceeded threshold ${thresholds.peakRssMb} MB`
      });
    }
    const peakProcessRssMb = summary.peakRssProcess?.rssMb;
    if (typeof thresholds.peakProcessRssMb === "number" && typeof peakProcessRssMb === "number" &&
      peakProcessRssMb > thresholds.peakProcessRssMb) {
      violations.push({
        kind: "resource",
        metric: `resourceByRole.${role}.peakProcessRssMb`,
        role,
        expected: `<= ${thresholds.peakProcessRssMb}`,
        actual: peakProcessRssMb,
        attribution: resourceAttribution(role, summary),
        message: `${role} peak process RSS ${peakProcessRssMb} MB exceeded threshold ${thresholds.peakProcessRssMb} MB`
      });
    }
    if (typeof thresholds.maxCpuPercent === "number" && typeof summary.maxCpuPercent === "number" &&
      summary.maxCpuPercent > thresholds.maxCpuPercent) {
      violations.push({
        kind: "resource",
        metric: `resourceByRole.${role}.maxCpuPercent`,
        role,
        expected: `<= ${thresholds.maxCpuPercent}`,
        actual: summary.maxCpuPercent,
        message: `${role} max CPU ${summary.maxCpuPercent}% exceeded threshold ${thresholds.maxCpuPercent}%`
      });
    }
  }
}

function resourceAttribution(role, summary) {
  return {
    role,
    peakRssMb: summary?.peakRssMb ?? null,
    maxCpuPercent: summary?.maxCpuPercent ?? null,
    peakProcessCount: summary?.peakProcessCount ?? null,
    peakRssProcess: summary?.peakRssProcess ?? null,
    peakCpuProcess: summary?.peakCpuProcess ?? null
  };
}

export function checkAggregateThreshold(violations, actual, metric, threshold) {
  if (typeof threshold !== "number" || typeof actual !== "number" || actual <= threshold) {
    return;
  }
  violations.push({
    kind: "agent-latency",
    metric,
    expected: `<= ${threshold}`,
    actual,
    message: `${metric} ${actual}ms exceeded threshold ${threshold}ms`
  });
}

export function checkBooleanThreshold(violations, kind, metric, actual, threshold, message) {
  if (typeof threshold !== "number" || actual === null || actual === undefined) {
    return;
  }
  const expected = threshold >= 1;
  if (actual !== expected) {
    violations.push({
      kind,
      metric,
      expected,
      actual,
      message
    });
  }
}

export function checkTurnThreshold(violations, turn, metric, threshold, message) {
  if (!turn || typeof threshold !== "number" || typeof turn[metric] !== "number" || turn[metric] <= threshold) {
    return;
  }
  violations.push({
    kind: "agent-latency",
    metric,
    phaseId: turn.phaseId,
    expected: `<= ${threshold}`,
    actual: turn[metric],
    message: `${message}, over threshold ${threshold}ms`
  });
}
