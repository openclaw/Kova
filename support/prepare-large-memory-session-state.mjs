#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: prepare-large-memory-session-state.mjs <output-dir>");
  process.exit(2);
}

mkdirSync(root, { recursive: true });
mkdirSync(path.join(root, "sessions"), { recursive: true });

const now = Date.now();
const isoNow = new Date(now).toISOString();
const sessionStore = {};

for (let i = 0; i < 80; i += 1) {
  const sessionId = `kova-session-${i}`;
  const sessionKey = `agent:main:kova-large-memory:${i}`;
  const sessionFile = `${sessionId}.jsonl`;
  sessionStore[sessionKey] = {
    sessionId,
    sessionFile,
    updatedAt: now - i,
    sessionStartedAt: now - i,
    displayName: `Kova large memory session ${i}`,
    modelProvider: "openai",
    model: "gpt-5.5"
  };

  const lines = [
    JSON.stringify({
      type: "session",
      version: 1,
      id: sessionId,
      timestamp: isoNow,
      cwd: root
    })
  ];
  let parentId = null;
  for (let j = 0; j < 30; j += 1) {
    const id = `${sessionId}-message-${j}`;
    const role = j % 2 ? "assistant" : "user";
    const text = `kova fixture message ${i}/${j} `.repeat(200);
    lines.push(JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: new Date(now + j).toISOString(),
      message: {
        role,
        content: [{ type: "text", text }]
      }
    }));
    parentId = id;
  }
  writeFileSync(path.join(root, "sessions", sessionFile), `${lines.join("\n")}\n`);
}

writeFileSync(path.join(root, "sessions", "sessions.json"), JSON.stringify(sessionStore, null, 2));
writeFileSync(path.join(root, "memory.json"), JSON.stringify({
  schemaVersion: "kova.fixture.memory.v1",
  items: Array.from({ length: 1200 }, (_, i) => ({
    id: `memory-${i}`,
    text: `memory payload ${i} `.repeat(120)
  }))
}, null, 2));
