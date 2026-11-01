import assert from "node:assert/strict";
import test from "node:test";
import { CallError } from "../support/verify/background.mjs";
import { resumeArguments } from "../support/verify/run-resume.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const origin = "http://127.0.0.1:18789";
const gatewayUrl = "ws://127.0.0.1:18789";
const discoveredKey = "agent:main:thread:12345678-90ab-cdef-1234-567890abcdef";
const unique = (key = discoveredKey) => ({ ok: true, key, agentId: key.split(":")[1] });
const defaultsRequest = { method: "agents.list", params: {} };
const reference = (key, slug, agentId = "main") => ({
  reference: { key, ...(slug ? { slug } : {}) }, agentId,
  includeGlobal: true, includeUnknown: true, allowMissing: true
});

function fixture(path, replies = [], defaults = { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [] }) {
  const requests = [];
  let resolved = 0;
  return {
    requests,
    async resolve() {
      return await resumeArguments({ "url-from": "url.json" }, {
        read: async () => ({ url: path.startsWith("/") ? `${origin}${path}` : path }),
        runtime: () => ({ gatewayPort: 18789 }),
        rpc: async (method, params) => {
          schemas.check(method, params);
          requests.push({ method, params });
          if (method === "agents.list") return defaults;
          assert.ok(resolved < replies.length, "unexpected Gateway request");
          const reply = replies[resolved++];
          if (reply instanceof Error) throw reply;
          return reply;
        }
      });
    }
  };
}

function handoff(args) {
  assert.deepEqual(args.slice(0, 2), ["resume", "--handoff"]);
  const result = JSON.parse(Buffer.from(args[2], "base64url").toString("utf8"));
  assert.equal(result.version, 1);
  assert.equal(result.gatewayUrl, gatewayUrl);
  return result;
}

test("resume resolves the configured main alias and passes explicit literal paths unchanged", async () => {
  const main = fixture("/chat/main", [unique("agent:main:current")]);
  assert.equal(handoff(await main.resolve()).sessionKey, "agent:main:current");
  assert.deepEqual(main.requests, [{ method: "sessions.resolve", params: { key: "main", agentId: "main" } }]);
  for (const [path, key] of [
    ["/chat/main/~key/notebook", "agent:main:notebook"],
    ["/chat/main/~key/release-deadbeef", "agent:main:release-deadbeef"],
    ["/chat/main/thread/notebook", "agent:main:thread:notebook"],
    ["/dashboard/main/global", "agent:main:global"],
    ["/chat/main/main", "agent:main:main"],
    ["/chat/main/boot", "agent:main:boot"],
    ["/chat/Support-/~key/notebook", "agent:support-:notebook"],
    ["/control/chat/main/sessions", "agent:main:sessions"]
  ]) {
    const literal = fixture(path);
    assert.equal(handoff(await literal.resolve()).sessionKey, key);
    assert.deepEqual(literal.requests, []);
  }
});

test("resume lets the product choose an exact key or display slug", async () => {
  for (const key of ["agent:main:notebook", discoveredKey]) {
    const slug = fixture("/chat/main/notebook", [unique(key)]);
    assert.equal(handoff(await slug.resolve()).sessionKey, key);
    assert.deepEqual(slug.requests, [defaultsRequest, { method: "sessions.resolve", params: reference("agent:main:notebook", "notebook") }]);
  }
  const encoded = fixture("/dashboard/%20Main%20/research%20notes", [unique()]);
  assert.equal(handoff(await encoded.resolve()).sessionKey, discoveredKey);
  assert.deepEqual(encoded.requests.at(-1).params, reference("agent:main:research notes", "research notes"));
});

test("configured main names remain literal even when they resemble short IDs or display slugs", async () => {
  for (const mainKey of ["1234ABCD", "release-deadbeef", "notebook"]) {
    const configured = fixture(`/chat/main/${mainKey}`, [], { defaultId: "main", mainKey: mainKey.toLowerCase(), scope: "per-sender", agents: [] });
    assert.equal(handoff(await configured.resolve()).sessionKey, `agent:main:${mainKey}`);
    assert.deepEqual(configured.requests, [defaultsRequest]);
  }
  const unavailable = fixture("/chat/main/notebook", [], {});
  await assert.rejects(unavailable.resolve(), /configured main session key/);
  assert.deepEqual(unavailable.requests, [defaultsRequest]);
});

test("short references stay authoritative and confirmed misses discover the exact decoded key", async () => {
  const short = fixture("/chat/main/notebook--0123ABCD", [unique()]);
  assert.equal(handoff(await short.resolve()).sessionKey, discoveredKey);
  assert.deepEqual(short.requests, [defaultsRequest, { method: "sessions.resolve", params: {
    shortId: "0123abcd", slugHint: "notebook", agentId: "main", allowMissing: true
  } }]);
  for (const missing of [{ ok: false }, { ok: false, candidates: [] }]) {
    const key = "agent:main:12345678-90ab-cdef-1234-567890abcdef";
    const literal = fixture("/chat/main/12345678-90ab-cdef-1234-567890abcdef", [missing, unique(key)]);
    assert.equal(handoff(await literal.resolve()).sessionKey, key);
    assert.deepEqual(literal.requests, [
      defaultsRequest,
      { method: "sessions.resolve", params: { shortId: "567890abcdef", slugHint: "12345678-90ab-cdef-1234", agentId: "main", allowMissing: true } },
      { method: "sessions.resolve", params: reference(key) }
    ]);
  }
});

test("missing, ambiguous and failed discoveries never fabricate a literal handoff", async () => {
  const candidates = [{ key: discoveredKey, agentId: "main" }, { key: "agent:main:thread:12345678-aaaa-bbbb-cccc-000000000000", agentId: "main" }];
  for (const [path, replies, error, count] of [
    ["/chat/main/notebook", [{ ok: false }], /did not resolve/, 1],
    ["/chat/main/notebook", [{ ok: false, candidates }], /ambiguous/, 1],
    ["/chat/main/12345678", [{ ok: false, candidates }], /ambiguous/, 1],
    ["/chat/main/12345678", [{ ok: false }, { ok: false }], /did not resolve/, 2],
    ["/chat/main/12345678", [{ ok: false }, { ok: false, candidates }], /ambiguous/, 2],
    ["/chat/main/12345678", [{ key: discoveredKey }], /invalid result/, 1],
    ["/chat/main/12345678", [new CallError("Gateway refusal", 1)], /Gateway refusal/, 1],
    ["/chat/main", [{ ok: false }], /did not resolve/, 1]
  ]) {
    const missing = fixture(path, replies);
    await assert.rejects(missing.resolve(), (caught) => {
      assert.equal(caught.exitCode, 1);
      assert.match(caught.message, error);
      return true;
    });
    assert.equal(missing.requests.filter((request) => request.method === "sessions.resolve").length, count);
    assert.equal(missing.requests.filter((request) => request.method === "agents.list").length, path === "/chat/main" ? 0 : 1);
  }
});

test("raw URL markers are recognized before percent and tilde decoding", async () => {
  for (const [suffix, rest, exact] of [
    ["~~key", "~key", false], ["%7Ekey", "~key", false],
    ["~key/~~key", "~key", true], ["~key/%7Ekey", "~key", true],
    ["~dot", ".", false], ["~dotdot", "..", false],
    ["~~dot", "~dot", false], ["%7Edot", "~dot", false]
  ]) {
    const key = `agent:main:${rest}`;
    const literal = fixture(`/chat/main/${suffix}`, exact ? [] : [unique(key)]);
    assert.equal(handoff(await literal.resolve()).sessionKey, key);
    assert.deepEqual(literal.requests, exact ? [] : [defaultsRequest, { method: "sessions.resolve", params: reference(key, rest) }]);
  }
});

test("invalid and foreign URLs are refused before any Gateway lookup", async () => {
  for (const url of [
    "/chat/main/~key", "/chat/main/%ZZ", "/chat/main/a//b",
    "http://127.0.0.1:19876/chat/main/notebook", "https://127.0.0.1:18789/chat/main/notebook",
    "http://user:password@127.0.0.1:18789/chat/main/notebook", `${origin}/chat/main/notebook?x=1`, `${origin}/chat/main/notebook#x`
  ]) {
    const invalid = fixture(url);
    await assert.rejects(invalid.resolve(), (error) => error instanceof CallError && error.exitCode === 2);
    assert.deepEqual(invalid.requests, []);
  }
});

test("query and handoff inputs keep their existing argument contract", async () => {
  const context = {
    read: async () => assert.fail("query must not read a file"),
    runtime: () => ({ gatewayPort: 18789 }),
    rpc: async () => assert.fail("query and handoff must not resolve a URL")
  };
  assert.deepEqual(await resumeArguments({ query: "--literal-query" }, context), ["resume", "--", "--literal-query"]);
  const value = { version: 1, sessionKey: discoveredKey, gatewayUrl };
  for (const input of [value, Buffer.from(JSON.stringify(value)).toString("base64url")]) {
    const args = await resumeArguments({ "handoff-from": "handoff.json" }, { ...context, read: async () => ({ handoff: input }) });
    assert.deepEqual(handoff(args), value);
  }
});

test("resume URL requests satisfy the pinned Gateway schemas", (t) => schemas.report(t));
