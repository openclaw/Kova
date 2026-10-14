import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { readRequestBody, writeJson } from "mock-ai-provider/dist/shared/http.js";
import { renderResponse, renderResponseStreamEvents } from "mock-ai-provider/dist/providers/openai/responses/render-responses.js";
import { renderChatCompletion } from "mock-ai-provider/dist/providers/openai/chat/render-chat-completions.js";
import { writeChatCompletionStream } from "mock-ai-provider/dist/providers/openai/chat/render-chat-completion-stream.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validHold = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 300000;

export function verificationRepliesEnabled(script) {
  if (script.kovaVerification === undefined) return script.kovaPersona?.version === 1;
  if (!object(script.kovaVerification) || script.kovaVerification.version !== 1 || Object.keys(script.kovaVerification).length !== 1) throw new Error("invalid verification reply configuration");
  return true;
}

function heldTurn(script) {
  const held = script.kovaPersona?.heldTurn;
  if (held === undefined) return null;
  if (!object(held) || typeof held.marker !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(held.marker) || !validHold(held.holdMs) || typeof held.progressCard !== "boolean") throw new Error("invalid held-turn configuration");
  return held;
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

function markerObject(text, marker) {
  const offset = text.indexOf(`${marker} `);
  if (offset < 0) return null;
  const tail = text.slice(offset + marker.length + 1).trimStart();
  if (!tail.startsWith("{")) throw new Error(`${marker} requires a JSON object`);
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < tail.length && index < MAX_MARKER_BYTES; index++) {
    const char = tail[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 32) throw new Error(`${marker} JSON nesting exceeds 32`);
    } else if ((char === "}" || char === "]") && --depth === 0) {
      const encoded = tail.slice(0, index + 1);
      if (Buffer.byteLength(encoded) > MAX_MARKER_BYTES) throw new Error(`${marker} JSON exceeds 65536 bytes`);
      return { value: JSON.parse(encoded), remainder: tail.slice(index + 1) };
    }
  }
  throw new Error(`${marker} requires complete JSON within 65536 bytes`);
}

export function selectVerificationReply(body, script = {}) {
  if (!object(body)) throw new Error("request body must be an object");
  const messages = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const instructions = typeof body.instructions === "string" ? body.instructions : textContent(messages.find((item) => item?.role === "system" || item?.role === "developer")?.content);
  if (instructions.startsWith("You are a context summarization assistant.") && instructions.includes("ONLY output the structured summary.")) return null;
  const turn = latestTurn(body);
  const marker = /KOVA_(?:VERIFY_HOLD|TOOL_CALL) /.exec(turn.text)?.[0].trimEnd();
  const marked = marker ? markerObject(turn.text, marker) : null;
  if (marked && /KOVA_(?:VERIFY_HOLD|TOOL_CALL) /.test(marked.remainder)) throw new Error("one verification marker is allowed per message");
  const hold = marker === "KOVA_VERIFY_HOLD" ? marked.value : null;
  const tool = marker === "KOVA_TOOL_CALL" ? marked.value : null;
  if (hold && (!validHold(hold.holdMs) || typeof hold.progressCards !== "boolean" || Object.keys(hold).some((key) => !["holdMs", "progressCards"].includes(key)))) throw new Error("KOVA_VERIFY_HOLD requires holdMs between 1 and 300000 and boolean progressCards");
  if (tool && (typeof tool.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) || !object(tool.arguments) || Object.keys(tool).some((key) => !["name", "arguments"].includes(key)))) throw new Error("KOVA_TOOL_CALL requires a tool name and arguments object");
  const saved = heldTurn(script);
  const overflowModel = script.kovaPersona?.overflowOnce?.modelId;
  const inherited = !hold && !tool && saved && (!overflowModel || body.model !== overflowModel) && turn.text.includes(saved.marker) ? saved : null;
  if (!hold && !tool && !inherited) return null;
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
  if ((hold?.progressCards ?? inherited.progressCard) && !completed) return toolReply("progress_card", {
    markdown: "Mock reply is streaming; completion is pending.",
    plan: [{ step: "Publish progress", status: "completed" }, { step: "Complete the held reply", status: "in_progress" }]
  });
  return {
    respond: { type: "final-text", text: `**${hold ? "KOVA_VERIFY_HOLD" : inherited.marker}**\n\nThe held reply is complete.` },
    holdMs: hold?.holdMs ?? inherited.holdMs
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

export function attachVerificationReplies(server, { script, requestLog }) {
  if (!verificationRepliesEnabled(script)) return;
  heldTurn(script);
  const original = server.listeners("request");
  if (original.length !== 1) throw new Error("unexpected mock provider request handler count");
  const fallback = original[0];
  server.removeListener("request", fallback);
  server.on("request", (req, res) => {
    void handle(req, res).catch((error) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else writeJson(res, error.statusCode ?? 400, { error: { message: error.message, type: "invalid_request_error" } });
    });
  });

  async function handle(req, res) {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method !== "POST" || !["/v1/responses", "/v1/chat/completions", "/responses", "/chat/completions"].includes(path)) return fallback.call(server, req, res);
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => { controller.abort(); if (!req.complete) req.destroy(); };
    const requestClosed = () => { if (!req.complete) abort(); };
    req.once("aborted", abort);
    req.once("close", requestClosed);
    res.once("close", abort);
    try {
      const raw = await readRequestBody(req, MAX_BODY_BYTES);
      controller.signal.throwIfAborted();
      const body = JSON.parse(raw);
      const reply = selectVerificationReply(body, script);
      if (!reply) {
        const replay = Readable.from([Buffer.from(raw)]);
        Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
        fallback.call(server, replay, res);
        return;
      }
      await writeVerificationReply(res, body, reply, path.endsWith("/responses"), controller.signal);
      if (requestLog) {
        const finished = Date.now();
        await appendFile(requestLog, `${JSON.stringify({
          schemaVersion: "mock-ai-provider.request.v1", requestId: randomUUID(), method: "POST", path,
          providerId: "openai", apiSurface: path.endsWith("/responses") ? "responses" : "chat.completions",
          model: body.model, stream: body.stream === true, status: 200,
          receivedAt: new Date(started).toISOString(), receivedAtEpochMs: started,
          respondedAt: new Date(finished).toISOString(), respondedAtEpochMs: finished,
          durationMs: finished - started, bodyBytes: Buffer.byteLength(raw),
          matchedScriptStep: "kova-verification", responseType: reply.respond.type,
          toolCallsEmitted: reply.respond.toolCalls?.length ?? 0,
          finalTextEmitted: reply.respond.type === "final-text" ? reply.respond.text : null,
          errorClass: null
        })}\n`, "utf8");
      }
    } finally {
      req.off("aborted", abort);
      req.off("close", requestClosed);
      res.off("close", abort);
    }
  }
}
