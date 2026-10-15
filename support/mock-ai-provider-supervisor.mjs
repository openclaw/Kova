#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { access, rename, rm, writeFile, readFile, appendFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createMockAiProviderServer } from "mock-ai-provider/dist/server/create-server.js";
import { listen } from "mock-ai-provider/dist/server/listen.js";
import { readRequestBody, writeJson } from "mock-ai-provider/dist/shared/http.js";
import { renderResponse, renderResponseStreamEvents } from "mock-ai-provider/dist/providers/openai/responses/render-responses.js";
import { renderChatCompletion } from "mock-ai-provider/dist/providers/openai/chat/render-chat-completions.js";
import { writeChatCompletionStream } from "mock-ai-provider/dist/providers/openai/chat/render-chat-completion-stream.js";
import { readMockTraits, selectMockReply } from "./persona/mock-content.mjs";
import {
  mockProviderOwnerRecord,
  mockProviderStopFile,
  removeMockProviderOwnerFile
} from "../src/process-safety.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const owner = mockProviderOwnerRecord(process.pid, randomUUID());
  try {
    await supervise(options, owner);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

async function supervise({ scriptPath, requestLog, serverLog, pidFile }, owner) {
  const stopFile = mockProviderStopFile(pidFile, owner);
  const startupLog = `${serverLog}.startup.${owner.pid}.${owner.token}`;
  await rm(stopFile, { force: true });
  await rm(startupLog, { force: true });

  let server = null;
  let interval = null;
  let stopping = null;
  const stopServer = async () => {
    if (!server) {
      return;
    }
    if (!stopping) {
      stopping = closeServer(server);
    }
    await stopping;
  };
  const handleSignal = () => void stopServer();

  try {
    server = await createMockAiProviderServer({
      providers: ["openai"],
      scriptPath,
      requestLogPath: requestLog,
      openAiAuth: { strict: false }
    });
    attachPersonaReplies(server, JSON.parse(await readFile(scriptPath, "utf8")), requestLog);
    const serverClosed = new Promise((resolve) => {
      server.once("close", resolve);
    });
    const { port } = await listen(server, { port: 0, host: "127.0.0.1" });
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    await writeFile(startupLog, `${JSON.stringify({
      ok: true,
      owner,
      providers: ["openai"],
      host: "127.0.0.1",
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      script: {
        source: "file",
        path: scriptPath
      },
      models: {
        source: "default"
      },
      requestLog,
      auth: {
        strict: false,
        apiKeyConfigured: false
      }
    })}\n`, "utf8");
    await writeFile(pidFile, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(startupLog, serverLog);

    // Cleanup requests never signal a persisted PID; this process owns the
    // server handle and closes its active connections before exiting.
    interval = setInterval(() => {
      void access(stopFile)
        .then(stopServer)
        .catch((error) => {
          if (error.code !== "ENOENT") {
            void stopServer();
          }
        });
    }, 50);
    interval.unref();
    await serverClosed;
  } catch (error) {
    await stopServer();
    throw error;
  } finally {
    clearInterval(interval);
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await removeControlFile(startupLog);
    await cleanupControlFiles(pidFile, owner);
  }
}

export function attachPersonaReplies(server, script, requestLog) {
  const traits = readMockTraits(script);
  if (!traits.version) return;
  const original = server.listeners("request");
  if (original.length !== 1) throw new Error("unexpected mock provider request handler count");
  const fallback = original[0];
  const overflowTriggers = new Set();
  const serial = createSerialAdmission();
  server.removeListener("request", fallback);
  server.on("request", (req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy();
        else writeJson(res, error.statusCode ?? 400, { error: { message: error.message, type: "invalid_request_error" } });
      }
    });
  });

  async function handle(req, res) {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method !== "POST" || !["/v1/responses", "/v1/chat/completions", "/responses", "/chat/completions"].includes(path)) return fallback(req, res);
    const receivedAtEpochMs = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    let release;
    try {
      const raw = await readRequestBody(req);
      controller.signal.throwIfAborted();
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
      if (body.model === traits.singleSlotModel?.modelId) release = await serial.acquire(controller.signal);
      controller.signal.throwIfAborted();
      const admittedAtEpochMs = Date.now();
      const reply = selectMockReply(traits, body, overflowTriggers);
      if (!reply) {
        const replay = Readable.from([Buffer.from(raw)]);
        Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
        fallback(replay, res);
        return;
      }
      if (reply.delayMs) await sleep(reply.delayMs, undefined, { signal: controller.signal });
      const status = reply.respond.type === "error" ? reply.respond.status : 200;
      await writePersonaReply(res, body, reply, path.endsWith("/responses"), controller.signal);
      const respondedAtEpochMs = Date.now();
      await appendFile(requestLog, `${JSON.stringify({
        schemaVersion: "mock-ai-provider.request.v1", requestId: randomUUID(), method: "POST", path,
        providerId: "openai", apiSurface: path.endsWith("/responses") ? "responses" : "chat.completions",
        model: body.model, stream: body.stream === true, status,
        receivedAt: new Date(receivedAtEpochMs).toISOString(), receivedAtEpochMs,
        admittedAtEpochMs, respondedAt: new Date(respondedAtEpochMs).toISOString(), respondedAtEpochMs,
        durationMs: respondedAtEpochMs - receivedAtEpochMs, bodyBytes: Buffer.byteLength(raw),
        matchedScriptStep: "kova-persona", responseType: reply.respond.type,
        toolCallsEmitted: reply.respond.toolCalls?.length ?? 0,
        finalTextEmitted: reply.respond.type === "final-text" ? reply.respond.text : null,
        errorClass: reply.respond.errorType ?? null,
      })}\n`, "utf8");
    } finally {
      release?.();
      res.off("close", abort);
    }
  }
}

export function createSerialAdmission(limit = 32) {
  let occupied = false;
  const pending = [];
  const release = () => {
    const next = pending.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve(release);
    } else occupied = false;
  };
  return {
    acquire(signal) {
      signal.throwIfAborted();
      if (!occupied) {
        occupied = true;
        return Promise.resolve(release);
      }
      if (pending.length >= limit) throw Object.assign(new Error("mock model request queue is full"), { statusCode: 429 });
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, abort: () => {
          const index = pending.indexOf(entry);
          if (index !== -1) pending.splice(index, 1);
          reject(signal.reason);
        } };
        pending.push(entry);
        signal.addEventListener("abort", entry.abort, { once: true });
      });
    },
  };
}

async function writePersonaReply(res, body, reply, responses, signal) {
  if (reply.respond.type === "error") {
    const { message, code, errorType: type, status } = reply.respond;
    writeJson(res, status, { error: { message, type, code } });
    return;
  }
  if (!body.stream) {
    if (reply.holdMs) await sleep(reply.holdMs, undefined, { signal });
    const rendered = responses ? renderResponse(body, reply) : renderChatCompletion(body, reply);
    if (reply.usage) rendered.body.usage = wireUsage(reply.usage, responses);
    writeJson(res, 200, rendered.body);
    return;
  }
  const frames = [];
  if (responses) {
    for (const event of renderResponseStreamEvents(body, reply).events) {
      if (reply.usage && event.type === "response.completed") event.response.usage = wireUsage(reply.usage, true);
      frames.push({ text: `data: ${JSON.stringify(event)}\n\n`, content: event.type === "response.output_text.delta" });
    }
    frames.push({ text: "data: [DONE]\n\n", content: false });
  } else {
    writeChatCompletionStream({ requestBody: body, step: reply, headers: {}, res: {
      writeHead() {}, end() {}, write(text) {
        const data = text.slice(6).trim();
        const parsed = data === "[DONE]" ? null : JSON.parse(data);
        if (reply.usage && parsed?.usage) {
          parsed.usage = wireUsage(reply.usage, false);
          text = `data: ${JSON.stringify(parsed)}\n\n`;
        }
        frames.push({ text, content: typeof parsed?.choices?.[0]?.delta?.content === "string" });
      },
    } });
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const contentCount = frames.filter((frame) => frame.content).length;
  const spacing = reply.holdMs ? reply.holdMs / Math.max(1, contentCount) : 0;
  for (const frame of frames) {
    signal.throwIfAborted();
    res.write(frame.text);
    if (frame.content && spacing) await sleep(spacing, undefined, { signal });
  }
  res.end();
}

function wireUsage(usage, responses) {
  return responses
    ? { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total }
    : { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.total };
}

async function closeServer(server) {
  const closed = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  const forceTimer = setTimeout(() => {
    server.closeAllConnections();
  }, 3000);
  forceTimer.unref();
  try {
    await closed;
  } finally {
    clearTimeout(forceTimer);
  }
}

async function cleanupControlFiles(pidFile, owner) {
  await removeControlFile(mockProviderStopFile(pidFile, owner));
  await removeMockProviderOwnerFile(pidFile, `${JSON.stringify(owner)}\n`);
}

async function removeControlFile(path) {
  try {
    await rm(path, { force: true });
  } catch (error) {
    if (error.code !== "EISDIR") {
      throw error;
    }
  }
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${flag ?? ""}`);
    }
    values[flag.slice(2)] = value;
  }
  for (const key of ["script", "request-log", "server-log", "pid-file"]) {
    if (!values[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return {
    scriptPath: values.script,
    requestLog: values["request-log"],
    serverLog: values["server-log"],
    pidFile: values["pid-file"]
  };
}
