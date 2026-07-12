// Pure formatters for numbers, durations, deltas, percents.
// No color, no glyphs - colorization happens at the renderer layer.

export function formatNumber(value, { fractionDigits } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n) && fractionDigits == null) {
    return n.toLocaleString("en-US");
  }
  const fd = fractionDigits ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return n.toLocaleString("en-US", { minimumFractionDigits: fd, maximumFractionDigits: fd });
}

export function formatPercent(value, { fractionDigits = 1, withSign = false } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = withSign && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(fractionDigits)}%`;
}

// Format milliseconds into the most readable unit.
export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  if (n < 1) return `${n.toFixed(2)} ms`;
  if (n < 1000) return `${Math.round(n)} ms`;
  const s = n / 1000;
  if (s < 59.95) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const roundedSeconds = Math.round(s);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${String(rem).padStart(2, "0")}m`;
}

// Format bytes into human-readable units.
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 1024) return `${Math.round(n)} B`;
  if (abs < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (abs < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Compute the percent delta from a baseline value. Returns null when the
// baseline is missing or zero. The "direction" hint tells callers whether
// higher is better ("lower-better" for latency, "higher-better" for throughput).
export function computeDelta(baseline, current) {
  if (baseline == null || current == null) return null;
  const b = Number(baseline);
  const c = Number(current);
  if (!Number.isFinite(b) || !Number.isFinite(c) || b === 0) return null;
  return ((c - b) / b) * 100;
}

// Verdict for a delta given a direction. "lower-better" means a negative
// delta is "better"; "higher-better" inverts. Threshold defaults to 5%.
export function classifyDelta(deltaPercent, { direction = "lower-better", threshold = 5 } = {}) {
  if (deltaPercent == null) return "unknown";
  const within = Math.abs(deltaPercent) <= threshold;
  if (within) return "stable";
  if (direction === "lower-better") return deltaPercent < 0 ? "better" : "worse";
  return deltaPercent > 0 ? "better" : "worse";
}
