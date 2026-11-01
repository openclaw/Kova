export function collectRecordMetricObjects(record) {
  const metrics = [];
  for (const phase of record.phases ?? []) {
    if (phase.metrics) {
      metrics.push(phase.metrics);
    }
  }
  if (record.finalMetrics) {
    metrics.push(record.finalMetrics);
  }
  return metrics;
}

export function maxObservedCollectorMetric(metricObjects, collector, key) {
  let observed = false;
  let count = 0;
  for (const metrics of metricObjects) {
    if (metrics?.[collector]) {
      observed = true;
    }
    const value = metrics?.[collector]?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return observed ? count : null;
}
