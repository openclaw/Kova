import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { openDirectGatewayRpcClient } from "../openclaw-runtime.mjs";
import { abortable, CallError } from "./background.mjs";
import { entrypoint, nonempty, positiveInteger, sessionKey } from "./script.mjs";

export async function readPages(rpc, key, limit, messageId) {
  const pages = [], messages = [], seen = new Set();
  let cursor;
  let offset = 0;
  let initialSession;
  for (;;) {
    const page = await rpc(pages.length ? "chat.history" : "chat.startup", { sessionKey: key, limit, ...(cursor ? { cursor } : offset ? { offset } : {}) });
    if (initialSession !== undefined && page?.sessionId !== initialSession) throw new Error("session changed during history pagination");
    initialSession ??= page?.sessionId;
    pages.push(page);
    messages.push(...(page?.messages ?? []));
    if (page?.hasMore !== true) break;
    if (pages.length >= 1000) throw new Error("history exceeded the bounded page count");
    if (nonempty(page.olderCursor)) {
      if (seen.has(page.olderCursor)) throw new Error("history cursor did not advance");
      cursor = page.olderCursor; seen.add(cursor);
    } else {
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("history offset did not advance");
      offset = page.nextOffset;
    }
  }
  if (messageId) pages.push(await rpc("chat.message.get", { sessionKey: key, messageId }));
  return { pages, messages };
}

export async function readDelta(rpc, key, limit) {
  await rpc("sessions.messages.subscribe", { key });
  const initial = await rpc("chat.history", { sessionKey: key, limit });
  if (!nonempty(initial?.deltaCursor)) return { pages: [initial], messages: initial?.messages ?? [] };
  const delta = await rpc("chat.history", { sessionKey: key, cursor: initial.deltaCursor, limit });
  return { pages: [initial, delta], messages: delta?.messages ?? [] };
}
async function follow(runtime, key, limit, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const { client } = await openDirectGatewayRpcClient(runtime, { timeoutMs, authFromRuntimeConfig: true });
  const rpc = (method, params) => abortable(client.request(method, params, { timeoutMs }), signal, () => client.close());
  try { return await readDelta(rpc, key, limit); }
  finally { client.close(); }
}

export const definition = {
  id: "chat-history-read", url: import.meta.url,
  flags: ["env", "session-key", "limit", "message-id", "follow-delta", "timeout", "wait", "background", "handle"],
  booleans: ["follow-delta", "background"],
  empty: () => ({ pages: [], messages: [], elapsedMs: 0 }),
  validate(o) { o.limitValue = positiveInteger(o.limit, 100, 1000); },
  async run(o, ctx) {
    const key = await sessionKey(o, ctx);
    const result = await readPages(ctx.rpc, key, o.limitValue, o["message-id"]);
    if (!o["follow-delta"]) return result;
    let following;
    if (ctx.follow) following = await ctx.follow(key, o.limitValue);
    else {
      const worker = new Worker(new URL(import.meta.url), { workerData: { runtime: ctx.runtime(), key, limit: o.limitValue, timeoutMs: ctx.remaining() }, execArgv: [] });
      try {
        following = await abortable(new Promise((accept, reject) => {
          worker.once("message", (message) => message.error ? reject(new CallError(message.error, message.exitCode)) : accept(message.result));
          worker.once("error", reject);
          worker.once("exit", (code) => reject(new Error(`history reader exited without a result (${code})`)));
        }), ctx.signal);
      } finally { await worker.terminate(); }
    }
    return { pages: [...result.pages, ...following.pages], messages: [...result.messages, ...following.messages] };
  }
};
if (!isMainThread && workerData) {
  try { parentPort.postMessage({ result: await follow(workerData.runtime, workerData.key, workerData.limit, workerData.timeoutMs) }); }
  catch (error) { parentPort.postMessage({ error: error.message, exitCode: error.name === "TimeoutError" ? 3 : 1 }); }
} else await entrypoint(definition);
