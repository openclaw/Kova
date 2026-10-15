import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { boundedInteger, conditionMain } from "./condition.mjs";

export async function runSearchOverlap(ctx, { lifecycle } = {}) {
  const { options } = ctx;
  const width = boundedInteger(options.searches, 8, 32), offset = boundedInteger(options["offset-ms"], 0, 100, 0);
  const requestMs = boundedInteger(options["request-timeout"], 30000, 120000);
  const client = await ctx.connect();
  const sessionKey = `agent:main:kova-search-write-${randomUUID()}`;
  const created = await client.request("sessions.create", { key: sessionKey }, { timeoutMs: Math.min(30000, ctx.remaining()) });
  if (created.key !== sessionKey) throw new Error("created search-write session differs");
  const createdIds = [sessionKey, created.sessionId].filter(Boolean), requests = [];
  let cleanupClient = client;
  ctx.cleanup(() => cleanupClient.request("sessions.delete", { key: sessionKey, ...(created.sessionId ? { expectedSessionId: created.sessionId } : {}), deleteTranscript: true }, { timeoutMs: 10000 }));
  const start = Date.now();
  const observe = async (method, params, timeoutMs = requestMs, phase = "overlap") => {
    const row = { method, phase, startedMs: Date.now() - start }; requests.push(row);
    const result = await ctx.observe(client, method, params, { timeoutMs });
    Object.assign(row, { status: result.status, finishedMs: Date.now() - start, elapsedMs: result.elapsedMs });
    if (result.error) row.error = result.error;
    if (method === "sessions.search" && result.result) row.indexing = result.result.indexing === true;
    return result;
  };
  const sendAndObserve = async (phase) => {
    const idempotencyKey = randomUUID(); createdIds.push(idempotencyKey);
    const deadline = Date.now() + requestMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const sent = await observe("chat.send", { sessionKey, message: "Reply with exact ASCII text KOVA_AGENT_OK only.", idempotencyKey }, remaining(), phase);
    let completion, persistedReply = false;
    if (sent.result?.runId) {
      createdIds.push(sent.result.runId);
      completion = await observe("agent.wait", { runId: sent.result.runId, timeoutMs: remaining() }, remaining(), phase);
      if (completion.result?.status === "ok") {
        const history = await observe("chat.history", { sessionKey, limit: 100 }, remaining(), phase);
        persistedReply = history.result?.messages?.some((message) => message.role === "assistant" && message.__openclaw?.runId === sent.result.runId) === true;
      }
    }
    return { status: sent.status === "timeout" || completion?.status === "timeout" || completion?.result?.status === "timeout" ? "timeout" : completion?.result?.status === "ok" && persistedReply ? "completed" : "error", persistedReply };
  };
  const control = await sendAndObserve("control");
  if (control.status !== "completed") throw Object.assign(new Error("ordinary chat control did not complete before overlap"), { output: { sessionKey, createdIds, control, requests, conditionEstablished: false } });
  const search = { agentId: "main", sessionKeys: [options["session-key"]], query: options.query, limit: 25 };
  let warm;
  for (let i = 0; i < 20; i++) {
    warm = await observe("sessions.search", search, Math.min(10000, requestMs), "warm");
    if (warm.status === "completed") break;
    if (!/has not completed startup inspection/.test(warm.error ?? "")) throw new Error("warm search failed before overlap");
    await sleep(500, undefined, { signal: ctx.signal });
  }
  if (warm?.status !== "completed") throw new Error("warm search did not become available");
  let inFlight = 0;
  const searchCall = () => { inFlight++; return observe("sessions.search", search).finally(() => inFlight--); };
  // Observe every rejection immediately, then join outstanding work even when
  // cancellation interrupts a delay before the chat observation completes.
  const pending = [];
  const track = (promise) => {
    const settled = promise.then((value) => ({ value }), (error) => ({ error }));
    pending.push(settled);
    return settled;
  };
  for (let i = 0; i < width; i++) track(searchCall());
  let tail, chat, saved, searchesAtSave;
  try {
    if (offset) await sleep(offset, undefined, { signal: ctx.signal });
    searchesAtSave = inFlight;
    const card = track(observe("progressCard.put", { sessionKey, markdown: "Concurrent search and save", plan: [{ step: "Concurrent write", status: "in_progress" }] }));
    tail = track((async () => { for (let i = 0; i < 16; i++) { await sleep(5, undefined, { signal: ctx.signal }); track(searchCall()); } })());
    chat = await sendAndObserve("overlap");
    const tailResult = await tail;
    if (tailResult.error) throw tailResult.error;
    const cardResult = await card;
    if (cardResult.error) throw cardResult.error;
    saved = cardResult.value;
  } finally {
    // The tail may append requests, so let it finish before taking the join.
    await tail;
    await Promise.all(pending);
  }
  ctx.signal.throwIfAborted();
  const cardRow = requests.find((row) => row.method === "progressCard.put");
  const overlappingSearches = requests.filter((row) => row.phase === "overlap" && row.method === "sessions.search" && row.startedMs <= cardRow.finishedMs && row.finishedMs >= cardRow.startedMs).length;
  const output = { sessionKey, createdIds, conditionEstablished: overlappingSearches > 0, searchesAtSave, overlappingSearches, requests,
    card: { status: saved.status, elapsedMs: saved.elapsedMs },
    control, chat, recovered: false };
  // A hung writer must not poison the remaining observations. Keep recovery with
  // the foreground owner and retain the timeout evidence before restarting it.
  if (requests.some((row) => row.status === "timeout")) {
    lifecycle ??= (await import("./gateway-fixture-client.mjs")).requestGatewayLifecycle;
    const common = { env: options.env, "gateway-handle": options["gateway-handle"], timeoutMs: Math.min(120000, ctx.remaining()) };
    const paused = await lifecycle({ ...common, operation: "pause" }, { signal: ctx.signal });
    if (paused.exitCode !== 0 || paused.output?.error || paused.output?.result?.paused !== true) throw Object.assign(new Error("foreground Gateway pause failed after overlap"), { output });
    const resumed = await lifecycle({ ...common, timeoutMs: Math.min(120000, ctx.remaining()), operation: "resume" }, { signal: ctx.signal });
    if (resumed.exitCode !== 0 || resumed.output?.error || resumed.output?.result?.ready !== true) throw Object.assign(new Error("foreground Gateway recovery failed after overlap"), { output });
    cleanupClient = await ctx.connect();
    output.recovered = true;
    // Listener readiness precedes writable session admission. A read can safely
    // wait through that interval before cleanup issues its single delete.
    while (true) {
      try {
        await cleanupClient.request("sessions.search", search, { timeoutMs: Math.min(10000, ctx.remaining()) });
        break;
      } catch (error) {
        if (!/has not completed startup inspection/.test(error.message)) throw Object.assign(error, { output });
        try { await sleep(500, undefined, { signal: ctx.signal }); }
        catch (error) { throw Object.assign(error, { output }); }
      }
    }
  }
  return output;
}

await conditionMain(import.meta.url, { id: "session-search-overlap", flags: ["session-key", "query", "gateway-handle", "searches", "offset-ms", "request-timeout"], required: ["session-key", "query", "gateway-handle"], cleanupMs: 15000, timeoutMs: 300000 }, runSearchOverlap);
