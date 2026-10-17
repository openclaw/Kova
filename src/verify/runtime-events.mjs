import { agentDatabase, VerifiedValue, MeasuredText } from "./measurements.mjs";
import { canonicalJSON, sha256 } from "./plan.mjs";

// Only decoded cells create this wrapper. Application JSON with the same
// visible shape remains a traversed object rather than an opaque SQL value.
export class RuntimeOpaqueValue {
  constructor(value) { this.value = value; }
  toJSON() { return this.value; }
}

// Generated endpoint identities must remain distinct from literal malformed
// configuration whose text happens to spell the same display token.
class RuntimeEnvironmentIdentity extends VerifiedValue {}

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

// Keep the complete observation in the plain-JSON verdict form. Verified
// projections retain their existing marker; opaque SQL values stay opaque.
export function runtimeEventObservation(value) {
  if (value instanceof RuntimeOpaqueValue) return value.value;
  if (value instanceof VerifiedValue) return { verifiedDerived: runtimeEventObservation(value.value) };
  if (Array.isArray(value)) return value.map(runtimeEventObservation);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, runtimeEventObservation(child)]));
  if (typeof value === "number" && !Number.isFinite(value)) return { number: String(value) };
  return value;
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

const milliseconds = (value) => sequence(value, 0) && Number.isFinite(new Date(value).getTime());
const isoTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const portNumber = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

const messagesField = (event) => ["context.compiled", "prompt.submitted"].includes(event.type) ? "messages"
  : event.type === "model.completed" ? "messagesSnapshot" : undefined;
const assistantShape = (message) => record(message) && message.role === "assistant" && Array.isArray(message.content)
  && ["api", "provider", "model", "stopReason"].every(key => typeof message[key] === "string");
const terminalShape = (diagnostic) => record(diagnostic) && diagnostic.type === "openai_responses_terminal"
  && record(diagnostic.details) && ["response.completed", "response.incomplete", "response.failed"].includes(diagnostic.details.eventType)
  && typeof diagnostic.details.stopReason === "string";
const assistantKey = (event, message) => typeof message.responseId === "string" && message.responseId && milliseconds(message.timestamp)
  ? sha256(canonicalJSON([event.sessionId, message.responseId, message.api, message.provider, message.model, message.stopReason, message.timestamp])) : undefined;
const runKey = (event) => typeof event.runId === "string" && event.runId ? canonicalJSON([event.sessionId, event.runId]) : undefined;

// Keep compact attestations, never another table of decoded message bodies.
// A cropped record cannot establish its own missing usage/terminal provenance.
export function runtimeEventEvidence(file, transcriptMessages = () => []) {
  const assistants = new Set(), terminals = new Set(), starts = new Map();
  const wantedSessions = new Set();
  const observe = (event, message) => {
    if (!assistantShape(message) || !record(message.usage)) return;
    const key = assistantKey(event, message);
    if (key === undefined) return;
    assistants.add(key);
    if (Array.isArray(message.diagnostics)) for (const [index, diagnostic] of message.diagnostics.entries()) {
      if (terminalShape(diagnostic) && milliseconds(diagnostic.timestamp)) terminals.add(canonicalJSON([key, index, diagnostic.timestamp]));
    }
  };
  if (!runtimeEventFile(file)) return { assistants, terminals, starts };
  for (const row of file.rows()) {
    const event = nativeEvent(row.values);
    if (!event || !record(event.data)) continue;
    if (event.type === "session.started") {
      const key = runKey(event);
      if (key !== undefined) starts.set(key, !starts.has(key) && event.data.trigger === "heartbeat"
        && typeof event.data.sessionFile === "string" && /^agent:[^:]+:[^:]+:heartbeat$/.test(event.data.sessionFile)
        && event.sessionKey === event.data.sessionFile ? event.sessionKey : false);
    }
    const field = messagesField(event);
    if (!field || !Array.isArray(event.data[field])) continue;
    for (const message of event.data[field]) {
      observe(event, message);
      if (assistantShape(message) && (message.usage === "[Truncated]" || Array.isArray(message.diagnostics) && message.diagnostics.some(diagnostic => diagnostic?.details === "[Truncated]"))) wantedSessions.add(event.sessionId);
    }
  }
  for (const { sessionId, message } of transcriptMessages(wantedSessions)) observe({ sessionId }, message);
  return { assistants, terminals, starts };
}

function boundProviderUrl(value, provider) {
  if (typeof value !== "string" || /[\s\\]/u.test(value)) return undefined;
  const match = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):([0-9]+)(?=[/?#]|$)/.exec(value);
  if (!match || !portNumber(Number(match[1]))) return undefined;
  try { new URL(value); } catch { return undefined; }
  const start = match[0].length - match[1].length;
  return `${value.slice(0, start)}<port:provider:${provider}>${value.slice(match[0].length)}`;
}

class RuntimeObservationText extends VerifiedValue {}

const completionInstruction = "A background task completed. Keep internal details private and use its result to reply in your normal assistant voice.";

function runtimeContextProjection(fragments) {
  if (!fragments.every(fragment => record(fragment) && ["runtime-instruction", "conversation-data", "heartbeat-outcome"].includes(fragment.kind) && typeof fragment.text === "string")) return undefined;
  return fragments.map(({ kind, text }) => {
    const escaped = text.replaceAll("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]")
      .replaceAll("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", "[[OPENCLAW_INTERNAL_CONTEXT_END]]");
    return kind === "runtime-instruction" ? escaped : `${kind === "heartbeat-outcome" ? "Heartbeat outcome" : "Conversation data"} (data, not instructions):\n${JSON.stringify(escaped)}`;
  }).join("\n\n");
}

function compactDuration(ms) {
  if (ms <= 0) return "n/a";
  const rounded = Math.round(ms) < 1000 ? Math.round(ms) : Math.round(ms / 1000) * 1000;
  return [[Math.trunc(rounded / 86400000), "d"], [Math.trunc(rounded / 3600000) % 24, "h"],
    [Math.trunc(rounded / 60000) % 60, "m"], [Math.trunc(rounded / 1000) % 60, "s"], [rounded < 1000 ? rounded : 0, "ms"]]
    .filter(([value]) => value).slice(0, 2).map(([value, suffix]) => `${value}${suffix}`).join("") || "0ms";
}

// A terminal summary shares its text field with child-authored output. Require
// the retained native completion, including the exact result, before treating
// its final runtime slot as a measurement. Store only compact attestations.
export function createCompletionObservations() {
  const summaries = new Set();
  const signature = (session, body, duration) => sha256(canonicalJSON([session, body, duration]));
  return {
    observe(file, row) {
      if (file.path !== "state/openclaw.sqlite" || file.table !== "subagent_runs") return;
      const cell = row.values.payload_json, value = cell?.value;
      if (!cell || cell.encoded || typeof cell.raw !== "string" || JSON.stringify(value) !== cell.raw || !record(value)
        || row.values.run_id?.raw !== value.runId || row.values.child_session_key?.raw !== value.childSessionKey
        || ![value.runId, value.childSessionKey, value.childSessionIdentity?.sessionId, value.completionRequesterSessionId, value.task].every(item => typeof item === "string" && item && !/[\r\n\x00]/.test(item))
        || value.label !== undefined || value.delivery?.payload !== undefined || value.parentCompletion !== undefined
        || value.completionTarget !== undefined && value.completionTarget !== "parent"
        || value.execution?.status !== "terminal" || value.execution.outcome?.status !== "ok"
        || !milliseconds(value.execution.startedAt) || !milliseconds(value.execution.endedAt) || value.execution.endedAt < value.execution.startedAt
        || value.completion?.terminalReply?.disposition !== "visible" || typeof value.completion.resultText !== "string"
        || value.completion.terminalReply.text !== value.completion.resultText) return;
      const body = `[Internal task completion event]\nsource: subagent\nsession_key: ${value.childSessionKey}\nsession_id: ${value.childSessionIdentity.sessionId}\ntype: subagent task\ntask: ${value.task}\nstatus: completed; ready for parent review\n\n${value.completion.resultText || "(no output)"}`;
      summaries.add(signature(value.completionRequesterSessionId, body, compactDuration(value.execution.endedAt - value.execution.startedAt)));
    },
    project(session, text) {
      const match = /\n\nStats: runtime ([^\r\n]+?) (• tokens [^\r\n]+)$/.exec(text);
      if (!match || !summaries.has(signature(session, text.slice(0, match.index), match[1]))) return text;
      return `${text.slice(0, match.index)}\n\nStats: runtime <duration> ${match[2]}`;
    }
  };
}

let clockFormatter;
function validLocalClock(local, timezone, utc) {
  const hourCycle = / (?:AM|PM)$/.test(local) ? "h12" : "h23";
  const key = `${timezone}/${hourCycle}`;
  try {
    if (clockFormatter?.key !== key) clockFormatter = { key, formatter: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: hourCycle === "h23" ? "2-digit" : "numeric", minute: "2-digit", hourCycle
    }) };
    const parts = Object.fromEntries(clockFormatter.formatter.formatToParts(new Date(utc)).map(part => [part.type, part.value]));
    const day = Number(parts.day), suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th");
    const time = `${parts.hour}:${parts.minute}${hourCycle === "h12" ? ` ${parts.dayPeriod}` : ""}`;
    return local === `${parts.weekday}, ${parts.month} ${day}${suffix}, ${parts.year} - ${time}`;
  } catch { return false; }
}

function currentTimeObservation(text) {
  // current-time.ts recognizes only this complete local/UTC two-line block.
  return text.replace(/^Current time: ([^\r\n]+?) \(([^()\r\n]+)\)\nReference UTC: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC$/gm, (block, local, timezone, utc) => {
    const timestamp = `${utc.replace(" ", "T")}:00.000Z`;
    return isoTimestamp(timestamp) && validLocalClock(local, timezone, timestamp) ? `Current time: <time> (${timezone})\nReference UTC: <time> UTC` : block;
  });
}

function runtimeObservations(event, report, observationBindings, normalize = value => value, evidence, completions) {
  if (!record(event.data)) return event;
  let data = event.data;
  const omit = (value, key, at, valid, reason) => {
    if (!valid(value[key])) return value;
    report({ at: `${at}/${key}`, before: value[key], after: absent, category: "measurements", reason });
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  };
  const observedText = (value, at, project, reason) => {
    if (typeof value !== "string") return value;
    const after = project(value);
    if (after === value) return value;
    report({ at, before: value, after, category: "measurements", reason });
    return new RuntimeObservationText(normalize(after, at));
  };
  if (event.type === "trace.metadata" && record(data.harness) && Array.isArray(data.harness.invocation)
    && data.harness.invocation.every(value => typeof value === "string") && portNumber(observationBindings?.gatewayPort)) {
    const original = data.harness.invocation, port = String(observationBindings.gatewayPort);
    const invocation = original.map((value, index) => {
      const after = value === port && original[index - 1] === "--port" ? "<port:gateway>"
        : value === `--port=${port}` ? "--port=<port:gateway>" : value;
      if (after === value) return value;
      report({ at: `event_json/data/harness/invocation/${index}`, before: value, after, category: "declaredIds", reason: "recorded clone Gateway invocation port" });
      return new RuntimeEnvironmentIdentity(after);
    });
    if (invocation.some((value, index) => value !== original[index])) data = { ...data, harness: { ...data.harness, invocation } };
  }
  // This is a copy of effective configuration. Only values bound by recorded
  // clone preparation are identities; a different port or destination is data.
  if (event.type === "trace.metadata" && record(data.config) && record(data.config.redacted) && record(observationBindings)) {
    let redacted = data.config.redacted;
    if (record(redacted.gateway) && portNumber(observationBindings.gatewayPort) && redacted.gateway.port === observationBindings.gatewayPort) {
      report({ at: "event_json/data/config/redacted/gateway/port", before: redacted.gateway.port, after: "<port:gateway>", category: "declaredIds", reason: "recorded clone Gateway port" });
      redacted = { ...redacted, gateway: { ...redacted.gateway, port: new RuntimeEnvironmentIdentity("<port:gateway>") } };
    }
    if (record(redacted.models) && record(redacted.models.providers) && record(observationBindings.providerBaseUrls)) {
      let providers = redacted.models.providers;
      for (const [name, provider] of Object.entries(providers)) {
        if (!record(provider) || !Object.hasOwn(observationBindings.providerBaseUrls, name) || provider.baseUrl !== observationBindings.providerBaseUrls[name]) continue;
        const baseUrl = boundProviderUrl(provider.baseUrl, name);
        if (baseUrl === undefined) continue;
        report({ at: `event_json/data/config/redacted/models/providers/${pointer(name)}/baseUrl`, before: provider.baseUrl, after: baseUrl, category: "declaredIds", reason: "recorded clone provider loopback port" });
        providers = { ...providers, [name]: { ...provider, baseUrl: new RuntimeEnvironmentIdentity(baseUrl) } };
      }
      if (providers !== redacted.models.providers) redacted = { ...redacted, models: { ...redacted.models, providers } };
    }
    if (redacted !== data.config.redacted) data = { ...data, config: { ...data.config, redacted } };
  }
  // trajectory/metadata.ts stamps these two native captures with toISOString().
  if (["trace.metadata", "trace.artifacts"].includes(event.type)) {
    data = omit(data, "capturedAt", "event_json/data", isoTimestamp, "native trajectory capture observation time");
  }
  // attempt-finalize.ts copies the same prompt-cache observation to both
  // completion captures. Cache outcomes, usage and retention remain evidence.
  if (["model.completed", "trace.artifacts"].includes(event.type) && record(data.promptCache)) {
    const promptCache = omit(data.promptCache, "lastCacheTouchAt", "event_json/data/promptCache", milliseconds, "native prompt-cache touch observation time");
    if (promptCache !== data.promptCache) data = { ...data, promptCache };
  }
  // The prompt observers and attempt finalizer copy AgentMessage arrays here.
  // Their outer timestamps are observation metadata; nested content/details
  // remain application data, including any similarly named fields.
  const field = messagesField(event);
  if (field && Array.isArray(data[field])) {
    const ownedPrompts = new Set();
    const messages = data[field].map((message, index) => {
      if (!record(message)) return message;
      const content = typeof message.content === "string" || Array.isArray(message.content);
      const native = message.role === "user" && content
        || message.role === "custom" && content && typeof message.customType === "string" && typeof message.display === "boolean"
        || assistantShape(message) && (record(message.usage) || message.usage === "[Truncated]" && evidence?.assistants.has(assistantKey(event, message)))
        || message.role === "toolResult" && Array.isArray(message.content) && ["toolCallId", "toolName"].every(key => typeof message[key] === "string") && typeof message.isError === "boolean";
      if (!native) return message;
      const at = `event_json/data/${field}/${index}`;
      let result = omit(message, "timestamp", at, milliseconds, "native agent message observation time");
      if (completions && message.role === "custom" && message.customType === "openclaw.runtime-context" && message.display === false
        && message.details?.source === "openclaw-runtime-context" && message.details.runtimeContextCarrier === true && Array.isArray(message.details.fragments)) {
        const rawFragments = message.details.fragments.slice();
        const fragments = message.details.fragments.map((fragment, offset, all) => {
          if (!record(fragment) || fragment.kind !== "conversation-data" || typeof fragment.text !== "string"
            || all[offset - 1]?.kind !== "runtime-instruction" || all[offset - 1].text !== completionInstruction
            || all[offset + 1]?.kind !== "runtime-instruction" || typeof all[offset + 1].text !== "string") return fragment;
          const projected = completions.project(event.sessionId, fragment.text);
          rawFragments[offset] = { ...fragment, text: projected };
          const text = observedText(fragment.text, `${at}/details/fragments/${offset}/text`, () => projected, "native child completion runtime verified against its retained execution and result");
          return text === fragment.text ? fragment : { ...fragment, text };
        });
        if (fragments.some((fragment, index) => fragment !== message.details.fragments[index])) {
          result = { ...result, details: { ...message.details, fragments } };
          if (typeof message.content === "string" && message.content === runtimeContextProjection(message.details.fragments)) {
            result.content = observedText(message.content, `${at}/content`, () => runtimeContextProjection(rawFragments), "native child completion runtime verified against its retained execution and result");
          }
        }
      }
      if (message.role === "user" && record(message.provenance) && message.provenance.kind === "internal_system" && ["cron", "heartbeat", "exec"].includes(message.provenance.sourceTool)) {
        const observe = (text, path) => {
          if (typeof text === "string") {
            const projected = currentTimeObservation(text);
            if (projected !== text) ownedPrompts.add(projected);
          }
          return observedText(text, path, currentTimeObservation, "native scheduled prompt current-time observation");
        };
        const content = typeof message.content === "string" ? observe(message.content, `${at}/content`)
          : message.content.map((part, partIndex) => {
            if (!record(part) || part.type !== "text" || typeof part.text !== "string") return part;
            const text = observe(part.text, `${at}/content/${partIndex}/text`);
            return text === part.text ? part : { ...part, text };
          });
        if (content !== message.content && (!Array.isArray(content) || content.some((part, i) => part !== message.content[i]))) result = { ...result, content };
      }
      if (message.role === "assistant" && Array.isArray(message.diagnostics)) {
        const diagnostics = message.diagnostics.map((diagnostic, diagnosticIndex) => {
          // openai-responses-stream-terminal-internal.ts records Date.now()
          // beside the terminal interpretation. Preserve that interpretation.
          if (!terminalShape(diagnostic) && !(record(diagnostic) && diagnostic.type === "openai_responses_terminal"
            && diagnostic.details === "[Truncated]" && evidence?.terminals.has(canonicalJSON([assistantKey(event, message), diagnosticIndex, diagnostic.timestamp])))) return diagnostic;
          return omit(diagnostic, "timestamp", `${at}/diagnostics/${diagnosticIndex}`, milliseconds, "native Responses terminal observation time");
        });
        if (diagnostics.some((diagnostic, i) => diagnostic !== message.diagnostics[i])) result = { ...result, diagnostics };
      }
      return result;
    });
    if (messages.some((message, index) => message !== data[field][index])) data = { ...data, [field]: messages };
    if (["context.compiled", "prompt.submitted"].includes(event.type) && typeof data.prompt === "string"
      && (ownedPrompts.has(currentTimeObservation(data.prompt)) || typeof event.sessionKey === "string" && evidence?.starts.get(runKey(event)) === event.sessionKey)) {
      const prompt = observedText(data.prompt, "event_json/data/prompt", currentTimeObservation, "native scheduled prompt current-time observation");
      if (prompt !== data.prompt) data = { ...data, prompt };
    }
  }
  return data === event.data ? event : { ...event, data };
}

// Return content for multiset comparison. SQLite rowids and storage sequence
// positions are not event identity. Keep every payload/unknown column and only
// project metadata proven to come from the native runtime event producer.
export function runtimeEventContent(file, row, { normalize = (value) => value, report = () => {}, observationBindings, evidence, completions } = {}) {
  if (!runtimeEventFile(file)) return undefined;
  const visit = (value, at) => {
    if (typeof value === "string") return normalize(value, at);
    if (value instanceof MeasuredText) return new VerifiedValue(visit(value.value, at));
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
      value = Object.fromEntries(Object.entries(runtimeObservations(event, report, observationBindings, normalize, evidence, completions)).filter(([key, child]) => {
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

// Candidates still pass through the complete persona-source membership check.
// Extraction never rewrites a message, signature, or idempotency-key suffix.
export function runtimeEventIdentities(file, row) {
  if (!file || !runtimeEventFile(file) || !row?.values) return [];
  const event = nativeEvent(row.values);
  if (!event || !record(event.data)) return [];
  const identities = [], seen = new Set();
  const identity = (value) => typeof value === "string" && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
  const add = (field, id) => {
    if (!identity(id)) return;
    const key = JSON.stringify([field, id]);
    if (seen.has(key)) return;
    seen.add(key);
    identities.push({ field, id });
  };
  const messagesField = ["context.compiled", "prompt.submitted"].includes(event.type) ? "messages" : event.type === "model.completed" ? "messagesSnapshot" : undefined;
  if (messagesField && Array.isArray(event.data[messagesField])) for (const message of event.data[messagesField]) {
    if (!record(message)) continue;
    if (message.role === "assistant" && message.api === "openai-responses" && identity(message.provider)
      && identity(message.model) && record(message.usage) && typeof message.stopReason === "string" && Array.isArray(message.content)) {
      // openai-responses-stream-internal copies the provider response identity
      // and creates text/toolCall blocks from the corresponding output items.
      add("responseId", message.responseId);
      for (const part of message.content) {
        if (!record(part)) continue;
        if (part.type === "toolCall" && identity(part.name) && record(part.arguments)) add("toolCallId", part.id);
        if (part.type !== "text" || typeof part.text !== "string" || typeof part.textSignature !== "string") continue;
        try {
          const signature = JSON.parse(part.textSignature);
          // The v1 producer uses JSON.stringify. Reject duplicate members and
          // unknown encodings rather than interpreting them as native output.
          if (record(signature) && signature.v === 1 && identity(signature.id)
            && (signature.phase === undefined || ["commentary", "final_answer"].includes(signature.phase))
            && JSON.stringify(signature) === part.textSignature) add("textSignatureId", signature.id);
        } catch { /* Unknown signatures remain ordinary product content. */ }
      }
    } else if (message.role === "toolResult" && identity(message.toolName) && typeof message.isError === "boolean" && Array.isArray(message.content)) {
      add("toolCallId", message.toolCallId);
    } else if (message.role === "user" && (typeof message.content === "string" || Array.isArray(message.content)) && typeof message.idempotencyKey === "string") {
      // buildRunUserTurnIdempotencyKey emits this exact suffix. Keep other keys
      // literal, and return only the generated UUID portion of this one.
      const match = /^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):user$/i.exec(message.idempotencyKey);
      if (match) add("runId", match[1]);
    }
  }
  // attempt-result normalizes these entries before buildTrajectoryArtifacts
  // copies them into the terminal artifact event; payload fields are not read.
  if (event.type === "trace.artifacts" && isoTimestamp(event.data.capturedAt) && typeof event.data.finalStatus === "string" && Array.isArray(event.data.toolMetas)) {
    for (const meta of event.data.toolMetas) if (record(meta) && identity(meta.toolName) && typeof meta.replaySafe === "boolean") add("toolCallId", meta.toolCallId);
  }
  return identities;
}
