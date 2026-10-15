import { posix } from "node:path";
import { checkCatalogueCommands, parseCatalogueCommand, createCatalogueResolver } from "../catalogue.mjs";

const personaKey = /\{persona:([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+)\}/g;
const own = (value, key) => Object.hasOwn(value, key);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function matchesPaths(path, globs) {
  return globs.some((glob) => !glob.startsWith("!") && posix.matchesGlob(path, glob))
    && !globs.some((glob) => glob.startsWith("!") && posix.matchesGlob(path, glob.slice(1)));
}

function runFiles(command, entry, standard) {
  const { tokens, findings } = parseCatalogueCommand(command, { standard });
  if (findings.length) return { reads: [], writes: [] }; // The catalogue reports these on selected phases.
  const reads = [], writes = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      if (i === 2 && tokens[0] === "ocm" && tokens[1].startsWith("@")) continue;
      break;
    }
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    const spec = entry?.flags[flag];
    if (!spec || spec.value === "none") continue;
    const value = equal < 0 ? tokens[i + 1] : token.slice(equal + 1);
    if (equal < 0 && (spec.value === "required" || (value && !value.startsWith("--")))) i += 1;
    if (!value?.startsWith("{run}/")) continue;
    if (!["--out", "--handle", "--wait", "--from"].includes(flag) && !flag.endsWith("-from") && !flag.endsWith("-handle")) continue;
    const relative = value.slice(6);
    if (!relative || relative.startsWith("/") || relative.split("/").some((part) => part === "..") || relative.includes("\\")) {
      throw new Error(`invalid run file: ${value}`);
    }
    const file = `{run}/${posix.normalize(relative)}`;
    (flag === "--out" || flag === "--handle" ? writes : reads).push(file);
  }
  return { reads, writes };
}

export function selectPhases({ paths, standard, templates, areas, extraPhases = { phases: [], expects: [] }, persona, catalogue }) {
  const ignored = paths.filter((path) => Object.values(standard.ignore).some((globs) => matchesPaths(path, globs)));
  const ignoredSet = new Set(ignored);
  const changed = paths.filter((path) => !ignoredSet.has(path));
  const records = [];
  const resolveEntry = createCatalogueResolver(catalogue);
  const add = (phases, source, group, from) => phases.forEach((phase, index) => {
    const entries = phase.commands.map((command) => resolveEntry(command, { standard: source === "standard" }));
    const traits = new Set(phase.requires ?? []);
    const destroys = new Set();
    const reads = new Set(), writes = new Set();
    phase.commands.forEach((command, i) => {
      for (const [, trait] of command.matchAll(personaKey)) {
        traits.add(trait);
        if (entries[i]?.side === "destructive") destroys.add(trait);
      }
      const fileCommand = command.replace(personaKey, (placeholder, trait, key) => {
        const value = own(persona.traits, trait) && own(persona.traits[trait].keys, key) ? persona.traits[trait].keys[key] : undefined;
        return key !== "env" && typeof value === "string" && /^[a-zA-Z0-9._:/@-]+$/.test(value) ? value : placeholder;
      });
      const files = runFiles(fileCommand, entries[i], source === "standard");
      for (const file of files.reads) if (!writes.has(file)) reads.add(file);
      files.writes.forEach((file) => writes.add(file));
    });
    records.push({ phase: { ...phase, id: `${source}/${phase.id}`, from: from ?? phase.from }, source, group, index, traits, destroys, reads, writes, deps: new Set(), missing: new Set() });
  });
  add(standard.before, "standard", "before", "standard");
  for (const template of [...templates].sort((a, b) => compare(a.id, b.id))) add(template.phases, template.id, "template", `template:${template.id}`);
  add(extraPhases.phases, "intent", "intent");
  add(standard.after, "standard", "after", "standard");
  const byId = new Map();
  for (const record of records) {
    if (byId.has(record.phase.id)) throw new Error(`duplicate phase: ${record.phase.id}`);
    byId.set(record.phase.id, record);
  }
  const selected = new Set(records.filter((record) => record.group === "template" && changed.some((path) => matchesPaths(path, record.phase.paths))));
  const mapped = changed.filter((path) => [...selected].some((record) => matchesPaths(path, record.phase.paths)));
  const unmapped = changed.filter((path) => !mapped.includes(path)).flatMap((path) => {
    const owners = areas.filter((area) => matchesPaths(path, [...area.paths, ...(area.bound?.includes ?? []).flatMap((line) => {
      // Area bounds also name commands and prose; only repository paths are globs.
      const prefix = line.split(": ", 1)[0];
      return prefix.split(/,\s*| and /).filter((value) => !/\s/.test(value)
        && (value.includes("/") || /\.(?:json5?|[cm]?[jt]sx?|md|ya?ml|toml|rs|sh)$/.test(value)));
    })]));
    return owners.length ? owners.map((area) => `no phase for ${path} in ${area.id}`) : [`no template for ${path}`];
  });
  for (const record of records) if (record.group === "intent") selected.add(record);
  if (changed.length || extraPhases.phases.length) for (const record of records) if (record.source === "standard") selected.add(record);
  const writers = new Map();
  for (const record of records) for (const file of record.writes) {
    if (!writers.has(file)) writers.set(file, new Set());
    writers.get(file).add(record);
  }
  const pending = [...selected];
  const include = (record) => {
    if (!selected.has(record)) { selected.add(record); pending.push(record); }
  };
  const depend = (reader, writer) => {
    reader.deps.add(writer);
    include(writer);
  };
  for (let i = 0; i < pending.length; i += 1) {
    const record = pending[i];
    if (record.group === "template") {
      for (const setup of records) if (setup !== record && setup.source === record.source && setup.phase.kind === "setup") {
        include(setup);
        if (record.phase.kind !== "setup") record.deps.add(setup);
      }
    }
    for (const file of new Set([...record.reads, ...record.writes])) {
      const candidates = [...(writers.get(file) ?? [])];
      if (candidates.length > 1) throw new Error(`multiple writers for ${file}: ${candidates.map((item) => item.phase.id).join(", ")}`);
      if (record.reads.has(file)) {
        if (!candidates.length) throw new Error(`no writer for ${file}, read by ${record.phase.id}`);
        if (candidates[0] === record) throw new Error(`${record.phase.id} reads ${file} before writing it`);
        depend(record, candidates[0]);
      }
    }
  }
  const checkCommands = () => {
    const commands = [...selected].flatMap((record) => record.phase.commands.map((command, i) => ({ command, source: record.phase.id, at: `/commands/${i}`, standard: record.source === "standard" })));
    const findings = checkCatalogueCommands(catalogue, commands);
    const invalid = findings.filter((finding) => finding.code !== "toWrite");
    if (invalid.length) {
      const error = new Error(`catalogue check refused plan: ${invalid.map((finding) => `${finding.source ?? "catalogue"}${finding.at ?? ""}: ${finding.code}: ${finding.message}`).join("; ")}`);
      error.findings = invalid;
      throw error;
    }
    return findings;
  };
  const findings = checkCommands();
  for (const finding of findings) byId.get(finding.source).missing.add(`entry:${finding.entryId}`);
  for (const record of selected) {
    for (const trait of record.phase.requires ?? []) if (!own(persona.traits, trait)) record.missing.add(`trait:${trait}`);
    record.phase.commands = record.phase.commands.map((command) => command.replace(personaKey, (placeholder, trait, key) => {
      if (!own(persona.traits, trait)) { record.missing.add(`trait:${trait}`); return placeholder; }
      if (!own(persona.traits[trait].keys, key)) { record.missing.add(`key:${trait}:${key}`); return placeholder; }
      const value = persona.traits[trait].keys[key];
      if (typeof value !== "string" || !/^[a-zA-Z0-9._:/@-]+$/.test(value)) throw new Error(`unsafe persona key: ${trait}:${key}`);
      return key === "env" ? placeholder : value;
    }));
  }
  // Safe key characters can still change argument interpretation (for example a leading dash).
  checkCommands();
  const dependents = new Map([...selected].map((record) => [record, new Set()]));
  const selectedSetups = [...selected].filter((record) => record.group === "template" && record.phase.kind === "setup");
  for (const record of selected) {
    for (const dep of record.deps) dependents.get(dep).add(record);
    for (const setup of selectedSetups) if (setup !== record && setup.source === record.source) dependents.get(setup).add(record);
  }
  const missingQueue = [...selected].filter((record) => record.missing.size);
  for (let i = 0; i < missingQueue.length; i += 1) {
    const dep = missingQueue[i];
    for (const record of dependents.get(dep)) {
      if (!record.missing.size) missingQueue.push(record);
      record.missing.add(`phase:${dep.phase.id}`);
    }
  }
  const active = [...selected].filter((record) => !record.missing.size);
  const edges = new Map(active.map((record) => [record, new Set()]));
  const precedes = (first, second) => { if (first !== second && edges.has(first) && edges.has(second)) edges.get(second).add(first); };
  for (const record of active) {
    for (const dep of record.deps) precedes(dep, record);
    for (const other of active) {
      if (record.group === "before" && other.group !== "before") precedes(record, other);
      if (record.group === "after" && other.group !== "after") precedes(other, record);
      if (record.group !== "intent" && record.source === other.source && record.group === other.group && record.index < other.index) precedes(record, other);
      for (const trait of record.destroys) if (other.traits.has(trait) && !other.destroys.has(trait)) precedes(other, record);
    }
  }
  const kindOrder = { setup: 0, operation: 1, event: 2 };
  const tieBreak = (a, b) => (kindOrder[a.phase.kind] ?? 0) - (kindOrder[b.phase.kind] ?? 0)
    || (a.group === "intent") - (b.group === "intent") || compare(a.source, b.source) || a.index - b.index;
  const ordered = [];
  while (edges.size) {
    const available = [...edges].filter(([, deps]) => !deps.size).map(([record]) => record).sort(tieBreak);
    if (!available.length) throw new Error(`phase order conflicts: ${[...edges.keys()].map((record) => record.phase.id).join(", ")}`);
    const next = available[0];
    ordered.push(next.phase);
    edges.delete(next);
    for (const deps of edges.values()) deps.delete(next);
  }
  return { phases: ordered, withheld: [...selected].filter((record) => record.missing.size).map((record) => ({ id: record.phase.id, from: record.phase.from, missing: [...record.missing].sort(compare) })).sort((a, b) => compare(a.id, b.id)), unmapped, ignored };
}
