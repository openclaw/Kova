import { open, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, matchesGlob } from "node:path";
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

export async function* stateFiles(directory, standard, prefix = "") {
  let entries;
  try {
    if (!await recordedDirectory(directory)) { if (!prefix) return; throw new Error(`missing state directory: ${directory}`); }
    entries = await readdir(directory, { withFileTypes: true });
  }
  catch (error) { if (error.code === "ENOENT" && !prefix) return; throw error; }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`recorded state must not contain symbolic links: ${path}`);
    if (entry.isDirectory()) { yield* stateFiles(file, standard, path); continue; }
    if (!entry.isFile()) throw new Error(`recorded state is not a regular file: ${path}`);
    if (/-wal$|-shm$/.test(entry.name)) {
      try { if ((await readBytes(file.slice(0, -4), 16)).equals(Buffer.from("SQLite format 3\0"))) continue; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    yield* stateFile(file, path, standard);
  }
}

export async function* stateFile(file, path, standard) {
  if ((await readBytes(file, 16)).equals(Buffer.from("SQLite format 3\0"))) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      yield { path, kind: "sqlite-file", value: { type: "sqlite" } };
      const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND lower(name) NOT GLOB 'sqlite_*' ORDER BY name").all();
      for (const table of tables) {
        // Virtual modules can execute native code and may be unavailable here.
        // Their declarations and ordinary persisted backing tables remain data.
        if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql)) {
          yield { path, kind: "sqlite-schema", table: table.name, value: table.sql };
          continue;
        }
        const columns = db.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all();
        const primary = columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        const rowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql) ? null : ["rowid", "_rowid_", "oid"].find((name) => !columns.some((c) => c.name.toLowerCase() === name));
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
              try { values[column.name] = { raw: value, value: JSON.parse(value) }; continue; }
              catch { /* Keep text that is not JSON, including damaged product data. */ }
            }
            const scalar = sqlValue(value);
            values[column.name] = { raw: scalar, value: scalar, encoded: scalar !== null && typeof scalar === "object" };
          }
          rows.push({ rowid: sqlValue(identity), values });
        }
        yield { path, kind: "sqlite", table: table.name, primary, rows };
      }
    } finally { db.close(); }
    return;
  }
  const bytes = await readBytes(file);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { yield { path, kind: "binary", value: sha256(bytes) }; return; }
  if (text.includes("\0")) { yield { path, kind: "binary", value: sha256(bytes) }; return; }
  try {
    if (/\.json5?$/i.test(path)) { yield { path, kind: "json", value: JSON5.parse(text) }; return; }
    if (/\.jsonl$/i.test(path)) {
      const malformed = new Set();
      const value = text.split(/\r?\n/).map((line, index) => {
        if (!line.trim()) return undefined;
        try { return JSON.parse(line); }
        catch { malformed.add(index); return line; }
      });
      yield { path, kind: "jsonl", value, malformed }; return;
    }
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
  if (!paths.length) return value;
  const result = structuredClone(value);
  const remove = (object, [part, ...rest]) => {
    if (!object || typeof object !== "object") return;
    for (const key of part === "*" ? Object.keys(object) : [part]) {
      if (rest.length) remove(object[key], rest); else delete object[key];
    }
  };
  for (const path of paths) remove(result, path.split("."));
  return result;
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
    if (!await recordedDirectory(join(directory, "state"))) throw new Error(`${phase.id}: missing state checkpoint directory`);
    for await (const file of stateFiles(join(directory, "state"), standard)) {
      const path = file.path.split("/").map((part) => pointerPart(normalize(part)));
      const dynamic = path.map((_, index) => index);
      if (file.kind === "sqlite") {
        path[path.length - 1] += `:${pointerPart(file.table)}`;
        b.add("state", path, { type: "table" }, { dynamic });
        const idColumns = new Set([...file.primary, ...standard.stateIds.filter((entry) => entry.table === file.table && matchesGlob(file.path, entry.path)).map((entry) => entry.column)]);
        for (const row of file.rows) {
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
      } else if (file.kind === "json") b.nodes("state", file.value, path, dynamic);
      else if (file.kind === "jsonl") {
        b.add("state", path, { type: "jsonl" }, { dynamic });
        file.value.forEach((value, index) => {
          if (value === undefined) return;
          const at = [...path, String(index)];
          if (file.malformed.has(index)) b.add("state", at, { invalidJSONL: normalizeText(value, normalize) }, { dynamic });
          else b.nodes("state", value, at, dynamic);
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
