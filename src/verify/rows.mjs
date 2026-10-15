import { open, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, matchesGlob } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import JSON5 from "json5";
import { sha256, canonicalJSON } from "./plan.mjs";
import { responseData, transcriptMeasurements, sessionTranscript, sessionIndex, agentDatabase, persistedRowsMeasurements, sessionIndexMeasurements, VerifiedValue, DuplicateValues, TranscriptInteger } from "./measurements.mjs";

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

// A damaged document can still contain intact escaped source identities. Find
// token boundaries in the original bytes, then decode intact strings/fragments.
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
        yield { ...decoded, rows: () => context ? persistedRowsMeasurements(decoded, { ...context, db, standard }) : readRows() };
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
    try { yield { path, kind: "json", value: JSON5.parse(text) }; return; }
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
        yield { index: index++, value, malformed };
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

export function normalizeText(text, normalize = (value) => value, onMeasurement = () => {}, onIdentity = () => {}) {
  let structured = false;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") {
      const visit = (item) => typeof item === "string" ? normalizeText(item, normalize, onMeasurement, onIdentity)
        : Array.isArray(item) ? item.map(visit)
          : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, child]) => [normalize(key), visit(child)])) : item;
      text = JSON.stringify(visit(value));
      structured = true;
    }
  } catch { /* Plain and damaged text remains comparable. */ }
  if (!structured) text = normalize(text);
  const beforeMeasurements = text;
  if (/memory pressure:.*\breason=rss_threshold\b/.test(text)) text = text
    .replace(/(\b(?:used|usedBytes)["']?\s*[:=]\s*)\d+(?:\.\d+)?(?:\s*(?:[KMGT]i?B|B))?\b/gi, "$1<rss>")
    .replace(/(\bthresholdRatio=)\d+(?:\.\d+)?%/g, "$1<rss>");
  const result = text
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
  if (result !== beforeMeasurements) onMeasurement(beforeMeasurements, result);
  // Ciao appends collision counters to the machine's service name and hostname.
  // Retain the base identity, message, outcome and occurrence count. Match only
  // these advertisement messages so other product identifiers remain visible.
  const identified = result
    .replace(/^((?:<time> \[plugins\] )?bonjour: gateway name conflict resolved; newName="[^"\r\n]+) \([1-9]\d*\)(")$/, "$1$2")
    .replace(/^((?:<time> \[plugins\] )?bonjour: gateway hostname conflict resolved; newHostname="[^"\r\n]+)-\([1-9]\d*\)(")$/, "$1$2")
    .replace(/^((?:<time> \[plugins\] )?bonjour: advertised gateway fqdn=)([^\r\n]+)(\._openclaw-gw\._tcp\.local\. host=)([^\s]+)(\.local\. port=<port> state=[a-z]+)$/, (_, prefix, name, service, host, suffix) =>
      `${prefix}${name.replace(/ \([1-9]\d*\)$/, "")}${service}${host.replace(/-\([1-9]\d*\)$/, "")}${suffix}`);
  if (identified !== result) onIdentity("Bonjour collision counter in run-environment identity", result, identified);
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

function logHasDeclaredId(value, hasId) {
  if (!hasId) return false;
  if (hasId(value)) return true;
  // Reuse strict source-token recovery for JSON strings inside surrounding
  // text. UTF-16 preserves lone code units instead of inventing replacements.
  return intactSourceStrings(Buffer.from(value, "utf16le"), "utf-16le")
    .some((fragment) => fragment !== value && logHasDeclaredId(fragment, hasId));
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
  function nodes(signal, value, segments, dynamic = [], verified = false) {
    if (value instanceof VerifiedValue) return nodes(signal, value.value, segments, dynamic, true);
    if (value && typeof value === "object") {
      const array = Array.isArray(value);
      const keys = Object.keys(value).map((key) => [key, array ? key : normalize(key, { signal, at: [...segments, pointerPart(key)].join("/"), kind: "key" })]);
      if (new Set(keys.map(([, key]) => key)).size !== keys.length) throw new Error("normalization produced duplicate JSON keys");
      const container = array ? { type: "array", length: value.length } : { type: "object", keys: keys.map(([, key]) => key).sort() };
      add(signal, segments, verified ? { ...container, verifiedDerived: true } : container, { dynamic });
      const childDynamic = array ? dynamic : [...dynamic, segments.length];
      for (const [original, key] of keys) nodes(signal, value[original], [...segments, pointerPart(key)], childDynamic);
    } else {
      const leaf = typeof value === "string" && !verified ? normalize(value, { signal, at: segments.join("/"), kind: "value" }) : finiteValue(value);
      add(signal, segments, verified ? { verifiedDerived: leaf } : leaf, { dynamic });
    }
  }
  return { items, add, nodes };
}

export async function checkpointRows(directory, phase, standard, normalization, commandCount = phase.commands.length, commandEntries = [], audit = () => {}, sharedItems) {
  const normalize = (value, location = { signal: "state", at: "", kind: "value" }) => normalization.text(value, (category, reason, before, after) => audit({ ...location, category, reason, before, after }));
  const at = (signal, segments, kind = "value") => (value) => normalize(value, { signal, at: segments.join("/"), kind });
  const text = (value, signal, segments) => normalizeText(value, at(signal, segments),
    (before, after) => audit({ signal, at: segments.join("/"), category: "measurements", reason: "text timestamp, duration, resource use, process or port observation", before, after }),
    (reason, before, after) => audit({ signal, at: segments.join("/"), category: "declaredIds", reason, before, after }));
  const measured = (value, transformed, signal, segments, reason) => {
    measurementChanges(value, transformed, segments, (path, before, after) => audit({ signal, at: path.join("/"), category: "measurements", reason, before, after }));
    return transformed;
  };
  const b = rowBuilder(normalize, sharedItems);
  const exists = await recordedDirectory(directory);
  b.add("checkpoint", [], exists);
  if (!exists) return { items: b.items, recorded: false, exitTwo: false };
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
        b.nodes("responses", measured(value, responseData(value, entry), "responses", [index], "known response execution measurement"), [index]);
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
      for (const column of new Set([...Object.keys(row.values), ...Object.keys(afterRow.values)])) measured(row.values[column]?.value, afterRow.values[column]?.value, "state", [...address, pointerPart(column)], "verified derived storage or persisted execution measurement");
    })) {
      const path = file.path.split("/").map((part) => pointerPart(normalize(part, { signal: "state", at: file.path, kind: "path" })));
      const dynamic = path.map((_, index) => index);
      if (file.kind === "sqlite") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, { type: "table" }, { dynamic });
        const idColumns = new Set([...file.primary, ...standard.stateIds.filter((entry) => entry.table === file.table && matchesGlob(file.path, entry.path)).map((entry) => entry.column)]);
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
  return { items: b.items, recorded: true, exitTwo: commands.some((command) => command.exit === 2) };
}
