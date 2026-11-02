#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { conditionMain } from "./condition.mjs";

const message = "Reply with exact ASCII text KOVA_AGENT_OK only.";

export async function runIncognitoSend(ctx) {
  const client = await ctx.connect();
  const created = await client.request("sessions.create", { agentId: "main", incognito: true }, { timeoutMs: Math.min(30000, ctx.remaining()) });
  if (!/^agent:main:.*\bincognito-[^\s]+$/.test(created?.key ?? "") || typeof created.sessionId !== "string" || !created.sessionId) {
    throw new Error("sessions.create did not return an Incognito session identity");
  }
  const { key: sessionKey, sessionId } = created;
  ctx.cleanup(() => client.request("sessions.delete", { key: sessionKey, expectedSessionId: sessionId, deleteTranscript: true }, { timeoutMs: 10000 }));
  const createdIds = [sessionKey, sessionId];
  const send = await ctx.observe(client, "chat.send", { sessionKey, message, idempotencyKey: randomUUID() }, { timeoutMs: 30000 });
  const output = { status: "observed", sessionKey, sessionId, createdIds, sendAccepted: send.status === "completed", send };
  if (send.status !== "completed") return output;
  const runId = send.result?.runId;
  if (typeof runId !== "string" || !runId) throw new Error("chat.send did not return a run id");
  createdIds.push(runId);
  // Keep all four requests on the connection that owns the Incognito session.
  output.wait = await ctx.observe(client, "agent.wait", { runId, timeoutMs: Math.min(60000, Math.max(1, ctx.remaining() - 1000)) }, { timeoutMs: 65000 });
  output.turnCompleted = output.wait.status === "completed" && output.wait.result?.status === "ok";
  const history = await ctx.observe(client, "chat.history", { sessionKey, limit: 20 }, { timeoutMs: 30000 });
  output.history = summarizeHistory(history);
  output.replyVisible = output.history.userCount > 0 && output.history.replyMatches === true;
  // The reply itself and the full conversation are not needed to compare admission.
  if (output.wait.result) output.wait.result = { runId, status: output.wait.result.status };
  return output;
}

function summarizeHistory(observation) {
  if (observation.status !== "completed") return observation;
  const messages = observation.result?.messages;
  if (!Array.isArray(messages)) throw new Error("chat.history did not return messages");
  const assistants = messages.filter((entry) => entry.role === "assistant");
  return {
    status: observation.status,
    elapsedMs: observation.elapsedMs,
    userCount: messages.filter((entry) => entry.role === "user").length,
    assistantCount: assistants.length,
    replyMatches: assistants.some((entry) => {
      const text = typeof entry.content === "string" ? entry.content : (entry.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
      return text.trim() === "KOVA_AGENT_OK";
    }),
  };
}

await conditionMain(import.meta.url, { id: "session-incognito-send", flags: [], required: [], cleanupMs: 15000, timeoutMs: 150000 }, runIncognitoSend);
