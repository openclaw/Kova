import { equal, itemKey, valueOf } from "./rows.mjs";

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

export function verdictFor({ rows, exitTwo, damaged = [], notStarted, incomplete, undeclared }) {
  if (damaged.length) return "unresolved";
  if (rows.some((row) => row.class === "break")) return "breaks";
  if (exitTwo || rows.some((row) => row.class === "flaky") || notStarted.length || incomplete.length || undeclared.length) return "unresolved";
  return "good-to-go";
}

// Only structural addresses participate: log and stdout text use the item noise
// set, so one varying line cannot hide a new line in the same signal.
export function noiseFloor(first, second) {
  const noisy = new Set();
  const groups = new Map();
  for (const [key, item] of first) {
    if (!equal(valueOf(item), valueOf(second.get(key)))) noisy.add(key);
  }
  for (const [key, item] of second) {
    if (!first.has(key) && !equal(valueOf(undefined), valueOf(item))) noisy.add(key);
  }
  for (const [side, items] of [[0, first], [1, second]]) {
    let recentSignal, recent = [];
    for (const item of items.values()) {
      if (item.signal !== recentSignal) { recentSignal = item.signal; recent = []; }
      for (const index of item.dynamic) {
        // Adjacent children usually share their structural prefixes. Reuse
        // the group only after checking the prefix, regardless of item order.
        let group = recent[index];
        if (group) for (let part = 0; part < index; part++) {
          if (group.prefix[part] !== item.segments[part]) { group = undefined; break; }
        }
        if (!group) {
          const prefix = item.segments.slice(0, index);
          const key = itemKey(item.signal, JSON.stringify(prefix));
          group = groups.get(key);
          if (!group) { group = { signal: item.signal, prefix, sides: [new Set(), new Set()] }; groups.set(key, group); }
          recent[index] = group;
        }
        group.sides[side].add(item.segments[index]);
      }
    }
  }
  const patterns = [];
  for (const group of groups.values()) {
    const [a, b] = group.sides;
    let differs = a.size !== b.size;
    if (!differs) for (const part of a) if (!b.has(part)) { differs = true; break; }
    if (!differs) continue;
    const stable = new Set();
    for (const part of a) if (b.has(part)) stable.add(part);
    patterns.push({ ...group, stable });
  }
  groups.clear();
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
  const excluded = [];
  let excludedKey;
  const checkpoint = itemKey("checkpoint", "");
  const baselineRecorded = baseline.get(checkpoint)?.value !== false;
  const recorded = changes.map((items) => items.get(checkpoint)?.value !== false);
  const keySet = new Set(baseline.keys());
  for (const items of changes) for (const key of items.keys()) keySet.add(key);
  const keys = [...keySet].sort();
  keySet.clear();
  const predictions = new Map(expects.filter((expected) => expected.phase === phase).map((expected) => [itemKey(expected.signal, expected.at), expected]));
  for (const key of keys) {
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
        const previous = excluded.at(-1);
        if (previous && excludedKey === key && previous.class === category && equal(previous.change, valueOf(after))) previous.clones.push(`change-${i + 1}`);
        else excluded.push({ phase, signal: representative.signal, at: representative.at, category: "noiseClones", reason: noise.noisy.has(key) ? "noise copies differ at this item" : "noise copies differ in this address", clones: [`change-${i + 1}`], baseline: valueOf(before), change: valueOf(after), class: category });
        excludedKey = key;
        continue;
      }
      const row = { phase, signal: representative.signal, at: representative.at, clones: [`change-${i + 1}`], baseline: valueOf(before), change: valueOf(after), class: category, explainedBy: category === "intended" ? "intent:goal" : null };
      const previous = rows.at(-1);
      if (previous && previous.signal === row.signal && previous.at === row.at && previous.class === row.class && equal(previous.change, row.change)) previous.clones.push(...row.clones);
      else rows.push(row);
    }
  }
  return { rows, noiseExcluded: excluded.length, excluded };
}
