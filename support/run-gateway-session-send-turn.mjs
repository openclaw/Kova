#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  extractText,
  failJson,
  finishJson,
  openDirectGatewayRpcClient,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs,
  runOcmJson,
  sleep
} from "./openclaw-runtime.mjs";

const startedAtEpochMs = Date.now();

try {
  const args = parseSupportArgs(process.argv.slice(2));
  const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(args.env);
  const message = args.message ?? "Reply with exact ASCII text KOVA_AGENT_OK only.";
  const expectedText = args["expected-text"] ?? "KOVA_AGENT_OK";
  const timeoutMs = readTimeoutMs(args.timeout, 120000);
  const sessionKey = args["session-key"] ?? `kova-gateway-session-${randomUUID()}`;
  const createSession = readBoolean(args["create-session"], true);
  const minAssistantCount = readPositiveInteger(args["min-assistant-count"], 1);
  const allowShellFallback = readBoolean(args["allow-shell-fallback"], false);
  const gatewayTransport = await openDirectGatewayRpcClient(runtimeContext);
  if (!gatewayTransport.client && !allowShellFallback) {
    throw new Error(`direct Gateway RPC is required for gateway-session-send-turn; fallback=${gatewayTransport.transport}; reason=${gatewayTransport.fallbackReason ?? "unknown"}`);
  }

  try {
    let created = null;
    let sessionCreateStartedAtEpochMs = null;
    let sessionCreateFinishedAtEpochMs = null;
    if (createSession) {
      sessionCreateStartedAtEpochMs = Date.now();
      created = await gatewayCall(runtimeContext, gatewayTransport, "sessions.create", {
        agentId: "main",
        key: sessionKey,
        label: "Kova Gateway Session Send"
      }, Math.min(timeoutMs, 60000));
      sessionCreateFinishedAtEpochMs = Date.now();
    }
    const canonicalKey = created?.key ?? sessionKey;
    const sendStartedAtEpochMs = Date.now();
    const sent = await gatewayCall(runtimeContext, gatewayTransport, "sessions.send", {
        key: canonicalKey,
        message,
        thinking: "off",
        timeoutMs,
        idempotencyKey: `kova-gateway-session-${randomUUID()}`
      }, Math.min(timeoutMs, 60000));
    const sendFinishedAtEpochMs = Date.now();
    const runId = typeof sent?.runId === "string" ? sent.runId : null;

    const history = await waitForAssistantText({
      runtimeContext,
      gatewayTransport,
      sessionKey: canonicalKey,
      expectedText,
      timeoutMs,
      minAssistantCount
    });
    const finishedAtEpochMs = Date.now();
    const activeFinishedAtEpochMs = history.assistantMatchedAtEpochMs ?? finishedAtEpochMs;

    finishJson({
      ok: true,
      surface: "gateway-session-send-turn",
      method: "sessions.send",
      createSession,
      minAssistantCount,
      envName: runtimeContext.envName,
      runtime: runtimeContext.runtime,
      gatewayTransport: {
        kind: gatewayTransport.transport,
        fallbackReason: gatewayTransport.fallbackReason
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
      expectedTextPresent: history.matchedAssistantText.includes(expectedText)
    });
  } finally {
    gatewayTransport.client?.close();
  }
} catch (error) {
  failJson(error, { surface: "gateway-session-send-turn", finishedAtEpochMs: Date.now() });
}

async function waitForAssistantText({ runtimeContext, gatewayTransport, sessionKey, expectedText, timeoutMs, minAssistantCount }) {
  const deadline = Date.now() + timeoutMs;
  let lastAssistantText = "";
  let lastHistoryError = null;
  let assistantTexts = [];
  let assistantFirstSeenAtEpochMs = null;
  let pollCount = 0;
  let errorCount = 0;
  while (Date.now() < deadline) {
    try {
      pollCount += 1;
      const history = await gatewayCall(runtimeContext, gatewayTransport, "chat.history", { sessionKey, limit: 16 }, Math.min(15000, Math.max(1000, deadline - Date.now())));
      lastHistoryError = null;
      assistantTexts = extractAssistantTexts(history?.messages ?? []);
      lastAssistantText = assistantTexts.at(-1) ?? "";
      const eligibleAssistantTexts = assistantTexts.slice(Math.max(0, minAssistantCount - 1));
      if (assistantFirstSeenAtEpochMs === null && eligibleAssistantTexts.length > 0) {
        assistantFirstSeenAtEpochMs = Date.now();
      }
      const matchedAssistantText = eligibleAssistantTexts.find((text) => text.includes(expectedText));
      if (matchedAssistantText) {
        return {
          assistantTexts,
          lastAssistantText,
          matchedAssistantText,
          assistantFirstSeenAtEpochMs,
          assistantMatchedAtEpochMs: Date.now(),
          pollCount,
          errorCount,
          lastHistoryErrorMessage: null
        };
      }
    } catch (error) {
      lastHistoryError = error;
      errorCount += 1;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for Gateway session assistant text ${JSON.stringify(expectedText)}; last=${JSON.stringify(lastAssistantText)}; lastHistoryError=${JSON.stringify(lastHistoryError?.message ?? null)}`
  );
}

async function gatewayCall(runtimeContext, gatewayTransport, method, params, timeoutMs) {
  if (gatewayTransport.client) {
    return await gatewayTransport.client.request(method, params, { timeoutMs });
  }
  return runOcmJson([
    `@${runtimeContext.envName}`,
    "--",
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--timeout",
    String(timeoutMs),
    "--json"
  ]);
}

function readBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`invalid boolean value: ${value}`);
}

function readPositiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
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
    .filter((message) => {
      const role = String(message?.role ?? message?.sender ?? message?.type ?? "").toLowerCase();
      return role.includes("assistant") || role.includes("agent");
    })
    .map((message) => extractText(message))
    .map((text) => text.trim())
    .filter(Boolean);
}
