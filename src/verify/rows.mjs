import { open, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, matchesGlob } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import JSON5 from "json5";
import { sha256, canonicalJSON } from "./plan.mjs";
import { responseData, transcriptMeasurements, sessionTranscript, sessionIndex, agentDatabase, persistedRowsMeasurements, sessionIndexMeasurements, runtimeTranscriptMessages, VerifiedValue, SkillsPromptCount, MeasuredText, DuplicateValues, TranscriptInteger } from "./measurements.mjs";
import { projectBuildIdResponses } from "./build-ids.mjs";
import { runtimeEventFile, runtimeEventContent, runtimeEventSignature, runtimeEventObservation, runtimeEventEvidence, createCompletionObservations, RuntimeOpaqueValue } from "./runtime-events.mjs";

export const absent = Object.freeze({ absent: true });
export const itemKey = (signal, at) => JSON.stringify([signal, at]);
export const valueOf = (item) => item ? item.value : absent;
export const pointerPart = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");
export const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const finiteValue = (value) => typeof value === "number" && !Number.isFinite(value) ? { number: String(value) } : value;
const sqlValue = (value) => typeof value === "bigint" ? (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : { integer: String(value) }) : value instanceof Uint8Array ? { sha256: sha256(value) } : finiteValue(value);
const measuredMilliseconds = new RegExp(String.raw`(\b(?:${[
  "durationMs", "elapsedMs", "totalMs", "handlerElapsedMs", "admissionWaitMs",
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
async function* fileChunks(path, signal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`recording is not a regular file: ${path}`);
    for (;;) {
      signal?.throwIfAborted();
      const bytes = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      yield bytes.subarray(0, bytesRead);
    }
  } finally { await file.close(); }
}

async function* fileLines(path, signal) {
  let pending = [], size = 0;
  for await (const bytes of fileChunks(path, signal)) {
    let start = 0;
    for (;;) {
      const end = bytes.indexOf(10, start);
      if (end < 0) break;
      const part = bytes.subarray(start, end);
      let line = pending.length ? Buffer.concat([...pending, part], size + part.length) : part;
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      yield { bytes: line, terminated: true };
      pending = []; size = 0; start = end + 1;
    }
    if (start < bytes.length) { const part = bytes.subarray(start); pending.push(part); size += part.length; }
  }
  yield { bytes: Buffer.concat(pending, size), terminated: false };
}

const recordedText = (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
export const parseRecordedJSON = (bytes) => JSON.parse(recordedText(bytes));
export async function readJSON(path) { return parseRecordedJSON(await readBytes(path)); }

// Check text before identity discovery: no part of a damaged phase may supply
// normalization identities or comparison rows. Keep only diagnostics, not a
// second in-memory copy of every recording.
export async function checkpointDamage(directory, phase, { signal } = {}) {
  if (!await recordedDirectory(directory)) return [];
  const files = new Set(["commands.json", ...phase.checkpoint.flatMap((kind) =>
    kind === "logs" ? ["logs.txt"] : ["responses", "timing", "doctor"].includes(kind) ? [`${kind}.json`] : [])]);
  const damaged = [];
  for (const file of files) {
    signal?.throwIfAborted();
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      for await (const bytes of fileChunks(join(directory, file), signal)) decoder.decode(bytes, { stream: true });
      decoder.decode();
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
      damaged.push({ file, reason: error.message });
    }
  }
  return damaged;
}
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

// Decode maximal intact spans without replacing damaged bytes or joining their
// neighbours. The platform decoder validates each non-ASCII code point.
function sourceTextFragments(bytes, decoder) {
  const width = decoder.encoding === "utf-8" ? 1 : 2;
  const codeAt = (offset) => width === 1 ? bytes[offset] : decoder.encoding === "utf-16be" ? bytes[offset] * 256 + bytes[offset + 1] : bytes[offset] + bytes[offset + 1] * 256;
  const fragments = [];
  let start = 0, damaged = false;
  for (let offset = 0; offset < bytes.length;) {
    const code = codeAt(offset);
    if (width === 1 ? code < 0x80 : code < 0xd800 || code > 0xdfff) { offset += width; damaged = false; continue; }
    const length = width === 2 ? code >= 0xd800 && code <= 0xdbff ? 4 : 2
      : code >= 0xf0 && code <= 0xf4 ? 4 : code >= 0xe0 && code <= 0xef ? 3 : code >= 0xc2 && code <= 0xdf ? 2 : 1;
    try {
      decoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      damaged = false;
    } catch {
      if (!damaged) fragments.push(decoder.decode(bytes.subarray(start, offset)));
      offset += width;
      start = offset;
      damaged = true;
    }
  }
  fragments.push(decoder.decode(bytes.subarray(start)));
  return fragments;
}

function sourceStringFragments(bytes, decoder, parse) {
  try { return [parse(decoder.decode(bytes))]; }
  catch { /* Damaged encoding may leave independently intact string fragments. */ }
  const fragments = sourceTextFragments(bytes, decoder);
  if (fragments.length === 1) return [];
  const original = parse(fragments.join("\uFFFD"));
  if (typeof original !== "string") return [];
  let ordinal = 0, marker = "_kovaInvalid0!";
  while (original.includes(marker)) marker = `_kovaInvalid${++ordinal}!`;
  // The leading underscore also survives a JSON5 arbitrary-character escape.
  // Markers contain no quote or backslash and are removed before ID discovery.
  const restored = parse(fragments.join(marker));
  const recovered = restored.split(marker);
  return recovered.length === fragments.length ? recovered : [];
}

// Read source tokens before object decoding can discard repeated members.
// Damaged documents can also retain intact escaped strings and fragments.
// Replacement characters introduced by decoding are never source evidence.
function intactSourceStrings(bytes, encoding = "utf-8", json5 = false) {
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  const width = decoder.encoding === "utf-8" ? 1 : 2;
  const codeAt = (offset) => width === 1 ? bytes[offset] : decoder.encoding === "utf-16be" ? bytes[offset] * 256 + bytes[offset + 1] : bytes[offset] + bytes[offset + 1] * 256;
  const strings = sourceTextFragments(bytes, decoder);
  const keyParts = [];
  let keyStart = 0;
  for (let offset = 0; offset + width <= bytes.length; offset += width) {
    const quote = codeAt(offset);
    if (json5 && quote === 47 && codeAt(offset + width) === 47) {
      keyParts.push(bytes.subarray(keyStart, offset));
      while (offset + width <= bytes.length) {
        if ([10, 13, 0x2028, 0x2029].includes(codeAt(offset))) break;
        if (width === 1 && bytes[offset] === 0xe2 && bytes[offset + 1] === 0x80 && [0xa8, 0xa9].includes(bytes[offset + 2])) { offset += 2; break; }
        offset += width;
      }
      keyStart = offset + width;
      continue;
    }
    if (json5 && quote === 47 && codeAt(offset + width) === 42) {
      keyParts.push(bytes.subarray(keyStart, offset));
      offset += 2 * width;
      while (offset + width <= bytes.length && !(codeAt(offset) === 42 && codeAt(offset + width) === 47)) offset += width;
      offset += width;
      keyStart = offset + width;
      continue;
    }
    if (json5 && [58, 44, 123, 125, 91, 93].includes(quote)) {
      if (quote === 58) {
        try {
          // Ignore damaged comment bytes, but preserve their separator so a
          // comment cannot join two identifier fragments into a new key.
          const token = [...keyParts, bytes.subarray(keyStart, offset)].map((part) => decoder.decode(part)).join(" ");
          const keys = Object.keys(JSON5.parse(`{${token}:null}`));
          if (keys.length === 1) strings.push(keys[0]);
        } catch { /* Only a valid unquoted JSON5 key protects an identity. */ }
      }
      keyStart = offset + width;
      keyParts.length = 0;
      continue;
    }
    if (quote !== 34 && !(json5 && quote === 39)) continue;
    const start = offset;
    for (offset += width; offset + width <= bytes.length; offset += width) {
      if (codeAt(offset) === 92) { offset += width; continue; }
      if (codeAt(offset) !== quote) continue;
      try {
        for (const text of sourceStringFragments(bytes.subarray(start, offset + width), decoder, json5 ? JSON5.parse : JSON.parse)) strings.push(text);
      } catch { /* Malformed escape syntax cannot supply decoded identities. */ }
      break;
    }
    keyStart = offset + width;
    keyParts.length = 0;
  }
  return strings;
}

export async function* checkpointStateFiles(directory, phase, standard, normalize, auditRows) {
  const selected = phase.checkpoint.filter((signal) => signal.startsWith("state:")).map((signal) => signal.slice(6));
  if (!selected.length) return;
  if (selected.some((path) => !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error(`${phase.id}: invalid recorded state selection`);
  if (!await recordedDirectory(directory)) throw new Error(`${phase.id}: missing state checkpoint directory`);
  const context = normalize ? { normalize, auditRows, readState: async (path) => {
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

// JSON.parse validates the grammar and supplies ordinary JSON semantics. This
// bounded second walk retains repeated members which SQLite consumers can read
// before JavaScript selects the last one. String/number tokens still use the
// native JSON parser, including escape and surrogate handling.
function transcriptJSON(text, compared) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") return parsed;
  let offset = 0, repeated = false, precise = false;
  const token = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const space = () => { while (/[ \t\r\n]/.test(text[offset] ?? "x")) offset++; };
  const read = () => {
    space();
    const start = text[offset++];
    if (start === "{") {
      const members = new Map();
      space();
      while (text[offset] !== "}") {
        const key = read(); space(); offset++;
        const value = read();
        if (members.has(key)) { members.get(key).push(value); repeated = true; }
        else members.set(key, [value]);
        space(); if (text[offset] !== ",") break; offset++;
      }
      offset++;
      return Object.fromEntries([...members].map(([key, values]) => [key, values.length === 1 ? values[0] : compared ? new DuplicateValues(values) : values]));
    }
    if (start === "[") {
      const values = []; space();
      while (text[offset] !== "]") { values.push(read()); space(); if (text[offset] !== ",") break; offset++; }
      offset++; return values;
    }
    token.lastIndex = --offset;
    const match = token.exec(text);
    if (!match) throw new Error("invalid recorded JSON token");
    offset = token.lastIndex;
    const value = JSON.parse(match[0]);
    if (compared && typeof value === "number" && !Number.isSafeInteger(value) && /^-?\d+$/.test(match[0])) {
      const integer = BigInt(match[0]);
      if (integer >= -(1n << 63n) && integer < (1n << 63n)) { precise = true; return new TranscriptInteger(String(integer)); }
    }
    return value;
  };
  const lossless = read();
  return repeated || precise ? lossless : parsed;
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
      const decoder = new TextDecoder(db.prepare("PRAGMA encoding").get().encoding, { fatal: true, ignoreBOM: true });
      yield { path, kind: "sqlite-file", value: { type: "sqlite" } };
      const shapes = new Map(db.prepare("PRAGMA main.table_list").all().map((table) => [table.name, table]));
      const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND lower(name) NOT GLOB 'sqlite_*' ORDER BY name").all();
      const transcriptFTS = agentDatabase(path) && shapes.get("session_transcript_fts")?.type === "virtual"
        && /\bUSING\s+fts5\s*\(/i.test(tables.find((table) => table.name === "session_transcript_fts")?.sql ?? "");
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
        const companion = table.name === "session_transcript_fts_rows" && columns.length === 3
          && columns.some((column) => ["id", "fts_rowid"].includes(column.name) && column.pk === 1 && column.type.toUpperCase() === "INTEGER")
          && ["session_id", "message_id"].every((name) => columns.some((column) => column.name === name));
        const nativeShadow = shape.type === "shadow" && ["data", "idx", "content", "docsize", "config"].some(suffix => table.name === `session_transcript_fts_${suffix}`);
        const projectionColumns = {
          session_transcript_active_events: { session_id: ["TEXT", 1], active_position: ["INTEGER", 2], event_seq: ["INTEGER", 0], message_position: ["INTEGER", 0], context_eligible: ["INTEGER", 0] },
          session_transcript_index_state: { session_id: ["TEXT", 1], indexed_seq: ["INTEGER", 0], leaf_event_id: ["TEXT", 0], needs_rebuild: ["INTEGER", 0], active_event_count: ["INTEGER", 0], active_message_count: ["INTEGER", 0], updated_at: ["INTEGER", 0] }
        }[table.name];
        const nativeProjection = agentDatabase(path) && shape.strict === 1 && projectionColumns
          && columns.length === Object.keys(projectionColumns).length
          && columns.every(column => projectionColumns[column.name]?.[0] === column.type.toUpperCase() && projectionColumns[column.name][1] === column.pk)
          && shapes.get("session_windows")?.type === "table" && shapes.get("transcript_events")?.type === "table";
        if (context && (transcriptFTS && (nativeShadow || companion) || nativeProjection)) {
          const count = db.prepare(`SELECT count(*) AS count FROM ${quote(table.name)}`);
          count.setReadBigInts(true);
          yield { path, kind: "derived-sqlite", table: table.name, value: { type: "table", rows: sqlValue(count.get().count) },
            reason: nativeProjection ? "rebuildable native transcript navigation/search projection; all physical rows excluded" : "derived transcript FTS storage; all physical rows excluded" };
          continue;
        }
        const ordered = new Set((standard.stateIds ?? []).filter((item) => item.table === table.name && matchesGlob(path, item.path) && item.order !== undefined).map((item) => item.order));
        const primary = columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        const rowid = shape.wr ? null : ["rowid", "_rowid_", "oid"].find((name) => !columns.some((c) => c.name.toLowerCase() === name));
        let alias = "__kova_rowid";
        while (columns.some((column) => column.name === alias || column.name.startsWith(`${alias}_`))) alias += "_";
        // SQLite's string binding replaces invalid encoding before JavaScript
        // can inspect it. Read TEXT as bytes and keep its storage type separate.
        const selected = columns.flatMap((column, index) => [
          `CASE WHEN typeof(${quote(column.name)}) = 'text' THEN CAST(${quote(column.name)} AS BLOB) ELSE ${quote(column.name)} END AS ${quote(column.name)}`,
          `typeof(${quote(column.name)}) AS ${quote(`${alias}_${index}`)}`
        ]);
        const statement = db.prepare(`SELECT ${rowid ? `${quote(rowid)} AS ${quote(alias)}, ` : ""}${selected.join(", ")} FROM ${quote(table.name)}`);
        statement.setReadBigInts(true);
        function* readRows() {
          for (const result of statement.iterate()) {
            const identity = rowid ? result[alias] : null;
            if (rowid) delete result[alias];
            const values = Object.create(null);
            for (const [index, column] of columns.entries()) {
              let value = result[column.name];
              const storageType = result[`${alias}_${index}`];
              const textBytes = storageType === "text" ? value : null;
              const ordering = ordered.has(column.name) ? { orderValue: textBytes ? { textBytes: Buffer.from(textBytes) } : value instanceof Uint8Array ? Buffer.from(value) : value } : {};
              if (textBytes) {
                try { value = decoder.decode(textBytes); }
                catch {
                  const invalid = { invalidText: { sha256: sha256(textBytes) } };
                  const source = context ? {} : { sourceStrings: intactSourceStrings(textBytes, decoder.encoding) };
                  values[column.name] = { raw: invalid, value: invalid, encoded: true, ...ordering, ...source };
                  continue;
                }
              }
              const storage = context && agentDatabase(path) && table.name === "transcript_events" && ["event_json", "event_zstd", "event_utf8_bytes", "navigation_json"].includes(column.name) ? {
                storageType,
                storedBytes: value instanceof Uint8Array ? value.byteLength : typeof value === "string" ? Buffer.byteLength(value) : undefined
              } : {};
              const order = { ...storage, ...ordering };
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
                    try { value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
                    catch { if (!context) source.sourceStrings = intactSourceStrings(bytes); }
                  } catch { /* Invalid bounds, encoding and bytes remain the original BLOB hash. */ }
                }
              }
              if (typeof value === "string") {
                try {
                  const native = agentDatabase(path) && table.name === "transcript_events" && ["event_json", "event_zstd", "navigation_json"].includes(column.name);
                  values[column.name] = { raw: value, value: native ? transcriptJSON(value, Boolean(context)) : JSON.parse(value), ...order, ...source }; continue;
                }
                catch { /* Keep text that is not JSON, including damaged product data. */ }
              }
              const scalar = sqlValue(value);
              values[column.name] = { raw: scalar, value: scalar, encoded: scalar !== null && typeof scalar === "object", ...order, ...source };
            }
            yield { rowid: sqlValue(identity), values };
          }
        }
        const decoded = { path, kind: "sqlite", table: table.name, primary, rows: readRows };
        yield { ...decoded, evidence: context && runtimeEventFile(decoded) ? runtimeEventEvidence(decoded, sessions => runtimeTranscriptMessages(db, path, standard, sessions)) : undefined,
          rows: () => context ? persistedRowsMeasurements(decoded, { ...context, db, standard }) : readRows() };
      }
    } finally { db.close(); }
    return;
  }
  // Persona backups retain structured values after their original suffix moves.
  // This source-only hint does not alter checkpoint item formats or paths.
  if (format === "auto") {
    const bytes = await readBytes(file);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { yield { path, kind: "binary", value: sha256(bytes), sourceStrings: intactSourceStrings(bytes, "utf-8", true) }; return; }
    try {
      yield { path, kind: "json", value: JSON5.parse(text), sourceStrings: context || !bytes.includes(92) ? [] : intactSourceStrings(bytes, "utf-8", true) };
      return;
    }
    catch { format = "jsonl"; }
  }
  if (format === "jsonl" || /\.jsonl$/i.test(path) || sessionTranscript(path)) {
    async function* records() {
      let index = 0;
      for await (const { bytes } of fileLines(file)) {
        let text;
        try { text = recordedText(bytes); }
        catch {
          yield { index: index++, binary: sha256(bytes), sourceStrings: context ? [] : intactSourceStrings(bytes) };
          continue;
        }
        if (!index) text = text.replace(/^\uFEFF/, "");
        if (!text.trim()) { yield { index: index++ }; continue; }
        let value, malformed = false;
        try { value = JSON.parse(text); }
        catch { value = text; malformed = true; }
        yield { index: index++, value, malformed, sourceStrings: context || !bytes.includes(92) ? [] : intactSourceStrings(bytes) };
      }
    }
    yield { path, kind: "jsonl", records: records() }; return;
  }
  const bytes = await readBytes(file);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { yield { path, kind: "binary", value: sha256(bytes) }; return; }
  if (text.includes("\0")) { yield { path, kind: "binary", value: sha256(bytes) }; return; }
  try {
    if (/\.json5?$/i.test(path) || sessionIndex(path)) { yield { path, kind: "json", value: JSON5.parse(text) }; return; }
  } catch { /* Invalid product JSON is compared as text, not discarded. */ }
  yield { path, kind: "text", value: textLines(text) };
}

function nativeLog(text, subsystem, parsed) {
  try {
    const value = parsed ?? JSON.parse(text);
    const record = item => item !== null && typeof item === "object" && !Array.isArray(item);
    if (!record(value)) return null;
    const has = (item, key) => Object.hasOwn(item, key);
    const severity = item => typeof item === "string" ? item.toLowerCase().replace(/^warning$/, "warn") : null;
    const binding = JSON.stringify({ subsystem });
    let metadata, message, level;
    if (has(value, "subsystem")) {
      // JSON console writes these root fields after caller metadata. Numeric
      // file arguments cannot redirect ownership to an unrelated object.
      if (value.subsystem !== subsystem || ["0", "1", "2", "_meta"].some(key => has(value, key))) return null;
      metadata = value; message = value.message; level = severity(value.level);
    } else {
      // getChildLogger serializes the fixed binding as both prefix and name.
      // The file sink keeps metadata/message in their original argument slots.
      if (value[0] !== binding || !record(value._meta) || has(value, "level")
        || has(value._meta, "name") && value._meta.name !== binding) return null;
      level = severity(value._meta.logLevelName);
      if (record(value[1])) { metadata = value[1]; message = value[2]; }
      else { if (has(value, "2")) return null; message = value[1]; }
      if (has(value, "message") && value.message !== message) return null;
      if (has(value._meta, "logLevelId") && value._meta.logLevelId !== ({ warn: 4, error: 5, fatal: 6 })[level]) return null;
    }
    if (typeof message !== "string" || !["warn", "error", "fatal"].includes(level)) return null;
    if (metadata && (has(metadata, "subsystem") && metadata.subsystem !== subsystem
      || has(metadata, "message") && metadata.message !== message
      || has(metadata, "level") && severity(metadata.level) !== level)) return null;
    return { value, metadata, message, level };
  } catch {
    const timed = text.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\s+/, "");
    const severity = /^(?:\[(warn|warning|error|fatal)\]|(warn|warning|error|fatal))\s+/i.exec(timed);
    const body = severity ? timed.slice(severity[0].length) : timed;
    const prefix = `[${subsystem}] `;
    return body.startsWith(prefix) ? { message: body.slice(prefix.length), level: severity ? (severity[1] ?? severity[2]).toLowerCase().replace(/^warning$/, "warn") : undefined } : null;
  }
}

// These exact responder notifications describe shared-host name negotiation,
// not advertisement failure or a product outcome. Keep unknown messages.
function environmentLog(text) {
  const log = nativeLog(text, "plugins");
  if (!log) return false;
  if (log.value) {
    const level = log.value.level ?? log.value._meta?.logLevelName;
    if (typeof level !== "string" || !/^(?:warn|warning)$/i.test(level)
      || Object.hasOwn(log.value, "level") && !/^(?:warn|warning)$/i.test(log.value.level)
      || Object.hasOwn(log.value, "subsystem") && log.value.subsystem !== "plugins"
      || Object.hasOwn(log.value, "hostname") && typeof log.value.hostname !== "string"
      || Object.hasOwn(log.value, "time") && typeof log.value.time !== "string"
      || Object.hasOwn(log.value, "_meta") && (!log.value._meta || typeof log.value._meta !== "object" || Array.isArray(log.value._meta)
        || !/^(?:warn|warning)$/i.test(log.value._meta.logLevelName)
        || Object.hasOwn(log.value._meta, "name") && log.value._meta.name !== '{"subsystem":"plugins"}'
        || Object.entries(log.value._meta).some(([key, value]) => key === "logLevelId" ? value !== 4
          : key === "parentNames" ? !Array.isArray(value) || value.some(name => typeof name !== "string")
          : !["date", "hostname", "logLevelName", "name", "runtime", "runtimeVersion"].includes(key) || typeof value !== "string"))
      || Object.hasOwn(log.value, "0") && log.value[0] !== '{"subsystem":"plugins"}'
      || Object.hasOwn(log.value, "1") && log.value[1] !== log.message
      || Object.keys(log.value).some(key => !["0", "1", "message", "level", "time", "hostname", "subsystem", "_meta"].includes(key))) return false;
  } else if (/^(?:\d{4}-\d\d-\d\dT\S+\s+)?(?:\[(?:error|fatal)\]|error|fatal)\s+/i.test(text)) return false;
  const message = log.message;
  return typeof message === "string" && /^bonjour: gateway (?:name conflict resolved; newName|hostname conflict resolved; newHostname)="(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"$/.test(message);
}

const logJSON = value => JSON.stringify(value, (_, item) => typeof item === "number" && !Number.isFinite(item) ? JSON.rawJSON(item > 0 ? "1e400" : "-1e400") : item);
const escapeObservation = (value, marker) => typeof value === "string" ? value.replaceAll(marker, `<${marker}>`) : value;

function trailingJSONStart(text, end) {
  if (!/[}\]"]/.test(text[end - 1] ?? "")) return undefined;
  const stack = [];
  let quoted = false;
  for (let index = end - 1; index >= 0; index--) {
    const character = text[index];
    if (character === '"') {
      let slash = index - 1;
      while (text[slash] === "\\") slash--;
      if ((index - slash - 1) % 2) continue;
      quoted = !quoted;
      if (!quoted && !stack.length) return index;
    } else if (!quoted) {
      if (character === "}" || character === "]") stack.push(character === "}" ? "{" : "[");
      else if (character === "{" || character === "[") {
        if (stack.pop() !== character) return undefined;
        if (!stack.length) return index;
      }
    }
  }
  return undefined;
}

function transactionMeasurements(text, protect) {
  const log = nativeLog(text, "sqlite/transaction");
  if (!log || log.level !== undefined && log.level !== "warn" || !/^slow SQLite transaction hold(?: |$)/.test(log.message)) return text;
  const phases = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, number]) => [key,
      ["prepareMs", "beginMs", "sqlMs", "hostAdmissionWaitMs", "commitMs"].includes(key)
        ? Number.isFinite(number) && number >= 0 ? "<duration>" : escapeObservation(number, "<duration>") : number]));
  };
  if (log.value) {
    if (log.message !== "slow SQLite transaction hold" || !log.metadata || !Object.hasOwn(log.metadata, "phases")) return text;
    log.metadata.phases = protect(logJSON(log.metadata.phases), logJSON(phases(log.metadata.phases)));
    if (Number.isInteger(log.metadata.threadId) && log.metadata.threadId >= 0) log.metadata.threadId = "<thread>";
    else if (Object.hasOwn(log.metadata, "threadId")) log.metadata.threadId = escapeObservation(log.metadata.threadId, "<thread>");
    return logJSON(log.value);
  }
  // Work backwards from the producer's fixed suffix. This delimiter scan
  // locates the final JSON value; JSON.parse below still validates its syntax.
  // An earlier phases= inside operation/context cannot claim the native field.
  const suffix = /( isMainThread=(?:true|false) mode=(?:deferred|immediate|exclusive) pid=\d+ threadId=)(\d+|\S*<thread>\S*)( thresholdMs=\d+(?:\.\d+)?$)/.exec(text);
  if (!suffix) return text;
  const field = " phases=";
  let start = trailingJSONStart(text, suffix.index);
  if (start === undefined || text.slice(start - field.length, start) !== field) {
    // No complete JSON boundary: retain the malformed tail literally.
    const prefix = text.indexOf(field);
    if (prefix < 0 || prefix + field.length > suffix.index) return text;
    start = prefix + field.length;
  }
  const value = text.slice(start, suffix.index), [, owner, thread, bound] = suffix;
  let after;
  try { after = logJSON(phases(JSON.parse(value))); }
  catch { return text.slice(0, start) + logJSON(protect(value, value)) + owner + thread + bound; }
  const normalizedThread = /^\{[^{}]*\}$/.test(value) ? (/^\d+$/.test(thread) ? "<thread>" : escapeObservation(thread, "<thread>")) : thread;
  return text.slice(0, start) + logJSON(protect(value, after)) + owner + normalizedThread + bound;
}

const correlationFields = [["traceId", 32], ["spanId", 16], ["parentSpanId", 16]];
function nativeCorrelations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let binding;
  try { binding = JSON.parse(value[0]); } catch { return null; }
  if (typeof binding?.subsystem !== "string" || typeof value.message !== "string" || typeof value._meta?.logLevelName !== "string") return null;
  return { valid: correlationFields.every(([key, width]) => key === "parentSpanId" && value[key] === undefined
    || typeof value[key] === "string" && new RegExp(`^[0-9a-f]{${width}}$`).test(value[key]) && /[1-9a-f]/.test(value[key])) };
}

// Match identities jointly, before rendering any copy. A shared anchor joins
// at most one identity per copy; transitive joins that violate that partition
// are rejected. Indexed union avoids pairwise group/graph comparisons.
function correlationGroups(nodes) {
  const parents = nodes.map((_, index) => index), sizes = nodes.map(() => 1), anchors = new Map();
  const find = index => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  };
  const unite = (first, second) => {
    let a = find(first), b = find(second);
    if (a === b) return;
    if (sizes[a] < sizes[b]) [a, b] = [b, a];
    parents[b] = a; sizes[a] += sizes[b];
  };
  for (const [index, node] of nodes.entries()) {
    // Identical raw identities remain equal even if all their messages changed.
    for (const anchor of node.keys ?? [`raw:${node.id}`, ...node.anchors]) {
      let entry = anchors.get(anchor);
      if (!entry) anchors.set(anchor, entry = { copies: new Set(), members: [] });
      if (entry.ambiguous) continue;
      if (entry.copies.has(node.copy)) { entry.ambiguous = true; entry.members.length = 0; entry.copies.clear(); continue; }
      entry.copies.add(node.copy); entry.members.push(index);
    }
  }
  for (const entry of anchors.values()) for (let index = 1; index < entry.members.length; index++) unite(entry.members[0], entry.members[index]);
  anchors.clear();
  const components = new Map();
  for (const [index, node] of nodes.entries()) {
    const key = find(index);
    if (!components.has(key)) components.set(key, { members: [], copies: new Set(), anchors: new Set() });
    const component = components.get(key);
    if (component.copies.has(node.copy)) component.ambiguous = true;
    component.copies.add(node.copy); component.members.push(node);
    for (const anchor of node.anchors) component.anchors.add(anchor);
  }
  return [...components.values()].filter(component => !component.ambiguous);
}

function correlationComponents(nodes) {
  const references = nodes.filter(node => node.reference), changes = nodes.filter(node => !node.reference);
  const groups = correlationGroups(references);
  // Freeze reference classes before considering changes. A changed relation
  // must never invalidate correspondence between the two noise recordings.
  const contracted = groups.map(group => ({ copy: -1, referenceGroup: group, anchors: group.anchors,
    keys: new Set([...group.anchors, ...group.members.map(node => `raw:${node.id}`)]) }));
  const admitted = new Set();
  // One reserved copy marker prevents a merge of frozen reference classes.
  // Shared anchors spanning multiple reference classes are ambiguous; an
  // anchor unique to a class can still ground a transitive partial overlap.
  for (const component of correlationGroups([...contracted, ...changes])) {
    const reference = component.members.find(node => node.referenceGroup)?.referenceGroup;
    if (!reference) continue;
    for (const node of component.members) if (!node.referenceGroup) { reference.members.push(node); admitted.add(node); }
  }
  const unique = new Map();
  // Repeated changes that cannot claim a reference identity must still align
  // with each other. Otherwise a repeatable split/merge would appear flaky.
  for (const [namespace, components] of [["reference", groups], ["change", correlationGroups(changes.filter(node => !admitted.has(node)))]]) {
    for (const component of components) {
      if (component.members.length < 2) continue;
      // Reference signatures are frozen. New change-only components have a
      // separate hash domain and cannot borrow a reference identity's token.
      const signature = sha256(canonicalJSON([namespace, [...component.anchors].sort()]));
      // Distinct raw-ID components can still have indistinguishable messages.
      // Do not project either component if their proposed token would collide.
      unique.set(signature, unique.has(signature) ? null : component.members);
    }
  }
  return [...unique].filter(([, members]) => members !== null);
}

function logCorrelationCohort() {
  const copies = [];
  let finished = false;
  return {
    add(reference = false) {
      if (finished) throw new Error("diagnostic correlations are already prepared");
      const copy = copies.length, groups = new Map(), resolved = new Map();
      const project = (diagnosticId, span) => {
        const entry = resolved.get(diagnosticId);
        return span === undefined ? entry?.root ?? diagnosticId : entry?.spans.get(span) ?? span;
      };
      project.observe = (phase, raw, normalize = value => value) => {
        if (finished) throw new Error("diagnostic correlations are already prepared");
        let value;
        try { value = JSON.parse(raw); } catch { return; }
        if (!nativeCorrelations(value)?.valid) return;
        const body = { ...value };
        for (const [key] of correlationFields) delete body[key];
        const anchor = sha256(canonicalJSON([phase, normalizeText(logJSON(body), normalize, () => {}, () => {}, true)]));
        const id = value.traceId;
        if (!groups.has(id)) groups.set(id, { copy, reference, id, anchors: new Set(), spans: new Map() });
        const group = groups.get(id);
        group.anchors.add(anchor);
        const observeSpan = (span, role) => {
          if (!group.spans.has(span)) group.spans.set(span, { copy, reference, id: span, anchors: new Set(), group });
          group.spans.get(span).anchors.add(`${role}:${anchor}`);
        };
        observeSpan(value.spanId, "own");
        if (value.parentSpanId !== undefined) observeSpan(value.parentSpanId, "parent");
      };
      copies.push({ groups, resolved });
      return project;
    },
    finish() {
      if (finished) return;
      finished = true;
      for (const [anchor, groups] of correlationComponents(copies.flatMap(copy => [...copy.groups.values()]))) {
        const root = `<correlation:root:${anchor}>`;
        for (const group of groups) copies[group.copy].resolved.set(group.id, { root, spans: new Map() });
        // Own-message and referring-parent anchors both participate. A parent
        // can remain grounded after its own warning disappears. Changed span
        // relationships cannot alter the frozen reference partition.
        for (const [identity, spans] of correlationComponents(groups.flatMap(group => [...group.spans.values()]))) {
          for (const span of spans) copies[span.copy].resolved.get(span.group.id).spans.set(span.id, `<correlation:root:${anchor}/span:${identity}>`);
        }
      }
      for (const copy of copies) copy.groups.clear();
    }
  };
}

// A standalone reader has no cross-copy correspondence evidence. It keeps raw
// IDs, so reordering or removing one line cannot rename another line's identity.
export function createLogCorrelationNormalizer() {
  const cohort = logCorrelationCohort(), project = cohort.add();
  project.finish = () => { cohort.finish(); return project; };
  return project;
}

async function observeLogCorrelations(checkpoints, normalization, correlations, signal) {
  for (const { directory, phase } of checkpoints) {
    signal?.throwIfAborted();
    if (!phase.checkpoint.includes("logs") || !await recordedDirectory(directory)) continue;
    for await (const { bytes, terminated } of fileLines(join(directory, "logs.txt"), signal)) {
      signal?.throwIfAborted();
      if (!terminated && !bytes.length) continue;
      const raw = recordedText(bytes);
      // Match checkpointRows' retention boundary exactly. Correlation metadata
      // does not declare an identity or promote an otherwise excluded line.
      if (environmentLog(raw) || !warning(raw) && !logHasDeclaredId(raw, normalization.hasId)) continue;
      correlations.observe(phase.id, raw, normalization.logText ?? normalization.text);
    }
  }
}

export async function prepareLogCorrelations(copies, phases, { signal } = {}) {
  const cohort = logCorrelationCohort(), projections = [];
  for (const { directory, normalization, reference = false } of copies) {
    const correlations = cohort.add(reference);
    await observeLogCorrelations(phases.map(phase => ({ phase, directory: join(directory, "checkpoints", phase.id) })), normalization, correlations, signal);
    projections.push(correlations);
  }
  signal?.throwIfAborted();
  cohort.finish();
  return projections;
}

export async function prepareCompletionObservations(directory, phases, standard, { signal } = {}) {
  const completions = createCompletionObservations();
  const path = "state/openclaw.sqlite";
  for (const phase of phases) {
    signal?.throwIfAborted();
    if (!phase.checkpoint.some(value => value.startsWith("state:") && (path === value.slice(6) || path.startsWith(`${value.slice(6)}/`)))) continue;
    const checkpoint = join(directory, "checkpoints", phase.id);
    if (!await recordedDirectory(checkpoint)) continue;
    for await (const file of checkpointStateFiles(join(checkpoint, "state"), { ...phase, checkpoint: [`state:${path}`] }, standard)) {
      if (file.kind !== "sqlite" || file.table !== "subagent_runs") continue;
      for (const row of file.rows()) { signal?.throwIfAborted(); completions.observe(file, row); }
    }
  }
  return completions;
}

export function normalizeText(text, normalize = (value) => value, onMeasurement = () => {}, onIdentity = () => {}, nativeMessage = false, correlations) {
  let structured = false;
  let value;
  try { value = JSON.parse(text); }
  catch { /* Plain and damaged text remains comparable. */ }
  if (value && typeof value === "object") {
    const transaction = nativeMessage && nativeLog(text, "sqlite/transaction", value);
    const phaseOwner = transaction?.message === "slow SQLite transaction hold" ? transaction.metadata : null;
    const projectedCorrelations = new Set();
    const native = nativeMessage && nativeCorrelations(value);
    if (native) {
      const diagnosticId = value.traceId;
      for (const [key] of correlationFields) {
        const before = value[key];
        const after = native.valid && correlations && before !== undefined ? correlations(diagnosticId, key === "traceId" ? undefined : before)
          : typeof before === "string" ? before.replace(/<correlation:[^>]*>/g, "<$&>") : before;
        if (before !== undefined) projectedCorrelations.add(key);
        if (after !== before) {
          value[key] = after;
          onIdentity(`native diagnostic correlation ${key}`, before, after);
        }
      }
    }
    const wsEnvelope = nativeMessage && (value.subsystem === "gateway/ws" || value._meta?.name === '{"subsystem":"gateway/ws"}');
    const visit = (item, depth = 0, key = "", measure = true) => {
      if (typeof item === "string") return measure ? normalizeText(item, normalize, onMeasurement, onIdentity, wsEnvelope && depth === 1 && ["message", "1"].includes(key)) : normalize(item);
      if (Array.isArray(item)) return item.map(child => visit(child, depth + 1, "", measure));
      if (!item || typeof item !== "object") return item;
      const entries = Object.entries(item).map(([key, child]) => [normalize(key), child, key]);
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("normalization produced duplicate JSON keys");
      return Object.fromEntries(entries.map(([key, child, originalKey]) => [key, depth === 0 && projectedCorrelations.has(key) ? child
        : visit(child, depth + 1, key, measure && !(item === phaseOwner && originalKey === "phases"))]));
    };
    // JSON permits overflow literals; preserve them as numeric JSON instead of
    // letting stringify turn them into null or a colliding application object.
    text = logJSON(visit(value));
    structured = true;
  }
  if (!structured) text = normalize(text);
  const beforeMeasurements = text;
  const protectedPhases = [];
  let markerIndex = 0;
  if (nativeMessage) text = transactionMeasurements(text, (before, after) => {
    // Choose after all ID/path mapping and JSON recursion. The complete mapped
    // line and both renderings must lack this marker; the generic measurement
    // rules below cannot create its private-use delimiters. Restore before any
    // audit or output, keeping malformed phase strings outside those rules.
    const unavailable = new Set();
    for (const source of [text, before, after]) for (const [literal] of source.matchAll(/\uE000sqlite_phase_\d+\uE001/g)) unavailable.add(literal);
    let marker;
    do { marker = `\uE000sqlite_phase_${markerIndex++}\uE001`; }
    while (unavailable.has(marker));
    protectedPhases.push([logJSON(marker), after]);
    return marker;
  });
  if (/memory pressure:.*\breason=rss_threshold\b/.test(text)) text = text
    .replace(/(\b(?:used|usedBytes)["']?\s*[:=]\s*)\d+(?:\.\d+)?(?:\s*(?:[KMGT]i?B|B))?\b/gi, "$1<rss>")
    .replace(/(\bthresholdRatio=)\d+(?:\.\d+)?%/g, "$1<rss>");
  let result = text
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
  for (const [marker, value] of protectedPhases) result = result.replaceAll(marker, () => value);
  if (result !== beforeMeasurements) onMeasurement(beforeMeasurements, result);
  // Ciao appends collision counters to the machine's service name and hostname.
  // Retain the base identity, message, outcome and occurrence count. Match only
  // these advertisement messages so other product identifiers remain visible.
  let identified = result
    .replace(/^((?:<time> \[plugins\] )?bonjour: gateway name conflict resolved; newName="[^"\r\n]+) \([1-9]\d*\)(")$/, "$1$2")
    .replace(/^((?:<time> \[plugins\] )?bonjour: gateway hostname conflict resolved; newHostname="[^"\r\n]+)-\([1-9]\d*\)(")$/, "$1$2")
    .replace(/^((?:<time> \[plugins\] )?bonjour: advertised gateway fqdn=)([^\r\n]+)(\._openclaw-gw\._tcp\.local\. host=)([^\s]+)(\.local\. port=<port> state=[a-z]+)$/, (_, prefix, name, service, host, suffix) =>
      `${prefix}${name.replace(/ \([1-9]\d*\)$/, "")}${service}${host.replace(/-\([1-9]\d*\)$/, "")}${suffix}`);
  if (identified !== result) onIdentity("Bonjour collision counter in run-environment identity", result, identified);
  // ws-log.ts shortens generated connection UUIDs and this harness's request
  // UUIDs. Other identifiers, response bytes, methods and outcomes stay visible.
  if (nativeMessage && /^(?:(?:<time> \[ws\] )?[⇄←→] (?:req|res)(?: [✓✗])? [A-Za-z][\w.]* )(?:(?:<duration>|runId=\S+|bytes=\d+) )*(?:conn=\S+ )?id=\S+$/u.test(identified)) {
    const before = identified;
    // Arbitrary metadata, especially unquoted error text, is not field evidence.
    // Normalize only the complete fixed form; no connection-history inference.
    identified = identified
      .replaceAll("<connection>", "<<connection>>").replaceAll("<request>", "<<request>>")
      .replace(/( id=)kova-[0-9a-f]{7}…[0-9a-f]{4}$/i, "$1<request>")
      .replace(/( conn=)[0-9a-f]{8}…[0-9a-f]{4}(?= id=\S+$)/i, "$1<connection>");
    if (identified !== before) onIdentity("native WebSocket generated connection and harness request identities", before, identified);
  }
  return identified;
}

function warning(line) {
  try {
    const data = JSON.parse(line);
    // JSON console output assigns level after caller metadata. Native file
    // output puts arguments under numeric keys and severity in _meta.
    const level = typeof data?.level === "string" ? data.level : data?._meta?.logLevelName;
    return typeof level === "string" && /^(?:warn|warning|error|fatal)$/i.test(level);
  } catch {
    if (/^\(node:\d+\)\s+(?:\[[^\]]+\]\s+)?[A-Za-z]*Warning:/i.test(line)) return true;
    let rest = line.trimStart().replace(/^(?:\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?|\d\d:\d\d:\d\d(?:\.\d+)?)\s+/, "");
    for (;;) {
      const level = /^(?:\[(silent|silly|trace|debug|info|warn(?:ing)?|error|fatal)\]|(silent|silly|trace|debug|info|warn(?:ing)?|error|fatal))(?=\s|:|$)/i.exec(rest);
      if (level) return /^(?:warn|warning|error|fatal)$/i.test(level[1] ?? level[2]);
      const context = /^\[[^\]\r\n]+\]\s*/.exec(rest);
      if (!context) return false;
      rest = rest.slice(context[0].length);
    }
  }
}

// Each decoded view retains offsets in the original text. JSON.parse validates
// complete tokens; invalid escapes and unfinished tokens supply no decoded view.
// No replacement decoding or concatenation can join damaged fragments.
export function* logTextViews(text, mapped = false, ranges, depth = 0) {
  yield { text, ranges, depth };
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
    let decoded;
    try { decoded = JSON.parse(token[0]); }
    catch { continue; }
    let offsets;
    if (mapped) {
      offsets = { start: new Uint32Array(decoded.length), end: new Uint32Array(decoded.length) };
      for (let index = 0, offset = token.index + 1; index < decoded.length; index++) {
        const start = offset;
        offset += text[offset] === "\\" ? text[offset + 1] === "u" ? 6 : 2 : 1;
        offsets.start[index] = ranges ? ranges.start[start] : start;
        offsets.end[index] = ranges ? ranges.end[offset - 1] : offset;
      }
    }
    yield* logTextViews(decoded, mapped, offsets, depth + 1);
  }
}

function logHasDeclaredId(value, hasId) {
  if (hasId) for (const view of logTextViews(value)) if (hasId(view.text)) return true;
  return false;
}

// Record transformations at the source address. Derived wrappers carry no
// additional suppression when their logical value is unchanged.
function measurementChanges(before, after, segments, report) {
  if (before === after) return;
  if (before instanceof VerifiedValue) before = before.value;
  if (after instanceof VerifiedValue) after = after.value;
  if (before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) measurementChanges(before[key], after[key], [...segments, pointerPart(key)], report);
  } else if (!equal(before === undefined ? absent : before, after === undefined ? absent : after)) {
    report(segments, before === undefined ? absent : before, after === undefined ? absent : after);
  }
}

// The map key already contains the serialized address. Keep the readable
// address available without retaining a second joined string for every item.
const itemAddress = { enumerable: true, get() { return this.segments.join("/"); } };
const skillsPromptCandidates = new WeakMap();

// Attestation must agree across the whole phase before any copy changes shape.
// Candidates contain only two counts, never source prompts or public metadata.
export function reconcileSkillsPromptMeasurements(copies, audit = () => {}) {
  const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
  try {
    if (!names.every(name => copies[name]?.recorded)) return;
    const candidates = names.map(name => skillsPromptCandidates.get(copies[name].items));
    if (candidates.some(values => !values)) return;
    for (const [key] of candidates[0]) {
      if (!candidates.every((values, index) => values.has(key)
        && copies[names[index]].items.get(key)?.value === values.get(key).original)) continue;
      for (const [index, name] of names.entries()) {
        const items = copies[name].items, item = items.get(key), { original, normalized } = candidates[index].get(key);
        items.set(key, Object.defineProperty({ ...item, value: { verifiedDerived: normalized } }, "at", itemAddress));
        if (original !== normalized) audit(name, { signal: item.signal, at: item.at, category: "measurements",
          reason: "native skills prompt size verified across all five copies against their catalogs, digests and entries after identity normalization",
          before: original, after: normalized });
      }
    }
  } finally {
    for (const name of names) if (copies[name]?.items) skillsPromptCandidates.delete(copies[name].items);
  }
}

export function rowBuilder(normalize = (value) => value, sharedItems) {
  const items = new Map();
  const dynamicPaths = new Map();
  function add(signal, segments, value, { failure = false, dynamic = [], summary } = {}) {
    const at = segments.join("/");
    const key = itemKey(signal, at);
    if (items.has(key)) throw new Error(`normalization produced duplicate item: ${signal}/${at}`);
    const leaf = finiteValue(value);
    const shared = sharedItems?.get(key);
    const sameSegments = shared && shared.item.segments.length === segments.length && shared.item.segments.every((part, index) => part === segments[index]);
    const sameDynamic = shared && shared.item.dynamic.length === dynamic.length && shared.item.dynamic.every((part, index) => part === dynamic[index]);
    // The five copies often contain the same persisted records. Share immutable
    // items only within this phase, after each copy has produced its own audit.
    if (shared && shared.item.failure === failure && shared.item.summary === summary
      && sameSegments && sameDynamic
      && (shared.item.value === leaf || equal(shared.item.value, leaf))) items.set(shared.key, shared.item);
    else {
      if (sameSegments) segments = shared.item.segments;
      if (sameDynamic) dynamic = shared.item.dynamic;
      const pathKey = dynamic.join(",");
      if (dynamicPaths.has(pathKey)) dynamic = dynamicPaths.get(pathKey);
      else dynamicPaths.set(pathKey, dynamic);
      const item = Object.defineProperty({ signal, value: leaf, failure, segments, dynamic, summary }, "at", itemAddress);
      items.set(shared?.key ?? key, item);
      if (!shared) sharedItems?.set(key, { key, item });
    }
  }
  function nodes(signal, value, segments, dynamic = [], verified = false, normalized = false) {
    if (value instanceof SkillsPromptCount) {
      let candidates = skillsPromptCandidates.get(items);
      if (!candidates) skillsPromptCandidates.set(items, candidates = new Map());
      candidates.set(itemKey(signal, segments.join("/")), { original: value.value, normalized: value.normalized });
      return nodes(signal, value.value, segments, dynamic, false, normalized);
    }
    if (value instanceof RuntimeOpaqueValue) return add(signal, segments, value.value, { dynamic });
    if (value instanceof MeasuredText) return nodes(signal, value.value, segments, dynamic, true, normalized);
    if (value instanceof VerifiedValue) return nodes(signal, value.value, segments, dynamic, true, normalized);
    if (value && typeof value === "object") {
      const array = Array.isArray(value);
      const keys = Object.keys(value).map((key) => [key, array || normalized ? key : normalize(key, { signal, at: [...segments, pointerPart(key)].join("/"), kind: "key" })]);
      if (new Set(keys.map(([, key]) => key)).size !== keys.length) throw new Error("normalization produced duplicate JSON keys");
      const container = array ? { type: "array", length: value.length } : { type: "object", keys: keys.map(([, key]) => key).sort() };
      add(signal, segments, verified ? { ...container, verifiedDerived: true } : container, { dynamic });
      const childDynamic = array ? dynamic : [...dynamic, segments.length];
      for (const [original, key] of keys) nodes(signal, value[original], [...segments, pointerPart(key)], childDynamic, false, normalized);
    } else {
      const leaf = typeof value === "string" && !verified && !normalized ? normalize(value, { signal, at: segments.join("/"), kind: "value" }) : finiteValue(value);
      add(signal, segments, verified ? { verifiedDerived: leaf } : leaf, { dynamic });
    }
  }
  return { items, add, nodes, nodesNormalized: (signal, value, segments, dynamic) => nodes(signal, value, segments, dynamic, false, true) };
}

export async function checkpointRows(directory, phase, standard, normalization, commandCount = phase.commands.length, commandEntries = [], audit = () => {}, sharedItems) {
  let correlations = normalization.correlations;
  const normalize = (value, location = { signal: "state", at: "", kind: "value" }) =>
    (location.signal === "logs" ? normalization.logText ?? normalization.text : normalization.text)(value,
      (category, reason, before, after) => audit({ ...location, category, reason, before, after }));
  const at = (signal, segments, kind = "value") => (value) => normalize(value, { signal, at: segments.join("/"), kind });
  const text = (value, signal, segments) => normalizeText(value, at(signal, segments),
    (before, after) => audit({ signal, at: segments.join("/"), category: "measurements", reason: "text timestamp, duration, resource use, process or port observation", before, after }),
    (reason, before, after) => {
      if (reason.startsWith("native diagnostic correlation ") && /^<correlation:root:[a-f0-9]{64}(?:\/span:[a-f0-9]{64})?>$/.test(after)) normalization.findingId?.(after);
      audit({ signal, at: segments.join("/"), category: "declaredIds", reason, before, after });
    }, signal === "logs", correlations);
  const measured = (value, transformed, signal, segments, reason) => {
    measurementChanges(value, transformed, segments, (path, before, after) => audit({ signal, at: path.join("/"), category: "measurements", reason, before, after }));
    return transformed;
  };
  const b = rowBuilder(normalize, sharedItems);
  const exists = await recordedDirectory(directory);
  b.add("checkpoint", [], exists);
  if (!exists) return { items: b.items, recorded: false, exitTwo: false, notExercised: [], commandFailures: [] };
  if (!correlations && phase.checkpoint.includes("logs")) correlations = createLogCorrelationNormalizer().finish();
  const commands = await readJSON(join(directory, "commands.json"));
  if (!Array.isArray(commands) || commands.length !== commandCount) throw new Error(`${phase.id}: invalid recorded command count`);
  for (const [index, command] of commands.entries()) {
    if (!(command.exit === null || Number.isInteger(command.exit)) || !(command.stdout === null || typeof command.stdout === "string")) throw new Error(`${phase.id}: invalid recorded command`);
    b.add("commands", [String(index), "exit"], command.exit, { failure: command.exit !== 0 || command.timedOut === true });
    measured(command.durationMs, undefined, "commands", [String(index), "durationMs"], "absolute command duration");
    const lines = new Map();
    for (const line of textLines(command.stdout ?? "")) {
      const normalized = text(line, "commands", [String(index), "stdout", pointerPart(line)]);
      lines.set(normalized, (lines.get(normalized) ?? 0) + 1);
    }
    for (const [line, count] of lines) b.add("commands", [String(index), "stdout", line], count);
  }
  for (const signal of new Set(phase.checkpoint)) {
    if (signal === "responses") {
      const responses = await readCommandResponses(directory, commands, phase.id);
      for (const [index, value] of Object.entries(responses)) {
        const entry = commandEntries[Number(index) % phase.commands.length];
        const projected = projectBuildIdResponses(value, entry, standard.buildIds, (category, reason, before, after, at) =>
          audit({ signal: "responses", at: `${index}${at}`, category, reason, before, after }), value => normalization.text(value));
        b.nodes("responses", measured(projected, responseData(projected, entry), "responses", [index], "known response execution measurement"), [index]);
      }
    } else if (signal === "timing") {
      const timing = await readJSON(join(directory, "timing.json"));
      if (!Array.isArray(timing) || timing.length !== commands.length || timing.some((item) => typeof item.reachedBound !== "boolean")) throw new Error(`${phase.id}: invalid timing checkpoint`);
      timing.forEach((item, index) => {
        for (const [key, value] of Object.entries(item)) if (key !== "reachedBound") measured(value, undefined, "timing", [String(index), pointerPart(key)], "absolute timing observation; reachedBound is retained");
        b.add("timing", [String(index)], item.reachedBound, { failure: item.reachedBound });
      });
    } else if (signal === "logs") {
      const lines = new Map();
      for await (const { bytes, terminated } of fileLines(join(directory, "logs.txt"))) {
        if (!terminated && !bytes.length) continue;
        const raw = recordedText(bytes);
        if (environmentLog(raw)) {
          audit({ signal: "logs", at: pointerPart(raw), category: "declaredIds", reason: "native Bonjour shared-host name negotiation event", before: raw, after: absent });
          continue;
        }
        const failure = warning(raw);
        if (!failure && !logHasDeclaredId(raw, normalization.hasId)) {
          audit({ signal: "logs", at: pointerPart(raw), category: "logLevel", reason: "log line has no warn, error or fatal level and no declared identity", before: raw, after: absent });
          continue;
        }
        const line = text(raw, "logs", [pointerPart(raw)]);
        const previous = lines.get(line);
        lines.set(line, { count: (previous?.count ?? 0) + 1, failure: previous?.failure || failure });
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
        for (const [findingIndex, { finding, scope }] of values.entries()) {
          const sourceAt = [String(index), `@finding:${findingIndex}`];
          const normalized = text(typeof finding === "string" ? finding : typeof finding.message === "string" ? finding.message : canonicalJSON(finding), "doctor", [...sourceAt, "message"]);
          // checkId identifies a check, which can report several distinct findings.
          const code = typeof finding === "object" && typeof finding.code === "string" && finding.code;
          const address = code ? normalize(code, { signal: "doctor", at: [...sourceAt, "code"].join("/"), kind: "key" }) : normalized;
          findings.set(scope ? canonicalJSON([...scope.map((value, scopeIndex) => typeof value === "string" ? normalize(value, { signal: "doctor", at: [...sourceAt, "scope", String(scopeIndex)].join("/"), kind: "key" }) : value), address]) : address, normalized);
        }
      }
      for (const [at, summary] of findings) b.add("doctor", [at], true, { failure: true, summary });
    } else if (signal === "screen") b.add("screen", [], sha256(await readBytes(join(directory, "screen.png"))));
  }
  if (phase.checkpoint.some((signal) => signal.startsWith("state:"))) {
    for await (const file of checkpointStateFiles(join(directory, "state"), phase, standard, (value) => normalization.text(value), (filePath, table, row, afterRow, index) => {
      const address = [...filePath.split("/").map(pointerPart)];
      address[address.length - 1] += `:${pointerPart(table)}`;
      address.push(`@row:${index}`);
      for (const column of new Set([...Object.keys(row.values), ...Object.keys(afterRow.values)])) {
        const skills = table === "session_entry_snapshots" && row.values.field?.raw === "systemPromptReport" && column === "value_json";
        measured(row.values[column]?.value, afterRow.values[column]?.value, "state", [...address, pointerPart(column)], skills
          ? "native skills prompt size verified against its catalog, digest and entries after identity normalization"
          : "verified derived storage or persisted execution measurement");
      }
    })) {
      const path = file.path.split("/").map((part) => pointerPart(normalize(part, { signal: "state", at: file.path, kind: "path" })));
      const dynamic = path.map((_, index) => index);
      if (file.kind === "derived-sqlite") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        audit({ signal: "state", at: path.join("/"), category: "derived", reason: file.reason, before: file.value, after: absent });
        continue;
      }
      if (file.kind === "sqlite") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, { type: "table" }, { dynamic });
        if (runtimeEventFile(file)) {
          const events = new Map();
          let index = 0;
          for await (const row of file.rows()) {
            const source = [...path, `@row:${index++}`].join("/");
            const value = runtimeEventContent(file, row, {
              evidence: file.evidence,
              completions: normalization.completions,
              observationBindings: normalization.observationBindings,
              normalize: (value, field) => normalize(value, { signal: "state", at: `${source}/${field}`, kind: "value" }),
              report: (item) => audit({ ...item, signal: "state", at: `${source}/${item.at}` })
            });
            const key = `<event:${sha256(runtimeEventSignature(value))}>`;
            audit({ signal: "state", at: source, category: "derived", reason: "runtime event compares full normalized content and multiplicity once, without storage positions or repeated descendant observations", before: { rowid: row.rowid, primary: file.primary.map(column => row.values[column]?.raw) }, after: key });
            normalization.findingId?.(key);
            const previous = events.get(key);
            if (previous) {
              if (!equal(previous.value, value)) throw new Error("runtime event content hash collision");
              previous.count++;
            } else events.set(key, { value, count: 1 });
          }
          // Content identities are fixed observations, not unknown dynamic keys.
          // A noisy event cannot suppress a different changed payload by prefix.
          for (const [key, event] of [...events].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
            event.value = runtimeEventObservation(event.value);
            b.add("state", [...path, key], { count: event.count, content: event.value }, { dynamic });
          }
          continue;
        }
        // Content declarations discover identities inside JSON; their containing
        // column remains structured evidence, including typed observations.
        const idColumns = new Set([...file.primary, ...standard.stateIds.filter((entry) => entry.kind === undefined && entry.table === file.table && matchesGlob(file.path, entry.path)).map((entry) => entry.column)]);
        const dynamicKeys = [...dynamic, path.length];
        let rowIndex = -1;
        for await (const row of file.rows()) {
          rowIndex++;
          const keys = file.primary.map((column) => {
            const cell = row.values[column];
            return cell.value instanceof VerifiedValue ? cell.value.value : typeof cell.raw === "string" ? at("state", [...path, `@row:${rowIndex}`, pointerPart(column)], "key")(cell.raw) : cell.raw;
          });
          const primaryKey = keys.length === 1 ? keys[0] : keys;
          // SQLite permits multiple NULL primary keys in rowid tables. Preserve
          // SQL storage types and use rowid only to disambiguate those NULL keys.
          const nullable = keys.includes(null);
          if (nullable && row.rowid === null) throw new Error(`nullable state key needs rowid: ${file.path}:${file.table}`);
          const key = canonicalJSON(nullable ? { key: primaryKey, rowid: row.rowid } : keys.length ? primaryKey : row.rowid);
          if (!file.primary.length && row.rowid === null) throw new Error(`state table has no addressable key: ${file.path}:${file.table}`);
          const segments = [...path, pointerPart(key)];
          b.add("state", segments, true, { dynamic: dynamicKeys });
          for (const [column, value] of Object.entries(row.values)) {
            const identity = typeof value.raw === "string" ? normalization.id(value.raw) : value.raw;
            const declared = identity !== value.raw || typeof value.raw === "string" && (idColumns.has(column) || normalization.isId?.(value.raw));
            const at = [...segments, pointerPart(column)];
            // Formatted numeric/BLOB markers and already-normalized tokens are
            // not product JSON strings and must not be normalized a second time.
            if (value.invalidCompressed) b.add("state", at, value.value, { dynamic: dynamicKeys });
            else if (value.value instanceof VerifiedValue) b.nodes("state", value.value, at, dynamicKeys);
            else if (declared || value.encoded) b.add("state", at, declared ? normalize(value.raw, { signal: "state", at: at.join("/"), kind: "value" }) : value.value, { dynamic: dynamicKeys });
            else b.nodes("state", value.value, at, dynamicKeys);
          }
        }
      } else if (file.kind === "sqlite-schema") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, at("state", path)(file.value), { dynamic });
      } else if (file.kind === "json") b.nodes("state", sessionIndex(file.path) ? measured(file.value, sessionIndexMeasurements(file.value), "state", path, "session execution measurement") : file.value, path, dynamic);
      else if (file.kind === "jsonl") {
        b.add("state", path, { type: "jsonl" }, { dynamic });
        for await (const { index, value, binary, malformed } of file.records) {
          const at = [...path, String(index)];
          if (binary !== undefined) b.add("state", at, { invalidJSONLBytes: binary }, { dynamic });
          else if (value === undefined) continue;
          else if (malformed) b.add("state", at, { invalidJSONL: text(value, "state", at) }, { dynamic });
          else b.nodes("state", sessionTranscript(file.path) ? measured(value, transcriptMeasurements(value), "state", at, "transcript execution measurement") : value, at, dynamic);
        }
      } else if (file.kind === "text") {
        b.add("state", path, { type: "text" }, { dynamic });
        file.value.forEach((line, index) => b.add("state", [...path, String(index)], text(line, "state", [...path, String(index)]), { dynamic }));
      }
      else b.add("state", path, file.value, { dynamic });
    }
  }
  const commandFailures = commands.flatMap((command, index) => command.exit !== 0 || command.timedOut
    ? [{ command: command.command, index, exit: command.exit, reason: command.timedOut ? "command timed out" : command.exit === null ? "command exit unavailable" : `command exited ${command.exit}` }] : []);
  const notExercised = commandFailures.filter(command => command.exit === 2);
  return { items: b.items, recorded: true, exitTwo: notExercised.length > 0, notExercised, commandFailures };
}
