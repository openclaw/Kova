import { open, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, matchesGlob } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import JSON5 from "json5";
import { sha256, canonicalJSON } from "./plan.mjs";

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

export async function* checkpointStateFiles(directory, phase, standard) {
  const selected = phase.checkpoint.filter((signal) => signal.startsWith("state:")).map((signal) => signal.slice(6));
  if (!selected.length) return;
  if (selected.some((path) => !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error(`${phase.id}: invalid recorded state selection`);
  if (!await recordedDirectory(directory)) throw new Error(`${phase.id}: missing state checkpoint directory`);
  yield* stateFiles(directory, standard, "", selected);
}

export async function* stateFiles(directory, standard, prefix = "", selected = null) {
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
    if (entry.isDirectory()) { yield* stateFiles(file, standard, path, selected); continue; }
    if (selected && !selected.some(includes)) continue;
    if (!entry.isFile()) throw new Error(`recorded state is not a regular file: ${path}`);
    if (/-wal$|-shm$/.test(entry.name)) {
      try { if ((await readBytes(file.slice(0, -4), 16)).equals(Buffer.from("SQLite format 3\0"))) continue; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    yield* stateFile(file, path, standard);
  }
}

export async function* stateFile(file, path, standard, format) {
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
            const order = ordered.has(column.name) ? { orderValue: value instanceof Uint8Array ? Buffer.from(value) : value } : {};
            // The usage envelope authenticates its separate encoded body. Keep
            // that one buffer for checkpoint normalization, without changing
            // the complete values consumed by persona identity discovery.
            const source = agentDatabase(path) && table.name === "cache_entries" && column.name === "blob" && value instanceof Uint8Array ? { sourceBytes: value } : {};
            const compressed = standard.compressed.find((item) => matchesGlob(path, item.path) && item.table === table.name && item.column === column.name);
            if (compressed && value !== null) {
              if (compressed.codec !== "zstd") throw new Error(`unsupported compressed state: ${path}:${table.name}/${column.name}`);
              // Corrupted product content is still evidence. Keep its bytes
              // comparable when decompression or JSON decoding cannot work.
              if (value instanceof Uint8Array) {
                try { value = new TextDecoder("utf-8", { fatal: true }).decode(zstdDecompressSync(value)); }
                catch { /* The ordinary BLOB hash below preserves the difference. */ }
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
        yield { path, kind: "sqlite", table: table.name, primary, rows };
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
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
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
  function nodes(signal, value, segments, dynamic = []) {
    if (value && typeof value === "object") {
      const array = Array.isArray(value);
      const keys = Object.keys(value).map((key) => [key, array ? key : normalize(key)]);
      if (new Set(keys.map(([, key]) => key)).size !== keys.length) throw new Error("normalization produced duplicate JSON keys");
      add(signal, segments, array ? { type: "array", length: value.length } : { type: "object", keys: keys.map(([, key]) => key).sort() }, { dynamic });
      for (const [original, key] of keys) nodes(signal, value[original], [...segments, pointerPart(key)], array ? dynamic : [...dynamic, segments.length]);
    } else add(signal, segments, typeof value === "string" ? normalize(value) : value, { dynamic });
  }
  return { items, add, nodes };
}

function responseData(value, entry) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const paths = ["gateway", "script"].includes(entry?.kind) ? ["elapsedMs", "durationMs"] : [];
  if (["status", "channels-status"].includes(entry?.id)) {
    // Pinned status/health observations, not similarly named configuration or payload fields.
    const eventLoop = ["degradedSinceMs", "intervalMs", "delayP99Ms", "delayMaxMs", "utilization", "cpuCoreRatio", "cpuBreakdown.mainThreadCoreRatio", "cpuBreakdown.workerCoreRatio", "cpuBreakdown.otherThreadsCoreRatio", "cpuBreakdown.hostUtilization"];
    paths.push(...eventLoop.map((path) => `eventLoop.${path}`));
    const channels = entry.id === "status" ? ["health.channels.*", "health.channels.*.accounts.*"] : ["channels.*", "channelAccounts.*.*"];
    paths.push(...channels.flatMap((path) => [`${path}.probe.elapsedMs`, `${path}.probe.latencyMs`, `${path}.audit.elapsedMs`, `${path}.authAgeMs`]));
    if (entry.id === "status") paths.push("gateway.connectLatencyMs", "health.durationMs", "lastHeartbeat.durationMs", ...eventLoop.map((path) => `health.eventLoop.${path}`), "agents.agents.*.lastActiveAgeMs", "sessions.recent.*.age", "sessions.byAgent.*.recent.*.age", "linkChannel.authAgeMs", "health.sessions.recent.*.age", "health.agents.*.sessions.recent.*.age");
  }
  const operationPaths = {
    "sessions-list": ["sessions.*.ageMs"],
    "gateway-sessions-list": ["result.sessions.*.runtimeMs"],
    "gateway-sessions-describe": ["result.session.runtimeMs"],
    "gateway-sessions-subscribe": ["result.list.sessions.*.runtimeMs"],
    "gateway-sessions-patch": ["result.entry.runtimeMs"],
    "cron-list": ["jobs.*.state.lastDurationMs"]
  };
  paths.push(...(operationPaths[entry?.id] ?? []));
  return omitMeasurements(value, paths);
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const measurement = (value) => typeof value === "number" && Number.isFinite(value);
const agentDatabase = (path) => /^agents\/[^/]+\/agent\/openclaw-agent\.sqlite$/.test(path);
const sessionTranscript = (path) => /^agents\/[^/]+\/sessions\/[^/]+\.jsonl(?:\.bak(?:\.[^/]+)?|\.(?:reset|deleted)\.[^/]+)?$/.test(path);
const sessionIndex = (path) => /^(?:agents\/[^/]+\/)?sessions\/sessions\.json(?:\.bak)?$/.test(path);
const removed = Symbol("removed measurement");

// These paths name producer-owned fields, never arbitrary keys in product payloads.
// Copy only changed branches so the original recording remains available to ID discovery.
function mapFields(value, paths, transform) {
  const visit = (value, [part, ...rest]) => {
    if (!value || typeof value !== "object") return value;
    let result = value;
    for (const key of part === "*" ? Object.keys(value) : [part]) {
      if (!Object.hasOwn(value, key)) continue;
      const next = rest.length ? visit(value[key], rest) : transform(value[key]);
      if (next === value[key]) continue;
      if (result === value) result = Array.isArray(value) ? value.slice() : { ...value };
      if (next === removed) delete result[key]; else result[key] = next;
    }
    return result;
  };
  return paths.reduce((result, path) => visit(result, path.split(".")), value);
}
const omitMeasurements = (value, paths, nullable = false) => mapFields(value, paths, (value) => measurement(value) || nullable && value === null ? removed : value);

function hasFormattedRuntime(entry) {
  return record(entry) && measurement(entry.runtimeMs) && entry.runtimeMs >= 0 && typeof entry.runtime === "string" &&
    (entry.runtime === "n/a" ? entry.runtimeMs === 0 : /^(?:\d+ms|(?=\d)(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/.test(entry.runtime));
}

function subagentListText(text, value) {
  if (typeof text !== "string") return text;
  const entries = [value.active, value.recent].flatMap((entries) => Array.isArray(entries) ? entries : []);
  return text.split("\n").map((line) => {
    for (const entry of entries) {
      if (!hasFormattedRuntime(entry)) continue;
      const prefix = `${entry.index}. ${entry.taskName ? `${entry.taskName}: ` : ""}${entry.label} (`;
      if (!line.startsWith(prefix)) continue;
      const start = line.indexOf(`, ${entry.runtime}`, prefix.length);
      const end = start + 2 + entry.runtime.length;
      if (start >= 0 && [",", ")"].includes(line[end])) return `${line.slice(0, start + 2)}<duration>${line.slice(end)}`;
    }
    return line;
  }).join("\n");
}

function toolMeasurements(value, tool) {
  if (!record(value)) return value;
  if (tool === "exec") return omitMeasurements(value, ["durationMs"]);
  if (tool === "process") return omitMeasurements(value, ["idleMs", "sessions.*.runtimeMs", "sessions.*.idleMs"]);
  if (tool === "cron") return omitMeasurements(value, ["jobs.*.state.lastDurationMs", "state.lastDurationMs", "entries.*.durationMs", "run.durationMs"]);
  if (tool !== "subagents" || value.action !== "list") return value;
  const result = mapFields(value, ["active.*", "recent.*"], (entry) => {
    const next = omitMeasurements(entry, ["runtimeMs"]);
    if (!hasFormattedRuntime(entry)) return next;
    return mapFields(next, ["runtime"], () => removed);
  });
  return mapFields(result, ["text"], (text) => subagentListText(text, value));
}

function transcriptMeasurements(event) {
  if (!record(event) || event.type !== "message" || event.message?.role !== "toolResult") return event;
  const { message } = event;
  const details = toolMeasurements(message.details, message.toolName);
  let content = message.content;
  if (["cron", "subagents"].includes(message.toolName) && Array.isArray(content)) content = content.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    try {
      const value = JSON.parse(part.text), next = toolMeasurements(value, message.toolName);
      const text = JSON.stringify(next);
      return text === part.text ? part : { ...part, text };
    } catch { return part; }
  });
  // Process list text repeats the measured runtime in a fixed prefix; command
  // output after the separator remains untouched, including media and timeouts.
  if (message.toolName === "process" && Array.isArray(message.details?.sessions) && Array.isArray(content)) content = content.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    const text = part.text.split("\n").map((line) => {
      for (const session of message.details.sessions) {
        if (!measurement(session?.runtimeMs) || typeof session.status !== "string") continue;
        const prefix = `${session.sessionId} ${session.status.padEnd(9)} `;
        if (line.startsWith(prefix)) return prefix + line.slice(prefix.length).replace(/^(?:n\/a|\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\s*\d+(?:\.\d+)?(?:ms|s|m|h|d))*)(?= |$)/, "<duration>");
      }
      return line;
    }).join("\n");
    return text === part.text ? part : { ...part, text };
  });
  if (details === message.details && (!Array.isArray(content) || content.every((part, index) => part === message.content[index]))) return event;
  return { ...event, message: { ...message, ...(details === message.details ? {} : { details }), ...(content === message.content ? {} : { content }) } };
}

function usageRollupMeasurements(value) {
  return mapFields(value, ["buckets.*.latency"], (latency) => {
    if (!record(latency)) return latency;
    let result = omitMeasurements(latency, ["min", "max", "sum"]);
    // Centroid membership/counts depend on the measured latency distribution.
    // Its independent total sample count and all usage/work counts remain data.
    if (Array.isArray(latency.centroids) && latency.centroids.every((entry) => record(entry) && Object.keys(entry).every((key) => ["count", "value"].includes(key)) && Number.isSafeInteger(entry.count) && entry.count > 0 && measurement(entry.value))) {
      result = { ...result };
      delete result.centroids;
    }
    return result;
  });
}

function decodedUsageMeasurements(values) {
  const envelope = values.value_json?.value, bytes = values.blob?.sourceBytes;
  if (!record(envelope) || envelope.version !== 6 || envelope.format !== 1 || typeof envelope.pricingFingerprint !== "string" || !record(envelope.checkpoint) || !["jsonl", "sqlite"].includes(envelope.checkpoint.kind) || !record(envelope.body) || !bytes) return null;
  const body = envelope.body;
  if (!["identity", "zstd"].includes(body.encoding) || ![body.bytes, body.storedBytes, body.utf16Length].every((value) => Number.isSafeInteger(value) && value > 0) || typeof body.sha256 !== "string" || bytes.byteLength !== body.storedBytes) return null;
  try {
    const raw = body.encoding === "zstd" ? zstdDecompressSync(bytes, { maxOutputLength: body.bytes }) : bytes;
    if (raw.byteLength !== body.bytes || sha256(raw) !== body.sha256) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (text.length !== body.utf16Length) return null;
    const rollup = JSON.parse(text);
    if (!record(rollup) || !record(rollup.buckets) || !record(rollup.untimestamped)) return null;
    const normalized = usageRollupMeasurements(rollup);
    // The producer may choose compression based on the body size. Once the
    // original sizes/hash are verified, compare decoded content instead of
    // measurement-dependent compression, lengths and digest aliases.
    const normalizedBody = { ...body, encoding: "decoded-json" };
    for (const key of ["bytes", "storedBytes", "utf16Length", "sha256"]) delete normalizedBody[key];
    return { envelope: { ...envelope, body: normalizedBody }, rollup: normalized };
  } catch { return null; }
}

function quarantineIdentity(value) {
  return JSON.stringify({
    sourceIndex: value.sourceIndex, reason: value.reason, job: value.job ?? null,
    raw: value.raw ?? null, state: value.state ?? null,
    updatedAtMs: value.updatedAtMs ?? null, scheduleIdentity: value.scheduleIdentity ?? null
  });
}

function persistedRowMeasurements(file, row) {
  let values = row.values;
  const json = (column, transform) => {
    const cell = values[column];
    if (!cell || cell.encoded || file.primary.includes(column)) return;
    const value = transform(cell.value);
    if (value !== cell.value) values = { ...values, [column]: { ...cell, value, raw: JSON.stringify(value) } };
  };
  const omitColumn = (column) => {
    const cell = values[column];
    if (!file.primary.includes(column) && cell && (measurement(cell.value) || cell.value === null)) {
      values = { ...values };
      delete values[column];
    }
  };
  if (agentDatabase(file.path)) {
    if (file.table === "session_nodes") json("entry_json", (value) => omitMeasurements(value, ["runtimeMs"]));
    if (file.table === "transcript_events") {
      json("event_json", transcriptMeasurements);
      json("event_zstd", transcriptMeasurements);
      const payload = typeof row.values.event_json?.raw === "string" ? "event_json" : "event_zstd";
      const original = row.values[payload]?.raw;
      if (!file.primary.includes("event_utf8_bytes") && typeof original === "string" && measurement(values.event_utf8_bytes?.value) && Buffer.byteLength(original) === values.event_utf8_bytes.value && values[payload] !== row.values[payload]) {
        const length = Buffer.byteLength(values[payload].raw);
        values = { ...values, event_utf8_bytes: { ...values.event_utf8_bytes, value: length, raw: length } };
      }
    }
    if (file.table === "cache_entries") {
      if (values.scope?.raw === "session-cost-usage-rollup-v2") json("value_json", (value) => mapFields(value, ["rollup"], usageRollupMeasurements));
      if (values.scope?.raw === "session-cost-usage-rollup-v3" && !file.primary.some((column) => ["blob", "value_json"].includes(column))) {
        const decoded = decodedUsageMeasurements(values);
        if (decoded) {
          json("value_json", () => decoded.envelope);
          values = { ...values, blob: { ...values.blob, value: decoded.rollup, encoded: false } };
        }
      }
    }
  }
  if (file.path === "state/openclaw.sqlite") {
    if (file.table === "subagent_runs") json("payload_json", (value) => omitMeasurements(value, ["accumulatedRuntimeMs", "execution.outcome.elapsedMs", "parentCompletion.accumulatedRuntimeMs", "parentCompletion.execution.outcome.elapsedMs"]));
    if (file.table === "cron_jobs") json("state_json", (value) => omitMeasurements(value, ["lastDurationMs"]));
    if (file.table === "task_runs" && values.runtime?.raw === "cron") json("detail_json", (value) => value?.kind === "cron-run" ? omitMeasurements(value, ["durationMs"]) : value);
    if (file.table === "cron_run_logs") {
      omitColumn("duration_ms");
      json("entry_json", (value) => omitMeasurements(value, ["durationMs"]));
    }
    if (["audit_events", "outbound_message_progress"].includes(file.table)) omitColumn("duration_ms");
    if (file.table === "update_runs") omitColumn("downtime_ms");
    if (file.table === "gateway_restart_sentinel") {
      json("stats_json", (value) => omitMeasurements(value, ["durationMs", "steps.*.durationMs"], true));
      json("payload_json", (value) => omitMeasurements(value, ["stats.durationMs", "stats.steps.*.durationMs"], true));
    }
    if (file.table === "diagnostic_events" && typeof values.scope?.raw === "string" && values.scope.raw.startsWith("cron.quarantine:") && record(values.payload_json?.value)) {
      const payload = values.payload_json.value;
      // A bad digest is product evidence. Only a hash produced from the exact
      // retained payload can be replaced by the corresponding normalized hash.
      if (values.event_key?.raw === sha256(quarantineIdentity(payload))) {
        json("payload_json", (value) => omitMeasurements(value, ["state.lastDurationMs"]));
        if (values.payload_json !== row.values.payload_json) {
          const key = sha256(quarantineIdentity(values.payload_json.value));
          values = { ...values, event_key: { ...values.event_key, raw: key, value: key } };
        }
      }
    }
  }
  return values === row.values ? row : { ...row, values };
}

function persistedRowsMeasurements(file) {
  const rows = file.rows.map((row) => persistedRowMeasurements(file, row));
  if (file.path !== "state/openclaw.sqlite" || file.table !== "diagnostic_events") return rows;
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    if (typeof row.values.scope?.raw !== "string" || !row.values.scope.raw.startsWith("cron.quarantine:")) continue;
    const key = canonicalJSON([row.values.scope.raw, row.values.event_key?.raw]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  for (const indexes of groups.values()) {
    if (indexes.length < 2 || !indexes.some((index) => rows[index].values.event_key?.raw !== file.rows[index].values.event_key?.raw)) continue;
    // Two retained quarantines can differ only by duration. Preserve their
    // multiplicity without inventing a duplicate primary key after omission.
    indexes.forEach((index, ordinal) => {
      const row = rows[index], cell = row.values.event_key;
      const key = `${cell.raw}#${ordinal + 1}`;
      rows[index] = { ...row, values: { ...row.values, event_key: { ...cell, raw: key, value: key } } };
    });
  }
  return rows;
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
    for await (const file of checkpointStateFiles(join(directory, "state"), phase, standard)) {
      const path = file.path.split("/").map((part) => pointerPart(normalize(part)));
      const dynamic = path.map((_, index) => index);
      if (file.kind === "sqlite") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, { type: "table" }, { dynamic });
        const idColumns = new Set([...file.primary, ...standard.stateIds.filter((entry) => entry.table === file.table && matchesGlob(file.path, entry.path)).map((entry) => entry.column)]);
        for (const row of persistedRowsMeasurements(file)) {
          const keys = file.primary.map((key) => row.values[key].raw).map((value) => typeof value === "string" ? normalize(value) : value);
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
            if (declared || value.encoded) b.add("state", at, declared ? normalize(value.raw) : value.value, { dynamic: dynamicKeys });
            else b.nodes("state", value.value, at, dynamicKeys);
          }
        }
      } else if (file.kind === "sqlite-schema") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, normalize(file.value), { dynamic });
      } else if (file.kind === "json") b.nodes("state", sessionIndex(file.path) ? omitMeasurements(file.value, ["*.runtimeMs"]) : file.value, path, dynamic);
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
