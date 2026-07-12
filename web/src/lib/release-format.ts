/**
 * Human-readable formatters used across release pages. Pure functions.
 */

export function fmtMs(ms: number): string {
  if (ms >= 60_000) {
    const totalSeconds = Math.round(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function fmtRunStamp(d: Date): string {
  const [m, t] = DATE_TIME.format(d).split(", ");
  return `${m} · ${t} UTC`;
}

/** Format a metric value with its unit. Mirrors lib/format.fmtVal but adds nicer thousands. */
export function fmtMetric(v: number | null, unit: string): string {
  if (v === null) return "—";
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1000) body = v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  else if (abs >= 100) body = v.toFixed(0);
  else if (abs >= 10) body = v.toFixed(1);
  else body = v.toFixed(2);
  return unit ? `${body} ${unit}` : body;
}

/**
 * Decide delta class and arrow based on direction and `lowerIsBetter`.
 * - Returns `delta-flat` for very small deltas so the UI stays calm.
 */
export function deltaClass(
  deltaPct: number,
  lowerIsBetter: boolean = true,
): { cls: "delta-up" | "delta-down" | "delta-flat"; arrow: "▲" | "▼" | "—" } {
  if (Math.abs(deltaPct) < 0.5) return { cls: "delta-flat", arrow: "—" };
  const worse = lowerIsBetter ? deltaPct > 0 : deltaPct < 0;
  return worse
    ? { cls: "delta-up", arrow: "▲" }
    : { cls: "delta-down", arrow: "▼" };
}
