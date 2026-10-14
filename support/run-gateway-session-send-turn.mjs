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
    const sendStartedAtEpochMs = Date.now();
    const sent = await gatewayCall(gatewayTransport, "sessions.send", {
        key: canonicalKey,
        message,
        thinking: "off",
        timeoutMs,
        idempotencyKey: `kova-gateway-session-${randomUUID()}`
      }, Math.min(timeoutMs, 60000));
    const sendFinishedAtEpochMs = Date.now();
    runId = typeof sent?.runId === "string" && sent.runId.trim() ? sent.runId : null;
    if (runId === null) {
      throw new Error("sessions.send returned no run id");
    }
    const deadline = sendStartedAtEpochMs + timeoutMs;
    const completion = waitForRunCompletion({ gatewayTransport, runId, deadline });
    let completionError = null;
    void completion.catch((error) => { completionError = error; });

    const history = await waitForAssistantText({
      gatewayTransport,
      sessionKey: canonicalKey,
      expectedText,
      deadline,
      runId,
      minAssistantCount,
      readCompletionError: () => completionError
    });
    const runCompletedAtEpochMs = await completion;
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

async function waitForAssistantText({ gatewayTransport, sessionKey, expectedText, deadline, runId, minAssistantCount, readCompletionError }) {
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
      pollCount += 1;
      const history = await gatewayCall(gatewayTransport, "chat.history", { sessionKey, limit: 16 }, Math.min(15000, Math.max(1000, deadline - Date.now())));
      lastHistoryError = null;
      const messages = history?.messages ?? [];
      assistantTexts = extractAssistantTexts(messages);
      assistantTextEvidence = summarizeAssistantTextEvidence(messages);
      const runAssistantTexts = extractAssistantTexts(messages.filter((message) => message?.__openclaw?.runId === runId));
      lastAssistantText = runAssistantTexts.at(-1) ?? "";
      const eligibleAssistantTexts = assistantTexts.length >= minAssistantCount ? runAssistantTexts : [];
      if (assistantFirstSeenAtEpochMs === null && eligibleAssistantTexts.length > 0) {
        assistantFirstSeenAtEpochMs = Date.now();
      }
      const matchedAssistantText = eligibleAssistantTexts.find((text) => textEquals(text, expectedText));
      if (matchedAssistantText) {
        return {
          assistantTexts,
          lastAssistantText,
          matchedAssistantText,
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
