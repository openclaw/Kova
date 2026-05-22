#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mediaFingerprint } from "../../channel-conformance/media-fingerprint.mjs";

const args = parseArgs(process.argv.slice(2));
const dir = requiredArg(args, "dir");
const requestedPort = Number(args.port ?? 0);
const host = args.host ?? "127.0.0.1";
const token = args.token ?? "999001:kova-telegram-token";
const portFile = join(dir, "port");
const callsPath = join(dir, "calls.jsonl");
const pollsPath = join(dir, "polls.jsonl");
const startupPath = join(dir, "startup.json");
const MAX_RETAINED_POLLS = 2000;
const MAX_EMPTY_POLL_DELAY_MS = 100;

let nextMessageId = 10_000;
let updates = [];
let calls = [];
let polls = [];

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
  callsPath,
  pollsPath
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
  if (request.method === "GET" && url.pathname.startsWith(`/file/bot${token}/`)) {
    const filePath = decodeURIComponent(url.pathname.slice(`/file/bot${token}/`.length));
    const body = mediaBytesForFilePath(filePath);
    const call = {
      schemaVersion: "kova.telegramPlatformShim.call.v1",
      receivedAt: new Date().toISOString(),
      tokenMatches: true,
      method: "downloadFile",
      path: url.pathname,
      body: { file_path: filePath },
      responseOk: true,
      result: {
        file_path: filePath,
        sizeBytes: body.length,
        sha256: sha256(body),
        fingerprint: mediaFingerprint(body)
      }
    };
    calls.push(call);
    await appendJsonLine(callsPath, call);
    response.writeHead(200, { "content-type": contentTypeForFilePath(filePath) });
    response.end(body);
    return;
  }
  if (request.method === "POST" && url.pathname === "/__kova/enqueue-update") {
    const body = await readRequestBody(request);
    const payload = parseJsonObject(body.toString("utf8"));
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
    polls = [];
    await writeFile(callsPath, "", "utf8");
    await writeFile(pollsPath, "", "utf8");
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
  if (request.method === "GET" && url.pathname === "/__kova/polls") {
    writeJson(response, 200, {
      ok: true,
      result: polls
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
  if (method === "getUpdates") {
    const returnedUpdates = Array.isArray(result.result) ? result.result : [];
    if (returnedUpdates.length === 0) {
      await delay(emptyPollDelayMs(body));
    }
    const poll = {
      schemaVersion: "kova.telegramPlatformShim.poll.v1",
      receivedAt: call.receivedAt,
      tokenMatches: call.tokenMatches,
      method,
      path: call.path,
      body: compactGetUpdatesBody(body),
      responseOk: call.responseOk,
      returnedCount: returnedUpdates.length,
      returnedUpdateIds: returnedUpdates.map((update) => update?.update_id).filter(Number.isInteger)
    };
    if (poll.returnedCount > 0) {
      polls.push(poll);
      if (polls.length > MAX_RETAINED_POLLS) {
        polls = polls.slice(-MAX_RETAINED_POLLS);
      }
      await appendJsonLine(pollsPath, poll);
    }
  } else {
    calls.push(call);
    await appendJsonLine(callsPath, call);
  }
  writeJson(response, 200, result);
}

function compactGetUpdatesBody(body) {
  return {
    ...(body.offset != null ? { offset: body.offset } : {}),
    ...(body.timeout != null ? { timeout: body.timeout } : {}),
    ...(body.limit != null ? { limit: body.limit } : {}),
    ...(body.allowed_updates != null ? { allowed_updates: body.allowed_updates } : {})
  };
}

function emptyPollDelayMs(body) {
  const timeoutSeconds = Number(body.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return 0;
  }
  return Math.min(Math.ceil(timeoutSeconds * 1000), MAX_EMPTY_POLL_DELAY_MS);
}

function delay(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (method === "getFile") {
    const fileId = body.file_id ?? body.fileId ?? "kova-file";
    return {
      ok: true,
      result: {
        file_id: fileId,
        file_unique_id: `${fileId}-unique`,
        file_size: mediaBytesForFilePath(filePathForFileId(fileId)).length,
        file_path: filePathForFileId(fileId)
      }
    };
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
        ...(typeof body.caption === "string" ? { caption: body.caption } : {}),
        ...(method === "sendPoll" ? {
          poll: {
            id: `poll-${nextMessageId}`,
            question: body.question ?? "",
            options: normalizePollOptions(body.options)
          }
        } : {})
      }
    };
  }
  if (method === "editMessageText") {
    return {
      ok: true,
      result: {
        message_id: Number(body.message_id ?? body.messageId ?? nextMessageId++),
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: body.chat_id ?? body.chatId ?? -1003970070733,
          type: "supergroup",
          title: "Kova Telegram Shim"
        },
        ...(typeof body.text === "string" ? { text: body.text } : {})
      }
    };
  }
  if (method === "createForumTopic") {
    return {
      ok: true,
      result: {
        message_thread_id: nextMessageId++,
        name: body.name ?? "Kova Topic",
        icon_color: body.icon_color ?? null
      }
    };
  }
  if (
    method === "setMessageReaction" ||
    method === "deleteMessage" ||
    method === "pinChatMessage" ||
    method === "unpinChatMessage" ||
    method === "editForumTopic"
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
    "sendAnimation",
    "sendPoll"
  ]).has(method);
}

function normalizePollOptions(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function filePathForFileId(fileId) {
  const value = String(fileId ?? "kova-file");
  if (value.includes("video")) {
    return `videos/${value}.mp4`;
  }
  if (value.includes("audio") || value.includes("voice")) {
    return `audio/${value}.ogg`;
  }
  if (value.includes("document") || value.includes("file")) {
    return `documents/${value}.txt`;
  }
  return `photos/${value}.png`;
}

function contentTypeForFilePath(filePath) {
  if (/\.mp4$/iu.test(filePath)) {
    return "video/mp4";
  }
  if (/\.(?:ogg|opus)$/iu.test(filePath)) {
    return "audio/ogg";
  }
  if (/\.txt$/iu.test(filePath)) {
    return "text/plain; charset=utf-8";
  }
  return "image/png";
}

function mediaBytesForFilePath(filePath) {
  if (/\.mp4$/iu.test(filePath)) {
    return Buffer.from("KOVA_TELEGRAM_VIDEO_INPUT");
  }
  if (/\.(?:ogg|opus)$/iu.test(filePath)) {
    return Buffer.from("KOVA_TELEGRAM_AUDIO_INPUT");
  }
  if (/\.txt$/iu.test(filePath)) {
    return Buffer.from("KOVA_TELEGRAM_DOCUMENT_INPUT\n");
  }
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8AARLJgYGBgYPgPAAf5AgPlsp7cAAAAAElFTkSuQmCC",
    "base64"
  );
}

function parseTelegramBody(request, rawBody) {
  const contentType = String(request.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) {
    return parseJsonObject(rawBody.toString("utf8"));
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")));
  }
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartFields(rawBody, contentType);
  }
  const text = rawBody.toString("utf8");
  if (!text.trim()) {
    return {};
  }
  try {
    return parseJsonObject(text);
  } catch {
    return { rawBody: text };
  }
}

function parseMultipartFields(rawBody, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/iu);
  const boundary = boundaryMatch?.[1]?.trim();
  if (!boundary) {
    return { rawBody };
  }
  const fields = {};
  const rawText = rawBody.toString("latin1");
  const marker = `--${boundary}`;
  for (const part of rawText.split(marker)) {
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
    const body = stripMultipartPartTerminator(bodyParts.join("\n\n"));
    const isFilePart = Boolean(disposition?.[2]) || /^content-type:\s*(?:image|audio|video|application\/octet-stream)/imu.test(rawHeaders);
    if (isFilePart) {
      const bodyBuffer = Buffer.from(body, "latin1");
      fields[name] = {
        file: true,
        filename: disposition?.[2] ?? null,
        sizeBytes: bodyBuffer.length,
        sha256: sha256(bodyBuffer),
        fingerprint: mediaFingerprint(bodyBuffer)
      };
    } else {
      fields[name] = Buffer.from(body, "latin1").toString("utf8");
    }
  }
  return fields;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function stripMultipartPartTerminator(value) {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.replace(/\n$/u, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
