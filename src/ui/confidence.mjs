// Confidence model for Kova metric aggregation.
//
// Given a set of samples for a metric, we describe how trustworthy the
// central tendency is. The label is bucketed off the coefficient of
// variation (σ / mean) and the sample count, so a single-sample reading
// is always called out as "single-sample" rather than masquerading as
// stable.
//
//   single-sample     n === 1
//   stable (±X%)      cv ≤ 5%
//   moderate (±X%)    cv ≤ 15%
//   noisy (±X%)       cv >  15%
//
// All inputs are plain numbers; renderers handle coloring.

export const CONFIDENCE_BUCKETS = ["single-sample", "stable", "moderate", "noisy"];

// summarizeSamples([n1, n2, ...]) -> { n, mean, median, stdev, p95, min, max, cv }
//   - cv is expressed as a fraction (0.05 = 5%), not a percent string.
//   - p95 is null when n < 2; the renderer should pick the column variant.
export function summarizeSamples(values) {
  const xs = (values ?? [])
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const n = xs.length;
  if (n === 0) {
    return { n: 0, mean: null, median: null, stdev: null, p95: null, min: null, max: null, cv: null };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const median = quantile(sorted, 0.5);
  const p95 = n >= 2 ? quantile(sorted, 0.95) : null;
  const min = sorted[0];
  const max = sorted[n - 1];
  // Sample (n-1) standard deviation. With n === 1 there is no spread.
  let stdev = null;
  if (n >= 2) {
    const variance = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
    stdev = Math.sqrt(variance);
  }
  const cv = stdev != null && mean !== 0 ? Math.abs(stdev / mean) : null;
  return { n, mean, median, stdev, p95, min, max, cv };
}

// classifyConfidence({ n, cv }) -> { label, bucket, percent }
//   - label is human-readable, e.g. "stable (±3%)" or "single-sample"
//   - bucket is one of CONFIDENCE_BUCKETS
//   - percent is the rounded CV percent (null when not applicable)
export function classifyConfidence({ n, cv } = {}) {
  if (!Number.isFinite(n) || n <= 0) return { label: "no samples", bucket: "single-sample", percent: null };
  if (n === 1) return { label: "single-sample", bucket: "single-sample", percent: null };
  if (cv == null || !Number.isFinite(cv)) return { label: "n=" + n, bucket: "single-sample", percent: null };
  const percent = Math.round(cv * 100);
  if (cv <= 0.05) return { label: `stable (±${percent}%)`, bucket: "stable", percent };
  if (cv <= 0.15) return { label: `moderate (±${percent}%)`, bucket: "moderate", percent };
  return { label: `noisy (±${percent}%)`, bucket: "noisy", percent };
}

// headroomPercent({ value, threshold, direction }) -> number | null
//   direction: "lower-better" (default) — threshold is a ceiling
//              "higher-better"          — threshold is a floor
// Returns the percentage of the threshold still unused. Negative when
// the threshold is breached. Null when inputs are missing.
export function headroomPercent({ value, threshold, direction = "lower-better" } = {}) {
  const v = typeof value === "number" ? value : Number.NaN;
  const t = typeof threshold === "number" ? threshold : Number.NaN;
  if (!Number.isFinite(v) || !Number.isFinite(t) || t === 0) return null;
  const raw = direction === "lower-better" ? (t - v) / t : (v - t) / t;
  return raw * 100;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}
