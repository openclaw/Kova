import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { resolveGatewayEndpoint } from "../gateway-endpoint.mjs";
import { abortable, CallError, failure } from "./background.mjs";
import { disposableEnv } from "./helper.mjs";

// Identity admission follows support/persona/profile-content.mjs at c749cc2.
// Only existing profile lookup and the temporary authentication path are used.
export const personaProfileIdentities = Object.freeze({ owner: "owner@persona.invalid", member: "member@persona.invalid" });
const profileMethods = new Set(["sessions.list", "sessions.setInvolvement", "session.suggestions.add"]);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function validateProfileCall(options) {
  const names = ["persona-profile", "gateway-handle", "expect-involved-key", "expect-excluded-key"];
  if (!names.some((name) => options[name] !== undefined)) return;
  if (!Object.hasOwn(personaProfileIdentities, options["persona-profile"]) || !nonempty(options["gateway-handle"])) throw new CallError("profile calls require --persona-profile owner|member and --gateway-handle");
  disposableEnv(options);
  if (!profileMethods.has(options.method)) throw new CallError("--persona-profile is unsupported for this method");
  if (!options.params || typeof options.params !== "object" || Array.isArray(options.params)) throw new CallError("profile parameters must be an object");
  if (options.background || options.wait) throw new CallError("profile calls require a foreground request");
  const included = options["expect-involved-key"], excluded = options["expect-excluded-key"];
  if (included !== undefined || excluded !== undefined) {
    if (!nonempty(included) || !nonempty(excluded) || included === excluded) throw new CallError("involvement assertions require two distinct session keys");
    if (options.method !== "sessions.list" || options.params?.involvingMe !== true) throw new CallError("involvement assertions require sessions.list with involvingMe true");
    if (options.params.offset !== undefined && options.params.offset !== 0) throw new CallError("involvement assertions require the first list page");
  }
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new CallError("profile state must use regular files", 1);
  return info;
}

async function insideStateFile(runtime, path) {
  const state = resolve(runtime.stateDir ?? join(runtime.root, ".openclaw"));
  const canonical = await realpath(state);
  if ((await lstat(state)).isSymbolicLink()) throw new CallError("profile state must not use symbolic links", 1);
  const suffix = relative(state, resolve(path));
  if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) throw new CallError("profile file must be inside the selected environment state", 1);
  if (await realpath(dirname(path)) !== resolve(canonical, relative(state, dirname(path)))) throw new CallError("profile file directory must not use symbolic links", 1);
  return regularFile(path);
}

export async function readSavedPersonaProfiles(runtime) {
  try {
    const path = join(runtime.stateDir ?? join(runtime.root, ".openclaw"), "state", "openclaw.sqlite");
    await insideStateFile(runtime, path);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { await regularFile(`${path}${suffix}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN");
      const query = db.prepare("SELECT p.id, p.merged_into FROM user_profiles p JOIN user_profile_emails e ON e.profile_id = p.id WHERE e.email = ?");
      const owner = query.get(personaProfileIdentities.owner), member = query.get(personaProfileIdentities.member);
      if (!nonempty(owner?.id) || !nonempty(member?.id) || owner.merged_into || member.merged_into || owner.id === member.id) throw new Error();
      return { owner: owner.id, member: member.id };
    } finally { db.close(); }
  } catch { throw new CallError("saved persona profiles are absent or differ", 1); }
}

export function personaGatewayConfig(config, port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new CallError("invalid persona Gateway port", 1);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new CallError("profile configuration must be an object", 1);
  for (const section of [config, config.gateway, config.gateway?.auth, config.gateway?.remote, config.gateway?.controlUi]) {
    if (section && (typeof section !== "object" || Array.isArray(section) || Object.hasOwn(section, "$include"))) throw new CallError("profile configuration requires literal authentication settings", 1);
  }
  if (config.gateway?.roles || (config.gateway?.bind && config.gateway.bind !== "loopback")) throw new CallError("profile calls require a loopback Gateway without named roles", 1);
  const remote = config.gateway?.remote ? { ...config.gateway.remote } : undefined;
  if (remote) { delete remote.token; delete remote.password; }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      ...(remote ? { remote } : {}),
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { ...config.gateway?.controlUi, allowedOrigins: [`http://127.0.0.1:${port}`] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user", requiredHeaders: ["x-forwarded-proto"], allowUsers: Object.values(personaProfileIdentities), allowLoopback: true },
        identityScopes: { [personaProfileIdentities.owner]: ["operator.admin"], [personaProfileIdentities.member]: ["operator.read", "operator.write"] }
      }
    }
  };
}

async function replaceFile(path, bytes, mode) {
  const temporary = `${path}.kova-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function profileBuildId(endpoint, config, headers, signal) {
  let response;
  try {
    const raw = config.gateway?.controlUi?.basePath ?? "";
    if (typeof raw !== "string") throw new Error();
    const base = raw.trim().replace(/\/$/, "");
    const basePath = !base || base === "/" ? "" : base.startsWith("/") ? base : `/${base}`;
    const origin = headers.origin;
    const pathname = `${basePath}/control-ui-config.json`;
    const url = new URL(`${origin}${pathname}`);
    if (basePath.startsWith("//") || url.origin !== origin || url.pathname !== pathname || url.search || url.hash || endpoint.host !== "127.0.0.1") throw new Error();
    response = await fetch(url, { headers: { ...headers, accept: "application/json" }, redirect: "manual", cache: "no-store", signal });
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || response.url !== url.href || type !== "application/json" || (length !== null && (!/^\d+$/.test(length) || Number(length) > 262144)) || !response.body) throw new Error();
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 262144) throw new Error();
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
    if (parsed.basePath !== basePath || !nonempty(parsed.serverBuildId) || parsed.serverBuildId !== parsed.serverBuildId.trim() || parsed.serverBuildId.length > 96) throw new Error();
    return parsed.serverBuildId;
  } catch { throw new CallError("could not read the persona Gateway UI build identity", signal.aborted ? 3 : 1); }
  finally { await response?.body?.cancel().catch(() => {}); }
}

export async function openPersonaProfileClient(runtime, identity, { timeoutMs, signal, config }) {
  const deadline = Date.now() + timeoutMs;
  const activeSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const remaining = () => { activeSignal.throwIfAborted(); return Math.max(1, deadline - Date.now()); };
  const pending = new Map();
  let socket;
  const client = {
    request(method, params, { timeoutMs: requestedMs = remaining() } = {}) {
      if (socket?.readyState !== 1) return Promise.reject(new CallError("persona connection is closed", 1));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new CallError("persona request timeout", 3)); }, Math.min(requestedMs, remaining()));
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: "req", id, method, params }), (error) => {
          if (!error) return;
          clearTimeout(timer); pending.delete(id); reject(new CallError("persona request could not be sent", 1));
        });
      });
    },
    close() {
      const error = activeSignal.aborted ? new CallError("persona request interrupted", 3) : new CallError("persona connection closed", 1);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
      pending.clear(); socket?.terminate(); activeSignal.removeEventListener("abort", cancel);
    }
  };
  const cancel = () => client.close();
  activeSignal.addEventListener("abort", cancel, { once: true });
  try {
    remaining();
    if (!Object.hasOwn(personaProfileIdentities, identity)) throw new Error();
    const require = createRequire(runtime.binaryPath);
    const { WebSocket } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/websocket-runtime")).href);
    const endpoint = resolveGatewayEndpoint(runtime, null, { protocol: "ws" });
    if (endpoint.source !== "ocm-env-metadata" || endpoint.host !== "127.0.0.1") throw new Error();
    const headers = { origin: `http://127.0.0.1:${runtime.gatewayPort}`, "x-forwarded-proto": "http", "x-forwarded-for": identity === "owner" ? "192.0.2.10" : "192.0.2.11", "x-forwarded-user": personaProfileIdentities[identity] };
    const buildId = await profileBuildId(endpoint, config, headers, activeSignal);
    remaining();
    socket = new WebSocket(endpoint.url, { headers });
    const hello = await abortable(new Promise((resolve, reject) => {
      let connecting = false;
      socket.on("error", () => { client.close(); reject(new CallError("persona connection failed", 1)); });
      socket.on("close", () => { client.close(); reject(new CallError("persona connection closed", 1)); });
      socket.on("message", (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { reject(new CallError("persona response is invalid", 1)); return; }
        if (frame.type === "res") {
          const item = pending.get(frame.id);
          if (!item) return;
          clearTimeout(item.timer); pending.delete(frame.id);
          if (frame.ok) item.resolve(frame.payload);
          else item.reject(new CallError("persona Gateway rejected the request", 1));
        } else if (frame.type === "event" && frame.event === "connect.challenge" && !connecting) {
          connecting = true;
          client.request("connect", personaProfileConnectParams(buildId)).then(resolve, reject);
        }
      });
    }), activeSignal, cancel);
    const scopes = hello?.auth?.scopes;
    if (hello?.auth?.method !== "trusted-proxy" || !Array.isArray(scopes) || (identity === "owner" ? !scopes.includes("operator.admin") : !scopes.includes("operator.read") || !scopes.includes("operator.write") || scopes.includes("operator.admin"))) throw new Error();
    return { client };
  } catch (error) {
    client.close();
    throw new CallError("could not connect the saved persona profile", activeSignal.aborted || error.exitCode === 3 ? 3 : 1);
  }
}

export function personaProfileConnectParams(buildId) {
  return { minProtocol: 4, maxProtocol: 4, client: { id: "openclaw-control-ui", version: "kova", buildId, platform: "web", mode: "webchat" }, role: "operator", scopes: [] };
}

async function requireSavedProfile(client, identity, saved, remaining) {
  const { profile } = await client.request("users.self", {}, { timeoutMs: remaining() });
  if (profile?.id !== saved[identity] || profile.mergedInto || !Array.isArray(profile.emails) || !profile.emails.includes(personaProfileIdentities[identity])) throw new CallError("connected persona profile differs from the saved identity", 1);
}

async function observeSessionList(client, params, remaining, expectedKeys, first) {
  const found = new Set();
  let offset = params.offset ?? 0, page = first, count = 0, pages = 0, totalCount;
  for (;;) {
    remaining();
    page ??= await client.request("sessions.list", { ...params, ...(offset ? { offset } : {}) }, { timeoutMs: remaining() });
    if (!Array.isArray(page?.sessions) || typeof page.hasMore !== "boolean" || page.sessions.some((row) => !nonempty(row?.key)) || (page.offset !== undefined && page.offset !== offset)) throw new CallError("involvement assertions require valid session list pages", 1);
    if (page.totalCount !== undefined) {
      if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || (totalCount !== undefined && totalCount !== page.totalCount)) throw new CallError("session list changed during involvement pagination", 1);
      totalCount = page.totalCount;
    }
    for (const row of page.sessions) if (expectedKeys.includes(row.key)) found.add(row.key);
    count += page.sessions.length;
    pages++;
    if (!page.hasMore) {
      if (page.nextOffset != null) throw new CallError("completed session list has a continuation offset", 1);
      return { found, count, pages };
    }
    // Native nextOffset counts the underlying page before owner-first rows;
    // preserve it instead of deriving an offset from returned row count/limit.
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.sessions.length === 0 || (totalCount !== undefined && page.nextOffset >= totalCount)) throw new CallError("session list continuation offset did not advance", 1);
    offset = page.nextOffset;
    page = undefined;
  }
}

/** Called with the original Gateway stopped; startTemporary always joins its child. */
export async function executePausedProfileCall(request, runtime, context, startTemporary, dependencies = {}) {
  const startedAt = Date.now(), options = request.options;
  let original, path, mode, changed = false, mayRestore = true, result;
  // The process owner may retry only after it has confirmed the child stopped.
  // Keep the original bytes in memory; this callback is never serialized.
  const restoreAuthentication = async () => {
    if (!changed) return;
    await replaceFile(path, original, mode);
    changed = false;
    if (result?.output) result.output.authenticationRestored = true;
  };
  const remaining = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= request.expiresAt) throw new CallError("profile call timeout", 3);
    return Math.max(1, request.expiresAt - Date.now());
  };
  const open = dependencies.openProfile ?? openPersonaProfileClient;
  try {
    validateProfileCall(options);
    if (resolveOcmTransport()) throw new CallError("profile calls require execution beside the selected environment", 2);
    remaining();
    const saved = await (dependencies.readSavedProfiles ?? readSavedPersonaProfiles)(runtime);
    path = resolve(runtime.configPath ?? join(runtime.root, ".openclaw", "openclaw.json"));
    const info = await insideStateFile(runtime, path);
    if (info.size > 1048576) throw new CallError("profile configuration exceeds the supported size", 1);
    original = await readFile(path);
    mode = info.mode & 0o777;
    const config = personaGatewayConfig(JSON5.parse(original.toString("utf8")), Number(runtime.gatewayPort));
    remaining();
    await replaceFile(path, `${JSON.stringify(config, null, 2)}\n`, mode);
    changed = true;
    const connect = async (metadata, settings) => {
      const connection = await open(metadata, "owner", { ...settings, timeoutMs: Math.min(settings.timeoutMs, remaining()), signal: context.signal, config });
      try { await requireSavedProfile(connection.client, "owner", saved, remaining); return connection; }
      catch (error) { connection.client.close(); throw error; }
    };
    // Until the callback confirms a joined child, restoration must not race it.
    mayRestore = false;
    const temporary = await startTemporary({ connect, environment(env) { delete env.OPENCLAW_GATEWAY_TOKEN; delete env.OPENCLAW_GATEWAY_PASSWORD; } }, async () => {
      const identity = options["persona-profile"];
      const { client } = await open(runtime, identity, { timeoutMs: remaining(), signal: context.signal, config });
      try {
        await requireSavedProfile(client, identity, saved, remaining);
        let baseline;
        const included = options["expect-involved-key"], excluded = options["expect-excluded-key"];
        if (included) baseline = await observeSessionList(client, { ...options.params, involvingMe: false }, remaining, [included, excluded]);
        const value = await client.request(options.method, options.params, { timeoutMs: remaining() });
        let involvement;
        if (baseline) {
          const filtered = await observeSessionList(client, options.params, remaining, [included, excluded], value);
          if (!baseline.found.has(included) || !baseline.found.has(excluded)) throw new CallError("unfiltered list does not contain both expected session keys", 1);
          if (!filtered.found.has(included) || filtered.found.has(excluded)) throw new CallError("saved profile involvement filter differs from the expected sessions", 1);
          involvement = { involvedKey: included, excludedKey: excluded, baselineCount: baseline.count, filteredCount: filtered.count, baselinePages: baseline.pages, filteredPages: filtered.pages };
        }
        if (options.method === "sessions.setInvolvement" && (value?.ok !== true || value.key !== options.params.key || value.hiddenFromInvolvingMe !== options.params.hidden)) throw new CallError("personal involvement result differs from the requested change", 1);
        if (options.method === "session.suggestions.add" && (!nonempty(value?.suggestion?.id) || value.suggestion.author?.id !== saved[identity] || value.suggestion.sessionKey !== options.params.sessionKey)) throw new CallError("suggestion does not belong to the saved persona profile and session", 1);
        return { output: { method: options.method, result: value ?? null, error: null, elapsedMs: Date.now() - startedAt, personaProfile: { name: identity, id: saved[identity] }, ...(involvement ? { involvement } : {}) }, exitCode: 0 };
      } finally { client.close(); }
    });
    mayRestore = temporary?.cleanupComplete === true;
    if (!mayRestore) throw new CallError("temporary persona Gateway stop was not confirmed", 1);
    if (temporary.error) {
      if (context.signal.aborted) throw new CallError("profile call interrupted", 3);
      if (Date.now() >= request.expiresAt) throw new CallError("profile call timeout", 3);
      throw temporary.error;
    }
    if (!temporary.value?.output || !Number.isInteger(temporary.value.exitCode)) throw new CallError("temporary persona Gateway returned no result", 1);
    result = temporary.value;
  } catch (error) {
    // Do not expose config parser excerpts, runtime import paths or auth values.
    result = failure(options.method, error instanceof CallError ? error : new CallError(context.signal.aborted ? "profile call interrupted" : "persona profile call failed", context.signal.aborted ? 3 : 1), startedAt);
  } finally {
    if (changed && mayRestore) {
      try { await restoreAuthentication(); }
      catch { result = failure(options.method, new CallError("could not restore persona Gateway authentication", 1), startedAt); }
    }
  }
  result.output.authenticationRestored = !changed;
  result.output.elapsedMs = Date.now() - startedAt;
  return { ...result, restart: !changed && mayRestore, ...(changed ? { restoreAuthentication } : {}) };
}
