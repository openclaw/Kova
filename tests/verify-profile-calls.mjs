import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { atomicJson, CallError } from "../support/verify/background.mjs";
import { executeGatewayCall, parseGatewayCallArgs } from "../support/verify/gateway-call.mjs";
import { executePausedProfileCall, personaGatewayConfig, personaProfileIdentities, readSavedPersonaProfiles } from "../support/verify/gateway-profile.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const env = "kova-run-profile-fixture";
const key = "agent:main:involved", excluded = "agent:main:excluded";
const ids = { owner: "profile-owner", member: "profile-member" };
const original = Buffer.from("// Preserve the exact configuration.\n{gateway:{bind:'loopback',auth:{mode:'token',token:'synthetic-local-token'},remote:{token:'synthetic-remote-token'},controlUi:{basePath:'/ui'}},unrelated:42}\n");
const listParams = { agentId: "main", archived: "all", involvingMe: true, configuredAgentsOnly: true, limit: 200 };
const flags = (method, params, identity = "owner") => ["--env", env, "--method", method, "--params", JSON.stringify(params), "--persona-profile", identity, "--gateway-handle", "gateway.json", "--timeout", "240000"];
const listOptions = () => parseGatewayCallArgs([...flags("sessions.list", listParams), "--expect-involved-key", key, "--expect-excluded-key", excluded]);

async function fixture(t, { profiles = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kova-profile-calls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".openclaw", "state"), { recursive: true });
  const configPath = join(root, ".openclaw", "openclaw.json");
  await writeFile(configPath, original);
  await chmod(configPath, 0o640);
  if (profiles) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, ".openclaw", "state", "openclaw.sqlite"));
    try {
      db.exec("CREATE TABLE user_profiles (id TEXT PRIMARY KEY, merged_into TEXT); CREATE TABLE user_profile_emails (email TEXT PRIMARY KEY, profile_id TEXT);");
      for (const identity of ["owner", "member"]) {
        db.prepare("INSERT INTO user_profiles (id) VALUES (?)").run(ids[identity]);
        db.prepare("INSERT INTO user_profile_emails (email, profile_id) VALUES (?, ?)").run(personaProfileIdentities[identity], ids[identity]);
      }
    } finally { db.close(); }
  }
  return { root, configPath, gatewayPort: 18789, binaryPath: join(root, "openclaw.mjs") };
}

async function transaction(t, options = listOptions(), settings = {}) {
  const runtime = await fixture(t, settings);
  const controller = new AbortController(), calls = [], connections = [];
  let running = false, starts = 0;
  const readConfig = async () => JSON5.parse(await readFile(runtime.configPath, "utf8"));
  const openProfile = async (_runtime, identity) => {
    assert.equal(running, true);
    assert.equal((await readConfig()).gateway.auth.mode, "trusted-proxy");
    const connection = { identity, closed: false };
    connections.push(connection);
    return { client: {
      close() { connection.closed = true; },
      async request(method, params) {
        schemas.check(method, params);
        calls.push({ identity, method, params: structuredClone(params) });
        if (method === "users.self") return { profile: { id: settings.wrongIdentity ? "different-profile" : ids[identity], emails: [personaProfileIdentities[identity]] } };
        if (settings.request) return settings.request(method, params, identity, controller);
        if (method === "sessions.list") return { sessions: (params.involvingMe ? [key] : [key, excluded]).map((key) => ({ key })), hasMore: false, nextOffset: null };
        if (method === "sessions.setInvolvement") return { ok: true, key: params.key, hiddenFromInvolvingMe: params.hidden };
        if (method === "session.suggestions.add") return { suggestion: { id: "suggestion-new", sessionKey: params.sessionKey, author: { id: ids[identity] } } };
        throw new Error("unexpected request");
      }
    } };
  };
  const startTemporary = async (overrides, onReady) => {
    starts++;
    const environment = { OPENCLAW_GATEWAY_TOKEN: "synthetic-inherited-token", OPENCLAW_GATEWAY_PASSWORD: "synthetic-inherited-password", KEEP: "yes" };
    overrides.environment(environment);
    assert.deepEqual(environment, { KEEP: "yes" });
    let value, error;
    running = true;
    try {
      if (settings.startupFailure) throw new Error("synthetic startup failure");
      const connection = await overrides.connect(runtime, { timeoutMs: 60000 });
      connection.client.close();
      value = await onReady();
    } catch (caught) { error = caught; }
    finally { running = false; }
    assert.equal((await readConfig()).gateway.auth.mode, "trusted-proxy", "authentication remains installed until the temporary process has stopped");
    if (settings.restoreFailure) {
      await rm(runtime.configPath);
      await mkdir(runtime.configPath);
    }
    return { value, error, cleanupComplete: !settings.cleanupFailure };
  };
  const result = await executePausedProfileCall({ options, expiresAt: Date.now() + 60000 }, runtime, { signal: controller.signal }, startTemporary, { openProfile });
  assert.equal(running, false);
  assert.ok(connections.every((connection) => connection.closed));
  if (!settings.cleanupFailure && !settings.restoreFailure) {
    assert.deepEqual(await readFile(runtime.configPath), original);
    assert.equal((await stat(runtime.configPath)).mode & 0o777, 0o640);
    assert.equal(result.output.authenticationRestored, true);
  }
  return { result, calls, connections, starts, runtime };
}

test("profile flags accept the retained list, involvement and suggestion forms", () => {
  assert.equal(listOptions()["persona-profile"], "owner");
  assert.equal(parseGatewayCallArgs(flags("sessions.setInvolvement", { key, expectedSessionId: "session-current", hidden: false }))["persona-profile"], "owner");
  assert.equal(parseGatewayCallArgs(flags("session.suggestions.add", { sessionKey: excluded, text: "Suggested follow-up from a viewer." }, "member"))["persona-profile"], "member");
  for (const args of [
    [...flags("sessions.list", listParams, "unknown")],
    [...flags("health", {})],
    [...flags("sessions.list", listParams), "--expect-involved-key", key],
    [...flags("sessions.list", listParams), "--expect-involved-key", key, "--expect-excluded-key", key],
    [...flags("sessions.list", { ...listParams, offset: 1 }), "--expect-involved-key", key, "--expect-excluded-key", excluded],
    [...flags("sessions.list", listParams), "--background", "--handle", "background.json"],
    ["--env", env, "--method", "sessions.list", "--gateway-handle", "gateway.json"],
    ["--env", env, "--method", "sessions.list", "--persona-profile", "owner"],
    [...flags("sessions.list", listParams), "--wait", "wait.json"]
  ]) assert.throws(() => parseGatewayCallArgs(args));
});

test("profile dispatch resolves both session inputs before requesting the transaction", async (t) => {
  const runtime = await fixture(t);
  const created = join(runtime.root, "created.json"), described = join(runtime.root, "described.json");
  await writeFile(created, JSON.stringify({ method: "sessions.create", result: { key }, error: null }));
  await writeFile(described, JSON.stringify({ method: "sessions.describe", result: { session: { key, sessionId: "session-current" } }, error: null }));
  const options = parseGatewayCallArgs([...flags("sessions.setInvolvement", { hidden: true }), "--session-from", created, "--from", described]);
  const expected = { output: { method: "sessions.setInvolvement", result: { ok: true }, error: null }, exitCode: 0 };
  const result = await executeGatewayCall(options, {
    prepare() { assert.fail("profile dispatch must use the existing Gateway"); },
    async requestLifecycle(request) {
      assert.equal(request.operation, "profile-call");
      assert.deepEqual(request.params, { hidden: true, key, expectedSessionId: "session-current" });
      schemas.check(request.method, request.params);
      return expected;
    }
  });
  assert.equal(result, expected);
});

test("saved profile list compares unfiltered and filtered requests with identical selectors", async (t) => {
  const { result, calls } = await transaction(t);
  assert.equal(result.exitCode, 0);
  assert.equal(result.restart, true);
  assert.deepEqual(result.output.personaProfile, { name: "owner", id: ids.owner });
  assert.deepEqual(calls.filter((call) => call.method === "sessions.list"), [
    { identity: "owner", method: "sessions.list", params: { ...listParams, involvingMe: false } },
    { identity: "owner", method: "sessions.list", params: listParams }
  ]);
  assert.equal(result.output.involvement.excludedKey, excluded);
});

test("profile list assertions follow every native page while preserving filters and the first response", async (t) => {
  const baseline = [...Array.from({ length: 400 }, (_, index) => ({ key: `agent:main:baseline-${index}` })), { key }, { key: excluded }];
  const filtered = [...Array.from({ length: 200 }, (_, index) => ({ key: `agent:main:filtered-${index}` })), { key }];
  let firstFiltered;
  const { result, calls } = await transaction(t, listOptions(), {
    request(_method, params) {
      const rows = params.involvingMe ? filtered : baseline, offset = params.offset ?? 0;
      const sessions = rows.slice(offset, offset + params.limit), next = offset + sessions.length;
      const page = { sessions, offset: offset || undefined, totalCount: rows.length, hasMore: next < rows.length, nextOffset: next < rows.length ? next : null };
      if (params.involvingMe && offset === 0) firstFiltered = page;
      return page;
    }
  });
  assert.equal(result.exitCode, 0, result.output.error);
  assert.equal(result.output.result, firstFiltered);
  assert.equal(result.output.result.sessions.some((row) => row.key === key), false, "the included key is found after the requested first page");
  assert.deepEqual(result.output.involvement, { involvedKey: key, excludedKey: excluded, baselineCount: 402, filteredCount: 201, baselinePages: 3, filteredPages: 2 });
  assert.deepEqual(calls.filter((call) => call.method === "sessions.list").map((call) => call.params), [
    { ...listParams, involvingMe: false },
    { ...listParams, involvingMe: false, offset: 200 },
    { ...listParams, involvingMe: false, offset: 400 },
    listParams,
    { ...listParams, offset: 200 }
  ]);
  assert.ok(calls.every((call) => call.identity === "owner"));
});

test("an excluded session on a later filtered page fails the full-list assertion", async (t) => {
  const { result, calls } = await transaction(t, listOptions(), {
    request(_method, params) {
      if (!params.involvingMe) return { sessions: [{ key }, { key: excluded }], hasMore: false, nextOffset: null };
      if (!params.offset) return { sessions: [{ key }], hasMore: true, nextOffset: 1 };
      return { sessions: [{ key: excluded }], offset: 1, hasMore: false, nextOffset: null };
    }
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /involvement filter/);
  assert.equal(calls.filter((call) => call.method === "sessions.list" && call.params.involvingMe).length, 2);
});

for (const cursor of [null, "1", 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) test(`profile pagination rejects invalid continuation ${JSON.stringify(cursor)}`, async (t) => {
  const { result, calls } = await transaction(t, listOptions(), {
    request() { return { sessions: [{ key }], hasMore: true, nextOffset: cursor }; }
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /continuation offset/);
  assert.equal(calls.filter((call) => call.method === "sessions.list").length, 1);
});

for (const cursor of [1, 0]) test(`profile pagination rejects a nonprogressing later continuation ${cursor}`, async (t) => {
  const { result, calls } = await transaction(t, listOptions(), {
    request(_method, params) { return { sessions: [{ key }], offset: params.offset, hasMore: true, nextOffset: params.offset ? cursor : 1 }; }
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /continuation offset/);
  assert.equal(calls.filter((call) => call.method === "sessions.list").length, 2);
});

test("profile pagination refuses a changing native total rather than claiming exclusion", async (t) => {
  const { result } = await transaction(t, listOptions(), {
    request(_method, params) { return params.offset ? { sessions: [{ key: excluded }], offset: 1, totalCount: 3, hasMore: false, nextOffset: null } : { sessions: [{ key }], totalCount: 2, hasMore: true, nextOffset: 1 }; }
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /changed during involvement pagination/);
});

for (const variant of ["baseline-missing", "filtered-leak", "filtered-missing", "paginated"]) test(`list assertions reject ${variant} and restore authentication`, async (t) => {
  const { result } = await transaction(t, listOptions(), {
    request(_method, params) {
      let keys = params.involvingMe ? [key] : [key, excluded];
      if (variant === "baseline-missing" && !params.involvingMe) keys = [key];
      if (variant === "filtered-leak" && params.involvingMe) keys = [key, excluded];
      if (variant === "filtered-missing" && params.involvingMe) keys = [];
      return { sessions: keys.map((key) => ({ key })), hasMore: variant === "paginated", nextOffset: null };
    }
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.restart, true);
});

test("member suggestion uses the saved member while startup uses the saved owner", async (t) => {
  const options = parseGatewayCallArgs(flags("session.suggestions.add", { sessionKey: excluded, text: "Suggested follow-up from a viewer." }, "member"));
  const { result, calls } = await transaction(t, options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls.filter((call) => call.method === "users.self").map((call) => call.identity), ["owner", "member"]);
  assert.equal(result.output.result.suggestion.author.id, ids.member);
});

test("personal involvement validates the native mutation result", async (t) => {
  const options = parseGatewayCallArgs(flags("sessions.setInvolvement", { key, expectedSessionId: "session-current", hidden: true }));
  const { result } = await transaction(t, options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.result.hiddenFromInvolvingMe, true);
});

for (const method of ["sessions.setInvolvement", "session.suggestions.add"]) test(`${method} rejects a mismatched mutation result`, async (t) => {
  const params = method === "sessions.setInvolvement" ? { key, expectedSessionId: "session-current", hidden: true } : { sessionKey: excluded, text: "A suggestion" };
  const { result } = await transaction(t, parseGatewayCallArgs(flags(method, params)), {
    request() {
      return method === "sessions.setInvolvement"
        ? { ok: true, key, hiddenFromInvolvingMe: false }
        : { suggestion: { id: "suggestion-new", sessionKey: excluded, author: { id: "different-profile" } } };
    }
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.restart, true);
});

for (const variant of ["wrongIdentity", "startupFailure"]) test(`${variant} fails before a profile-sensitive request and restores authentication`, async (t) => {
  const { result, calls } = await transaction(t, listOptions(), { [variant]: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.restart, true);
  assert.ok(calls.every((call) => call.method === "users.self"));
});

test("absent saved profiles never install authentication or start a process", async (t) => {
  const { result, starts } = await transaction(t, listOptions(), { profiles: false });
  assert.equal(result.exitCode, 1);
  assert.equal(starts, 0);
  assert.match(result.output.error, /saved persona profiles/);
});

test("interruption between paired requests restores authentication after stopping", async (t) => {
  const { result, calls } = await transaction(t, listOptions(), {
    request(_method, _params, _identity, controller) {
      controller.abort(new Error("synthetic cancellation"));
      return { sessions: [key, excluded].map((key) => ({ key })), hasMore: false, nextOffset: null };
    }
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.restart, true);
  assert.equal(calls.filter((call) => call.method === "sessions.list").length, 1);
});

test("profile timeout stays exit 3 when cancellation closes the pending RPC", async (t) => {
  let pendingClosed = false;
  const { result } = await transaction(t, listOptions(), {
    request(_method, _params, _identity, controller) {
      return new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          pendingClosed = true;
          // A transport close can settle before its caller observes the timeout.
          reject(new CallError("persona connection closed", 1));
        }, { once: true });
        queueMicrotask(() => controller.abort(new CallError("synthetic-private-timeout-detail", 3)));
      });
    }
  });
  assert.equal(pendingClosed, true);
  assert.equal(result.exitCode, 3);
  assert.equal(result.restart, true);
  assert.equal(result.output.authenticationRestored, true);
  assert.equal(result.output.error, "profile call interrupted");
  assert.doesNotMatch(JSON.stringify(result.output), /synthetic-private-timeout-detail/);
});

test("unconfirmed temporary cleanup cannot race authentication restoration", async (t) => {
  const { result, runtime } = await transaction(t, listOptions(), { cleanupFailure: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.restart, false);
  assert.equal(result.output.authenticationRestored, false);
  assert.equal(JSON5.parse(await readFile(runtime.configPath, "utf8")).gateway.auth.mode, "trusted-proxy");
  assert.equal(typeof result.restoreAuthentication, "function");
  await result.restoreAuthentication();
  assert.equal(result.output.authenticationRestored, true);
  assert.deepEqual(await readFile(runtime.configPath), original);
});

test("failed authentication restoration retains an in-memory retry", async (t) => {
  const { result, runtime } = await transaction(t, listOptions(), { restoreFailure: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.restart, false);
  assert.equal(result.output.authenticationRestored, false);
  assert.equal(typeof result.restoreAuthentication, "function");
  await rm(runtime.configPath, { recursive: true });
  await result.restoreAuthentication();
  assert.equal(result.output.authenticationRestored, true);
  assert.deepEqual(await readFile(runtime.configPath), original);
  assert.equal((await stat(runtime.configPath)).mode & 0o777, 0o640);
  await result.restoreAuthentication();
  assert.deepEqual(await readFile(runtime.configPath), original);
});

test("saved profile lookup refuses symbolic links and merged identities", async (t) => {
  const runtime = await fixture(t);
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(runtime.root, ".openclaw", "state", "openclaw.sqlite");
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?").run(ids.owner, ids.member); }
  finally { db.close(); }
  await assert.rejects(readSavedPersonaProfiles(runtime), /saved persona profiles/);
  await rm(path);
  await symlink(runtime.configPath, path);
  await assert.rejects(readSavedPersonaProfiles(runtime), /saved persona profiles/);
});

test("temporary admission rejects unsupported configuration and keeps unrelated settings", () => {
  const converted = personaGatewayConfig(JSON5.parse(original.toString()), 18789);
  assert.equal(converted.unrelated, 42);
  assert.equal(converted.gateway.remote.token, undefined);
  assert.equal(converted.gateway.controlUi.basePath, "/ui");
  for (const config of [{ $include: "foreign.json" }, { gateway: { bind: "lan" } }, { gateway: { roles: {} } }, { gateway: { auth: { $include: "foreign.json" } } }]) assert.throws(() => personaGatewayConfig(config, 18789));
});

test("profile request parameters conform to the pinned Gateway schemas", (t) => schemas.report(t));

test("saved profile connection uses the pinned connect request schema", async () => {
  const { personaProfileConnectParams } = await import("../support/verify/gateway-profile.mjs");
  schemas.check("connect", personaProfileConnectParams("kova-profile-build"));
});

for (const [signal, equals] of [["SIGINT", false], ["SIGTERM", true]]) test(`profile CLI joins cancellation cleanup and exits 3 on ${signal}`, { timeout: 15000 }, async (t) => {
  const runtime = await fixture(t, { profiles: false });
  const handle = join(runtime.root, "gateway.json"), directory = `${handle}.d`;
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), env, entry: "foreground-gateway-start", method: "gateway.start", handlePath: handle, directory, expiresAt: new Date(Date.now() + 120000).toISOString() };
  await atomicJson(join(directory, "operation.json"), operation);
  await atomicJson(handle, { entry: operation.entry, ref: { ...runtime, id: operation.id, directory } });
  const args = ["--env", env, "--method", "sessions.list", "--params", JSON.stringify(listParams), "--gateway-handle", handle, "--timeout", "90000", ...(equals ? ["--persona-profile=owner"] : ["--persona-profile", "owner"])];
  const environment = { ...process.env };
  for (const name of ["NODE_OPTIONS", "KOVA_OCM_TRANSPORT_JSON", "KOVA_NETWORK_FRONTAGE_ENABLED"]) delete environment[name];
  const child = spawn(process.execPath, [fileURLToPath(new URL("../support/verify/gateway-call.mjs", import.meta.url)), ...args], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => { child.once("error", (error) => resolve({ error })); child.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  const waitForRecord = async (path) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.equal(child.exitCode, null, `CLI exited before its mailbox record: ${stderr}`);
      assert.equal(child.signalCode, null);
      assert.ok(Date.now() < deadline, "CLI did not publish its mailbox record");
      await sleep(20);
    }
  };
  const pending = await waitForRecord(join(directory, "fixture-request.json"));
  assert.equal(pending.options.operation, "profile-call");
  assert.equal(pending.options["persona-profile"], "owner");
  assert.equal(child.kill(signal), true);
  await waitForRecord(join(directory, `fixture-cancel-${pending.id}.json`));
  await sleep(100);
  assert.equal(child.exitCode, null, "CLI must wait for authentication restoration");
  assert.equal(child.signalCode, null);
  await rm(join(directory, "fixture-request.json"));
  await atomicJson(join(directory, `fixture-result-${pending.id}.json`), { output: { method: "sessions.list", result: null, error: "profile request interrupted", elapsedMs: 0, authenticationRestored: true }, exitCode: 3 });
  const ended = await closed;
  assert.equal(ended.error, undefined);
  assert.equal(ended.signal, null);
  assert.equal(ended.code, 3, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.authenticationRestored, true);
  assert.match(output.error, new RegExp(signal));
  assert.equal(JSON.parse(await readFile(join(directory, "operation.json"), "utf8")).id, operation.id);
  await assert.rejects(readFile(join(directory, "result.json")), { code: "ENOENT" });
});

for (const variant of ["cleanupFailure", "restoreFailure"]) test(`completed suggestion survives ${variant}`, async (t) => {
  const options = parseGatewayCallArgs(flags("session.suggestions.add", { sessionKey: key, text: "fixture" }, "member"));
  const { result, runtime, calls } = await transaction(t, options, { [variant]: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.restart, false);
  assert.equal(result.output.authenticationRestored, false);
  assert.equal(result.output.result.suggestion.id, "suggestion-new");
  assert.deepEqual(result.output.personaProfile, { name: "member", id: ids.member });
  assert.equal(calls.filter((call) => call.method === options.method).length, 1);
  assert.match(result.output.error, variant === "cleanupFailure" ? /stop was not confirmed/ : /could not restore/);
  if (variant === "restoreFailure") await rm(runtime.configPath, { recursive: true });
  await result.restoreAuthentication();
  assert.equal(result.output.authenticationRestored, true);
  assert.equal(result.output.result.suggestion.id, "suggestion-new");
  assert.deepEqual(await readFile(runtime.configPath), original);
});

test("profile cancellation preserves a completed suggestion receipt without converting failure to success", async () => {
  const options = parseGatewayCallArgs(flags("session.suggestions.add", { sessionKey: key, text: "fixture" }, "member"));
  const completed = { exitCode: 0, output: { method: options.method, result: { suggestion: { id: "observed-created-suggestion", sessionKey: key, author: { id: ids.member } } }, personaProfile: { name: "member", id: ids.member }, authenticationRestored: true, error: null, elapsedMs: 1 } };
  let calls = 0;
  const result = await executeGatewayCall(options, { requestLifecycle: async () => {
    calls++;
    throw Object.assign(new CallError("caller interrupted", 3), { operationResult: completed });
  } });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 3);
  assert.equal(result.output.error, "caller interrupted");
  assert.deepEqual(result.output.result, completed.output.result);
  assert.deepEqual(result.output.personaProfile, completed.output.personaProfile);
  assert.equal(result.output.authenticationRestored, true);
});
