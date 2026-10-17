import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { resolveGatewayEndpoint } from "../gateway-endpoint.mjs";
import { runOcmJson } from "../openclaw-runtime.mjs";
import { EntryError } from "./common.mjs";
import { sessionRequests, withSessionClient } from "./session-content.mjs";

export const pairedProfileName = "verify-cli";
export const profileTraitIds = ["gateway-multi-user-profiles", "session-shared-readonly", "session-imported-draft"];
export const profileIdentities = Object.freeze({ owner: "owner@persona.invalid", member: "member@persona.invalid" });
const suggestionText = "Rephrase the second paragraph";
const sharedLabel = "kova-shared-notebook";

export const profileRequests = {
  connect: (buildId) => ({ method: "connect", params: { minProtocol: 4, maxProtocol: 4, client: { id: "openclaw-control-ui", version: "kova", buildId, platform: "web", mode: "webchat" }, role: "operator", scopes: [] } }),
  self: () => ({ method: "users.self", params: {} }),
  list: () => ({ method: "users.list", params: {} }),
  config: () => ({ method: "config.get", params: {} }),
  visibility: (key, visibility) => ({ method: "session.visibility.set", params: { sessionKey: key, visibility } }),
  members: (key) => ({ method: "session.members.list", params: { sessionKey: key } }),
  suggest: (key) => ({ method: "session.suggestions.add", params: { sessionKey: key, text: suggestionText } }),
  suggestions: (key) => ({ method: "session.suggestions.list", params: { sessionKey: key } }),
  unchangedLabel: (key) => ({ method: "sessions.patch", params: { key, label: sharedLabel } }),
  deviceList: () => ({ method: "device.pair.list", params: {} }),
};

function safeError(message, error) {
  return new EntryError(message, error?.exitCode === 3 ? 3 : 1);
}

export function profileResponseError(request, response) {
  const error = new EntryError("persona Gateway rejected the request");
  const key = request.params?.sessionKey ?? request.params?.key;
  if (response?.code === "INVALID_REQUEST") {
    if (response.details?.code === "SESSION_PARTICIPATION_REQUIRED") error.participationRequired = true;
    if (typeof key === "string" && response.message === `Session "${key}" was not found.`) error.sessionNotVisible = true;
  }
  return error;
}

/** Read the build identity served by this Gateway at its configured UI mount. */
export async function readProfileBuildId({ gatewayUrl, basePath = "", headers }, fetchImpl = fetch) {
  let response;
  try {
    const gateway = new URL(gatewayUrl);
    if (gateway.protocol !== "ws:" || gateway.hostname !== "127.0.0.1" || gateway.username || gateway.password || gateway.search || gateway.hash) throw new Error();
    const origin = `http://${gateway.host}`;
    if (typeof basePath !== "string") throw new Error();
    const value = basePath.trim();
    const withSlash = !value || value === "/" ? "" : value.startsWith("/") ? value : `/${value}`;
    const normalized = withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
    if (normalized.startsWith("//")) throw new Error();
    const pathname = `${normalized}/control-ui-config.json`;
    const url = new URL(`${origin}${pathname}`);
    if (url.origin !== origin || url.pathname !== pathname || url.search || url.hash || headers?.origin !== origin) throw new Error();
    response = await fetchImpl(url.href, { method: "GET", headers: { ...headers, accept: "application/json" }, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10000) });
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    const limit = 256 * 1024;
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || response.url !== url.href || type !== "application/json" || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new Error();
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.basePath !== normalized || typeof parsed.serverBuildId !== "string" || !parsed.serverBuildId.trim() || parsed.serverBuildId !== parsed.serverBuildId.trim() || parsed.serverBuildId.length > 96) throw new Error();
    return parsed.serverBuildId;
  } catch (error) {
    throw new EntryError("could not read the persona Gateway UI build identity", error?.name === "TimeoutError" || error?.name === "AbortError" ? 3 : 1);
  } finally { await response?.body?.cancel().catch(() => {}); }
}

function statePath(env) { return resolve(env.stateDir ?? join(env.root, ".openclaw")); }

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("persona state must use regular files");
}

async function runtimeRequire(env) {
  try {
    const resolved = runOcmJson(["env", "resolve", env.name ?? env.envName, "--json", "--", "status"]);
    if (!isAbsolute(resolved.binaryPath)) throw new Error();
    return createRequire(resolved.binaryPath);
  } catch { throw new EntryError("could not resolve the environment's OpenClaw runtime"); }
}

async function configAccess(env) {
  const state = statePath(env);
  const path = resolve(env.configPath ?? join(state, "openclaw.json"));
  const inside = relative(state, path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new EntryError("profile configuration must be inside the environment state directory");
  await regularFile(path);
  const require = await runtimeRequire(env);
  const JSON5 = require("json5");
  return {
    path,
    read: async () => JSON5.parse(await readFile(path, "utf8")),
    async write(config) {
      const temporary = `${path}.kova-${randomUUID()}`;
      try {
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    },
  };
}

export function profileGatewayConfig(config, port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid persona Gateway port");
  if (config.gateway?.roles || (config.gateway?.bind && config.gateway.bind !== "loopback")) throw new Error("profile content requires the isolated loopback Gateway without named roles");
  const remote = config.gateway?.remote ? { ...config.gateway.remote } : undefined;
  if (remote) delete remote.token;
  return {
    ...config,
    gateway: {
      ...config.gateway,
      ...(remote ? { remote } : {}),
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { ...config.gateway?.controlUi, allowedOrigins: [`http://127.0.0.1:${port}`] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user", requiredHeaders: ["x-forwarded-proto"], allowUsers: Object.values(profileIdentities), allowLoopback: true },
        identityScopes: { [profileIdentities.owner]: ["operator.admin"], [profileIdentities.member]: ["operator.read", "operator.write"] },
      },
    },
  };
}

/** Call only while the caller's foreground Gateway is stopped. */
export async function enterProfileGatewayMode(env) {
  try {
    const access = await configAccess(env);
    const original = await access.read();
    const saved = Object.fromEntries(["auth", "trustedProxies"].map((key) => [key, { present: Object.hasOwn(original.gateway ?? {}, key), value: original.gateway?.[key] }]));
    const hadControlUi = Object.hasOwn(original.gateway ?? {}, "controlUi");
    const hadOrigins = Object.hasOwn(original.gateway?.controlUi ?? {}, "allowedOrigins");
    const origins = original.gateway?.controlUi?.allowedOrigins;
    const hadRemote = Object.hasOwn(original.gateway ?? {}, "remote");
    const hadRemoteToken = Object.hasOwn(original.gateway?.remote ?? {}, "token");
    const remoteToken = original.gateway?.remote?.token;
    await access.write(profileGatewayConfig(original, Number(env.gatewayPort)));
    let restored = false;
    return async () => {
      if (restored) return;
      try {
        const current = await access.read();
        current.gateway ??= {};
        for (const [key, entry] of Object.entries(saved)) {
          if (entry.present) current.gateway[key] = entry.value;
          else delete current.gateway[key];
        }
        if (hadOrigins) current.gateway.controlUi = { ...current.gateway.controlUi, allowedOrigins: origins };
        else {
          if (current.gateway.controlUi) delete current.gateway.controlUi.allowedOrigins;
          if (!hadControlUi && Object.keys(current.gateway.controlUi ?? {}).length === 0) delete current.gateway.controlUi;
        }
        if (hadRemoteToken) current.gateway.remote = { ...current.gateway.remote, token: remoteToken };
        else {
          if (current.gateway.remote) delete current.gateway.remote.token;
          if (!hadRemote && Object.keys(current.gateway.remote ?? {}).length === 0) delete current.gateway.remote;
        }
        await access.write(current);
        restored = true;
      } catch { throw new EntryError("could not restore the persona Gateway authentication configuration"); }
    };
  } catch { throw new EntryError("could not configure persona identity admission"); }
}

/** Uses the installed product transport and the Gateway's ordinary verified-identity admission. */
export async function openProfileClient(env, identity = "owner") {
  if (!Object.hasOwn(profileIdentities, identity)) throw new EntryError("unknown persona identity", 2);
  let socket;
  const pending = new Map();
  const failPending = (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const client = {
    hello: undefined,
    request(method, params, { timeoutMs = 150000 } = {}) {
      if (!socket || socket.readyState !== 1) return Promise.reject(new EntryError("persona identity connection is closed"));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new EntryError("persona identity request timed out", 3)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, request: { method, params } });
        socket.send(JSON.stringify({ type: "req", id, method, params }), (error) => {
          if (!error) return;
          clearTimeout(timer); pending.delete(id); reject(new EntryError("persona identity request could not be sent"));
        });
      });
    },
    close() { failPending(new EntryError("persona identity connection closed")); socket?.terminate(); },
  };
  try {
    const require = await runtimeRequire(env);
    const { WebSocket } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/websocket-runtime")).href);
    const endpoint = resolveGatewayEndpoint(env, null, { protocol: "ws" });
    if (endpoint.host !== "127.0.0.1") throw new Error();
    const origin = `http://127.0.0.1:${Number(env.gatewayPort)}`;
    const headers = { origin, "x-forwarded-proto": "http", "x-forwarded-for": identity === "owner" ? "192.0.2.10" : "192.0.2.11", "x-forwarded-user": profileIdentities[identity] };
    const config = await (await configAccess(env)).read();
    const buildId = await readProfileBuildId({ gatewayUrl: endpoint.url, basePath: config.gateway?.controlUi?.basePath, headers });
    socket = new WebSocket(endpoint.url, { headers });
    await new Promise((resolve, reject) => {
      let connecting = false;
      const timer = setTimeout(() => reject(new EntryError("persona identity connection timed out", 3)), 20000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      socket.on("error", () => { const error = new EntryError("persona identity connection failed"); failPending(error); finish(error); });
      socket.on("close", () => { const error = new EntryError("persona identity connection closed"); failPending(error); finish(error); });
      socket.on("message", (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { finish(new EntryError("persona Gateway sent an invalid response")); return; }
        if (frame.type === "res") {
          const item = pending.get(frame.id);
          if (!item) return;
          clearTimeout(item.timer); pending.delete(frame.id);
          if (frame.ok) item.resolve(frame.payload);
          else item.reject(profileResponseError(item.request, frame.error));
        } else if (frame.type === "event" && frame.event === "connect.challenge" && !connecting) {
          connecting = true;
          const request = profileRequests.connect(buildId);
          client.request(request.method, request.params, { timeoutMs: 15000 }).then((hello) => { client.hello = hello; finish(); }, finish);
        }
      });
    });
    const scopes = client.hello?.auth?.scopes;
    if (client.hello?.auth?.method !== "trusted-proxy" || !Array.isArray(scopes) || (identity === "owner" ? !scopes.includes("operator.admin") : !scopes.includes("operator.read") || !scopes.includes("operator.write") || scopes.includes("operator.admin"))) throw new EntryError("persona identity has unexpected operator authority");
    return { client };
  } catch (error) { client.close(); throw safeError("could not connect the persona identity", error); }
}

export async function readSavedHumanProfiles(env) {
  try {
    const path = join(statePath(env), "state", "openclaw.sqlite");
    await regularFile(path);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
      const read = db.prepare("SELECT p.id, p.merged_into FROM user_profiles p JOIN user_profile_emails e ON e.profile_id = p.id WHERE e.email = ?");
      const owner = read.get(profileIdentities.owner), member = read.get(profileIdentities.member);
      if (!owner?.id || !member?.id || owner.merged_into || member.merged_into || owner.id === member.id) throw new Error();
      return { ownerProfileId: owner.id, memberProfileId: member.id };
    } finally { db.close(); }
  } catch { throw new EntryError("saved persona identities are absent or differ"); }
}

export async function withProfileClients(env, operation, { existingOnly = false } = {}) {
  const saved = existingOnly ? await readSavedHumanProfiles(env) : undefined;
  const owner = await openProfileClient(env, "owner");
  let member;
  try {
    member = await openProfileClient(env, "member");
    const first = (request) => owner.client.request(request.method, request.params);
    const second = (request) => member.client.request(request.method, request.params);
    if (saved) {
      const current = await checkHumanProfiles(first, second);
      if (current.ownerProfileId !== saved.ownerProfileId || current.memberProfileId !== saved.memberProfileId) throw new Error("saved persona identities changed during connection");
    }
    return await operation(first, second);
  } finally { member?.client.close(); owner.client.close(); }
}

export async function withProfileClient(env, identity, operation) {
  if (!Object.hasOwn(profileIdentities, identity)) throw new EntryError("unknown persona identity", 2);
  const saved = await readSavedHumanProfiles(env);
  const handle = await openProfileClient(env, identity);
  try {
    const rpc = (request) => handle.client.request(request.method, request.params);
    const current = await readHumanProfile(rpc, identity);
    if (current.profileId !== saved[`${identity}ProfileId`]) throw new EntryError("saved persona identity changed during connection");
    return await operation(rpc, current);
  } catch (error) { throw safeError("persona identity operation failed", error); }
  finally { handle.client.close(); }
}

export async function readHumanProfile(rpc, identity) {
  if (!Object.hasOwn(profileIdentities, identity)) throw new EntryError("unknown persona identity", 2);
  try {
    const { profile } = await rpc(profileRequests.self());
    if (typeof profile?.id !== "string" || !profile.id || profile.mergedInto || !profile.emails?.includes(profileIdentities[identity])) throw new Error();
    return { profileId: profile.id };
  } catch (error) { throw safeError("saved persona identity is absent or differs", error); }
}

export async function checkHumanProfiles(owner, member) {
  const [first, second, inventory] = await Promise.all([owner(profileRequests.self()), member(profileRequests.self()), owner(profileRequests.list())]);
  const valid = (profile, identity) => typeof profile?.id === "string" && profile.id && !profile.mergedInto && profile.emails?.includes(profileIdentities[identity]);
  if (!valid(first?.profile, "owner") || !valid(second?.profile, "member") || first.profile.id === second.profile.id || !Array.isArray(inventory?.profiles) || ![first.profile.id, second.profile.id].every((id) => inventory.profiles.some((profile) => profile.id === id && !profile.mergedInto))) throw new Error("saved persona profiles are missing or differ");
  return { ownerProfileId: first.profile.id, memberProfileId: second.profile.id };
}

export function pairedProfileEnvironment(env, state = statePath(env)) {
  const home = join(state, "profiles");
  const directory = join(home, `.openclaw-${pairedProfileName}`);
  return { OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: join(directory, "openclaw.json"), OPENCLAW_PROFILE: pairedProfileName };
}

export async function setSharedVisibility(owner, key, visibility) {
  if (!["suggest", "read-only"].includes(visibility)) throw new EntryError("invalid shared session visibility", 2);
  try { return await owner(profileRequests.visibility(key, visibility)); }
  catch (error) { throw safeError("could not set the shared persona session visibility", error); }
}

export async function addSharedSuggestion(member, key) {
  try {
    const added = await member(profileRequests.suggest(key));
    if (typeof added?.suggestion?.id !== "string" || !added.suggestion.id) throw new Error();
    return { suggestionId: added.suggestion.id };
  } catch (error) { throw safeError("could not add the shared persona session suggestion", error); }
}

export async function checkReadonlySession({ owner, member, key, memberProfileId, suggestionId }) {
  const identities = await checkHumanProfiles(owner, member);
  if (memberProfileId && identities.memberProfileId !== memberProfileId) throw new Error("shared session recipient differs from the saved profile");
  const [{ session }, members, suggestions, history] = await Promise.all([owner(sessionRequests.describe(key)), owner(profileRequests.members(key)), member(profileRequests.suggestions(key)), member(sessionRequests.history(key))]);
  if (session?.key !== key || !session.sessionId || session.visibility !== "read-only" || session.label !== sharedLabel) throw new Error("saved read-only session is absent or differs");
  if (members?.sessionKey !== key || !Array.isArray(members.members)) throw new Error("shared session membership is unavailable");
  if (members.members.some((entry) => entry.identityId === identities.memberProfileId) || suggestions?.role !== "viewer") throw new Error("shared session recipient has write access");
  const saved = suggestions?.suggestions?.filter((entry) => entry.state === "pending" && entry.author?.id === identities.memberProfileId && entry.text === suggestionText);
  if (saved?.length !== 1 || typeof saved[0].id !== "string" || !saved[0].id || (suggestionId && saved[0].id !== suggestionId)) throw new Error("saved pending suggestion is absent or differs");
  if (!Array.isArray(history?.messages) || !history.messages.some((message) => message.role === "user") || !history.messages.some((message) => message.role === "assistant")) throw new Error("shared session history is not readable");
  let denied = false;
  try { await member(profileRequests.unchangedLabel(key)); } catch (error) { if (!error.participationRequired) throw error; denied = true; }
  if (!denied) throw new Error("read-only recipient could modify the session");
  return { key, sessionId: session.sessionId, suggestionId: saved[0].id, memberIdentityId: identities.memberProfileId };
}

async function pairedIdentity(state) {
  const path = join(state, "state", "openclaw.sqlite");
  await regularFile(path);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    const row = db.prepare("SELECT device_id FROM device_identities WHERE identity_key = 'primary'").get();
    if (typeof row?.device_id !== "string" || !row.device_id) throw new Error();
    const grants = db.prepare("SELECT scopes_json FROM gateway_origin_device_tokens WHERE device_id = ? AND role = 'operator' AND length(token) > 0 LIMIT 100").all(row.device_id);
    if (!grants.some((grant) => { const scopes = JSON.parse(grant.scopes_json); return Array.isArray(scopes) && scopes.includes("operator.read") && scopes.includes("operator.pairing"); })) throw new Error();
    return row.device_id;
  } finally { db.close(); }
}

export function hasApprovedProfileDevice(inventory, deviceId) {
  const paired = inventory?.paired?.find((entry) => entry.deviceId === deviceId);
  return Boolean(paired?.roles?.includes("operator") && paired.tokens?.some((entry) => entry.role === "operator" && !entry.revokedAtMs && entry.scopes?.includes("operator.read") && entry.scopes.includes("operator.pairing")));
}

async function runPairedClient(env, state, mode, options = {}) {
  let input;
  try {
    const require = await runtimeRequire(env);
    const profileEnvironment = pairedProfileEnvironment(env, state);
    const profileState = profileEnvironment.OPENCLAW_STATE_DIR;
    const previous = mode === "build" ? undefined : await pairedIdentity(profileState);
    if (mode === "rebind") {
      const inventory = await withSessionClient(env, (rpc) => rpc(profileRequests.deviceList()), { authFromRuntimeConfig: options.authFromRuntimeConfig });
      if (!hasApprovedProfileDevice(inventory, previous)) throw new Error();
    }
    const access = await configAccess(env);
    const config = await access.read();
    const token = mode === "check" ? undefined : config.gateway?.auth?.token;
    if (mode !== "check" && ((config.gateway?.auth?.mode ?? "token") !== "token" || typeof token !== "string" || !token)) throw new Error();
    const endpoint = resolveGatewayEndpoint(env, null, { protocol: "ws" });
    const binary = runOcmJson(["env", "resolve", env.name ?? env.envName, "--json", "--", "status"]).binaryPath;
    input = { sdk: require.resolve("openclaw/plugin-sdk/gateway-runtime"), binary, environment: profileEnvironment, state: profileState, url: endpoint.url.replace(/\/$/, ""), token, mode, previous };
  } catch (error) { throw safeError("could not prepare the saved CLI profile", error); }
  const childEnv = { ...process.env, ...options.env, KOVA_PERSONA_PAIR_INPUT: JSON.stringify(input) };
  for (const name of ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_URL", "NODE_OPTIONS"]) delete childEnv[name];
  const owned = spawnOwnedProcess(process.execPath, [fileURLToPath(import.meta.url), "--paired-client"], { env: childEnv });
  let output = "", exceeded = false, timedOut = false, stopping;
  const stop = () => { stopping ??= owned.stop(); void stopping.catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 60000);
  owned.child.stdout.on("data", (chunk) => { if (output.length + chunk.length > 4096) { exceeded = true; stop(); } else output += chunk.toString(); });
  owned.child.stderr.resume();
  try {
    const completed = await owned.closed;
    let result;
    try { result = JSON.parse(output); } catch {}
    if (timedOut || completed.status === 3) throw new EntryError("CLI profile connection timed out", 3);
    if (completed.error || completed.status !== 0 || exceeded || result?.profile !== pairedProfileName || Object.keys(result).length !== 1) throw new EntryError("saved CLI profile could not authenticate");
    return { profile: pairedProfileName };
  } finally {
    clearTimeout(timer);
    try { await (stopping ?? owned.stop()); } catch { throw new EntryError("CLI profile process cleanup failed"); }
  }
}

export const buildPairedProfile = (env, state = statePath(env)) => runPairedClient(env, state, "build");
export const rebindPairedProfile = (env, state = statePath(env), options = {}) => runPairedClient(env, state, "rebind", options);
export const checkPairedProfile = (env, state = statePath(env)) => runPairedClient(env, state, "check");

async function writeProfileRemoteConfig(path, url) {
  await writeFile(path, `${JSON.stringify({ gateway: { mode: "remote", remote: { url, transport: "direct" } } })}\n`, { mode: 0o600 });
}

export async function writePairedProfileConfig(env, state = statePath(env)) {
  if (!isAbsolute(state)) throw new EntryError("an absolute paired profile state directory is required", 2);
  try {
    const profile = pairedProfileEnvironment(env, state);
    await pairedIdentity(profile.OPENCLAW_STATE_DIR);
    const endpoint = resolveGatewayEndpoint(env, null, { protocol: "ws" });
    await writeProfileRemoteConfig(profile.OPENCLAW_CONFIG_PATH, endpoint.url.replace(/\/$/, ""));
    return { profile: pairedProfileName };
  } catch (error) { throw safeError("could not configure the paired CLI profile", error); }
}

async function pairedClientProcess() {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write = () => true;
  let client;
  try {
    const source = process.env.KOVA_PERSONA_PAIR_INPUT;
    delete process.env.KOVA_PERSONA_PAIR_INPUT;
    if (!source || source.length > 65536) throw new Error();
    const input = JSON.parse(source);
    if (!["build", "rebind", "check"].includes(input.mode) || !isAbsolute(input.state)) throw new Error();
    Object.assign(process.env, input.environment);
    delete process.env.OPENCLAW_GATEWAY_PORT;
    if (input.mode === "build") await mkdir(input.state, { recursive: true, mode: 0o700 });
    const { GatewayClient } = await import(pathToFileURL(input.sdk).href);
    const connect = (token, readOnly) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new EntryError("CLI profile connection timed out", 3)), 18000);
      client = new GatewayClient({ url: input.url, deviceAuthScope: input.url, token, clientName: "cli", clientDisplayName: "Kova CLI profile", clientVersion: "kova", mode: "cli", scopes: ["operator.read", "operator.pairing"], ...(readOnly ? { sharedStateMode: "read-only" } : {}), onHelloOk: (hello) => { clearTimeout(timeout); resolve(hello); }, onConnectError: (error) => { clearTimeout(timeout); reject(new EntryError("CLI profile connection failed", /timeout|timed out/i.test(error?.message ?? "") ? 3 : 1)); } });
      client.start();
    });
    if (input.mode !== "check") { await connect(input.token, false); await client.stopAndWait(); }
    const hello = await connect(undefined, true);
    if (hello.auth?.method !== "device-token" || !hello.auth.scopes.includes("operator.read") || !hello.auth.scopes.includes("operator.pairing")) throw new Error();
    const id = await pairedIdentity(input.state);
    if (input.previous && id !== input.previous) throw new Error();
    const request = profileRequests.deviceList();
    const list = await client.request(request.method, request.params);
    if (!hasApprovedProfileDevice(list, id)) throw new Error();
    await client.stopAndWait();
    if (input.mode === "rebind") await writeProfileRemoteConfig(process.env.OPENCLAW_CONFIG_PATH, input.url);
    if (input.mode !== "build") {
      const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
      if (config.gateway?.remote?.url !== input.url) throw new Error();
      const inventory = await new Promise((resolve, reject) => {
        execFile(process.execPath, [input.binary, "--profile", pairedProfileName, "devices", "list", "--json"], { env: process.env, timeout: 15000, maxBuffer: 1048576, encoding: "utf8" }, (error, stdout) => {
          if (error) { reject(new EntryError("CLI profile read failed", error.killed ? 3 : 1)); return; }
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error()); }
        });
      });
      if (!hasApprovedProfileDevice(inventory, id)) throw new Error();
    }
    await new Promise((resolve) => write(`${JSON.stringify({ profile: pairedProfileName })}\n`, resolve));
    process.exit(0);
  } catch (error) {
    try { await client?.stopAndWait({ timeoutMs: 1000 }); } catch {}
    process.exit(error?.exitCode === 3 ? 3 : 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--paired-client") await pairedClientProcess();
