#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const dir = requiredArg(args, "dir");
const requestedPort = Number(args.port ?? 0);
const host = args.host ?? "127.0.0.1";
const token = args.token ?? "999001:kova-telegram-token";
const portFile = join(dir, "port");
const callsPath = join(dir, "calls.jsonl");
const startupPath = join(dir, "startup.json");

let nextMessageId = 10_000;
let updates = [];
let calls = [];

await mkdir(dir, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    writeJson(response, 500, {
      ok: false,
      description: error instanceof Error ? error.message : String(error)
    });
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(requestedPort, host, resolve);
});

const address = server.address();
if (!address || typeof address !== "object") {
  throw new Error("telegram platform shim did not bind a TCP port");
}

const startup = {
  schemaVersion: "kova.telegramPlatformShim.startup.v1",
  host,
  port: address.port,
  apiRoot: `http://${host}:${address.port}`,
  token,
  callsPath
};
await writeFile(portFile, `${address.port}\n`, "utf8");
await writeFile(startupPath, `${JSON.stringify(startup, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(startup)}\n`);

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      queuedUpdates: updates.length,
      callCount: calls.length
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__kova/enqueue-update") {
    const body = await readRequestBody(request);
    const payload = parseJsonObject(body);
    const incoming = Array.isArray(payload.updates) ? payload.updates : [payload.update];
    for (const update of incoming) {
      if (!update || typeof update !== "object" || !Number.isInteger(update.update_id)) {
        throw new Error("queued Telegram update must be an object with integer update_id");
      }
      updates.push(update);
    }
    updates.sort((left, right) => left.update_id - right.update_id);
    writeJson(response, 200, { ok: true, queuedUpdates: updates.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__kova/reset") {
    updates = [];
    calls = [];
    await writeFile(callsPath, "", "utf8");
    writeJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__kova/calls") {
    writeJson(response, 200, {
      ok: true,
      result: calls
    });
    return;
  }

  const match = url.pathname.match(/^\/bot([^/]+)\/([^/]+)$/u);
  if (!match || request.method !== "POST") {
    writeJson(response, 404, {
      ok: false,
      description: "Not Found"
    });
    return;
  }

  const [, requestToken, method] = match;
  const rawBody = await readRequestBody(request);
  const body = parseTelegramBody(request, rawBody);
  const call = {
    schemaVersion: "kova.telegramPlatformShim.call.v1",
    receivedAt: new Date().toISOString(),
    tokenMatches: requestToken === token,
    method,
    path: url.pathname,
    body
  };
  const result = telegramResult(method, body);
  call.responseOk = result.ok === true;
  call.result = result.result ?? null;
  calls.push(call);
  await appendJsonLine(callsPath, call);
  writeJson(response, 200, result);
}

function telegramResult(method, body) {
  if (method === "getMe") {
    return {
      ok: true,
      result: {
        id: 999001,
        is_bot: true,
        first_name: "Kova",
        username: "kova_mock_bot",
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
        has_topics_enabled: true
      }
    };
  }
  if (method === "getWebhookInfo") {
    return { ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } };
  }
  if (method === "deleteWebhook" || method === "setMyCommands" || method === "sendChatAction") {
    return { ok: true, result: true };
  }
  if (method === "getChat") {
    return {
      ok: true,
      result: {
        id: body.chat_id ?? body.chatId ?? -1003970070733,
        type: "supergroup",
        title: "Kova Telegram Shim",
        is_forum: true
      }
    };
  }
  if (method === "getUpdates") {
    const offset = Number.isInteger(Number(body.offset)) ? Number(body.offset) : null;
    const result = offset === null ? updates : updates.filter((update) => update.update_id >= offset);
    return { ok: true, result };
  }
  if (isSendMethod(method)) {
    return {
      ok: true,
      result: {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: body.chat_id ?? body.chatId ?? -1003970070733,
          type: "supergroup",
          title: "Kova Telegram Shim"
        },
        ...(body.message_thread_id != null ? { message_thread_id: Number(body.message_thread_id) } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(typeof body.caption === "string" ? { caption: body.caption } : {})
      }
    };
  }
  if (
    method === "setMessageReaction" ||
    method === "deleteMessage" ||
    method === "pinChatMessage" ||
    method === "unpinChatMessage" ||
    method === "editForumTopic" ||
    method === "createForumTopic"
  ) {
    return { ok: true, result: true };
  }
  return { ok: true, result: true };
}

function isSendMethod(method) {
  return new Set([
    "sendMessage",
    "sendPhoto",
    "sendVideo",
    "sendVideoNote",
    "sendAudio",
    "sendVoice",
    "sendDocument",
    "sendAnimation"
  ]).has(method);
}

function parseTelegramBody(request, rawBody) {
  const contentType = String(request.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) {
    return parseJsonObject(rawBody);
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartFields(rawBody, contentType);
  }
  if (!rawBody.trim()) {
    return {};
  }
  try {
    return parseJsonObject(rawBody);
  } catch {
    return { rawBody };
  }
}

function parseMultipartFields(rawBody, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/iu);
  const boundary = boundaryMatch?.[1]?.trim();
  if (!boundary) {
    return { rawBody };
  }
  const fields = {};
  const marker = `--${boundary}`;
  for (const part of rawBody.split(marker)) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--") {
      continue;
    }
    const [rawHeaders, ...bodyParts] = part.split(/\r?\n\r?\n/u);
    const disposition = rawHeaders.match(/content-disposition:[^\n]*name="([^"]+)"(?:;[^\n]*filename="([^"]+)")?/iu);
    const name = disposition?.[1];
    if (!name) {
      continue;
    }
    const body = bodyParts.join("\n\n").replace(/\r?\n--$/u, "").trimEnd();
    fields[name] = disposition?.[2] ? `[file:${disposition[2]}]` : body;
  }
  return fields;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text) {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed;
}

async function appendJsonLine(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) {
      throw new Error(`unexpected argument '${key}'`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}
