import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { openDirectGatewayRpcClient } from "../openclaw-runtime.mjs";
import { EntryError } from "./common.mjs";

export const sessionRequests = {
  create: (key, label) => ({ method: "sessions.create", params: { ...(key ? { key } : {}), ...(label ? { label } : {}) } }),
  resolveLabel: (label) => ({ method: "sessions.resolve", params: { label } }),
  resolveShort: (shortId) => ({ method: "sessions.resolve", params: { shortId } }),
  describe: (key) => ({ method: "sessions.describe", params: { key } }),
  send: (key, message, idempotencyKey) => ({ method: "sessions.send", params: { key, message, thinking: "off", timeoutMs: 120000, idempotencyKey } }),
  wait: (runId) => ({ method: "agent.wait", params: { runId, timeoutMs: 120000 } }),
  history: (key, offset = 0) => ({ method: "chat.history", params: { sessionKey: key, limit: 100, offset } }),
  message: (key, sessionId, messageId) => ({ method: "chat.message.get", params: { sessionKey: key, sessionId, messageId } }),
  patchModel: (key, model) => ({ method: "sessions.patch", params: { key, model } }),
  compact: (key) => ({ method: "sessions.compact", params: { key } }),
  reset: (key) => ({ method: "sessions.reset", params: { key, reason: "reset" } }),
};

export async function withSessionClient(env, operation) {
  const handle = await openDirectGatewayRpcClient({ ...env, envName: env.name });
  try {
    return await operation(async (request) => {
      try { return await handle.client.request(request.method, request.params, { timeoutMs: 150000 }); }
      catch (error) {
        if (/timeout/i.test(error.message)) throw new EntryError(error.message, 3);
        throw error;
      }
    });
  } finally { handle.client.close(); }
}

export async function sendSessionMessage(rpc, key, message) {
  const sent = await rpc(sessionRequests.send(key, message, `kova-persona-${randomUUID()}`));
  if (typeof sent?.runId !== "string" || !sent.runId) throw new Error("session send returned no run id");
  const result = await rpc(sessionRequests.wait(sent.runId));
  if (result?.runId !== sent.runId || (result.terminalReceipt !== undefined && result.terminalReceipt?.runId !== sent.runId)) {
    throw new Error("session completion receipt does not match the accepted run");
  }
  if (result.status !== "ok") throw new EntryError(`session turn did not complete: ${result.status ?? "missing status"}`, result.status === "timeout" ? 3 : 1);
  return sent.runId;
}

async function settledMutation(rpc, request) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try { return await rpc(request); }
    catch (error) {
      if (!/has (?:an active run|queued work); retry after it finishes\.$/.test(error.message)) throw error;
      if (Date.now() >= deadline) throw new EntryError("session run did not settle before its lifecycle mutation", 3);
      await sleep(100);
    }
  }
}

export async function makeSession(rpc, options) {
  const created = await rpc(sessionRequests.create(options.key, options.label));
  const key = created?.key;
  if (typeof key !== "string" || !key || typeof created.sessionId !== "string") throw new Error("session creation returned incomplete identity");
  const resetAt = options.resetOnce ? Math.floor(options.messages / 2) : -1;
  let sinceBoundary = 0;
  for (let index = 0; index < options.messages; index++) {
    const planted = index === Math.floor(options.messages * 0.7) && options.plantWord ? ` ${options.plantWord}` : "";
    const prefix = index % 100 === 0 && options.plantPrefix ? ` ${options.plantPrefix}-${index}` : "";
    await sendSessionMessage(rpc, key, `Notebook entry ${index + 1}.${planted}${prefix} Reply with KOVA_AGENT_OK.`);
    sinceBoundary++;
    if (index + 1 === resetAt) {
      await settledMutation(rpc, sessionRequests.reset(key));
      sinceBoundary = 0;
    }
    if (options.compactEvery && sinceBoundary >= options.compactEvery) {
      const compacted = await settledMutation(rpc, sessionRequests.compact(key));
      if (compacted.compacted !== true) throw new Error(`session was not compacted: ${compacted.reason ?? "no result"}`);
      sinceBoundary = 0;
    }
  }
  if (options.nextModel) await rpc(sessionRequests.patchModel(key, options.nextModel));
  const { session } = await rpc(sessionRequests.describe(key));
  if (!session?.sessionId || session.key !== key) throw new Error("created session is absent");
  return { key: session.key, sessionId: session.sessionId };
}

export async function readSessionKeys(rpc, key) {
  const { session } = await rpc(sessionRequests.describe(key));
  if (!session?.sessionId || session.key !== key) throw new Error("session is absent");
  return { key: session.key, sessionId: session.sessionId };
}
