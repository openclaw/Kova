import { createRequire } from "node:module";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runOcmJson } from "../openclaw-runtime.mjs";
import { EntryError } from "./common.mjs";
import { sendSessionMessage } from "./session-content.mjs";
import { readStoredSession, requireSessionContentRuntime, sessionKeyShortId } from "./session-store-read.mjs";

const DAY = 86400000;
const MAX_ROWS = 20000;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
export const collectionAgentPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const collectionKinds = ["sessions-organized-mixed", "sessions-thousands-near-cap", "store-stale-sessions-over-cap", "sessions-stale-dashboard", "agents-multiple-with-global-key"];
export const collectionRequiredConfig = { session: { maintenance: { mode: "warn", maxEntries: 5000, pruneAfter: "30d", archiveDashboardAfter: "7d", preserveRecent: false } } };
const archiveReasons = ["manual", "active-session-cap", "age-retention", "stale-dashboard", "restart-recovery"];
const groupName = "Verification notebook";
const forkLabel = "kova-persona-organized-fork";
const parentMarker = "KOVA_ORGANIZED_PARENT";

export const collectionRequests = {
  config: () => ({ method: "config.get", params: {} }),
  create: (agentId, key, label, parentSessionKey) => ({ method: "sessions.create", params: { agentId, key, label, ...(parentSessionKey ? { parentSessionKey } : {}) } }),
  patch: (agentId, key, expectedSessionId, fields) => ({ method: "sessions.patch", params: { agentId, key, expectedSessionId, ...fields } }),
  fork: (agentId, sessionKey, entryId) => ({ method: "sessions.fork", params: { agentId, sessionKey, entryId } }),
  describe: (agentId, key) => ({ method: "sessions.describe", params: { agentId, key } }),
  groups: () => ({ method: "sessions.groups.list", params: {} }),
  resolveShort: (agentId, shortId) => ({ method: "sessions.resolve", params: { agentId, shortId } }),
};

const schemaKey = "agent:research:dashboard:kova-persona-schema";
export const collectionRequestCases = {
  config: [[]],
  create: [["research", schemaKey, "kova-persona-schema"], ["research", "agent:research:kova-persona-many-00000", "kova-persona-many-0"], ["research", `${schemaKey}-child`, "kova-persona-child", schemaKey], ["research", "global", "kova-persona-global"], ["research", "agent:research:global", "kova-persona-qualified-global"]],
  patch: [
    ["research", schemaKey, "stored-session-id", { pinned: true }],
    ["research", schemaKey, "stored-session-id", { snoozedUntil: 2000000000000 }],
    ["research", schemaKey, "stored-session-id", { archived: true }],
    ["research", schemaKey, "stored-session-id", { category: groupName, color: "purple" }],
    ["research", schemaKey, "stored-session-id", { unread: true }],
    ["research", schemaKey, "stored-session-id", { label: forkLabel }],
  ],
  fork: [["research", schemaKey, "persisted-user-entry"]],
  describe: [["research", schemaKey], ["research", "global"]],
  groups: [[]],
  resolveShort: [["research", "12345678"]],
};

function agent(value) {
  if (typeof value !== "string" || !collectionAgentPattern.test(value)) throw new EntryError("a canonical --agent is required", 2);
  return value;
}

export function requireCollectionKind(kind, agentId) {
  requireSessionContentRuntime();
  agent(agentId);
  if (!collectionKinds.includes(kind)) throw new EntryError("unknown session collection", 2);
}

function duration(value, fallback) {
  if (value === undefined) return fallback;
  const raw = String(value).trim().toLowerCase();
  const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw);
  const scales = { ms: 1, s: 1000, m: 60000, h: 3600000, d: DAY };
  let result = 0;
  if (single) result = Number(single[1]) * scales[single[2] ?? "d"];
  else {
    let consumed = 0;
    for (const match of raw.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
      if (match.index !== consumed) throw new Error("unsupported session maintenance duration");
      result += Number(match[1]) * scales[match[2]];
      consumed += match[0].length;
    }
    if (consumed !== raw.length) throw new Error("unsupported session maintenance duration");
  }
  result = Math.round(result);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 3650 * DAY) throw new Error("session maintenance duration exceeds the fixture bound");
  return result;
}

export function collectionPolicy(config) {
  const maintenance = config?.session?.maintenance;
  if (maintenance?.mode !== "warn") throw new Error("session collections require session.maintenance.mode=warn before construction and snapshot checks");
  const maxEntries = maintenance.maxEntries ?? 5000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 5000 || maxEntries > 10000) throw new Error("session collections require maxEntries between 5000 and 10000");
  if (maintenance.preserveRecent !== undefined && maintenance.preserveRecent !== false) throw new Error("session collections require preserveRecent=false");
  const buffer = Math.max(25, Math.ceil(maxEntries * 0.1));
  return {
    maxEntries, buffer, nearCount: maxEntries + Math.floor(buffer / 5), staleCount: 400,
    pruneAfter: duration(maintenance.pruneAfter, 30 * DAY),
    dashboardAfter: duration(maintenance.archiveDashboardAfter, 7 * DAY),
  };
}

async function currentConfig(rpc, state) {
  const snapshot = await rpc(collectionRequests.config());
  if (!snapshot?.config || typeof snapshot.config !== "object" || Array.isArray(snapshot.config)) throw new Error("Gateway configuration is absent");
  if (typeof snapshot.path !== "string" || await realpath(dirname(snapshot.path)) !== await realpath(state)) throw new Error("session collection belongs to a different environment");
  return snapshot.config;
}

async function collectionDatabase(state, agentId) {
  agent(agentId);
  if (typeof state !== "string" || !isAbsolute(state)) throw new Error("an absolute task environment state directory is required");
  let file = await realpath(state);
  if (!(await lstat(file)).isDirectory()) throw new Error("task environment state is not a directory");
  const parts = ["agents", agentId, "agent", "openclaw-agent.sqlite"];
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("session database must be a regular file inside the task environment");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      const stat = await lstat(`${file}${suffix}`);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("session database sidecar must be a regular task environment file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return file;
}

/** Metadata-only reads have row, entry and aggregate byte limits and never open a writable database. */
export async function readCollectionRows(state, agentId) {
  requireSessionContentRuntime();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(await collectionDatabase(state, agentId), { readOnly: true, allowExtension: false });
  let reading = false;
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
    reading = true;
    const table = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'session_nodes'").get();
    const columns = new Set(db.prepare("PRAGMA table_info(session_nodes)").all().map((column) => column.name));
    if (table?.type !== "table" || ["session_key", "current_session_id", "entry_json"].some((name) => !columns.has(name))) throw new Error("unsupported session collection schema");
    const rows = new Map();
    let bytes = 0;
    for (const row of db.prepare(`SELECT session_key, current_session_id,
      length(CAST(entry_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(entry_json AS BLOB)) <= ? THEN entry_json END AS entry_json
      FROM session_nodes ORDER BY session_key LIMIT ?`).iterate(MAX_ENTRY_BYTES, MAX_ROWS + 1)) {
      if (rows.size >= MAX_ROWS) throw new Error("session collection exceeds the row limit");
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 2 || row.bytes > MAX_ENTRY_BYTES || (bytes += row.bytes) > MAX_READ_BYTES) throw new Error("session collection exceeds the metadata byte limit");
      const entry = JSON.parse(row.entry_json);
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.sessionId !== "string" || !entry.sessionId || entry.sessionId !== row.current_session_id) throw new Error("session entry and current identity differ");
      if (row.session_key !== "global" && row.session_key !== "unknown" && !row.session_key.startsWith(`agent:${agentId}:`)) throw new Error("session collection contains a different agent's row");
      rows.set(row.session_key, entry);
    }
    return rows;
  } finally {
    try { if (reading) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

/** Load the selected installed runtime's supported writer, never a source checkout. */
export async function openCollectionFixture(env, state, { resolveRuntime = runOcmJson, loadSdk = (url) => import(url) } = {}) {
  if (typeof env.root !== "string" || !isAbsolute(env.root) || typeof state !== "string" || !isAbsolute(state)) throw new Error("session fixture requires an absolute selected environment root and state directory");
  const selectedRoot = await realpath(env.root);
  const selectedState = await realpath(state);
  const processScope = { OPENCLAW_HOME: selectedRoot, OPENCLAW_STATE_DIR: selectedState, OPENCLAW_CONFIG_PATH: join(selectedState, "openclaw.json") };
  // This CLI owns one environment for its entire lifetime. Keep SDK imports,
  // runtime configuration reads and deferred callbacks in that same scope.
  Object.assign(process.env, processScope);
  process.chdir(selectedRoot);
  const assertProcessScope = () => {
    if (process.cwd() !== selectedRoot || Object.entries(processScope).some(([name, value]) => process.env[name] !== value)) throw new Error("session fixture process environment changed");
  };
  const resolved = await resolveRuntime(["env", "resolve", env.name, "--json", "--", "status"]);
  if (typeof resolved.binaryPath !== "string" || !isAbsolute(resolved.binaryPath)) throw new Error("selected OpenClaw runtime has no absolute binary path");
  const packageRoot = dirname(await realpath(resolved.binaryPath));
  const packagePath = join(packageRoot, "package.json");
  if (JSON.parse(await readFile(packagePath, "utf8")).name !== "openclaw") throw new Error("selected runtime is not the OpenClaw package");
  const require = createRequire(packagePath);
  const sdkPath = await realpath(require.resolve("openclaw/plugin-sdk/session-store-runtime"));
  const within = relative(packageRoot, sdkPath);
  if (within.startsWith("..") || isAbsolute(within)) throw new Error("session SDK is outside the selected OpenClaw runtime");
  assertProcessScope();
  const sdk = await loadSdk(pathToFileURL(sdkPath).href);
  assertProcessScope();
  if (typeof sdk.patchSessionEntry !== "function") throw new Error("selected OpenClaw runtime lacks the supported session fixture writer");
  return async ({ agentId, key, sessionId, fields, maintenanceConfig, nextSessionId }) => {
    if (nextSessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nextSessionId)) throw new Error("invalid historical session generation");
    assertProcessScope();
    if (maintenanceConfig?.mode !== "warn") throw new Error("historical session replacement requires an explicit warning maintenance policy");
    const storePath = await collectionDatabase(state, agentId);
    if (!key.startsWith(`agent:${agentId}:`) || (!key.includes("kova-persona-") && !/^agent:[a-z0-9][a-z0-9_-]*:explicit:model-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key))) throw new Error("historical metadata requires a task-created session key");
    const result = await sdk.patchSessionEntry({
      agentId, sessionKey: key, storePath,
      env: { ...process.env, ...processScope },
      maintenanceConfig,
      replaceEntry: true, skipMaintenance: true, requireWriteSuccess: true,
      update: (entry) => {
        if (entry.sessionId !== sessionId || !entry.label?.startsWith("kova-persona-")) throw new Error("historical session identity changed");
        return { ...entry, ...fields, ...(nextSessionId ? { sessionId: nextSessionId } : {}) };
      },
    });
    if (result?.sessionId !== (nextSessionId ?? sessionId)) throw new Error("historical session replacement failed");
  };
}

const keyFor = (agentId, suffix) => `agent:${agentId}:dashboard:kova-persona-${suffix}`;
const numberedKey = (agentId, prefix, index) => `agent:${agentId}:kova-persona-${prefix}-${String(index).padStart(5, "0")}`;
const oldFields = (old) => ({ updatedAt: old, lastInteractionAt: old, lastActivityAt: old, sessionStartedAt: old });
const active = (entry) => entry.archivedAt === undefined;
const positive = (value) => Number.isFinite(value) && value > 0;
const root = (entry, agentId) => !entry.spawnedBy && (!entry.parentSessionKey || entry.parentSessionKey === `agent:${agentId}:main`);
const protectedHistory = (entry) => entry.modelSelectionLocked === true || entry.delivery?.kind === "external" || ["group", "channel", "thread"].includes(entry.chatType) || Boolean(entry.mainRestartRecovery && !entry.mainRestartRecovery.tombstone);

function row(rows, key) {
  const entry = rows.get(key);
  if (!entry || typeof entry.sessionId !== "string" || !entry.sessionId || !positive(entry.updatedAt)) throw new Error(`saved collection session is absent: ${key}`);
  return entry;
}

function historical(entry, before) {
  return [entry.updatedAt, entry.lastInteractionAt, entry.lastActivityAt, entry.sessionStartedAt].every((value) => positive(value) && value < before);
}

async function create(rpc, agentId, key, label, parentKey) {
  const created = await rpc(collectionRequests.create(agentId, key, label, parentKey));
  if (created?.key !== key || typeof created.sessionId !== "string" || !created.sessionId) throw new Error("session creation returned an unexpected identity");
  const { session } = await rpc(collectionRequests.describe(agentId, key));
  if (session?.key !== key || session.sessionId !== created.sessionId || session.label !== label) throw new Error("created collection session is absent or belongs to different content");
  return created.sessionId;
}

function uniqueLabel(rows, label) {
  const found = [...rows].filter(([, entry]) => entry.label === label);
  if (found.length !== 1) throw new Error(`saved collection label is absent or ambiguous: ${label}`);
  return found[0];
}

function checkNear(rows, agentId, policy) {
  for (let index = 0; index < policy.nearCount; index++) {
    const entry = row(rows, numberedKey(agentId, "many", index));
    if (!active(entry) || entry.pinnedAt !== undefined || entry.label !== `kova-persona-many-${index}`) throw new Error("near-cap collection is missing an ordinary unarchived session");
  }
  const count = [...rows.values()].filter(active).length;
  if (count <= policy.maxEntries - policy.buffer) throw new Error("session collection is below the near-cap boundary");
}

async function collectionContext({ rpc, kind, agentId, state }) {
  requireCollectionKind(kind, agentId);
  // Config writes finish before the Gateway watcher acknowledges the new file.
  // Wait for the required warning policy before the first collection mutation.
  const deadline = Date.now() + 30000;
  let config = await currentConfig(rpc, state);
  while (config.session?.maintenance?.mode !== "warn") {
    if (Date.now() >= deadline) throw new EntryError("Gateway did not acknowledge the collection warning policy", 3);
    await sleep(100);
    config = await currentConfig(rpc, state);
  }
  const policy = collectionPolicy(config);
  const maintenanceConfig = {
    mode: "warn", maxEntries: policy.maxEntries,
    pruneAfterMs: policy.pruneAfter, archiveDashboardAfterMs: policy.dashboardAfter,
    modelRunPruneAfterMs: DAY, preserveRecentMs: null,
    resetArchiveRetentionMs: null, maxDiskBytes: null, highWaterBytes: null,
  };
  return { config, policy, maintenanceConfig };
}

/** One sessions.create operation, repeated for a named collection. */
export async function createCollectionSessions(options) {
  const { rpc, kind, agentId, state, readRows = readCollectionRows } = options;
  const { config, policy } = await collectionContext(options);
  const sessions = [];
  const add = async (key, label, parentKey) => sessions.push(await create(rpc, agentId, key, label, parentKey));
  if (kind === "sessions-thousands-near-cap" || kind === "store-stale-sessions-over-cap") {
    const stale = kind === "store-stale-sessions-over-cap";
    if (stale) checkNear(await readRows(state, agentId), agentId, policy);
    const count = stale ? policy.staleCount : policy.nearCount;
    for (let index = 0; index < count; index++) {
      const prefix = stale ? "stale" : "many";
      await add(numberedKey(agentId, prefix, index), `kova-persona-${prefix}-${index}`);
    }
  } else if (kind === "sessions-stale-dashboard") {
    await add(keyFor(agentId, "stale-dashboard"), "kova-persona-stale-dashboard");
  } else if (kind === "agents-multiple-with-global-key") {
    if (Object.keys(config.agents?.entries ?? {}).length < 2 || config.session?.mainKey === "global") throw new Error("global collection requires multiple configured agents and a non-global main key");
    await add("global", "kova-persona-global");
    await add(`agent:${agentId}:global`, "kova-persona-qualified-global");
  } else {
    const names = ["pinned", "snoozed", "grouped", "unread", "parent", "child", ...archiveReasons.map((reason) => `archive-${reason}`)];
    for (const name of names) await add(keyFor(agentId, `organized-${name}`), `kova-persona-organized-${name}`, name === "child" ? keyFor(agentId, "organized-parent") : undefined);
  }
  return { agentId, sessionIds: sessions };
}

/** One sessions.patch operation on an explicit range of saved stale rows. */
export async function patchStaleCollection(options) {
  const { rpc, agentId, state, start, count, fields, readRows = readCollectionRows } = options;
  if (options.kind !== "store-stale-sessions-over-cap" || !Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || start + count > 400) throw new EntryError("invalid stale collection range", 2);
  if (!fields || Object.keys(fields).length !== 1 || !(fields.pinned === true || fields.archived === true)) throw new EntryError("stale collection patch requires pinned or archived", 2);
  await collectionContext(options);
  const rows = await readRows(state, agentId);
  for (let index = start; index < start + count; index++) {
    const key = numberedKey(agentId, "stale", index), entry = row(rows, key);
    await rpc(collectionRequests.patch(agentId, key, entry.sessionId, fields));
  }
  return { agentId, count };
}

/** One installed-SDK metadata replacement, repeated without other mutations. */
export async function writeCollectionHistory(options) {
  const { kind, agentId, state, writeFixture, readRows = readCollectionRows } = options;
  const { policy, maintenanceConfig } = await collectionContext(options);
  if (typeof writeFixture !== "function") throw new Error("historical content requires the selected runtime's session fixture writer");
  const rows = await readRows(state, agentId);
  const replacements = [];
  if (kind === "store-stale-sessions-over-cap") {
    const old = Date.now() - Math.max(45 * DAY, policy.pruneAfter + DAY);
    for (let index = 0; index < policy.staleCount; index++) replacements.push([numberedKey(agentId, "stale", index), oldFields(old)]);
  } else if (kind === "sessions-stale-dashboard") {
    replacements.push([keyFor(agentId, "stale-dashboard"), oldFields(Date.now() - policy.dashboardAfter - DAY)]);
  } else if (kind === "sessions-organized-mixed") {
    for (const reason of archiveReasons.filter((value) => value !== "manual")) replacements.push([keyFor(agentId, `organized-archive-${reason}`), { archiveReason: reason, archivedBy: undefined }]);
  } else throw new EntryError("this collection has no historical metadata", 2);
  for (const [key, fields] of replacements) {
    await writeFixture({ agentId, key, sessionId: row(rows, key).sessionId, fields, maintenanceConfig });
  }
  return { agentId, count: replacements.length };
}

export async function populateCollectionParent({ rpc, agentId }) {
  agent(agentId);
  const key = keyFor(agentId, "organized-parent");
  await sendSessionMessage(rpc, key, `${parentMarker}: remember this notebook. Reply with KOVA_AGENT_OK.`);
  await sendSessionMessage(rpc, key, "Keep the notebook for the next session. Reply with KOVA_AGENT_OK.");
  return { key };
}

/** Fork once at the last persisted user entry; labeling is a separate patch. */
export async function forkCollectionParent({ rpc, agentId, state, readSession = readStoredSession }) {
  agent(agentId);
  const parentKey = keyFor(agentId, "organized-parent");
  const parent = await readSession(state, parentKey, { maxEvents: 500, maxBytes: 4 * 1024 * 1024 });
  const users = parent.events.filter(({ event }) => event.type === "message" && event.message?.role === "user");
  if (users.length < 2 || typeof users.at(-1).event.id !== "string") throw new Error("organized parent has no second persisted user entry");
  let fork;
  const deadline = Date.now() + 30000;
  for (;;) {
    try { fork = await rpc(collectionRequests.fork(agentId, parentKey, users.at(-1).event.id)); break; }
    catch (error) {
      if (!/has (?:an active run|queued work); retry after it finishes\.$/.test(error.message)) throw error;
      if (Date.now() >= deadline) throw new EntryError("organized parent did not settle before its fork", 3);
      await sleep(100);
    }
  }
  if (typeof fork?.sessionKey !== "string" || !fork.sessionKey.startsWith(`agent:${agentId}:dashboard:`)) throw new Error("session fork returned no same-agent dashboard key");
  const { session } = await rpc(collectionRequests.describe(agentId, fork.sessionKey));
  if (!session?.sessionId) throw new Error("fork has no saved identity");
  return { key: fork.sessionKey, sessionId: session.sessionId };
}

function messageText(event) {
  const content = event?.message?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : "";
}

/** Checks derive every returned key from current saved product state. */
export async function checkSessionCollection({ rpc, kind, agentId, state, readRows = readCollectionRows, readSession = readStoredSession }) {
  requireCollectionKind(kind, agentId);
  const config = await currentConfig(rpc, state);
  const policy = collectionPolicy(config);
  const rows = await readRows(state, agentId);
  if (kind === "sessions-thousands-near-cap" || kind === "store-stale-sessions-over-cap") {
    checkNear(rows, agentId, policy);
    if (kind === "store-stale-sessions-over-cap") {
      for (let index = 0; index < policy.staleCount; index++) {
        const entry = row(rows, numberedKey(agentId, "stale", index));
        if (entry.label !== `kova-persona-stale-${index}` || !historical(entry, Date.now() - policy.pruneAfter)) throw new Error("stale collection is missing historical activity");
        if (index < 5) {
          if (!active(entry) || !positive(entry.pinnedAt) || !root(entry, agentId)) throw new Error("stale collection is missing a pinned session");
        } else if (index < 55) {
          if (!positive(entry.archivedAt) || entry.archiveReason !== "manual" || entry.pinnedAt !== undefined) throw new Error("stale collection is missing a manual archive");
        } else if (!active(entry) || entry.pinnedAt !== undefined || protectedHistory(entry)) throw new Error("stale collection is missing an eligible active session");
      }
      if ([...rows.values()].filter(active).length <= policy.maxEntries) throw new Error("saved collection is not over its active entry cap");
    }
    return { agentId };
  }
  if (kind === "agents-multiple-with-global-key") {
    if (Object.keys(config.agents?.entries ?? {}).length < 2 || !config.agents.entries[agentId] || config.session?.mainKey === "global") throw new Error("global collection requires its owner in a multi-agent configuration with a non-global main key");
    const raw = row(rows, "global"), qualified = row(rows, `agent:${agentId}:global`);
    if (raw.label !== "kova-persona-global" || qualified.label !== "kova-persona-qualified-global" || raw.sessionId === qualified.sessionId || !active(raw) || !active(qualified)) throw new Error("raw and qualified global sessions are absent or not distinct");
    for (const [key, entry] of [["global", raw], [`agent:${agentId}:global`, qualified]]) {
      const { session } = await rpc(collectionRequests.describe(agentId, key));
      if (session?.key !== key || session.sessionId !== entry.sessionId) throw new Error("Gateway global session ownership differs from its stored row");
    }
    return { agentId };
  }
  if (kind === "sessions-stale-dashboard") {
    const key = keyFor(agentId, "stale-dashboard"), entry = row(rows, key);
    if (entry.label !== "kova-persona-stale-dashboard" || !active(entry) || entry.pinnedAt !== undefined || protectedHistory(entry) || !historical(entry, Date.now() - policy.dashboardAfter)) throw new Error("saved dashboard session is not eligible for stale archiving");
    return { key };
  }
  const get = (name) => row(rows, keyFor(agentId, `organized-${name}`));
  const pinned = get("pinned"), snoozed = get("snoozed"), grouped = get("grouped"), unread = get("unread");
  if (!active(pinned) || !positive(pinned.pinnedAt) || pinned.snoozedUntil !== undefined || !root(pinned, agentId)) throw new Error("organized pinned session is absent");
  if (!active(snoozed) || !positive(snoozed.snoozedAt) || !Number.isSafeInteger(snoozed.snoozedUntil) || snoozed.snoozedUntil <= Date.now() || !root(snoozed, agentId)) throw new Error("organized snoozed session is absent or awake");
  if (!active(grouped) || grouped.category !== groupName || grouped.color !== "purple") throw new Error("organized group or color is absent");
  const catalog = await rpc(collectionRequests.groups());
  if (!Array.isArray(catalog?.groups) || catalog.groups.filter((group) => group.name === groupName && Number.isSafeInteger(group.position) && group.position >= 0).length !== 1) throw new Error("organized group is absent from the saved catalog");
  if (!active(unread) || !positive(unread.markedUnreadAt) || unread.markedUnreadAt <= (unread.lastReadAt ?? 0)) throw new Error("organized unread state is absent");
  for (const reason of archiveReasons) {
    const entry = get(`archive-${reason}`);
    if (!positive(entry.archivedAt) || entry.archiveReason !== reason || entry.pinnedAt !== undefined || entry.snoozedUntil !== undefined) throw new Error(`organized archive is absent: ${reason}`);
  }
  const parentKey = keyFor(agentId, "organized-parent"), parent = get("parent"), childKey = keyFor(agentId, "organized-child"), child = get("child");
  if (!active(parent) || !active(child) || child.parentSessionKey !== parentKey || child.parentSessionId !== parent.sessionId || child.forkSource !== undefined || child.pinnedAt !== undefined || child.snoozedUntil !== undefined) throw new Error("organized nested child lineage differs");
  const [forkKey, fork] = uniqueLabel(rows, forkLabel);
  if (!active(fork) || fork.parentSessionKey !== parentKey || fork.forkSource?.sessionKey !== parentKey || fork.forkSource.sessionId !== parent.sessionId || typeof fork.forkSource.entryId !== "string" || !fork.forkSource.entryId || fork.sessionId === parent.sessionId) throw new Error("organized fork ancestry differs");
  const history = await readSession(state, forkKey, { maxEvents: 500, maxBytes: 4 * 1024 * 1024 });
  if (history.sessionId !== fork.sessionId || !history.events.some(({ event }) => event.type === "message" && event.message?.role === "user" && messageText(event).includes(parentMarker))) throw new Error("organized fork has no copied notebook history");
  const shortId = sessionKeyShortId(forkKey);
  const resolved = await rpc(collectionRequests.resolveShort(agentId, shortId));
  if (resolved?.key !== forkKey) throw new Error("organized fork short id resolves to a different session");
  const archivedKey = keyFor(agentId, "organized-archive-manual");
  return { pinnedKey: keyFor(agentId, "organized-pinned"), snoozedKey: keyFor(agentId, "organized-snoozed"), snoozedSessionId: snoozed.sessionId, archivedKey, archivedSessionId: row(rows, archivedKey).sessionId, childKey, forkKey, shortId };
}
