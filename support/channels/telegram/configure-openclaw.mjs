#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const portFile = requiredArg(args, "port-file");
const token = args.token ?? "999001:kova-telegram-token";
const streamingMode = optionalString(args["streaming-mode"]);
const port = fs.readFileSync(portFile, "utf8").trim();
if (!/^\d+$/u.test(port)) {
  throw new Error(`invalid Telegram shim port in ${portFile}`);
}

const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(requiredEnv("OPENCLAW_HOME"), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}

const existingTelegram = config.channels?.telegram ?? {};
config.channels = {
  ...(config.channels ?? {}),
  telegram: {
    ...existingTelegram,
    enabled: true,
    botToken: token,
    apiRoot: `http://127.0.0.1:${port}`,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "open",
    groupAllowFrom: ["*"],
    mediaGroupFlushMs: 50,
    pollingStallThresholdMs: 30000,
    timeoutSeconds: 2,
    network: {
      ...(existingTelegram.network ?? {}),
      dangerouslyAllowPrivateNetwork: true
    },
    groups: {
      ...(existingTelegram.groups ?? {}),
      "*": {
        ...(existingTelegram.groups?.["*"] ?? {}),
        requireMention: false,
        groupPolicy: "open",
        allowFrom: ["*"],
        topics: {
          ...(existingTelegram.groups?.["*"]?.topics ?? {}),
          "*": {
            ...(existingTelegram.groups?.["*"]?.topics?.["*"] ?? {}),
            requireMention: false,
            groupPolicy: "open",
            allowFrom: ["*"]
          }
        }
      }
    },
    actions: {
      ...(existingTelegram.actions ?? {}),
      createForumTopic: true,
      deleteMessage: true,
      editForumTopic: true,
      editMessage: true,
      poll: true,
      reactions: true,
      sendMessage: true
    },
    capabilities: {
      ...(existingTelegram.capabilities ?? {}),
      inlineButtons: "all"
    },
    ...(streamingMode ? {
      streaming: {
        ...(existingTelegram.streaming && typeof existingTelegram.streaming === "object" && !Array.isArray(existingTelegram.streaming)
          ? existingTelegram.streaming
          : {}),
        mode: streamingMode
      }
    } : {}),
    reactionLevel: "minimal",
    replyToMode: "all"
  }
};
config.messages = {
  ...(config.messages ?? {}),
  groupChat: {
    ...(config.messages?.groupChat ?? {}),
    unmentionedInbound: "room_event",
    mentionPatterns: []
  }
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(configPath);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) {
      throw new Error(`unexpected argument '${key}'`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
