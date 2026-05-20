#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";

const options = parseArgs(process.argv.slice(2));
const marker = options.marker ?? "KOVA_AGENT_OK";
const requestLog = options.requestLog ?? null;
const providerMode = options.mode ?? "normal";
const delayMs = options.delayMs ?? 0;
const stallMs = options.stallMs ?? 65000;
const errorStatus = options.errorStatus ?? 503;
let nextRequestId = 1;
let providerPostCount = 0;
const emittedToolCallInboundEventIds = new Set();

const supportedModes = new Set(["normal", "slow", "timeout", "malformed", "streaming-stall", "error-then-recover", "concurrent-pressure"]);
if (!supportedModes.has(providerMode)) {
  throw new Error(`unsupported mock provider mode '${providerMode}'`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeSse(res, events) {
  res.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream"
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeMalformed(res, stream) {
  if (stream) {
    res.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream"
    });
    res.write("data: {this-is-not-json}\n\n");
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{this-is-not-json");
}

async function writeStreamingStall(res, stream, call) {
  if (!stream) {
    await sleep(stallMs);
    if (!res.destroyed && !res.writableEnded) {
      writeJson(res, 504, { error: { message: `mock provider ${call.mode} timed out` } });
    }
    return;
  }
  res.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream"
  });
  res.write(`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_kova_stall", role: "assistant" } })}\n\n`);
  await sleep(stallMs);
  if (!res.destroyed && !res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function responseEvents(text) {
  const usage = mockUsage();
  return [
    {
      type: "response.output_item.added",
      item: { type: "message", id: "msg_kova_1", role: "assistant", content: [], status: "in_progress" }
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_kova_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }]
      }
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage
      }
    }
  ];
}

function responseToolCallEvents(toolCall) {
  const usage = mockUsage();
  const args = JSON.stringify(toolCall.arguments ?? {});
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: toolCall.id,
        call_id: toolCall.callId,
        name: toolCall.name,
        arguments: ""
      }
    },
    {
      type: "response.function_call_arguments.delta",
      delta: args
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: toolCall.id,
        call_id: toolCall.callId,
        name: toolCall.name,
        arguments: args
      }
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage
      }
    }
  ];
}

function mockUsage() {
  return {
    input_tokens: 9,
    output_tokens: 3,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 0 }
  };
}

function chatUsage() {
  return { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 };
}

function writeChatCompletion(res, stream, requestBodyText) {
  const responseText = resolveResponseText(requestBodyText);
  if (stream) {
    writeSse(res, [
      {
        id: "chatcmpl_kova",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: responseText } }]
      },
      {
        id: "chatcmpl_kova",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      }
    ]);
    return;
  }

  writeJson(res, 200, {
    id: "chatcmpl_kova",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
    usage: chatUsage()
  });
}

const server = http.createServer(async (req, res) => {
  const receivedAtEpochMs = Date.now();
  const receivedAt = new Date(receivedAtEpochMs).toISOString();
  const requestId = req.headers["x-request-id"] || req.headers["openai-request-id"] || `kova-mock-${nextRequestId++}`;
  let firstByteAtEpochMs = null;
  let firstChunkAtEpochMs = null;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk, ...args) => {
    if (firstByteAtEpochMs === null) {
      firstByteAtEpochMs = Date.now();
    }
    if (firstChunkAtEpochMs === null) {
      firstChunkAtEpochMs = firstByteAtEpochMs;
    }
    return originalWrite(chunk, ...args);
  };
  res.end = (chunk, ...args) => {
    if (chunk !== undefined && chunk !== null && firstByteAtEpochMs === null) {
      firstByteAtEpochMs = Date.now();
    }
    return originalEnd(chunk, ...args);
  };
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let bodyText = "";
  let body = {};
  let parseError = null;
  let loggable = false;
  let stream = false;
  let model = null;
  let usage = null;
  let behavior = {
    mode: providerMode,
    outcome: null,
    errorClass: null,
    providerCallIndex: null
  };
  let logged = false;

  function logRequest(outcome) {
    if (!requestLog || !loggable) {
      return;
    }
    if (logged) {
      return;
    }
    logged = true;
    const respondedAtEpochMs = Date.now();
    const status = outcome === "aborted" && !res.writableEnded ? 499 : res.statusCode;
    const entry = {
      schemaVersion: "kova.mockProvider.request.v1",
      requestId: String(requestId),
      mode: behavior.mode,
      behavior: behavior.mode,
      outcome,
      errorClass: behavior.errorClass,
      providerCallIndex: behavior.providerCallIndex,
      receivedAt,
      receivedAtEpochMs,
      respondedAt: new Date(respondedAtEpochMs).toISOString(),
      respondedAtEpochMs,
      durationMs: respondedAtEpochMs - receivedAtEpochMs,
      firstByteAt: firstByteAtEpochMs === null ? null : new Date(firstByteAtEpochMs).toISOString(),
      firstByteAtEpochMs,
      firstByteLatencyMs: firstByteAtEpochMs === null ? null : firstByteAtEpochMs - receivedAtEpochMs,
      firstChunkAt: firstChunkAtEpochMs === null ? null : new Date(firstChunkAtEpochMs).toISOString(),
      firstChunkAtEpochMs,
      firstChunkLatencyMs: firstChunkAtEpochMs === null ? null : firstChunkAtEpochMs - receivedAtEpochMs,
      method: req.method,
      route: url.pathname,
      path: url.pathname,
      model,
      stream,
      status,
      usage,
      statusClass: typeof status === "number" ? `${Math.floor(status / 100)}xx` : null,
      bodyBytes: Buffer.byteLength(bodyText),
      parseError,
      kova: extractKovaRequestMarkers(bodyText)
    };
    fs.appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
  }

  res.on("finish", () => {
    logRequest("completed");
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      logRequest("aborted");
    }
  });

  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    loggable = true;
    writeJson(res, 200, {
      object: "list",
      data: [{ id: "gpt-5.5", object: "model", owned_by: "kova" }]
    });
    return;
  }

  bodyText = await readBody(req);
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch (error) {
    body = {};
    parseError = error.message;
  }
  model = typeof body.model === "string" ? body.model : null;
  stream = body.stream !== false;
  loggable = url.pathname.startsWith("/v1/");

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    behavior = behaviorForProviderCall();
    await applyDelayForBehavior(behavior);
    const scriptedFailure = scriptedFailureBehavior(bodyText, behavior.providerCallIndex);
    if (scriptedFailure) {
      behavior = scriptedFailure;
    }
    if (await maybeWriteFailureBehavior(res, behavior, stream)) {
      return;
    }
    const responseText = resolveResponseText(bodyText);
    const responseToolCall = shouldEmitResponseToolCall(bodyText)
      ? resolveResponseToolCall(bodyText)
      : null;
    if (responseToolCall) {
      markResponseToolCallEmitted(bodyText);
      if (body.stream === false) {
        usage = mockUsage();
        writeJson(res, 200, {
          id: "resp_kova",
          object: "response",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: responseToolCall.id,
              call_id: responseToolCall.callId,
              name: responseToolCall.name,
              arguments: JSON.stringify(responseToolCall.arguments ?? {})
            }
          ],
          usage
        });
        return;
      }
      usage = mockUsage();
      writeSse(res, responseToolCallEvents(responseToolCall));
      return;
    }
    if (body.stream === false) {
      usage = mockUsage();
      writeJson(res, 200, {
        id: "resp_kova",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_kova_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: responseText, annotations: [] }]
          }
        ],
        usage
      });
      return;
    }
    usage = mockUsage();
    writeSse(res, responseEvents(responseText));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    behavior = behaviorForProviderCall();
    await applyDelayForBehavior(behavior);
    const scriptedFailure = scriptedFailureBehavior(bodyText, behavior.providerCallIndex);
    if (scriptedFailure) {
      behavior = scriptedFailure;
    }
    if (await maybeWriteFailureBehavior(res, behavior, body.stream !== false)) {
      return;
    }
    if (body.stream === false) {
      usage = chatUsage();
    }
    writeChatCompletion(res, body.stream !== false, bodyText);
    return;
  }

  writeJson(res, 404, { error: { message: `unhandled mock route: ${req.method} ${url.pathname}` } });
});

function behaviorForProviderCall() {
  providerPostCount += 1;
  if (providerMode === "error-then-recover" && providerPostCount > 1) {
    return {
      mode: "normal",
      outcome: null,
      errorClass: null,
      providerCallIndex: providerPostCount
    };
  }
  return {
    mode: providerMode,
    outcome: null,
    errorClass: null,
    providerCallIndex: providerPostCount
  };
}

function scriptedFailureBehavior(requestBodyText, providerCallIndex) {
  const status = latestMatch(String(requestBodyText ?? ""), /KOVA_MOCK_PROVIDER_ERROR_STATUS:(\d{3})/g);
  if (!status) {
    return null;
  }
  return {
    mode: "scripted-error",
    outcome: null,
    errorClass: "scripted-provider-error",
    providerCallIndex,
    status: Number(status)
  };
}

function resolveResponseText(requestBodyText) {
  const matches = [...String(requestBodyText ?? "").matchAll(/KOVA_MOCK_RESPONSE_B64:([A-Za-z0-9+/_=-]+)/g)];
  const latest = matches.at(-1);
  if (!latest) {
    return marker;
  }
  try {
    return Buffer.from(latest[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
  } catch {
    return marker;
  }
}

function resolveResponseToolCall(requestBodyText) {
  const matches = [...String(requestBodyText ?? "").matchAll(/KOVA_MOCK_TOOL_CALL_B64:([A-Za-z0-9+/_=-]+)/g)];
  const latest = matches.at(-1);
  if (!latest) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(latest[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")
    );
    const name = typeof decoded.name === "string" && decoded.name.trim()
      ? decoded.name.trim()
      : null;
    if (!name) {
      return null;
    }
    return {
      id: typeof decoded.id === "string" && decoded.id.trim() ? decoded.id.trim() : "fc_kova_1",
      callId: typeof decoded.callId === "string" && decoded.callId.trim()
        ? decoded.callId.trim()
        : "call_kova_1",
      name,
      arguments: decoded.arguments && typeof decoded.arguments === "object" && !Array.isArray(decoded.arguments)
        ? decoded.arguments
        : {}
    };
  } catch {
    return null;
  }
}

function shouldEmitResponseToolCall(requestBodyText) {
  const text = String(requestBodyText ?? "");
  if (!/KOVA_MOCK_TOOL_CALL_B64:/.test(text)) {
    return false;
  }
  const latestToolFixtureIndex = text.lastIndexOf("KOVA_MOCK_TOOL_CALL_B64:");
  const inboundEventId = latestMatch(text, /KOVA_INBOUND_EVENT_ID:([A-Za-z0-9._:-]+)/g);
  if (inboundEventId) {
    const latestInboundEventIndex = latestMatchIndex(text, /KOVA_INBOUND_EVENT_ID:([A-Za-z0-9._:-]+)/g);
    if (latestToolFixtureIndex < latestInboundEventIndex) {
      return false;
    }
    return !emittedToolCallInboundEventIds.has(inboundEventId);
  }
  const compactOutputIndex = text.lastIndexOf('"type":"function_call_output"');
  const spacedOutputIndex = text.lastIndexOf('"type": "function_call_output"');
  const latestFunctionOutputIndex = Math.max(compactOutputIndex, spacedOutputIndex);
  if (latestFunctionOutputIndex < 0) {
    return true;
  }
  if (latestToolFixtureIndex < 0) {
    return false;
  }
  return latestFunctionOutputIndex < latestToolFixtureIndex;
}

function markResponseToolCallEmitted(requestBodyText) {
  const inboundEventId = latestMatch(
    String(requestBodyText ?? ""),
    /KOVA_INBOUND_EVENT_ID:([A-Za-z0-9._:-]+)/g
  );
  if (inboundEventId) {
    emittedToolCallInboundEventIds.add(inboundEventId);
  }
}

function extractKovaRequestMarkers(requestBodyText) {
  const text = String(requestBodyText ?? "");
  return {
    modelTurnCases: uniqueMatches(text, /KOVA_MODEL_TURN_CASE:([A-Za-z0-9._-]+)/g),
    inboundEventIds: uniqueMatches(text, /KOVA_INBOUND_EVENT_ID:([A-Za-z0-9._:-]+)/g),
    toolCallFixtures: uniqueMatches(text, /KOVA_MOCK_TOOL_CALL_B64:([A-Za-z0-9+/_=-]+)/g).length
  };
}

function latestMatch(text, pattern) {
  let latest = null;
  for (const match of text.matchAll(pattern)) {
    latest = match[1];
  }
  return latest;
}

function latestMatchIndex(text, pattern) {
  let latest = -1;
  for (const match of text.matchAll(pattern)) {
    latest = match.index ?? latest;
  }
  return latest;
}

function uniqueMatches(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];
}

async function applyDelayForBehavior(behavior) {
  if (behavior.mode === "slow" || behavior.mode === "concurrent-pressure") {
    await sleep(delayMs);
  }
}

async function maybeWriteFailureBehavior(res, behavior, stream) {
  if (behavior.mode === "scripted-error") {
    writeJson(res, behavior.status, {
      error: {
        message: "mock provider scripted failure",
        type: "kova_mock_provider_scripted_error"
      }
    });
    return true;
  }
  if (behavior.mode === "timeout") {
    behavior.errorClass = "provider-timeout";
    await sleep(stallMs);
    if (!res.destroyed && !res.writableEnded) {
      writeJson(res, 504, { error: { message: "mock provider timeout" } });
    }
    return true;
  }
  if (behavior.mode === "malformed") {
    behavior.errorClass = "malformed-response";
    writeMalformed(res, stream);
    return true;
  }
  if (behavior.mode === "streaming-stall") {
    behavior.errorClass = "streaming-stall";
    await writeStreamingStall(res, stream, behavior);
    return true;
  }
  if (behavior.mode === "error-then-recover") {
    behavior.errorClass = "provider-error";
    writeJson(res, errorStatus, { error: { message: "mock provider transient failure", type: "kova_mock_provider_error" } });
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

server.listen(Number(options.port ?? 0), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) {
    throw new Error("mock server did not expose a port");
  }
  if (options.portFile) {
    fs.writeFileSync(options.portFile, `${port}\n`, "utf8");
  }
  console.log(`kova mock openai listening on ${port}`);
});

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return {
    marker: parsed.marker,
    port: parsed.port,
    portFile: parsed.portfile,
    requestLog: parsed.requestlog,
    mode: parsed.mode,
    delayMs: positiveInteger(parsed.delayms, "delay-ms", 0),
    stallMs: positiveInteger(parsed.stallms, "stall-ms", 65000),
    errorStatus: positiveInteger(parsed.errorstatus, "error-status", 503)
  };
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}
