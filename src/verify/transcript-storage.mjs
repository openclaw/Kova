import { matchesGlob } from "node:path";

// Pinned native transcript payload v1. The field lists and projections follow
// session-model-context-projection.ts; report classification follows
// session-entry-codec.ts and session-transcript-report-facts.ts. These are data
// checks on a recording, without importing or executing an OpenClaw runtime.
const payloadColumns = ["event_json", "event_zstd", "event_utf8_bytes", "navigation_json"];
const treeFields = ["type", "id", "parentId", "targetId", "appendParentId", "appendMode"];
const modelFields = [...treeFields, "timestamp", "version", "cwd", "firstKeptEntryId", "reason", "tokensBefore", "thinkingLevel", "provider", "modelId", "fromId", "customType", "display", "label", "name"];
const messageFields = ["role", "provider", "model", "timestamp", "excludeFromContext", "toolCallId", "toolUseId", "tool_call_id", "tool_use_id", "callId", "call_id", "toolName", "isError", "stopReason", "customType", "display"];
const syntheticField = "openclawSyntheticMissingToolResult";
const missingResult = "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value) => typeof value === "string";
const nonempty = (value) => string(value) && value.length > 0;
const optional = (value, field, check) => value[field] === undefined || check(value[field]);
const parent = (value) => value === null || string(value);
const content = (value) => string(value) || Array.isArray(value) && value.every((part) => record(part) && string(part.type));

function readableMessage(value) {
  if (!record(value)) return false;
  switch (value.role) {
    case "user": case "assistant": return content(value.content);
    case "toolResult": return string(value.toolCallId) && string(value.toolName) && typeof value.isError === "boolean" && Array.isArray(value.content);
    // The entry owner supplies the legacy "hook" type before classification.
    case "custom": return (value.customType === undefined || string(value.customType)) && content(value.content);
    case "bashExecution": return string(value.command) && string(value.output);
    default: return false;
  }
}

function indexedEntry(value) {
  if (!record(value) || !nonempty(value.id) || !optional(value, "parentId", parent) || !optional(value, "timestamp", string)) return false;
  switch (value.type) {
    case "message": return readableMessage(value.message);
    case "thinking_level_change": return nonempty(value.thinkingLevel);
    case "model_change": return nonempty(value.provider) && nonempty(value.modelId);
    case "compaction": return string(value.summary) && nonempty(value.firstKeptEntryId) && typeof value.tokensBefore === "number";
    case "reset": return ["new", "reset", "idle", "daily", "cron-stale"].includes(String(value.reason)) && optional(value, "firstKeptEntryId", string);
    case "branch_summary": return string(value.fromId) && string(value.summary);
    case "custom": return nonempty(value.customType);
    case "custom_message": return nonempty(value.customType) && content(value.content) && typeof value.display === "boolean";
    case "label": return nonempty(value.targetId) && optional(value, "label", string);
    case "session_info": return optional(value, "name", string);
    default: return false;
  }
}

function reportFacts(value) {
  if (indexedEntry(value)) {
    const entry = { id: value.id, parentId: value.parentId, timestamp: value.timestamp, appendMode: value.appendMode, type: value.type };
    if (value.type === "label") Object.assign(entry, { targetId: value.targetId, label: value.label });
    if (value.type === "custom_message") entry.customType = value.customType;
    if (value.type === "message" && value.message.role === "assistant") {
      const runId = record(value.message.__openclaw) && value.message.__openclaw.runId;
      if (string(runId) && runId.trim()) entry.assistantRunId = runId.trim();
      if (string(value.message.responseId)) entry.assistantResponseId = value.message.responseId;
    }
    return { kind: "canonical", hasParentId: Object.hasOwn(value, "parentId"), entry };
  }
  if (record(value) && value.type === "leaf" && nonempty(value.id) && parent(value.parentId) && parent(value.targetId) && optional(value, "appendParentId", parent) && optional(value, "appendMode", (mode) => mode === "side")) {
    return { kind: "leaf", entry: { id: value.id, parentId: value.parentId, targetId: value.targetId, ...(value.appendParentId !== undefined ? { appendParentId: value.appendParentId } : {}), ...(value.appendMode === "side" ? { appendMode: "side" } : {}) } };
  }
  if (record(value) && value.type !== "session" && value.type !== "leaf" && nonempty(value.id) && parent(value.parentId)) return { kind: "link", id: value.id, parentId: value.parentId };
  return { kind: "ignored" };
}

// All SQL fragments below are fixed selectors; recording data is always bound.
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const fields = (values) => values.map(literal).join(", ");
const member = (alias) => `CASE ${alias}.type WHEN 'object' THEN json(${alias}.value) WHEN 'array' THEN json(${alias}.value) WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') ELSE ${alias}.value END`;
const pick = (value, names) => `(SELECT json_group_object(key, CASE type WHEN 'object' THEN json(value) WHEN 'array' THEN json(value) WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') ELSE value END) FROM json_each(${value}) WHERE key IN (${fields(names)}))`;

function payloadNavigation(event) {
  const internal = pick("message_member.value", ["runId", "steerTargetRunId", "contextFreeCommand"]);
  const message = `(SELECT json_group_object(message_member.key,
    CASE WHEN message_member.key = '__openclaw' AND message_member.type = 'object' THEN json(${internal}) ELSE ${member("message_member")} END)
    FROM json_each(root_member.value) AS message_member WHERE message_member.key IN ('role', 'idempotencyKey', 'provenance', 'excludeFromContext', '__openclaw'))`;
  return `(SELECT json_group_object(root_member.key,
    CASE WHEN root_member.key = 'message' AND root_member.type = 'object' THEN json(${message}) ELSE ${member("root_member")} END)
    FROM json_each(${event}) AS root_member WHERE root_member.key IN (${fields([...modelFields, "message"])}))`;
}

function resetNavigation(event) {
  const entry = pick(event, [...treeFields, "timestamp", "firstKeptEntryId", "customType", "display"]);
  return `CASE WHEN json_valid(${event}) THEN CASE WHEN json_type(${event}) = 'object'
    THEN json_set(${entry}, '$.message', json_object('role', json_extract(${event}, '$.message.role'))) ELSE ${event} END ELSE ${event} END`;
}

const operatorKind = (event) => `CASE WHEN json_extract(${event}, '$.customType') = 'openclaw.system-update'
  AND json_extract(${event}, '$.details.kind') IN ('prompt-update', 'runtime-context') THEN json_extract(${event}, '$.details.kind') ELSE NULL END`;
const contentProperty = (event, name) => `CASE WHEN typeof(key) = 'integer' AND key < 8 THEN json_extract(${event}, fullkey || ${literal(`.${name}`)}) ELSE json_extract(value, ${literal(`$.${name}`)}) END`;

function modelNavigation(event, jsonb) {
  const entry = pick(event, modelFields);
  const message = `${jsonb ? "jsonb_extract" : "json_extract"}(${event}, '$.message')`;
  const messageFacts = pick(message, messageFields);
  const messageKind = operatorKind(message), entryKind = operatorKind(event);
  const custom = `json_set(${entry}, '$.content', json('[]'))`;
  const calls = `(SELECT json_group_array(json_object('type', ${contentProperty(event, "type")}, 'id', ${contentProperty(event, "id")}, 'name', ${contentProperty(event, "name")}))
    FROM json_each(${event}, '$.message.content') WHERE type = 'object' AND ${contentProperty(event, "type")} IN ('toolCall', 'toolUse', 'functionCall'))`;
  const synthetic = `COALESCE(json_extract(${event}, '$.message.details.${syntheticField}'), 0) = 1 OR EXISTS (
    SELECT 1 FROM json_each(${event}, '$.message.content') WHERE type = 'object' AND ${contentProperty(event, "type")} = 'text' AND ${contentProperty(event, "text")} = ${literal(missingResult)})`;
  return `CASE json_extract(${event}, '$.type')
    WHEN 'message' THEN json_set(${entry}, '$.message', json_set(${messageFacts},
      '$.content', json(${calls}), '$.command', '', '$.output', '',
      '$.providerReplay', json_object('type', json_extract(${event}, '$.message.providerReplay.type')),
      '$.details', json_patch(json_object('${syntheticField}', json(CASE WHEN (${synthetic}) THEN 'true' ELSE 'false' END)),
        CASE WHEN ${messageKind} IS NULL THEN json('{}') ELSE json_object('kind', ${messageKind}) END)))
    WHEN 'custom_message' THEN CASE WHEN ${entryKind} IS NULL THEN ${custom} ELSE json_set(${custom}, '$.details', json_object('kind', ${entryKind})) END
    WHEN 'custom' THEN CASE WHEN json_extract(${event}, '$.customType') = 'openclaw.system-prompt'
      THEN json_set(${entry}, '$.data', json_object('restart', json(CASE WHEN json_type(${event}, '$.data.restart') = 'true' THEN 'true' ELSE 'false' END))) ELSE ${entry} END
    WHEN 'compaction' THEN json_set(${entry}, '$.summary', '')
    WHEN 'branch_summary' THEN json_set(${entry}, '$.summary', '') ELSE ${entry} END`;
}

function modelEvent(event, omitCheckpoint) {
  const projected = `json_remove(${event}, '$.message.__openclaw.upstreamUserText')`;
  const model = `CASE WHEN json_extract(${event}, '$.message.role') = 'toolResult' THEN json_remove(${projected}, '$.message.details') ELSE ${projected} END`;
  return omitCheckpoint ? `json_remove(${model}, '$.message.providerReplay')` : model;
}

const projections = new WeakMap();
const encodings = new WeakMap();
const utf8Storage = (db) => {
  if (!db) return false;
  if (!encodings.has(db)) encodings.set(db, db.prepare("PRAGMA encoding").get()?.encoding === "UTF-8");
  return encodings.get(db);
};

function nativeNavigation(db, text, report) {
  let query = projections.get(db);
  if (query === undefined) {
    if (!utf8Storage(db)) {
      projections.set(db, null);
      return undefined;
    }
    let jsonb = false;
    try { db.prepare("SELECT jsonb('{}')").get(); jsonb = true; } catch { /* SQLite 3.44 uses JSON text. */ }
    const event = "source.event_projection", original = "source.event_json";
    query = db.prepare(`WITH input(event_json, report_json) AS (VALUES (?, ?)),
      source AS NOT MATERIALIZED (SELECT event_json, report_json,
        ${jsonb ? "CASE WHEN json_valid(event_json) THEN jsonb(event_json) ELSE event_json END" : "event_json"} AS event_projection FROM input),
      metadata AS MATERIALIZED (SELECT CASE WHEN json_valid(${original}) AND json_valid(source.report_json) THEN CASE
        WHEN json_type(${event}) != 'object' OR coalesce(json_type(${event}, '$.message'), 'null') NOT IN ('object', 'null') THEN NULL
        ELSE json_object('version', 1, 'report', json(source.report_json),
          'navigation', json(${payloadNavigation(event)}), 'reset', json(${resetNavigation(original)}), 'model', json(${modelNavigation(event, jsonb)}),
          'modelBytes', octet_length(${modelEvent(event, false)}), 'modelWithoutCheckpointBytes', octet_length(${modelEvent(event, true)}),
          'withoutCustomDataBytes', octet_length(json_remove(${event}, '$.data'))) END ELSE NULL END AS navigation_json FROM source)
      SELECT CASE WHEN json_valid(navigation_json) AND octet_length(navigation_json) <= 16384 THEN navigation_json ELSE NULL END AS navigation_json FROM metadata`);
    projections.set(db, query);
  }
  return query?.get(text, JSON.stringify(report))?.navigation_json ?? undefined;
}

/** Attest a native logical event before a comparison folds its physical columns. */
export function verifiedTranscriptStorage(file, row, db, standard) {
  if (file.table !== "transcript_events" || !/^agents\/[^/]+\/agent\/openclaw-agent\.sqlite$/.test(file.path) || payloadColumns.some((column) => file.primary.includes(column) || !Object.hasOwn(row.values, column))) return undefined;
  if (!(standard?.compressed ?? []).some((entry) => entry.table === file.table && entry.column === "event_zstd" && entry.codec === "zstd" && matchesGlob(file.path, entry.path))) return undefined;
  if (!utf8Storage(db)) return undefined;
  const values = row.values, identity = values.event_json, compressed = values.event_zstd, size = values.event_utf8_bytes, navigation = values.navigation_json;
  const plain = identity.storageType === "text" && compressed.storageType === "null";
  const packed = identity.storageType === "null" && compressed.storageType === "blob";
  if (!plain && !packed) return undefined;
  const active = plain ? identity : compressed;
  if (active.encoded || typeof active.raw !== "string" || active.value === active.raw) return undefined;
  const text = active.raw, event = active.value, bytes = Buffer.byteLength(text);
  if (plain && identity.storedBytes !== bytes) return undefined;
  if (size.storageType !== "integer" || !Number.isSafeInteger(size.raw) || size.raw < 0 || size.raw !== bytes) return undefined;
  if (packed && (size.storageType !== "integer" || bytes < 1 || bytes > 4 * 1024 * 1024 || !Number.isSafeInteger(compressed.storedBytes) || compressed.storedBytes < 1 || compressed.storedBytes > 4 * 1024 * 1024)) return undefined;
  if (plain) return navigation.storageType === "null" ? { text, event } : undefined;
  if (!db || navigation.storageType !== "text" || navigation.encoded || typeof navigation.raw !== "string" || navigation.storedBytes !== Buffer.byteLength(navigation.raw) || navigation.storedBytes > 16384) return undefined;
  // Header rows deliberately have no stored projection. Everything else must
  // match the complete native envelope, including duplicate-key ordering and
  // all derived byte costs. Unknown, reformatted or damaged metadata stays raw.
  if (record(event) && event.type === "session" && string(event.id)) return undefined;
  try {
    const expected = nativeNavigation(db, text, reportFacts(event));
    return expected !== undefined && expected === navigation.raw ? { text, event } : undefined;
  } catch { return undefined; }
}
