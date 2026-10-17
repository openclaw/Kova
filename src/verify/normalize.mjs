import { isAbsolute, join, matchesGlob } from "node:path";
import { createCatalogueResolver, parseCatalogueCommand } from "../catalogue.mjs";
import { quoteShell } from "../commands.mjs";
import { canonicalJSON, validateRuntimeStateIds } from "./plan.mjs";
import { checkpointStateFiles, logTextViews, readCommandResponses, readJSON, recordedDirectory } from "./rows.mjs";
import { createdIds } from "./ids.mjs";
import { runtimeEventIdentities } from "./runtime-events.mjs";

function idPattern(ids) {
  const keys = [...ids].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return keys.length ? new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
}

function recordedOperation(record, planned, expected, resolveEntry) {
  if (!record || typeof record !== "object" || typeof record.command !== "string" || !record.command.trim() || typeof record.stderr !== "string" || typeof record.timedOut !== "boolean" || !Number.isFinite(record.durationMs) || record.durationMs < 0 || !(record.exit === null || Number.isInteger(record.exit)) || !(record.stdout === null || typeof record.stdout === "string")) throw new Error("invalid recorded command metadata");
  // Resolution refusals retain the original planned command and exit 2.
  if (record.command === planned) return;
  // Frozen arguments contain literal data, including braces; placeholder rules
  // apply only to source commands. Shell syntax and operation identity still apply.
  const parsed = parseCatalogueCommand(record.command, { standard: true, resolved: true });
  if (parsed.findings.length) throw new Error("invalid recorded command syntax");
  const tokens = parsed.tokens, original = parseCatalogueCommand(planned, { standard: true }).tokens;
  const bindings = new Set();
  if (original[0] === "node" && original[1]?.startsWith("{kovaRoot}/") && tokens[0] === "node" && isAbsolute(tokens[1] ?? "") && tokens[1].endsWith(original[1].slice("{kovaRoot}".length))) {
    tokens[1] = original[1]; bindings.add(1);
  }
  if (original[0] === "ocm" && /^@\{(?:env|persona:[^}]+:env)\}$/.test(original[1] ?? "") && original[2] === "--" && tokens[0] === "ocm" && /^@[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(tokens[1] ?? "") && tokens[2] === "--") {
    tokens[1] = original[1]; bindings.add(1);
  }
  const canonical = tokens.map((token, index) => bindings.has(index) ? token : quoteShell(token)).join(" ");
  if (resolveEntry(canonical, { standard: true, resolved: true })?.id !== expected.id) throw new Error("recorded command does not match its planned operation");
}

// Discover identities across the whole copy before comparing its first checkpoint.
// An id read before its creating response still gets the creator's stable token.
export async function readDeclaredIds(directory, phases, standard, catalogue) {
  validateRuntimeStateIds(standard.stateIds);
  const candidates = new Map();
  const records = new Map();
  let recorded = 0;
  const resolveEntry = createCatalogueResolver(catalogue);
  for (const phase of phases) {
    const checkpoint = join(directory, "checkpoints", phase.id);
    if (!await recordedDirectory(checkpoint)) continue;
    let commands;
    try { commands = await readJSON(join(checkpoint, "commands.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; continue; }
    if (!Array.isArray(commands)) throw new Error(`${phase.id}: invalid command recording`);
    const entries = commands.map((command, index) => {
      const entry = resolveEntry(phase.commands[index % phase.commands.length], { standard: phase.from === "standard" });
      if (!entry) throw new Error(`${phase.id}: recorded catalogue does not resolve command ${index}`);
      recordedOperation(command, phase.commands[index % phase.commands.length], entry, resolveEntry);
      return entry;
    });
    const responses = phase.checkpoint.includes("responses") ? await readCommandResponses(checkpoint, commands, phase.id) : null;
    recorded++;
    for (const [index, command] of commands.entries()) {
      const entry = entries[index];
      if (!Array.isArray(command.createdIds)) throw new Error(`${phase.id}: recording lacks createdIds; rerun verify run`);
      const pointers = new Map();
      for (const { pointer, value } of command.createdIds) {
        if (typeof pointer !== "string" || typeof value !== "string" || !value || !entry.creates.some((declared) => {
          const parts = declared.split("/"), actual = pointer.split("/");
          return parts.length === actual.length && parts.every((part, i) => part === actual[i] || part === "*" && /^(0|[1-9][0-9]*)$/.test(actual[i]));
        })) throw new Error(`${phase.id}: invalid declared creation id`);
        if (pointers.has(pointer) && pointers.get(pointer) !== value) throw new Error(`${phase.id}: contradictory createdIds for one pointer`);
        pointers.set(pointer, value);
      }
      if (command.stdout !== null && pointers.size) throw new Error(`${phase.id}: createdIds require a JSON command output`);
      if (responses && canonicalJSON(Object.fromEntries(pointers)) !== canonicalJSON(Object.fromEntries(createdIds(responses[index], entry.creates).map(({ pointer, value }) => [pointer, value])))) throw new Error(`${phase.id}: createdIds do not match the selected response`);
      for (const [pointer, value] of pointers) if (!candidates.has(value)) candidates.set(value, `<id:${phase.id}/${index}${pointer}>`);
    }
    for await (const file of checkpointStateFiles(join(checkpoint, "state"), phase, standard)) {
      if (file.kind !== "sqlite") continue;
      const declarations = standard.stateIds.filter((item) => matchesGlob(file.path, item.path) && item.table === file.table);
      if (!declarations.length) continue;
      for (const declaration of declarations) {
        for await (const row of file.rows()) {
          // Missing product columns must remain comparable. Without the declared
          // identity/order fields, keep this row's values instead of guessing IDs.
          const ordered = declaration.order !== undefined;
          if (![declaration.column, declaration.recordKey, ...(ordered ? [declaration.order] : [])].every((column) => Object.hasOwn(row.values, column))) continue;
          const identities = declaration.kind === "runtime-message-ids"
            ? runtimeEventIdentities(file, row).map(({ id, field }) => ({ id, field: `${declaration.column}/${field}` }))
            : [{ id: row.values[declaration.column].raw, field: declaration.column }];
          for (const { id, field } of identities) {
            if (typeof id !== "string" || !id) continue;
            const key = row.values[declaration.recordKey].raw;
            const group = canonicalJSON([file.path, field, key, declaration.order ?? null]);
            if (!records.has(group)) records.set(group, { path: file.path, field, key, ordered, ids: new Map() });
            const values = records.get(group).ids;
            if (!values.has(id)) values.set(id, { id, order: ordered ? row.values[declaration.order].orderValue : null, rowid: row.rowid });
          }
        }
      }
    }
  }
  return { candidates, records, recorded, allIds: new Set([...candidates.keys(), ...[...records.values()].flatMap((record) => [...record.ids.keys()])]) };
}

export function normalizeDeclaredIds({ candidates, records, allIds }, protectedIds) {
  for (const id of protectedIds) candidates.delete(id);
  const pattern = idPattern([...allIds].filter((id) => !protectedIds.has(id)));
  const normalize = pattern ? (value) => value.replace(pattern, (id) => candidates.get(id) ?? id) : (value) => value;
  const pending = [...records.values()];
  let undeclared = [];
  for (const record of pending) record.dependencies = pattern ? [...`${record.path}\0${typeof record.key === "string" ? record.key : ""}`.matchAll(pattern)].map(([id]) => id) : [];
  while (pending.length) {
    let changed = false;
    for (let index = 0; index < pending.length;) {
      const record = pending[index];
      if ([...record.ids.keys()].every((id) => protectedIds.has(id) || candidates.has(id))) {
        pending.splice(index, 1);
        changed = true;
        continue;
      }
      const unresolved = record.dependencies.some((id) => !protectedIds.has(id) && !candidates.has(id));
      if (unresolved) { index++; continue; }
      const ids = [...record.ids.values()].sort((a, b) => compare(a.order, b.order) || compare(a.rowid, b.rowid));
      for (let offset = 0; offset < ids.length;) {
        let end = offset + 1;
        while (end < ids.length && compare(ids[offset].order, ids[end].order) === 0) end++;
        const ordinal = record.ordered ? offset + 1 : 1;
        for (let i = offset; i < end; i++) {
          const { id, rowid } = ids[i];
          if (protectedIds.has(id) || candidates.has(id)) continue;
          if (end - offset > 1 && rowid === null) throw new Error(`declared id tie needs rowid: ${record.path}/${record.field}`);
          const key = canonicalJSON(typeof record.key === "string" ? normalize(record.key) : record.key);
          candidates.set(id, `<id:${normalize(record.path)}#${key}/${record.field}/${ordinal}${end - offset > 1 ? `.${i - offset + 1}` : ""}>`);
        }
        offset = end;
      }
      pending.splice(index, 1);
      changed = true;
    }
    if (!changed) {
      undeclared = unresolvedRecordKeys(pending, candidates, protectedIds);
      break;
    }
  }
  let originalPattern;
  const matches = (pattern, value) => {
    if (!pattern) return false;
    pattern.lastIndex = 0;
    const found = pattern.test(value);
    pattern.lastIndex = 0;
    return found;
  };
  const hasId = (value) => {
    if (matches(pattern, value)) return true;
    // Original persona identities stay literal but still satisfy declarations.
    if (originalPattern === undefined) originalPattern = idPattern([...allIds].filter((id) => protectedIds.has(id)));
    return matches(originalPattern, value);
  };
  const logText = (value) => {
    if (!pattern) return value;
    if (!value.includes('"')) return normalize(value);
    const edits = new Map(), occupied = new Uint8Array(value.length);
    for (const { text, ranges, depth } of logTextViews(value, true)) {
      for (const match of text.matchAll(pattern)) {
        const start = ranges ? ranges.start[match.index] : match.index;
        const end = ranges ? ranges.end[match.index + match[0].length - 1] : match.index + match[0].length;
        // Literal matches keep precedence, including IDs across token edges.
        // A decoded view of the same match supplies its actual quoting depth.
        const previous = edits.get(start);
        if (!(previous?.end === end && previous.id === match[0]) && occupied.subarray(start, end).some(Boolean)) continue;
        occupied.fill(1, start, end);
        let replacement = candidates.get(match[0]) ?? match[0];
        for (let level = 0; level < depth; level++) replacement = JSON.stringify(replacement).slice(1, -1);
        edits.set(start, { start, end, id: match[0], replacement });
      }
    }
    let offset = 0;
    const parts = [];
    // Never rescan generated tokens while applying the original-text edits.
    for (const { start, end, replacement } of [...edits.values()].sort((a, b) => a.start - b.start)) {
      parts.push(value.slice(offset, start), replacement);
      offset = end;
    }
    parts.push(value.slice(offset));
    return parts.join("");
  };
  const findingIds = () => [...allIds, ...candidates.values(), ...[...records.values()].flatMap((record) => typeof record.key === "string" ? [record.key, normalize(record.key)] : [])];
  return { text: normalize, logText, id: (value) => candidates.get(value) ?? value, isId: (value) => allIds.has(value), hasId, findingIds, undeclared };
}

function unresolvedRecordKeys(records, candidates, protectedIds) {
  const address = (record) => `stateIds:${record.path}#${canonicalJSON(record.key)}/${record.field}/*`;
  const owners = new Map();
  for (const record of records) for (const id of record.ids.keys()) {
    if (protectedIds.has(id) || candidates.has(id)) continue;
    if (!owners.has(id)) owners.set(id, record);
  }
  const edges = new Map(), missing = new Map();
  for (const record of records) {
    const dependencies = record.dependencies.filter((id) => !protectedIds.has(id) && !candidates.has(id));
    // Every alternative is blocked after resolution stops. One producer per
    // dependency suffices, without expanding duplicate declarations pairwise.
    edges.set(record, [...new Set(dependencies.map((id) => record.ids.has(id) ? record : owners.get(id)).filter(Boolean))]);
    missing.set(record, dependencies.filter((id) => !owners.has(id)));
  }
  const seen = new Set(), active = new Map(), reasons = new Map();
  // Walk iteratively: long chains and cycles must not consume the call stack.
  for (const root of records) {
    if (seen.has(root)) continue;
    const stack = [{ record: root, next: 0 }];
    seen.add(root); active.set(root, 0);
    while (stack.length) {
      const frame = stack.at(-1), children = edges.get(frame.record);
      if (frame.next < children.length) {
        const child = children[frame.next++];
        if (active.has(child)) {
          if (!reasons.has(frame.record)) {
            const start = active.get(child), length = stack.length - start;
            const cycle = stack.slice(start, start + 8).map(({ record }) => address(record));
            if (length > 8) cycle.push(`[${length - 8} more declarations]`);
            cycle.push(address(child));
            reasons.set(frame.record, `depends on cycle: ${cycle.join(" -> ")}`);
          }
        } else if (!seen.has(child)) {
          seen.add(child); active.set(child, stack.length);
          stack.push({ record: child, next: 0 });
        }
      } else {
        if (!reasons.has(frame.record)) {
          const inherited = children.map((child) => reasons.get(child));
          reasons.set(frame.record, inherited.find((reason) => reason?.startsWith("depends on cycle:")) ?? inherited.find(Boolean) ??
            `unresolved generated ids: ${canonicalJSON(missing.get(frame.record))}`);
        }
        active.delete(frame.record);
        stack.pop();
      }
    }
  }
  return records.map((record) => `${address(record)} (${reasons.get(record)})`);
}

function compare(a, b) {
  a = a?.integer ? BigInt(a.integer) : a;
  b = b?.integer ? BigInt(b.integer) : b;
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const rank = (value) => ["number", "bigint"].includes(typeof value) ? 0 : typeof value === "string" || value?.textBytes instanceof Uint8Array ? 1 : 2;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 1) return Buffer.compare(typeof a === "string" ? Buffer.from(a) : a.textBytes, typeof b === "string" ? Buffer.from(b) : b.textBytes);
  if (a instanceof Uint8Array) return Buffer.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}
