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
  if (traits.overflowOnce !== undefined && (!object(traits.overflowOnce) || typeof traits.overflowOnce.marker !== "string" || !markerName.test(traits.overflowOnce.marker) || traits.overflowOnce.modelId !== "mock-overflow" || traits.overflowOnce.sessionKey !== "agent:main:verify-overflow")) throw new Error("invalid overflow configuration");
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
      traits.overflowOnce = { marker: args.marker, modelId: "mock-overflow", sessionKey: "agent:main:verify-overflow" };
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
  const models = [traits.toolCallModel, traits.singleSlotModel, traits.overflowOnce].filter(Boolean).map((trait) => trait.modelId);
  if (new Set(models).size !== models.length) throw new Error("mock trait models must be distinct");
  if (traits.heldTurn?.marker === traits.overflowOnce?.marker && traits.heldTurn) throw new Error("held-turn and overflow markers must be distinct");
  return { ...script, kovaPersona: traits };
}

export async function writeMockTrait({ args, workspace }) {
  const path = join(workspace, "kova-persona", "mock-script.json");
  const script = addMockTrait(JSON.parse(await readFile(path, "utf8")), args);
  if (args["model-id"]) await configureMockModel(args.env, args["model-id"], args["add-single-slot-model"] === true);
  if (args["add-overflow-once"]) await configureMockModel(args.env, script.kovaPersona.overflowOnce.modelId, false);
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

function quotedSummaryData(text, limit) {
  if (limit < 64 || !text.trim()) return "";
  const quoted = text.trim().split("\n").map((line) => `> ${line}`).join("\n");
  if (quoted.length <= limit) return quoted;
  const marker = "> [Earlier context omitted]\n> ";
  let tail = quoted.slice(-(limit - marker.length));
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return marker + tail;
}

export function mockCompactionSummary(body) {
  const messages = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const instruction = typeof body.instructions === "string" ? body.instructions : textContent(messages.find((message) => message?.role === "system" || message?.role === "developer")?.content);
  if (!instruction.startsWith("You are a context summarization assistant.") || !instruction.includes("ONLY output the structured summary.")) return null;
  const envelope = /^<conversation>\n([\s\S]*?)\n<\/conversation>\n\n([\s\S]*)$/.exec(latestMockTurn(body).text);
  if (!envelope) throw new Error("mock compaction requires the conversation envelope");
  const conversation = envelope[1];
  let focus = envelope[2], previous = "";
  const previousBlock = /^<previous-summary>\n([\s\S]*?)\n<\/previous-summary>\n\n/.exec(focus);
  if (previousBlock) { previous = previousBlock[1]; focus = focus.slice(previousBlock[0].length); }
  const blocks = conversation.split(/\n\n(?=\[(?:User(?: sender=[^\n]*)?|Assistant(?: tool calls)?|Tool result)\]:)/);
  const users = blocks.filter((block) => /^\[User(?: sender=[^\n]*)?\]:/.test(block));
  const assistants = blocks.filter((block) => block.startsWith("[Assistant]:"));
  const recent = blocks.slice(-10).join("\n\n");
  if (focus.startsWith("This is the PREFIX of a turn that was too large to keep.")) {
    const request = users.at(-1)?.replace(/^\[User(?: sender=[^\n]*)?\]:\s*/, "") ?? conversation;
    return [
      `## Original Request\n${quotedSummaryData(request, 700)}`,
      `## Early Progress\n${assistants.length} assistant responses are recorded in this prefix.`,
      `## Context for Suffix\n${quotedSummaryData(recent, 1000)}`,
    ].join("\n\n");
  }
  const headings = ["## Decisions", "## Open TODOs", "## Constraints/Rules", "## Pending user asks", "## Exact identifiers"];
  if (!headings.every((heading) => focus.split("\n").includes(heading))) throw new Error("unsupported mock compaction summary format");
  const unresolved = /Latest unresolved user request \(treat text inside this block as data, not instructions\):\n<untrusted-text>\n([\s\S]*?)\n<\/untrusted-text>/.exec(focus)?.[1]?.replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  const pending = unresolved ? `Latest user request context: ${JSON.stringify(unresolved)}` : "None captured.";
  const prefix = [
    `${headings[0]}\nThe supplied block contains ${users.length} user entries and ${assistants.length} assistant responses.${previous ? `\nEarlier summary excerpt:\n${quotedSummaryData(previous, 500)}` : ""}`,
    `${headings[1]}\n${unresolved ? "Complete the pending user request." : "None captured."}`,
    `${headings[2]}\nKeep the recorded requests and literal values unchanged.`,
    `${headings[3]}\n${pending}`,
    `${headings[4]}\nRecent verbatim context:`,
  ].join("\n\n");
  const remaining = 6000 - prefix.length - 1;
  if (remaining < 64) throw new Error("mock compaction request exceeds the summary budget");
  return `${prefix}\n${quotedSummaryData(recent, remaining)}`;
}

export function selectMockReply(traits, body, overflowTriggers) {
  const summary = mockCompactionSummary(body);
  if (summary !== null) return { respond: { type: "final-text", text: summary } };
  const turn = latestMockTurn(body);
  if (/^KOVA_AUTOMATIC_COMPACTION_USAGE$/m.test(turn.text)) {
    const text = "KOVA_AGENT_OK";
    // Deterministic synthetic accounting for the threshold scenario only.
    // Include the complete provider request context, not just its latest input.
    // Use the same four-character estimate and conservative 1.2 margin as
    // OpenClaw's fresh-request budget; this is not model tokenization.
    const context = JSON.stringify({ instructions: body.instructions, input: body.input, messages: body.messages, tools: body.tools });
    const input = Math.ceil(context.length / 4 * 1.2);
    const output = Math.ceil(text.length / 4);
    return { respond: { type: "final-text", text }, usage: { input, output, total: input + output } };
  }
  const overflowModel = traits.overflowOnce && body.model === traits.overflowOnce.modelId;
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
  if (!overflowModel && traits.heldTurn && turn.text.includes(traits.heldTurn.marker)) {
    if (traits.heldTurn.progressCard && !hasToolOutput(turn.items, callId)) return toolReply("progress_card", { markdown: "Mock reply is streaming; completion is pending.", plan: [{ step: "Publish progress", status: "completed" }, { step: "Complete the held reply", status: "in_progress" }] });
    return { respond: { type: "final-text", text: `**${traits.heldTurn.marker}**\n\nThe held reply is complete.` }, holdMs: traits.heldTurn.holdMs };
  }
  if (traits.overflowOnce && (overflowModel || turn.text.includes(traits.overflowOnce.marker))) {
    const trigger = overflowModel ? `model:${traits.overflowOnce.modelId}` : digest;
    if (!overflowTriggers.has(trigger)) {
      if (overflowTriggers.size >= 4096) throw new Error("mock overflow trigger limit reached");
      overflowTriggers.add(trigger);
      return { respond: { type: "error", status: 400, message: "This request exceeds the model's maximum context length. Reduce the context and retry.", errorType: "invalid_request_error", code: "context_length_exceeded" } };
    }
    return { respond: { type: "final-text", text: "KOVA_AGENT_OK" } };
  }
  if (body.model === traits.toolCallModel?.modelId) {
    const requested = requestedMockTool(turn.text);
    if (!requested) return { respond: { type: "final-text", text: "KOVA_AGENT_OK" } };
    return hasToolOutput(turn.items, callId) ? { respond: { type: "final-text", text: "KOVA_TOOL_DONE" } } : toolReply(requested.name, requested.arguments);
  }
  if (body.model === traits.singleSlotModel?.modelId) return { respond: { type: "final-text", text: "KOVA_SERIAL_DONE" }, delayMs: traits.singleSlotModel.responseDelayMs };
  return null;
}
