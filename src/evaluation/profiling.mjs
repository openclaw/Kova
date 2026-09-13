import { measurementMetricValue } from "../health.mjs";
import {
  INSTRUMENTED_PERFORMANCE_REASON,
  instrumentedPerformanceThresholdAffected,
  isInstrumentedPerformanceMetric,
  measurementMetricForThreshold,
  profilingAffectsPerformance
} from "../performance/instrumentation.mjs";
import { finiteNumberOrNull, thresholdFromExpected } from "./shared.mjs";

export function buildInstrumentedPerformanceAssessment({
  record,
  thresholds,
  roleThresholds,
  violations
}) {
  if (!profilingAffectsPerformance(record.profiling)) {
    return null;
  }

  const skipped = new Map();
  for (const [metric, threshold] of Object.entries(thresholds ?? {})) {
    if (!Number.isFinite(threshold) || !isInstrumentedPerformanceMetric(metric)) {
      continue;
    }
    const measurementMetric = measurementMetricForThreshold(metric);
    const actual = measurementMetricValue(record.measurements ?? {}, measurementMetric);
    addSkippedPerformanceAssessment(skipped, {
      metric,
      measurementMetric,
      threshold,
      actual,
      affected: instrumentedPerformanceThresholdAffected(record, {
        metric,
        actual
      })
    });
  }

  for (const [role, rolePolicy] of Object.entries(roleThresholds ?? {})) {
    const roleMeasurements = record.measurements?.resourceByRole?.[role] ?? {};
    for (const [metric, threshold] of Object.entries(rolePolicy ?? {})) {
      if (!Number.isFinite(threshold) || !isInstrumentedPerformanceMetric(metric)) {
        continue;
      }
      const actual = metric === "peakProcessRssMb"
        ? roleMeasurements.peakRssProcess?.rssMb ?? null
        : roleMeasurements[metric] ?? null;
      addSkippedPerformanceAssessment(skipped, {
        metric: `resourceByRole.${role}.${metric}`,
        measurementMetric: metric,
        role,
        threshold,
        actual,
        affected: instrumentedPerformanceThresholdAffected(record, {
          metric,
          role,
          actual
        })
      });
    }
  }

  for (const violation of violations) {
    if (!isSkippedPerformanceViolation(record, violation)) {
      continue;
    }
    addSkippedPerformanceAssessment(skipped, {
      metric: violation.metric,
      measurementMetric: measurementMetricForThreshold(violation.metric),
      role: violation.role ?? null,
      threshold: thresholdFromExpected(violation.expected),
      actual: violation.actual,
      observedOverThreshold: true,
      originalMessage: violation.message ?? null
    });
  }

  const entries = [...skipped.values()].toSorted((left, right) =>
    Number(right.observedOverThreshold) - Number(left.observedOverThreshold) ||
    left.metric.localeCompare(right.metric)
  );
  const complete = entries.length === 0;
  return {
    schemaVersion: "kova.performanceThresholdAssessment.v1",
    complete,
    skippedCount: entries.length,
    reason: complete ? null : INSTRUMENTED_PERFORMANCE_REASON,
    rerun: complete
      ? null
      : "rerun without profiling for gateable performance evidence",
    skipped: entries
  };
}

function addSkippedPerformanceAssessment(target, assessment) {
  if (assessment.affected === false) {
    return;
  }
  const existing = target.get(assessment.metric);
  const actual = finiteNumberOrNull(assessment.actual);
  const threshold = finiteNumberOrNull(assessment.threshold);
  const observedOverThreshold = assessment.observedOverThreshold === true;
  const next = {
    metric: assessment.metric,
    measurementMetric: assessment.measurementMetric,
    role: assessment.role ?? null,
    status: "SKIPPED",
    reason: INSTRUMENTED_PERFORMANCE_REASON,
    threshold,
    actual,
    observedOverThreshold,
    affectsRecordStatus: false,
    message: assessment.originalMessage
      ? `${assessment.originalMessage}; threshold not adjudicated because the run was instrumented`
      : `${assessment.metric} was not adjudicated because the run was instrumented`
  };
  if (
    !existing ||
    Number(next.observedOverThreshold) > Number(existing.observedOverThreshold) ||
    (
      next.observedOverThreshold === existing.observedOverThreshold &&
      (next.actual ?? Number.NEGATIVE_INFINITY) >
        (existing.actual ?? Number.NEGATIVE_INFINITY)
    )
  ) {
    target.set(assessment.metric, next);
  }
}

export function isSkippedPerformanceViolation(record, violation) {
  return violation?.failureDomain !== "kova-harness" &&
    Number.isFinite(violation?.actual) &&
    isInstrumentedPerformanceMetric(violation?.metric) &&
    instrumentedPerformanceThresholdAffected(record, {
      metric: violation.metric,
      role: violation.role,
      actual: violation.actual,
      command: violation.command
    });
}
