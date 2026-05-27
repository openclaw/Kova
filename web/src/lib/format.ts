/**
 * Formatting + delta helpers. Pure functions; safe to call during SSG.
 */

export function fmtVal(v: number | null, unit: string): string {
  if (v == null) return "—";
  if (unit === "ms" || unit === "MB" || v >= 100) return Math.round(v).toLocaleString();
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export type DeltaInfo =
  | { kind: "flat" }
  | { kind: "up" | "down"; pct: number; bad: boolean };

export function deltaFromSpark(values: number[] | null, lowerIsBetter = true): DeltaInfo | null {
  if (!values || values.length < 2) return null;
  const cur = values[values.length - 1]!;
  const prev = values[values.length - 2]!;
  if (prev === 0) return null;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return { kind: "flat" };
  const dir: "up" | "down" = pct > 0 ? "up" : "down";
  const bad = lowerIsBetter ? pct > 0 : pct < 0;
  return { kind: dir, pct, bad };
}

export function deltaText(d: DeltaInfo | null): { text: string; cls: string } {
  if (!d) return { text: "", cls: "delta-flat" };
  if (d.kind === "flat") return { text: "— stable", cls: "delta-flat" };
  const arrow = d.kind === "up" ? "▲" : "▼";
  const sign = d.pct > 0 ? "+" : "";
  return {
    text: `${arrow} ${sign}${d.pct.toFixed(1)}%`,
    cls: d.bad ? "delta-up" : "delta-down",
  };
}
