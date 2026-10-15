import { equal, itemKey, valueOf } from "./rows.mjs";
import { canonicalJSON } from "./plan.mjs";

export function classify({ baseline, change, other, expected, signal }) {
  const before = valueOf(baseline);
  const after = valueOf(change);
  const different = !equal(before, after);
  if (baseline?.failure && change?.failure && (equal(before, after) || signal === "logs")) return "not-caused";
  if (!different) return null;
  if (baseline?.failure && !change?.failure || signal === "checkpoint" && before === false && after === true) return "fixed";
  if (expected && equal(after, expected.change)) return "intended";
  if (equal(before, valueOf(other))) return "flaky";
  return "break";
}

export function verdictFor({ rows, exitTwo, notStarted, incomplete, undeclared }) {
  if (exitTwo) return "unresolved";
  if (rows.some((row) => row.class === "break")) return "breaks";
  if (rows.some((row) => row.class === "flaky") || notStarted.length || incomplete.length || undeclared.length) return "unresolved";
  return "good-to-go";
}

// Only structural addresses participate: log and stdout text use the item noise
// set, so one varying line cannot hide a new line in the same signal.
export function noiseFloor(first, second) {
  const noisy = new Set();
  const groups = new Map();
  for (const key of new Set([...first.keys(), ...second.keys()])) {
    if (!equal(valueOf(first.get(key)), valueOf(second.get(key)))) noisy.add(key);
  }
  for (const [side, items] of [[0, first], [1, second]]) for (const item of items.values()) {
    for (const index of item.dynamic) {
      const prefix = item.segments.slice(0, index);
      const key = itemKey(item.signal, JSON.stringify(prefix));
      if (!groups.has(key)) groups.set(key, { signal: item.signal, prefix, sides: [new Set(), new Set()] });
      groups.get(key).sides[side].add(item.segments[index]);
    }
  }
  const patterns = [...groups.values()].filter(({ sides: [a, b] }) => ([...a].some((x) => !b.has(x)) || [...b].some((x) => !a.has(x)))).map((group) => ({ ...group, stable: new Set([...group.sides[0]].filter((part) => group.sides[1].has(part))) }));
  const indexed = new Map();
  const covered = (signal, segments) => {
    for (let index = 0; index < segments.length; index++) {
      const pattern = indexed.get(itemKey(signal, JSON.stringify(segments.slice(0, index))));
      if (pattern && !pattern.stable.has(segments[index])) return true;
    }
    return false;
  };
  // A parent pattern already excludes its varying descendants. Indexing
  // prefixes also keeps lookup independent of the number of noisy records.
  const roots = [];
  for (const pattern of patterns.sort((a, b) => a.prefix.length - b.prefix.length)) {
    if (covered(pattern.signal, pattern.prefix)) continue;
    roots.push(pattern);
    indexed.set(itemKey(pattern.signal, JSON.stringify(pattern.prefix)), pattern);
  }
  return {
    noisy,
    patterns: roots,
    excludes(item) { return noisy.has(itemKey(item.signal, item.at)) || covered(item.signal, item.segments); }
  };
}

export function compareItems({ phase, baseline, changes, noise, expects }) {
  const rows = [];
  const excluded = new Map();
  const checkpoint = itemKey("checkpoint", "");
  const baselineRecorded = baseline.get(checkpoint)?.value !== false;
  const recorded = changes.map((items) => items.get(checkpoint)?.value !== false);
  const keys = new Set([...baseline.keys(), ...changes.flatMap((items) => [...items.keys()])]);
  const predictions = new Map(expects.filter((expected) => expected.phase === phase).map((expected) => [itemKey(expected.signal, expected.at), expected]));
  for (const key of [...keys].sort()) {
    const before = baseline.get(key);
    const representative = before ?? changes[0].get(key) ?? changes[1].get(key);
    const expected = predictions.get(key);
    for (let i = 0; i < 2; i++) {
      // Only the checkpoint itself can be compared when a whole side is absent.
      if (key !== checkpoint && (!baselineRecorded || !recorded[i])) continue;
      const after = changes[i].get(key);
      const other = key === checkpoint || recorded[1 - i] ? changes[1 - i].get(key) : before;
      const category = classify({ baseline: before, change: after, other, expected, signal: representative.signal });
      if (!category) continue;
      if (noise.excludes(representative)) {
        const id = canonicalJSON([key, category, valueOf(after)]);
        if (excluded.has(id)) excluded.get(id).clones.push(`change-${i + 1}`);
        else excluded.set(id, { phase, signal: representative.signal, at: representative.at, category: "noiseClones", reason: noise.noisy.has(key) ? "noise copies differ at this item" : "noise copies differ in this address", clones: [`change-${i + 1}`], baseline: valueOf(before), change: valueOf(after), class: category });
        continue;
      }
      const row = { phase, signal: representative.signal, at: representative.at, clones: [`change-${i + 1}`], baseline: valueOf(before), change: valueOf(after), class: category, explainedBy: category === "intended" ? "intent:goal" : null };
      const previous = rows.at(-1);
      if (previous && previous.signal === row.signal && previous.at === row.at && previous.class === row.class && equal(previous.change, row.change)) previous.clones.push(...row.clones);
      else rows.push(row);
    }
  }
  return { rows, noiseExcluded: excluded.size, excluded: [...excluded.values()] };
}
