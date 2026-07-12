/**
 * OG card SVG renderer + PNG transcoder.
 *
 * Hand-written SVG → PNG via @resvg/resvg-js. Deliberately not using
 * satori — the card is dense, factual, monospace, and we don't want a
 * React-JSX dependency to render four <text> rows.
 *
 * Dimensions: 1200×630 (standard og:image).
 *
 * Per-release cards surface: version, pass/fail/blocked counts, and the
 * primary startup/agent-turn metric (or just the verdict if no detail exists).
 * Default card is brand + tagline only.
 */

import { Resvg } from "@resvg/resvg-js";
import type { Release, Scenario } from "../content.config";

const W = 1200;
const H = 630;

// Mirror globals.css dark-theme tokens so OG matches the site.
const TOKENS = {
  bg: "#0a0a0b",
  surface: "#111114",
  border: "#27272a",
  text1: "#fafafa",
  text2: "#a1a1aa",
  text3: "#71717a",
  pass: "#22c55e",
  fail: "#ef4444",
  warn: "#f59e0b",
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface CardData {
  /** Top-left eyebrow, e.g. "kova · OpenClaw performance". */
  eyebrow: string;
  /** Big headline, e.g. "OpenClaw 2026.5.16-beta.7". */
  headline: string;
  /** Sub-headline, e.g. release date. */
  subhead?: string;
  /** Counts strip (pass / fail / blocked). null = hide. */
  counts?: { pass: number; fail: number; block: number } | null;
  /** Short fact line at the bottom-left. */
  fact?: string;
  /** Right-side hero fact, e.g. worst metric. null = hide. */
  hero?: { label: string; value: string; tone: "pass" | "fail" | "warn" } | null;
}

/** Build a 1200×630 OG card SVG from card data. Pure function. */
export function cardSvg(d: CardData): string {
  const eyebrow = escapeXml(d.eyebrow.toUpperCase());
  const headline = escapeXml(d.headline);
  const subhead = d.subhead ? escapeXml(d.subhead) : "";
  const fact = d.fact ? escapeXml(d.fact.toUpperCase()) : "";

  // Counts strip
  let countsBlock = "";
  if (d.counts) {
    const { pass, fail, block } = d.counts;
    countsBlock = `
      <g transform="translate(80, 410)" font-family="ui-monospace, monospace">
        <text x="0" y="0" font-size="22" fill="${TOKENS.text3}" letter-spacing="2">SCENARIOS</text>
        <g transform="translate(0, 50)">
          <text x="0"   y="0" font-size="68" fill="${TOKENS.pass}" font-weight="600">${pass}</text>
          <text x="0"   y="32" font-size="18" fill="${TOKENS.text3}" letter-spacing="2">PASS</text>
          <text x="180" y="0" font-size="68" fill="${TOKENS.fail}" font-weight="600">${fail}</text>
          <text x="180" y="32" font-size="18" fill="${TOKENS.text3}" letter-spacing="2">FAIL</text>
          <text x="360" y="0" font-size="68" fill="${TOKENS.warn}" font-weight="600">${block}</text>
          <text x="360" y="32" font-size="18" fill="${TOKENS.text3}" letter-spacing="2">BLOCKED</text>
        </g>
      </g>`;
  }

  // Hero (right-side)
  let heroBlock = "";
  if (d.hero) {
    const heroColor = TOKENS[d.hero.tone];
    heroBlock = `
      <g transform="translate(1120, 280)" text-anchor="end" font-family="ui-monospace, monospace">
        <text x="0" y="0" font-size="22" fill="${TOKENS.text3}" letter-spacing="2">${escapeXml(d.hero.label.toUpperCase())}</text>
        <text x="0" y="100" font-size="108" fill="${heroColor}" font-weight="600">${escapeXml(d.hero.value)}</text>
      </g>`;
  }

  // Brand mark (top-left, matches Base.astro)
  const brand = `
    <g transform="translate(80, 90)">
      <path d="M0 18 L20 18 L35 0 L55 60 L70 18 L100 18"
            stroke="${TOKENS.text1}" stroke-width="3" fill="none"
            stroke-linecap="round" stroke-linejoin="round" />
      <text x="125" y="32" font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="36" font-weight="600" fill="${TOKENS.text1}">Kova</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${TOKENS.bg}" />
  <rect x="0" y="0" width="${W}" height="2" fill="${TOKENS.text1}" opacity="0.08" />
  ${brand}
  <text x="80" y="180" font-family="ui-monospace, monospace" font-size="22"
        fill="${TOKENS.text3}" letter-spacing="3">${eyebrow}</text>
  <text x="80" y="280" font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="80" font-weight="700" fill="${TOKENS.text1}">${headline}</text>
  ${subhead ? `<text x="80" y="335" font-family="ui-monospace, monospace" font-size="26" fill="${TOKENS.text2}">${subhead}</text>` : ""}
  ${countsBlock}
  ${heroBlock}
  ${fact ? `<text x="80" y="580" font-family="ui-monospace, monospace" font-size="22" fill="${TOKENS.text3}" letter-spacing="2">${fact}</text>` : ""}
  <text x="${W - 80}" y="580" text-anchor="end" font-family="ui-monospace, monospace"
        font-size="22" fill="${TOKENS.text3}" letter-spacing="2">KOVA.OPENCLAW.DEV</text>
</svg>`;
}

/** Render an SVG string to a PNG byte array at 1200×630 device resolution. */
export function svgToPng(svg: string): Uint8Array {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    background: TOKENS.bg,
    font: {
      // Resvg can't load Geist without bundling fonts, so let it fall
      // back to the platform's monospace/sans. The card is text-heavy
      // but the fallback is acceptable for OG previews.
      loadSystemFonts: true,
    },
  });
  return resvg.render().asPng();
}

/* ─── Card builders for known page types ─────────────────────────── */

function fmtMetricShort(v: number, unit: string): string {
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1000) body = v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  else if (abs >= 100) body = v.toFixed(0);
  else if (abs >= 10) body = v.toFixed(1);
  else body = v.toFixed(2);
  return unit ? `${body} ${unit}` : body;
}

export function releaseCard(release: Release): CardData {
  const scenarios = release.scenarios ?? [];
  let counts: CardData["counts"] = null;
  if (scenarios.length > 0) {
    let pass = 0, fail = 0, block = 0;
    for (const s of scenarios) {
      if (s.state === "pass") pass++;
      else if (s.state === "fail") fail++;
      else block++;
    }
    counts = { pass, fail, block };
  }

  let hero: CardData["hero"] = null;
  const primary = primaryReleaseScenario(scenarios);
  if (primary && primary.value != null) {
    hero = {
      label: primary.metric ?? primary.id,
      value: fmtMetricShort(primary.value, primary.unit),
      tone: primary.state === "fail" ? "fail" : primary.state === "block" ? "warn" : "pass",
    };
  } else if (scenarios.length > 0 && counts) {
    hero = counts.fail > 0
      ? { label: "verdict", value: "regressions", tone: "fail" }
      : counts.block > 0
        ? { label: "verdict", value: "blocked", tone: "warn" }
        : { label: "verdict", value: "clean", tone: "pass" };
  }

  return {
    eyebrow: "OpenClaw release · measured by Kova",
    headline: `OpenClaw ${release.ver}`,
    subhead: release.date,
    counts,
    hero,
    fact: release.host
      ? `${release.runCount ?? scenarios.length} runs · ${release.host}`
      : `${release.runCount ?? scenarios.length} runs`,
  };
}

export const defaultCard: CardData = {
  eyebrow: "Stable releases · reproducible · public",
  headline: "OpenClaw runtime performance",
  subhead: "Startup time · agent run time · measured by Kova",
  counts: null,
  hero: null,
  fact: "kova.openclaw.dev",
};

function primaryReleaseScenario(scenarios: Scenario[]): Scenario | null {
  return scenarios.find((s) => s.id === "gateway-session-send-turn" && s.value != null) ??
    scenarios.find((s) => s.id === "agent-cold-warm-message" && s.value != null) ??
    scenarios.find((s) => s.id === "release-runtime-startup" && s.value != null) ??
    scenarios.find((s) => s.id === "gateway-performance" && s.value != null) ??
    null;
}
