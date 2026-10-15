const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pointerPart = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");

// Finding patterns describe related rows; they never participate in comparison.
export function createAddressPattern(identities = []) {
  const known = new Set([...identities].filter((value) => typeof value === "string" && value.length));
  const alternatives = [...known].sort((a, b) => b.length - a.length || compareText(a, b));
  const matcher = (values) => values.length
    ? new RegExp(`(?<![A-Za-z0-9_])(?:${values.map(escapePattern).join("|")})(?![A-Za-z0-9_])`, "g")
    : null;
  const embedded = matcher(alternatives);
  const acrossSegments = matcher(alternatives.filter((value) => value.includes("/")));
  const identify = (value) => {
    if (known.has(value)) return "<id>";
    return embedded ? value.replace(embedded, "<id>") : value;
  };
  const text = (value) => identify(value).replace(/\d+/g, "*");
  const json = (value) => {
    if (typeof value === "string") return JSON.stringify(text(value));
    // Keep numeric keys distinct from strings containing the same digits.
    if (typeof value === "number") return text(String(value));
    if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(text(key))}:${json(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  // Log addresses may contain literal slashes inside a complete known token.
  // Identify only those before splitting; other IDs could match digits in
  // pointer escapes. Pointer-escaped keys are decoded below.
  return (address) => (acrossSegments ? address.replace(acrossSegments, "<id>") : address).split("/").map((part) => {
    const decoded = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (known.has(decoded)) return pointerPart("<id>");
    if (/^[\[{"]/.test(decoded)) {
      try { return pointerPart(json(JSON.parse(decoded))); }
      catch { /* Ordinary address text need not be JSON. */ }
    }
    return pointerPart(text(decoded));
  }).join("/");
}

export function createFindings({ identities = [] } = {}) {
  const patternFor = createAddressPattern(identities);
  const groups = new Map();
  return {
    add(row) {
      const pattern = patternFor(row.at);
      const key = JSON.stringify([row.signal, row.class, pattern]);
      let group = groups.get(key);
      if (!group) {
        group = {
          signal: row.signal,
          class: row.class,
          pattern,
          count: 0,
          phases: new Map(),
          representative: {
            phase: row.phase,
            at: row.at,
            baseline: row.baseline,
            change: row.change,
            clones: [...row.clones]
          }
        };
        groups.set(key, group);
      }
      group.count++;
      group.phases.set(row.phase, (group.phases.get(row.phase) ?? 0) + 1);
    },
    finish() {
      return [...groups.values()].map((group) => ({
        ...group,
        phases: [...group.phases].sort(([a], [b]) => compareText(a, b)).map(([phase, count]) => ({ phase, count }))
      }));
    }
  };
}
