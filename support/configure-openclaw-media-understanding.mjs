#!/usr/bin/env node
import { positiveInt as positiveInteger, parseCompactArgs } from "./cli-args.mjs";

import fs from "node:fs";
import path from "node:path";
import { ownedOpenClawPaths } from "./openclaw-scope.mjs";

const options = parseArgs(process.argv.slice(2));
const timeoutMs = positiveInteger(options.timeoutMs ?? "1200", "timeout-ms");
const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
const { stateDir, configPath } = ownedOpenClawPaths();

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

const openaiProvider = config.models?.providers?.openai || {};
const models = Array.isArray(openaiProvider.models)
  ? openaiProvider.models.filter((model) => model?.id !== "gpt-5.5")
  : [];

config.models = {
  ...(config.models || {}),
  mode: "merge",
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...openaiProvider,
      models: [
        ...models,
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096
        }
      ]
    }
  }
};

config.tools = {
  ...(config.tools || {}),
  media: {
    ...(config.tools?.media || {}),
    image: {
      ...(config.tools?.media?.image || {}),
      enabled: true,
      timeoutSeconds,
      models: [
        {
          provider: "openai",
          model: "gpt-5.5",
          capabilities: ["image"],
          timeoutSeconds
        }
      ]
    }
  }
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(configPath);

function parseArgs(args) {
  const parsed = parseCompactArgs(args);
  return {
    timeoutMs: parsed.timeoutms
  };
}
