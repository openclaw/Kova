#!/usr/bin/env node
import { conditionMain } from "./condition.mjs";

const scopes = ["operator.read", "operator.write"];
const sessionKeyPattern = /^agent:[a-z0-9][a-z0-9_-]*:[^\s\u0000-\u001f\u007f]+$/;

export async function runColdFork(ctx) {
  const sessionKey = ctx.options["session-key"];
  const entryId = ctx.options["entry-id"];
  if (!sessionKeyPattern.test(sessionKey ?? "") || typeof entryId !== "string" || !entryId.trim() || /[\s\u0000-\u001f\u007f]/.test(entryId)) {
    throw new Error("a canonical --session-key and nonempty --entry-id are required");
  }
  // Deletion requires admin scope; this connection never reads the source session.
  const cleanupClient = await ctx.connect();
  const client = await ctx.connect(scopes);
  const grantedScopes = client.grantedScopes;
  if (!Array.isArray(grantedScopes) || grantedScopes.length !== scopes.length || !scopes.every((scope) => grantedScopes.includes(scope))) {
    throw new Error("cold fork requires exactly operator.read and operator.write granted scopes");
  }
  const preview = await ctx.observe(client, "sessions.preview", { keys: [sessionKey] }, { timeoutMs: 30000 });
  const cold = preview.result?.previews?.find((item) => item.key === sessionKey)?.status;
  if (preview.status !== "completed" || cold !== "cold") {
    throw new Error("source session must report a cold preview before its first fork");
  }
  const createdIds = [];
  const recordFork = (observation) => {
    if (observation.status !== "completed") return observation;
    const key = observation.result?.sessionKey;
    if (!sessionKeyPattern.test(key ?? "") || key === sessionKey || createdIds.includes(key)) {
      throw new Error("sessions.fork did not return a new session key");
    }
    createdIds.push(key);
    ctx.cleanup(() => cleanupClient.request("sessions.delete", { key, deleteTranscript: true }, { timeoutMs: 10000 }));
    return { status: observation.status, elapsedMs: observation.elapsedMs, result: { sessionKey: key } };
  };
  const params = { sessionKey, entryId };
  const firstFork = recordFork(await ctx.observe(client, "sessions.fork", params, { timeoutMs: 60000 }));
  // No history read or other session operation may warm the source before this retry.
  const secondFork = recordFork(await ctx.observe(client, "sessions.fork", params, { timeoutMs: 60000 }));
  return {
    status: "observed", sessionKey, entryId, grantedScopes, initialStatus: cold,
    createdIds, firstFork, secondFork,
    firstForkAccepted: firstFork.status === "completed",
    secondForkAccepted: secondFork.status === "completed",
  };
}

await conditionMain(import.meta.url, {
  id: "session-cold-fork", flags: ["session-key", "entry-id"], required: ["session-key", "entry-id"], cleanupMs: 25000, timeoutMs: 180000,
}, runColdFork);
