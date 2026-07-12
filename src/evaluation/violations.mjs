export function checkDuration(violations, results, metric, threshold, predicate) {
  if (!activeFiniteThreshold(violations, metric, threshold)) {
    return;
  }

  for (const result of results) {
    if (!predicate(result.command)) {
      continue;
    }
    if (!finiteNonNegativeMeasurement(violations, metric, result.durationMs, "durationMs")) {
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
  if (!activeFiniteThreshold(violations, metric, threshold)) {
    return;
  }
  if (!finiteNonNegativeMeasurement(violations, metric, actual, "measurement")) {
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
    if (
      activeFiniteThreshold(violations, `resourceByRole.${role}.peakRssMb`, thresholds.peakRssMb) &&
      finiteNonNegativeMeasurement(
        violations,
        `resourceByRole.${role}.peakRssMb`,
        summary.peakRssMb,
        "measurement"
      ) &&
      summary.peakRssMb > thresholds.peakRssMb
    ) {
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
    if (
      activeFiniteThreshold(
        violations,
        `resourceByRole.${role}.peakProcessRssMb`,
        thresholds.peakProcessRssMb
      ) &&
      finiteNonNegativeMeasurement(
        violations,
        `resourceByRole.${role}.peakProcessRssMb`,
        peakProcessRssMb,
        "measurement"
      ) &&
      peakProcessRssMb > thresholds.peakProcessRssMb
    ) {
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
    if (
      activeFiniteThreshold(
        violations,
        `resourceByRole.${role}.maxCpuPercent`,
        thresholds.maxCpuPercent
      ) &&
      finiteNonNegativeMeasurement(
        violations,
        `resourceByRole.${role}.maxCpuPercent`,
        summary.maxCpuPercent,
        "measurement"
      ) &&
      summary.maxCpuPercent > thresholds.maxCpuPercent
    ) {
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

export function checkAggregateThreshold(
  violations,
  actual,
  metric,
  threshold,
  { optionalMeasurement = false } = {}
) {
  if (!activeFiniteThreshold(violations, metric, threshold)) {
    return;
  }
  if (optionalMeasurement && actual === null) {
    return;
  }
  if (!finiteNonNegativeMeasurement(violations, metric, actual, "measurement") || actual <= threshold) {
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
  if (!activeFiniteThreshold(violations, metric, threshold)) {
    return;
  }
  if (typeof actual !== "boolean") {
    malformedEvidence(violations, metric, "boolean measurement", actual);
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

export function checkTurnThreshold(
  violations,
  turn,
  metric,
  threshold,
  message,
  { optionalMeasurement = false } = {}
) {
  if (!turn || !activeFiniteThreshold(violations, metric, threshold)) {
    return;
  }
  if (optionalMeasurement && turn[metric] === null) {
    return;
  }
  if (
    !finiteNonNegativeMeasurement(violations, metric, turn[metric], "turn measurement") ||
    turn[metric] <= threshold
  ) {
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

function activeFiniteThreshold(violations, metric, threshold) {
  if (threshold === undefined) {
    return false;
  }
  if (!Number.isFinite(threshold) || threshold < 0) {
    malformedEvidence(violations, metric, "finite non-negative threshold", threshold);
    return false;
  }
  return true;
}

function finiteNonNegativeMeasurement(violations, metric, actual, label) {
  if (!Number.isFinite(actual) || actual < 0) {
    malformedEvidence(violations, metric, `finite non-negative ${label}`, actual);
    return false;
  }
  return true;
}

function malformedEvidence(violations, metric, expected, actual) {
  violations.push({
    kind: "kova-evidence",
    failureDomain: "kova-harness",
    metric,
    expected,
    actual: describeValue(actual),
    message: `${metric} contained malformed Kova evidence: expected ${expected}, got ${describeValue(actual)}`
  });
}

function describeValue(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
