import { randomUUID } from "node:crypto";
import { CallError } from "./background.mjs";
import { nonempty } from "./script.mjs";

export async function history(context, key) {
  const pages = [];
  const messages = [];
  let cursor, offset = 0, sessionId;
  for (;;) {
    const page = await context.rpc("chat.history", { sessionKey: key, limit: 100, ...(cursor === undefined ? offset ? { offset } : {} : { cursor }) });
    if (sessionId !== undefined && page?.sessionId !== sessionId) throw new Error("session changed while reading history");
    sessionId ??= page?.sessionId;
    pages.push(page);
    messages.push(...(Array.isArray(page?.messages) ? page.messages : []));
    if (page?.hasMore !== true) break;
    if (pages.length >= 1000) throw new Error("history exceeded the bounded page count");
    if (nonempty(page.olderCursor)) {
      if (page.olderCursor === cursor) throw new Error("Gateway history cursor did not advance");
      cursor = page.olderCursor;
    } else {
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Gateway history offset did not advance");
      offset = page.nextOffset;
    }
  }
  return { pages, messages };
}

export function boundMessages(messages, runId) {
  return messages.filter((message) => message?.__openclaw?.runId === runId || (message?.__openclaw?.idempotencyKey ?? message?.idempotencyKey) === runId);
}

export async function sendTurn(context, key, message, { method = "chat.send", params = {} } = {}) {
  const receipt = await context.rpc(method, {
    ...(method === "sessions.send" ? { key } : { sessionKey: key }), message,
    idempotencyKey: randomUUID(), ...params
  });
  if (!nonempty(receipt?.runId)) return { receipt, reply: null, messages: [], createdIds: [] };
  context.record?.({ receipt, createdIds: [receipt.runId] });
  let completion;
  for (;;) {
    completion = await context.rpc("agent.wait", { runId: receipt.runId, timeoutMs: context.remaining() });
    if (completion?.runId && completion.runId !== receipt.runId) throw new Error("Gateway completion returned a different run id");
    context.record?.({ receipt: { ...receipt, completion } });
    if (completion?.status !== "pending") break;
    await context.pause(Math.min(250, context.remaining()));
  }
  // A product timeout is recorded as its result; our own deadline remains exit 3.
  const observed = await history(context, key);
  const messages = boundMessages(observed.messages, receipt.runId);
  return { receipt: { ...receipt, completion }, reply: messages.filter((row) => row.role === "assistant"), messages, createdIds: [receipt.runId] };
}
