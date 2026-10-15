import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBuildIds, projectBuildIdResponses } from "../src/verify/build-ids.mjs";

const declarations = [{ kind: "asset-fingerprint", command: "control-ui", at: "/requests/*/endpoint" }];
const entry = { id: "control-ui", kind: "script" };
const asset = (endpoint = "/assets/index-RyfAVzM6.js", changes = {}) => ({
  transport: "http", method: "GET", endpoint, origin: "gateway", resourceType: "script",
  params: { query: {}, body: null }, status: "result", elapsedMs: 12, statusCode: 200, ...changes
});
const gateway = (method, changes = {}) => ({ transport: "gateway", method, params: { sessionKey: "product-session-id" }, status: "result", elapsedMs: 25, ...changes });
const project = (requests, audit) => projectBuildIdResponses({ flow: "new-session-page", requests }, entry, declarations, audit);

test("build fingerprint declarations are optional and limited to the supported producer", () => {
  assert.deepEqual(validateBuildIds(), []);
  assert.deepEqual(validateBuildIds([]), []);
  assert.equal(validateBuildIds(declarations), declarations);
  for (const invalid of [null, {}, "asset-fingerprint", [null], [{}], [...declarations, ...declarations],
    [{ ...declarations[0], kind: "hash" }], [{ ...declarations[0], command: "status" }],
    [{ ...declarations[0], at: "/requests/*/params" }], [{ ...declarations[0], extra: true }]]) {
    assert.throws(() => validateBuildIds(invalid), /invalid buildIds declaration/);
  }
});

test("undeclared responses and other producers retain their original representation", () => {
  const response = { requests: [asset()] };
  for (const rules of [undefined, []]) assert.equal(projectBuildIdResponses(response, entry, rules), response);
  assert.equal(projectBuildIdResponses(response, { id: "other" }, declarations), response);
  for (const value of [undefined, null, [], "response", { requests: null }, { requests: {} }, {}]) {
    assert.equal(projectBuildIdResponses(value, entry, declarations), value);
  }
});

test("asset hashes and chunk counts no longer displace ordinary browser requests", () => {
  const before = gateway("sessions.list"), after = gateway("sessions.create");
  const baseline = project([asset(), before, asset("/assets/control-ui-boot-shared-BkgOJ--_.js"), after]);
  const change = project([before, asset("/assets/control-ui-boot-shared-C_jLGYSZ.js"), asset("/assets/index-Dd-zct_7.js"), asset("/assets/control-ui-boot-shared-By_K58ul.js"), after]);
  assert.deepEqual(change, baseline);
  assert.deepEqual(change.requests.other, [before, after]);
  assert.equal(change.requests.assets["/assets/index-<build-id>.js"][0].observation.endpoint, "/assets/index-<build-id>.js");
  assert.notDeepEqual(project([before, after]), project([after, before]));
  assert.notDeepEqual(project([before, after]), project([before, after, after]));
});

test("the final eight base64url characters normalize without losing names or extensions", () => {
  const paths = ["/assets/session-workspace-recovery.runtime-AZaz09_-.js", "/assets/control-ui-boot-chat-styles-BkgOJ--_.css"];
  const result = project(paths.map((path) => asset(path)));
  assert.deepEqual(Object.keys(result.requests.assets), ["/assets/control-ui-boot-chat-styles-<build-id>.css", "/assets/session-workspace-recovery.runtime-<build-id>.js"]);
  assert.notDeepEqual(project([asset("/assets/index-AZaz09_-.js")]), project([asset("/assets/index-AZaz09_-.css")]));
  assert.notDeepEqual(project([asset("/assets/index-AZaz09_-.js")]), project([asset("/assets/changed-AZaz09_-.js")]));
  assert.notDeepEqual(project([asset()]), project([]));
});

test("same-URL repetitions survive collapse across distinct fingerprinted chunks", () => {
  const first = asset("/assets/shared-AAAAAAAA.js"), second = asset("/assets/shared-BBBBBBBB.js"), third = asset("/assets/shared-CCCCCCCC.js");
  const result = project([first, second, first, second, second, third]);
  assert.equal(result.requests.assets["/assets/shared-<build-id>.js"][0].count, 3);
  assert.notDeepEqual(project([first, first]), project([first]));
  assert.deepEqual(project([first, second]), project([third]));
});

test("asset variant order follows normalized IDs and non-finite payloads stay opaque", () => {
  const normalize = value => ({ "before-z": "<id:one>", "before-a": "<id:two>", "after-a": "<id:one>", "after-z": "<id:two>" })[value] ?? value;
  const observe = names => projectBuildIdResponses({ requests: names.map(name => asset(undefined, { params: { session: name } })) }, entry, declarations, undefined, normalize).requests.assets["/assets/index-<build-id>.js"].map(value => normalize(value.observation.params.session));
  assert.deepEqual(observe(["before-a", "before-z"]), observe(["after-z", "after-a"]));
  const overflow = asset(undefined, { params: { value: Infinity } });
  assert.deepEqual(project([overflow]).requests.other, [overflow]);
});

test("different outcomes, parameters and metadata remain separate deterministic asset observations", () => {
  const variants = [asset(), asset(undefined, { status: "failed", statusCode: 404 }),
    asset(undefined, { status: "pending", elapsedMs: null }),
    asset(undefined, { params: { query: "[redacted]", body: null } }),
    asset(undefined, { method: "POST" }), asset(undefined, { resourceType: "stylesheet" }),
    asset(undefined, { validation: { status: "invalid", errors: ["bad response"] } }),
    asset(undefined, { status: "closed", errorCode: "UNAVAILABLE" })];
  const forward = project(variants), reversed = project(variants.toReversed());
  assert.deepEqual(forward, reversed);
  const observations = forward.requests.assets["/assets/index-<build-id>.js"];
  assert.equal(observations.length, variants.length);
  assert.ok(observations.some(({ observation }) => observation.statusCode === 404 && observation.status === "failed"));
  assert.ok(observations.some(({ observation }) => observation.validation?.status === "invalid"));
  assert.ok(observations.every(({ count }) => count === 1));
});

test("unsupported paths, origins and malformed observations stay ordered and unchanged", () => {
  const requests = [null, [], "request", {},
    ...["/assets/index-1234567.js", "/assets/index-123456789.js", "/assets/index-12345678.webp", "/assets/index-12345678.js?query=1", "/assets/index-12345678.js\n", "/other/index-12345678.js", "/assets/nested/index-12345678.js", "/assets/-12345678.js", "/assets/index-1234567+.js", "/[redacted]"].map((path) => asset(path)),
    asset(undefined, { origin: "external" }), asset(undefined, { transport: "gateway" }),
    asset(undefined, { method: null }), asset(undefined, { resourceType: null }), asset(undefined, { status: null }), asset(undefined, { params: [] }),
    gateway("sessions.list"), gateway("sessions.list")];
  const result = project(requests);
  assert.deepEqual(result.requests.assets, {});
  assert.deepEqual(result.requests.other, requests);
  for (let index = 0; index < requests.length; index++) assert.equal(result.requests.other[index], requests[index]);
});

test("only finite producer-owned asset elapsed time is removed and product IDs stay literal", () => {
  const original = { requests: [asset(undefined, { elapsedMs: 80, params: { elapsedMs: 15, sessionKey: "RyfAVzM6" }, durationMs: 90 })], createdIds: ["RyfAVzM6"] };
  const saved = structuredClone(original), result = projectBuildIdResponses(original, entry, declarations);
  assert.deepEqual(original, saved);
  const observation = result.requests.assets["/assets/index-<build-id>.js"][0].observation;
  assert.equal(Object.hasOwn(observation, "elapsedMs"), false);
  assert.deepEqual(observation.params, { elapsedMs: 15, sessionKey: "RyfAVzM6" });
  assert.equal(observation.durationMs, 90);
  assert.deepEqual(result.createdIds, ["RyfAVzM6"]);
  for (const elapsedMs of [null, "slow"]) {
    const projected = project([asset(undefined, { elapsedMs })]);
    assert.equal(projected.requests.assets["/assets/index-<build-id>.js"][0].observation.elapsedMs, elapsedMs);
  }
  for (const elapsedMs of [Infinity, NaN]) {
    const invalid = asset(undefined, { elapsedMs }), projected = project([invalid, asset(undefined, { elapsedMs: null })]);
    assert.equal(projected.requests.other[0], invalid);
    assert.equal(projected.requests.assets["/assets/index-<build-id>.js"][0].observation.elapsedMs, null);
  }
});

test("object key order does not create duplicate asset outcome variants", () => {
  const first = asset("/assets/shared-AAAAAAAA.js", { params: { query: { second: 2, first: 1 }, body: null } });
  const second = asset("/assets/shared-BBBBBBBB.js", { params: { body: null, query: { first: 1, second: 2 } } });
  const variants = project([first, second]).requests.assets["/assets/shared-<build-id>.js"];
  assert.equal(variants.length, 1);
  assert.equal(variants[0].count, 1);
});

test("audit entries identify each original fingerprint, elapsed time and discarded chunk observation", () => {
  const audits = [], requests = [asset("/assets/shared-AAAAAAAA.js"), asset("/assets/shared-BBBBBBBB.js"), asset("/assets/shared-BBBBBBBB.js")];
  const result = project(requests, (category, reason, before, after, at) => audits.push({ category, reason, before, after, at }));
  assert.equal(result.requests.assets["/assets/shared-<build-id>.js"][0].count, 2);
  assert.deepEqual(audits.filter(({ category }) => category === "declaredIds").map(({ at }) => at), ["/requests/0/endpoint", "/requests/1/endpoint", "/requests/2/endpoint"]);
  assert.deepEqual(audits.filter(({ category }) => category === "measurements").map(({ at }) => at), ["/requests/0/elapsedMs", "/requests/1/elapsedMs", "/requests/2/elapsedMs"]);
  const collapsed = audits.filter(({ category, at }) => category === "derived" && at !== "/requests");
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].at, "/requests/0");
  assert.equal(collapsed[0].before, requests[0]);
  assert.deepEqual(collapsed[0].after, { absent: true });
  assert.deepEqual(audits.at(-1), { category: "derived", reason: "Control UI request positions and length derived from build assets", before: { type: "array", length: 3 }, after: { type: "object", keys: ["assets", "other"] }, at: "/requests" });
});
