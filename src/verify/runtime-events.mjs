import { agentDatabase, VerifiedValue } from "./measurements.mjs";
import { canonicalJSON } from "./plan.mjs";

// Only decoded cells create this wrapper. Application JSON with the same
// visible shape remains a traversed object rather than an opaque SQL value.
export class RuntimeOpaqueValue {
  constructor(value) { this.value = value; }
  toJSON() { return this.value; }
}

export function runtimeEventSignature(value) {
  const typed = (value) => {
    if (value instanceof RuntimeOpaqueValue) return ["opaque", typed(value.value)];
    if (value instanceof VerifiedValue) return ["verified", value.constructor.name, typed(value.value)];
    if (value === null) return ["null"];
    if (Array.isArray(value)) return ["array", value.map(typed)];
    if (typeof value === "object") return ["object", Object.keys(value).sort().map((key) => [key, typed(value[key])])];
    if (typeof value === "undefined") return ["undefined"];
    if (typeof value === "bigint") return ["bigint", String(value)];
    if (typeof value === "number") return ["number", Number.isFinite(value) ? value : String(value)];
    if (["string", "boolean"].includes(typeof value)) return [typeof value, value];
    throw new Error("unsupported runtime comparison value");
  };
  return canonicalJSON(typed(value));
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof VerifiedValue);
const sequence = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const absent = Object.freeze({ absent: true });
const pointer = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");

export const runtimeEventFile = (file) => agentDatabase(file.path) && file.table === "trajectory_runtime_events";

function nativeEvent(values) {
  const cell = values.event_json, event = cell?.value;
  if (!cell || cell.encoded || typeof cell.raw !== "string" || !record(event) ||
      event.traceSchema !== "openclaw-trajectory" || event.schemaVersion !== 1 || event.source !== "runtime" ||
      typeof event.type !== "string" || !event.type || typeof values.session_id?.raw !== "string" ||
      !values.session_id.raw || values.session_id.encoded || event.sessionId !== values.session_id.raw || event.traceId !== event.sessionId ||
      !values.run_id || values.run_id.encoded ||
      !(values.run_id.raw === null ? event.runId === undefined : typeof values.run_id.raw === "string" && event.runId === values.run_id.raw) ||
      values.seq?.encoded || !sequence(values.seq?.raw, 0) || !sequence(event.seq, 1) ||
      event.sourceSeq !== undefined && (!sequence(event.sourceSeq, 1) || event.sourceSeq !== event.seq) ||
      values.created_at?.encoded || !Number.isSafeInteger(values.created_at?.raw) || typeof event.ts !== "string") return undefined;
  const timestamp = Date.parse(event.ts);
  // runtime.ts emits toISOString(); runtime-store.sqlite.ts copies its parsed
  // milliseconds into created_at. Retain inconsistent or malformed metadata.
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== event.ts || values.created_at.raw !== timestamp) return undefined;
  return event;
}

// Return content for multiset comparison. SQLite rowids and storage sequence
// positions are not event identity. Keep every payload/unknown column and only
// project metadata proven to come from the native runtime event producer.
export function runtimeEventContent(file, row, { normalize = (value) => value, report = () => {} } = {}) {
  if (!runtimeEventFile(file)) return undefined;
  const visit = (value, at) => {
    if (typeof value === "string") return normalize(value, at);
    if (value instanceof VerifiedValue) return value;
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${at}/${index}`));
    if (!record(value)) return value;
    const keys = new Set();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      const childAt = `${at}/${pointer(key)}`;
      const normalized = normalize(key, childAt);
      if (keys.has(normalized)) throw new Error("normalization produced duplicate JSON keys");
      keys.add(normalized);
      return [normalized, visit(child, childAt)];
    }));
  };
  const event = nativeEvent(row.values);
  const remove = (at, before, category, reason) => report({ at, category, reason, before, after: absent });
  const columns = [];
  const keys = new Set();
  for (const [column, cell] of Object.entries(row.values)) {
    if (event && ["seq", "created_at"].includes(column)) {
      remove(pointer(column), cell.raw, column === "seq" ? "derived" : "measurements",
        column === "seq" ? "native runtime event storage sequence" : "native runtime event timestamp copied into storage");
      continue;
    }
    let value = cell.value;
    if (event && column === "event_json") {
      value = Object.fromEntries(Object.entries(event).filter(([key, child]) => {
        if (!["seq", "sourceSeq", "ts"].includes(key)) return true;
        remove(`event_json/${pointer(key)}`, child, key === "ts" ? "measurements" : "derived",
          key === "ts" ? "native runtime event observation time" : "native runtime recorder sequence");
        return false;
      }));
    }
    // Retain the SQL scalar type, including malformed sequence/timestamp TEXT
    // whose spelling is also JSON. The event payload is decoded JSON; encoded
    // cell markers must not receive product-string normalization.
    if (["session_id", "run_id", "seq", "created_at"].includes(column) && !cell.encoded) value = cell.raw;
    const at = pointer(column);
    const key = normalize(column, at);
    if (keys.has(key)) throw new Error("normalization produced duplicate JSON keys");
    keys.add(key);
    columns.push([key, cell.encoded ? new RuntimeOpaqueValue(value) : visit(value, at)]);
  }
  return Object.fromEntries(columns);
}
