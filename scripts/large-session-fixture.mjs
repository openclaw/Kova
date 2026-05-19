#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = required(args.root, "--root");
const shape = args.shape ?? "valid";

if (args._[0] !== "prepare") {
  throw new Error("usage: large-session-fixture.mjs prepare --root <dir> --shape <valid|malformed>");
}
if (!["valid", "malformed"].includes(shape)) {
  throw new Error(`--shape must be valid or malformed, got ${JSON.stringify(shape)}`);
}

mkdirSync(root, { recursive: true });
writeFileSync(join(root, "sessions.json"), `${JSON.stringify(buildSessions(shape), null, 2)}\n`);
writeFileSync(join(root, "memory.json"), `${JSON.stringify(buildMemory(), null, 2)}\n`);

function buildSessions(shape) {
  const sessions = Array.from({ length: 80 }, (_, index) => buildSession(index));
  if (shape === "malformed") {
    return {
      schemaVersion: "kova.fixture.sessions.v1",
      sessions: sessions.map((entry, index) => ({
        id: entry.sessionId,
        createdAt: new Date(entry.updatedAt).toISOString(),
        messages: Array.from({ length: 30 }, (_, messageIndex) => ({
          role: messageIndex % 2 ? "assistant" : "user",
          content: `kova fixture message ${index}/${messageIndex} `.repeat(200),
        })),
      })),
    };
  }

  return Object.fromEntries(sessions.map((entry) => [entry.sessionId, entry]));
}

function buildSession(index) {
  const sessionId = `kova-session-${index}`;
  const updatedAt = Date.UTC(2026, 0, 1, 0, 0, index);
  return {
    sessionId,
    updatedAt,
    sessionFile: `${sessionId}.jsonl`,
    channel: "kova",
    lastChannel: "kova",
    lastTo: "fixture-user",
    lastThreadId: `thread-${Math.floor(index / 4)}`,
    label: `Kova large session ${index}`,
    pluginExtensions: {
      "kova.fixture": {
        largeContextDigest: `session ${index} `.repeat(450),
        messageCount: 30,
        bytePressure: true,
      },
    },
    systemPromptReport: {
      schemaVersion: "kova.fixture.systemPromptReport.v1",
      summary: `Kova large session report ${index} `.repeat(160),
    },
  };
}

function buildMemory() {
  return {
    schemaVersion: "kova.fixture.memory.v1",
    items: Array.from({ length: 1200 }, (_, index) => ({
      id: `memory-${index}`,
      text: `memory payload ${index} `.repeat(120),
    })),
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
