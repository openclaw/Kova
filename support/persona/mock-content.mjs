import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { productJson, productCommand } from "./common.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const modelName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const markerName = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export const MOCK_TRAIT_OPTIONS = {
  "add-held-turn": { type: "boolean" },
  "add-tool-call-model": { type: "boolean" },
  "add-single-slot-model": { type: "boolean" },
  "add-overflow-once": { type: "boolean" },
  marker: { type: "string" },
  "hold-ms": { type: "string" },
  "progress-card": { type: "boolean" },
  "model-id": { type: "string" },
};

export function readMockTraits(script) {
  const traits = script.kovaPersona;
  if (traits === undefined) return {};
  if (!object(traits) || traits.version !== 1 || Object.keys(traits).some((key) => !["version", "heldTurn", "toolCallModel", "singleSlotModel", "overflowOnce"].includes(key))) throw new Error("invalid persona mock configuration");
  if (traits.heldTurn !== undefined && (!object(traits.heldTurn) || typeof traits.heldTurn.marker !== "string" || !markerName.test(traits.heldTurn.marker) || !Number.isSafeInteger(traits.heldTurn.holdMs) || traits.heldTurn.holdMs < 1 || traits.heldTurn.holdMs > 300000 || typeof traits.heldTurn.progressCard !== "boolean")) throw new Error("invalid held-turn configuration");
  if (traits.toolCallModel !== undefined && (!object(traits.toolCallModel) || typeof traits.toolCallModel.modelId !== "string" || !modelName.test(traits.toolCallModel.modelId))) throw new Error("invalid tool-call model");
  if (traits.singleSlotModel !== undefined && (!object(traits.singleSlotModel) || typeof traits.singleSlotModel.modelId !== "string" || !modelName.test(traits.singleSlotModel.modelId) || traits.singleSlotModel.agentId !== "idle" || traits.singleSlotModel.responseDelayMs !== 1000)) throw new Error("invalid single-slot model");
  if (traits.overflowOnce !== undefined && (!object(traits.overflowOnce) || typeof traits.overflowOnce.marker !== "string" || !markerName.test(traits.overflowOnce.marker) || traits.overflowOnce.sessionKey !== "agent:main:verify-overflow")) throw new Error("invalid overflow configuration");
  return traits;
}

export function parseMockAddition(args) {
  const modes = ["add-held-turn", "add-tool-call-model", "add-single-slot-model", "add-overflow-once"].filter((key) => args[key] === true);
  if (modes.length !== 1) throw new Error("exactly one mock addition is required");
  const traits = {};
  const mode = modes[0];
  if (mode === "add-held-turn" || mode === "add-overflow-once") {
    if (!args.marker || !markerName.test(args.marker)) throw new Error("--marker must be a safe nonempty marker");
    if (args["model-id"] !== undefined) throw new Error("--model-id does not apply to marker replies");
    if (mode === "add-held-turn") {
      const holdMs = Number(args["hold-ms"]);
      if (!/^\d+$/.test(args["hold-ms"] ?? "") || !Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > 300000) throw new Error("--hold-ms must be between 1 and 300000");
      traits.heldTurn = { marker: args.marker, holdMs, progressCard: args["progress-card"] === true };
    } else {
      if (args["hold-ms"] !== undefined || args["progress-card"]) throw new Error("hold options require --add-held-turn");
      traits.overflowOnce = { marker: args.marker, sessionKey: "agent:main:verify-overflow" };
    }
  } else {
    if (!args["model-id"] || !modelName.test(args["model-id"])) throw new Error("--model-id must be a safe nonempty model name");
    if (args.marker !== undefined || args["hold-ms"] !== undefined || args["progress-card"]) throw new Error("marker options do not apply to model additions");
    if (mode === "add-tool-call-model") traits.toolCallModel = { modelId: args["model-id"] };
    else traits.singleSlotModel = { modelId: args["model-id"], agentId: "idle", responseDelayMs: 1000 };
  }
  return traits;
}

export function addMockTrait(script, args) {
  const addition = parseMockAddition(args);
  if (!Array.isArray(script.steps) || !script.steps.length) throw new Error("saved mock reply table is absent");
  const traits = { ...readMockTraits(script), ...addition, version: 1 };
  if (traits.toolCallModel?.modelId === traits.singleSlotModel?.modelId && traits.toolCallModel) throw new Error("tool-call and single-slot models must be distinct");
  if (traits.heldTurn?.marker === traits.overflowOnce?.marker && traits.heldTurn) throw new Error("held-turn and overflow markers must be distinct");
  return { ...script, kovaPersona: traits };
}

export async function writeMockTrait({ args, workspace }) {
  const path = join(workspace, "kova-persona", "mock-script.json");
  const script = addMockTrait(JSON.parse(await readFile(path, "utf8")), args);
  if (args["model-id"]) await configureMockModel(args.env, args["model-id"], args["add-single-slot-model"] === true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(script, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path };
}

async function configureMockModel(env, modelId, serial) {
  const config = await productJson(env, ["config", "get", "models.providers.openai", "--json"]);
  if (!Array.isArray(config.models) || !config.models.some((model) => model.id === "gpt-5.5")) throw new Error("base mock model is absent");
  const model = { ...config.models.find((model) => model.id === "gpt-5.5"), id: modelId, name: modelId };
  const models = [...config.models.filter((existing) => existing.id !== modelId), model];
  await productCommand(env, ["config", "set", "models.providers.openai.models", JSON.stringify(models), "--strict-json"]);
  const defaults = await productJson(env, ["config", "get", "agents.defaults", "--json"]);
  const ref = `openai/${modelId}`;
  const params = { ...(defaults.models?.[ref] ?? {}), params: { ...(defaults.models?.[ref]?.params ?? {}), transport: "sse", openaiWsWarmup: false } };
  await productCommand(env, ["config", "set", "agents.defaults.models", JSON.stringify({ ...defaults.models, [ref]: params }), "--strict-json"]);
  if (Array.isArray(defaults.modelPolicy?.allow) && defaults.modelPolicy.allow.length) {
    await productCommand(env, ["config", "set", "agents.defaults.modelPolicy.allow", JSON.stringify([...new Set([...defaults.modelPolicy.allow, ref])]), "--strict-json"]);
  }
  if (serial) {
    const entries = await productJson(env, ["config", "get", "agents.entries", "--json"]);
    if (!object(entries.idle)) throw new Error("idle agent is absent");
    const previous = object(entries.idle.model) ? entries.idle.model : {};
    await productCommand(env, ["config", "set", "agents.entries.idle.model", JSON.stringify({ ...previous, primary: ref }), "--strict-json"]);
  }
}

function textContent(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
}

export function latestMockTurn(body) {
  if (typeof body.input === "string") return { text: body.input, items: [], key: body.input };
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const index = items.findLastIndex((item) => item?.role === "user" && !textContent(item.content).trim().startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"));
  if (index < 0) return { text: "", items: [], key: "" };
  const user = items[index];
  const text = textContent(user.content);
  return { text, items: items.slice(index + 1), key: typeof user.id === "string" ? `${user.id}\n${text}` : text };
}

export function requestedMockTool(text) {
  const explicit = text.indexOf("KOVA_TOOL_CALL ");
  if (explicit !== -1) {
    const request = parseObject(text.slice(explicit + "KOVA_TOOL_CALL ".length));
    if (!object(request) || typeof request.name !== "string" || !object(request.arguments)) throw new Error("KOVA_TOOL_CALL requires name and an arguments object");
    return request;
  }
  const named = /\b(?:Call|call) ([a-z][a-z0-9_]*) (?:exactly once )?with\s*(\{)/.exec(text);
  return named ? { name: named[1], arguments: parseObject(text.slice(named.index + named[0].length - 1)) } : null;
}

function parseObject(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("tool arguments must be JSON");
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  throw new Error("tool arguments contain incomplete JSON");
}

function hasToolOutput(items, callId) {
  return items.some((item) => (item.type === "function_call_output" && item.call_id === callId) || (item.role === "tool" && item.tool_call_id === callId));
}

export function selectMockReply(traits, body, overflowTriggers) {
  const turn = latestMockTurn(body);
  const digest = createHash("sha256").update(`${body.model ?? ""}\n${turn.key}`).digest("hex");
  const callId = `call_kova_${digest.slice(0, 24)}`;
  const toolReply = (name, args) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new Error("invalid requested tool name");
    const names = new Set(Array.isArray(body.tools) ? body.tools.map((tool) => tool?.name ?? tool?.function?.name) : []);
    if (!names.has(name)) {
      if (!names.has("tool_call")) throw new Error(`requested tool is unavailable: ${name}`);
      args = { id: name, args };
      name = "tool_call";
    }
    return { respond: { type: "tool-calls", toolCalls: [{ id: callId, name, arguments: JSON.stringify(args) }] } };
  };
  if (traits.heldTurn && turn.text.includes(traits.heldTurn.marker)) {
    if (traits.heldTurn.progressCard && !hasToolOutput(turn.items, callId)) return toolReply("progress_card", { markdown: "Mock reply is streaming; completion is pending.", plan: [{ step: "Publish progress", status: "completed" }, { step: "Complete the held reply", status: "in_progress" }] });
    return { respond: { type: "final-text", text: `**${traits.heldTurn.marker}**\n\nThe held reply is complete.` }, holdMs: traits.heldTurn.holdMs };
  }
  if (traits.overflowOnce && turn.text.includes(traits.overflowOnce.marker)) {
    if (!overflowTriggers.has(digest)) {
      if (overflowTriggers.size >= 4096) throw new Error("mock overflow trigger limit reached");
      overflowTriggers.add(digest);
      return { respond: { type: "error", status: 400, message: "This request exceeds the model's maximum context length. Reduce the context and retry.", errorType: "invalid_request_error", code: "context_length_exceeded" } };
    }
    return { respond: { type: "final-text", text: `${traits.overflowOnce.marker}_RECOVERED` } };
  }
  if (body.model === traits.toolCallModel?.modelId) {
    const requested = requestedMockTool(turn.text);
    if (!requested) return { respond: { type: "final-text", text: "KOVA_AGENT_OK" } };
    return hasToolOutput(turn.items, callId) ? { respond: { type: "final-text", text: "KOVA_TOOL_DONE" } } : toolReply(requested.name, requested.arguments);
  }
  if (body.model === traits.singleSlotModel?.modelId) return { respond: { type: "final-text", text: "KOVA_SERIAL_DONE" }, delayMs: traits.singleSlotModel.responseDelayMs };
  return null;
}
