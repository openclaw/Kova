// Unified verdict headline builder. Produces the headline + meta strings
// that feed into renderKovaHeader.
//
// Form:
//   [VERDICT]   <scope> · <samples> · <confidence> · <elapsed?>
//
// The verdict and meta are still positioned by the header renderer; this
// module only assembles the strings consistently across surfaces.

import { formatDuration } from "./format.mjs";

// buildVerdictHeadline({
//   scope,         // e.g. "3 scenarios", "5/15 samples failed", "1/3 regressed"
//   samples,       // e.g. "15 samples", "30 runs"
//   confidence,    // label from classifyConfidence (e.g. "stable (±3%)")
//   elapsedMs,     // total wall clock for the run
//   sep,           // separator glyph from ui.g.sep (caller-provided to avoid coupling)
// }) -> string
export function buildVerdictHeadline({ scope, samples, confidence, elapsedMs, sep = "·" } = {}) {
  const parts = [
    scope,
    samples,
    confidence,
    elapsedMs != null ? formatDuration(elapsedMs) : null,
  ].filter(Boolean);
  return parts.join(` ${sep} `);
}
