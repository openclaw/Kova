// Sorted inputs; percentage in the 0–100 range. Callers own rounding.
export function interpolatedPercentile(sortedValues, percentileValue) {
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const position = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

// Sorted inputs; fraction in the 0–1 range.
export function nearestRankPercentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const index = Math.ceil(values.length * percentileValue) - 1;
  return values[Math.min(Math.max(index, 0), values.length - 1)];
}
