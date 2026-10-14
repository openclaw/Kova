#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  extractAssistantVisibleText,
  failJson,
  finishJson,
  openDirectGatewayRpcClient,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs,
  sleep
} from "./openclaw-runtime.mjs";

const startedAtEpochMs = Date.now();
let runId = null;
let replyRunId = null;

try {
  const args = parseSupportArgs(process.argv.slice(2));
  rejectUnsupportedArgs(args, ["env", "message", "expected-text", "timeout", "session-key", "create-session", "min-assistant-count"]);
  const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(args.env);
  const message = args.message ?? "Reply with exact ASCII text KOVA_AGENT_OK only.";
  const expectedText = args["expected-text"] ?? "KOVA_AGENT_OK";
  const timeoutMs = readTimeoutMs(args.timeout, 120000);
  const sessionKey = args["session-key"] ?? `kova-gateway-session-${randomUUID()}`;
  const createSession = readBoolean(args["create-session"], true);
  const minAssistantCount = readPositiveInteger(args["min-assistant-count"], 1);
  const gatewayTransport = await openDirectGatewayRpcClient(runtimeContext);

  try {
    let created = null;
    let sessionCreateStartedAtEpochMs = null;
    let sessionCreateFinishedAtEpochMs = null;
    if (createSession) {
      sessionCreateStartedAtEpochMs = Date.now();
      created = await gatewayCall(gatewayTransport, "sessions.create", {
        agentId: "main",
        key: sessionKey,
        label: "Kova Gateway Session Send"
      }, Math.min(timeoutMs, 60000));
      sessionCreateFinishedAtEpochMs = Date.now();
    }
    const canonicalKey = created?.key ?? sessionKey;
    const idempotencyKey = `kova-gateway-session-${randomUUID()}`;
    const sendStartedAtEpochMs = Date.now();
    const sent = await gatewayCall(gatewayTransport, "sessions.send", {
        key: canonicalKey,
        message,
        thinking: "off",
        timeoutMs,
        idempotencyKey
      }, Math.min(timeoutMs, 60000));
    const sendFinishedAtEpochMs = Date.now();
    if (typeof sent?.runId !== "string" || !sent.runId.trim()) {
      throw new Error("sessions.send returned no run id");
    }
    if (sent.runId !== idempotencyKey) {
      throw new Error("sessions.send returned a different run id from the submitted idempotency key");
    }
    runId = sent.runId;
    const deadline = sendStartedAtEpochMs + timeoutMs;
    const completions = new Map();
    let completionError = null;
    const trackCompletion = (id) => {
      if (!completions.has(id)) {
        const pending = waitForRunCompletion({ gatewayTransport, runId: id, deadline });
        void pending.catch((error) => { completionError ??= error; });
        completions.set(id, pending);
      }
      return completions.get(id);
    };
    const completion = trackCompletion(runId);

    const history = await waitForAssistantText({
      gatewayTransport,
      sessionKey: canonicalKey,
      expectedText,
      deadline,
      runId,
      minAssistantCount,
      trackCompletion,
      readCompletionError: () => completionError
    });
    replyRunId = history.replyRunId;
    const completedAt = await Promise.all([completion, trackCompletion(replyRunId)]);
    const runCompletedAtEpochMs = Math.max(...completedAt);
    const finishedAtEpochMs = Date.now();
    const activeFinishedAtEpochMs = Math.max(history.assistantMatchedAtEpochMs ?? finishedAtEpochMs, runCompletedAtEpochMs);

    finishJson({
      ok: true,
      surface: "gateway-session-send-turn",
      method: "sessions.send",
      createSession,
      minAssistantCount,
      envName: runtimeContext.envName,
      runtime: runtimeContext.runtime,
      gatewayTransport: {
        kind: gatewayTransport.transport
      },
      sessionKey: canonicalKey,
      runId,
      replyRunId,
      startedAtEpochMs,
      sessionCreateStartedAtEpochMs,
      sessionCreateFinishedAtEpochMs,
      sessionCreateDurationMs: sessionCreateStartedAtEpochMs === null || sessionCreateFinishedAtEpochMs === null
        ? null
        : sessionCreateFinishedAtEpochMs - sessionCreateStartedAtEpochMs,
      sendStartedAtEpochMs,
      sendFinishedAtEpochMs,
      sendDurationMs: sendFinishedAtEpochMs - sendStartedAtEpochMs,
      activeStartedAtEpochMs: sendStartedAtEpochMs,
      activeFinishedAtEpochMs,
      activeTurnMs: activeFinishedAtEpochMs - sendStartedAtEpochMs,
      finishedAtEpochMs,
      assistantFirstSeenAtEpochMs: history.assistantFirstSeenAtEpochMs,
      assistantMatchedAtEpochMs: history.assistantMatchedAtEpochMs,
      timeToFirstAssistantMs: history.assistantFirstSeenAtEpochMs === null ? null : history.assistantFirstSeenAtEpochMs - sendStartedAtEpochMs,
      timeToMatchedAssistantMs: history.assistantMatchedAtEpochMs === null ? null : history.assistantMatchedAtEpochMs - sendStartedAtEpochMs,
      historyPollCount: history.pollCount,
      historyErrorCount: history.errorCount,
      lastHistoryError: history.lastHistoryErrorMessage,
      finalAssistantVisibleText: history.matchedAssistantText,
      finalAssistantRawText: history.lastAssistantText,
      assistantMessageCount: history.assistantTexts.length,
      assistantTextEvidence: history.assistantTextEvidence,
      expectedTextPresent: textEquals(history.matchedAssistantText, expectedText)
    });
  } finally {
    gatewayTransport.client?.close();
  }
} catch (error) {
  const failure = classifyGatewaySessionFailure(error);
  failJson(error, {
    surface: "gateway-session-send-turn",
    runId,
    replyRunId,
    finishedAtEpochMs: Date.now(),
    failureDomain: failure.failureDomain,
    recordStatus: failure.recordStatus,
    assistantTextEvidence: error?.assistantTextEvidence ?? null
  });
}

async function waitForRunCompletion({ gatewayTransport, runId, deadline }) {
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const result = await gatewayCall(gatewayTransport, "agent.wait", {
      runId,
      timeoutMs: Math.min(10000, remainingMs)
    }, remainingMs + 1000);
    if (result?.runId !== runId) {
      throw new Error("agent.wait returned a different or missing run id");
    }
    if (result.status === "error" || result.error) {
      throw new Error(result.error || `Gateway session run ${runId} failed`);
    }
    if (result.status === "ok") {
      return Date.now();
    }
    if (result.status !== "pending" && result.status !== "timeout") {
      throw new Error(`Gateway session run ${runId} ended with status ${JSON.stringify(result.status)}`);
    }
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`timed out waiting for Gateway session run ${runId}`);
}

async function waitForAssistantText({ gatewayTransport, sessionKey, expectedText, deadline, runId, minAssistantCount, trackCompletion, readCompletionError }) {
  let lastAssistantText = "";
  let assistantTextEvidence = null;
  let lastHistoryError = null;
  let assistantTexts = [];
  let assistantFirstSeenAtEpochMs = null;
  let pollCount = 0;
  let errorCount = 0;
  while (Date.now() < deadline) {
    if (readCompletionError()) throw readCompletionError();
    try {
      const readHistory = async (params) => {
        pollCount += 1;
        return await gatewayCall(gatewayTransport, "chat.history", params, Math.min(15000, Math.max(1, deadline - Date.now())));
      };
      const history = await readHistory({ sessionKey, limit: 16, inputRunIds: [runId] });
      lastHistoryError = null;
      const messages = history?.messages ?? [];
      assistantTexts = extractAssistantTexts(messages);
      assistantTextEvidence = summarizeAssistantTextEvidence(messages);
      const replies = await findSubmittedReplies({ history, sessionKey, runId, expectedText, deadline, readHistory });
      for (const reply of replies) {
        replyRunId = reply.__openclaw?.runId || runId;
        trackCompletion(replyRunId);
      }
      const runAssistantTexts = extractAssistantTexts(replies);
      lastAssistantText = runAssistantTexts.at(-1) ?? "";
      const eligibleReplies = assistantTexts.length >= minAssistantCount ? replies : [];
      if (assistantFirstSeenAtEpochMs === null && runAssistantTexts.length > 0) {
        assistantFirstSeenAtEpochMs = Date.now();
      }
      const matchedReply = eligibleReplies.find((reply) => {
        const text = extractAssistantVisibleText(reply).trim();
        return text.length > 0 && textEquals(text, expectedText);
      });
      if (matchedReply) {
        return {
          replyRunId: matchedReply.__openclaw?.runId || runId,
          assistantTexts,
          lastAssistantText,
          matchedAssistantText: extractAssistantVisibleText(matchedReply).trim(),
          assistantFirstSeenAtEpochMs,
          assistantMatchedAtEpochMs: Date.now(),
          pollCount,
          errorCount,
          lastHistoryErrorMessage: null,
          assistantTextEvidence
        };
      }
    } catch (error) {
      lastHistoryError = error;
      errorCount += 1;
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  if (readCompletionError()) throw readCompletionError();
  const error = new Error(
    `timed out waiting for Gateway session run ${runId} assistant text exactly equal to ${JSON.stringify(expectedText)}; last=${JSON.stringify(lastAssistantText)}; lastHistoryError=${JSON.stringify(lastHistoryError?.message ?? null)}`
  );
  error.assistantTextEvidence = assistantTextEvidence;
  throw error;
}

async function findSubmittedReplies({ history, sessionKey, runId, expectedText, deadline, readHistory }) {
  const direct = (history.messages ?? []).filter((message) => isAssistantMessage(message) && (
    message?.__openclaw?.runId === runId || messageIdempotencyKey(message) === runId
  ));
  if (direct.length > 0) return direct;

  const receipt = history.inputReceipts?.find((input) => input.runId === runId);
  if (receipt?.state === "pending") return [];
  const inputId = receipt?.state === "consumed" ? receipt.consumedByEventId : null;
  // A queued input can execute under another id. Its durable user message
  // identifies the reply segment; other user messages end that segment.
  let page = history;
  let offset = 0;
  let latestReply = null;
  let matchingReply = null;
  while (Date.now() < deadline) {
    const messages = page.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (assistantRole(message).toLowerCase() === "user") {
        if (messageIdempotencyKey(message) === `${runId}:user` ||
            (inputId && message?.__openclaw?.id === inputId)) {
          return [matchingReply ?? latestReply].filter(Boolean);
        }
        latestReply = null;
        matchingReply = null;
      } else if (isAssistantMessage(message) && typeof message?.__openclaw?.runId === "string" && message.__openclaw.runId) {
        latestReply ??= message;
        if (textEquals(extractAssistantVisibleText(message), expectedText)) matchingReply ??= message;
      }
    }
    if (page.hasMore !== true || !history.sessionId) return [];
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) {
      throw new Error("Gateway history returned a non-advancing page offset");
    }
    offset = page.nextOffset;
    page = await readHistory({ sessionKey, sessionId: history.sessionId, limit: 16, offset });
  }
  return [];
}

function messageIdempotencyKey(message) {
  return message?.__openclaw?.idempotencyKey ?? message?.idempotencyKey;
}

async function gatewayCall(gatewayTransport, method, params, timeoutMs) {
  return await gatewayTransport.client.request(method, params, { timeoutMs });
}

function rejectUnsupportedArgs(args, allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported argument${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${key}`).join(", ")}`);
  }
}

function classifyGatewaySessionFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (isHarnessFailureMessage(message)) {
    return {
      failureDomain: "kova-harness",
      recordStatus: "BLOCKED"
    };
  }
  return {
    failureDomain: "openclaw",
    recordStatus: "FAIL"
  };
}

function isHarnessFailureMessage(message) {
  return /^unsupported argument/.test(message) ||
    /^unexpected argument:/.test(message) ||
    /^--[a-z0-9-]+ requires a value$/.test(message) ||
    /^invalid (?:boolean value|positive integer|timeout):/.test(message) ||
    /^--env is required$/.test(message) ||
    /^ocm\b/.test(message) ||
    /^invalid gateway port from OCM status:/.test(message);
}

function readBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`invalid boolean value: ${value}`);
}

function readPositiveInteger(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function extractAssistantTexts(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .filter(isAssistantMessage)
    .map((message) => extractAssistantVisibleText(message))
    .map((text) => text.trim())
    .filter(Boolean);
}

function summarizeAssistantTextEvidence(messages) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const candidates = allMessages.filter(isAssistantMessage);
  return {
    schemaVersion: "kova.assistantTextEvidence.v1",
    historyMessageCount: allMessages.length,
    assistantCandidateCount: candidates.length,
    candidates: candidates.slice(-4).map((message) => {
      const visibleText = extractAssistantVisibleText(message);
      return {
        role: assistantRole(message),
        keys: Object.keys(message ?? {}).slice(0, 12),
        contentShape: contentShape(message?.content),
        visibleTextPreview: truncateEvidenceText(visibleText, 240),
        visibleTextLength: visibleText.length
      };
    })
  };
}

function isAssistantMessage(message) {
  const role = assistantRole(message).toLowerCase();
  return role.includes("assistant") || role.includes("agent");
}

function assistantRole(message) {
  return String(message?.role ?? message?.sender ?? message?.type ?? "");
}

function contentShape(value) {
  if (typeof value === "string") {
    return "string";
  }
  if (Array.isArray(value)) {
    const types = value
      .map((entry) => typeof entry?.type === "string" ? entry.type : typeof entry)
      .slice(0, 8);
    return `array(${value.length})[${types.join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `object{${Object.keys(value).slice(0, 8).join(",")}}`;
  }
  return value == null ? "nullish" : typeof value;
}

function truncateEvidenceText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function textEquals(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual.trim() === expected.trim();
}
