// Inline status badges. Background-colored chips when color is on,
// ASCII brackets otherwise. The kind drives the palette.

import { makeColor } from "./color.mjs";

const KIND_TO_BG = {
  SHIP: "ok",
  PASS: "ok",
  OK: "ok",
  READY: "ok",
  GREEN: "ok",
  CLEAN: "ok",
  CLEANED: "ok",
  DONE: "ok",
  IMPROVED: "ok",
  DO_NOT_SHIP: "err",
  FAIL: "err",
  PARTIAL: "warn",
  INCOMPLETE: "warn",
  REGRESSION: "warn",
  BLOCKED: "block",
  SKIPPED: "neutral",
  "DRY-RUN": "neutral",
  DRY_RUN: "neutral",
  HEALTHY: "ok",
};

export function badge(label, kind, ui) {
  const c = makeColor(ui);
  const key = String(kind || label).toUpperCase().replace(/[\s-]/g, "_");
  const slot = KIND_TO_BG[key] || KIND_TO_BG[String(kind || label).toUpperCase()] || "neutral";
  const text = ` ${label} `;
  if (!c.enabled) return `[${label}]`;
  return c.bg[slot](text);
}
