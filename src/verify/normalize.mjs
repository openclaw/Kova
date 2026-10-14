import { isAbsolute, join, matchesGlob } from "node:path";
import { createCatalogueResolver, parseCatalogueCommand } from "../catalogue.mjs";
import { quoteShell } from "../commands.mjs";
import { canonicalJSON } from "./plan.mjs";
import { readCommandResponses, readJSON, recordedDirectory, stateFiles } from "./rows.mjs";
import { createdIds } from "./ids.mjs";

function idPattern(ids) {
  const keys = [...ids].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return keys.length ? new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
}

function recordedOperation(record, planned, expected, resolveEntry) {
  if (!record || typeof record !== "object" || typeof record.command !== "string" || !record.command.trim() || typeof record.stderr !== "string" || typeof record.timedOut !== "boolean" || !Number.isFinite(record.durationMs) || record.durationMs < 0 || !(record.exit === null || Number.isInteger(record.exit)) || !(record.stdout === null || typeof record.stdout === "string")) throw new Error("invalid recorded command metadata");
  // Resolution refusals retain the original planned command and exit 2.
  if (record.command === planned) return;
  const parsed = parseCatalogueCommand(record.command, { standard: true });
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
  if (resolveEntry(canonical, { standard: true })?.id !== expected.id) throw new Error("recorded command does not match its planned operation");
}

// Discover identities across the whole copy before comparing its first checkpoint.
// An id read before its creating response still gets the creator's stable token.
export async function readDeclaredIds(directory, phases, standard, catalogue) {
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
    for await (const file of stateFiles(join(checkpoint, "state"), standard)) {
      if (file.kind !== "sqlite") continue;
      for (const declaration of standard.stateIds.filter((item) => matchesGlob(file.path, item.path) && item.table === file.table)) {
        for (const row of file.rows) {
          // Missing product columns must remain comparable. Without the declared
          // identity/order fields, keep this row's values instead of guessing IDs.
          if (![declaration.column, declaration.recordKey, ...(declaration.order ? [declaration.order] : [])].every((column) => Object.hasOwn(row.values, column))) continue;
          const id = row.values[declaration.column].raw;
          if (typeof id !== "string" || !id) continue;
          const key = row.values[declaration.recordKey].raw;
          const group = canonicalJSON([file.path, declaration.column, key, declaration.order ?? null]);
          if (!records.has(group)) records.set(group, { path: file.path, field: declaration.column, key, ordered: Boolean(declaration.order), ids: new Map() });
          const values = records.get(group).ids;
          if (!values.has(id)) values.set(id, { id, order: declaration.order ? row.values[declaration.order].raw : null, rowid: row.rowid });
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
  for (const record of pending) record.dependencies = pattern ? [...`${record.path}\0${typeof record.key === "string" ? record.key : ""}`.matchAll(pattern)].map(([id]) => id) : [];
  while (pending.length) {
    let changed = false;
    for (let index = 0; index < pending.length;) {
      const record = pending[index];
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
          const key = typeof record.key === "string" ? normalize(record.key) : canonicalJSON(record.key);
          candidates.set(id, `<id:${normalize(record.path)}#${key}/${record.field}/${ordinal}${end - offset > 1 ? `.${i - offset + 1}` : ""}>`);
        }
        offset = end;
      }
      pending.splice(index, 1);
      changed = true;
    }
    if (!changed) throw new Error("cyclic or unresolved generated record keys in stateIds");
  }
  return { text: normalize, id: (value) => candidates.get(value) ?? value };
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a?.integer || b?.integer) {
    const x = BigInt(a?.integer ?? a), y = BigInt(b?.integer ?? b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
