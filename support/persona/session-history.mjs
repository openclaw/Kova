import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { productJson, productCommand } from "./common.mjs";
import { readStoredSession, sessionKeyShortId } from "./session-store-read.mjs";
import { sessionRequests, sendSessionMessage } from "./session-content.mjs";
import { extraRequests } from "./session-extras.mjs";

export const historyKinds = ["session-long-compacted", "session-at-compaction-threshold", "session-pruned-projections"];
const word = "VERIFYWORD-ONCE", prefix = "VERIFYPFX";
function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.map((part) => part?.text ?? "").join("\n") : "";
}
function budgetOf(session) {
  const budget = session?.contextBudgetStatus;
  if (!Number.isFinite(budget?.estimatedPromptTokens) || !Number.isFinite(budget.promptBudgetBeforeReserve) || budget.promptBudgetBeforeReserve <= 0 || budget.sessionId !== session.sessionId) throw new Error("session has no current measured prompt budget");
  return budget;
}

export async function buildHistoryContent({ rpc, key, options, env, workspace }) {
  if (options.kind === "session-at-compaction-threshold") {
    const fraction = options.fillToThreshold ?? 0.95;
    for (let attempt = 0; attempt < 12; attempt++) {
      const { session } = await rpc(sessionRequests.describe(key));
      const budget = budgetOf(session);
      const ratio = budget.estimatedPromptTokens / budget.promptBudgetBeforeReserve;
      if (ratio >= fraction - 0.02 && ratio <= fraction + 0.02 && !budget.shouldCompact) return;
      if (ratio > fraction + 0.02 || budget.shouldCompact) throw new Error("session context exceeded the requested pre-compaction range");
      const characters = Math.max(64, Math.floor((fraction * budget.promptBudgetBeforeReserve - budget.estimatedPromptTokens - 128) * 2));
      if (characters > 1000000) throw new Error("mock model context window exceeds the bounded filler");
      await sendSessionMessage(rpc, key, `Notebook material: ${"note ".repeat(Math.ceil(characters / 5))} Reply with KOVA_AGENT_OK.`);
    }
    throw new Error("session did not reach its measured pre-compaction range");
  }
  if (options.kind !== "session-pruned-projections") return;
  const name = typeof env === "string" ? env : env.name;
  const provider = await productJson(name, ["config", "get", "models.providers.openai", "--json"]);
  const modelId = (options.toolModel ?? "openai/mock-tools").split("/").at(-1);
  if (!provider.models?.some((model) => model.id === modelId)) throw new Error("pruning requires the configured mock tool model");
  const models = provider.models.map((model) => model.id === modelId ? { ...model, compat: { ...model.compat, supportsPromptCacheKey: true } } : model);
  await productCommand(name, ["config", "set", "models.providers.openai.models", JSON.stringify(models), "--strict-json"]);
  await productCommand(name, ["config", "set", "agents.defaults.contextPruning", JSON.stringify({ mode: "cache-ttl", ttl: "1m" }), "--strict-json"]);
  await rpc(extraRequests.patchModel(key, options.toolModel ?? "openai/mock-tools"));
  await mkdir(join(workspace, "kova-persona"), { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, "kova-persona", "pruning-data.txt"), `${"Notebook detail with durable source material.\n".repeat(200)}\n`, { mode: 0o600 });
  for (let index = 0; index < (options.toolTurns ?? 20); index++) {
    await sendSessionMessage(rpc, key, `Read notebook page ${index + 1}. KOVA_TOOL_CALL ${JSON.stringify({ name: "read", arguments: { path: "kova-persona/pruning-data.txt" } })}`);
  }
  await sleep(61000);
  await sendSessionMessage(rpc, key, "Summarize the old notebook material. Reply with KOVA_AGENT_OK.");
}

export async function checkHistoryContent({ rpc, key, kind, state }) {
  const { session } = await rpc(sessionRequests.describe(key));
  if (!session?.sessionId || session.key !== key) throw new Error("saved session is absent");
  if (kind === "session-at-compaction-threshold") {
    const budget = budgetOf(session);
    const ratio = budget.estimatedPromptTokens / budget.promptBudgetBeforeReserve;
    if (ratio < 0.93 || ratio > 0.97 || budget.shouldCompact || budget.route !== "fits") throw new Error("saved session is outside the pre-compaction range");
    return { key: session.key };
  }
  const stored = await readStoredSession(state, key, { allWindows: kind === "session-long-compacted" });
  if (stored.sessionId !== session.sessionId) throw new Error("session identity changed during its content check");
  const events = stored.events.map((record) => record.event);
  if (kind === "session-pruned-projections") {
    let pruned;
    for (const event of events) {
      if (event.type === "reset") pruned = undefined;
      if (event.type !== "custom" || event.customType !== "openclaw.cache-ttl") continue;
      if (Array.isArray(event.data?.prunedToolResults)) pruned = new Map(event.data.prunedToolResults.map((value) => [value.key, value]));
      else if (event.data?.cacheTtlDelta) {
        const change = event.data.cacheTtlDelta.prunedToolResults;
        if (!pruned || !Array.isArray(change?.set) || !Array.isArray(change.remove)) throw new Error("saved pruning delta has no valid base");
        for (const key of change.remove) pruned.delete(key);
        for (const value of change.set) pruned.set(value.key, value);
      }
    }
    if (!pruned?.size || [...pruned.values()].some((value) => typeof value.key !== "string" || !["soft", "hard"].includes(value.mode))) throw new Error("saved session has no current pruned tool-result projection");
    if (!events.some((event) => event.type === "message" && event.message?.role === "toolResult" && messageText(event.message).includes("Notebook detail with durable source material."))) throw new Error("original tool content is absent");
    return { key: session.key, sessionId: session.sessionId };
  }
  if (kind !== "session-long-compacted") throw new Error("unknown session history kind");
  const messages = events.filter((event) => event.type === "message");
  const userMessages = messages.filter((event) => event.message?.role === "user");
  if (messages.length < 5000 || !events.some((event) => event.type === "compaction")) throw new Error("long session lacks its messages or compaction entries");
  const reset = stored.windows.some((window) => window.reason === "reset" || window.reason === "new") || events.some((event) => event.type === "reset" && ["reset", "new"].includes(event.reason));
  if (!reset) throw new Error("long session has no reset boundary");
  const unique = userMessages.filter((event) => messageText(event.message).includes(word));
  if (unique.length !== 1 || userMessages.filter((event) => messageText(event.message).includes(prefix)).length < 2) throw new Error("long session search content is absent or ambiguous");
  const anchorMessageId = unique[0].id;
  if (typeof anchorMessageId !== "string" || !anchorMessageId) throw new Error("stored message has no durable entry id");
  const fetched = await rpc(sessionRequests.message(key, session.sessionId, anchorMessageId));
  if (!fetched.ok || fetched.message?.role !== "user" || !messageText(fetched.message).includes(word)) throw new Error("saved anchor message is not visible through the Gateway");
  const shortId = sessionKeyShortId(key);
  const resolved = await rpc(sessionRequests.resolveShort(shortId));
  if (resolved.key !== key) throw new Error("short session id is not unique");
  return { key: session.key, sessionId: session.sessionId, shortId, anchorMessageId, searchWord: word, searchPrefix: prefix };
}
