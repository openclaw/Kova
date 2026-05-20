#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const options = parseArgs(process.argv.slice(2));
if (!options.output) {
  throw new Error("--output is required");
}

const providerScript = scriptForMode(options);
mkdirSync(dirname(options.output), { recursive: true });
writeFileSync(options.output, `${JSON.stringify(providerScript, null, 2)}\n`, "utf8");

function scriptForMode(options) {
  if (options.channelWorkflowCases.length > 0) {
    return channelWorkflowScript(options.channelWorkflowCases);
  }
  const marker = options.marker ?? "KOVA_AGENT_OK";
  const mode = options.mode ?? "normal";
  const delayMs = nonNegativeInteger(options.delayMs, "delayMs") ?? 1000;
  const stallMs = nonNegativeInteger(options.stallMs, "stallMs") ?? 65000;
  const errorStatus = nonNegativeInteger(options.errorStatus, "errorStatus") ?? 503;
  const final = { type: "final-text", text: marker };

  if (mode === "normal") {
    return makeScript(mode, [{ id: "kova-normal-final", respond: final }]);
  }
  if (mode === "slow" || mode === "concurrent-pressure") {
    return makeScript(mode, [{
      id: `kova-${mode}-delay`,
      respond: {
        type: "delay",
        ms: delayMs,
        then: final
      }
    }]);
  }
  if (mode === "timeout" || mode === "streaming-stall") {
    return makeScript(mode, [{
      id: `kova-${mode}-timeout`,
      respond: {
        type: "timeout",
        ms: stallMs
      }
    }]);
  }
  if (mode === "malformed") {
    return makeScript(mode, [{
      id: "kova-malformed-response",
      respond: {
        type: "malformed",
        status: 200,
        contentType: "application/json",
        body: "{this-is-not-json"
      }
    }]);
  }
  if (mode === "error-then-recover") {
    return makeScript(mode, [
      {
        id: "kova-error-then-recover-error",
        respond: {
          type: "error",
          status: errorStatus,
          message: "mock provider transient failure",
          errorType: "provider-error",
          code: "kova_mock_provider_error"
        }
      },
      {
        id: "kova-error-then-recover-final",
        respond: final
      }
    ]);
  }
  throw new Error(`unsupported mock provider mode '${mode}'`);
}

function channelWorkflowScript(caseIds) {
  const catalog = JSON.parse(readFileSync(join(repoRoot, "channel-capabilities", "channel-workflow-cases.json"), "utf8"));
  const casesById = new Map((catalog.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const steps = [];
  for (const caseId of caseIds) {
    const testCase = casesById.get(caseId);
    if (!testCase) {
      throw new Error(`unknown channel workflow case '${caseId}'`);
    }
    steps.push(...scriptStepsForWorkflowCase(testCase));
  }
  if (steps.length === 0) {
    throw new Error("channel workflow mock script did not produce any steps");
  }
  return {
    id: "kova-channel-workflows",
    steps
  };
}

function scriptStepsForWorkflowCase(testCase) {
  const script = testCase.providerScript ?? {};
  if (Number.isInteger(script.errorStatus)) {
    return [{
      id: `${testCase.id}:provider-error`,
      respond: {
        type: "error",
        status: script.errorStatus,
        message: "mock provider channel workflow failure",
        errorType: "provider-error",
        code: "kova_channel_workflow_error"
      }
    }];
  }
  if (Array.isArray(script.toolCalls) && script.toolCalls.length > 0) {
    return [
      {
        id: `${testCase.id}:tool-calls`,
        respond: {
          type: "tool-calls",
          toolCalls: script.toolCalls.map((toolCall, index) => ({
            id: toolCall.id ?? `call_${safeToolCallId(testCase.id)}_${index + 1}`,
            name: requiredNonEmptyString(toolCall.name, `${testCase.id} providerScript.toolCalls[${index}].name`),
            arguments: stringifyToolArguments(toolCall.arguments)
          }))
        }
      },
      {
        id: `${testCase.id}:final`,
        respond: {
          type: "final-text",
          text: typeof script.finalText === "string" ? script.finalText : "NO_REPLY"
        }
      }
    ];
  }
  return [{
    id: `${testCase.id}:final`,
    respond: {
      type: "final-text",
      text: typeof script.finalText === "string" ? script.finalText : "Hello from mock AI provider"
    }
  }];
}

function stringifyToolArguments(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "{}";
  }
  return JSON.stringify(value);
}

function safeToolCallId(value) {
  return String(value ?? "case").replace(/[^a-zA-Z0-9_]+/g, "_");
}

function requiredNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function makeScript(id, steps) {
  return { id: `kova-${id}`, steps };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return {
    output: parsed.output,
    marker: parsed.marker,
    mode: parsed.mode,
    delayMs: parsed.delayms,
    stallMs: parsed.stallms,
    errorStatus: parsed.errorstatus,
    channelWorkflowCases: String(parsed.channelworkflowcases ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function nonNegativeInteger(value, label) {
  if (value === undefined) {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}
