#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
if (!options.portFile) {
  throw new Error("--port-file is required");
}

const port = fs.readFileSync(options.portFile, "utf8").trim();
if (!/^\d+$/.test(port)) {
  throw new Error(`invalid mock provider port in ${options.portFile}`);
}
if (!options.skipHealthCheck) {
  await assertMockProviderReady(port);
}

const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(requiredEnv("OPENCLAW_HOME"), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, ".env"),
  [
    "OPENAI_API_KEY=kova-mock-key",
    "OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER=1"
  ].join("\n") + "\n",
  "utf8"
);

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

const modelRef = "openai/gpt-5.5";
const imageModelRef = "openai/gpt-image-1";
const videoModelRef = "openai/sora-2";
const gatewayToken = "kova-mock-gateway-token";
const cost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0
};

config.models = {
  ...(config.models || {}),
  mode: "merge",
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...(config.models?.providers?.openai || {}),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY"
      },
      api: "openai-responses",
      request: {
        ...(config.models?.providers?.openai?.request || {}),
        allowPrivateNetwork: true
      },
      models: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost,
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096
        },
        {
          id: "gpt-image-1",
          name: "gpt-image-1",
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost,
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096
        },
        {
          id: "sora-2",
          name: "sora-2",
          api: "openai-responses",
          reasoning: false,
          input: ["text", "image", "video"],
          cost,
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096
        }
      ]
    }
  }
};

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
        params: {
          ...(config.agents?.defaults?.models?.[modelRef]?.params || {}),
          transport: "sse",
          openaiWsWarmup: false
        }
      }
    },
    imageGenerationModel: {
      ...(config.agents?.defaults?.imageGenerationModel || {}),
      primary: imageModelRef
    },
    videoGenerationModel: {
      ...(config.agents?.defaults?.videoGenerationModel || {}),
      primary: videoModelRef
    }
  }
};

config.gateway = {
  ...(config.gateway || {}),
  auth: {
    ...(config.gateway?.auth || {}),
    mode: "token",
    token: gatewayToken
  },
  http: {
    ...(config.gateway?.http || {}),
    endpoints: {
      ...(config.gateway?.http?.endpoints || {}),
      chatCompletions: {
        ...(config.gateway?.http?.endpoints?.chatCompletions || {}),
        enabled: true
      }
    }
  },
  remote: {
    ...(config.gateway?.remote || {}),
    token: gatewayToken
  }
};

if (options.gatewayHttpEndpoints.length > 0) {
  config.gateway.http = {
    ...(config.gateway.http || {}),
    endpoints: {
      ...(config.gateway.http?.endpoints || {})
    }
  };
  for (const endpoint of options.gatewayHttpEndpoints) {
    config.gateway.http.endpoints[endpoint] = {
      ...(config.gateway.http.endpoints[endpoint] || {}),
      enabled: true
    };
  }
}

config.session = {
  ...(config.session || {}),
  dmScope: config.session?.dmScope || "per-channel-peer"
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(configPath);

async function assertMockProviderReady(port) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`mock-ai-provider is not reachable at ${url}: ${lastError?.message ?? "unknown error"}`);
}

function parseArgs(args) {
  const parsed = { gatewayHttpEndpoints: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skip-health-check") {
      parsed.skiphealthcheck = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (key === "gatewayhttpendpoint") {
      parsed.gatewayHttpEndpoints.push(value);
    } else {
      parsed[key] = value;
    }
    index += 1;
  }
  const supportedGatewayHttpEndpoints = new Set(["chatCompletions", "responses"]);
  for (const endpoint of parsed.gatewayHttpEndpoints) {
    if (!supportedGatewayHttpEndpoints.has(endpoint)) {
      throw new Error(`unsupported --gateway-http-endpoint: ${endpoint}`);
    }
  }
  return {
    portFile: parsed.portfile,
    skipHealthCheck: parsed.skiphealthcheck === true,
    gatewayHttpEndpoints: parsed.gatewayHttpEndpoints
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
