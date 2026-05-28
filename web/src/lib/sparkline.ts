/**
 * Tiny SVG sparkline generator. Returns the SVG markup as a string so it can
 * be rendered inline by Astro (no client JS needed).
 */

interface SparkOpts {
  state?: "pass" | "fail" | "block";
  width?: number;
  height?: number;
}

export function spark(values: number[], opts: SparkOpts = {}): string {
  const { state, width = 100, height = 24 } = opts;
  if (values.length === 0) {
    return `<svg class="spark${state ? ` ${state}` : ""}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  }
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1e-9);
  if (values.length === 1) {
    const y = height / 2;
    const line = `M${pad.toFixed(2)},${y.toFixed(2)} L${(width - pad).toFixed(2)},${y.toFixed(2)}`;
    const area = `${line} L${(width - pad).toFixed(2)},${height - pad} L${pad.toFixed(2)},${height - pad} Z`;
    const cls = state ? ` ${state}` : "";
    return (
      `<svg class="spark${cls}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">` +
      `<path class="area" d="${area}" />` +
      `<path class="line" d="${line}" />` +
      `<circle cx="${(width - pad).toFixed(2)}" cy="${y.toFixed(2)}" r="1.6" />` +
      `</svg>`
    );
  }
  const stepX = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i): [number, number] => [
    pad + i * stepX,
    pad + (1 - (v - min) / range) * (height - pad * 2),
  ]);
  const line = pts
    .map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(2) + "," + p[1].toFixed(2))
    .join(" ");
  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  const area =
    line +
    ` L${last[0].toFixed(2)},${height - pad} L${first[0].toFixed(2)},${height - pad} Z`;
  const cls = state ? ` ${state}` : "";
  return (
    `<svg class="spark${cls}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="area" d="${area}" />` +
    `<path class="line" d="${line}" />` +
    `<circle cx="${last[0].toFixed(2)}" cy="${last[1].toFixed(2)}" r="1.6" />` +
    `</svg>`
  );
}
