import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isKovaTarget } from "./protocol.js";

const CHANNEL_ID = "kova-channel-probe";
const ACCOUNT_ID = "default";
const MAX_BINDINGS = 64;
const MAX_BYTES = 128 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedString = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const keysOnly = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));

export function probeBindingsFile(stateDir) {
  return join(stateDir, CHANNEL_ID, `thread-bindings-${ACCOUNT_ID}.json`);
}

function validateRecords(values) {
  if (!Array.isArray(values) || values.length > MAX_BINDINGS) throw new Error("channel binding count exceeds its limit");
  const seen = new Set();
  for (const value of values) {
    const conversation = value?.conversation;
    const metadata = value?.metadata;
    const key = conversation?.conversationId;
    if (!keysOnly(value, ["bindingId", "targetSessionKey", "targetKind", "status", "boundAt", "conversation", "metadata"]) ||
        !keysOnly(conversation, ["channel", "accountId", "conversationId", "parentConversationId"]) ||
        !keysOnly(metadata, ["agentId", "label", "boundBy", "threadName", "lastActivityAt", "idleTimeoutMs", "maxAgeMs"]) ||
        value.bindingId !== `${ACCOUNT_ID}:${key}` || conversation.channel !== CHANNEL_ID || conversation.accountId !== ACCOUNT_ID ||
        !/^kova-thread-[a-f0-9-]{36}$/.test(key ?? "") || seen.has(key) || !isKovaTarget(conversation.parentConversationId) ||
        !boundedString(conversation.parentConversationId, 512) || !boundedString(value.targetSessionKey, 512) ||
        !/^agent:[a-z0-9_-]+:subagent:[a-zA-Z0-9_-]+$/.test(value.targetSessionKey) ||
        value.targetKind !== "subagent" || value.status !== "active" || !timestamp(value.boundAt) || !timestamp(metadata.lastActivityAt) ||
        metadata.idleTimeoutMs !== 0 || metadata.maxAgeMs !== 0 ||
        [["agentId", 64], ["label", 500], ["boundBy", 64], ["threadName", 500]].some(([name, max]) => metadata[name] !== undefined && !boundedString(metadata[name], max))) {
      throw new Error("invalid saved channel thread binding");
    }
    seen.add(key);
  }
  return values;
}

function savedMetadata(input, now) {
  const metadata = { lastActivityAt: now, idleTimeoutMs: 0, maxAgeMs: 0 };
  // Presentation text may contain an old workspace path; persist only portable route facts.
  for (const name of ["agentId", "label", "boundBy", "threadName"]) {
    if (input?.[name] !== undefined) metadata[name] = input[name];
  }
  return metadata;
}

async function openBindingFile(stateDir, assertCurrent) {
  if (typeof stateDir !== "string" || !isAbsolute(stateDir)) throw new Error("channel bindings require an absolute state directory");
  const root = await realpath(stateDir);
  const rootIdentity = await lstat(root);
  if (!rootIdentity.isDirectory()) throw new Error("channel state root is not a directory");
  const directory = join(root, CHANNEL_ID);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const directoryIdentity = await lstat(directory);
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) throw new Error("channel binding directory must be a regular task directory");
  const path = probeBindingsFile(root);
  const assertDirectory = async () => {
    assertCurrent();
    for (const [pathname, expected] of [[root, rootIdentity], [directory, directoryIdentity]]) {
      const current = await lstat(pathname);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("channel binding directory changed");
    }
    assertCurrent();
  };
  const inspectFile = async () => {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("channel bindings must be a regular private file");
      return info;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  return {
    async read() {
      await assertDirectory();
      const before = await inspectFile();
      if (!before) return [];
      if (before.size > MAX_BYTES) throw new Error("channel binding file exceeds its read limit");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) throw new Error("channel binding file changed while opening");
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let used = 0;
        while (used < bytes.length) {
          const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
          if (!bytesRead) break;
          used += bytesRead;
        }
        if (used > MAX_BYTES) throw new Error("channel binding file exceeds its read limit");
        const saved = JSON.parse(decoder.decode(bytes.subarray(0, used)));
        if (!keysOnly(saved, ["version", "accountId", "bindings"]) || saved.version !== 1 || saved.accountId !== ACCOUNT_ID) throw new Error("unsupported channel binding file");
        await assertDirectory();
        return validateRecords(saved.bindings);
      } finally { await handle.close(); }
    },
    async write(values, commitGuard = () => {}) {
      validateRecords(values);
      const bytes = `${JSON.stringify({ version: 1, accountId: ACCOUNT_ID, bindings: values })}\n`;
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("channel binding file exceeds its write limit");
      await assertDirectory();
      await inspectFile();
      const temporary = join(directory, `.thread-bindings-${ACCOUNT_ID}-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await assertDirectory();
        await inspectFile();
        commitGuard();
        assertCurrent();
        await rename(temporary, path);
      } finally {
        try { await handle?.close(); }
        finally { await rm(temporary, { force: true }); }
      }
    }
  };
}

export async function openProbeBindings(runtime, signal, bindingApi, routingApi) {
  // Ordinary probe messages remain available on hosts without durable thread support.
  if (typeof runtime?.state?.resolveStateDir !== "function") return null;
  try { bindingApi ??= await import("openclaw/plugin-sdk/thread-bindings-session-runtime"); }
  catch (error) {
    if (["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND"].includes(error.code)) return null;
    throw error;
  }
  const { registerSessionBindingAdapter, unregisterSessionBindingAdapter } = bindingApi;
  if (typeof registerSessionBindingAdapter !== "function" || typeof unregisterSessionBindingAdapter !== "function") return null;
  try { routingApi ??= await import("openclaw/plugin-sdk/conversation-binding-runtime"); }
  catch (error) {
    if (["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND"].includes(error.code)) return null;
    throw error;
  }
  const { resolveRuntimeConversationBindingRouteAsync } = routingApi;
  if (typeof resolveRuntimeConversationBindingRouteAsync !== "function") return null;
  let closed = false;
  let pending = Promise.resolve();
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (closed) throw new Error("channel binding storage is stopped");
  };
  assertCurrent();
  const store = await openBindingFile(runtime.state.resolveStateDir(), assertCurrent);
  const records = new Map((await store.read()).map((record) => [record.conversation.conversationId, record]));
  const mutate = (operation) => {
    const result = pending.then(() => { assertCurrent(); return operation(); });
    pending = result.catch(() => {});
    return result;
  };
  const commit = async (next, guard) => {
    await store.write([...next.values()], guard);
    records.clear();
    for (const [key, value] of next) records.set(key, value);
  };
  const find = (ref) => ref.channel === CHANNEL_ID && ref.accountId === ACCOUNT_ID
    ? records.get(ref.conversationId) ?? null : null;
  const adapter = {
    channel: CHANNEL_ID, accountId: ACCOUNT_ID,
    capabilities: { placements: ["child"], bindSupported: true, unbindSupported: true },
    listBySession: (key) => [...records.values()].filter((record) => record.targetSessionKey === key).map((record) => structuredClone(record)),
    resolveByConversation: (ref) => { const record = find(ref); return record ? structuredClone(record) : null; },
    inspectByConversation: (ref) => { const record = find(ref); return record ? structuredClone(record) : null; },
    bind: (input) => mutate(async () => {
      if (input.conversation.channel !== CHANNEL_ID || input.conversation.accountId !== ACCOUNT_ID || input.placement !== "child" || input.targetKind !== "subagent") throw new Error("unsupported channel thread binding");
      const parent = records.get(input.conversation.conversationId)?.conversation.parentConversationId ?? input.conversation.conversationId;
      if (!isKovaTarget(parent) || !/^agent:[a-z0-9_-]+:subagent:/.test(input.targetSessionKey)) throw new Error("invalid channel thread binding target");
      input.assertCurrent?.();
      const conversationId = `kova-thread-${randomUUID()}`;
      const now = Date.now();
      const record = {
        bindingId: `${ACCOUNT_ID}:${conversationId}`, targetSessionKey: input.targetSessionKey,
        targetKind: "subagent", status: "active", boundAt: now,
        conversation: { channel: CHANNEL_ID, accountId: ACCOUNT_ID, conversationId, parentConversationId: parent },
        metadata: savedMetadata(input.metadata, now)
      };
      await commit(new Map([...records, [conversationId, record]]), input.assertCurrent);
      return structuredClone(record);
    }),
    touchAsync: (bindingId, at = Date.now()) => mutate(async () => {
      const record = [...records.values()].find((value) => value.bindingId === bindingId);
      if (!record) return;
      const next = new Map(records);
      next.set(record.conversation.conversationId, { ...record, metadata: { ...record.metadata, lastActivityAt: at } });
      await commit(next);
    }),
    unbind: (input) => mutate(async () => {
      const selected = [...records.values()].filter((record) => input.targetSessionKey ? record.targetSessionKey === input.targetSessionKey : record.bindingId === input.bindingId);
      const next = new Map(records);
      for (const record of selected) next.delete(record.conversation.conversationId);
      if (selected.length) await commit(next);
      return selected.map((record) => structuredClone(record));
    })
  };
  assertCurrent();
  registerSessionBindingAdapter(adapter);
  return {
    resolveRoute: resolveRuntimeConversationBindingRouteAsync,
    read: async () => { await pending; return store.read(); },
    deliveryTarget: ({ conversationId, parentConversationId }) => {
      if (closed || signal.aborted) return null;
      const record = records.get(conversationId);
      if (!record || record.status !== "active" || (parentConversationId !== undefined && parentConversationId !== record.conversation.parentConversationId)) return null;
      return { to: record.conversation.parentConversationId, threadId: record.conversation.conversationId };
    },
    stop: async () => { closed = true; unregisterSessionBindingAdapter({ channel: CHANNEL_ID, accountId: ACCOUNT_ID, adapter }); await pending; }
  };
}
