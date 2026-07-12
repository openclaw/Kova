/**
 * Kova → web payload contract (single source of truth).
 *
 * Defines the shape every release JSON in `web/src/content/releases/<ver>.json`
 * must conform to. Consumed by:
 *
 *   - Astro site (`web/src/content.config.ts`) for content-collection schema.
 *   - Kova CLI `kova publish <run-id>` projector for produce-side validation
 *     before writing into the web tree.
 *   - `kova check:contract` self-check which fails CI if the live release
 *     JSONs ever drift from this schema.
 *
 * One file = one contract. Both ends of the pipeline (CLI producer and
 * Astro consumer) MUST import schemas from here so they cannot drift.
 *
 * Versioning rule: any change that adds a required field is a major bump
 * of `WEB_PAYLOAD_SCHEMA_VERSION`. Adding an optional field is a minor
 * bump. The schema version is intentionally separate from Kova's internal
 * `kova.report.v1` schemaVersion — the report is the *input* to publish,
 * the web payload is the *output*.
 *
 * Plain ESM with JSDoc typedefs so Kova CLI (.mjs) can `import` it
 * directly. The web side (TypeScript) gets full types via `z.infer`.
 */

import { z } from "zod";

export const WEB_PAYLOAD_SCHEMA_VERSION = "kova.web-payload.v1";

/* ─── Atomic enums ────────────────────────────────────────────── */

export const stateEnum = z.enum(["pass", "fail", "block"]);
export const findingKind = z.enum(["fail", "warn", "info"]);
export const proveState = z.enum(["pass", "fail"]);

const finiteNumber = z.number().finite();
const nonnegativeNumber = finiteNumber.nonnegative();
const nonnegativeInteger = z.number().int().nonnegative();

/* ─── Per-scenario summary (top-level on a release) ───────────── */

export const scenarioSchema = z.strictObject({
  id: z.string(),
  /** Public label for the headline metric, e.g. "startup" or "full turn". */
  metric: z.string().optional(),
  value: finiteNumber.nullable(),
  unit: z.string(),
  threshold: nonnegativeNumber,
  state: stateEnum,
  /** Trailing-window samples; null when no sample. */
  spark: z.array(finiteNumber).nullable(),
  /** Defaults true; set false when higher numbers are better. */
  lowerIsBetter: z.boolean().optional(),
  /** Worst contributing metric, used by scenario tile. */
  worstMetric: z
    .strictObject({ name: z.string(), value: finiteNumber, unit: z.string() })
    .optional(),
});

/* ─── Per-run details (drill-down on /releases/<ver>) ─────────── */

export const phaseSchema = z.strictObject({
  name: z.string(),
  elapsedMs: nonnegativeInteger,
  state: stateEnum,
});

export const metricRowSchema = z.strictObject({
  name: z.string(),
  value: finiteNumber.nullable(),
  unit: z.string(),
  threshold: nonnegativeNumber.nullable(),
  state: stateEnum,
  /** Renders indented (role-scoped child of the previous metric). */
  child: z.boolean().optional(),
});

export const findingSchema = z.strictObject({
  kind: findingKind,
  text: z.string(),
  scenarioId: z.string().optional(),
  metric: z.string().optional(),
});

export const proveSchema = z.strictObject({
  state: proveState,
  text: z.string(),
  scenarioId: z.string().optional(),
});

export const runScenarioSchema = z.strictObject({
  id: z.string(),
  state: stateEnum,
  sampleCount: nonnegativeInteger,
  /** Headline number for this scenario in this run, before unit formatting. */
  sampleValue: finiteNumber.optional(),
  sampleUnit: z.string().optional(),
  phases: z.array(phaseSchema).optional(),
  metrics: z.array(metricRowSchema).optional(),
  findings: z.array(findingSchema).optional(),
  proves: z.array(proveSchema).optional(),
});

export const bundleSchema = z.strictObject({
  name: z.string(),
  bytes: nonnegativeInteger,
  href: z.string(),
});

export const runSchema = z.strictObject({
  id: z.string(),
  runtime: z.string(),
  profile: z.string(),
  startedAt: z.coerce.date(),
  durationMs: nonnegativeInteger,
  entryCount: nonnegativeInteger,
  state: stateEnum,
  host: z.string().optional(),
  command: z.string().optional(),
  expandedByDefault: z.boolean().optional(),
  scenarios: z.array(runScenarioSchema).optional(),
  bundle: bundleSchema.optional(),
});

/* ─── Headline + comparison (publish-time projections) ────────── */

export const headlineSchema = z.strictObject({
  label: z.string(),
  value: finiteNumber,
  unit: z.string(),
  vsVer: z.string().optional(),
  deltaPct: finiteNumber.optional(),
  lowerIsBetter: z.boolean().optional(),
  scenarioId: z.string().optional(),
  metric: z.string().optional(),
});

export const comparisonRowSchema = z.strictObject({
  scenarioId: z.string(),
  metric: z.string(),
  before: finiteNumber,
  after: finiteNumber,
  unit: z.string(),
  deltaPct: finiteNumber,
  lowerIsBetter: z.boolean().optional(),
});

export const comparisonSchema = z.strictObject({
  vsVer: z.string(),
  rows: z.array(comparisonRowSchema),
});

/* ─── Root release schema ─────────────────────────────────────── */

export const releaseSchema = z.strictObject({
  ver: z.string(),
  releaseDate: z.coerce.date(),
  date: z.string(),
  sha: z.string(),
  passed: z.boolean(),
  /** Number of runs executed. Kept even when `runs[]` is populated. */
  runCount: nonnegativeInteger.optional(),
  host: z.string().optional(),
  coldReadyDeltaPct: finiteNumber.optional(),
  scenarios: z.array(scenarioSchema).optional(),
  runtimeTargets: z.array(z.string()).optional(),
  headline: z.array(headlineSchema).optional(),
  runs: z.array(runSchema).optional(),
  comparison: comparisonSchema.optional(),
});

/* ─── Convenience helpers ─────────────────────────────────────── */

/**
 * Parse-or-throw with a descriptive error pointing at the offending file.
 * Use this on the publish side before writing into web/src/content/releases.
 *
 * @param {unknown} data
 * @param {string} sourceLabel  Human label, e.g. an artifact path or "<run-id>".
 * @returns {z.infer<typeof releaseSchema>}
 */
export function parseRelease(data, sourceLabel = "<unknown>") {
  const result = releaseSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid web-payload (${WEB_PAYLOAD_SCHEMA_VERSION}) at ${sourceLabel}:\n${issues}`,
    );
  }
  return result.data;
}

/** Non-throwing variant returning `{ ok, data?, errors? }`. */
export function safeParseRelease(data) {
  const result = releaseSchema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join(".") || "<root>",
      message: i.message,
      code: i.code,
    })),
  };
}

/* ─── JSDoc typedefs (for IDE intellisense in plain .mjs callers) ─ */

/** @typedef {z.infer<typeof releaseSchema>}       WebPayloadRelease */
/** @typedef {z.infer<typeof scenarioSchema>}      WebPayloadScenario */
/** @typedef {z.infer<typeof runSchema>}           WebPayloadRun */
/** @typedef {z.infer<typeof runScenarioSchema>}   WebPayloadRunScenario */
/** @typedef {z.infer<typeof phaseSchema>}         WebPayloadPhase */
/** @typedef {z.infer<typeof metricRowSchema>}     WebPayloadMetricRow */
/** @typedef {z.infer<typeof findingSchema>}       WebPayloadFinding */
/** @typedef {z.infer<typeof proveSchema>}         WebPayloadProve */
/** @typedef {z.infer<typeof bundleSchema>}        WebPayloadBundle */
/** @typedef {z.infer<typeof headlineSchema>}      WebPayloadHeadline */
/** @typedef {z.infer<typeof comparisonRowSchema>} WebPayloadComparisonRow */
/** @typedef {z.infer<typeof comparisonSchema>}    WebPayloadComparison */
