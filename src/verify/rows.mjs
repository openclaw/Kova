import { open, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, matchesGlob } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import JSON5 from "json5";
import { sha256, canonicalJSON } from "./plan.mjs";
import { responseData, transcriptMeasurements, sessionTranscript, sessionIndex, agentDatabase, persistedRowsMeasurements, sessionIndexMeasurements, VerifiedValue } from "./measurements.mjs";

export const absent = Object.freeze({ absent: true });
export const itemKey = (signal, at) => JSON.stringify([signal, at]);
export const valueOf = (item) => item ? item.value : absent;
export const pointerPart = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
export const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const finiteValue = (value) => typeof value === "number" && !Number.isFinite(value) ? { number: String(value) } : value;
const sqlValue = (value) => typeof value === "bigint" ? (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : { integer: String(value) }) : value instanceof Uint8Array ? { sha256: sha256(value) } : finiteValue(value);
const measuredMilliseconds = new RegExp(String.raw`(\b(?:${[
  "durationMs", "elapsedMs", "handlerElapsedMs", "admissionWaitMs",
  "prepareSyncMs", "rowSyncMs", "yieldWaitMs", "prepareThreadCpuMs", "rowThreadCpuMs", "responseThreadCpuMs",
  "completionDelayMs", "mutationQueueWaitMs", "lifecycleQueueWaitMs", "queueWaitMs", "writerExecutionMs",
  "cpuUserMs", "cpuSystemMs", "cpuTotalMs", "eventLoopDelayP99Ms", "eventLoopDelayMaxMs",
  "nativeMs", "serviceMs", "admissionMs", "nodeInventoryMs", "referencePlanningMs", "orphanPlanningMs", "markerScanMs"
].join("|")})["']?\s*[:=]\s*)-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b`, "gi");

export async function readBytes(path, prefixLength) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`recording is not a regular file: ${path}`);
    if (prefixLength !== undefined) {
      const bytes = Buffer.alloc(prefixLength);
      const result = await file.read(bytes, 0, prefixLength, 0);
      return bytes.subarray(0, result.bytesRead);
    }
    return await file.readFile();
  } finally { await file.close(); }
}
export async function readJSON(path) { return JSON.parse((await readBytes(path)).toString("utf8")); }
export async function readCommandResponses(directory, commands, phase) {
  const responses = await readJSON(join(directory, "responses.json"));
  const expected = commands.flatMap((command, index) => command.stdout === null ? [String(index)] : []);
  if (!responses || typeof responses !== "object" || Array.isArray(responses) || Object.keys(responses).length !== expected.length || expected.some((index) => !Object.hasOwn(responses, index))) throw new Error(`${phase}: invalid response checkpoint command indices`);
  return responses;
}
export async function recordedDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) throw new Error(`recording is not a directory: ${path}`);
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
const textLines = (text) => text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];

export async function* checkpointStateFiles(directory, phase, standard, normalize) {
  const selected = phase.checkpoint.filter((signal) => signal.startsWith("state:")).map((signal) => signal.slice(6));
  if (!selected.length) return;
  if (selected.some((path) => !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error(`${phase.id}: invalid recorded state selection`);
  if (!await recordedDirectory(directory)) throw new Error(`${phase.id}: missing state checkpoint directory`);
  const context = normalize ? { normalize, readState: async (path) => {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) return;
    if (!selected.some((root) => path === root || path.startsWith(`${root}/`))) return;
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (!await recordedDirectory(join(directory, ...parts.slice(0, index)))) return;
    }
    try { return await readBytes(join(directory, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } } : undefined;
  yield* stateFiles(directory, standard, "", selected, context);
}

export async function* stateFiles(directory, standard, prefix = "", selected = null, context) {
  let entries;
  try {
    if (!await recordedDirectory(directory)) { if (!prefix) return; throw new Error(`missing state directory: ${directory}`); }
    entries = await readdir(directory, { withFileTypes: true });
  }
  catch (error) { if (error.code === "ENOENT" && !prefix) return; throw error; }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const includes = (root) => path === root || path.startsWith(`${root}/`);
    if (selected && !selected.some((root) => includes(root) || root.startsWith(`${path}/`))) continue;
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`recorded state must not contain symbolic links: ${path}`);
    if (entry.isDirectory()) { yield* stateFiles(file, standard, path, selected, context); continue; }
    if (selected && !selected.some(includes)) continue;
    if (!entry.isFile()) throw new Error(`recorded state is not a regular file: ${path}`);
    if (/-wal$|-shm$/.test(entry.name)) {
      try { if ((await readBytes(file.slice(0, -4), 16)).equals(Buffer.from("SQLite format 3\0"))) continue; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    yield* stateFile(file, path, standard, undefined, context);
  }
}

export async function* stateFile(file, path, standard, format, context) {
  if ((await readBytes(file, 16)).equals(Buffer.from("SQLite format 3\0"))) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      yield { path, kind: "sqlite-file", value: { type: "sqlite" } };
      const shapes = new Map(db.prepare("PRAGMA main.table_list").all().map((table) => [table.name, table]));
      const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND lower(name) NOT GLOB 'sqlite_*' ORDER BY name").all();
      for (const table of tables) {
        const shape = shapes.get(table.name);
        if (!shape) throw new Error(`missing SQLite table metadata: ${table.name}`);
        // Virtual modules can execute native code and may be unavailable here.
        // Their declarations and ordinary persisted backing tables remain data.
        if (shape.type === "virtual") {
          yield { path, kind: "sqlite-schema", table: table.name, value: table.sql };
          continue;
        }
        const columns = db.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all();
        const ordered = new Set((standard.stateIds ?? []).filter((item) => item.table === table.name && matchesGlob(path, item.path) && item.order !== undefined).map((item) => item.order));
        const primary = columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        const rowid = shape.wr ? null : ["rowid", "_rowid_", "oid"].find((name) => !columns.some((c) => c.name.toLowerCase() === name));
        let alias = "__kova_rowid";
        while (columns.some((column) => column.name === alias)) alias += "_";
        const statement = db.prepare(`SELECT ${rowid ? `${quote(rowid)} AS ${quote(alias)}, ` : ""}* FROM ${quote(table.name)}`);
        statement.setReadBigInts(true);
        const rows = [];
        for (const result of statement.iterate()) {
          const identity = rowid ? result[alias] : null;
          if (rowid) delete result[alias];
          const values = Object.create(null);
          for (const column of columns) {
            let value = result[column.name];
            const storage = context && agentDatabase(path) && table.name === "transcript_events" && ["event_json", "event_zstd", "event_utf8_bytes", "navigation_json"].includes(column.name) ? {
              storageType: value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value === "string" ? "text" : typeof value === "bigint" ? "integer" : "real",
              storedBytes: value instanceof Uint8Array ? value.byteLength : typeof value === "string" ? Buffer.byteLength(value) : undefined
            } : {};
            const order = { ...storage, ...(ordered.has(column.name) ? { orderValue: value instanceof Uint8Array ? Buffer.from(value) : value } : {}) };
            // The usage envelope authenticates its separate encoded body. Keep
            // that one buffer for checkpoint normalization, without changing
            // the complete values consumed by persona identity discovery.
            const source = agentDatabase(path) && table.name === "cache_entries" && column.name === "blob" && value instanceof Uint8Array ? { sourceBytes: value } : {};
            const compressed = standard.compressed.find((item) => matchesGlob(path, item.path) && item.table === table.name && item.column === column.name);
            if (compressed && value !== null) {
              if (compressed.codec !== "zstd") throw new Error(`unsupported compressed state: ${path}:${table.name}/${column.name}`);
              // Corrupted product content is still evidence. Keep its bytes
              // comparable when decompression or JSON decoding cannot work.
              if (!(value instanceof Uint8Array) && context) {
                // Source ID discovery still inspects original TEXT as data;
                // comparison must retain the invalid compressed storage type.
                const raw = sqlValue(value);
                values[column.name] = { raw, value: { invalidCompressed: { type: typeof value, value: raw } }, invalidCompressed: true, encoded: true, ...order };
                continue;
              }
              if (value instanceof Uint8Array) {
                try {
                  const native = context && agentDatabase(path) && table.name === "transcript_events" && column.name === "event_zstd";
                  const limit = 4 * 1024 * 1024;
                  const stored = result.event_utf8_bytes;
                  const size = typeof stored === "bigint" && stored >= 1n && stored <= BigInt(limit) ? Number(stored) : stored;
                  if (native && (!value.byteLength || value.byteLength > limit || !Number.isSafeInteger(size) || size < 1 || size > limit)) throw new Error("invalid compressed transcript bounds");
                  const bytes = zstdDecompressSync(value, native ? { maxOutputLength: size } : undefined);
                  if (native && bytes.byteLength !== size) throw new Error("compressed transcript length mismatch");
                  value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
                } catch { /* Invalid bounds, encoding and bytes remain the original BLOB hash. */ }
              }
            }
            if (typeof value === "string") {
              try { values[column.name] = { raw: value, value: JSON.parse(value), ...order, ...source }; continue; }
              catch { /* Keep text that is not JSON, including damaged product data. */ }
            }
            const scalar = sqlValue(value);
            values[column.name] = { raw: scalar, value: scalar, encoded: scalar !== null && typeof scalar === "object", ...order, ...source };
          }
          rows.push({ rowid: sqlValue(identity), values });
        }
        const decoded = { path, kind: "sqlite", table: table.name, primary, rows };
        if (context) decoded.rows = await persistedRowsMeasurements(decoded, { ...context, db, standard });
        yield decoded;
      }
    } finally { db.close(); }
    return;
  }
  const bytes = await readBytes(file);
  // Persona backups retain structured values after their original suffix moves.
  // This source-only hint does not alter checkpoint item formats or paths.
  if (format === "auto") {
    try { yield { path, kind: "json", value: JSON5.parse(bytes.toString("utf8")) }; return; }
    catch { format = "jsonl"; }
  }
  if (format === "jsonl" || /\.jsonl$/i.test(path) || sessionTranscript(path)) {
    const value = [], malformed = new Set(), binary = new Map();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (let start = 0; start <= bytes.length;) {
      const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline;
      const line = bytes.subarray(start, newline >= 0 && bytes[end - 1] === 13 ? end - 1 : end);
      const index = value.length;
      let text;
      try { text = decoder.decode(line); }
      catch { binary.set(index, sha256(line)); text = line.toString("utf8"); }
      if (!start) text = text.replace(/^\uFEFF/, "");
      if (!text.trim()) value.push(undefined);
      else try { value.push(JSON.parse(text)); }
      catch { malformed.add(index); value.push(binary.has(index) ? undefined : text); }
      if (newline < 0) break;
      start = newline + 1;
    }
    yield { path, kind: "jsonl", value, malformed, binary }; return;
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { yield { path, kind: "binary", value: sha256(bytes) }; return; }
  if (text.includes("\0")) { yield { path, kind: "binary", value: sha256(bytes) }; return; }
  try {
    if (/\.json5?$/i.test(path) || sessionIndex(path)) { yield { path, kind: "json", value: JSON5.parse(text) }; return; }
  } catch { /* Invalid product JSON is compared as text, not discarded. */ }
  yield { path, kind: "text", value: textLines(text) };
}

export function normalizeText(text, normalize = (value) => value) {
  let structured = false;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") {
      const visit = (item) => typeof item === "string" ? normalizeText(item, normalize)
        : Array.isArray(item) ? item.map(visit)
          : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, child]) => [normalize(key), visit(child)])) : item;
      text = JSON.stringify(visit(value));
      structured = true;
    }
  } catch { /* Plain and damaged text remains comparable. */ }
  if (!structured) text = normalize(text);
  if (/memory pressure:.*\breason=rss_threshold\b/.test(text)) text = text
    .replace(/(\b(?:used|usedBytes)["']?\s*[:=]\s*)\d+(?:\.\d+)?(?:\s*(?:[KMGT]i?B|B))?\b/gi, "$1<rss>")
    .replace(/(\bthresholdRatio=)\d+(?:\.\d+)?%/g, "$1<rss>");
  return text
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?\b/g, "<time>")
    .replace(/\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|µs|us|ns|seconds?|secs?|s|minutes?|mins?)\b/g, "<duration>")
    // OpenClaw diagnostics also print bare numeric measurements in JSON and
    // key=value logs. Preserve phase names, outcomes, counts and configuration.
    .replace(measuredMilliseconds, "$1<duration>")
    .replace(/(\bphaseDurationsMs["']?\s*[:=]\s*)\{([^{}]*)\}/g, (_, prefix, fields) => `${prefix}{${fields.replace(/(:\s*)-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?=\s*[,}]|\s*$)/gi, "$1<duration>")}}`)
    .replace(/(\b(?:rss|rssBytes)["']?\s*[:=]\s*)\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:\s*(?:[KMGT]i?B|B))?\b/gi, "$1<rss>")
    .replace(/(\b(?:cpu|cpuCoreRatio|eventLoopUtilization|util)["']?\s*[:=]\s*)\d+(?:\.\d+)?(?:e[+-]?\d+)?\b%?/gi, "$1<cpu>")
    .replace(/\(node:\d+\)/g, "(node:<pid>)")
    .replace(/(\b(?:pid|ppid|processId)["']?\s*[:= ]\s*)\d+\b/gi, "$1<pid>")
    .replace(/(\b(?:port|gatewayPort)["']?\s*[:= ]\s*)\d+\b/gi, "$1<port>")
    .replace(/((?:https?|wss?):\/\/(?:\[[^\]\s]+\]|[^\s/:"']+):)\d+\b/g, "$1<port>");
}

function warning(line) {
  try {
    const data = JSON.parse(line);
    return /^(?:warn|warning|error|fatal)$/i.test(data.level ?? data._meta?.logLevelName ?? "");
  } catch { return /(?:^|\s|\[)(?:WARN(?:ING)?|ERROR|FATAL)(?:\]|\s|:)/i.test(line) || /^\(node:\d+\)\s+(?:\[[^\]]+\]\s+)?[A-Za-z]*Warning:/i.test(line); }
}

export function rowBuilder(normalize = (value) => value) {
  const items = new Map();
  function add(signal, segments, value, { failure = false, dynamic = [], summary } = {}) {
    const at = segments.join("/");
    const key = itemKey(signal, at);
    if (items.has(key)) throw new Error(`normalization produced duplicate item: ${signal}/${at}`);
    items.set(key, { signal, at, value: finiteValue(value), failure, segments, dynamic, summary });
  }
  function nodes(signal, value, segments, dynamic = [], verified = false) {
    if (value instanceof VerifiedValue) return nodes(signal, value.value, segments, dynamic, true);
    if (value && typeof value === "object") {
      const array = Array.isArray(value);
      const keys = Object.keys(value).map((key) => [key, array ? key : normalize(key)]);
      if (new Set(keys.map(([, key]) => key)).size !== keys.length) throw new Error("normalization produced duplicate JSON keys");
      const container = array ? { type: "array", length: value.length } : { type: "object", keys: keys.map(([, key]) => key).sort() };
      add(signal, segments, verified ? { ...container, verifiedDerived: true } : container, { dynamic });
      for (const [original, key] of keys) nodes(signal, value[original], [...segments, pointerPart(key)], array ? dynamic : [...dynamic, segments.length]);
    } else {
      const leaf = typeof value === "string" && !verified ? normalize(value) : finiteValue(value);
      add(signal, segments, verified ? { verifiedDerived: leaf } : leaf, { dynamic });
    }
  }
  return { items, add, nodes };
}

export async function checkpointRows(directory, phase, standard, normalization, commandCount = phase.commands.length, commandEntries = []) {
  const { text: normalize, id: normalizeId } = normalization;
  const b = rowBuilder(normalize);
  const exists = await recordedDirectory(directory);
  b.add("checkpoint", [], exists);
  if (!exists) return { items: b.items, recorded: false, exitTwo: false };
  const commands = await readJSON(join(directory, "commands.json"));
  if (!Array.isArray(commands) || commands.length !== commandCount) throw new Error(`${phase.id}: invalid recorded command count`);
  for (const [index, command] of commands.entries()) {
    if (!(command.exit === null || Number.isInteger(command.exit)) || !(command.stdout === null || typeof command.stdout === "string")) throw new Error(`${phase.id}: invalid recorded command`);
    b.add("commands", [String(index), "exit"], command.exit, { failure: command.exit !== 0 || command.timedOut === true });
    const lines = new Map();
    for (const line of textLines(command.stdout ?? "")) {
      const text = normalizeText(line, normalize);
      lines.set(text, (lines.get(text) ?? 0) + 1);
    }
    for (const [line, count] of lines) b.add("commands", [String(index), "stdout", line], count);
  }
  for (const signal of new Set(phase.checkpoint)) {
    if (signal === "responses") {
      const responses = await readCommandResponses(directory, commands, phase.id);
      for (const [index, value] of Object.entries(responses)) {
        const entry = commandEntries[Number(index) % phase.commands.length];
        b.nodes("responses", responseData(value, entry), [index]);
      }
    } else if (signal === "timing") {
      const timing = await readJSON(join(directory, "timing.json"));
      if (!Array.isArray(timing) || timing.length !== commands.length || timing.some((item) => typeof item.reachedBound !== "boolean")) throw new Error(`${phase.id}: invalid timing checkpoint`);
      timing.forEach((item, index) => b.add("timing", [String(index)], item.reachedBound, { failure: item.reachedBound }));
    } else if (signal === "logs") {
      const lines = new Map();
      for (const raw of textLines((await readBytes(join(directory, "logs.txt"))).toString("utf8"))) {
        const line = normalizeText(raw, normalize);
        const previous = lines.get(line);
        lines.set(line, { count: (previous?.count ?? 0) + 1, failure: previous?.failure || warning(raw) });
      }
      for (const [line, { count, failure }] of lines) b.add("logs", [line], count, { failure });
    } else if (signal === "doctor") {
      const outputs = await readJSON(join(directory, "doctor.json"));
      if (!Array.isArray(outputs) || outputs.length !== commands.length) throw new Error(`${phase.id}: invalid Doctor checkpoint`);
      const findings = new Map();
      for (const [index, output] of outputs.entries()) {
        const entry = commandEntries[index % phase.commands.length]?.id;
        if (!["doctor", "doctor-repair"].includes(entry)) continue;
        let values;
        if (typeof output === "string") values = output.split(/\r?\n/).filter(Boolean).map((finding) => ({ finding }));
        else if (Array.isArray(output?.findings) && (output.warnings === undefined || Array.isArray(output.warnings))) values = [...output.findings, ...(output.warnings ?? [])].map((finding) => ({ finding }));
        else if (Array.isArray(output?.targets) && output.targets.every((target) => typeof target?.agentId === "string" && Array.isArray(target.issues))) values = output.targets.flatMap((target) => target.issues.map((finding) => ({ finding, scope: [target.agentId, finding?.sessionKey ?? null] })));
        else if (entry === "doctor-repair" && output?.schemaVersion === "kova.doctorRepair.v1" && Array.isArray(output.errors)) values = output.errors.map((finding) => ({ finding }));
        // Unknown product output is evidence, not malformed recording metadata.
        if (!values || values.some(({ finding }) => typeof finding !== "string" && (!finding || typeof finding !== "object" || Array.isArray(finding)))) {
          b.nodes("doctor", output, [String(index), "output"]);
          continue;
        }
        for (const { finding, scope } of values) {
          const text = normalizeText(typeof finding === "string" ? finding : typeof finding.message === "string" ? finding.message : canonicalJSON(finding), normalize);
          // checkId identifies a check, which can report several distinct findings.
          const code = typeof finding === "object" && typeof finding.code === "string" && finding.code;
          const at = code ? normalize(code) : text;
          findings.set(scope ? canonicalJSON([...scope.map((value) => typeof value === "string" ? normalize(value) : value), at]) : at, text);
        }
      }
      for (const [at, summary] of findings) b.add("doctor", [at], true, { failure: true, summary });
    } else if (signal === "screen") b.add("screen", [], sha256(await readBytes(join(directory, "screen.png"))));
  }
  if (phase.checkpoint.some((signal) => signal.startsWith("state:"))) {
    for await (const file of checkpointStateFiles(join(directory, "state"), phase, standard, normalize)) {
      const path = file.path.split("/").map((part) => pointerPart(normalize(part)));
      const dynamic = path.map((_, index) => index);
      if (file.kind === "sqlite") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, { type: "table" }, { dynamic });
        const idColumns = new Set([...file.primary, ...standard.stateIds.filter((entry) => entry.table === file.table && matchesGlob(file.path, entry.path)).map((entry) => entry.column)]);
        for (const row of file.rows) {
          const keys = file.primary.map((key) => row.values[key]).map((cell) => cell.value instanceof VerifiedValue ? cell.value.value : typeof cell.raw === "string" ? normalize(cell.raw) : cell.raw);
          const primaryKey = keys.length === 1 ? keys[0] : keys;
          // SQLite permits multiple NULL primary keys in rowid tables. Preserve
          // SQL storage types and use rowid only to disambiguate those NULL keys.
          const nullable = keys.includes(null);
          if (nullable && row.rowid === null) throw new Error(`nullable state key needs rowid: ${file.path}:${file.table}`);
          const key = canonicalJSON(nullable ? { key: primaryKey, rowid: row.rowid } : keys.length ? primaryKey : row.rowid);
          if (!file.primary.length && row.rowid === null) throw new Error(`state table has no addressable key: ${file.path}:${file.table}`);
          const segments = [...path, pointerPart(key)];
          const dynamicKeys = [...dynamic, path.length];
          b.add("state", segments, true, { dynamic: dynamicKeys });
          for (const [column, value] of Object.entries(row.values)) {
            const identity = typeof value.raw === "string" ? normalizeId(value.raw) : value.raw;
            const declared = identity !== value.raw || typeof value.raw === "string" && (idColumns.has(column) || normalization.isId?.(value.raw));
            const at = [...segments, pointerPart(column)];
            // Formatted numeric/BLOB markers and already-normalized tokens are
            // not product JSON strings and must not be normalized a second time.
            if (value.invalidCompressed) b.add("state", at, value.value, { dynamic: dynamicKeys });
            else if (value.value instanceof VerifiedValue) b.nodes("state", value.value, at, dynamicKeys);
            else if (declared || value.encoded) b.add("state", at, declared ? normalize(value.raw) : value.value, { dynamic: dynamicKeys });
            else b.nodes("state", value.value, at, dynamicKeys);
          }
        }
      } else if (file.kind === "sqlite-schema") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, normalize(file.value), { dynamic });
      } else if (file.kind === "json") b.nodes("state", sessionIndex(file.path) ? sessionIndexMeasurements(file.value) : file.value, path, dynamic);
      else if (file.kind === "jsonl") {
        b.add("state", path, { type: "jsonl" }, { dynamic });
        file.value.forEach((value, index) => {
          const at = [...path, String(index)];
          if (file.binary.has(index)) b.add("state", at, { invalidJSONLBytes: file.binary.get(index) }, { dynamic });
          else if (value === undefined) return;
          else if (file.malformed.has(index)) b.add("state", at, { invalidJSONL: normalizeText(value, normalize) }, { dynamic });
          else b.nodes("state", sessionTranscript(file.path) ? transcriptMeasurements(value) : value, at, dynamic);
        });
      } else if (file.kind === "text") {
        b.add("state", path, { type: "text" }, { dynamic });
        file.value.forEach((line, index) => b.add("state", [...path, String(index)], normalizeText(line, normalize), { dynamic }));
      }
      else b.add("state", path, file.value, { dynamic });
    }
  }
  return { items: b.items, recorded: true, exitTwo: commands.some((command) => command.exit === 2) };
}
