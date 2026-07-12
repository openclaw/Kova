/**
 * Pure matrix calculations kept separate from Astro content loading so the
 * continuity and status contracts can be tested directly.
 */

type ScenarioState = "pass" | "fail" | "block";

interface HeadlineSource {
  headline?: Array<{
    metric?: string;
    scenarioId?: string;
    value: number;
  }>;
  scenarios?: Array<{
    id: string;
    state: ScenarioState;
  }>;
}

export function pctDelta(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

/**
 * Compare each value only with the immediately preceding chronological slot.
 * Missing releases and blocked/null samples break the comparison chain.
 */
export function chronologicalDeltas(values: Array<number | null>): Array<number | null> {
  return values.map((value, index) =>
    pctDelta(value, index === 0 ? null : values[index - 1] ?? null),
  );
}

export function headlineMetric(
  release: HeadlineSource,
  metrics: string[],
): { value: number | null; breach: boolean } | null {
  const hit = release.headline?.find((headline) => metrics.includes(headline.metric ?? ""));
  if (!hit) return null;
  const scenario = hit.scenarioId
    ? release.scenarios?.find((candidate) => candidate.id === hit.scenarioId)
    : undefined;
  return { value: hit.value, breach: scenario?.state === "fail" };
}
