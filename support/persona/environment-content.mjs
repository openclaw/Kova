import { access, mkdir, readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { productJson, productCommand, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";

export const catalogThread = "64beb580-5daa-42c2-8188-e33be08c5537";
export const catalogWord = "KOVACATALOGNOTEBOOK";
export const catalogLocator = { catalogId: "claude", hostId: "gateway:local", threadId: catalogThread, agentId: "main" };
export const environmentRequests = {
  catalogList: () => ({ method: "sessions.catalog.list", params: { catalogId: "claude", agentId: "main", hostIds: ["gateway:local"], limitPerHost: 20 } }),
  catalogRead: () => ({ method: "sessions.catalog.read", params: { ...catalogLocator, limit: 50 } }),
  catalogImport: () => ({ method: "sessions.catalog.import", params: { ...catalogLocator, displayName: "Imported verification notebook" } }),
  describe: (key) => ({ method: "sessions.describe", params: { key, agentId: "main" } }),
  history: (key) => ({ method: "chat.history", params: { sessionKey: key, limit: 20 } }),
  self: () => ({ method: "users.self", params: {} }),
  cronAdd: () => ({ method: "cron.add", params: {
    name: "kova-persona-isolated", agentId: "main", enabled: true,
    schedule: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" },
    sessionTarget: "isolated", wakeMode: "now",
    payload: { kind: "agentTurn", message: "Reply with KOVA_AGENT_OK.", thinking: "off", timeoutSeconds: 120 },
    delivery: { mode: "announce", channel: "kova-channel-probe", to: "dm:kova-probe-user-persona-cron" },
  } }),
  cronList: () => ({ method: "cron.list", params: { includeDisabled: true, limit: 100, query: "kova-persona-isolated" } }),
};
export const environmentRequestCases = {
  catalogList: [[]], catalogRead: [[]], catalogImport: [[]], describe: [["agent:main:persona-import"]],
  history: [["agent:main:persona-import"]], self: [[]], cronAdd: [[]], cronList: [[]],
};

async function directory(state, ...parts) {
  const root = await realpath(state);
  let path = root;
  for (const part of ["kova-persona", ...parts]) {
    path = join(path, part);
    await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    if ((await lstat(path)).isSymbolicLink() || !(await lstat(path)).isDirectory()) throw new Error("persona content must stay in a regular environment directory");
    const local = relative(root, await realpath(path));
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("persona content escaped the environment");
  }
  return path;
}

export async function savedContent(state, name, value) {
  const path = join(await directory(state), name);
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error("invalid saved content name");
  if (value !== undefined) await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  return JSON.parse(await readFile(path, "utf8"));
}

export async function prepareCatalog({ state }) {
  const target = await directory(state, "claude", "projects", "persona-notebook");
  const fixture = fileURLToPath(new URL(`../../personas/openclaw/fixtures/claude-catalog/${catalogThread}.jsonl`, import.meta.url));
  const rows = (await readFile(fixture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  await writeFile(join(target, `${catalogThread}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  return {};
}

export async function personaGatewayEnvironment(metadata) {
  const path = join(metadata.stateDir ?? join(metadata.root, ".openclaw"), "kova-persona", "claude");
  try { await access(path); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  if ((await lstat(path)).isSymbolicLink() || !(await lstat(path)).isDirectory()) throw new Error("persona catalog directory is invalid");
  return { CLAUDE_CONFIG_DIR: path };
}

export async function checkCatalog(rpc) {
  const listed = await rpc(environmentRequests.catalogList());
  const catalog = listed.catalogs?.find((value) => value.id === "claude");
  const host = catalog?.hosts?.find((value) => value.hostId === "gateway:local");
  if (catalog?.error || host?.error || host?.pending || !host?.sessions?.some((row) => row.threadId === catalogThread)) throw new Error("saved local Claude catalog thread is absent");
  const content = await rpc(environmentRequests.catalogRead());
  if (content.threadId !== catalogThread || content.nextCursor || content.items?.length !== 2 || content.items.some((item) => item.truncated) || !content.items.some((item) => item.text?.includes(catalogWord))) throw new Error("catalog content is incomplete");
  return { catalogId: "claude", hostId: "gateway:local", threadId: catalogThread, searchWord: catalogWord };
}

export async function importDraft({ env, state }) {
  const { openProfileClient } = await import("./profile-content.mjs");
  const handle = await openProfileClient(env, "owner");
  try {
    const rpc = ({ method, params }) => handle.client.request(method, params);
    const result = await rpc(environmentRequests.catalogImport());
    if (!result.created || !result.complete || result.importedItems !== 2 || typeof result.sessionKey !== "string") throw new Error("catalog import did not create the complete notebook");
    await savedContent(state, "imported-draft.json", { key: result.sessionKey });
    return { key: result.sessionKey };
  } finally { handle.client.close(); }
}

export async function checkDraft({ env, state }) {
  const { openProfileClient } = await import("./profile-content.mjs");
  const { key } = await savedContent(state, "imported-draft.json");
  const owner = await openProfileClient(env, "owner");
  try {
    const { session } = await owner.client.request("sessions.describe", environmentRequests.describe(key).params);
    const self = await owner.client.request("users.self", {});
    if (session?.visibility !== "draft" || session.createdActor?.id !== self.profile?.id || session.createdActor?.type !== "human") throw new Error("imported draft has lost its creator or visibility");
    const history = await owner.client.request("chat.history", environmentRequests.history(key).params);
    if (!JSON.stringify(history.messages).includes(catalogWord)) throw new Error("imported draft history is absent");
  } finally { owner.client.close(); }
  const viewer = await openProfileClient(env, "member");
  try {
    try {
      await viewer.client.request("chat.history", environmentRequests.history(key).params);
    } catch (error) {
      if (error.exitCode === 3) throw error;
      if (error.sessionNotVisible !== true) throw error;
      return { key };
    }
    throw new Error("imported draft was readable by another operator");
  } finally { viewer.client.close(); }
}

export async function addCron({ env }) {
  return withSessionClient(env, async (rpc) => {
    const result = await rpc(environmentRequests.cronAdd());
    if (typeof result.id !== "string" || !result.id) throw new Error("cron creation returned no job id");
    return { jobId: result.id };
  });
}

export async function checkCron(rpc) {
  const result = await rpc(environmentRequests.cronList());
  const jobs = result.jobs?.filter((job) => job.name === "kova-persona-isolated");
  if (jobs?.length !== 1) throw new Error("isolated cron job is absent or duplicated");
  const [job] = jobs;
  if (!job.enabled || job.sessionTarget !== "isolated" || job.payload?.kind !== "agentTurn" || job.delivery?.mode !== "announce" || job.delivery?.channel !== "kova-channel-probe") throw new Error("isolated cron content differs");
  return { jobId: job.id };
}

export async function configureHeartbeat({ args, workspace }) {
  await productCommand(args.env, ["config", "set", "agents.defaults.heartbeat.every", "1m"]);
  await writeFile(join(workspace, "HEARTBEAT.md"), "# Notebook heartbeat\n\nCheck the notebook scratch and reply HEARTBEAT_OK.\n", { mode: 0o600 });
  return {};
}

export async function checkHeartbeat({ args, workspace }) {
  const every = await productJson(args.env, ["config", "get", "agents.defaults.heartbeat.every", "--json"]);
  if (every !== "1m" || !(await readFile(join(workspace, "HEARTBEAT.md"), "utf8")).includes("HEARTBEAT_OK")) throw new Error("short heartbeat content is absent");
  return {};
}

export const linkedPeer = "kova-probe-user-linked";
export async function configureDm({ args }) {
  await productCommand(args.env, ["config", "set", "session.dmScope", "per-channel-peer"]);
  await productCommand(args.env, ["config", "set", "session.identityLinks", JSON.stringify({ "persona-peer": [`kova-channel-probe:${linkedPeer}`] }), "--strict-json"]);
  return {};
}
export async function checkDm({ args }) {
  const scope = await productJson(args.env, ["config", "get", "session.dmScope", "--json"]);
  const links = await productJson(args.env, ["config", "get", "session.identityLinks", "--json"]);
  if (scope !== "per-channel-peer" || !links["persona-peer"]?.includes(`kova-channel-probe:${linkedPeer}`)) throw new Error("isolated linked DM peer is absent");
  return { peerId: linkedPeer };
}

export async function writeLocale({ state }) { await savedContent(state, "ui-preference.json", { locale: "ar" }); return {}; }
export async function checkLocale({ state }) {
  const value = await savedContent(state, "ui-preference.json");
  if (value.locale !== "ar") throw new EntryError("saved right-to-left locale is absent");
  return { locale: value.locale };
}
