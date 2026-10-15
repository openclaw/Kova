#!/usr/bin/env node
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EntryError, runEntry } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";

const keyPattern = /^(?:global|agent:[a-z0-9][a-z0-9_-]*:[^\s\u0000-\u001f\u007f]+)$/;
const fieldTypes = { label: "string", model: "string", pinned: "boolean", snoozedUntil: "number", category: "string", color: "string", unread: "boolean", archived: "boolean" };

export const sessionOperationRequests = {
  describe: (key, agentId) => ({ method: "sessions.describe", params: { key, ...(agentId ? { agentId } : {}) } }),
  patch: (key, agentId, expectedSessionId, fields) => ({ method: "sessions.patch", params: { key, ...(agentId ? { agentId } : {}), expectedSessionId, ...fields } }),
};
export const sessionOperationRequestCases = {
  describe: [["agent:main:main"], ["agent:research:dashboard:example", "research"]],
  patch: [
    ["agent:main:main", undefined, "saved-session-id", { label: "kova-persona-main" }],
    ["agent:main:main", undefined, "saved-session-id", { model: "openai/mock-tools" }],
    ["agent:research:dashboard:example", "research", "saved-session-id", { pinned: true }],
    ["agent:research:dashboard:example", "research", "saved-session-id", { snoozedUntil: 2000000000000 }],
    ["agent:research:dashboard:example", "research", "saved-session-id", { category: "Verification notebook", color: "purple" }],
    ["agent:research:dashboard:example", "research", "saved-session-id", { unread: true }],
    ["agent:research:dashboard:example", "research", "saved-session-id", { archived: true }],
  ],
};

export function sessionPatchFields(args, now = Date.now()) {
  if ((args.fields !== undefined) === (args["snooze-for-ms"] !== undefined)) throw new EntryError("choose --fields or --snooze-for-ms", 2);
  if (args["snooze-for-ms"] !== undefined) {
    const duration = args["snooze-for-ms"];
    if (!/^\d+$/.test(duration) || !Number.isSafeInteger(Number(duration)) || Number(duration) < 1 || !Number.isSafeInteger(now + Number(duration))) throw new EntryError("--snooze-for-ms must be a positive duration in milliseconds", 2);
    return { snoozedUntil: now + Number(duration) };
  }
  let fields;
  try { fields = JSON.parse(args.fields); } catch { throw new EntryError("--fields must be a JSON object", 2); }
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw new EntryError("--fields must be a nonempty JSON object", 2);
  for (const [field, value] of Object.entries(fields)) {
    if (!Object.hasOwn(fieldTypes, field) || typeof value !== fieldTypes[field] || (field === "snoozedUntil" && (!Number.isSafeInteger(value) || value < 1))) throw new EntryError("unsupported session patch field or value", 2);
  }
  return fields;
}

export async function patchSessionOperation({ rpc, key, agentId, fields }) {
  if (!keyPattern.test(key ?? "")) throw new EntryError("a canonical session key is required", 2);
  const { session } = await rpc(sessionOperationRequests.describe(key, agentId));
  if (session?.key !== key || typeof session.sessionId !== "string" || !session.sessionId) throw new Error("session patch target has no saved identity");
  await rpc(sessionOperationRequests.patch(key, agentId, session.sessionId, fields));
  return { key, sessionId: session.sessionId };
}

async function readSessionKey(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new EntryError("invalid session receipt file", 2);
  let result;
  try { result = JSON.parse(await readFile(path, "utf8")); } catch { throw new EntryError("invalid session receipt JSON", 2); }
  const key = result?.key ?? result?.sessionKey;
  if (!keyPattern.test(key ?? "")) throw new EntryError("session receipt has no canonical key", 2);
  return key;
}

async function main() {
  const argv = process.argv.slice(2);
  const operation = argv.shift();
  await runEntry({
    key: { type: "string", pattern: keyPattern }, "session-from": { type: "string" },
    agent: { type: "string", pattern: /^[a-z0-9][a-z0-9_-]{0,63}$/ },
    fields: { type: "string" }, "snooze-for-ms": { type: "string" }, out: { type: "string" },
  }, async ({ args, env }) => {
    const key = args.key ?? await readSessionKey(args["session-from"]);
    const result = await withSessionClient(env, (rpc) => patchSessionOperation({ rpc, key, agentId: args.agent, fields: sessionPatchFields(args) }));
    if (args.out) await writeFile(args.out, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
    return result;
  }, argv, (args) => {
    if (operation !== "patch") throw new EntryError("expected patch", 2);
    if ((args.key !== undefined) === (args["session-from"] !== undefined)) throw new EntryError("choose --key or --session-from", 2);
    for (const path of [args["session-from"], args.out]) if (path !== undefined && !isAbsolute(path)) throw new EntryError("a receipt path must be absolute", 2);
    sessionPatchFields(args);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
