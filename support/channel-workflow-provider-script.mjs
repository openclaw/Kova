import { readChannelWorkflowCaseCatalogSync } from "./channel-workflow-catalog.mjs";

export function scriptForMode(options, repoRoot) {
  if (options.channelWorkflowCases.length > 0) {
    return channelWorkflowScript(options.channelWorkflowCases, repoRoot);
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

export function channelWorkflowScript(caseIds, repoRoot, options = {}) {
  const catalog = readChannelWorkflowCatalog(repoRoot);
  const casesById = new Map((catalog.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const steps = [];
  for (const caseId of caseIds) {
    const testCase = casesById.get(caseId);
    if (!testCase) {
      throw new Error(`unknown channel workflow case '${caseId}'`);
    }
    steps.push(...scriptStepsForWorkflowCase(testCase, options));
  }
  if (steps.length === 0) {
    throw new Error("channel workflow mock script did not produce any steps");
  }
  return {
    id: "kova-channel-workflows",
    steps
  };
}

export function scriptStepsForWorkflowCase(testCase, options = {}) {
  const steps = primaryScriptStepsForWorkflowCase(testCase, options);
  const expects = testCase.expects && typeof testCase.expects === "object" && !Array.isArray(testCase.expects)
    ? testCase.expects
    : {};
  if (expects.noSelfTrigger === true) {
    steps.push({
      id: `${testCase.id}:unexpected-bot-echo-final`,
      respond: {
        type: "final-text",
        text: "KOVA_UNEXPECTED_BOT_ECHO_RESPONSE"
      }
    });
  }
  return steps;
}

function readChannelWorkflowCatalog(repoRoot) {
  return readChannelWorkflowCaseCatalogSync(repoRoot);
}

function primaryScriptStepsForWorkflowCase(testCase, options = {}) {
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
    const hasCompletionToolCalls = Array.isArray(script.completionToolCalls) && script.completionToolCalls.length > 0;
    const steps = [
      {
        id: `${testCase.id}:tool-calls`,
        respond: {
          type: "tool-calls",
          toolCalls: script.toolCalls.map((toolCall, index) =>
            scriptToolCall(testCase, "providerScript.toolCalls", toolCall, index, options)
          )
        }
      },
    ];
    if (!hasCompletionToolCalls) {
      steps.push({
        id: `${testCase.id}:final`,
        respond: {
          type: "final-text",
          text: replaceScriptString(typeof script.finalText === "string" ? script.finalText : "NO_REPLY", options.replacements)
        }
      });
    }
    if (hasCompletionToolCalls) {
      steps.push(
        {
          id: `${testCase.id}:completion-tool-calls`,
          respond: {
            type: "tool-calls",
            toolCalls: script.completionToolCalls.map((toolCall, index) =>
              scriptToolCall(testCase, "providerScript.completionToolCalls", toolCall, index, options)
            )
          }
        },
        {
          id: `${testCase.id}:completion-final`,
          respond: {
            type: "final-text",
            text: replaceScriptString(typeof script.completionFinalText === "string" ? script.completionFinalText : "NO_REPLY", options.replacements)
          }
        }
      );
    }
    return steps;
  }
  return [{
    id: `${testCase.id}:final`,
    respond: {
      type: "final-text",
      text: replaceScriptString(typeof script.finalText === "string" ? script.finalText : "Hello from mock AI provider", options.replacements)
    }
  }];
}

function scriptToolCall(testCase, label, toolCall, index, options = {}) {
  const testCaseId = testCase.id;
  const defaultId = `call_${safeToolCallId(`${testCaseId}_${label}`)}_${index + 1}`;
  const needsGeneratedMediaPath = JSON.stringify(toolCall.arguments ?? "").includes("{{kova.generatedMediaPath}}");
  const replacements = {
    ...(needsGeneratedMediaPath ? generatedMediaPathReplacement(testCase) : {}),
    ...(options.replacements ?? {})
  };
  return {
    id: toolCall.id ?? defaultId,
    name: requiredNonEmptyString(toolCall.name, `${testCaseId} ${label}[${index}].name`),
    arguments: stringifyToolArguments(replaceScriptValue(toolCall.arguments, replacements))
  };
}

function generatedMediaPathReplacement(testCase) {
  const token = "{{kova.generatedMediaPath}}";
  const filename = generatedMediaFilename(testCase);
  if (!filename) {
    throw new Error(`${testCase.id} uses ${token} without a generated media filename`);
  }
  const stem = filename.replace(/\.[^.]+$/u, "");
  const extension = filename.slice(stem.length);
  const pattern = extension
    ? `path=\"([^\"]*${escapeRegex(stem)}[^\"]*${escapeRegex(extension)})\"`
    : `path=\"([^\"]*${escapeRegex(filename)}[^\"]*)\"`;
  return {
    [token]: `{{request.text.match:${pattern}}}`
  };
}

function generatedMediaFilename(testCase) {
  const calls = Array.isArray(testCase.providerScript?.toolCalls)
    ? testCase.providerScript.toolCalls
    : [];
  for (const call of calls) {
    const args = call?.arguments;
    if (args && typeof args === "object" && !Array.isArray(args) && typeof args.filename === "string" && args.filename.length > 0) {
      return args.filename;
    }
  }
  return null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceScriptValue(value, replacements = {}) {
  if (typeof value === "string") {
    return replaceScriptString(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceScriptValue(entry, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      replaceScriptValue(entry, replacements)
    ]));
  }
  return value;
}

function replaceScriptString(value, replacements = {}) {
  return Object.entries(replacements).reduce(
    (current, [from, to]) => current.split(from).join(to),
    value
  );
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
