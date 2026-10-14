import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EntryError, productCommand } from "./common.mjs";
import { sendSessionMessage, sessionRequests } from "./session-content.mjs";

export const sessionExtraKinds = [
  "session-goal-active", "session-progress-card", "session-interrupted-inputs",
  "session-idle-expired", "session-public-shared", "config-reset-idle-short",
  "config-subagent-archive-fast"
];
const goalObjective = "Keep the project notebook current.";
const cancelledMarker = "KOVA_PERSONA_CANCELLED_INPUT";
const interruptedMarker = "KOVA_PERSONA_INTERRUPTED_INPUT";
const idleMarker = "KOVA_IDLE_HISTORY";
const idleMinutes = 1;
const card = {
  markdown: "The project notebook has one completed item and two remaining items.",
  plan: [
    { step: "Collect the notes", status: "completed" },
    { step: "Review the notebook", status: "in_progress" },
    { step: "Publish the summary", status: "pending" }
  ]
};

export const extraRequests = {
  progressPut: (key) => ({ method: "progressCard.put", params: { sessionKey: key, markdown: card.markdown, plan: card.plan.map((step) => ({ ...step })) } }),
  progressGet: (key) => ({ method: "progressCard.get", params: { sessionKey: key } }),
  chatSend: (key, message, idempotencyKey, queueMode) => ({ method: "chat.send", params: { sessionKey: key, message, idempotencyKey, ...(queueMode === undefined ? {} : { queueMode }) } }),
  abort: (key, runId) => ({ method: "chat.abort", params: { sessionKey: key, ...(runId === undefined ? {} : { runId }) } }),
  pendingHistory: (key, before) => ({ method: "chat.history", params: { sessionKey: key, limit: 20, ...(before === undefined ? {} : { pendingBefore: before }) } }),
  publicShare: (key, sessionId) => ({ method: "session.publicShare.set", params: { sessionKey: key, expectedSessionId: sessionId, enabled: true } }),
  publicMembers: (key) => ({ method: "session.members.list", params: { sessionKey: key } }),
  configGet: () => ({ method: "config.get", params: {} })
};

function requireKind(kind) {
  if (!sessionExtraKinds.includes(kind)) throw new EntryError("unknown session content kind", 2);
}

function text(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
}

async function describe(rpc, key) {
  const { session } = await rpc(sessionRequests.describe(key));
  if (session?.key !== key || typeof session.sessionId !== "string" || !session.sessionId) throw new Error("session content has no persisted session identity");
  return session;
}

async function config(rpc, state) {
  const snapshot = await rpc(extraRequests.configGet());
  if (state !== undefined && (typeof snapshot?.path !== "string" || await realpath(dirname(snapshot.path)) !== await realpath(state))) {
    throw new Error("session content belongs to a different environment");
  }
  if (!snapshot?.config || typeof snapshot.config !== "object") throw new Error("Gateway configuration is absent");
  return snapshot.config;
}

function requireIdlePolicy(value, key) {
  const session = value?.session;
  const types = session?.resetByType;
  if (!/:thread:[^:]+$/.test(key) || session?.reset?.mode !== "none" ||
      types?.direct?.mode !== "none" || types?.group?.mode !== "none" ||
      types?.thread?.mode !== "idle" || types.thread.idleMinutes !== idleMinutes ||
      Object.keys(session.resetByChannel ?? {}).length) {
    throw new Error("idle content requires a one-minute thread reset policy with direct and group resets disabled");
  }
}

async function readPending(rpc, key) {
  const items = [];
  let before;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const history = await rpc(extraRequests.pendingHistory(key, before));
    const pending = history?.pendingInputs;
    if (!pending || !Array.isArray(pending.items)) throw new Error("Gateway did not return durable pending inputs");
    items.push(...pending.items);
    if (pending.nextBefore === undefined) return items;
    if (!Number.isSafeInteger(pending.nextBefore) || pending.nextBefore < 1 || (before !== undefined && pending.nextBefore >= before)) throw new Error("pending input pagination did not advance");
    before = pending.nextBefore;
  }
  throw new Error("pending input history exceeded the bounded check");
}

async function waitFor(operation, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await operation();
    if (result) return result;
    if (Date.now() >= deadline) break;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new EntryError(`timed out waiting for ${description}`, 3);
}

async function accepted(rpc, request) {
  const response = await rpc(request);
  if (typeof response?.runId !== "string" || !response.runId) throw new Error("accepted session input has no run id");
  return response.runId;
}

async function buildPending(rpc, key, marker) {
  try {
    const held = await accepted(rpc, extraRequests.chatSend(key, `${marker}: retain this reply until the Gateway restarts.`, randomUUID()));
    // Observe this run's live stream; a saved card or older reply cannot prove it started.
    await waitFor(async () => {
      const result = await rpc(extraRequests.pendingHistory(key));
      const active = result?.inFlightRun;
      return active?.runId === held && typeof active.text === "string" && active.text.trim().length > 0;
    }, "held mock reply");
    const cancelled = await accepted(rpc, extraRequests.chatSend(key, cancelledMarker, randomUUID(), "followup"));
    const interrupted = await accepted(rpc, extraRequests.chatSend(key, interruptedMarker, randomUUID(), "followup"));
    await waitFor(async () => {
      const inputs = await readPending(rpc, key);
      return [cancelled, interrupted].every((runId) => inputs.some((input) => input.runId === runId && input.state === "queued" && input.queued === true));
    }, "accepted followup inputs");
    await rpc(extraRequests.abort(key, cancelled));
    await waitFor(async () => {
      const inputs = await readPending(rpc, key);
      return inputs.some((input) => input.runId === cancelled && input.state === "cancelled" && text(input.message).includes(cancelledMarker)) &&
        inputs.some((input) => input.runId === interrupted && input.state === "queued" && input.queued === true && text(input.message).includes(interruptedMarker));
    }, "retained cancelled input");
    // The caller must now restart its owned Gateway before running the content check.
    return { key };
  } catch (error) {
    try { await rpc(extraRequests.abort(key)); }
    catch { throw new AggregateError([error], "pending input creation failed and its session could not be stopped"); }
    throw error;
  }
}

function timestamp(value) {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : undefined;
}

async function idleFacts(rpc, key) {
  const session = await describe(rpc, key);
  const history = await rpc(sessionRequests.history(key));
  const messages = history?.messages;
  if (!Array.isArray(messages) || !messages.some((message) => message.role === "user" && text(message).includes(idleMarker)) || !messages.some((message) => message.role === "assistant")) {
    throw new Error("idle session is missing its completed notebook turn");
  }
  const times = [timestamp(session.lastInteractionAt), timestamp(session.updatedAt), ...messages.map((message) => timestamp(message.timestamp))].filter((value) => value !== undefined);
  if (!times.length) throw new Error("idle session has no saved activity timestamp");
  const latest = Math.max(...times);
  if (latest > Date.now()) throw new Error("idle session activity timestamp is in the future");
  return { session, expiresAt: latest + idleMinutes * 60000 };
}

/** Extend an already-created session through its product producers. */
export async function buildSessionExtras({ rpc, key, options, env, state }) {
  const kind = options?.kind;
  requireKind(kind);
  const session = await describe(rpc, key);
  if (kind === "session-goal-active") {
    if (typeof options.toolModel !== "string" || !options.toolModel) throw new EntryError("active goal content requires the mock tool model", 2);
    await rpc(sessionRequests.patchModel(key, options.toolModel));
    await sendSessionMessage(rpc, key, `Please create this goal. KOVA_TOOL_CALL ${JSON.stringify({ name: "create_goal", arguments: { objective: goalObjective } })}`);
  } else if (kind === "session-progress-card") {
    await rpc(extraRequests.progressPut(key));
  } else if (kind === "session-interrupted-inputs") {
    return buildPending(rpc, key, options.holdMarker ?? "VERIFY_HOLD");
  } else if (kind === "session-idle-expired") {
    requireIdlePolicy(await config(rpc, state), key);
    await sendSessionMessage(rpc, key, `${idleMarker}: retain this notebook entry. Reply with KOVA_AGENT_OK.`);
    const { expiresAt } = await idleFacts(rpc, key);
    while (Date.now() <= expiresAt) await sleep(Math.min(1000, expiresAt - Date.now() + 1));
  } else if (kind === "session-public-shared") {
    // Public-share responses contain a bearer token. Keep them out of command output and errors.
    let enabled = false;
    try {
      const response = await rpc(extraRequests.publicShare(key, session.sessionId));
      enabled = response?.ok === true && response.sessionKey === key && typeof response.publicShare?.token === "string" && response.publicShare.token.length > 0;
    } catch { throw new Error("Gateway could not enable the saved public session share"); }
    if (!enabled) throw new Error("Gateway did not create the public session share");
  } else {
    const name = typeof env === "string" ? env : env?.name;
    if (!name) throw new EntryError("configuration content requires an environment name", 2);
    if (kind === "config-reset-idle-short") {
      await productCommand(name, ["config", "set", "session.reset", JSON.stringify({ mode: "none" }), "--strict-json"]);
      await productCommand(name, ["config", "set", "session.resetByType", JSON.stringify({ direct: { mode: "none" }, group: { mode: "none" }, thread: { mode: "idle", idleMinutes } }), "--strict-json"]);
      await productCommand(name, ["config", "set", "session.resetByChannel", "{}", "--strict-json"]);
    } else {
      await productCommand(name, ["config", "set", "agents.defaults.subagents.archiveAfterMinutes", "1", "--strict-json"]);
    }
    // The persona lifecycle restarts the Gateway before checking newly saved settings.
    return kind === "config-reset-idle-short" ? { key } : { parentKey: key };
  }
  return checkSessionExtra({ rpc, key, kind, state });
}

/** Checks consume product state and return only the declared durable identifiers. */
export async function checkSessionExtra({ rpc, key, kind, state }) {
  requireKind(kind);
  const session = await describe(rpc, key);
  if (kind === "session-goal-active") {
    if (session.goal?.status !== "active" || session.goal.objective !== goalObjective || typeof session.goal.id !== "string" || !session.goal.id) throw new Error("saved session goal is absent or differs");
    return { key: session.key, goalId: session.goal.id };
  }
  if (kind === "session-progress-card") {
    const result = await rpc(extraRequests.progressGet(key));
    const saved = result?.card;
    const stepsMatch = Array.isArray(saved?.steps) && saved.steps.length === card.plan.length && card.plan.every((step, index) => saved.steps[index]?.step === step.step && saved.steps[index]?.status === step.status);
    if (!Number.isSafeInteger(saved?.revision) || saved.revision < 1 || saved.markdown !== card.markdown || !stepsMatch) throw new Error("saved session progress card is absent or differs");
  } else if (kind === "session-interrupted-inputs") {
    const inputs = await readPending(rpc, key);
    for (const [marker, status] of [[cancelledMarker, "cancelled"], [interruptedMarker, "interrupted"]]) {
      const matching = inputs.filter((input) => text(input.message).includes(marker));
      if (matching.length !== 1 || matching[0].state !== status || matching[0].queued === true) throw new Error(`saved ${status} input is absent or still queued`);
    }
  } else if (kind === "session-idle-expired") {
    requireIdlePolicy(await config(rpc, state), key);
    if (Date.now() <= (await idleFacts(rpc, key)).expiresAt) throw new Error("saved session has not reached its one-minute idle expiry");
  } else if (kind === "session-public-shared") {
    let present = false;
    try {
      const result = await rpc(extraRequests.publicMembers(key));
      present = result?.sessionKey === key && typeof result.publicShare?.token === "string" && result.publicShare.token.length > 0 && Number.isFinite(result.publicShare.createdAt);
    } catch { throw new Error("Gateway could not read the saved public session share"); }
    if (!present) throw new Error("saved public session share is absent");
  } else if (kind === "config-reset-idle-short") {
    requireIdlePolicy(await config(rpc, state), key);
  } else {
    if ((await config(rpc, state)).agents?.defaults?.subagents?.archiveAfterMinutes !== 1) throw new Error("saved subagent archive interval is not one minute");
    return { parentKey: session.key };
  }
  return { key: session.key };
}
