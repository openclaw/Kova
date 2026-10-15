import { verificationRequest } from "./mock-request.mjs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJson } from "mock-ai-provider/dist/shared/http.js";
import { renderResponse, renderResponseStreamEvents } from "mock-ai-provider/dist/providers/openai/responses/render-responses.js";
import { renderChatCompletion } from "mock-ai-provider/dist/providers/openai/chat/render-chat-completions.js";
import { writeChatCompletionStream } from "mock-ai-provider/dist/providers/openai/chat/render-chat-completion-stream.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function verificationRepliesEnabled(script) {
  if (script.kovaVerification === undefined) return script.kovaPersona?.version === 1;
  if (!object(script.kovaVerification) || script.kovaVerification.version !== 1 || Object.keys(script.kovaVerification).length !== 1) throw new Error("invalid verification reply configuration");
  return true;
}

function textContent(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
}

function latestTurn(body) {
  if (typeof body.input === "string") return { text: body.input, items: [], key: body.input };
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const index = items.findLastIndex((item) => item?.role === "user" && !textContent(item.content).trim().startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"));
  if (index < 0) return { text: "", items: [], key: "" };
  const text = textContent(items[index].content);
  return { text, items: items.slice(index + 1), key: typeof items[index].id === "string" ? `${items[index].id}\n${text}` : text };
}

export function selectVerificationReply(body) {
  if (!object(body)) throw new Error("request body must be an object");
  const messages = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const instructions = typeof body.instructions === "string" ? body.instructions : textContent(messages.find((item) => item?.role === "system" || item?.role === "developer")?.content);
  if (instructions.startsWith("You are a context summarization assistant.") && instructions.includes("ONLY output the structured summary.")) return null;
  const turn = latestTurn(body);
  const { hold, tool } = verificationRequest(turn.text);
  if (!hold && !tool) return null;
  if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 256)) throw new Error("verification model name exceeds 256 characters");
  const digest = createHash("sha256").update(`${body.model ?? ""}\n${turn.key}`).digest("hex");
  const callId = `call_kova_verify_${digest.slice(0, 24)}`;
  const completed = turn.items.some((item) => (item?.type === "function_call_output" && item.call_id === callId) || (item?.role === "tool" && item.tool_call_id === callId));
  const toolReply = (name, args) => {
    const names = new Set(Array.isArray(body.tools) ? body.tools.map((entry) => entry?.name ?? entry?.function?.name) : []);
    if (!names.has(name)) {
      if (!names.has("tool_call")) throw new Error(`requested tool is unavailable: ${name}`);
      args = { id: name, args };
      name = "tool_call";
    }
    return { respond: { type: "tool-calls", toolCalls: [{ id: callId, name, arguments: JSON.stringify(args) }] } };
  };
  if (tool) return completed ? { respond: { type: "final-text", text: "KOVA_TOOL_DONE" } } : toolReply(tool.name, tool.arguments);
  if (hold.progressCards && !completed) return toolReply("progress_card", {
    markdown: "Mock reply is streaming; completion is pending.",
    plan: [{ step: "Publish progress", status: "completed" }, { step: "Complete the held reply", status: "in_progress" }]
  });
  return {
    respond: { type: "final-text", text: "**KOVA_VERIFY_HOLD**\n\nThe held reply is complete." },
    holdMs: hold.holdMs
  };
}

export async function writeVerificationReply(res, body, reply, responses, signal) {
  if (!body.stream) {
    if (reply.holdMs) await sleep(reply.holdMs, undefined, { signal });
    signal.throwIfAborted();
    writeJson(res, 200, (responses ? renderResponse(body, reply) : renderChatCompletion(body, reply)).body);
    return;
  }
  const frames = [];
  let bytes = 0;
  const capture = (text, content) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 1024 * 1024 || frames.length >= 256) throw new Error("verification stream exceeds its capture limit");
    frames.push({ text, content });
  };
  if (responses) {
    for (const event of renderResponseStreamEvents(body, reply).events) capture(`data: ${JSON.stringify(event)}\n\n`, event.type === "response.output_text.delta");
    capture("data: [DONE]\n\n", false);
  } else {
    writeChatCompletionStream({ requestBody: body, step: reply, headers: {}, res: {
      writeHead() {}, end() {}, write(text) {
        const data = text.slice(6).trim();
        const parsed = data === "[DONE]" ? null : JSON.parse(data);
        capture(text, typeof parsed?.choices?.[0]?.delta?.content === "string");
      }
    } });
  }
  signal.throwIfAborted();
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const count = frames.filter((frame) => frame.content).length;
  const started = performance.now();
  let emitted = 0;
  for (const frame of frames) {
    signal.throwIfAborted();
    if (!res.write(frame.text)) await once(res, "drain", { signal });
    if (frame.content && reply.holdMs) {
      const remaining = started + reply.holdMs * (++emitted / count) - performance.now();
      if (remaining > 0) await sleep(Math.ceil(remaining), undefined, { signal });
    }
  }
  res.end();
}
