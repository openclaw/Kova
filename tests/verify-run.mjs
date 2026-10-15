import { parseCatalogueCommand } from "../src/catalogue.mjs";
import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile, appendFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createAttachmentLogFilter, createLogCollector, createStateFileIdentityResolver, createStateTextPolicy, mergeStateTextPolicies, isPrivateVerificationPath, projectStateLogBytes, recordPhase, redactCommandResult, redactStateText, snapshotState, writeCheckpoint } from "../src/verify/checkpoint.mjs";
import { quoteShell, runCommand } from "../src/commands.mjs";
import { runVerification, compareVersions, prepareRun, validateRunPlan, validateTarget, validateRunDestinations as validateRawRunDestinations } from "../src/verify/run.mjs";
import { resolveRunCommand } from "../src/verify/clones.mjs";
import { canonicalJSON, sha256 } from "../src/verify/plan.mjs";
import { repoRoot } from "../src/paths.mjs";
import { executeGatewayCall, parseGatewayCallArgs, resolveGatewayParams } from "../support/verify/gateway-call.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const requestSchemas = await loadGatewaySchemaAssertions();

async function checkGatewayCommand(command) {
  const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
  if (tokens[0] !== "node" || !tokens[1]?.replaceAll("\\", "/").endsWith("/support/verify/gateway-call.mjs")) return;
  const options = parseGatewayCallArgs(tokens.slice(2));
  if (!options.wait) requestSchemas.check(options.method, await resolveGatewayParams(options));
}

async function validateRunDestinations(command, context) {
  // Destination-refusal controls must be valid requests before the ownership
  // check. Successful calls must also retain validity after parameter freezing.
  await checkGatewayCommand(command);
  const prepared = await validateRawRunDestinations(command, context);
  await checkGatewayCommand(prepared);
  return prepared;
}

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-verify-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));

test("records a real phase's JSON, text, exit 2 and timing by command index", async (t) => {
  const directory = await temporary(t);
  const invoke = (source) => `${quoteShell(process.execPath)} -e ${quoteShell(source)}`;
  const phase = {
    id: "intent/record-output", timeoutMs: 5000, checkpoint: ["responses", "timing", "logs", "doctor"],
    commands: [invoke("console.log(JSON.stringify({result:{ok:true}}))"), invoke("console.log('detail'); console.error('bad call'); process.exitCode=2"), invoke("console.log('null')")]
  };
  const result = await recordPhase({ phase, directory, collectLogs: async () => "gateway line\n" });
  assert.equal(result.incomplete, true);
  const commands = await readJSON(join(result.path, "commands.json"));
  assert.deepEqual(commands.map((command) => command.exit), [0, 2, 0]);
  assert.deepEqual(commands.map((command) => command.stdout), [null, "detail\n", null]);
  assert.equal(commands[1].stderr, "bad call\n");
  assert.deepEqual(await readJSON(join(result.path, "responses.json")), { 0: { result: { ok: true } }, 2: null });
  assert.deepEqual(await readJSON(join(result.path, "doctor.json")), [{ result: { ok: true } }, "detail\n", null]);
  assert.equal(await readFile(join(result.path, "logs.txt"), "utf8"), "gateway line\n");
  const timing = await readJSON(join(result.path, "timing.json"));
  assert.ok(timing.every((value) => value.durationMs >= 0 && !value.reachedBound));
});

test("records timeout evidence through the existing process owner", async (t) => {
  const directory = await temporary(t);
  const phase = { id: "intent/timed-command", timeoutMs: 5000, checkpoint: ["timing"], commands: [`${quoteShell(process.execPath)} -e ${quoteShell("setInterval(()=>{},1000)")}`] };
  const result = await recordPhase({ phase, directory, bounds: [100] });
  assert.equal(result.results[0].status, 124);
  assert.equal((await readJSON(join(result.path, "timing.json")))[0].reachedBound, true);
  assert.equal(result.incomplete, false);
});

test("SQLite snapshots contain committed WAL data, preserve blobs and leave source data intact", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t);
  const state = join(directory, "source");
  const output = join(directory, "copy");
  await mkdir(state);
  const source = new DatabaseSync(join(state, "openclaw.sqlite"));
  t.after(() => source.close());
  source.exec("PRAGMA journal_mode=WAL; CREATE TABLE events (id TEXT PRIMARY KEY, content BLOB, details TEXT)");
  source.prepare("INSERT INTO events VALUES (?, ?, ?)").run("existing-id", Buffer.from([0, 1, 255]), '{"nested":true}');
  await writeFile(join(state, "settings.json"), '{"value":1}\n');
  await snapshotState(state, ["openclaw.sqlite", "settings.json", "absent.json"], output);
  const copy = new DatabaseSync(join(output, "openclaw.sqlite"), { readOnly: true });
  try {
    const row = copy.prepare("SELECT * FROM events").get();
    assert.equal(row.id, "existing-id");
    assert.deepEqual(Buffer.from(row.content), Buffer.from([0, 1, 255]));
    assert.equal(row.details, '{"nested":true}');
  } finally { copy.close(); }
  assert.equal(source.prepare("SELECT count(*) AS count FROM events").get().count, 1);
  assert.deepEqual((await readdir(output)).sort(), ["openclaw.sqlite", "settings.json"]);
  assert.equal(await readFile(join(output, "settings.json"), "utf8"), '{"value":1}\n');
});

test("SQLite evidence preserves constrained rows while omitting generated credentials and retired bytes", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t), state = join(directory, "source");
  await mkdir(state);
  const source = new DatabaseSync(join(state, "openclaw.sqlite"));
  t.after(() => source.close());
  source.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=OFF;
    CREATE TABLE events (value TEXT, content BLOB);
    INSERT INTO events(rowid, value) VALUES (1, 'one'), (3, 'three');
    CREATE TABLE device_identities (identity_key TEXT NOT NULL PRIMARY KEY, device_id TEXT NOT NULL, public_key_pem TEXT NOT NULL, private_key_pem TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE device_auth_tokens (device_id TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, scopes_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(device_id, role)) STRICT;
    CREATE TABLE gateway_origin_device_tokens (gateway_scope TEXT NOT NULL, device_id TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, scopes_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(gateway_scope, device_id, role)) STRICT;
    CREATE TABLE device_bootstrap_tokens (token_key TEXT NOT NULL PRIMARY KEY, token TEXT NOT NULL, setup_id TEXT, ts INTEGER NOT NULL, device_id TEXT, public_key TEXT, profile_json TEXT, redeemed_profile_json TEXT, pending_profile_json TEXT, issued_at_ms INTEGER NOT NULL, last_used_at_ms INTEGER) STRICT;
    CREATE TABLE device_pairing_paired (device_id TEXT NOT NULL PRIMARY KEY, public_key TEXT NOT NULL, display_name TEXT, operator_label TEXT, platform TEXT, device_family TEXT, client_id TEXT, client_mode TEXT, browser_origin TEXT, role TEXT, roles_json TEXT, scopes_json TEXT, approved_scopes_json TEXT, remote_ip TEXT, tokens_json TEXT, approved_via TEXT, node_surface_json TEXT, pending_node_surface_json TEXT, created_at_ms INTEGER NOT NULL, approved_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER, last_seen_reason TEXT) STRICT;
    CREATE TABLE device_pairing_join_codes (shortcode TEXT, payload_json TEXT, created_at_ms INTEGER, expires_at_ms INTEGER) STRICT;
    CREATE TABLE channel_pairing_requests (channel_key TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, meta_json TEXT, PRIMARY KEY(channel_key, account_id, request_id)) STRICT;
    CREATE INDEX idx_channel_pairing_requests_code ON channel_pairing_requests(channel_key, code);
    CREATE TABLE config_revision_keys (id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), hmac_key BLOB NOT NULL CHECK(length(hmac_key)=32)) STRICT;
    CREATE TABLE audit_identity_keys (id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), key_id TEXT NOT NULL, key BLOB NOT NULL, created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE exec_approvals_config (config_key TEXT NOT NULL PRIMARY KEY, raw_json TEXT NOT NULL, socket_path TEXT, has_socket_token INTEGER NOT NULL, default_security TEXT, default_ask TEXT, default_ask_fallback TEXT, auto_allow_skills INTEGER, agent_count INTEGER NOT NULL, allowlist_count INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE secret_store_entries (scope_kind TEXT NOT NULL CHECK(scope_kind IN ('team','identity')), scope_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('secret','env')), created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0), updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0), updated_by TEXT, deleted_at_ms INTEGER, allowed_hosts TEXT, CHECK((scope_kind='team' AND scope_id='') OR (scope_kind='identity' AND length(scope_id)>0)), PRIMARY KEY(scope_kind,scope_id,name)) STRICT;
    CREATE TABLE web_push_vapid_keys (key_id TEXT NOT NULL PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL, subject TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE native_hook_relay_bridges (relay_id TEXT NOT NULL PRIMARY KEY, pid INTEGER NOT NULL, hostname TEXT NOT NULL, port INTEGER NOT NULL, token TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE channel_ingress_events (queue_name TEXT NOT NULL, event_id TEXT NOT NULL, channel_id TEXT NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL, lane_key TEXT, payload_json TEXT NOT NULL, metadata_json TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claim_token TEXT, claim_owner TEXT, claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, last_error TEXT, failed_reason TEXT, failed_at INTEGER, completed_at INTEGER, completed_metadata_json TEXT, PRIMARY KEY(queue_name, event_id)) STRICT;
    CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY);
    CREATE TABLE session_suggestions (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, author_id TEXT NOT NULL, author_label TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','accepted','dismissed')), dispatch_token TEXT, dispatch_started_at INTEGER, dispatch_resolution TEXT CHECK(dispatch_resolution IN ('send','queue','edit','dismiss')), CHECK((dispatch_token IS NULL AND dispatch_started_at IS NULL AND dispatch_resolution IS NULL) OR (dispatch_token IS NOT NULL AND dispatch_started_at IS NOT NULL AND dispatch_resolution IS NOT NULL)), FOREIGN KEY(session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE) STRICT;`);
  const markers = Object.fromEntries(["private", "auth", "origin", "bootstrap-a", "bootstrap-b", "paired", "join-code", "join-token", "channel-code", "vapid", "relay", "exec", "store-team", "store-identity", "store-deleted", "legacy-vapid", "deleted"].map((name) => [name, `fixture-${name}-material`]));
  const hmac = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 101));
  const audit = Buffer.from(Array.from({ length: 32 }, (_, index) => 231 - index));
  const scopes = '["operator.read"]';
  source.prepare("INSERT INTO device_identities VALUES ('primary', 'device', 'public', ?, 1, 2)").run(markers.private);
  source.prepare("INSERT INTO device_auth_tokens VALUES ('device', 'operator', ?, ?, 3)").run(markers.auth, scopes);
  source.prepare("INSERT INTO gateway_origin_device_tokens VALUES ('local', 'device', 'operator', ?, ?, 4)").run(markers.origin, scopes);
  for (const [index, token] of [markers["bootstrap-a"], markers["bootstrap-b"]].entries()) source.prepare("INSERT INTO device_bootstrap_tokens VALUES (?, ?, ?, 5, 'device', 'public', ?, ?, NULL, 6, NULL)").run(token, token, `setup-${index}`, '{"roles":["operator"],"scopes":[]}', '{"roles":[],"scopes":[]}');
  const roles = { operator: { token: markers.paired, scopes: ["operator.read"], createdAtMs: 7, issuer: { kind: "shared-gateway-auth", generation: "public-digest" } } };
  source.prepare("INSERT INTO device_pairing_paired(device_id,public_key,display_name,tokens_json,created_at_ms,approved_at_ms) VALUES ('device','public','paired',?,1,2)").run(JSON.stringify(roles));
  const payload = { url: "wss://gateway.example.invalid", bootstrapToken: markers["join-token"], expiresAtMs: 8, tlsFingerprint: "public-fingerprint" };
  source.prepare("INSERT INTO device_pairing_join_codes VALUES (?, ?, 7, 8)").run(markers["join-code"], JSON.stringify(payload));
  source.prepare("INSERT INTO channel_pairing_requests VALUES ('chat','default','request',?,'created','seen',?)").run(markers["channel-code"], '{"name":"person"}');
  source.prepare("INSERT INTO config_revision_keys VALUES (1, ?)").run(hmac);
  source.prepare("INSERT INTO audit_identity_keys VALUES (1, 'public-key-id', ?, 9)").run(audit);
  const vapid = { publicKey: "public-vapid", privateKey: markers.vapid, subject: "https://example.invalid" };
  source.prepare("INSERT INTO config_machine_state VALUES ('webPush.vapidKeys', ?, 10)").run(JSON.stringify(vapid));
  source.prepare("INSERT INTO config_machine_state VALUES ('ordinary', ?, 11)").run('{"privateKey":"ordinary user text","nested":{"token":"keep"}}');
  const approvals = { version: 1, socket: { path: "/tmp/fixture-approvals.sock", token: markers.exec }, defaults: { security: "allowlist", ask: "on-miss" }, agents: { main: { allowlist: [{ pattern: "/usr/bin/true" }] } } };
  source.prepare("INSERT INTO exec_approvals_config VALUES ('current', ?, '/tmp/fixture-approvals.sock', 1, 'allowlist', 'on-miss', NULL, NULL, 1, 1, 12)").run(JSON.stringify(approvals));
  for (const [scope, id, name, value, kind, deleted] of [
    ["team", "", "OPENCLAW_GATEWAY_TOKEN", markers["store-team"], "secret", null],
    ["identity", "person", "OTHER_NAME", markers["store-identity"], "secret", null],
    ["team", "", "RETIRED_GATEWAY_TOKEN", markers["store-deleted"], "secret", 15],
    ["team", "", "FIXTURE_GREETING", "ordinary environment value", "env", null]
  ]) source.prepare("INSERT INTO secret_store_entries VALUES (?, ?, ?, ?, ?, 1, 2, 'setup', ?, '[\"example.invalid\"]')").run(scope, id, name, value, kind, deleted);
  source.prepare("INSERT INTO web_push_vapid_keys VALUES ('default', 'legacy-public', ?, 'https://example.invalid', 13)").run(markers["legacy-vapid"]);
  source.prepare("INSERT INTO native_hook_relay_bridges VALUES ('relay',12,'localhost',1234,?,13,14)").run(markers.relay);
  for (const [id, claim] of [["active", "11111111-1111-4111-8111-111111111111"], ["idle", null]]) source.prepare("INSERT INTO channel_ingress_events(queue_name,event_id,channel_id,account_id,status,payload_json,received_at,updated_at,claim_token,claim_owner,claimed_at) VALUES ('queue',?,'chat','default',?, ?,1,2,?,?,?)").run(id, claim ? "claimed" : "pending", '{"message":"keep this content"}', claim, claim ? "fixture-owner" : null, claim ? 2 : null);
  source.exec("INSERT INTO session_nodes VALUES ('session'); INSERT INTO session_suggestions(id,session_key,author_id,text,created_at,state,dispatch_token,dispatch_started_at,dispatch_resolution) VALUES ('suggestion','session','person','Preserve this suggestion.',15,'pending','22222222-2222-4222-8222-222222222222',16,'send')");
  source.prepare("INSERT INTO events(rowid, value) VALUES (5, ?)").run(markers.deleted.repeat(1000));
  source.exec("DELETE FROM events WHERE rowid=5");
  const blob = Buffer.from([0, 1, 255]);
  source.prepare("UPDATE events SET content=? WHERE rowid=3").run(blob);
  const tables = source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  const rows = (db, table) => db.prepare(`SELECT rowid AS original_rowid, * FROM "${table}" ORDER BY rowid`).all();
  const before = Object.fromEntries(tables.map((table) => [table, rows(source, table)]));
  const expected = structuredClone(before);
  expected.device_identities[0].private_key_pem = "";
  expected.device_auth_tokens[0].token = expected.gateway_origin_device_tokens[0].token = "";
  for (const row of expected.device_bootstrap_tokens) { row.token_key = `redacted:${sha256(row.token_key)}`; row.token = ""; }
  expected.device_pairing_paired[0].tokens_json = JSON.stringify({ operator: { ...roles.operator, token: "" } });
  expected.device_pairing_join_codes[0].shortcode = "";
  expected.device_pairing_join_codes[0].payload_json = JSON.stringify({ ...payload, bootstrapToken: "" });
  expected.channel_pairing_requests[0].code = "";
  expected.config_revision_keys[0].hmac_key = new Uint8Array(32);
  expected.audit_identity_keys[0].key = new Uint8Array(32);
  expected.config_machine_state[0].value_json = JSON.stringify({ ...vapid, privateKey: "" });
  expected.exec_approvals_config[0].raw_json = JSON.stringify({ ...approvals, socket: { ...approvals.socket, token: "" } });
  for (const row of expected.secret_store_entries) if (row.kind === "secret") row.value = "";
  expected.web_push_vapid_keys[0].private_key = "";
  expected.native_hook_relay_bridges[0].token = "";
  const output = join(directory, "initial-state");
  // A logging destination declaration cannot turn an existing credential
  // database into an unfiltered byte copy, even before any grant is observed.
  const attachmentLogs = createAttachmentLogFilter();
  t.after(() => attachmentLogs.dispose());
  const policy = { ...await createStateTextPolicy({ stateDirectory: state }), observedLogs: [{ ...attachmentLogs.snapshot(), paths: [join(state, "openclaw.sqlite"), await realpath(join(state, "openclaw.sqlite"))], datedDirectories: [] }] };
  await snapshotState(state, ["openclaw.sqlite"], output, policy);
  const checkpoint = await writeCheckpoint({ phase: { id: "intent/pairing", checkpoint: ["state:openclaw.sqlite"] }, directory, results: [], stateDirectory: state, stateTextPolicy: policy });
  for (const file of [join(output, "openclaw.sqlite"), join(checkpoint.path, "state/openclaw.sqlite")]) {
    const bytes = await readFile(file);
    for (const marker of [...Object.values(markers).map((value) => Buffer.from(value)), hmac, audit]) assert.equal(bytes.includes(marker), false);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      for (const table of tables) assert.deepEqual(rows(copy, table).map((row) => ({ ...row })), expected[table], table);
      assert.deepEqual(copy.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check), ["ok"]);
    } finally { copy.close(); }
  }
  for (const table of tables) assert.deepEqual(rows(source, table), before[table], table);
  assert.equal((await readdir(state)).some((name) => name.startsWith(".kova-snapshot-")), false);
});

test("credential samples are removed from SQLite statistics without removing unrelated samples", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t), state = join(directory, "state");
  await mkdir(state);
  const source = new DatabaseSync(join(state, "openclaw.sqlite"));
  t.after(() => source.close());
  source.enableDefensive?.(false);
  source.exec(`CREATE TABLE device_auth_tokens(device_id TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, scopes_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(device_id,role)) STRICT;
    CREATE TABLE ordinary(value TEXT);
    CREATE INDEX credential_token ON device_auth_tokens(token);
    CREATE INDEX ordinary_index ON ordinary(value);
    PRAGMA writable_schema=ON;
    CREATE TABLE sqlite_stat2(tbl, idx, sampleno, sample);
    CREATE TABLE sqlite_stat3(tbl, idx, neq, nlt, ndlt, sample);
    CREATE TABLE sqlite_stat4(tbl, idx, neq, nlt, ndlt, sample);
    PRAGMA writable_schema=OFF;`);
  const marker = "fixture-statistics-token";
  source.prepare("INSERT INTO device_auth_tokens VALUES ('device','operator',?,'[]',1)").run(marker);
  for (const table of ["sqlite_stat2", "sqlite_stat3", "sqlite_stat4"]) {
    source.prepare(`INSERT INTO ${table}(tbl,idx,sample) VALUES ('device_auth_tokens','credential_token',?)`).run(Buffer.from(marker));
    source.prepare(`INSERT INTO ${table}(tbl,idx,sample) VALUES ('ordinary','ordinary_index',?)`).run(Buffer.from("preserved sample"));
  }
  const output = join(directory, "copy");
  await snapshotState(state, ["openclaw.sqlite"], output);
  const bytes = await readFile(join(output, "openclaw.sqlite"));
  assert.equal(bytes.includes(Buffer.from(marker)), false);
  const copy = new DatabaseSync(join(output, "openclaw.sqlite"), { readOnly: true });
  try {
    for (const table of ["sqlite_stat2", "sqlite_stat3", "sqlite_stat4"]) {
      const rows = copy.prepare(`SELECT tbl,sample FROM ${table}`).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tbl, "ordinary");
      assert.equal(Buffer.from(rows[0].sample).toString(), "preserved sample");
      assert.equal(source.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 2);
    }
  } finally { copy.close(); }
});

test("legacy credential JSON preserves metadata in primary and profile paths", async (t) => {
  const directory = await temporary(t), state = join(directory, "state"), output = join(directory, "copy");
  await mkdir(state);
  const markers = { pem: "legacy-private-pem", raw: "legacy-private-raw", auth: "legacy-auth-token", paired: "legacy-paired-token", first: "legacy-bootstrap-first", second: "legacy-bootstrap-second", exec: "legacy-exec-token", vapid: "legacy-vapid-key", channel: "ABCD2345", node: "legacy-node-token" };
  const roles = { operator: { token: markers.paired, role: "operator", scopes: ["operator.read"], createdAtMs: 7 } };
  const bootstrap = { [markers.first]: { token: markers.first, ts: 1, profile: { roles: ["node"], scopes: [] } }, [markers.second]: { token: markers.second, ts: 2, deviceId: "device" } };
  const redactedBootstrap = Object.fromEntries(Object.entries(bootstrap).map(([key, value]) => [`redacted:${sha256(key)}`, { ...value, token: "" }]));
  const approvals = { version: 1, socket: { path: "/tmp/fixture-approvals.sock", token: markers.exec }, agents: { main: { allowlist: [{ pattern: "/usr/bin/true" }] } } };
  const vapid = { publicKey: "public-vapid", privateKey: markers.vapid, subject: "https://example.invalid" };
  const pairing = { version: 1, requests: [{ id: "person", code: markers.channel, createdAt: "2026-10-15T00:00:00Z", lastSeenAt: "2026-10-15T00:00:01Z", meta: { name: "Fixture Person" } }] };
  const files = [
    ...["identity/device.json", "identity/device.json.doctor-importing", "identity/device.json.native-importing"].map((path) => [path, { version: 1, privateKeyPem: markers.pem, publicKeyPem: "public", deviceId: "device" }, { version: 1, privateKeyPem: "", publicKeyPem: "public", deviceId: "device" }]),
    ["identity/device-auth.json", { version: 1, deviceId: "device", tokens: { node: { token: markers.auth, role: "node", scopes: [] } } }, { version: 1, deviceId: "device", tokens: { node: { token: "", role: "node", scopes: [] } } }],
    ...["devices/paired.json", "devices/paired.json.migrated"].map((path) => [path, { device: { publicKey: "public", tokens: roles } }, { device: { publicKey: "public", tokens: { operator: { ...roles.operator, token: "" } } } }]),
    ...["devices/bootstrap.json", "devices/bootstrap.json.migrated"].map((path) => [path, bootstrap, redactedBootstrap]),
    ...["exec-approvals.json", "exec-approvals.json.doctor-importing", `exec-approvals.json.migrated.${sha256(JSON.stringify(approvals))}.12345678-1234-4234-8234-123456789012`].map((path) => [path, approvals, { ...approvals, socket: { ...approvals.socket, token: "" } }]),
    ...["push/vapid-keys.json", "push/vapid-keys.json.doctor-importing"].map((path) => [path, vapid, { ...vapid, privateKey: "" }]),
    ["credentials/kova-chat-pairing.json", pairing, { ...pairing, requests: pairing.requests.map((request) => ({ ...request, code: "" })) }],
    ...["nodes/paired.json", "nodes/paired.json.migrated"].map((path) => [path, { node: { token: markers.node, displayName: "Fixture node", caps: ["canvas"] } }, { node: { token: "", displayName: "Fixture node", caps: ["canvas"] } }]),
    ...["node.json", "node.json.doctor-importing"].map((path) => [path, { version: 1, nodeId: "node", token: markers.node, displayName: "Fixture node" }, { version: 1, nodeId: "node", token: "", displayName: "Fixture node" }])
  ];
  const originals = new Map(), expected = new Map();
  for (const prefix of ["", "profiles/.openclaw-paired/"]) for (const [path, input, redacted] of files) {
    const target = `${prefix}${path}`;
    const value = prefix && path === "identity/device.json" ? { privateKey: markers.raw, publicKey: "public", deviceId: "device" } : input;
    const observed = prefix && path === "identity/device.json" ? { ...value, privateKey: "" } : redacted;
    await mkdir(dirname(join(state, target)), { recursive: true });
    const bytes = JSON.stringify(value);
    await writeFile(join(state, target), bytes);
    assert.deepEqual(JSON.parse(redactStateText(["rpc-file-alias", join(state, target)], Buffer.from(bytes), await createStateTextPolicy({ stateDirectory: state }))), observed, `Gateway file read: ${target}`);
    originals.set(target, bytes); expected.set(target, observed);
  }
  await writeFile(join(state, "ordinary.json"), '{"privateKey":"ordinary text","token":"ordinary payload"}');
  await symlink(join(state, "identity/device.json"), join(state, "identity-alias"));
  await symlink(join(state, "identity/device.json"), join(state, "openclaw.json"));
  await symlink(join(state, "exec-approvals.json.doctor-importing"), join(state, "exec-alias"));
  const documents = new Map([...files.map(([path]) => path), "openclaw.json", "openclaw-config-backup-example/original"].map((path) => [`agents/main/workspace/${path}`, ` {"token":"ordinary identifier","privateKey":"ordinary word","description":"${path}"}\n`]));
  for (const [path, text] of documents) { await mkdir(dirname(join(state, path)), { recursive: true }); await writeFile(join(state, path), text); }
  const selections = [...new Set(files.map(([path]) => path.split("/")[0])), "profiles", "ordinary.json", "identity-alias", "openclaw.json", "exec-alias", "agents"];
  await snapshotState(state, selections, output);
  const checkpoint = await writeCheckpoint({ phase: { id: "intent/legacy-pairing", checkpoint: selections.map((path) => `state:${path}`) }, directory, results: [], stateDirectory: state });
  for (const destination of [output, join(checkpoint.path, "state")]) {
    for (const [path, value] of expected) {
      const bytes = await readFile(join(destination, path));
      for (const marker of Object.values(markers)) assert.equal(bytes.includes(Buffer.from(marker)), false);
      assert.deepEqual(JSON.parse(bytes), value);
    }
    assert.deepEqual(await readJSON(join(destination, "identity-alias")), expected.get("identity/device.json"));
    assert.deepEqual(await readJSON(join(destination, "openclaw.json")), expected.get("identity/device.json"));
    assert.deepEqual(await readJSON(join(destination, "exec-alias")), expected.get("exec-approvals.json.doctor-importing"));
    assert.deepEqual(await readJSON(join(destination, "ordinary.json")), { privateKey: "ordinary text", token: "ordinary payload" });
    for (const [path, text] of documents) assert.ok(await readFile(join(destination, path), "utf8") === text, `ordinary document preserved: ${path}`);
  }
  for (const [path, bytes] of originals) assert.equal(await readFile(join(state, path), "utf8"), bytes);
});

test("generated hook configuration stays private in final captures and backups", async (t) => {
  const { automationHookConfiguration } = await import("../support/persona/make-automation-rows.mjs");
  const directory = await temporary(t), state = join(directory, "state"), output = join(directory, "copy");
  const marker = "synthetic-hook-fixture-value-0123456789";
  const config = automationHookConfiguration({ gateway: { mode: "local", bind: "loopback", auth: { token: "synthetic-gateway-token", password: "synthetic-gateway-password" }, remote: { token: "synthetic-remote-token", password: "synthetic-remote-password" } }, hooks: { internal: { enabled: true } }, note: { token: "ordinary text" } }, () => marker);
  const expected = { ...config, gateway: { ...config.gateway, auth: { token: "", password: "" }, remote: { token: "", password: "" } }, hooks: { ...config.hooks, token: "" } };
  const files = ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.last-good", "openclaw.json.pre-update", "openclaw.json.rejected.2026-10-15T00-00-00-000Z", "openclaw.json.clobbered.2026-10-15T00-00-00-000Z-01", "openclaw.json.kova-12345678-1234-4234-8234-123456789012", "openclaw.json.123.12345678-1234-4234-8234-123456789012.tmp", "openclaw-config-backup-example/original", "profiles/.openclaw-paired/openclaw.json5", "profiles/.openclaw-paired/openclaw.json5.last-good"];
  for (const path of files) {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), `// existing OpenClaw JSON5 configuration\n${JSON.stringify(config)}`);
    assert.deepEqual(JSON.parse(redactStateText([join(state, path), "rpc-config-alias"], `// existing OpenClaw JSON5 configuration\n${JSON.stringify(config)}`, await createStateTextPolicy({ stateDirectory: state }))), expected, `Gateway config read: ${path}`);
  }
  await symlink(join(state, "openclaw.json"), join(state, "config-alias"));
  const selections = [...files, "config-alias"];
  await snapshotState(state, selections, output);
  const phase = { id: "standard/snapshot", checkpoint: selections.map((path) => `state:${path}`) };
  const checkpoint = await writeCheckpoint({ phase, directory, results: [], stateDirectory: state });
  for (const destination of [output, join(checkpoint.path, "state")]) for (const path of selections) {
    const bytes = await readFile(join(destination, path), "utf8");
    assert.equal(bytes.includes(marker), false);
    assert.deepEqual(JSON.parse(bytes), expected);
  }
  for (const path of files) assert.ok((await readFile(join(state, path), "utf8")).includes(marker));
});

test("declared private-key files are omitted while PEM documentation stays byte-identical", async (t) => {
  const { rootCertificates } = await import("node:tls");
  const directory = await temporary(t), state = join(directory, "state"), output = join(directory, "copy");
  const { generateKeyPairSync } = await import("node:crypto");
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const fingerprintKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
  const certificate = rootCertificates[0];
  assert.equal(typeof certificate, "string");
  const files = new Map([
    ["config-journal-fingerprint.key", fingerprintKey],
    ["profiles/.openclaw-paired/config-journal-fingerprint.key", fingerprintKey],
    ["gateway/tls/gateway-key.pem", Buffer.from(privateKey)],
    ["gateway/tls/.openclaw-gateway-tls-key-fixture/key.pem", Buffer.from(privateKey)],
    ["agents/main/tls-material.dat", Buffer.from(privateKey)],
    ["agents/main/.openclaw-gateway-tls-key-fixture/key.pem", Buffer.from(privateKey)],
    ["debug-proxy/certs/root-ca-key.pem", Buffer.from(privateKey)],
    ["debug-proxy/certs/.root-ca-fixture/root-ca-key.pem", Buffer.from(privateKey)],
    ["secret-egress-proxy/gateway-fixture/leaf-key.pem", Buffer.from(privateKey)],
    ["configured/public-certificate.pem", Buffer.from(certificate)],
    ["ordinary.bin", Buffer.from([255, 0, 1, 2, 254])],
    ["notes.txt", Buffer.from("The text token and privateKey describe ordinary user content.")],
    ["guide.md", Buffer.from("A private key may begin with -----BEGIN PRIVATE KEY-----; this document contains no key.\n")],
    ["other-guide.md", Buffer.from("Another explanation of -----BEGIN PRIVATE KEY-----; preserve this different document.\n")],
    ...["workspace/examples/gateway/tls/gateway-key.pem", "workspace/docs/gateway/tls/gateway-key.pem", "workspace/config-journal-fingerprint.key", "workspace/debug-proxy/certs/root-ca-key.pem", "workspace/.openclaw-gateway-tls-key-example/key.pem"].map((path) => [path, Buffer.from("Documentation example: -----BEGIN PRIVATE KEY----- is PEM syntax, not key material.\n")])
  ]);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), bytes);
  }
  await symlink(join(state, "config-journal-fingerprint.key"), join(state, "fingerprint-alias"));
  await symlink(join(state, "gateway/tls/gateway-key.pem"), join(state, "pem-alias"));
  await symlink(join(state, "agents/main/tls-material.dat"), join(state, "configured-alias"));
  const selections = [...files.keys(), "fingerprint-alias", "pem-alias", "configured-alias"];
  const omitted = new Set([...files.keys()].filter((path) => !path.startsWith("workspace/") && (path.startsWith("gateway/") || path.startsWith("agents/") || path.startsWith("debug-proxy/") || path.startsWith("secret-egress-proxy/") || path.endsWith("config-journal-fingerprint.key"))));
  for (const path of ["fingerprint-alias", "pem-alias", "configured-alias"]) omitted.add(path);
  const config = { stateDirectory: state, homeDirectory: directory, cwd: state, gateway: { tls: { keyPath: join(state, "agents/main/tls-material.dat") } } };
  const stateTextPolicy = await createStateTextPolicy(config);
  await snapshotState(state, selections, output, stateTextPolicy);
  const checkpoint = await writeCheckpoint({ phase: { id: "intent/private-key-files", checkpoint: selections.map((path) => `state:${path}`) }, directory, results: [], stateDirectory: state, stateTextPolicy });
  for (const destination of [output, join(checkpoint.path, "state")]) for (const path of selections) {
    const captured = await readFile(join(destination, path));
    if (omitted.has(path)) assert.equal(captured.length, 0, path);
    else assert.ok(captured.equals(files.get(path)), path);
  }
  assert.equal(redactStateText(["rpc-alias", join(state, "config-journal-fingerprint.key")], fingerprintKey, stateTextPolicy), "");
  assert.equal(redactStateText([join(state, "gateway/tls/gateway-key.pem")], privateKey, stateTextPolicy), "");
  assert.equal(redactStateText(["/unrelated/gateway/tls/gateway-key.pem"], privateKey, stateTextPolicy), null);
  for (const keyPath of [" agents/main/tls-material.dat ", "~/state/agents/main/tls-material.dat", join(state, "configured-alias")]) {
    const policy = await createStateTextPolicy({ ...config, gateway: { tls: { keyPath } } });
    for (const root of [state, await realpath(state)]) assert.ok(redactStateText([join(root, "agents/main/tls-material.dat")], privateKey, policy) === "", "declared keys match logical and physical identities");
  }
  const stateAlias = join(directory, "state-alias");
  await symlink(state, stateAlias, "dir");
  const aliasPolicy = await createStateTextPolicy({ ...config, stateDirectory: stateAlias, cwd: stateAlias, gateway: { tls: { keyPath: join(stateAlias, "configured-alias") } } });
  for (const root of [stateAlias, state, await realpath(state)]) assert.ok(redactStateText([join(root, "agents/main/tls-material.dat")], privateKey, aliasPolicy) === "", "a symlinked declaration retains every known equivalent target identity");
  for (const path of [join(state, "profiles/.openclaw-paired/agents/main/tls-material.dat"), join(directory, "other-state/agents/main/tls-material.dat"), join(stateAlias, "workspace/agents/main/tls-material.dat")]) assert.ok(redactStateText([path], "ordinary document", aliasPolicy) === null, "distinct state and workspace paths are not aliases");
  const futurePolicy = await createStateTextPolicy({ ...config, stateDirectory: stateAlias, gateway: { tls: { keyPath: join(stateAlias, "agents/main/future-key.dat") } } });
  assert.ok(redactStateText([join(await realpath(state), "agents/main/future-key.dat")], "synthetic future key", futurePolicy) === "", "declarations retain equivalent identities before the key exists");
  const profileTarget = join(state, "profile-target"), profileAlias = join(state, "profiles/.openclaw-linked");
  await mkdir(join(profileTarget, "identity"), { recursive: true });
  const identity = JSON.stringify({ privateKeyPem: privateKey, publicKeyPem: "public", deviceId: "linked-profile" });
  const expectedIdentity = JSON.stringify({ privateKeyPem: "", publicKeyPem: "public", deviceId: "linked-profile" });
  await writeFile(join(profileTarget, "identity/device.json"), identity);
  await symlink(profileTarget, profileAlias, "dir");
  const danglingProfile = join(state, "profiles/.openclaw-missing");
  await symlink(join(state, "missing-profile"), danglingProfile, "dir");
  const profilePolicy = await createStateTextPolicy(config);
  assert.ok(!profilePolicy.roots.includes(danglingProfile), "dangling profile links do not declare state directories");
  for (const root of [profileAlias, profileTarget, await realpath(profileTarget)]) assert.ok(redactStateText([join(root, "identity/device.json")], identity, profilePolicy) === expectedIdentity, "a profile directory alias retains its legacy credential policy");
  assert.ok(redactStateText([join(state, "profile-target-other/identity/device.json")], "ordinary document", profilePolicy) === null, "unrelated directories do not become profile roots");
  const profileOutput = join(directory, "profile-copy");
  await snapshotState(state, ["profiles/.openclaw-linked"], profileOutput, profilePolicy);
  assert.ok((await readFile(join(profileOutput, "profiles/.openclaw-linked/identity/device.json"), "utf8")).trim() === expectedIdentity, "snapshot follows the owned alias without retaining its private key");
  const fragment = '{"token":"synthetic-config-token","enabled":false}';
  await writeFile(join(state, "config-fragment.json"), fragment);
  await symlink(join(state, "config-fragment.json"), join(state, "include-alias.json"));
  const fragmentPolicy = await createStateTextPolicy({ ...config, stateDirectory: stateAlias, configurations: [{ path: join(stateAlias, "include-alias.json"), at: ["hooks"] }] });
  for (const path of [join(stateAlias, "include-alias.json"), join(state, "config-fragment.json"), join(await realpath(state), "config-fragment.json")]) assert.ok(redactStateText([path], fragment, fragmentPolicy) === '{"token":"","enabled":false}', "declared include aliases retain their logical and physical target identities");
  assert.ok(redactStateText([join(state, "workspace/config-fragment.json")], "ordinary document", fragmentPolicy) === null, "matching config basenames outside the declaration remain ordinary data");
  assert.equal(redactStateText(["rpc-certificate.pem"], certificate), null);
  for (const path of ["guide.md", "other-guide.md"]) assert.equal(redactStateText([path], files.get(path)), null);
  assert.notDeepEqual(await readFile(join(output, "guide.md")), await readFile(join(output, "other-guide.md")));
  for (const [path, bytes] of files) assert.ok((await readFile(join(state, path))).equals(bytes), `source unchanged: ${path}`);
});

test("Gateway credential references remain metadata without resolving providers", async (t) => {
  const directory = await temporary(t), state = join(directory, "state");await mkdir(state);
  const references = [
    { source: "env", provider: "default", id: "KOVA_TEST_TOKEN" },
    { source: "file", provider: "fixture", id: "/tokens/value" },
    { source: "exec", provider: "fixture", id: "tokens/current" },
    { source: "store", provider: "default", id: "KOVA_TEST_TOKEN" },
    "${KOVA_TEST_TOKEN}", "${_KOVA_TEST_TOKEN}", "${" + "A".repeat(129) + "}"
  ];
  for (const [index, token] of references.entries()) {
    const config = { gateway: { auth: { mode: "token", token }, remote: { password: token } } };
    await writeFile(join(state, "openclaw.json"), JSON.stringify(config));
    const output = join(directory, `reference-${index}`);
    await snapshotState(state, ["openclaw.json"], output);
    assert.deepEqual(await readJSON(join(output, "openclaw.json")), config);
  }
});

test("malformed known legacy credential files cannot publish raw JSON", async (t) => {
  const directory = await temporary(t), state = join(directory, "state");
  for (const [index, [path, bytes]] of [
    ["openclaw.json", "not JSON"],
    ["openclaw.json", '{"gateway":{"auth":{"token":{"source":"env","provider":"default","id":"KOVA_TEST_TOKEN","value":"private-material"}}}}'],
    ["openclaw.json.bak", '{"hooks":{"token":{"nested":"material"}}}'],
    ["openclaw.json.last-good", "not JSON"],
    ["identity/device.json", "not JSON"],
    ["identity/device.json", '{"privateKeyPem":{"nested":"material"}}'],
    ["identity/device.json.native-importing", '{"privateKey":[]}'],
    ["identity/device-auth.json", '{"tokens":[]}'],
    ["devices/paired.json.migrated", '{"device":{"tokens":{"operator":[]}}}'],
    ["profiles/.openclaw-paired/devices/bootstrap.json", '{"material":{"token":42}}'],
    ["exec-approvals.json.doctor-importing", '{"version":1,"socket":{"token":[]}}'],
    ["push/vapid-keys.json", '{"privateKey":false}'],
    ["credentials/kova-chat-pairing.json", '{"version":1,"requests":[{"id":"person","code":[]}]}'],
    ["nodes/paired.json.migrated", '{"node":{"token":42}}'],
    ["node.json", '{"token":{}}']
  ].entries()) {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), bytes);
    const phase = { id: `intent/malformed-${index}`, checkpoint: [`state:${path}`] };
    const policy = await createStateTextPolicy({ stateDirectory: state });
    assert.throws(() => redactStateText(["rpc-file-alias", join(state, path)], bytes, policy), /cannot capture malformed credential metadata/);
    await assert.rejects(writeCheckpoint({ phase, directory, results: [], stateDirectory: state }), /cannot capture malformed credential metadata/);
    await assert.rejects(readdir(join(directory, "checkpoints", phase.id)), { code: "ENOENT" });
    assert.equal(await readFile(join(state, path), "utf8"), bytes);
  }
});

test("explicit SQLite sidecar selections cannot retain original pairing bytes", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t), state = join(directory, "state");
  await mkdir(state);
  const source = new DatabaseSync(join(state, "openclaw.sqlite"));
  t.after(() => source.close());
  source.exec("PRAGMA journal_mode=WAL; CREATE TABLE device_identities(private_key_pem TEXT, public_key TEXT)");
  const marker = "fixture-explicit-wal-private-material";
  source.prepare("INSERT INTO device_identities VALUES (?, 'public')").run(marker);
  assert.equal((await readFile(join(state, "openclaw.sqlite-wal"))).includes(Buffer.from(marker)), true);
  const paths = ["openclaw.sqlite", "openclaw.sqlite-wal", "openclaw.sqlite-shm"];
  const initial = join(directory, "initial");
  await snapshotState(state, paths, initial);
  const checkpoint = await writeCheckpoint({ phase: { id: "intent/explicit-sidecars", checkpoint: paths.map((path) => `state:${path}`) }, directory, results: [], stateDirectory: state });
  for (const output of [initial, join(checkpoint.path, "state")]) {
    assert.deepEqual(await readdir(output), ["openclaw.sqlite"]);
    assert.equal((await readFile(join(output, "openclaw.sqlite"))).includes(Buffer.from(marker)), false);
    const copy = new DatabaseSync(join(output, "openclaw.sqlite"), { readOnly: true });
    try { assert.deepEqual({ ...copy.prepare("SELECT * FROM device_identities").get() }, { private_key_pem: "", public_key: "public" }); }
    finally { copy.close(); }
  }
  assert.equal(source.prepare("SELECT private_key_pem FROM device_identities").get().private_key_pem, marker);
});

test("persistent rollback journals remain private after their headers are cleared", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t), state = join(directory, "state");
  await mkdir(state);
  const source = new DatabaseSync(join(state, "openclaw.sqlite"));
  t.after(() => source.close());
  source.exec("PRAGMA journal_mode=PERSIST; CREATE TABLE events(value TEXT)");
  const marker = "fixture-persistent-journal-private-material";
  source.prepare("INSERT INTO events VALUES (?)").run(marker);
  source.exec("UPDATE events SET value='current value'");
  const journal = await readFile(join(state, "openclaw.sqlite-journal"));
  assert.equal(journal.includes(Buffer.from(marker)), true);
  assert.deepEqual(journal.subarray(0, 8), Buffer.alloc(8));
  await symlink(join(state, "openclaw.sqlite-journal"), join(state, "journal-alias"));
  const renamed = Buffer.from(journal);
  Buffer.from("d9d505f920a163d7", "hex").copy(renamed);
  await writeFile(join(state, "renamed-journal-pages"), renamed);
  await writeFile(join(state, "notes-journal"), "ordinary journal notes");
  const caseName = "OPENCLAW.SQLITE-JOURNAL", original = await stat(join(state, "openclaw.sqlite-journal"));
  const caseFile = await stat(join(state, caseName)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const sameJournal = caseFile?.dev === original.dev && caseFile?.ino === original.ino;
  if (!sameJournal) await writeFile(join(state, caseName), "ordinary differently cased journal notes");
  const output = join(directory, "copy");
  await snapshotState(state, ["openclaw.sqlite", "openclaw.sqlite-journal", caseName, "journal-alias", "renamed-journal-pages", "notes-journal"], output);
  assert.deepEqual((await readdir(output)).sort(), [...(sameJournal ? [] : [caseName]), "notes-journal", "openclaw.sqlite"].sort());
  if (!sameJournal) assert.equal(await readFile(join(output, caseName), "utf8"), "ordinary differently cased journal notes");
  for (const name of await readdir(output)) assert.equal((await readFile(join(output, name))).includes(Buffer.from(marker)), false);
  assert.equal(await readFile(join(output, "notes-journal"), "utf8"), "ordinary journal notes");
  const copy = new DatabaseSync(join(output, "openclaw.sqlite"), { readOnly: true });
  try { assert.equal(copy.prepare("SELECT value FROM events").get().value, "current value"); }
  finally { copy.close(); }
  assert.equal(source.prepare("SELECT value FROM events").get().value, "current value");
});

test("SQLite sidecar aliases are omitted while ordinary sidecar-named files and hard links survive", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t), state = join(directory, "state");
  await mkdir(state);
  const source = new DatabaseSync(join(state, "openclaw.sqlite"));
  t.after(() => source.close());
  source.exec("PRAGMA journal_mode=WAL; CREATE TABLE device_identities(private_key_pem TEXT)");
  const marker = "fixture-aliased-wal-private-material";
  source.prepare("INSERT INTO device_identities VALUES (?)").run(marker);
  await symlink(join(state, "openclaw.sqlite-wal"), join(state, "wal-alias"));
  await symlink(join(state, "openclaw.sqlite-shm"), join(state, "shm-alias"));
  await link(join(state, "openclaw.sqlite-wal"), join(state, "renamed-wal-pages"));
  await writeFile(join(state, "notes-wal"), "ordinary text");
  await link(join(state, "notes-wal"), join(state, "notes-link"));
  await writeFile(join(state, "plain"), "not a database");
  await writeFile(join(state, "plain-shm"), "ordinary side file");
  const output = join(directory, "copy");
  await snapshotState(state, ["wal-alias", "shm-alias", "renamed-wal-pages", "notes-wal", "notes-link", "plain-shm"], output);
  assert.deepEqual((await readdir(output)).sort(), ["notes-link", "notes-wal", "plain-shm"]);
  for (const name of await readdir(output)) assert.equal((await readFile(join(output, name))).includes(Buffer.from(marker)), false);
  assert.equal(await readFile(join(output, "notes-wal"), "utf8"), "ordinary text");
  assert.equal(await readFile(join(output, "notes-link"), "utf8"), "ordinary text");
  assert.equal(await readFile(join(output, "plain-shm"), "utf8"), "ordinary side file");
  assert.equal(source.prepare("SELECT private_key_pem FROM device_identities").get().private_key_pem, marker);
});

test("damaged declared credential databases fail capture while ordinary corrupt fixtures remain observable", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t), state = join(await realpath(directory), "state");
  const selected = "profiles/.openclaw-verify-cli/state/openclaw.sqlite", path = join(state, selected);
  const marker = "synthetic-damaged-profile-token-marker";
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE device_auth_tokens(device_id TEXT NOT NULL,role TEXT NOT NULL,token TEXT NOT NULL,scopes_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(device_id,role)) STRICT");
    database.prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)").run("device", "operator", marker, "[]", 1);
  } finally { database.close(); }
  const healthy = await readFile(path), damaged = Buffer.from(healthy); damaged[0] = 0;
  const paths = [selected, "state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite",
    `${selected}.corrupt-123.1`, `${selected}.pre-startup-migration-11111111-1111-4111-8111-111111111111.bak`,
    `${selected}.pre-exec-approvals-migration-11111111-1111-4111-8111-111111111111.bak`,
    `${selected}.doctor-gateway-token.11111111-1111-4111-8111-111111111111.bak`,
    "state/openclaw-index-recovery-abc/database.sqlite", "state/openclaw-task-delivery-recovery-abc/database.sqlite",
    "agents/main/agent/.sqlite-snapshot-abc/database.sqlite"];
  for (const [index, name] of paths.entries()) {
    const file = join(state, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, healthy);
    const capture = (kind) => writeCheckpoint({ phase: { id: `intent/${kind}-${index}`, checkpoint: [`state:${name}`] }, directory, results: [], stateDirectory: state });
    const saved = await capture("healthy");
    assert.equal((await readFile(join(saved.path, "state", name))).includes(Buffer.from(marker)), false);
    assert.deepEqual(await readFile(file), healthy);
    await writeFile(file, damaged);
    await assert.rejects(capture("damaged"), /unreadable credential database/);
    await assert.rejects(readFile(join(directory, "checkpoints/intent", `damaged-${index}`, "state", name)), { code: "ENOENT" });
    assert.deepEqual(await readFile(file), damaged);
  }
  const sidecars = ["-wal", "-shm", "-journal", "-wal.corrupt-123.1", "-journal.orphaned-123-1"].map((suffix) => selected + suffix);
  for (const name of sidecars) await writeFile(join(state, name), Buffer.concat([Buffer.alloc(16), Buffer.from(marker)]));
  await snapshotState(state, sidecars, join(directory, "sidecars"));
  assert.deepEqual(await readdir(join(directory, "sidecars")), []);
  const ordinary = ["agents/main/agent/fixtures/corrupt-generation.sqlite", "agents/main/agent/fixtures/recovery-generation.sqlite.corrupt-123", "workspace/openclaw.sqlite"];
  for (const name of ordinary) { await mkdir(dirname(join(state, name)), { recursive: true }); await writeFile(join(state, name), "ordinary corrupt fixture\0bytes"); }
  await snapshotState(state, ordinary, join(directory, "ordinary"));
  for (const name of ordinary) assert.deepEqual(await readFile(join(directory, "ordinary", name)), await readFile(join(state, name)));
  const alias = join(state, "profiles/.OPENCLAW-VERIFY-CLI/STATE/OPENCLAW.SQLITE");
  const native = await stat(path), other = await stat(alias).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const same = native.dev === other?.dev && native.ino === other?.ino;
  if (!same) { await mkdir(dirname(alias), { recursive: true }); await writeFile(alias, "ordinary distinct database-name document"); }
  const aliasCapture = () => snapshotState(state, [relative(state, alias)], join(directory, "alias"));
  if (same) await assert.rejects(aliasCapture(), /unreadable credential database/);
  else { await aliasCapture(); assert.deepEqual(await readFile(join(directory, "alias", relative(state, alias))), await readFile(alias)); }
  await symlink(path, join(state, "database-alias"));
  await assert.rejects(snapshotState(state, ["database-alias"], join(directory, "symlink")), /unreadable credential database/);

  for (const bytes of [healthy, damaged]) for (const method of ["sessions.files.get", "sessions.files.assets"]) {
    await writeFile(path, bytes);
    const params = method === "sessions.files.get" ? { sessionKey: "agent:main:main", path } : { sessionKey: "agent:main:main", path: join(dirname(path), "page.html"), refs: ["openclaw.sqlite"] };
    requestSchemas.check(method, params);
    const result = await executeGatewayCall({ env: "copy", method, params, timeoutMs: 1000 }, {
      prepare: () => ({ envName: "copy", root: state, stateDir: state, runDir: state }), readGatewayConfiguration: () => ({}),
      connect: async () => ({ client: { close() {}, request: async () => method === "sessions.files.get"
        ? { file: { path, content: bytes.toString("base64"), contentEncoding: "base64" } }
        : { assets: [{ ref: "openclaw.sqlite", content: bytes.toString("base64") }] } } })
    });
    assert.notEqual(result.exitCode, 0); assert.equal(result.output.result, null);
    assert.match(result.output.error, /filtered state snapshot/);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
});

test("unsupported pairing schemas fail before evidence is written and remove private exports", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t), state = join(directory, "state");
  await mkdir(state);
  const source = new DatabaseSync(join(state, "openclaw.sqlite"));
  t.after(() => source.close());
  source.exec(`CREATE TABLE DEVICE_PAIRING_PAIRED(device_id TEXT NOT NULL PRIMARY KEY,public_key TEXT NOT NULL,tokens_json TEXT,created_at_ms INTEGER NOT NULL,approved_at_ms INTEGER NOT NULL) STRICT;
    INSERT INTO device_pairing_paired VALUES ('device','public','{"operator":{"token":"fixture-material"}}',1,2);
    CREATE TRIGGER pairing_change AFTER UPDATE ON device_pairing_paired BEGIN SELECT 1; END;`);
  const capture = () => snapshotState(state, ["openclaw.sqlite"], join(directory, "copy"));
  await assert.rejects(capture(), /cannot safely capture credential metadata schema/);
  assert.deepEqual(await readdir(join(directory, "copy")), []);
  source.exec("DROP TRIGGER pairing_change; UPDATE device_pairing_paired SET tokens_json='invalid'");
  await assert.rejects(capture(), /cannot capture malformed credential metadata/);
  assert.deepEqual(await readdir(join(directory, "copy")), []);
  source.exec("DROP TABLE device_pairing_paired; CREATE VIRTUAL TABLE device_pairing_paired USING fts5(tokens_json)");
  await assert.rejects(capture(), /cannot safely capture credential metadata schema/);
  assert.deepEqual(await readdir(join(directory, "copy")), []);
  source.exec("DROP TABLE device_pairing_paired; CREATE TABLE device_pairing_join_codes(shortcode TEXT,payload_json TEXT,created_at_ms INTEGER,expires_at_ms INTEGER) STRICT; INSERT INTO device_pairing_join_codes VALUES ('code','{\"bootstrapToken\":[]}',1,2)");
  await assert.rejects(capture(), /cannot capture malformed credential metadata/);
  assert.deepEqual(await readdir(join(directory, "copy")), []);
  source.exec("DROP TABLE device_pairing_join_codes; CREATE TABLE config_machine_state(state_key TEXT NOT NULL PRIMARY KEY,value_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL) STRICT; INSERT INTO config_machine_state VALUES ('webPush.vapidKeys','{\"privateKey\":42}',1)");
  await assert.rejects(capture(), /cannot capture malformed credential metadata/);
  assert.deepEqual(await readdir(join(directory, "copy")), []);
  source.exec("DROP TABLE config_machine_state; CREATE TABLE exec_approvals_config(config_key TEXT NOT NULL PRIMARY KEY,raw_json TEXT NOT NULL) STRICT; INSERT INTO exec_approvals_config VALUES ('current','{\"version\":1,\"socket\":{\"token\":42}}')");
  await assert.rejects(capture(), /cannot capture malformed credential metadata/);
  assert.deepEqual(await readdir(join(directory, "copy")), []);
  assert.equal(source.prepare("SELECT raw_json FROM exec_approvals_config").get().raw_json, '{"version":1,"socket":{"token":42}}');
  source.exec("DROP TABLE exec_approvals_config; CREATE TABLE secret_store_entries(value TEXT NOT NULL) STRICT; INSERT INTO secret_store_entries VALUES ('fixture-secret')");
  await assert.rejects(capture(), /cannot safely capture credential metadata schema/);
  assert.deepEqual(await readdir(join(directory, "copy")), []);
  assert.equal((await readdir(state)).some((name) => name.startsWith(".kova-snapshot-")), false);
});

test("state directory selection deduplicates children, skips WAL side files and refuses escapes", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await temporary(t);
  const state = join(directory, "state");
  await mkdir(join(state, "agents"), { recursive: true });
  const database = new DatabaseSync(join(state, "agents/events.sqlite"));
  t.after(() => database.close());
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE events (id INTEGER PRIMARY KEY); INSERT INTO events VALUES (1)");
  await snapshotState(state, ["agents/events.sqlite", "agents"], join(directory, "copy"));
  assert.deepEqual(await readdir(join(directory, "copy/agents")), ["events.sqlite"]);
  await assert.rejects(snapshotState(state, ["../outside"], join(directory, "refused")), /invalid checkpoint state path/);
  await symlink(directory, join(state, "escape"));
  await assert.rejects(snapshotState(state, ["escape"], join(directory, "refused")), /escapes OpenClaw state/);
  await symlink(join(state, "agents"), join(state, "agents/cycle"));
  await assert.rejects(snapshotState(state, ["agents"], join(directory, "refused")), /directory cycle/);
});

test("a failed capture publishes no checkpoint and a recorded checkpoint is never overwritten", async (t) => {
  const directory = await temporary(t);
  const phase = { id: "intent/capture", browser: true, checkpoint: ["screen"] };
  await assert.rejects(writeCheckpoint({ phase, directory, results: [] }), /requires a browser screenshot/);
  assert.deepEqual(await readdir(join(directory, "checkpoints/intent")), []);
  phase.checkpoint = [];
  const result = await writeCheckpoint({ phase, directory, results: [] });
  await assert.rejects(writeCheckpoint({ phase, directory, results: [{ command: "bad", status: 2, stdout: "", stderr: "", durationMs: 0 }] }));
  assert.deepEqual(await readJSON(join(result.path, "commands.json")), []);
});

test("logs advance by byte offset and recover after rotation or truncation", async (t) => {
  const directory = await temporary(t);
  const file = join(directory, "gateway.log");
  const collect = createLogCollector([file]);
  assert.equal(await collect(), "");
  await writeFile(file, "one\n");
  assert.equal(await collect(), "one\n");
  assert.equal(await collect(), "");
  await appendFile(file, "two\n");
  assert.equal(await collect(), "two\n");
  await rename(file, `${file}.old`);
  await writeFile(file, "new\n");
  assert.equal(await collect(), "new\n");
  await writeFile(file, "x\n");
  assert.equal(await collect(), "x\n");
});

async function fixture(t, { withWithheld = false } = {}) {
  const root = await temporary(t), source = join(root, "source"), kova = join(root, "kova");
  await mkdir(source); await mkdir(join(kova, "catalogue"), { recursive: true }); await mkdir(join(kova, "verify"));
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Kova"); git("config", "user.email", "kova@example.invalid"); git("config", "commit.gpgsign", "false");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.2" }));
  git("add", "."); git("commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  const catalogue = await readJSON(join(repoRoot, "catalogue/openclaw.json"));
  await writeFile(join(kova, "catalogue/openclaw.json"), JSON.stringify(catalogue));
  await writeFile(join(kova, "package.json"), '{"version":"1.0.0"}');
  await writeFile(join(kova, "verify/standard.json"), '{"stateIds":[],"compressed":[]}');
  const definition = {
    schema: "kova.verify.persona.v1", id: "test", title: "Configured copy", objective: "Keep checked configuration across runtime changes.",
    runtime: { selector: "npm:2026.9.9", policy: "Pin the exported runtime and its package integrity." }, credentials: [],
    traits: [{ id: "configured", content: "A configured environment.", keys: {}, needs: [], builder: ["ocm @{env} -- status --json"], check: "ocm @{env} -- status --json" }]
  };
  if (withWithheld) definition.traits.push(
    { ...structuredClone(definition.traits[0]), id: "newer-content", minimumRuntime: "2026.10.3", needs: ["configured"] },
    { ...structuredClone(definition.traits[0]), id: "newer-dependent", needs: ["newer-content"] }
  );
  const definitionBytes = JSON.stringify(definition), archive = join(root, "persona.tar");
  await writeFile(join(root, "definition.json"), definitionBytes); await writeFile(archive, "archive");
  const integrity = `sha512-${Buffer.alloc(64, 0x42).toString("base64")}`;
  const manifest = { schema: "kova.verify.persona-manifest.v1", persona: "test", version: "20261014T000000Z", runtime: { selector: "npm:2026.9.9", resolved: `2026.9.9@${integrity}` }, env: { name: "durable", export: archive, includeState: true, sha256: sha256("archive") }, definition: { path: join(root, "definition.json"), sha256: sha256(definitionBytes) }, traits: { configured: { keys: {}, checkedAt: "2026-10-14T00:00:00Z" } }, doctor: "fixture doctor output" };
  if (withWithheld) manifest.withheldTraits = {
    "newer-content": { minimumRuntime: "2026.10.3", reason: "requires OpenClaw 2026.10.3; bound runtime is 2026.9.9" },
    "newer-dependent": { minimumRuntime: "2026.10.3", reason: "requires OpenClaw 2026.10.3; bound runtime is 2026.9.9; withheld dependencies: newer-content", dependencies: ["newer-content"] }
  };
  const manifestBytes = JSON.stringify(manifest), manifestPath = join(root, "persona.json");
  await writeFile(manifestPath, manifestBytes);
  const phases = ["use-target", "second"].map((name) => ({ id: `standard/${name}`, from: "standard", commands: [name === "use-target" ? "ocm start {env} --runtime {target} --no-service --json" : "ocm @{env} -- status --json"], checkpoint: ["responses", "timing", "logs"], timeoutMs: 5000 }));
  const plan = { schema: "kova.verify.plan.v1", change: { baseline: commit, change: commit }, persona: { manifest: manifestPath, sha256: sha256(manifestBytes) }, phases, phasesSha256: sha256(canonicalJSON(phases)) };
  const path = join(root, "plan.json");
  const save = () => writeFile(path, JSON.stringify({ ...plan, phasesSha256: sha256(canonicalJSON(plan.phases)) }));
  await save();
  const savePersona = async () => {
    const definitionBytes = JSON.stringify(definition);
    await writeFile(manifest.definition.path, definitionBytes);
    manifest.definition.sha256 = sha256(definitionBytes);
    const bytes = JSON.stringify(manifest);
    await writeFile(manifestPath, bytes);
    plan.persona.sha256 = sha256(bytes);
    await save();
  };
  const calls = [], created = [], removed = [];
  const bindings = new Map();
  let fail;
  const dependencies = {
    root: kova, home: join(root, "artifacts"), cleanupHandle: async () => {},
    execute: async (command) => {
      await checkGatewayCommand(command);
      calls.push(command);
      const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
      if (tokens[0] === "ocm" && tokens[1] === "start") bindings.set(tokens[2], tokens[tokens.indexOf("--runtime") + 1]);
      const shown = tokens[1] === "env" && tokens[2] === "show" ? JSON.stringify({ name: tokens[3], defaultRuntime: bindings.get(tokens[3]) }) : null;
      return { command, status: fail?.(command) ?? 0, stdout: shown ?? (command === "ocm --version" ? "0.3.3\n" : command === "ocm runtime list --json" ? "[]" : '{"ok":true}'), stderr: "", durationMs: 1, timedOut: false };
    },
    cloneFactory: ({ name, directory, executionEnv }) => ({
      directory, handles: new Set(),
      context: () => ({ env: name, run: directory, kovaRoot: kova, traits: {}, roots: [] }),
      async prepare() {
        assert.equal(executionEnv.KOVA_OPENCLAW_CONFIG_CONTRACT, "canonical");
        for (const key of ["OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_MCP_TOKEN", "OPENCLAW_TTS_PREFS", "OPENCLAW_CACHE_TRACE_FILE"]) assert.equal(executionEnv[key], "");
        created.push(name); await mkdir(join(directory, "state"), { recursive: true }); return { name, root: directory, stateDir: join(directory, "state") };
      },
      async cleanup() { removed.push(name); }
    })
  };
  return { root, source, catalogue, plan, definition, manifest, save, savePersona, calls, created, removed, dependencies, setFailure: (callback) => { fail = callback; }, options: { plan: path, targetBaseline: `local-build:${source}`, targetChange: `local-build:${source}` } };
}

test("dry run validates inputs without creating artifacts or calling OCM", async (t) => {
  const f = await fixture(t);
  const result = await runVerification(f.options, f.dependencies);
  assert.equal(result.execute, false);
  assert.equal(result.clones.length, 5);
  assert.deepEqual(f.calls, []);
  const cli = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "bin/kova.mjs"), "verify", "run", "--plan", f.options.plan, "--target-baseline", f.options.targetBaseline, "--target-change", f.options.targetChange, "--json"], { encoding: "utf8", env: { ...process.env, KOVA_HOME: join(f.root, "cli-home") } }));
  assert.equal(cli.execute, false);
  await assert.rejects(readdir(join(f.root, "cli-home")), { code: "ENOENT" });
  await assert.rejects(readdir(f.dependencies.home), { code: "ENOENT" });
  await writeFile(join(f.source, "dirty"), "changed");
  await assert.rejects(runVerification(f.options, f.dependencies), /uncommitted changes/);
});

test("execution refuses OCM transport before creating any state", async (t) => {
  const f = await fixture(t), previous = process.env.KOVA_OCM_TRANSPORT_JSON;
  try {
    process.env.KOVA_OCM_TRANSPORT_JSON = '{}';
    await assert.rejects(runVerification({ ...f.options, execute: true }, f.dependencies), /requires native OCM/);
    assert.deepEqual(f.calls, []);
    await assert.rejects(readdir(f.dependencies.home), { code: "ENOENT" });
    assert.equal((await runVerification(f.options, f.dependencies)).execute, false);
  } finally {
    if (previous === undefined) delete process.env.KOVA_OCM_TRANSPORT_JSON;
    else process.env.KOVA_OCM_TRANSPORT_JSON = previous;
  }
});

test("the final standard phase captures state without creating a raw OCM snapshot", async (t) => {
  const f = await fixture(t);
  const disposableRoot = join(f.root, "disposable-copies");
  const standard = await readJSON(join(repoRoot, "verify/standard.json"));
  const phase = { ...standard.after.find((item) => item.id === "snapshot"), id: "standard/snapshot", from: "standard" };
  assert.deepEqual(phase.commands, ["ocm env show {env} --json"]);
  phase.checkpoint = [...phase.checkpoint, "state:workspace"];
  f.plan.phases[1].commands = ["b", "c"].map((letter) => `ocm @{env} -- config set gateway.tls.keyPath ${quoteShell(disposableRoot)}/{env}/state/agents/key-${letter}.dat`);
  f.plan.phases.push(phase);
  await f.save();
  const makeClone = f.dependencies.cloneFactory;
  const guide = "The literal -----BEGIN PRIVATE KEY----- belongs in this documentation.\n";
  const policyReads = new Map(), copiedEnvs = new Map(), mutationObservations = new Map();
  const execute = f.dependencies.execute;
  f.dependencies.execute = async (command, options) => {
    const result = await execute(command, options), tokens = parseCatalogueCommand(command).tokens;
    if (tokens[3] === "config" && tokens[4] === "set") {
      const env = tokens[1].slice(1), metadata = copiedEnvs.get(env), config = await readJSON(join(metadata.stateDir, "openclaw.json"));
      const prior = config.gateway.tls.keyPath;
      assert.ok(JSON.parse(options.env.KOVA_VERIFY_STATE_POLICIES_JSON)[env].keys.includes(prior), "child context contains the declaration observed before mutation");
      await writeFile(tokens[6], `synthetic-${env}-rotated-key`);
      await writeFile(join(metadata.stateDir, "openclaw.json"), JSON.stringify({ gateway: { mode: "local", tls: { keyPath: tokens[6] } } }));
    }
    return result;
  };
  f.dependencies.cloneFactory = (options) => {
    const clone = makeClone(options), prepare = clone.prepare, context = clone.context, cleanup = clone.cleanup;
    const disposable = join(disposableRoot, options.name);
    let copied, policy;
    const remember = async () => {
      const config = await readJSON(join(copied.stateDir, "openclaw.json"));
      policy = mergeStateTextPolicies(policy, await createStateTextPolicy({ stateDirectory: copied.stateDir, homeDirectory: copied.root, cwd: copied.root, gateway: config.gateway }));
      return config.gateway.tls.keyPath;
    };
    clone.context = () => ({ ...context(), cwd: disposable, ownedRoots: [disposable], observeCredentialPaths: async () => {
      const prior = await remember();
      const history = mutationObservations.get(options.name) ?? [];
      history.push(prior); mutationObservations.set(options.name, history);
    } });
    clone.observeProductLogs = remember;
    clone.stateTextPolicies = () => policy ? { [options.name]: policy } : {};
    clone.prepare = async () => {
      const metadata = { ...await prepare(), root: disposable, stateDir: join(disposable, "state") };
      copied = metadata; copiedEnvs.set(options.name, metadata);
      await mkdir(join(metadata.stateDir, "agents"), { recursive: true });
      await writeFile(join(metadata.stateDir, "agents/state.json"), '{"observed":true}');
      await writeFile(join(metadata.stateDir, "agents/tls-material.dat"), "synthetic-configured-key");
      await mkdir(join(metadata.stateDir, "workspace/docs/gateway/tls"), { recursive: true });
      await writeFile(join(metadata.stateDir, "workspace/docs/gateway/tls/gateway-key.pem"), guide);
      await writeFile(join(metadata.stateDir, "openclaw.json"), JSON.stringify({ gateway: { mode: "local", tls: { keyPath: join(metadata.stateDir, "agents/tls-material.dat") } } }));
      return metadata;
    };
    clone.stateTextPolicy = async () => {
      policyReads.set(options.name, (policyReads.get(options.name) ?? 0) + 1);
      await remember(); return policy;
    };
    clone.cleanup = async () => { await cleanup(); await rm(disposable, { recursive: true, force: true }); };
    return clone;
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.incomplete, []);
  assert.deepEqual(result.cleanupErrors, []);
  assert.equal(f.calls.some((command) => parseCatalogueCommand(command).tokens.includes("snapshot")), false);
  for (const name of Object.keys(result.clones)) {
    await assert.rejects(readdir(join(disposableRoot, name)), { code: "ENOENT" });
    assert.equal(result.clones[name].phases[phase.id], "recorded");
    const checkpoint = join(f.dependencies.home, "verify", result.id, name, "checkpoints", phase.id);
    assert.deepEqual(await readJSON(join(checkpoint, "state/agents/state.json")), { observed: true });
    const stateDir = copiedEnvs.get(name).stateDir;
    assert.deepEqual(await readJSON(join(checkpoint, "state/openclaw.json")), { gateway: { mode: "local", tls: { keyPath: join(stateDir, "agents/key-c.dat") } } });
    assert.deepEqual(mutationObservations.get(name), [join(stateDir, "agents/tls-material.dat"), join(stateDir, "agents/key-b.dat")]);
    for (const letter of ["b", "c"]) assert.ok(await readFile(join(checkpoint, `state/agents/key-${letter}.dat`), "utf8") === "", "intermediate and current key paths remain protected");
    assert.equal((await readJSON(join(checkpoint, "responses.json")))[0].name, name);
    assert.equal(policyReads.get(name), 2, "initial and final state each request the current declaration");
    for (const state of [join(checkpoint, "state"), join(f.dependencies.home, "verify", result.id, name, "initial-state")]) {
      assert.equal(await readFile(join(state, "agents/tls-material.dat"), "utf8"), "");
      assert.equal(await readFile(join(state, "workspace/docs/gateway/tls/gateway-key.pem"), "utf8"), guide);
    }
  }
});

test("each command observes log destinations and an observation failure preserves later diagnostics", async (t) => {
  const f = await fixture(t);
  f.plan.phases[1].commands.push(...f.plan.phases[1].commands);
  f.plan.phases.push({ ...f.plan.phases[1], id: "standard/diagnostic", commands: [f.plan.phases[1].commands[0]] });
  await f.save();
  const makeClone = f.dependencies.cloneFactory, observed = new Map();
  f.dependencies.cloneFactory = (options) => {
    const clone = makeClone(options);
    clone.observeProductLogs = async () => {
      const count = (observed.get(options.name) ?? 0) + 1;
      observed.set(options.name, count);
      if (count === 2) throw new Error("intermediate destination is unsafe");
    };
    return clone;
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.notStarted, []);
  assert.deepEqual(result.incomplete, ["standard/second"]);
  for (const [name, clone] of Object.entries(result.clones)) {
    assert.equal(observed.get(name), 4);
    assert.match(clone.captureErrors["standard/second"], /intermediate destination is unsafe/);
    assert.equal(clone.phases["standard/second"], "no checkpoint");
    assert.equal(clone.phases["standard/diagnostic"], "recorded");
  }
  await assert.rejects(readFile(join(f.dependencies.home, "verify/cache", result.cache.key, "cache.json")), { code: "ENOENT" });
});

test("target and phase identities refuse wrong commits, downgrades and service operations", async (t) => {
  const f = await fixture(t);
  await assert.rejects(validateTarget(`local-build:${f.source}`, "0".repeat(40), "2026.9.9"), /commit differs/);
  await assert.rejects(validateTarget(`local-build:${f.source}`, f.plan.change.baseline, "2026.10.3"), /no older/);
  await assert.rejects(validateTarget("npm:2026.10.2", f.plan.change.baseline, "2026.9.9"), /local-build/);
  f.plan.phases[1].commands = ["ocm service start {env} --json"];
  f.plan.phasesSha256 = sha256(canonicalJSON(f.plan.phases));
  assert.throws(() => validateRunPlan(f.plan, f.catalogue), /managed service/);
  assert.equal(compareVersions("2026.10.2-beta.2", "2026.10.2-beta.11"), -1);
  assert.equal(compareVersions("2026.10.2", "2026.10.2-beta.11"), 1);
});

test("an installed Kova inside another checkout uses the package version for cache identity", async (t) => {
  const f = await fixture(t);
  const git = (...args) => execFileSync("git", ["-C", f.root, ...args], { stdio: "ignore" });
  git("init", "-q"); git("config", "user.name", "Kova"); git("config", "user.email", "kova@example.invalid");
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
  const prepared = await prepareRun(f.options, f.dependencies);
  assert.deepEqual(prepared.identity, { revision: "1.0.0", dirty: false });
});

test("a manifest cannot claim traits that its checked definition omits", async (t) => {
  const f = await fixture(t);
  const manifest = await readJSON(f.plan.persona.manifest);
  manifest.traits.unchecked = { keys: {} };
  const bytes = JSON.stringify(manifest);
  await writeFile(f.plan.persona.manifest, bytes);
  f.plan.persona.sha256 = sha256(bytes);
  await f.save();
  await assert.rejects(runVerification(f.options, f.dependencies), /traits differ from definition/);
  assert.deepEqual(f.calls, []);
});

test("runtime withholding admits only supported traits and retains its dependency reasons", async (t) => {
  const f = await fixture(t, { withWithheld: true });
  f.definition.traits[0].builder = ["node {kovaRoot}/support/retired-builder.mjs --env {env}"];
  await f.savePersona();
  const prepared = await prepareRun(f.options, f.dependencies);
  assert.deepEqual(prepared.persona.definition.traits.map((trait) => trait.id), ["configured"]);
  assert.deepEqual(prepared.persona.manifest.withheldTraits, f.manifest.withheldTraits);
  assert.deepEqual(Object.keys(prepared.persona.manifest.traits), ["configured"]);
  const result = await runVerification(f.options, f.dependencies);
  assert.equal(result.execute, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.created, []);
});

test("withholding cannot conceal supported traits or invent successful content", async (t) => {
  const f = await fixture(t, { withWithheld: true });
  const original = structuredClone(f.manifest);
  for (const [label, alter, expected] of [
    ["missing reasons", (manifest) => { delete manifest.withheldTraits; }, /withheld persona traits differ/],
    ["forged minimum", (manifest) => { manifest.withheldTraits["newer-content"].minimumRuntime = "2026.10.4"; }, /withheld persona traits differ/],
    ["forged dependency", (manifest) => { manifest.withheldTraits["newer-dependent"].dependencies = ["configured"]; }, /withheld persona traits differ/],
    ["hidden supported content", (manifest) => { delete manifest.traits.configured; manifest.withheldTraits.configured = { minimumRuntime: "2026.10.3", reason: "not checked" }; }, /withheld persona traits differ/],
    ["invented successful content", (manifest) => { manifest.traits["newer-content"] = { keys: {}, checkedAt: "2026-10-14T00:00:00Z" }; }, /manifest traits differ from definition/],
    ["forged bound runtime", (manifest) => { manifest.runtime.resolved = manifest.runtime.resolved.replace("2026.9.9@", "2026.10.3@"); }, /bound runtime differs from its selector/]
  ]) {
    for (const key of Object.keys(f.manifest)) delete f.manifest[key];
    Object.assign(f.manifest, structuredClone(original));
    alter(f.manifest);
    await f.savePersona();
    await assert.rejects(prepareRun(f.options, f.dependencies), expected, label);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.created, []);
});

test("records five ordered copies, then reuses only complete baseline and noise copies", async (t) => {
  const f = await fixture(t);
  const first = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(first.notStarted, []); assert.deepEqual(first.incomplete, []); assert.deepEqual(first.cleanupErrors, []);
  assert.equal(f.created.length, 5); assert.equal(f.removed.length, 5);
  for (const name of f.created) assert.deepEqual(Object.values(first.clones[name].phases), ["recorded", "recorded"]);
  const second = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.equal(f.created.length, 7);
  assert.equal(f.removed.length, 7);
  assert.equal(second.clones.baseline.cached, true);
  assert.equal(second.clones["change-1"].cached, false);
  assert.equal((await readJSON(second.plan.path)).schema, "kova.verify.plan.v1");
  const cachedCommands = join(f.dependencies.home, "verify/cache", first.cache.key, "baseline/checkpoints/standard/use-target/commands.json");
  await writeFile(cachedCommands, "[]");
  const third = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.equal(third.clones.baseline.cached, false);
  assert.equal(f.created.length, 12);
});

test("a cache without the current recording format is rebuilt", async (t) => {
  const f = await fixture(t);
  const first = await runVerification({ ...f.options, execute: true }, f.dependencies);
  const file = join(f.dependencies.home, "verify/cache", first.cache.key, "cache.json");
  const old = await readJSON(file);
  old.recordingFormat = 17;
  await writeFile(file, JSON.stringify(old));
  const second = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.equal(second.clones.baseline.cached, false);
  assert.equal((await readJSON(file)).recordingFormat, 18);
  assert.equal(f.created.length, 10);
});

test("phase log boundaries separate preparation, earlier phases and newly opened handles", async (t) => {
  const f = await fixture(t), makeClone = f.dependencies.cloneFactory, execute = f.dependencies.execute;
  const copies = new Map();
  f.plan.phases[1].checkpoint = ["responses"];
  f.plan.phases.push({ ...f.plan.phases[0], id: "standard/last", commands: f.plan.phases[1].commands });
  await f.save();
  f.dependencies.cloneFactory = (options) => {
    const clone = makeClone(options), prepare = clone.prepare;
    const product = join(options.directory, "product.log"), gateway = join(options.directory, "gateway.log"), fresh = join(options.directory, "fresh.log");
    const copy = { clone, product, gateway, fresh, commands: 0 };
    copies.set(options.name, copy);
    clone.collectProductLogs = createLogCollector([product]);
    clone.prepare = async () => {
      const metadata = await prepare();
      await writeFile(product, "preparation product\n");
      await writeFile(gateway, "preparation gateway\n");
      const handle = join(options.directory, "gateway.json");
      await writeFile(handle, JSON.stringify({ ref: { stdoutPath: gateway } }));
      clone.handles.add(handle);
      return metadata;
    };
    return clone;
  };
  f.dependencies.execute = async (command, options) => {
    const result = await execute(command, options), tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    const copy = copies.get(tokens[1] === "start" ? tokens[2] : tokens[1]?.slice(1));
    if (!copy) return result;
    copy.commands++;
    const text = `phase ${copy.commands}\n`;
    await appendFile(copy.product, text);
    await appendFile(copy.gateway, text);
    if (copy.commands === 1) {
      const handle = join(copy.clone.directory, "fresh.json");
      await writeFile(handle, JSON.stringify({ ref: { stdoutPath: copy.fresh } }));
      copy.clone.handles.add(handle);
    }
    await appendFile(copy.fresh, text);
    return result;
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.incomplete, []);
  for (const [name, copy] of Object.entries(result.clones)) {
    assert.match(copy.preparation.logs, /preparation product/);
    assert.match(copy.preparation.logs, /preparation gateway/);
    assert.doesNotMatch(copy.preparation.logs, /phase/);
    const checkpoints = join(f.dependencies.home, "verify", result.id, name, "checkpoints/standard");
    for (const [phase, number] of [["use-target", 1], ["last", 3]]) {
      const lines = (await readFile(join(checkpoints, phase, "logs.txt"), "utf8")).split("\n").filter(Boolean);
      assert.deepEqual(lines, Array(3).fill(`phase ${number}`));
    }
  }
});

test("failed clone preparation retains its logs without starting a phase", async (t) => {
  const f = await fixture(t), makeClone = f.dependencies.cloneFactory;
  f.dependencies.cloneFactory = (options) => {
    const clone = makeClone(options), prepare = clone.prepare, log = join(options.directory, "prepare.log");
    clone.collectProductLogs = createLogCollector([log]);
    clone.prepare = async () => { await prepare(); await writeFile(log, "preparation failure detail\n"); throw new Error("preparation failed"); };
    return clone;
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.equal(result.notStarted.length, 5);
  for (const copy of Object.values(result.clones)) {
    assert.equal(copy.error, "preparation failed");
    assert.equal(copy.preparation.logs, "preparation failure detail\n");
    assert.ok(Object.values(copy.phases).every((status) => status === "no checkpoint"));
  }
});

test("a warm run retains exit 2 when the next command fails before a checkpoint", async (t) => {
  const f = await fixture(t);
  f.plan.phases[1].commands.push(f.plan.phases[1].commands[0]);
  await f.save();
  const execute = f.dependencies.execute;
  f.dependencies.execute = (command, options) => {
    assert.equal(Object.hasOwn(options, "observeResult"), false);
    return execute(command, options);
  };
  const first = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(first.incomplete, []);
  assert.deepEqual(first.cleanupErrors, []);
  let attempts = 0;
  f.setFailure((command) => {
    const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    if (tokens[0] !== "ocm" || tokens[1] !== "@change-1") return 0;
    if (++attempts === 1) return 2;
    throw new Error("later command failed before capture");
  });
  const second = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.equal(attempts, 2);
  assert.deepEqual(second.notStarted, []);
  assert.deepEqual(second.cleanupErrors, []);
  assert.deepEqual(second.incomplete, ["standard/second"]);
  for (const name of ["baseline", "noise-1", "noise-2"]) {
    assert.equal(second.clones[name].cached, true);
    assert.equal(second.clones[name].phases["standard/second"], "recorded");
  }
  assert.equal(second.clones["change-1"].cached, false);
  assert.match(second.clones["change-1"].error, /later command failed before capture/);
  assert.deepEqual(second.clones["change-1"].incomplete, ["standard/second"]);
  assert.equal(second.clones["change-1"].phases["standard/second"], "no checkpoint");
  assert.equal(second.clones["change-1"].captureErrors, undefined);
  assert.equal(second.clones["change-2"].cached, false);
  assert.equal(second.clones["change-2"].phases["standard/second"], "recorded");
  assert.deepEqual(second.clones["change-2"].incomplete, []);
  assert.equal(f.created.length, 7);
  assert.equal(f.removed.length, 7);
});

test("first-phase failure is not started, while exit 2 on one later copy is incomplete", async (t) => {
  for (const [missing, expected] of [
    [["baseline"], []],
    [["change-1", "change-2"], []],
    [["baseline", "change-1"], ["standard/second"]],
    [["noise-1"], ["standard/second"]]
  ]) {
    const f = await fixture(t);
    f.setFailure((command) => {
      const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
      return tokens[0] === "ocm" && tokens[1] === "start" && missing.includes(tokens[2]) ? 1 : 0;
    });
    const failed = await runVerification({ ...f.options, execute: true }, f.dependencies);
    assert.deepEqual(failed.notStarted, missing);
    assert.deepEqual(failed.incomplete, expected, `missing checkpoints: ${missing.join(", ")}`);
    for (const name of missing) {
      assert.equal(failed.clones[name].phases["standard/use-target"], "recorded");
      assert.equal(failed.clones[name].phases["standard/second"], "no checkpoint");
      assert.deepEqual(failed.clones[name].incomplete, []);
      assert.equal(failed.clones[name].captureErrors, undefined);
    }
  }
  const f = await fixture(t);
  f.setFailure((command) => command.includes("'@change-1'") ? 2 : 0);
  const incomplete = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(incomplete.notStarted, []);
  assert.deepEqual(incomplete.incomplete, ["standard/second"]);
});

test("imports and runtime preparation share admission while product commands remain concurrent", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), original = f.dependencies.execute, makeClone = f.dependencies.cloneFactory;
  let preparing = 0, operations = 0, productCommands = 0;
  let allProducts;
  const joined = new Promise((resolve) => { allProducts = resolve; });
  f.dependencies.cloneFactory = (options) => {
    const clone = makeClone(options), prepare = clone.prepare;
    clone.prepare = async () => {
      await options.call(`ocm env import fixture --name ${options.name} --json`);
      await options.call(`ocm start ${options.name} --version 2026.9.9 --no-service --json`);
      await options.call(`ocm env import extra --name ${options.name}-extra --json`);
      await options.call(`ocm start ${options.name}-extra --runtime alias --no-service --json`);
      return prepare();
    };
    return clone;
  };
  f.dependencies.execute = async (command) => {
    const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    if (tokens[0] === "ocm" && (tokens[1] === "start" || tokens[1] === "env" && tokens[2] === "import")) {
      assert.equal(preparing++, 0, "OCM runtime admission refuses overlapping imports or preparation");
      operations++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      preparing--;
    } else if (tokens[1]?.startsWith("@")) {
      if (++productCommands === 5) allProducts();
      await joined;
    }
    return original(command);
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.notStarted, []);
  assert.equal(operations, 25);
  assert.equal(productCommands, 5);
  assert.equal(f.removed.length, 5);
});

test("placeholder resolution quotes paths and binds extra persona environments to copies", async () => {
  const context = { standard: true, env: "copy", target: "runtime", run: "/tmp/a b", kovaRoot: "/tmp/kova", traits: { second: { keys: { env: "copy-second" } } }, roots: [["/durable/source", "/copy/source"]] };
  assert.equal(resolveRunCommand("ocm @{persona:second:env} -- config get path --json", context), "'ocm' '@copy-second' '--' 'config' 'get' 'path' '--json'");
  const resolved = resolveRunCommand("node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.files.get --out {run}/a.json --params '{\"sessionKey\":\"agent:main:fixture\",\"path\":\"/durable/source/a\"}'", context);
  assert.equal(resolved, "'node' '/tmp/kova/support/verify/gateway-call.mjs' '--env' 'copy' '--method' 'sessions.files.get' '--out' '/tmp/a b/a.json' '--params' '{\"sessionKey\":\"agent:main:fixture\",\"path\":\"/copy/source/a\"}'");
  await checkGatewayCommand(resolved);
});


test("OCM operands and output files cannot escape clone or evidence ownership", async (t) => {
  const f = await fixture(t);
  for (const command of [
    "ocm env exec durable -- printf %s {env}",
    "ocm env exec {env} -- ocm env protect durable-persona off --json",
    "ocm env snapshot create durable --label {env} --json",
    "ocm env snapshot create {env} --label verify-final --json",
    "ocm upgrade {env} --runtime {target} --json",
    "ocm env clone {env} escaped-copy --json",
    "ocm start {env} --runtime unrelated --no-service --json",
    "node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.describe --params '{\"key\":\"agent:main:fixture\"}' --out {run}/checkpoints/standard/use-target/commands.json",
    "node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.describe --params '{\"key\":\"agent:main:fixture\"}' --out {run}/initial-state/openclaw.json"
  ]) {
    await checkGatewayCommand(command);
    f.plan.phases[1].commands = [command];
    f.plan.phasesSha256 = sha256(canonicalJSON(f.plan.phases));
    assert.throws(() => validateRunPlan(f.plan, f.catalogue), /clone|create environments|planned target|protected evidence/);
  }
  f.plan.phases.shift();
  f.plan.phasesSha256 = sha256(canonicalJSON(f.plan.phases));
  assert.throws(() => validateRunPlan(f.plan, f.catalogue), /standard target binding/);
});

test("persona checks cannot request explicit or automatic OCM snapshots", async () => {
  for (const command of ["ocm env snapshot create copy --label final --json", "ocm upgrade copy --runtime planned --json"]) {
    await assert.rejects(validateRunDestinations(command, {}), /snapshot-producing OCM operations/);
  }
});

test("unavailable OCM leaves a failure record with all copies not started", async (t) => {
  const f = await fixture(t);
  f.setFailure((command) => command === "ocm --version" ? 1 : 0);
  await assert.rejects(runVerification({ ...f.options, execute: true }, f.dependencies), /command failed/);
  const parent = join(f.dependencies.home, "verify");
  const [id] = await readdir(parent);
  const record = await readJSON(join(parent, id, "run.json"));
  assert.equal(record.notStarted.length, 5);
  assert.equal(record.ocm, null);
  assert.deepEqual(record.cleanupErrors, []);
});

test("failed capture preserves later diagnostics and ordinary phases remain interruptible", async (t) => {
  const f = await fixture(t);
  f.plan.phases[1].browser = true;
  f.plan.phases[1].checkpoint = ["screen"];
  f.plan.phases.push({ ...f.plan.phases[0], id: "standard/diagnostic", commands: ["ocm @{env} -- doctor --json"] });
  await f.save();
  const original = f.dependencies.execute;
  f.dependencies.execute = async (command, options) => {
    if (command.includes("'--'")) assert.equal(options.finishOnShutdown, false);
    const result = await original(command, options);
    if (command.includes("'status'")) return { ...result, status: command.includes("'@change-1'") ? 2 : 0, stdout: JSON.stringify({ screen: "/outside/evidence.png" }) };
    return result;
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.notStarted, []);
  assert.deepEqual(result.incomplete, ["standard/second"]);
  for (const copy of Object.values(result.clones)) {
    assert.match(copy.captureErrors["standard/second"], /screenshot/);
    assert.equal(copy.phases["standard/diagnostic"], "recorded");
  }
  assert.equal(f.calls.filter((command) => command.includes("'doctor'")).length, 5);
});


test("commands run in distinct owned working directories and reject aliased destinations", async (t) => {
  const root = await temporary(t), first = join(root, "first"), second = join(root, "second"), durable = join(root, "durable");
  for (const path of [first, second, durable]) await mkdir(path);
  const probe = `${quoteShell(process.execPath)} -e ${quoteShell("console.log(process.cwd())")}`;
  for (const cwd of [first, second]) assert.equal((await runCommand(probe, { cwd })).stdout.trim(), await realpath(cwd));
  const command = "ocm @copy -- sessions export-trajectory --session-key existing --output result --json";
  const output = join(root, "output"); await mkdir(output);
  const context = { cwd: first, run: output, ownedRoots: [first] };
  await validateRunDestinations(command, context);
  await assert.rejects(validateRunDestinations(`${command} --workspace ${quoteShell(`${root}/./durable`)}`, context), /owned copy/);
  await symlink(durable, join(first, "linked"));
  await assert.rejects(validateRunDestinations(`${command} --workspace ${quoteShell(join(first, "linked"))}`, context), /owned copy/);
  await mkdir(join(first, ".openclaw"));
  await symlink(durable, join(first, ".openclaw", "trajectory-exports"));
  await assert.rejects(validateRunDestinations(command, context), /owned copy/);
  await assert.rejects(validateRunDestinations("node /helper --out " + quoteShell(join(first, "linked", "result.json")), context), /owned copy/);
});


test("the runner confines product destinations before execution and routes each copy's cwd", async (t) => {
  const f = await fixture(t), seen = new Set();
  const original = f.dependencies.execute;
  f.dependencies.execute = async (command, options) => {
    if (command.startsWith("'ocm'")) {
      assert.ok(options.cwd);
      seen.add(options.cwd);
    }
    return original(command, options);
  };
  f.plan.phases[1].commands = [`ocm @{env} -- sessions export-trajectory --session-key existing --workspace ${quoteShell(`${f.source}/../source`)} --output proof --json`];
  await f.save();
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.equal(seen.size, 5);
  assert.equal(f.calls.some((command) => command.includes("'export-trajectory'")), false);
  for (const [name, copy] of Object.entries(result.clones)) {
    assert.deepEqual(copy.incomplete, ["standard/second"]);
    const checkpoint = join(dirname(result.path), name, "checkpoints/standard/second");
    assert.equal((await readJSON(join(checkpoint, "commands.json")))[0].exit, 2);
    assert.match((await readJSON(join(checkpoint, "responses.json")))[0].error, /owned copy/);
  }
  assert.equal(f.removed.length, 5);
});


test("destination validation rejects duplicate flags and config path escapes before execution", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), durable = join(root, "durable"), output = join(root, "output");
  await mkdir(copy); await mkdir(durable); await mkdir(output);
  const context = { cwd: copy, run: output, ownedRoots: [copy] };
  for (const flag of ["--workspace", "--output"]) {
    await assert.rejects(validateRunDestinations(`ocm @copy -- sessions export-trajectory --session-key existing ${flag} safe ${flag} ${quoteShell(durable)}`, context), /repeated/);
  }
  const path = join(copy, "patch.json5"), command = `ocm @copy -- config patch --file ${quoteShell(path)}`;
  for (const patch of [
    { logging: { file: `${root}/./durable/injected.log` } },
    { logging: { file: join(output, "checkpoints/standard/use-target/commands.json") } },
    { logging: { file: "~/shared.log" } },
    { logging: { file: "../shared.log" } },
    { logging: { file: null } },
    { logging: null },
    { agents: { defaults: { workspace: durable } } },
    { $include: join(copy, "other.json") }
  ]) {
    await writeFile(path, JSON.stringify(patch));
    await assert.rejects(validateRunDestinations(command, context), /owned|ownership/);
  }
  const patch = { logging: { file: join(copy, "product.log"), level: "debug" }, messages: { responsePrefix: "/verified", ackReaction: "~" }, profile: "default", plugins: { load: { paths: [join(copy, "plugin")] } } };
  await writeFile(path, JSON.stringify(patch));
  const prepared = parseCatalogueCommand(await validateRunDestinations(command, context), { standard: true }).tokens;
  assert.deepEqual(JSON.parse(await readFile(prepared[prepared.indexOf("--file") + 1], "utf8")), patch);
});

test("config set checks concrete paths and baselines logs before dispatch", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), output = join(root, "output"), durable = join(root, "durable");
  for (const path of [copy, output, durable]) await mkdir(path);
  await symlink(durable, join(copy, "alias"));
  const baselines = [], context = { cwd: copy, run: output, ownedRoots: [copy], prepareLogDestination: async (env, path) => baselines.push({ env, path }) };
  const set = (path, value, strict = false) => validateRunDestinations(`ocm @copy -- config set ${quoteShell(path)} ${quoteShell(value)}${strict ? " --strict-json" : ""}`, context);
  for (const path of ["logging.file", 'logging["file"]', "[logging]['file']", "logging.\\file", 'logging["\\u0066ile"]']) await assert.rejects(set(path, join(durable, "out.log")), /owned/);
  await assert.rejects(set("logging.file", join(copy, "alias/out.log")), /owned/);
  await assert.rejects(set("logging", "{level:'debug'}"), /preserve/);
  await assert.rejects(set("agents.list[0].workspace", durable), /owned/);
  await assert.rejects(set("logging.file", "'not strict JSON'", true), SyntaxError);
  for (const path of ["logging..file", "logging[", "logging[\"file\"]suffix", "__proto__.file"]) await assert.rejects(set(path, join(copy, "owned.log")), /invalid/);
  assert.deepEqual(baselines, []);
  const file = join(copy, "owned.log");
  await set("logging.file", file);
  await set("logging", `{file:${JSON.stringify(file)},level:'debug'}`);
  await set("logging.file", JSON.stringify(file), true);
  await set("gateway.controlUi.basePath", "/control");
  await set("mcp.servers['example.server'].command", "/trusted/program");
  assert.deepEqual(baselines, Array(3).fill({ env: "copy", path: file }));
});

test("cursor target inputs stay in the output directory before and after resolution", async (t) => {
  const f = await fixture(t), copy = join(f.root, "copy"), output = join(f.root, "output");
  await mkdir(copy); await mkdir(output); await symlink(f.source, join(output, "alias"));
  const cursor = "node {kovaRoot}/support/verify/session-status-cursor.mjs --session-from {run}/session.json --from {run}/cursor.json --target-from ";
  f.plan.phases[1].commands = [`${cursor}{run}/target.json --out {run}/params.json`];
  f.plan.phasesSha256 = sha256(canonicalJSON(f.plan.phases));
  assert.throws(() => validateRunPlan(f.plan, f.catalogue), /entry is not implemented/);
  // A future implementation must still receive the same destination checks.
  const implemented = structuredClone(f.catalogue);
  implemented.entries.find((entry) => entry.id === "session-status-cursor").status = "existing";
  assert.doesNotThrow(() => validateRunPlan(f.plan, implemented));
  f.plan.phases[1].commands = [`${cursor}/outside/target.json --out {run}/params.json`];
  f.plan.phasesSha256 = sha256(canonicalJSON(f.plan.phases));
  assert.throws(() => validateRunPlan(f.plan, implemented), /--target-from must stay/);
  const context = { cwd: copy, run: output, kovaRoot: repoRoot, ownedRoots: [copy] };
  const command = `${cursor}{run}/alias/target.json --out {run}/params.json`;
  await assert.rejects(validateRunDestinations(resolveRunCommand(command, context), context), /owned/);
});

test("configuration paths retain their full context across objects, arrays and provider settings", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), durable = join(root, "durable"), output = join(root, "output");
  for (const path of [copy, durable, output]) await mkdir(path);
  await symlink(durable, join(copy, "alias"));
  const path = join(copy, "patch.json5"), command = `ocm @copy -- config patch --file ${quoteShell(path)}`;
  let configuration = { storage: { locations: { backup: { provider: "filesystem", settings: { path: join(copy, "backup") } } } } };
  const context = { cwd: copy, run: output, ownedRoots: [copy], readConfiguration: async (env) => { assert.equal(env, "copy"); return configuration; } };
  const validate = async (patch) => {
    await writeFile(path, JSON.stringify(patch));
    return await validateRunDestinations(command, context);
  };
  const ordinary = {
    gateway: { controlUi: { basePath: "/control", root: join(copy, "ui") } },
    hooks: { path: "/events", mappings: [{ match: { path: "/incoming" } }], gmail: { serve: { path: "/gmail" }, tailscale: { path: "/gmail" } } },
    channels: { telegram: { webhookPath: "/telegram" }, "nextcloud-talk": { webhookPath: "/talk", botSecretFile: join(copy, "bot-secret") }, slack: { accounts: { example: { webhookPath: "/slack/events" } } } },
    secrets: { defaults: { file: "local-provider", store: "local-store" } },
    messages: { usageTemplate: { segments: [{ type: "text", text: "/a/plain/message", path: durable, file: durable }] } },
    memory: { search: { local: { modelPath: "HF:example/model.gguf" } } }
  };
  const prepared = parseCatalogueCommand(await validate(ordinary), { standard: true }).tokens;
  assert.deepEqual(await readJSON(prepared[prepared.indexOf("--file") + 1]), ordinary);
  for (const patch of [
    { gateway: { controlUi: { root: durable } } },
    { channels: { "nextcloud-talk": { botSecretFile: join(durable, "secret") } } },
    { channels: { "nextcloud-talk": { accounts: { example: { apiPasswordFile: join(copy, "alias/password") } } } } },
    { env: { vars: { OPENCLAW_CACHE_TRACE_FILE: join(durable, "cache.jsonl") } } },
    { env: { OPENCLAW_CACHE_TRACE_FILE: join(durable, "cache.jsonl") } },
    { env: { vars: { OPENCLAW_TTS_PREFS: join(durable, "preferences.json") } } },
    { env: { vars: { " OPENCLAW_TTS_PREFS ": join(durable, "preferences.json") } } },
    { env: { " OPENCLAW_CACHE_TRACE_FILE ": join(durable, "cache.jsonl") } },
    { agents: { entries: { main: { tts: { prefsPath: join(durable, "preferences.json") } } } } },
    { channels: { feishu: { tts: { prefsPath: join(durable, "preferences.json") } } } },
    { channels: { feishu: { accounts: { example: { tts: { prefsPath: join(copy, "alias/preferences.json") } } } } } },
    { agents: { entries: { example: { cwd: durable } } } },
    { memory: { search: { extraPaths: [{ path: durable, pattern: "*.md" }] } } },
    { secrets: { providers: { local: { source: "file", path: durable } } } },
    { messages: { usageTemplate: { $include: join(copy, "other.json") } } },
    { messages: { usageTemplate: durable } },
    { storage: { locations: { backup: { settings: { path: durable } } } } }
  ]) await assert.rejects(validate(patch), /owned|ownership/);
  await validate({ storage: { locations: { backup: { settings: { path: join(copy, "next-backup") } } } } });
  configuration = { storage: { locations: { backup: { provider: "custom", settings: { path: durable } } } } };
  await validate({ storage: { locations: { backup: { settings: { path: "/remote/object-prefix" } } } } });
  await assert.rejects(validate({ storage: { locations: { backup: { provider: "filesystem" } } } }), /owned copy/);
  await assert.rejects(validate({ storage: { locations: { unknown: { settings: { path: durable } } } } }), /known provider/);
  await validate({ agents: { entries: { main: { tts: { prefsPath: join(copy, "preferences.json") } } } } });
  await validate({ env: { vars: { " OPENCLAW_TTS_PREFS ": join(copy, "preferences.json") } } });
});

test("message configuration writes share destination checks and prepare log collection before dispatch", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), durable = join(root, "durable"), output = join(root, "output");
  for (const path of [copy, durable, output]) await mkdir(path);
  await symlink(durable, join(copy, "alias"));
  const diskLog = join(copy, "disk.log"), nextLog = join(copy, "next.log"), external = join(durable, "changed.log"), preparedLogs = [];
  const context = {
    cwd: copy, run: output, ownedRoots: [copy], kovaRoot: repoRoot,
    readConfiguration: async (env) => { assert.equal(env, "copy"); return { logging: { file: diskLog }, storage: { locations: { backup: { provider: "custom", settings: { path: durable } } } } }; },
    prepareLogDestination: async (env, path) => { preparedLogs.push({ env, path }); }
  };
  const call = (params, extra = "", method = "sessions.create") => `node ${quoteShell(join(repoRoot, "support/verify/gateway-call.mjs"))} --env copy --method ${method} --params ${quoteShell(JSON.stringify(params))} ${extra}`;
  const admit = async (params, method) => {
    const tokens = parseCatalogueCommand(await validateRunDestinations(call(params, "", method), context), { standard: true }).tokens;
    assert.deepEqual(JSON.parse(tokens[tokens.indexOf("--params") + 1]), params);
  };
  for (const message of ["/config", "/config get logging.file", "/debug show", "/config-check set logging.file=/outside", "Explain /config set logging.file=/outside", "/config set logging={broken"]) await admit({ message });
  for (const message of ["/bash", "!", "/BASH: help", "!poll owned-job", "/bash stop owned-job", "Explain /bash pwd"]) await admit({ message });
  await admit({ message: "/config set gateway.controlUi.basePath='/control'" });
  await admit({ message: "/debug set hooks.transformsDir=\"custom\"" });
  await admit({ message: `/config set mcp.servers.probe.command=${JSON.stringify(process.execPath)}` });
  await admit({ task: `/config set agents.entries.main.tts.prefsPath=${JSON.stringify(join(copy, "preferences.json"))}`, message: `/config set logging.file=${JSON.stringify(external)}` });
  for (const message of [`/CoNfIg: SET logging.file=${JSON.stringify(nextLog)}`, `/debug set logging.file=${JSON.stringify(nextLog)}`]) await admit({ message });
  assert.deepEqual(preparedLogs, [{ env: "copy", path: nextLog }, { env: "copy", path: nextLog }]);
  await admit({ message: "/debug unset logging.file" });
  await admit({ message: "/debug reset" });
  assert.deepEqual(preparedLogs.slice(2), [{ env: "copy", path: diskLog }, { env: "copy", path: diskLog }]);
  const before = preparedLogs.length;
  for (const message of [
    `/config set logging.file=${JSON.stringify(external)}`,
    `/debug set logging.file='${external}'`,
    `/config set logging=${JSON.stringify({ level: "debug", file: external })}`,
    `/config set agents.entries.main.tts=${JSON.stringify({ prefsPath: join(copy, "alias/preferences.json") })}`,
    `/config set channels.feishu.accounts.example.tts.prefsPath=${JSON.stringify(external)}`,
    `/config set env.vars.OPENCLAW_TTS_PREFS=${JSON.stringify(external)}`,
    `/config set storage.locations.backup.provider=filesystem`,
    `\u0001[fixture] Kova Gateway RPC: /CONFIG : set logging.file='${external}'\nignored`,
    `/config\\nset\\nlogging.file=${JSON.stringify(external)}`,
    "/config unset logging.file", "/config unset logging", '/config set logging={"level":"debug"}', '/debug set logging=[]',
    "/debug set storage.locations.backup.provider=filesystem",
    "/bash printf changed", "/BASH: printf changed", "/bash\nprintf changed", "/bash\\nprintf changed",
    "!printf changed", "! printf changed", "! : printf changed", "!!printf changed", "!poll; printf changed",
    "[fixture] Kova Gateway RPC: /bash printf changed"
  ]) await assert.rejects(validateRunDestinations(call({ message }), context), /owned|observable runtime/);
  assert.equal(preparedLogs.length, before);
  await assert.rejects(validateRunDestinations(call({ task: "!printf changed", message: "safe" }), context), /owned program boundary/);
  const source = join(output, "message.json");
  await writeFile(source, JSON.stringify({ task: `/config set logging.file=${JSON.stringify(external)}` }));
  await assert.rejects(validateRunDestinations(call({ message: "safe" }, `--merge-from ${quoteShell(source)}`), context), /owned copy/);
  await assert.rejects(validateRunDestinations(call({ task: "  ", message: `/config set logging.file=${JSON.stringify(external)}` }), context), /owned copy/);
  await admit({ sessionKey: "example", question: `/config set logging.file=${JSON.stringify(external)}` }, "sessions.companion.ask");
});

test("trusted program selectors pass unchanged while writable mount sources stay owned", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), external = join(root, "programs"), output = join(root, "output");
  for (const path of [copy, external, output]) await mkdir(path);
  const path = join(copy, "patch.json5"), command = `ocm @copy -- config patch --file ${quoteShell(path)}`;
  const context = { cwd: copy, run: output, ownedRoots: [copy] };
  const patch = {
    hooks: { transformsDir: "custom", mappings: [{ transform: { module: "map.mjs" } }], internal: { load: { extraDirs: [external] } } },
    plugins: { load: { paths: [external] } }, skills: { load: { extraDirs: [external], allowSymlinkTargets: [external] } },
    memory: { search: { store: { vector: { extensionPath: join(external, "vector.so") } } } },
    agents: { entries: { example: { sandbox: { docker: { binds: [`${copy}:/workspace:ro`] }, browser: { binds: [`${copy}:/browser:ro`] }, ssh: { command: "/usr/bin/ssh" } }, tools: { exec: { pathPrepend: [external], safeBinTrustedDirs: [external] } } } } },
    mcp: { servers: { example: { command: "node" }, absolute: { command: process.execPath, args: ["-e", "process.exit(0)"] } } },
    nodeHost: { mcp: { servers: { example: { command: process.execPath } } } },
    channels: { signal: { transport: { cliPath: join(external, "signal-cli") } }, imessage: { cliPath: join(external, "imsg") } },
    gateway: { terminal: { shell: "/bin/bash" } },
    browser: { executablePath: join(external, "browser"), profiles: { example: { executablePath: join(external, "browser"), mcpCommand: "../external-command" } } },
    models: { providers: { example: { localService: { command: process.execPath } } } },
    secrets: { providers: { example: { source: "exec", command: process.execPath, trustedDirs: [external] } } },
    security: { installPolicy: { exec: { command: process.execPath, trustedDirs: [external] } } },
    tools: { exec: { pathPrepend: [external], safeBinTrustedDirs: [external] }, media: { models: [{ command: process.execPath }] }, links: { models: [{ command: process.execPath }] } }
  };
  await writeFile(path, JSON.stringify(patch));
  const prepared = parseCatalogueCommand(await validateRunDestinations(command, context), { standard: true }).tokens;
  assert.deepEqual(await readJSON(prepared[prepared.indexOf("--file") + 1]), patch);
  for (const kind of ["docker", "browser"]) {
    await writeFile(path, JSON.stringify({ agents: { defaults: { sandbox: { [kind]: { binds: [`${external}:/workspace`] } } } } }));
    await assert.rejects(validateRunDestinations(command, context), /owned/);
  }
});

test("persona checks receive the same command admission as phase commands", async (t) => {
  const f = await fixture(t), manifestPath = join(f.root, "persona.json");
  const definitionPath = join(f.root, "definition.json"), definition = await readJSON(definitionPath);
  definition.traits[0].check = `node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.describe --params '{"key":"agent:main:fixture"}' --out ${f.root}/./durable/check.json`;
  await checkGatewayCommand(definition.traits[0].check);
  const bytes = JSON.stringify(definition); await writeFile(definitionPath, bytes);
  const manifest = await readJSON(manifestPath); manifest.definition.sha256 = sha256(bytes);
  const saved = JSON.stringify(manifest); await writeFile(manifestPath, saved);
  f.plan.persona.sha256 = sha256(saved); await f.save();
  await assert.rejects(runVerification({ ...f.options, execute: true }, f.dependencies), /--out must stay/);
  assert.deepEqual(f.created, []); assert.deepEqual(f.calls, []);
});

test("Gateway payload paths are checked after merging and the admitted payload is frozen", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), output = join(root, "output"), durable = join(root, "durable");
  for (const path of [copy, output, durable]) await mkdir(path);
  const context = { cwd: copy, run: output, ownedRoots: [copy], kovaRoot: repoRoot, configPaths: [join(copy, "openclaw.json"), join(copy, "custom-config.json")] };
  const helper = `node ${quoteShell(join(repoRoot, "support/verify/gateway-call.mjs"))} --env copy`;
  const defaults = {
    "sessions.groups.update": { name: "Fixture group", worktree: true },
    "sessions.files.get": { sessionKey: "agent:main:fixture" },
    "sessions.files.list": { sessionKey: "agent:main:fixture" },
    "sessions.files.set": { sessionKey: "agent:main:fixture", expectedHash: "a".repeat(64), content: "Updated fixture" },
    "sessions.files.assets": { sessionKey: "agent:main:fixture", refs: [] }
  };
  const call = (method, params, extra = "") => `${helper} --method ${method} --params ${quoteShell(JSON.stringify({ ...defaults[method], ...params }))} ${extra}`;
  for (const method of ["sessions.create", "sessions.groups.update"]) {
    await assert.rejects(validateRunDestinations(call(method, { cwd: `${root}/./durable` }), context), /owned copy/);
    await assert.rejects(validateRunDestinations(call(method, { cwd: output }), context), /owned copy/);
  }
  const path = join(output, "input.json");
  await writeFile(path, JSON.stringify({ result: { cwd: durable } }));
  await assert.rejects(validateRunDestinations(call("sessions.create", {}, `--merge-from ${quoteShell(path)}`), context), /owned copy/);
  await writeFile(path, JSON.stringify({ result: { cwd: copy, message: "/ordinary text" } }));
  const frozen = await validateRunDestinations(call("sessions.create", {}, `--merge-from ${quoteShell(path)}`), context);
  await writeFile(path, JSON.stringify({ result: { cwd: durable } }));
  const tokens = parseCatalogueCommand(frozen, { standard: true }).tokens;
  assert.equal(tokens.includes("--merge-from"), false);
  assert.deepEqual(JSON.parse(tokens[tokens.indexOf("--params") + 1]), { cwd: await realpath(copy), message: "/ordinary text" });
  for (const method of ["sessions.files.get", "sessions.files.set", "sessions.files.assets", "sessions.files.list"]) {
    await assert.rejects(validateRunDestinations(call(method, { path: "../durable/file" }), context), /absolute owned/);
    await assert.rejects(validateRunDestinations(call(method, { path: `${root}/./durable/file` }), context), /owned copy/);
  }
  for (const file of ["openclaw.json", "custom-config.json"]) await assert.rejects(validateRunDestinations(call("sessions.files.set", { path: join(copy, file), content: "{}" }), context), /configuration/);
  await validateRunDestinations(call("sessions.files.set", { path: join(copy, "notes.txt"), content: "/ordinary content" }), context);
  await mkdir(join(copy, "examples"));
  await validateRunDestinations(call("sessions.files.set", { path: join(copy, "examples/openclaw.json"), content: "{}" }), context);
  await assert.rejects(validateRunDestinations(call("sessions.files.assets", { path: join(copy, "page.html"), refs: ["%2e%2e/durable/style.css?x#y"] }), context), /owned copy/);
  await validateRunDestinations(call("sessions.files.assets", { path: join(copy, "page.html"), refs: ["./style.css?x#y"] }), context);
  for (const field of ["projectId", "catalogId", "execNode"]) await assert.rejects(validateRunDestinations(call("sessions.create", { [field]: "external" }), context), /unsupported/);
});

test("resolved helper outputs cannot enter checkpoint directories through aliases", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), output = join(root, "output");
  await mkdir(copy); await mkdir(join(output, "checkpoints"), { recursive: true });
  await symlink(join(output, "checkpoints"), join(output, "alias"));
  const context = { cwd: copy, run: output, ownedRoots: [copy] };
  await assert.rejects(validateRunDestinations(`node /helper --out ${quoteShell(join(output, "alias/new.json"))}`, context), /protected evidence/);
  const patch = join(output, "patch.json");await writeFile(patch, JSON.stringify({ logging: { file: join(output, "checkpoints/commands.json") } }));
  await assert.rejects(validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(patch)}`, context), /owned copy/);
});


test("failed response dependencies preserve diagnostics and incomplete baselines can recover", async (t) => {
  for (const defect of ["error", "missing", "invalid"]) for (const faultyCopy of ["change-1", "baseline"]) {
    const f = await fixture(t), makeClone = f.dependencies.cloneFactory;
    let rejectInput = true;
    f.dependencies.cloneFactory = (options) => {
      const clone = makeClone(options), prepare = clone.prepare;
      clone.prepare = async () => {
        const metadata = await prepare(), faulty = options.name === faultyCopy && rejectInput;
        const response = faulty && defect === "error" ? { error: "planted OpenClaw failure" } : { method: "sessions.describe", error: null, result: { session: { key: "agent:main:case", sessionId: "observed-id" } } };
        if (!faulty || defect !== "missing") await writeFile(join(options.directory, "dependency.json"), faulty && defect === "invalid" ? "not JSON" : JSON.stringify(response));
        return metadata;
      };
      return clone;
    };
    f.plan.phases[1] = { ...f.plan.phases[1], id: "intent/dependent-response", from: "intent:protected", commands: ["--merge-from", "--session-from"].map((flag) => `node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.patch --params '{"label":"updated"}' ${flag} {run}/dependency.json`) };
    f.plan.phases.push({ ...f.plan.phases[0], id: "standard/diagnostic", commands: ["ocm @{env} -- doctor --json"] });
    await f.save();
    const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
    assert.deepEqual(result.notStarted, []);
    assert.deepEqual(result.incomplete, ["intent/dependent-response"]);
    for (const [name, copy] of Object.entries(result.clones)) {
      assert.equal(copy.phases["intent/dependent-response"], "recorded");
      assert.equal(copy.phases["standard/diagnostic"], "recorded");
      assert.deepEqual(copy.incomplete, name === faultyCopy ? ["intent/dependent-response"] : []);
    }
    const path = join(dirname(result.path), faultyCopy, "checkpoints/intent/dependent-response");
    const commands = await readJSON(join(path, "commands.json"));
    assert.deepEqual(commands.map((row) => row.exit), [2, 2]);
    assert.ok(commands.every((row) => !/\{(?:env|run|kovaRoot)\}/.test(row.command)));
    assert.ok(Object.values(await readJSON(join(path, "responses.json"))).every((response) => typeof response.error === "string" && response.error));
    assert.equal(f.calls.filter((command) => command.includes("'sessions.patch'")).length, 8);
    assert.equal(f.calls.filter((command) => command.includes("'doctor'")).length, 5);
    assert.equal(f.removed.length, 5);
    rejectInput = false;
    const recovered = await runVerification({ ...f.options, execute: true }, f.dependencies);
    assert.deepEqual(recovered.incomplete, []);
    assert.deepEqual(recovered.notStarted, []);
    assert.equal(recovered.clones.baseline.cached, faultyCopy !== "baseline");
    assert.equal(f.removed.length, faultyCopy === "baseline" ? 10 : 7);
  }
});


test("configuration patches execute immutable checked bytes and reserve their storage", async (t) => {
  const root = await temporary(t), copy = join(root, "copy"), output = join(root, "output"), durable = join(root, "durable");
  for (const path of [copy, output, durable]) await mkdir(path);
  const context = { cwd: copy, run: output, ownedRoots: [copy] }, patch = join(copy, "patch.json5");
  const approved = `{logging:{level:'debug',file:${JSON.stringify(join(copy, "product.log"))}},hooks:{token:'synthetic-frozen-hook-value'}}`;
  await writeFile(patch, approved);
  const prepared = await validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(patch)}`, context);
  const tokens = parseCatalogueCommand(prepared, { standard: true }).tokens, frozen = tokens[tokens.indexOf("--file") + 1];
  assert.notEqual(frozen, patch);assert.equal(dirname(dirname(frozen)), await realpath(copy));assert.equal(isPrivateVerificationPath(frozen), true);
  assert.deepEqual(await readdir(output), []);
  await writeFile(patch, JSON.stringify({ logging: { file: join(durable, "injected.log") } }));
  assert.equal(await readFile(frozen, "utf8"), approved);
  await assert.rejects(validateRunDestinations(`node /helper --out ${quoteShell(join(output, ".inputs/other.json"))}`, context), /protected evidence/);
  await assert.rejects(validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(patch)}`, context), /owned copy/);
  await writeFile(patch, approved);
  await assert.rejects(validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(patch)}`, { ...context, cwd: durable }), /owned copy/);
  await assert.rejects(validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(frozen)}`, context), /private verification inputs/);
  await symlink(frozen, join(copy, "input-alias"));
  const snapshots = join(root, "snapshots");
  await snapshotState(copy, [relative(await realpath(copy), dirname(frozen)), "input-alias"], snapshots);
  assert.deepEqual(await readdir(snapshots), []);
  const privateDirectory = dirname(frozen), unicodePrivate = join(await realpath(copy), ".kova-private-AbSSef");
  await mkdir(unicodePrivate); await writeFile(join(unicodePrivate, "patch.json5"), approved);
  for (const [index, [native, caseDirectory, fileName]] of [
    [privateDirectory, join(dirname(privateDirectory), basename(privateDirectory).toUpperCase()), basename(frozen)],
    [unicodePrivate, join(dirname(unicodePrivate), ".Kova-private-Abßef"), "patch.json5"]
  ].entries()) {
    const originalDirectory = await stat(native);
    const aliasDirectory = await stat(caseDirectory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const samePrivate = aliasDirectory?.dev === originalDirectory.dev && aliasDirectory?.ino === originalDirectory.ino;
    const caseFile = join(caseDirectory, fileName), ordinary = '{"note":"ordinary private-path lookalike"}\n';
    if (!samePrivate) { await mkdir(caseDirectory); await writeFile(caseFile, ordinary); }
    if (samePrivate) await assert.rejects(validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(caseFile)}`, context), /private verification inputs/);
    else await validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(caseFile)}`, context);
    const caseSnapshots = join(root, `case-snapshots-${index}`), selected = relative(await realpath(copy), caseDirectory);
    await snapshotState(copy, [selected], caseSnapshots);
    if (samePrivate) assert.deepEqual(await readdir(caseSnapshots), []);
    else assert.ok(await readFile(join(caseSnapshots, selected, fileName), "utf8") === ordinary);
    const observation = await executeGatewayCall({ env: "copy", method: "sessions.files.get", params: { sessionKey: "agent:main:main", path: caseFile }, timeoutMs: 1000 }, {
      prepare: () => ({ envName: "copy", root: copy, stateDir: copy, runDir: copy }), readGatewayConfiguration: () => ({}),
      connect: async () => ({ client: { close() {}, request: async () => ({ file: { path: caseFile, content: await readFile(caseFile, "utf8") } }) } })
    });
    if (samePrivate) { assert.notEqual(observation.exitCode, 0); assert.match(observation.output.error, /private verification file contents/); assert.equal(observation.output.result, null); }
    else { assert.equal(observation.exitCode, 0); assert.ok(observation.output.result.file.content === ordinary); }
  }
  await rm(copy, { recursive: true });
  await assert.rejects(readFile(frozen), { code: "ENOENT" });
});

test("file identity aliases protect case-equivalent credentials and preserve distinct files", async (t) => {
  const directory = await temporary(t);
  const state = join(await realpath(directory), "state");
  const filter = createAttachmentLogFilter(); t.after(() => filter.dispose());
  const token = "synthetic-case-log-grant"; filter.register(token);
  const cases = [
    { path: "agents/key.dat", target: "agents/KEY.DAT", bytes: "ordinary key-shaped content", protected: "" },
    { path: "agents/e\u0301key.pem", target: "agents/ÉKEY.pem", bytes: "ordinary decomposed key-shaped content", protected: "" },
    { path: "settings.json", target: "SETTINGS.JSON", bytes: '{"hooks":{"token":"synthetic-hook"},"note":"ordinary"}', protected: '{"hooks":{"token":""},"note":"ordinary"}' },
    { path: "settings.json.BAK", target: "SETTINGS.JSON.bak", bytes: '{"hooks":{"token":"synthetic-backup"}}', protected: '{"hooks":{"token":""}}' },
    { path: "settings.json.REJECTED.2026-10-15T00-00-00Z", target: "SETTINGS.JSON.rejected.2026-10-15T00-00-00Z", bytes: '{"hooks":{"token":"synthetic-rejected"}}', protected: '{"hooks":{"token":""}}' },
    { path: "parts/hooks.json", target: "parts/HOOKS.JSON", bytes: '{"token":"synthetic-include","enabled":false}', protected: '{"token":"","enabled":false}' },
    { path: "parts/ςkey.pem", target: "parts/ΣKEY.pem", bytes: '{"token":"synthetic-sigma-include"}', protected: '{"token":""}' },
    { path: "identity/DEVICE.JSON", target: "identity/device.json", bytes: '{"privateKeyPem":"synthetic-private","publicKeyPem":"public"}', protected: '{"privateKeyPem":"","publicKeyPem":"public"}' },
    { path: "profiles/.OPENCLAW-peer/identity/DEVICE.JSON", target: "profiles/.openclaw-peer/identity/device.json", bytes: '{"privateKeyPem":"synthetic-profile-private","publicKeyPem":"public"}', protected: '{"privateKeyPem":"","publicKeyPem":"public"}' },
    { path: "logs/product.js", target: "logs/PRODUCT.JS", bytes: `{"message":"${token}"}\n\n`, protected: '{"message":""}\n\n' },
    { path: "logs/sskey.pem", target: "logs/ßKEY.pem", bytes: `{"message":"${token}"}\n\n`, protected: '{"message":""}\n\n' }
  ];
  for (const entry of cases) {
    await mkdir(dirname(join(state, entry.path)), { recursive: true });
    await writeFile(join(state, entry.path), entry.bytes);
    const source = await stat(join(state, entry.path));
    const target = await stat(join(state, entry.target)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    entry.same = target?.dev === source.dev && target?.ino === source.ino;
    if (!entry.same) { await mkdir(dirname(join(state, entry.target)), { recursive: true }); await writeFile(join(state, entry.target), "separate authoritative file"); }
  }
  t.diagnostic(cases.every((entry) => entry.same) ? "filesystem provides case aliases" : "filesystem provides distinct case-sensitive controls");
  const declared = await createStateTextPolicy({ stateDirectory: state, homeDirectory: state, cwd: state, gateway: { tls: { keyPath: join(state, "agents/KEY.DAT") } }, configurations: [{ path: join(state, "SETTINGS.JSON"), at: [] }, { path: join(state, "parts/HOOKS.JSON"), at: ["hooks"] }, { path: join(state, "parts/ΣKEY.pem"), at: ["hooks"] }] });
  const policy = { ...declared, keys: [...declared.keys, join(state, "agents/ÉKEY.pem")],
    observedLogs: [{ ...filter.snapshot(), paths: [join(state, "logs/PRODUCT.JS"), join(state, "logs/ßKEY.pem")], datedDirectories: [] }] };
  const identities = createStateFileIdentityResolver(policy);
  await identities.resolve(cases.map((entry) => join(state, entry.path)));
  const applied = JSON.parse(JSON.stringify(identities.policy));
  const project = (entry, selected) => {
    const paths = [join(state, entry.path)], bytes = Buffer.from(entry.bytes);
    const logged = projectStateLogBytes(paths, bytes, selected) ?? bytes;
    return redactStateText(paths, logged, selected) ?? logged.toString("utf8");
  };
  for (const entry of cases) assert.ok(project(entry, applied) === (entry.same ? entry.protected : entry.bytes), entry.path);
  const output = join(directory, "case-snapshot");
  await snapshotState(state, cases.map((entry) => entry.path), output, policy);
  for (const entry of cases) {
    const expected = entry.same ? entry.protected : entry.bytes;
    const formatted = entry.same && entry.protected && !entry.path.startsWith("logs/") ? `${expected}\n` : expected;
    assert.ok(await readFile(join(output, entry.path), "utf8") === formatted, `snapshot ${entry.path}`);
  }
  const distinct = cases.filter((entry) => !entry.same);
  if (distinct.length) {
    const stale = { ...policy, aliases: distinct.map((entry) => ({ path: join(state, entry.path), target: join(state, entry.target) })) };
    const fresh = createStateFileIdentityResolver(stale);
    await fresh.resolve(distinct.map((entry) => join(state, entry.path)));
    assert.deepEqual(fresh.policy.aliases, [], "fresh captures never trust historic file identity");
    await rm(join(state, distinct[0].target));
    await fresh.resolve([join(state, distinct[0].path)]);
    assert.ok(project(distinct[0], fresh.policy) === distinct[0].bytes, "an absent authoritative candidate does not hide a present ordinary file");
  }
  const missing = createStateFileIdentityResolver({ ...policy, keys: [...policy.keys, join(state, "MISSING.DAT")] });
  await assert.rejects(missing.resolve([join(state, "missing.dat")]), /cannot establish captured file identity/);
  await rm(state, { recursive: true });
  for (const entry of cases) assert.ok(project(entry, applied) === (entry.same ? entry.protected : entry.bytes), `retained identity ${entry.path}`);
});

test("observed grant projections preserve bytes across chunks and reject pending or incomplete product logs", async (t) => {
  const directory = await temporary(t);
  const state = await realpath(directory), path = join(state, "product.js");
  const filter = createAttachmentLogFilter(); t.after(() => filter.dispose());
  const token = 'synthetic-observed-"grant\\\nend', escaped = JSON.stringify(token).slice(1, -1);
  const ordinary = '  {"message":"ordinary token OPENCLAW_MCP_TOKEN=value λ"}\r\n';
  const prefix = Buffer.concat([Buffer.from(ordinary), Buffer.alloc(65525 - Buffer.byteLength(ordinary), 32)]);
  const bytes = Buffer.concat([prefix, Buffer.from(`raw=${token}\nescaped=${escaped}\n${ordinary}\n`)]);
  const expected = Buffer.concat([prefix, Buffer.from(`raw=\nescaped=\n${ordinary}\n`)]);
  const base = await createStateTextPolicy({ stateDirectory: state });
  const policy = () => ({ ...base, observedLogs: [{ ...filter.snapshot(), paths: [path], datedDirectories: [] }] });
  const before = policy();
  filter.begin(); const pending = policy();
  assert.throws(() => projectStateLogBytes([path], bytes, pending), /pending/);
  filter.register(token); filter.finish(); const completed = policy();
  assert.ok(filter.redactBytes(bytes).equals(expected));
  const stats = {};
  assert.ok(projectStateLogBytes([path], bytes, completed, { stats }).equals(expected));
  assert.equal(stats.matches, 2); assert.equal(stats.sha256Checks, 2);
  assert.equal(projectStateLogBytes([join(state, "ordinary.js")], bytes, completed), null);
  assert.ok(projectStateLogBytes([path], Buffer.from(ordinary), completed).equals(Buffer.from(ordinary)));
  assert.throws(() => projectStateLogBytes([path], bytes, completed, { deadlineMs: 0 }), /time budget/);
  assert.throws(() => projectStateLogBytes([path], bytes.subarray(0, -3), completed), /incomplete native product log record/);
  assert.equal(projectStateLogBytes([path], Buffer.alloc(0), completed).length, 0);
  for (const merged of [mergeStateTextPolicies(completed, pending, before), mergeStateTextPolicies(before, pending, completed)]) assert.ok(projectStateLogBytes([path], bytes, merged).equals(expected));
  filter.begin(); const newerPending = policy();
  for (const merged of [mergeStateTextPolicies(completed, newerPending), mergeStateTextPolicies(newerPending, completed)]) assert.throws(() => projectStateLogBytes([path], bytes, merged), /pending/);
  filter.finish();
  // A matching fast checksum alone never removes a byte.
  const checksumOnly = { ...completed, observedLogs: completed.observedLogs.map((rule) => ({ ...rule, fingerprints: rule.fingerprints.map((entry) => ({ ...entry, sha256: "0".repeat(64) })) })) };
  assert.ok(projectStateLogBytes([path], bytes, checksumOnly).equals(bytes));
  await writeFile(path, bytes);
  const output = join(state, "snapshot");
  await snapshotState(state, ["product.js"], output, completed);
  assert.ok((await readFile(join(output, "product.js"))).equals(expected), "streamed projection preserves newline count and all ordinary bytes");
  await writeFile(path, bytes.subarray(0, bytes.length - 2));
  await assert.rejects(snapshotState(state, ["product.js"], join(state, "partial"), completed), /incomplete native product log record/);
  await assert.rejects(readFile(join(state, "partial/product.js")), { code: "ENOENT" });
  const collector = createLogCollector([path], { requireCompleteRecord: () => filter.isActive() });
  await assert.rejects(collector(), /incomplete native product log record/);
  filter.markIncomplete();
  assert.throws(() => projectStateLogBytes([path], bytes, mergeStateTextPolicies(policy(), completed)), /incomplete native attach output/);
  assert.ok(!JSON.stringify(completed).includes(escaped), "private declarations contain no grant values");
});

test("native attachment output is filtered before recording on every exit status", async (t) => {
  const root = await temporary(t), token = 'synthetic-native-attach-"credential\\\nend';
  const escaped = JSON.stringify(token).slice(1, -1);
  const command = "ocm @copy -- attach --session agent:main:main --print-config --ttl 60000";
  const printed = { sessionKey: "agent:main:main", expiresAt: "2026-10-15T00:00:00Z", env: { OPENCLAW_MCP_TOKEN: token }, configPath: "/copy/config.json", launch: ["client", "--config", "/copy/config.json"] };
  const stdout = `  ${JSON.stringify(printed, null, 2)}\nGrant is live. ${token}\n`;
  for (const status of [0, 1, 2]) {
    const result = { command, status, stdout, stderr: `diagnostic ${token}`, durationMs: 3, timedOut: false };
    const safe = redactCommandResult(command, result);
    assert.equal(safe.status, status);assert.equal(JSON.stringify(safe).includes(token), false);assert.equal(result.stdout, stdout);
    assert.deepEqual(redactCommandResult(command, safe), safe);
    const phase = { id: `intent/attachment-${status}`, commands: [command], checkpoint: ["responses", "doctor", "timing", "logs"], timeoutMs: 1000 };
    const logText = `ordinary token documentation\nraw=${token}\nescaped=${escaped}\nordinary OPENCLAW_MCP_TOKEN=value\n`;
    const recorded = await recordPhase({ phase, directory: root, execute: async () => result, collectLogs: async () => logText });
    assert.equal(recorded.incomplete, status === 2);
    assert.equal(JSON.stringify(recorded.results).includes(token), false);
    assert.equal(await readFile(join(recorded.path, "logs.txt"), "utf8"), "ordinary token documentation\nraw=\nescaped=\nordinary OPENCLAW_MCP_TOKEN=value\n");
    for (const file of await readdir(recorded.path)) for (const form of [token, escaped]) assert.equal((await readFile(join(recorded.path, file), "utf8")).includes(form), false);
  }
  const phase = { id: "intent/attachment-malformed", checkpoint: ["responses"] };
  for (const result of [
    { command, status: 0, stdout: `{"env":{"OPENCLAW_MCP_TOKEN":"${token}`, stderr: token },
    { command, status: 2, stdout, stderr: token, outputBudget: { truncated: true } }
  ]) {
    const safe = redactCommandResult(command, result);
    assert.equal(safe.status, result.status);assert.equal(JSON.stringify(safe).includes(token), false);
    await assert.rejects(writeCheckpoint({ phase, directory: root, results: [result] }), /could not be captured/);
    await assert.rejects(readdir(join(root, "checkpoints", phase.id)), { code: "ENOENT" });
  }
  const ordinary = { stdout, stderr: token, status: 0 };
  assert.equal(redactCommandResult("ocm @copy -- status --json", ordinary), ordinary);
});

for (const malformed of [false, true]) test(`attachment command cleanup and ${malformed ? "capture failure" : "filtered observations"} preserve later phases`, async (t) => {
  const f = await fixture(t), execute = f.dependencies.execute, makeClone = f.dependencies.cloneFactory;
  const privateRoots = [], temporaryPaths = [], token = "synthetic-attachment-grant-value";
  const productLogs = new Map(), issued = new Set(), published = new Map();
  f.dependencies.cloneFactory = (options) => {
    const clone = makeClone(options), prepare = clone.prepare, cleanup = clone.cleanup, context = clone.context;
    const root = join(f.root, `disposable-${options.name}`);privateRoots.push(root);
    const logPath = join(root, "state/logs/product.log");
    productLogs.set(options.name, logPath);
    let base, logIdentities;
    const policy = () => ({ ...base, observedLogs: [{ ...options.attachmentLogs.snapshot(), paths: logIdentities, datedDirectories: [] }] });
    clone.prepare = async () => { const metadata = await prepare();await mkdir(dirname(logPath), { recursive: true });await writeFile(logPath, "ordinary startup\n");base = await createStateTextPolicy({ stateDirectory: join(root, "state") });logIdentities = [...new Set([logPath, await realpath(logPath)])];return { ...metadata, root, stateDir: join(root, "state") }; };
    clone.stateTextPolicies = () => ({ [options.name]: policy() });
    clone.stateTextPolicy = () => policy();
    clone.publishAttachmentPolicy = async () => { published.set(options.name, policy()); };
    clone.collectProductLogs = createLogCollector([logPath], { requireCompleteRecord: () => options.attachmentLogs.isActive() });
    clone.context = () => ({ ...context(), cwd: root, ownedRoots: [root] });
    clone.cleanup = async () => { await cleanup();await rm(root, { recursive: true, force: true }); };
    return clone;
  };
  f.plan.phases[1].commands = ["ocm @{env} -- attach --session agent:main:main --print-config --ttl 60000"];
  f.plan.phases[1].checkpoint.push("state:logs");
  f.plan.phases.push(
    { ...f.plan.phases[0], id: "standard/after-attach", commands: ["ocm @{env} -- status --json"], checkpoint: ["responses"] },
    { ...f.plan.phases[0], id: "standard/after-attach-logs", commands: ["ocm @{env} -- status --json"], checkpoint: ["logs", "state:logs"] }
  );await f.save();
  f.dependencies.execute = async (command, options) => {
    const result = await execute(command, options);
    assert.equal(Object.hasOwn(options, "attachmentLogs"), false, "in-memory filter must not reach child execution options");
    const tokens = parseCatalogueCommand(command).tokens, env = tokens[1]?.slice(1);
    if (tokens[3] !== "attach") {
      if (tokens[3] === "status" && issued.has(env)) await appendFile(productLogs.get(env), `later grant=${token}-${env}\nordinary later line\n`);
      return result;
    }
    issued.add(env);
    assert.equal(published.get(env).observedLogs[0].pending, true, "existing background operations see pending before native attach starts");
    assert.equal(JSON.parse(options.env.KOVA_VERIFY_STATE_POLICIES_JSON)[env].observedLogs[0].pending, true, "child context is taken after marking pending");
    const path = options.env.TMPDIR;temporaryPaths.push(path);
    assert.equal(dirname(path), options.cwd);assert.equal(isPrivateVerificationPath(path), true);assert.equal(options.env.TMP, path);assert.equal(options.env.TEMP, path);
    await writeFile(join(path, ".mcp.json"), '{"Authorization":"Bearer ${OPENCLAW_MCP_TOKEN}"}');
    await appendFile(productLogs.get(env), `native grant=${token}-${env}\nordinary OPENCLAW_MCP_TOKEN=value\n`);
    return { ...result, stdout: malformed ? `{"env":{"OPENCLAW_MCP_TOKEN":"${token}-${env}` : JSON.stringify({ env: { OPENCLAW_MCP_TOKEN: `${token}-${env}` }, configPath: join(path, ".mcp.json") })+"\nGrant is live.\n", stderr: `${token}-${env}` };
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.cleanupErrors, []);assert.deepEqual(result.incomplete, malformed ? ["standard/second", "standard/after-attach-logs"] : []);
  assert.equal(temporaryPaths.length, 5);
  for (const clone of Object.values(result.clones)) assert.equal(clone.phases["standard/after-attach"], "recorded");
  for (const [name, clone] of Object.entries(result.clones)) {
    const checkpoints = join(f.dependencies.home, "verify", result.id, name, "checkpoints");
    if (malformed) {
      assert.match(clone.captureErrors["standard/after-attach-logs"], /cannot safely capture logs after incomplete native attach output/);
      await assert.rejects(readFile(join(checkpoints, "standard/after-attach-logs/logs.txt")), { code: "ENOENT" });
    } else {
      assert.equal(await readFile(join(checkpoints, "standard/second/logs.txt"), "utf8"), "native grant=\nordinary OPENCLAW_MCP_TOKEN=value\n");
      assert.equal(await readFile(join(checkpoints, "standard/after-attach-logs/logs.txt"), "utf8"), "later grant=\nordinary later line\n");
      assert.ok(await readFile(join(checkpoints, "standard/after-attach-logs/state/logs/product.log"), "utf8") === "ordinary startup\nnative grant=\nordinary OPENCLAW_MCP_TOKEN=value\n" + "later grant=\nordinary later line\n".repeat(2));
    }
  }
  for (const path of [...privateRoots, ...temporaryPaths]) await assert.rejects(readdir(path), { code: "ENOENT" });
  const files = await readdir(f.dependencies.home, { recursive: true });
  for (const name of files) { try { assert.equal((await readFile(join(f.dependencies.home, name), "utf8")).includes(token), false); } catch (error) { if (error.code !== "EISDIR") throw error; } }
});

test("relative artifact roots become absolute before clone preparation and dispatch", async (t) => {
  const f = await fixture(t), makeClone = f.dependencies.cloneFactory;
  f.dependencies.home = relative(process.cwd(), join(f.root, "relative-home"));
  assert.equal(isAbsolute(f.dependencies.home), false);
  f.dependencies.cloneFactory = (options) => {
    assert.equal(isAbsolute(options.directory), true);
    assert.equal(isAbsolute(options.persona.archive), true);
    return makeClone(options);
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.notStarted, []);assert.deepEqual(result.incomplete, []);
  assert.equal(isAbsolute(result.path), true);assert.equal(isAbsolute(result.plan.path), true);
  assert.equal(f.removed.length, 5);
});


test("verification child commands cannot inherit Gateway credentials or diagnostic output paths", async (t) => {
  const f = await fixture(t), execute = f.dependencies.execute;
  const values = { OPENCLAW_CONFIG_PATH: join(f.root, "unrelated-config.json"), OPENCLAW_GATEWAY_TOKEN: "synthetic-unrelated-token", OPENCLAW_MCP_TOKEN: "synthetic-unrelated-mcp-token", OPENCLAW_TTS_PREFS: join(f.root, "durable-preferences.json"), OPENCLAW_CACHE_TRACE_FILE: join(f.root, "durable-cache.jsonl") };
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  Object.assign(process.env, values);
  f.dependencies.execute = (command, options) => {
    for (const name of Object.keys(values)) assert.equal(options.env[name], "");
    assert.equal(options.env.KOVA_OPENCLAW_CONFIG_CONTRACT, "canonical");
    return execute(command, options);
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.notStarted, []);assert.deepEqual(result.incomplete, []);
  for (const [name, value] of Object.entries(values)) assert.equal(process.env[name], value);
});

test("resolved verification-run Gateway fixtures have pinned schema coverage", (t) => requestSchemas.report(t));
