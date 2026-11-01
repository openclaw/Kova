#!/usr/bin/env node
import { parseCompactArgs } from "./cli-args.mjs";
import fs from "node:fs";
import path from "node:path";
import { ownedOpenClawPaths } from "./openclaw-scope.mjs";

const options = parseArgs(process.argv.slice(2));
const provider = options.provider || "openai";
const envVar = options.envVar || "OPENAI_API_KEY";
const authMethod = options.authMethod || "env";
const externalCli = options.externalCli || null;
const externalRuntime = authMethod === "external-cli"
  ? externalCliRuntimeConfig(provider, externalCli)
  : null;
const model = modelConfig(provider, options.model);
const modelRef = `${provider}/${model.id}`;

const { configPath } = ownedOpenClawPaths();
fs.mkdirSync(path.dirname(configPath), { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

if (authMethod !== "external-cli") {
  const existingProvider = config.models?.providers?.[provider] || {};
  if (provider === "custom-openai" && (typeof existingProvider.baseUrl !== "string" || !existingProvider.baseUrl.trim())) {
    throw new Error("custom-openai requires a preconfigured baseUrl; use --source-env with gateway-session-send-turn-existing-user, or choose openai/anthropic for a fresh environment");
  }
  config.models = {
    ...(config.models || {}),
    mode: "merge",
    providers: {
      ...(config.models?.providers || {}),
      [provider]: {
        ...existingProvider,
        agentRuntime: {
          ...(existingProvider.agentRuntime || {}),
          id: "openclaw"
        },
        apiKey: {
          source: "env",
          provider: "default",
          id: envVar
        },
        models: mergeModels(existingProvider.models, model)
      }
    }
  };
}

if (externalRuntime?.pluginEntry) {
  config.plugins = {
    ...(config.plugins || {}),
    entries: {
      ...(config.plugins?.entries || {}),
      [externalRuntime.pluginEntry]: {
        ...(config.plugins?.entries?.[externalRuntime.pluginEntry] || {}),
        enabled: true
      }
    }
  };
}

config.agents = {
  ...(config.agents || {}),
  defaults: {
    ...(config.agents?.defaults || {}),
    model: {
      ...(config.agents?.defaults?.model || {}),
      primary: modelRef
    },
    models: {
      ...(config.agents?.defaults?.models || {}),
      [modelRef]: {
        ...(config.agents?.defaults?.models?.[modelRef] || {}),
        agentRuntime: { id: externalRuntime?.agentRuntime || "openclaw" }
      }
    }
  }
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(configPath);

function mergeModels(existing, modelConfig) {
  const models = Array.isArray(existing) ? existing.filter((item) => item?.id !== modelConfig.id) : [];
  return [...models, modelConfig];
}

function defaultModel(provider) {
  if (provider === "anthropic") {
    return {
      id: "claude-sonnet-4-5",
      name: "claude-sonnet-4-5",
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 8192
    };
  }
  return {
    id: "gpt-5.5",
    name: "gpt-5.5",
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    contextTokens: 96000,
    maxTokens: 4096
  };
}

function modelConfig(provider, modelId) {
  const model = defaultModel(provider);
  if (!modelId) {
    return model;
  }
  return {
    ...model,
    id: modelId,
    name: modelId
  };
}

function externalCliRuntimeConfig(provider, cli) {
  if (provider === "openai" && cli === "codex") {
    return {
      agentRuntime: "codex",
      pluginEntry: "codex"
    };
  }
  if (provider === "anthropic" && cli === "claude") {
    return {
      agentRuntime: "claude-cli",
      pluginEntry: "anthropic"
    };
  }
  throw new Error(`unsupported external CLI runtime for provider ${provider}: ${cli || "<missing>"}`);
}

function parseArgs(args) {
  const parsed = parseCompactArgs(args);
  return {
    provider: parsed.provider,
    envVar: parsed.envvar,
    authMethod: parsed.authmethod,
    externalCli: parsed.externalcli,
    model: parsed.model
  };
}
