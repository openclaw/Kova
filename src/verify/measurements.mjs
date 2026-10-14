import { zstdDecompressSync } from "node:zlib";
import { matchesGlob } from "node:path";
import { sha256, canonicalJSON } from "./plan.mjs";

export function responseData(value, entry) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const paths = ["gateway", "script"].includes(entry?.kind) ? ["elapsedMs", "durationMs"] : [];
  const nullablePaths = [];
  if (["status", "channels-status"].includes(entry?.id)) {
    // Pinned status/health observations, not similarly named configuration or payload fields.
    const eventLoop = ["degradedSinceMs", "intervalMs", "delayP99Ms", "delayMaxMs", "utilization", "cpuCoreRatio", "cpuBreakdown.mainThreadCoreRatio", "cpuBreakdown.workerCoreRatio", "cpuBreakdown.otherThreadsCoreRatio", "cpuBreakdown.hostUtilization"];
    paths.push(...eventLoop.map((path) => `eventLoop.${path}`));
    const channels = entry.id === "status" ? ["health.channels.*", "health.channels.*.accounts.*"] : ["channels.*", "channelAccounts.*.*"];
    nullablePaths.push("eventLoop.degradedSinceMs", ...channels.map((path) => `${path}.authAgeMs`));
    paths.push(...channels.flatMap((path) => [`${path}.probe.elapsedMs`, `${path}.probe.latencyMs`, `${path}.audit.elapsedMs`, `${path}.authAgeMs`]));
    if (entry.id === "status") paths.push("gateway.connectLatencyMs", "health.durationMs", "lastHeartbeat.durationMs", ...eventLoop.map((path) => `health.eventLoop.${path}`), "agents.agents.*.lastActiveAgeMs", "sessions.recent.*.age", "sessions.byAgent.*.recent.*.age", "linkChannel.authAgeMs", "health.sessions.recent.*.age", "health.agents.*.sessions.recent.*.age");
    if (entry.id === "status") nullablePaths.push("health.eventLoop.degradedSinceMs", "gateway.connectLatencyMs", "linkChannel.authAgeMs");
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
  return omitMeasurements(omitMeasurements(value, paths), nullablePaths, true);
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const measurement = (value) => typeof value === "number" && Number.isFinite(value);
export const agentDatabase = (path) => /^agents\/[^/]+\/agent\/openclaw-agent\.sqlite$/.test(path);
export const sessionTranscript = (path) => /^agents\/[^/]+\/sessions\/[^/]+\.jsonl(?:\.bak(?:\.[^/]+)?|\.(?:reset|deleted)\.[^/]+)?$/.test(path);
export const sessionIndex = (path) => /^(?:agents\/[^/]+\/)?sessions\/sessions\.json(?:\.bak)?$/.test(path);
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

function statusTextMeasurements(text) {
  if (typeof text !== "string") return text;
  const duration = String.raw`\d+(?:ms|[dhms])(?: ?\d+(?:ms|[dhms]))*`;
  const uptime = new RegExp(`^(⏱️ Uptime: gateway )${duration}( · system )${duration}$`);
  const session = new RegExp(`( • duration )${duration}(?= • (?:updated |no activity$))`);
  const subagent = new RegExp(`^(  • .+ · )${duration}( · .+)$`);
  let subagents = false;
  return text.split("\n").map((line) => {
    if (/^🤖 Subagents: \d+ active(?: · \d+ done)?$/.test(line)) { subagents = true; return line; }
    if (subagents && line.startsWith("  • ")) return line.replace(subagent, "$1<duration>$2");
    subagents = false;
    if (line.startsWith("🧵 Session: ")) return line.replace(session, "$1<duration>").replace(/( • updated )(?:just now|\d+[mhd] ago)$/, "$1<age>");
    return line.replace(uptime, "$1<duration>$2<duration>");
  }).join("\n");
}

function toolMeasurements(value, tool) {
  if (!record(value)) return value;
  if (tool === "exec") return omitMeasurements(value, ["durationMs"]);
  if (tool === "session_status") return mapFields(value, ["statusText"], statusTextMeasurements);
  if (tool === "web_fetch" || tool === "web_search" && ["results", "answer"].includes(value.kind)) return omitMeasurements(value, ["tookMs"]);
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

export function transcriptMeasurements(event) {
  if (!record(event) || event.type !== "message" || event.message?.role !== "toolResult") return event;
  const { message } = event;
  const details = toolMeasurements(message.details, message.toolName);
  let content = message.content;
  if (["cron", "subagents", "web_fetch", "web_search"].includes(message.toolName) && Array.isArray(content)) content = content.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    try {
      const value = JSON.parse(part.text), next = toolMeasurements(value, message.toolName);
      if (next === value) return part;
      const text = JSON.stringify(next);
      return text === part.text ? part : { ...part, text };
    } catch { return part; }
  });
  if (message.toolName === "session_status" && typeof message.details?.statusText === "string" && Array.isArray(content)) content = content.map((part) =>
    part?.type === "text" && part.text === message.details.statusText && details !== message.details ? { ...part, text: details.statusText } : part);
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

const base64Hash = (value) => Buffer.from(sha256(value), "hex").toString("base64url");
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const sqlNumber = (value) => typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const projectionQueries = new WeakMap();
const usageScope = (value) => ["session-cost-usage-rollup-v2", "session-cost-usage-rollup-v3"].includes(value);

// Match the native producer's JSON projections, including SQLite's own text
// spelling and first-key semantics. Never infer byte costs from JS rendering.
function transcriptProjectionBytes(db, text) {
  if (!db) return undefined;
  try {
    let query = projectionQueries.get(db);
    if (!query) {
      query = db.prepare(`WITH input(event) AS (VALUES (?)),
        projected(event) AS (SELECT json_remove(event, '$.message.__openclaw.upstreamUserText') FROM input),
        model(event) AS (SELECT CASE WHEN json_extract(event, '$.message.role') = 'toolResult'
          THEN json_remove(event, '$.message.details') ELSE event END FROM projected)
        SELECT octet_length(event) AS modelBytes,
          octet_length(json_remove(event, '$.message.providerReplay')) AS modelWithoutCheckpointBytes,
          (SELECT octet_length(json_remove(event, '$.data')) FROM input) AS withoutCustomDataBytes
        FROM model`);
      projectionQueries.set(db, query);
    }
    return query.get(text);
  } catch { return undefined; }
}

function navigationMeasurements(value, original, normalized, db) {
  if (!record(value) || value.version !== 1) return value;
  const before = transcriptProjectionBytes(db, original), after = transcriptProjectionBytes(db, normalized);
  if (!before || !after) return value;
  let result = value;
  for (const field of ["modelBytes", "modelWithoutCheckpointBytes", "withoutCustomDataBytes"]) {
    if (safeInteger(value[field]) && value[field] === before[field] && safeInteger(after[field]) && after[field] !== value[field]) result = { ...result, [field]: after[field] };
  }
  return result;
}

function recordedSuffix(value, relative) {
  if (typeof value !== "string") return false;
  const path = value.replaceAll("\\", "/");
  return /^(?:\/|[A-Za-z]:\/)/.test(path) && !path.split("/").some((part) => part === "." || part === "..") && path.endsWith(`/${relative}`);
}

function sqliteCacheSource(key, path) {
  if (typeof key !== "string" || !agentDatabase(path)) return undefined;
  const marker = /^sqlite:([^:]+):([^:]+):(.*)$/.exec(key);
  return marker && marker[1] === path.split("/")[1] && recordedSuffix(marker[3], path) ? marker[2] : undefined;
}

function jsonlCacheSource(key) {
  if (typeof key !== "string") return undefined;
  const path = key.replaceAll("\\", "/");
  const match = /(?:^|\/)(agents\/[^/]+\/sessions\/[^/]+)$/.exec(path);
  return match && sessionTranscript(match[1]) && recordedSuffix(path, match[1]) ? match[1] : undefined;
}

function readSourceEvent(row, compressed) {
  if (typeof row.event_json === "string") return row.event_json;
  const size = sqlNumber(row.event_utf8_bytes);
  if (!compressed || !(row.event_zstd instanceof Uint8Array) || !safeInteger(size) || size < 1 || size > 4 * 1024 * 1024) return undefined;
  try {
    const bytes = zstdDecompressSync(row.event_zstd, { maxOutputLength: size });
    return bytes.byteLength === size ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : undefined;
  } catch { return undefined; }
}

// A cache session can have both v2 and v3 rows, possibly at different retained
// prefixes. Stream it once and retain only the requested checkpoint summaries.
function sqliteCheckpointSources(file, context) {
  const wanted = new Map(), sources = new Map();
  for (const row of file.rows) {
    if (!usageScope(row.values.scope?.raw)) continue;
    const checkpoint = row.values.value_json?.value?.checkpoint;
    const session = sqliteCacheSource(row.values.key?.raw, file.path);
    if (session === undefined || checkpoint?.kind !== "sqlite" || !safeInteger(checkpoint.maxSeq)) continue;
    if (!wanted.has(session)) wanted.set(session, new Set());
    wanted.get(session).add(checkpoint.maxSeq);
  }
  if (!wanted.size || !context.db) return sources;
  try {
    const db = context.db;
    const tables = new Map(db.prepare("PRAGMA main.table_list").all().filter((table) => table.schema === "main").map((table) => [table.name, table.type]));
    if (tables.get("transcript_events") !== "table") return sources;
    const columns = new Set(db.prepare('PRAGMA main.table_xinfo("transcript_events")').all().map((column) => column.name));
    if (!["session_id", "seq", "event_json"].every((column) => columns.has(column))) return sources;
    const compressed = (context.standard?.compressed ?? []).some((entry) => entry.table === "transcript_events" && entry.column === "event_zstd" && entry.codec === "zstd" && matchesGlob(file.path, entry.path));
    const query = db.prepare(`SELECT seq, event_json, octet_length(event_json) AS native_bytes,
      ${columns.has("event_zstd") ? "event_zstd" : "NULL AS event_zstd"},
      ${columns.has("event_utf8_bytes") ? "event_utf8_bytes" : "NULL AS event_utf8_bytes"}
      FROM transcript_events WHERE session_id = ? AND seq <= ? ORDER BY seq`);
    query.setReadBigInts(true);
    const nativeBytes = db.prepare("SELECT octet_length(?) AS bytes");
    const cold = tables.get("session_transcript_cold_archives") === "table" ? db.prepare("SELECT 1 FROM session_transcript_cold_archives WHERE session_id = ? LIMIT 1") : null;
    for (const [session, checkpoints] of wanted) {
      if (cold?.get(session)) continue; // Packed cold sources remain opaque.
      const snapshots = new Map();
      if (checkpoints.has(0)) snapshots.set(0, { count: 0, size: 0, normalizedSize: 0, sizeValid: true, anchor: base64Hash(""), normalizedAnchor: base64Hash("") });
      let count = 0, size = 0, normalizedSize = 0, sizeValid = true;
      let lastSeq = 0;
      for (const seq of checkpoints) lastSeq = Math.max(lastSeq, seq);
      for (const row of query.iterate(session, lastSeq)) {
        const seq = sqlNumber(row.seq), recordedBytes = sqlNumber(row.event_utf8_bytes ?? row.native_bytes);
        const text = readSourceEvent(row, compressed);
        let normalizedText = text, anchor, normalizedAnchor;
        if (text !== undefined) {
          try {
            const event = JSON.parse(text), normalized = transcriptMeasurements(event);
            anchor = base64Hash(JSON.stringify(event));
            normalizedAnchor = base64Hash(JSON.stringify(normalized));
            if (normalized !== event) normalizedText = JSON.stringify(normalized);
          } catch { sizeValid = false; }
        } else sizeValid = false;
        const actualBytes = text === undefined ? undefined : row.event_utf8_bytes === null ? sqlNumber(row.native_bytes) : Buffer.byteLength(text);
        if (!safeInteger(recordedBytes) || actualBytes !== recordedBytes) sizeValid = false;
        const nextBytes = normalizedText === undefined ? undefined : row.event_utf8_bytes === null ? nativeBytes.get(normalizedText).bytes : Buffer.byteLength(normalizedText);
        size += (count ? 1 : 0) + (safeInteger(recordedBytes) ? recordedBytes : 0);
        normalizedSize += (count ? 1 : 0) + (safeInteger(nextBytes) ? nextBytes : 0);
        count += 1;
        if (checkpoints.has(seq)) snapshots.set(seq, { count, size, normalizedSize, sizeValid, anchor, normalizedAnchor });
      }
      sources.set(session, snapshots);
    }
  } catch { /* Missing or malformed source/schema cannot authorize normalization. */ }
  return sources;
}

function normalizedJsonlPrefix(bytes, offset, observedSize) {
  let length = 0, tail = Buffer.alloc(0), changed = false;
  const append = (chunk) => {
    length += chunk.length;
    tail = chunk.length >= 4096 ? Buffer.from(chunk.subarray(chunk.length - 4096)) : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.length - 4096)), chunk]);
  };
  for (let start = 0; start < offset;) {
    const newline = bytes.indexOf(10, start), end = newline >= 0 && newline < offset ? newline : offset;
    const terminated = end < offset;
    const contentEnd = terminated && bytes[end - 1] === 13 ? end - 1 : end;
    const raw = bytes.subarray(start, contentEnd);
    let replacement = raw, completeRecord = false;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      const event = JSON.parse(text.trim());
      completeRecord = record(event);
      const normalized = transcriptMeasurements(event);
      if (normalized !== event) {
        replacement = Buffer.from(JSON.stringify(normalized));
        changed = true;
      }
    } catch { /* Preserve malformed records byte-for-byte. */ }
    if (!terminated && (offset !== observedSize || !completeRecord)) return undefined;
    append(replacement);
    if (terminated) append(bytes.subarray(contentEnd, end + 1));
    start = terminated ? end + 1 : offset;
  }
  return { length, anchor: base64Hash(tail), changed };
}

function jsonlCheckpointRequests(file) {
  const sources = new Map();
  for (const row of file.rows) {
    if (!usageScope(row.values.scope?.raw)) continue;
    const checkpoint = row.values.value_json?.value?.checkpoint;
    const path = jsonlCacheSource(row.values.key?.raw);
    if (!path || checkpoint?.kind !== "jsonl" || !safeInteger(checkpoint.parsedOffset) || !safeInteger(checkpoint.observedSize) || checkpoint.parsedOffset > checkpoint.observedSize || typeof checkpoint.anchorHash !== "string") continue;
    if (!sources.has(path)) sources.set(path, new Map());
    const key = canonicalJSON([checkpoint.parsedOffset, checkpoint.observedSize]);
    const requests = sources.get(path);
    if (!requests.has(key)) requests.set(key, { offset: checkpoint.parsedOffset, size: checkpoint.observedSize, anchors: new Set() });
    requests.get(key).anchors.add(checkpoint.anchorHash);
  }
  return sources;
}

async function jsonlCheckpointSources(path, requests, readState) {
  const snapshots = new Map();
  const bytes = await readState(path);
  if (!(bytes instanceof Uint8Array)) return snapshots;
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [key, request] of requests ?? []) {
    if (request.size > source.length) continue;
    const anchor = base64Hash(source.subarray(Math.max(0, request.offset - 4096), request.offset));
    if (!request.anchors.has(anchor)) continue;
    const normalized = normalizedJsonlPrefix(source, request.offset, request.size);
    snapshots.set(key, { anchor, normalized });
  }
  // Only small summaries survive this read; neither the source Buffer nor
  // normalized transcript bodies accumulate across an agent's cached sessions.
  return snapshots;
}

async function cacheCheckpointMeasurements(file, values, context) {
  const checkpoint = values.value_json?.value?.checkpoint;
  if (!record(checkpoint) || typeof checkpoint.anchorHash !== "string") return checkpoint;
  if (checkpoint.kind === "sqlite") {
    const session = sqliteCacheSource(values.key?.raw, file.path);
    const source = context.sqliteSources?.get(session)?.get(checkpoint.maxSeq);
    if (!source || source.anchor !== checkpoint.anchorHash) return checkpoint;
    let result = checkpoint;
    if (source.normalizedAnchor !== source.anchor) result = { ...result, anchorHash: source.normalizedAnchor };
    if (source.sizeValid && checkpoint.eventCount === source.count && checkpoint.size === source.size && source.normalizedSize !== source.size) result = { ...result, size: source.normalizedSize };
    return result;
  }
  if (checkpoint.kind !== "jsonl" || !safeInteger(checkpoint.parsedOffset) || !safeInteger(checkpoint.observedSize) || checkpoint.parsedOffset > checkpoint.observedSize || !context.readState) return checkpoint;
  const path = jsonlCacheSource(values.key?.raw);
  if (!path) return checkpoint;
  if (!context.jsonlSources.has(path)) context.jsonlSources.set(path, jsonlCheckpointSources(path, context.jsonlRequests.get(path), context.readState));
  const snapshots = await context.jsonlSources.get(path);
  const offset = checkpoint.parsedOffset;
  const source = snapshots.get(canonicalJSON([offset, checkpoint.observedSize]));
  if (source?.anchor !== checkpoint.anchorHash) return checkpoint;
  const normalized = source.normalized;
  return normalized?.changed ? { ...checkpoint, parsedOffset: normalized.length, observedSize: checkpoint.observedSize + normalized.length - offset, anchorHash: normalized.anchor } : checkpoint;
}

async function persistedRowMeasurements(file, row, context) {
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
      if (typeof original === "string" && values[payload] !== row.values[payload]) json("navigation_json", (value) => navigationMeasurements(value, original, values[payload].raw, context.db));
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
      if (["session-cost-usage-rollup-v2", "session-cost-usage-rollup-v3"].includes(values.scope?.raw) && !file.primary.includes("value_json")) {
        const checkpoint = await cacheCheckpointMeasurements(file, values, context);
        if (checkpoint !== values.value_json?.value?.checkpoint) json("value_json", (value) => ({ ...value, checkpoint }));
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

export async function persistedRowsMeasurements(file, context = {}) {
  const cache = agentDatabase(file.path) && file.table === "cache_entries";
  const sources = { ...context, jsonlSources: new Map(), jsonlRequests: cache ? jsonlCheckpointRequests(file) : new Map(), sqliteSources: cache ? sqliteCheckpointSources(file, context) : new Map() };
  const rows = [];
  for (const row of file.rows) rows.push(await persistedRowMeasurements(file, row, sources));
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


export const sessionIndexMeasurements = (value) => omitMeasurements(value, ["*.runtimeMs"]);
