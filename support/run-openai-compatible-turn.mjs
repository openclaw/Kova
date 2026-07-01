#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  extractText,
  failJson,
  finishJson,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs
} from "./openclaw-runtime.mjs";
import { resolveGatewayEndpoint } from "./gateway-endpoint.mjs";

const startedAtEpochMs = Date.now();

try {
  const args = parseSupportArgs(process.argv.slice(2));
  const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(args.env);
  const message = args.message ?? "Reply with exact ASCII text KOVA_AGENT_OK only.";
  const expectedText = args["expected-text"] ?? "KOVA_AGENT_OK";
  const timeoutMs = readTimeoutMs(args.timeout, 120000);
  const model = args.model ?? "openclaw";
  const cfg = readConfig(runtimeContext.root);
  const gateway = resolveGatewayEndpoint(runtimeContext, cfg, { protocol: "http" });
  const token = readGatewayToken(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`OpenAI-compatible request timed out after ${timeoutMs}ms`)), timeoutMs);
  const requestStartedAtEpochMs = Date.now();
  try {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: message }],
        stream: false
      }),
      signal: controller.signal
    });
    const bodyText = await response.text();
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { raw: bodyText };
    }
    if (!response.ok) {
      throw new Error(`OpenAI-compatible HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
    }
    const finalText = extractText(body?.choices?.[0]?.message ?? body);
    finishJson({
      ok: true,
      surface: "openai-compatible-turn",
      method: "POST /v1/chat/completions",
      envName: runtimeContext.envName,
      runtime: runtimeContext.runtime,
      gateway: {
        source: gateway.source,
        host: gateway.host,
        port: gateway.port,
        url: gateway.url
      },
      model,
      startedAtEpochMs,
      requestStartedAtEpochMs,
      finishedAtEpochMs: Date.now(),
      status: response.status,
      finalAssistantVisibleText: finalText,
      finalAssistantRawText: finalText,
      expectedTextPresent: textEquals(finalText, expectedText)
    });
  } finally {
    clearTimeout(timer);
  }
} catch (error) {
  failJson(error, { surface: "openai-compatible-turn", finishedAtEpochMs: Date.now() });
}

function textEquals(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual.trim() === expected.trim();
}

function readGatewayToken(cfg) {
  const candidates = [
    process.env.OPENCLAW_GATEWAY_TOKEN,
    cfg?.gateway?.auth?.token,
    cfg?.gateway?.token
  ];
  return candidates.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

function readConfig(root) {
  const configPath = path.join(root, ".openclaw", "openclaw.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}
