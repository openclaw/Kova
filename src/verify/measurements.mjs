import { zstdDecompressSync } from "node:zlib";
import { matchesGlob } from "node:path";
import { sha256, canonicalJSON } from "./plan.mjs";
import { verifiedTranscriptStorage } from "./transcript-storage.mjs";

// Only this module can produce the branded value; recorded JSON objects remain
// ordinary containers even if they use the same descriptive property names.
export class VerifiedValue {
  constructor(value) { this.value = value; }
  toJSON() { return this.value; }
}

// A decoded native JSON text projection retains its complete typed tree.
// Serializing nested clock markers would make literal strings indistinguishable.
// Its ordinary leaves still receive identity and location normalization once.
export class MeasuredText extends VerifiedValue {}

// Only the decoder constructs this marker. A recorded array remains distinct
// from repeated object members even when their contents happen to match.
export class DuplicateValues extends VerifiedValue {}
export class TranscriptInteger extends VerifiedValue {
  constructor(raw) { super(`json-integer:${raw}`); this.raw = raw; }
  valueOf() { return Number(this.raw); }
  toJSON() { return Number(this.raw); }
}

class ComparisonNormalizationError extends Error {}

// Derived hashes and byte counts compare the same keys/string leaves as
// rowBuilder, with canonical object ordering. This view never replaces the
// original payload: its ordinary rows still receive normalization exactly once.
function comparisonJSON(value, normalize = (value) => value) {
  const visit = (value) => {
    if (value instanceof TranscriptInteger) return value.raw;
    if (Array.isArray(value)) return `[${value.map((item) => visit(item) ?? "null").join(",")}]`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [normalize(key), child]);
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ComparisonNormalizationError("normalization produced duplicate JSON keys");
      entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.flatMap(([key, child]) => (child instanceof DuplicateValues ? child.value : [child]).map((item) => `${JSON.stringify(key)}:${visit(item)}`)).join(",")}}`;
    }
    return JSON.stringify(typeof value === "string" ? normalize(value) : typeof value === "number" && !Number.isFinite(value) ? { number: String(value) } : value);
  };
  try { return visit(value); }
  catch (error) {
    if (error instanceof ComparisonNormalizationError) throw error;
    throw new ComparisonNormalizationError(error.message, { cause: error });
  }
}

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
    "control-ui": ["requests.*.elapsedMs", "requests.other.*.elapsedMs", "steps.*.elapsedMs"],
    "session-search-overlap": ["requests.*.startedMs", "requests.*.finishedMs", "requests.*.elapsedMs", "card.elapsedMs"],
    "session-search-completeness": ["warm.*.elapsedMs", "trials.*.elapsedMs"],
    "sessions-list": ["sessions.*.ageMs"],
    "gateway-sessions-list": ["result.sessions.*.runtimeMs"],
    "gateway-sessions-describe": ["result.session.runtimeMs"],
    "gateway-sessions-subscribe": ["result.list.sessions.*.runtimeMs"],
    "gateway-sessions-patch": ["result.entry.runtimeMs"],
    "cron-list": ["jobs.*.state.lastDurationMs"]
  };
  paths.push(...(operationPaths[entry?.id] ?? []));
  if (entry?.id === "control-ui") nullablePaths.push("requests.*.elapsedMs", "requests.other.*.elapsedMs");
  let result = omitMeasurements(omitMeasurements(value, paths), nullablePaths, true);
  if (entry?.id === "agent-tool-turn") {
    const call = result.toolCall, message = result.toolResult;
    if (record(call) && call.type === "toolCall" && typeof call.id === "string" && call.id
      && record(message) && message.role === "toolResult" && message.toolCallId === call.id && typeof message.toolName === "string") {
      const target = message.toolName === "tool_call" ? toolCallTarget(message.details) : null;
      const matches = message.toolName === "tool_call"
        ? target && [target, "tool_call"].includes(call.name) && [target, `openclaw:core:${target}`].includes(call.arguments?.id)
        : call.name === message.toolName;
      if (matches) {
        const normalized = transcriptMeasurements({ type: "message", message }).message;
        if (normalized !== message) result = { ...result, toolResult: normalized };
      }
    }
  }
  return result;
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const measurement = (value) => value instanceof TranscriptInteger ? Number.isFinite(Number(value.raw)) : typeof value === "number" && Number.isFinite(value);
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

function installedPluginFileMeasurements(value) {
  if (!record(value) || !measurement(value.revision) || !record(value.index)
    || value.index.version !== 1 || value.index.migrationVersion !== 1 || !Array.isArray(value.index.plugins)) return value;
  // The native index records filesystem observations beside content hashes.
  // Keep malformed signatures and all file identity/content evidence intact.
  const signature = (value) => record(value) && Number.isSafeInteger(value.size) && value.size >= 0
    && measurement(value.mtimeMs) && (value.ctimeMs === undefined || measurement(value.ctimeMs))
    ? omitMeasurements(value, ["mtimeMs", "ctimeMs"]) : value;
  return mapFields(value, ["index.plugins.*"], (plugin) => {
    if (!record(plugin) || !["pluginId", "manifestPath", "manifestHash", "rootDir", "origin"].every((key) => typeof plugin[key] === "string")) return plugin;
    let result = mapFields(plugin, ["manifestFile"], signature);
    if (typeof plugin.doctorContractHash === "string") result = mapFields(result, ["doctorContractFile"], signature);
    if (record(plugin.packageJson) && typeof plugin.packageJson.path === "string" && typeof plugin.packageJson.hash === "string") {
      result = mapFields(result, ["packageJson.fileSignature"], signature);
    }
    return result;
  });
}

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

function toolCallTarget(value) {
  const tool = value?.tool;
  return record(value) && record(tool) && tool.source === "openclaw" && typeof tool.name === "string"
    && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(tool.name) && tool.name !== "tool_call" && tool.id === `openclaw:core:${tool.name}`
    && record(value.result) && Array.isArray(value.result.content) ? tool.name : null;
}

function toolMeasurements(value, tool) {
  if (!record(value)) return value;
  if (tool === "tool_call") {
    const target = toolCallTarget(value);
    if (!target) return value;
    const message = { role: "toolResult", toolName: target, details: value.result.details, content: value.result.content };
    const normalized = transcriptMeasurements({ type: "message", message }).message;
    if (normalized === message) return value;
    return { ...value, result: { ...value.result,
      ...(normalized.details === message.details ? {} : { details: normalized.details }),
      ...(normalized.content === message.content ? {} : { content: normalized.content })
    } };
  }
  if (tool === "exec") return omitMeasurements(value, ["durationMs"]);
  if (tool === "session_status") return mapFields(value, ["statusText"], statusTextMeasurements);
  if (tool === "web_fetch" || tool === "web_search" && ["results", "answer"].includes(value.kind)) return omitMeasurements(value, ["tookMs"]);
  if (tool === "process") return omitMeasurements(value, ["idleMs", "sessions.*.runtimeMs", "sessions.*.idleMs"]);
  if (tool === "cron") return omitMeasurements(value, ["jobs.*.state.lastDurationMs", "state.lastDurationMs", "entries.*.durationMs", "run.durationMs"]);
  if (tool === "subagents" && value.action === "wait" && value.status === "ok" && Array.isArray(value.runs)
    && value.runs.every(run => record(run) && typeof run.runId === "string" && run.runId
      && typeof run.sessionKey === "string" && run.sessionKey && ["queued", "running", "waiting", "terminal"].includes(run.status)
      && ["startedAt", "endedAt"].every(key => run[key] === undefined || run[key] === null || nativeClock(run[key]))
      && !(nativeClock(run.startedAt) && nativeClock(run.endedAt) && run.endedAt < run.startedAt))) {
    // subagents-tool mapRun copies lifecycle observations alongside the outcome.
    // Keep absent/null clocks distinct from an observed native timestamp.
    return mapFields(value, ["runs.*.startedAt", "runs.*.endedAt"], observedClock);
  }
  if (tool !== "subagents" || value.action !== "list") return value;
  const result = mapFields(value, ["active.*", "recent.*"], (entry) => {
    const next = omitMeasurements(entry, ["runtimeMs"]);
    if (!hasFormattedRuntime(entry)) return next;
    return mapFields(next, ["runtime"], () => removed);
  });
  return mapFields(result, ["text"], (text) => subagentListText(text, value));
}

const nativeClock = value => Number.isSafeInteger(value) && value >= 0;
const observedClock = value => nativeClock(value) ? new VerifiedValue("<time>") : value;
const correlation = value => typeof value === "string" && value.length > 0 && value.length <= 1024;
const scopeUuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function nestedActivity(event) {
  const message = event?.message, details = message?.details;
  if (!record(event) || event.type !== "message" || !record(message) || message.role !== "custom"
    || message.customType !== "openclaw.nested-tool.v1" || message.display !== true || message.excludeFromContext !== true || message.content !== ""
    || Object.keys(message).some(key => !["role", "customType", "display", "excludeFromContext", "content", "details", "timestamp", "idempotencyKey"].includes(key))
    || !record(details) || Object.keys(details).some(key => !["runId", "scopeId", "afterEntryId", "startOrder", "parentToolCallId", "toolCallId", "toolName", "input", "result", "isError", "startedAt", "timestamp"].includes(key))
    || !correlation(details.runId) || !scopeUuid(details.scopeId) || !(details.afterEntryId === null || correlation(details.afterEntryId))
    || !Number.isSafeInteger(details.startOrder) || details.startOrder < 0 || !correlation(details.toolCallId)
    || details.parentToolCallId !== undefined && !correlation(details.parentToolCallId)
    || typeof details.toolName !== "string" || !details.toolName || details.toolName.length > 256 || !Object.hasOwn(details, "input")
    || !record(details.result) || !Array.isArray(details.result.content) || Object.keys(details.result).some(key => !["content", "details"].includes(key))
    || typeof details.isError !== "boolean" || !nativeClock(details.startedAt) || !nativeClock(details.timestamp)
    || message.timestamp !== details.startedAt
    || Object.hasOwn(message, "idempotencyKey") && message.idempotencyKey !== `${details.scopeId}:${details.toolCallId}`) return undefined;
  return message;
}

// Declaration discovery owns scope relationships and original-persona identity
// protection. Measurement normalization never invents a second identity map.
export function nestedToolScopeId(event) {
  return nestedActivity(event)?.details.scopeId;
}

function nestedActivityMeasurements(event) {
  const message = nestedActivity(event);
  if (!message) return event;
  const details = message.details;
  const normalized = transcriptMeasurements({ type: "message", message: { role: "toolResult", toolName: details.toolName,
    details: details.result.details, content: details.result.content } }).message;
  const result = { ...details.result, content: normalized.content };
  if (Object.hasOwn(details.result, "details")) result.details = normalized.details;
  const next = { ...message, timestamp: observedClock(message.timestamp), details: {
    ...details, startedAt: observedClock(details.startedAt), timestamp: observedClock(details.timestamp), result
  } };
  return { ...event, message: next };
}

export function transcriptMeasurements(event) {
  if (!record(event) || event.type !== "message") return event;
  if (event.message?.role === "custom") return nestedActivityMeasurements(event);
  if (event.message?.role !== "toolResult") return event;
  const { message } = event;
  const details = toolMeasurements(message.details, message.toolName);
  let content = message.content;
  if ((["cron", "subagents", "web_fetch", "web_search"].includes(message.toolName)
    || message.toolName === "tool_call" && toolCallTarget(message.details)) && Array.isArray(content)) content = content.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    try {
      const value = JSON.parse(part.text);
      if (message.toolName === "tool_call" && toolCallTarget(value) !== toolCallTarget(message.details)) return part;
      const next = toolMeasurements(value, message.toolName);
      if (next === value) return part;
      const waitText = message.toolName === "subagents" && value.action === "wait"
        || message.toolName === "tool_call" && toolCallTarget(value) === "subagents"
          && (value.result.details?.action === "wait" || next.result.content.some(item => item?.text instanceof VerifiedValue));
      if (waitText) {
        // Native jsonResult emits compact or two-space JSON. Refuse a lossy
        // parse of duplicate members, overflow, unsafe integers or other text.
        if (part.text !== JSON.stringify(value) && part.text !== JSON.stringify(value, null, 2)) return part;
        return { ...part, text: new MeasuredText(next) };
      }
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

function runtimeEventMeasurements(event) {
  if (!record(event) || event.traceSchema !== "openclaw-trajectory" || event.schemaVersion !== 1 || event.source !== "runtime" || event.type !== "tool.result"
    || !record(event.data) || typeof event.data.name !== "string" || !record(event.data.result)) return event;
  const result = event.data.result;
  // Runtime capture and persisted tool messages contain the same native result.
  // Reuse its producer-specific rules without interpreting application data.
  const message = { role: "toolResult", toolName: event.data.name, details: result.details, content: result.content };
  const normalized = transcriptMeasurements({ type: "message", message }).message;
  if (normalized === message) return event;
  return { ...event, data: { ...event.data, result: { ...result,
    ...(normalized.details === message.details ? {} : { details: normalized.details }),
    ...(normalized.content === message.content ? {} : { content: normalized.content })
  } } };
}

function latencyRoundingError(operations) {
  const error = operations * Number.EPSILON;
  return error < 1 ? error / (1 - error) : Infinity;
}

function consistentLatencySum(latency) {
  if (latency.count === 0) return latency.sum === 0;
  const count = latency.count, groups = latency.centroids.length;
  let weighted = 0;
  for (const entry of latency.centroids) weighted += entry.value * entry.count;
  if (!Number.isFinite(weighted)) return false;
  // The native rollup adds each positive sample once. A centroid merge has
  // multiply/add/divide on a sample's path (at most count-groups merges);
  // reconstructing the weighted sum adds one multiply and the group additions.
  // gamma(n)=n*epsilon/(1-n*epsilon), using epsilon >= IEEE 754 rounding error,
  // bounds both histories. The absolute term covers subnormal rounding, whose
  // contribution can be magnified by at most the total sample count.
  const sumOps = count - 1, centroidOps = 3 * (count - groups) + groups;
  const sumError = latencyRoundingError(sumOps), centroidError = latencyRoundingError(centroidOps);
  if (sumError >= 1 || centroidError >= 1) return false;
  const denominator = 1 - Math.min(sumError, centroidError);
  const underflow = (sumOps + centroidOps) * count * Number.MIN_VALUE * (1 + Math.max(sumError, centroidError));
  const bound = ((sumError + centroidError) * Math.max(latency.sum, weighted) + underflow) / denominator;
  return Number.isFinite(bound) && Math.abs(latency.sum - weighted) <= bound;
}

const latencyFloatBits = new DataView(new ArrayBuffer(8));

// Round interval endpoints outward after each arithmetic operation. One adjacent
// representable number encloses the exact result of the rounded JS operation.
function latencyOutward(value, upper) {
  if (value === Infinity) return upper ? Infinity : Number.MAX_VALUE;
  if (value === -Infinity) return upper ? -Number.MAX_VALUE : -Infinity;
  if (value === 0) return upper ? Number.MIN_VALUE : -Number.MIN_VALUE;
  latencyFloatBits.setFloat64(0, value);
  const bits = latencyFloatBits.getBigUint64(0);
  latencyFloatBits.setBigUint64(0, bits + ((value > 0) === upper ? 1n : -1n));
  return latencyFloatBits.getFloat64(0);
}

function latencySumRange(observed, operations, weight) {
  if (!operations) return [observed, observed];
  const error = latencyOutward(latencyRoundingError(operations), true);
  if (error >= 1) return undefined;
  // Absolute underflow accumulates across both products in every merge, unlike
  // the relative bound along one sample's path; include the final multiply too.
  const absoluteOperations = Math.max(operations, 4 * (weight - 1) + 1);
  const absolute = latencyOutward(latencyOutward(latencyOutward(absoluteOperations * weight, true) * Number.MIN_VALUE, true) * latencyOutward(1 + error, true), true);
  const lower = latencyOutward(latencyOutward(observed - absolute, false) / latencyOutward(1 + error, true), false);
  const upper = latencyOutward(latencyOutward(observed + absolute, true) / latencyOutward(1 - error, false), true);
  return Number.isFinite(lower) && Number.isFinite(upper) ? [Math.max(0, lower), upper] : undefined;
}

function addLatencyRanges(left, right) {
  if (left[0] === 0 && left[1] === 0) return right;
  if (right[0] === 0 && right[1] === 0) return left;
  return [Math.max(0, latencyOutward(left[0] + right[0], false)), latencyOutward(left[1] + right[1], true)];
}

function intersectLatencyRanges(left, right) {
  if (!left || !right) return undefined;
  const lower = Math.max(left[0], right[0]), upper = Math.min(left[1], right[1]);
  return lower <= upper ? [lower, upper] : undefined;
}

function boundedLatencyGroup(count, minimum, maximum, requireMinimum = false, requireMaximum = false) {
  const required = Number(requireMinimum) + Number(requireMaximum);
  if (count < required) return undefined;
  let fixed = [0, 0];
  if (requireMinimum) fixed = addLatencyRanges(fixed, [minimum, minimum]);
  if (requireMaximum) fixed = addLatencyRanges(fixed, [maximum, maximum]);
  const remaining = count - required;
  const rest = !remaining ? [0, 0] : remaining === 1 ? [minimum, maximum]
    : [Math.max(0, latencyOutward(remaining * minimum, false)), latencyOutward(remaining * maximum, true)];
  return addLatencyRanges(fixed, rest);
}

function consistentLatencyExtrema(latency) {
  const entries = latency.centroids;
  // session-cost-usage-rollup compresses to MAX_LATENCY_CENTROIDS = 64.
  // Larger representations cannot be attested from this producer contract.
  if (entries.length > 64) return false;
  if (!latency.count) return true;
  if (latency.sum === 0 || latency.max === 0) return latency.sum === 0 && latency.max === 0 && entries.every((entry) => entry.value === 0);
  if (entries.every((entry) => entry.count === 1)) {
    const values = entries.map((entry) => entry.value);
    return latency.max === Math.max(...values) && (latency.min === undefined || latency.min === Math.min(...values));
  }
  const minimum = latency.min ?? 0, maximum = latency.max;
  // Each merged mean follows at most count-1 multiply/add/divide steps; one
  // final multiply recovers its group sum. Unmerged samples are exact. Invert
  // the same arithmetic bound used for the aggregate sum, including underflow.
  const groups = entries.map((entry) => intersectLatencyRanges(
    latencySumRange(entry.value * entry.count, entry.count === 1 ? 0 : 3 * (entry.count - 1) + 1, entry.count),
    boundedLatencyGroup(entry.count, minimum, maximum)
  ));
  if (groups.some((group) => !group)) return false;
  const total = latencySumRange(latency.sum, latency.count - 1, 1);
  const base = groups.reduce(addLatencyRanges, [0, 0]);
  if (!Number.isFinite(base[1]) || !intersectLatencyRanges(base, total)) return false;
  if (latency.min !== undefined && minimum === maximum) return true;
  const withExtremes = (replacements) => {
    let rest = base;
    for (const [index] of replacements) {
      // Remove the known endpoint contributions, retaining the outward error
      // from summation. This avoids rescanning every other group for each pair.
      rest = [Math.max(0, latencyOutward(rest[0] - groups[index][0], false)), Math.max(0, latencyOutward(rest[1] - groups[index][1], true))];
    }
    for (const [, replacement] of replacements) rest = addLatencyRanges(rest, replacement);
    return Boolean(intersectLatencyRanges(rest, total));
  };
  const maxima = entries.map((entry, index) => intersectLatencyRanges(groups[index], boundedLatencyGroup(entry.count, minimum, maximum, false, true)));
  if (latency.min === undefined) return maxima.some((range, index) => range && withExtremes([[index, range]]));
  // The extrema must coexist: either two different groups contain them, or one
  // group with at least two samples can contain both while preserving the sum.
  for (const [index, entry] of entries.entries()) {
    const lower = intersectLatencyRanges(groups[index], boundedLatencyGroup(entry.count, minimum, maximum, true));
    if (!lower) continue;
    const both = intersectLatencyRanges(groups[index], boundedLatencyGroup(entry.count, minimum, maximum, true, true));
    if (both && withExtremes([[index, both]])) return true;
    if (maxima.some((upper, other) => other !== index && upper && withExtremes([[index, lower], [other, upper]]))) return true;
  }
  return false;
}

function usageRollupMeasurements(value) {
  return mapFields(value, ["buckets.*.latency"], (latency) => {
    if (!record(latency) || !Number.isSafeInteger(latency.count) || latency.count < 0 || !Array.isArray(latency.centroids) || !measurement(latency.max) || latency.max < 0 || !measurement(latency.sum) || latency.sum < 0 || latency.min !== undefined && (!measurement(latency.min) || latency.min < 0 || latency.min > latency.max)) return latency;
    if (!latency.centroids.every((entry) => record(entry) && Object.keys(entry).every((key) => ["count", "value"].includes(key)) && Number.isSafeInteger(entry.count) && entry.count > 0 && measurement(entry.value) && entry.value >= 0)) return latency;
    const count = latency.centroids.reduce((total, entry) => total + entry.count, 0);
    if (!Number.isSafeInteger(count) || count !== latency.count || count === 0 && (latency.max !== 0 || latency.sum !== 0) || !consistentLatencySum(latency) || !consistentLatencyExtrema(latency)) return latency;
    // Centroid membership depends on the distribution; the independently
    // validated sample count and all other work/usage fields remain visible.
    const result = { ...omitMeasurements(latency, ["min", "max", "sum"]) };
    delete result.centroids;
    return new VerifiedValue(result);
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
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    if (text.length !== body.utf16Length) return null;
    const rollup = JSON.parse(text);
    if (!record(rollup) || !record(rollup.buckets) || !record(rollup.untimestamped)) return null;
    const normalized = usageRollupMeasurements(rollup);
    // The producer may choose compression based on the body size. Once the
    // original sizes/hash are verified, compare decoded content instead of
    // measurement-dependent compression, lengths and digest aliases.
    const normalizedBody = { ...body, encoding: "decoded-json" };
    for (const key of ["bytes", "storedBytes", "utf16Length", "sha256"]) delete normalizedBody[key];
    return { envelope: { ...envelope, body: new VerifiedValue(normalizedBody) }, rollup: new VerifiedValue(normalized) };
  } catch { return null; }
}

function quarantineIdentityData(value) {
  return {
    sourceIndex: value.sourceIndex, reason: value.reason, job: value.job ?? null,
    raw: value.raw ?? null, state: value.state ?? null,
    updatedAtMs: value.updatedAtMs ?? null, scheduleIdentity: value.scheduleIdentity ?? null
  };
}
const quarantineIdentity = (value) => JSON.stringify(quarantineIdentityData(value));

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
    if (safeInteger(value[field]) && value[field] === before[field] && safeInteger(after[field])) result = { ...result, [field]: new VerifiedValue(after[field]) };
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

// Reuse the bounded transcript decoder for runtime captures whose sanitizer
// omitted their usage/diagnostic objects. Only exact native JSON is evidence;
// invalid UTF-8, duplicate members and damaged compressed bodies stay opaque.
export function* runtimeTranscriptMessages(db, path, standard, sessions) {
  if (!db || !agentDatabase(path) || !sessions.size) return;
  let query, compressed;
  try {
    if (!db.prepare("PRAGMA main.table_list").all().some(table => table.schema === "main" && table.name === "transcript_events" && table.type === "table")) return;
    const columns = new Set(db.prepare('PRAGMA main.table_xinfo("transcript_events")').all().map(column => column.name));
    if (!["session_id", "event_json"].every(column => columns.has(column))) return;
    compressed = (standard.compressed ?? []).some(entry => entry.table === "transcript_events" && entry.column === "event_zstd" && entry.codec === "zstd" && matchesGlob(path, entry.path));
    query = db.prepare(`SELECT typeof(event_json) AS event_type, CAST(event_json AS BLOB) AS event_bytes,
      ${columns.has("event_zstd") ? "event_zstd" : "NULL AS event_zstd"},
      ${columns.has("event_utf8_bytes") ? "event_utf8_bytes" : "NULL AS event_utf8_bytes"}
      FROM transcript_events WHERE session_id = ?`);
    query.setReadBigInts(true);
  } catch { return; }
  for (const sessionId of sessions) for (const row of query.iterate(sessionId)) {
    try {
      const text = row.event_type === "text" ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(row.event_bytes)
        : row.event_type === "null" ? readSourceEvent(row, compressed) : undefined;
      if (text === undefined) continue;
      const event = JSON.parse(text);
      if (JSON.stringify(event) !== text || !record(event) || event.type !== "message" || typeof event.id !== "string" || !event.id
        || typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)) || new Date(event.timestamp).toISOString() !== event.timestamp
        || !record(event.message)) continue;
      yield { sessionId, message: event.message };
    } catch { /* Malformed transcript content supplies no attestation. */ }
  }
}

// A cache session can have both v2 and v3 rows, possibly at different retained
// prefixes. Stream it once and retain only the requested checkpoint summaries.
function sqliteCheckpointSources(file, context) {
  const wanted = new Map(), sources = new Map();
  for (const row of file.rows()) {
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
            normalizedText = comparisonJSON(normalized, context.normalize);
            normalizedAnchor = base64Hash(normalizedText);
          } catch (error) {
            if (error instanceof ComparisonNormalizationError) throw error;
            sizeValid = false;
          }
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
  } catch (error) {
    if (error instanceof ComparisonNormalizationError) throw error;
    /* Missing or malformed source/schema cannot authorize normalization. */
  }
  return sources;
}

function normalizedJsonlPrefix(bytes, offset, observedSize, normalize) {
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
      replacement = Buffer.from(comparisonJSON(transcriptMeasurements(event), normalize));
      if (!replacement.equals(raw)) changed = true;
    } catch (error) {
      if (error instanceof ComparisonNormalizationError) throw error;
      /* Preserve malformed records byte-for-byte. */
    }
    if (!terminated && (offset !== observedSize || !completeRecord)) return undefined;
    append(replacement);
    if (terminated) append(bytes.subarray(contentEnd, end + 1));
    start = terminated ? end + 1 : offset;
  }
  return { length, anchor: base64Hash(tail), changed };
}

function jsonlCheckpointRequests(file) {
  const sources = new Map();
  for (const row of file.rows()) {
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

async function jsonlCheckpointSources(path, requests, readState, normalize) {
  const snapshots = new Map();
  const bytes = await readState(path);
  if (!(bytes instanceof Uint8Array)) return snapshots;
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [key, request] of requests ?? []) {
    if (request.size > source.length) continue;
    const anchor = base64Hash(source.subarray(Math.max(0, request.offset - 4096), request.offset));
    if (!request.anchors.has(anchor)) continue;
    const normalized = normalizedJsonlPrefix(source, request.offset, request.size, normalize);
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
    result = { ...result, anchorHash: new VerifiedValue(source.normalizedAnchor) };
    if (source.sizeValid && checkpoint.eventCount === source.count && checkpoint.size === source.size) result = { ...result, size: new VerifiedValue(source.normalizedSize) };
    return result;
  }
  if (checkpoint.kind !== "jsonl" || !safeInteger(checkpoint.parsedOffset) || !safeInteger(checkpoint.observedSize) || checkpoint.parsedOffset > checkpoint.observedSize || !context.readState) return checkpoint;
  const path = jsonlCacheSource(values.key?.raw);
  if (!path) return checkpoint;
  if (!context.jsonlSources.has(path)) context.jsonlSources.set(path, jsonlCheckpointSources(path, context.jsonlRequests.get(path), context.readState, context.normalize));
  const snapshots = await context.jsonlSources.get(path);
  const offset = checkpoint.parsedOffset;
  const source = snapshots.get(canonicalJSON([offset, checkpoint.observedSize]));
  if (source?.anchor !== checkpoint.anchorHash) return checkpoint;
  const normalized = source.normalized;
  return normalized ? { ...checkpoint, parsedOffset: new VerifiedValue(normalized.length), observedSize: new VerifiedValue(checkpoint.observedSize + normalized.length - offset), anchorHash: new VerifiedValue(normalized.anchor) } : checkpoint;
}

// The native report stores a digest of the exact trimmed skills catalog.
// Keep only its compact attestation, never a table of retained prompt bodies.
function skillsPromptSources(file, normalize) {
  const sources = new Map();
  if (!normalize) return sources;
  for (const row of file.rows()) {
    const key = row.values.session_key?.raw, cell = row.values.value_json;
    if (row.values.field?.raw !== "skillsSnapshot" || typeof key !== "string") continue;
    if (sources.has(key)) { sources.set(key, null); continue; }
    sources.set(key, null);
    if (!cell || cell.encoded
      || !record(cell.value) || typeof cell.value.prompt !== "string" || cell.raw !== JSON.stringify(cell.value)) continue;
    const prompt = cell.value.prompt.trim();
    const entries = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi), ([block]) => ({
      name: block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)", blockChars: block.length
    }));
    const source = { hash: sha256(prompt), chars: prompt.length, entries: canonicalJSON(entries), normalizedChars: normalize(prompt).length };
    sources.set(key, source);
  }
  return sources;
}

function skillsPromptMeasurement(value, source) {
  const skills = value?.skills;
  if (!source || !record(value) || !record(skills) || skills.hash !== source.hash || skills.promptChars !== source.chars
    || !Array.isArray(skills.entries) || canonicalJSON(skills.entries) !== source.entries) return value;
  if (source.normalizedChars === skills.promptChars) return value;
  // Per-skill blockChars remain original observations; only the independently
  // attested aggregate receives the existing identity/location substitutions.
  return { ...value, skills: { ...skills, promptChars: new VerifiedValue(source.normalizedChars) } };
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
    if (file.table === "session_entry_snapshots" && values.field?.raw === "systemPromptReport") {
      const cell = values.value_json;
      if (cell && !cell.encoded && cell.raw === JSON.stringify(cell.value)) json("value_json", value => skillsPromptMeasurement(value, context.skillsPromptSources?.get(values.session_key?.raw)));
    }
    if (file.table === "trajectory_runtime_events") json("event_json", runtimeEventMeasurements);
    if (file.table === "session_nodes") json("entry_json", (value) => omitMeasurements(value, ["runtimeMs"]));
    if (file.table === "transcript_events") {
      const stored = verifiedTranscriptStorage(file, row, context.db, context.standard);
      if (stored) values = { ...values,
        event_json: { ...values.event_json, raw: stored.text, value: stored.event, encoded: false },
        event_zstd: { ...values.event_zstd, raw: null, value: null, encoded: false },
        navigation_json: { ...values.navigation_json, raw: null, value: new VerifiedValue(null), encoded: false }
      };
      json("event_json", transcriptMeasurements);
      json("event_zstd", transcriptMeasurements);
      const payload = stored || typeof row.values.event_json?.raw === "string" ? "event_json" : "event_zstd";
      const source = stored ? { raw: stored.text, value: stored.event } : row.values[payload];
      const original = source?.encoded ? undefined : source?.raw;
      const compared = typeof original === "string" ? source.value === original ? (context.normalize ?? ((value) => value))(original) : comparisonJSON(values[payload].value, context.normalize) : undefined;
      if (!file.primary.includes("event_utf8_bytes") && typeof original === "string" && (stored || measurement(values.event_utf8_bytes?.value) && Buffer.byteLength(original) === values.event_utf8_bytes.value)) {
        const length = Buffer.byteLength(compared);
        values = { ...values, event_utf8_bytes: { ...values.event_utf8_bytes, value: new VerifiedValue(length), raw: length } };
      }
      if (!stored && typeof original === "string") json("navigation_json", (value) => navigationMeasurements(value, original, compared, context.db));
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
    if (file.table === "state_leases" && values.scope?.raw === "gateway-owner" && values.lease_key?.raw === "global") json("payload_json", (value) => {
      const owner = value?.owner;
      return record(value) && record(owner) && Number.isSafeInteger(owner.pid) && owner.pid > 0
        && typeof owner.host === "string" && owner.host.length > 0
        && Number.isSafeInteger(owner.startedAt) && owner.startedAt >= 0
        ? mapFields(value, ["owner.startedAt"], observedClock) : value;
    });
    if (file.table === "gateway_boot_lifecycle") for (const column of ["started_at_ms", "completed_at_ms"]) {
      const cell = values[column];
      if (!file.primary.includes(column) && nativeClock(cell?.value)) values = { ...values, [column]: { ...cell, value: observedClock(cell.value) } };
    }
    if (file.table === "config_machine_state" && values.state_key?.raw === "plugins.installedIndex") json("value_json", installedPluginFileMeasurements);
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
        const key = sha256(comparisonJSON(quarantineIdentityData(values.payload_json.value), context.normalize));
        values = { ...values, event_key: { ...values.event_key, raw: key, value: new VerifiedValue(key) } };
      }
    }
  }
  return values === row.values ? row : { ...row, values };
}

// Decode one row at a time. Cross-row validation keeps only requested summaries
// and quarantine key counts; transcript bodies never accumulate in a table array.
export async function* persistedRowsMeasurements(file, context = {}) {
  const cache = agentDatabase(file.path) && file.table === "cache_entries";
  const skills = agentDatabase(file.path) && file.table === "session_entry_snapshots";
  const sources = { ...context, jsonlSources: new Map(), jsonlRequests: cache ? jsonlCheckpointRequests(file) : new Map(), sqliteSources: cache ? sqliteCheckpointSources(file, context) : new Map(),
    skillsPromptSources: skills ? skillsPromptSources(file, context.normalize) : new Map() };
  const quarantine = file.path === "state/openclaw.sqlite" && file.table === "diagnostic_events";
  const groups = new Map();
  const groupKey = (row) => typeof row.values.scope?.raw === "string" && row.values.scope.raw.startsWith("cron.quarantine:")
    ? canonicalJSON([row.values.scope.raw, row.values.event_key?.raw]) : null;
  if (quarantine) for (const before of file.rows()) {
    const after = await persistedRowMeasurements(file, before, sources), key = groupKey(after);
    if (key === null) continue;
    const group = groups.get(key) ?? { count: 0, ordinal: 0, changed: false };
    group.count++;
    group.changed ||= after.values.event_key?.raw !== before.values.event_key?.raw;
    groups.set(key, group);
  }
  let index = 0;
  for (const before of file.rows()) {
    let after = await persistedRowMeasurements(file, before, sources);
    const group = quarantine && groups.get(groupKey(after));
    if (group?.count > 1 && group.changed) {
      // Keep multiplicity when retained quarantines differ only by duration.
      const cell = after.values.event_key, key = `${cell.raw}#${++group.ordinal}`;
      after = { ...after, values: { ...after.values, event_key: { ...cell, raw: key, value: new VerifiedValue(key) } } };
    }
    context.auditRows?.(file.path, file.table, before, after, index++);
    yield after;
  }
}


export const sessionIndexMeasurements = (value) => omitMeasurements(value, ["*.runtimeMs"]);
