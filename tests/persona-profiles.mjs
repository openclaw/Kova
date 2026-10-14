import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReadonlySession, checkHumanProfiles, checkReadonlySession, hasApprovedProfileDevice, pairedProfileEnvironment, profileGatewayConfig, profileIdentities, profileRequests, profileResponseError, readProfileBuildId, readSavedHumanProfiles } from "../support/persona/profile-content.mjs";

const key = "agent:main:shared-persona";
const ownerId = "a39e7870-f120-4a54-a5f2-e7d7b8a3b516";
const memberId = "00e84f47-f96a-4810-9760-0b9ff048f9b4";

function collaboration() {
  const profiles = [
    { id: ownerId, emails: [profileIdentities.owner], mergedInto: null },
    { id: memberId, emails: [profileIdentities.member], mergedInto: null },
  ];
  const state = { profiles, visibility: "shared", members: [], suggestions: [], role: "viewer", sends: 0, denied: 0 };
  const request = (identity) => async ({ method, params }) => {
    if (method === "users.self") return { profile: profiles[identity === "owner" ? 0 : 1] };
    if (method === "users.list") return { profiles };
    if (method === "sessions.create") return { key, sessionId: "saved-session" };
    if (method === "sessions.send") { assert.equal(identity, "owner"); return { runId: `accepted-${++state.sends}` }; }
    if (method === "agent.wait") return { runId: params.runId, status: "ok" };
    if (method === "sessions.describe") return { session: { key, sessionId: "saved-session", visibility: state.visibility, label: "kova-shared-notebook" } };
    if (method === "session.visibility.set") { assert.equal(identity, "owner"); state.visibility = params.visibility; return { ok: true }; }
    if (method === "session.members.list") return { sessionKey: key, members: state.members };
    if (method === "session.suggestions.add") {
      assert.equal(identity, "member");
      assert.equal(state.visibility, "suggest");
      const suggestion = { id: "saved-suggestion", author: { type: "human", id: memberId }, text: params.text, state: "pending" };
      state.suggestions.push(suggestion);
      return { suggestion };
    }
    if (method === "session.suggestions.list") return { role: state.role, suggestions: state.suggestions };
    if (method === "chat.history") return { messages: [{ role: "user" }, { role: "assistant" }] };
    if (method === "sessions.patch") {
      assert.equal(identity, "member");
      assert.equal(params.label, "kova-shared-notebook");
      state.denied++;
      const error = new Error("participation required"); error.participationRequired = true; throw error;
    }
    assert.fail(`unexpected request ${method}`);
  };
  return { state, owner: request("owner"), member: request("member") };
}

test("read-only sharing leaves a viewer and preserves a suggestion made while allowed", async () => {
  const context = collaboration();
  const result = await buildReadonlySession({ ...context, key, memberProfileId: memberId });
  assert.deepEqual(result, { key, sessionId: "saved-session", suggestionId: "saved-suggestion", memberIdentityId: memberId });
  assert.equal(context.state.sends, 6);
  assert.equal(context.state.visibility, "read-only");
  assert.equal(context.state.denied, 1);
  assert.deepEqual(context.state.members, []);
});

test("read-only checks reject a write member, another author, and an accepted suggestion", async () => {
  const context = collaboration();
  await buildReadonlySession({ ...context, key, memberProfileId: memberId });
  const check = () => checkReadonlySession({ ...context, key, memberProfileId: memberId, suggestionId: "saved-suggestion" });
  context.state.members.push({ identityId: memberId });
  await assert.rejects(check(), /write access/);
  context.state.members.length = 0;
  context.state.suggestions[0].author.id = ownerId;
  await assert.rejects(check(), /pending suggestion/);
  context.state.suggestions[0].author.id = memberId;
  context.state.suggestions[0].state = "accepted";
  await assert.rejects(check(), /pending suggestion/);
});

test("read-only checks require the real participation denial and preserve transport failure", async () => {
  const context = collaboration();
  await buildReadonlySession({ ...context, key, memberProfileId: memberId });
  const member = context.member;
  context.member = async (request) => request.method === "sessions.patch" ? { ok: true } : member(request);
  await assert.rejects(checkReadonlySession({ ...context, key }), /could modify/);
  context.member = async (request) => {
    if (request.method === "sessions.patch") throw new Error("transport unavailable");
    return member(request);
  };
  await assert.rejects(checkReadonlySession({ ...context, key }), /transport unavailable/);
});

test("human profiles must retain separate canonical authenticated email identities", async () => {
  const context = collaboration();
  assert.deepEqual(await checkHumanProfiles(context.owner, context.member), { ownerProfileId: ownerId, memberProfileId: memberId });
  context.state.profiles[1].mergedInto = ownerId;
  await assert.rejects(checkHumanProfiles(context.owner, context.member), /profiles are missing/);
});

test("visibility denials are distinguished from unavailable or malformed responses without echoing text", () => {
  const request = { method: "chat.history", params: { sessionKey: key } };
  const denied = profileResponseError(request, { code: "INVALID_REQUEST", message: `Session "${key}" was not found.` });
  assert.equal(denied.sessionNotVisible, true);
  assert.equal(denied.message, "persona Gateway rejected the request");
  assert.equal(denied.cause, undefined);
  assert.equal(profileResponseError(request, { code: "UNAVAILABLE", message: `Session "${key}" was not found.` }).sessionNotVisible, undefined);
  assert.equal(profileResponseError(request, { code: "INVALID_REQUEST", message: "another error" }).sessionNotVisible, undefined);
  const participation = profileResponseError(request, { code: "INVALID_REQUEST", details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
  assert.equal(participation.participationRequired, true);
  assert.equal(participation.sessionNotVisible, undefined);
});

test("identity mode keeps unrelated configuration and gives only the owner administrative access", () => {
  const remoteToken = { source: "env", provider: "default", id: "KOVA_PROFILE_TEST_INPUT" };
  const config = { agents: { defaults: { model: "mock" } }, gateway: { bind: "loopback", auth: { mode: "none" }, controlUi: { basePath: "/lab" }, remote: { url: "ws://127.0.0.1:19020", transport: "direct", token: remoteToken } } };
  const changed = profileGatewayConfig(config, 19020);
  assert.deepEqual(config.gateway.auth, { mode: "none" });
  assert.deepEqual(changed.agents, config.agents);
  assert.equal(changed.gateway.controlUi.basePath, "/lab");
  assert.equal(Object.hasOwn(changed.gateway.remote, "token"), false);
  assert.deepEqual(changed.gateway.remote, { url: "ws://127.0.0.1:19020", transport: "direct" });
  assert.deepEqual(config.gateway.remote.token, remoteToken);
  assert.equal(changed.gateway.auth.trustedProxy.allowLoopback, true);
  assert.deepEqual(changed.gateway.auth.identityScopes[profileIdentities.member], ["operator.read", "operator.write"]);
  assert.deepEqual(changed.gateway.auth.identityScopes[profileIdentities.owner], ["operator.admin"]);
  assert.throws(() => profileGatewayConfig({ gateway: { bind: "lan" } }, 19020), /isolated loopback/);
});

function bootstrapResponse(body, { url = "http://127.0.0.1:19020/lab/control-ui-config.json", status = 200, headers = {} } = {}) {
  const response = new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

const bootstrapInput = { gatewayUrl: "ws://127.0.0.1:19020", basePath: "/lab/", headers: { origin: "http://127.0.0.1:19020", "x-forwarded-user": profileIdentities.owner } };

test("identity connect uses the actual bootstrap build and preserves the configured UI mount", async () => {
  const reported = "2026.9.9-persona-bootstrap-example";
  const buildId = await readProfileBuildId(bootstrapInput, async (url, options) => {
    assert.equal(url, "http://127.0.0.1:19020/lab/control-ui-config.json");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.origin, bootstrapInput.headers.origin);
    assert.equal(options.headers["x-forwarded-user"], profileIdentities.owner);
    assert.ok(options.signal instanceof AbortSignal);
    return bootstrapResponse({ basePath: "/lab", serverBuildId: reported });
  });
  assert.equal(profileRequests.connect(buildId).params.client.buildId, reported);
});

test("bootstrap rejects redirects, another origin, missing identity and invalid or oversized JSON", async () => {
  const responses = [
    () => bootstrapResponse({}, { status: 302, headers: { location: "http://example.invalid/" } }),
    () => bootstrapResponse({ basePath: "/lab", serverBuildId: "different" }, { url: "http://example.invalid/lab/control-ui-config.json" }),
    () => bootstrapResponse({ basePath: "/lab" }),
    () => bootstrapResponse({ basePath: "/another", serverBuildId: "different" }),
    () => bootstrapResponse("not JSON"),
    () => bootstrapResponse(" ".repeat(256 * 1024 + 1)),
    () => bootstrapResponse({}, { status: 401 }),
  ];
  for (const response of responses) await assert.rejects(readProfileBuildId(bootstrapInput, async () => response()), (error) => {
    assert.equal(error.message, "could not read the persona Gateway UI build identity");
    assert.equal(error.exitCode, 1);
    return true;
  });
  await assert.rejects(readProfileBuildId({ ...bootstrapInput, basePath: "//example.invalid" }, async () => assert.fail("invalid mount must not be fetched")), /UI build identity/);
  await assert.rejects(readProfileBuildId({ ...bootstrapInput, headers: { origin: "http://example.invalid" } }, async () => assert.fail("cross-origin input must not be fetched")), /UI build identity/);
});

test("bootstrap timeout remains a timeout without leaking the transport error", async () => {
  await assert.rejects(readProfileBuildId(bootstrapInput, async () => { throw new DOMException("transport details", "TimeoutError"); }), (error) => {
    assert.equal(error.exitCode, 3);
    assert.equal(error.message, "could not read the persona Gateway UI build identity");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("paired profile uses a native named-profile directory inside exported state", () => {
  const values = pairedProfileEnvironment({ root: "/environment" });
  assert.equal(values.OPENCLAW_STATE_DIR, join(values.OPENCLAW_HOME, ".openclaw-verify-cli"));
  assert.equal(values.OPENCLAW_CONFIG_PATH, join(values.OPENCLAW_STATE_DIR, "openclaw.json"));
  assert.equal(values.OPENCLAW_PROFILE, "verify-cli");
  assert.ok(values.OPENCLAW_HOME.startsWith("/environment/.openclaw/"));
});

test("port rebinding cannot repair missing, revoked or narrowed device approval", () => {
  const entry = { deviceId: "saved-device-id", roles: ["operator"], tokens: [{ role: "operator", scopes: ["operator.read", "operator.pairing"] }] };
  const inventory = { paired: [entry] };
  assert.equal(hasApprovedProfileDevice(inventory, entry.deviceId), true);
  assert.equal(hasApprovedProfileDevice(inventory, "another-device-id"), false);
  entry.tokens[0].revokedAtMs = 1;
  assert.equal(hasApprovedProfileDevice(inventory, entry.deviceId), false);
  delete entry.tokens[0].revokedAtMs;
  entry.tokens[0].scopes = ["operator.read"];
  assert.equal(hasApprovedProfileDevice(inventory, entry.deviceId), false);
});

test("saved identity inspection refuses missing state without creating profiles", async () => {
  const state = await mkdtemp(join(tmpdir(), "kova-profile-content-"));
  let db;
  try {
    await mkdir(join(state, "state"));
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(join(state, "state", "openclaw.sqlite"));
    db.exec("CREATE TABLE user_profiles (id TEXT PRIMARY KEY, merged_into TEXT); CREATE TABLE user_profile_emails (email TEXT PRIMARY KEY, profile_id TEXT)");
    db.prepare("INSERT INTO user_profiles VALUES (?, NULL)").run(ownerId);
    db.prepare("INSERT INTO user_profile_emails VALUES (?, ?)").run(profileIdentities.owner, ownerId);
    await assert.rejects(readSavedHumanProfiles({ stateDir: state }), /identities are absent/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM user_profiles").get().n, 1);
    db.prepare("INSERT INTO user_profiles VALUES (?, NULL)").run(memberId);
    db.prepare("INSERT INTO user_profile_emails VALUES (?, ?)").run(profileIdentities.member, memberId);
    assert.deepEqual(await readSavedHumanProfiles({ stateDir: state }), { ownerProfileId: ownerId, memberProfileId: memberId });
  } finally { db?.close(); await rm(state, { recursive: true, force: true }); }
});

export const profileRequestCases = {
  connect: [["persona-schema-build"]], self: [[]], list: [[]], config: [[]],
  visibility: [[key, "suggest"], [key, "read-only"]],
  members: [[key]], suggest: [[key]], suggestions: [[key]], unchangedLabel: [[key]], deviceList: [[]],
};

test("every profile request has a schema argument case", () => {
  assert.deepEqual(Object.keys(profileRequests).sort(), Object.keys(profileRequestCases).sort());
});
