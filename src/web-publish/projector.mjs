/**
 * Web publish projector: pure functions that take a web-payload-shaped
 * release and the prior published releases, and return the same release
 * with deltas + comparison rows filled in.
 *
 * No I/O on the augmentation side — `commands/publish.mjs` handles disk.
 * Keeping projection pure makes it trivial to snapshot-test the receipt
 * without spinning up a real artifact dir.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read every `*.json` in `dir` and parse without validation.
 * Validation is the caller's job (use `parseRelease` from the contract).
 *
 * @param {string} dir
 * @returns {Promise<Array<{ id: string; data: any }>>}
 */
export async function loadPriorReleases(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const raw = await readFile(join(dir, n), "utf8");
    out.push({ id: n.replace(/\.json$/, ""), data: JSON.parse(raw) });
  }
  return out;
}

/**
 * Pick the chronologically-previous release before `targetDate` in the same
 * release lane. Stable publishes compare to stable releases only, and
 * pre-release publishes compare to pre-releases only; mixing the lanes makes
 * public deltas read as a fallback to whichever artifact happened to be newer.
 *
 * Releases with no `releaseDate` are skipped. The target version itself is
 * excluded so re-publishing doesn't compare against itself.
 *
 * @param {Array<{ id: string; data: any }>} releases
 * @param {string} targetVer
 * @param {Date|string} targetDate
 * @returns {{ id: string; data: any } | null}
 */
export function findImmediatePrior(releases, targetVer, targetDate) {
  const t = releaseDayValue(targetDate);
  if (!Number.isFinite(t)) return null;
  let best = null;
  let bestT = -Infinity;
  for (const r of releases) {
    const ver = r.data?.ver ?? r.id;
    if (ver === targetVer) continue;
    if (!sameReleaseLane(ver, targetVer)) continue;
    const d = releaseDayValue(r.data?.releaseDate);
    const isEarlierVersionOnTargetDay = d === t && compareVersions(ver, targetVer) < 0;
    if (!Number.isFinite(d) || d > t || (d === t && !isEarlierVersionOnTargetDay)) continue;
    const bestVer = best?.data?.ver ?? best?.id;
    if (d > bestT || (d === bestT && compareVersions(ver, bestVer) > 0)) {
      best = r;
      bestT = d;
    }
  }
  return best;
}

function releaseDayValue(value) {
  if (!value) return NaN;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return NaN;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function compareVersions(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function isPreReleaseVersion(ver) {
  return typeof ver === "string" && ver.includes("-");
}

function sameReleaseLane(a, b) {
  return isPreReleaseVersion(a) === isPreReleaseVersion(b);
}

function pctDelta(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Return a new release payload with deltas computed against `prior`.
 * Never mutates the input. Fills in:
 *   - `coldReadyDeltaPct` (from `release-runtime-startup` scenario)
 *   - `headline[*].vsVer` and `headline[*].deltaPct` for entries that
 *     have a `scenarioId` matching one of the prior scenarios.
 *   - `comparison` block: one row per scenario that exists in both with
 *     matching `unit` and a numeric value.
 *
 * When `prior` is null this is a no-op pass-through. Pre-existing values
 * are never overwritten — the caller is the source of truth when they
 * supply explicit deltas.
 *
 * @param {any} payload  Web-payload-shaped release.
 * @param {{ id: string; data: any } | null} prior
 * @returns {any}
 */
export function augmentWithDeltas(payload, prior) {
  const next = structuredClone(payload);
  if (!prior) return next;

  const priorScenarios = new Map(
    (prior.data.scenarios ?? []).map((s) => [s.id, s]),
  );
  const priorHeadlines = new Map(
    (prior.data.headline ?? [])
      .filter((headline) => headline.scenarioId && headline.metric && headline.unit)
      .map((headline) => [headlineIdentity(headline), headline]),
  );
  const currScenarios = new Map(
    (next.scenarios ?? []).map((s) => [s.id, s]),
  );

  if (next.coldReadyDeltaPct == null) {
    const curCold = currScenarios.get("release-runtime-startup");
    const priorCold = priorScenarios.get("release-runtime-startup");
    const dp = pctDelta(curCold?.value ?? null, priorCold?.value ?? null);
    if (dp != null) next.coldReadyDeltaPct = round1(dp);
  }

  if (Array.isArray(next.headline)) {
    next.headline = next.headline.map((h) => {
      if (h.deltaPct != null && h.vsVer != null) return h;
      if (!h.scenarioId || !h.metric || !h.unit) return h;
      const priorHeadline = priorHeadlines.get(headlineIdentity(h));
      const dp = pctDelta(h.value ?? null, priorHeadline?.value ?? null);
      if (dp == null) return h;
      return { ...h, vsVer: prior.data.ver, deltaPct: round1(dp) };
    });
  }

  if (!next.comparison) {
    const rows = [];
    for (const [id, cs] of currScenarios) {
      const ps = priorScenarios.get(id);
      if (!ps) continue;
      if (cs.value == null || ps.value == null) continue;
      if (cs.unit !== ps.unit) continue;
      const dp = pctDelta(cs.value, ps.value);
      if (dp == null) continue;
      rows.push({
        scenarioId: id,
        metric: cs.metric ?? id,
        before: ps.value,
        after: cs.value,
        unit: cs.unit,
        deltaPct: round1(dp),
        lowerIsBetter: cs.lowerIsBetter !== false,
      });
    }
    if (rows.length > 0) {
      next.comparison = { vsVer: prior.data.ver, rows };
    }
  }

  return next;
}

function headlineIdentity(headline) {
  return `${headline.scenarioId}\u0000${headline.metric}\u0000${headline.unit}`;
}

/**
 * Recognize input payload shape. We accept:
 *   - `kova.web-payload.v1` (this contract) — ready to publish.
 *   - anything that has top-level `ver` and `releaseDate` — assumed to
 *     be a hand-curated web-payload; validated by the contract on the
 *     publish path.
 *   - `kova.report.v1` — internal Kova run report. Publish projects it
 *     through `from-internal-report.mjs` before validation.
 *
 * @param {any} input
 * @returns {"web-payload" | "internal-report" | "unknown"}
 */
export function classifyInput(input) {
  if (!input || typeof input !== "object") return "unknown";
  if (input.schemaVersion === "kova.report.v1") return "internal-report";
  if (typeof input.ver === "string" && (input.releaseDate || input.date)) {
    return "web-payload";
  }
  return "unknown";
}
