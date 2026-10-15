import { parseCatalogueCommand } from "../src/catalogue.mjs";
import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, appendFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createLogCollector, recordPhase, snapshotState, writeCheckpoint } from "../src/verify/checkpoint.mjs";
import { quoteShell, runCommand } from "../src/commands.mjs";
import { runVerification, compareVersions, prepareRun, validateRunPlan, validateTarget, validateRunDestinations as validateRawRunDestinations } from "../src/verify/run.mjs";
import { resolveRunCommand } from "../src/verify/clones.mjs";
import { canonicalJSON, sha256 } from "../src/verify/plan.mjs";
import { repoRoot } from "../src/paths.mjs";
import { parseGatewayCallArgs, resolveGatewayParams } from "../support/verify/gateway-call.mjs";
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
    CREATE TABLE native_hook_relay_bridges (relay_id TEXT NOT NULL PRIMARY KEY, pid INTEGER NOT NULL, hostname TEXT NOT NULL, port INTEGER NOT NULL, token TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE channel_ingress_events (queue_name TEXT NOT NULL, event_id TEXT NOT NULL, channel_id TEXT NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL, lane_key TEXT, payload_json TEXT NOT NULL, metadata_json TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claim_token TEXT, claim_owner TEXT, claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, last_error TEXT, failed_reason TEXT, failed_at INTEGER, completed_at INTEGER, completed_metadata_json TEXT, PRIMARY KEY(queue_name, event_id)) STRICT;
    CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY);
    CREATE TABLE session_suggestions (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, author_id TEXT NOT NULL, author_label TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','accepted','dismissed')), dispatch_token TEXT, dispatch_started_at INTEGER, dispatch_resolution TEXT CHECK(dispatch_resolution IN ('send','queue','edit','dismiss')), CHECK((dispatch_token IS NULL AND dispatch_started_at IS NULL AND dispatch_resolution IS NULL) OR (dispatch_token IS NOT NULL AND dispatch_started_at IS NOT NULL AND dispatch_resolution IS NOT NULL)), FOREIGN KEY(session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE) STRICT;`);
  const markers = Object.fromEntries(["private", "auth", "origin", "bootstrap-a", "bootstrap-b", "paired", "join-code", "join-token", "channel-code", "vapid", "relay", "claim", "deleted"].map((name) => [name, `fixture-${name}-material`]));
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
  source.prepare("INSERT INTO native_hook_relay_bridges VALUES ('relay',12,'localhost',1234,?,13,14)").run(markers.relay);
  for (const [id, claim] of [["active", markers.claim], ["idle", null]]) source.prepare("INSERT INTO channel_ingress_events(queue_name,event_id,channel_id,account_id,status,payload_json,received_at,updated_at,claim_token) VALUES ('queue',?,'chat','default','pending',?,1,2,?)").run(id, '{"message":"keep this content"}', claim);
  source.exec("INSERT INTO session_nodes VALUES ('session'); INSERT INTO session_suggestions(id,session_key,author_id,text,created_at,state) VALUES ('suggestion','session','person','Preserve this suggestion.',15,'pending')");
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
  expected.native_hook_relay_bridges[0].token = "";
  expected.channel_ingress_events[0].claim_token = "";
  const output = join(directory, "initial-state");
  await snapshotState(state, ["openclaw.sqlite"], output);
  const checkpoint = await writeCheckpoint({ phase: { id: "intent/pairing", checkpoint: ["state:openclaw.sqlite"] }, directory, results: [], stateDirectory: state });
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

test("legacy pairing JSON preserves metadata in primary and profile paths", async (t) => {
  const directory = await temporary(t), state = join(directory, "state"), output = join(directory, "copy");
  await mkdir(state);
  const markers = { pem: "legacy-private-pem", raw: "legacy-private-raw", auth: "legacy-auth-token", paired: "legacy-paired-token", first: "legacy-bootstrap-first", second: "legacy-bootstrap-second" };
  const roles = { operator: { token: markers.paired, role: "operator", scopes: ["operator.read"], createdAtMs: 7 } };
  const bootstrap = { [markers.first]: { token: markers.first, ts: 1, profile: { roles: ["node"], scopes: [] } }, [markers.second]: { token: markers.second, ts: 2, deviceId: "device" } };
  const redactedBootstrap = Object.fromEntries(Object.entries(bootstrap).map(([key, value]) => [`redacted:${sha256(key)}`, { ...value, token: "" }]));
  const files = [
    ["identity/device.json", { version: 1, privateKeyPem: markers.pem, publicKeyPem: "public", deviceId: "device" }, { version: 1, privateKeyPem: "", publicKeyPem: "public", deviceId: "device" }],
    ["identity/device-auth.json", { version: 1, deviceId: "device", tokens: { node: { token: markers.auth, role: "node", scopes: [] } } }, { version: 1, deviceId: "device", tokens: { node: { token: "", role: "node", scopes: [] } } }],
    ...["devices/paired.json", "devices/paired.json.migrated"].map((path) => [path, { device: { publicKey: "public", tokens: roles } }, { device: { publicKey: "public", tokens: { operator: { ...roles.operator, token: "" } } } }]),
    ...["devices/bootstrap.json", "devices/bootstrap.json.migrated"].map((path) => [path, bootstrap, redactedBootstrap])
  ];
  const originals = new Map(), expected = new Map();
  for (const prefix of ["", "profiles/.openclaw-paired/"]) for (const [path, input, redacted] of files) {
    const target = `${prefix}${path}`;
    const value = prefix && path === "identity/device.json" ? { privateKey: markers.raw, publicKey: "public", deviceId: "device" } : input;
    const observed = prefix && path === "identity/device.json" ? { ...value, privateKey: "" } : redacted;
    await mkdir(dirname(join(state, target)), { recursive: true });
    const bytes = JSON.stringify(value);
    await writeFile(join(state, target), bytes);
    originals.set(target, bytes); expected.set(target, observed);
  }
  await writeFile(join(state, "ordinary.json"), '{"privateKey":"ordinary text","token":"ordinary payload"}');
  await symlink(join(state, "identity/device.json"), join(state, "identity-alias"));
  const selections = ["identity", "devices", "profiles", "ordinary.json", "identity-alias"];
  await snapshotState(state, selections, output);
  const checkpoint = await writeCheckpoint({ phase: { id: "intent/legacy-pairing", checkpoint: selections.map((path) => `state:${path}`) }, directory, results: [], stateDirectory: state });
  for (const destination of [output, join(checkpoint.path, "state")]) {
    for (const [path, value] of expected) {
      const bytes = await readFile(join(destination, path));
      for (const marker of Object.values(markers)) assert.equal(bytes.includes(Buffer.from(marker)), false);
      assert.deepEqual(JSON.parse(bytes), value);
    }
    assert.deepEqual(await readJSON(join(destination, "identity-alias")), expected.get("identity/device.json"));
    assert.deepEqual(await readJSON(join(destination, "ordinary.json")), { privateKey: "ordinary text", token: "ordinary payload" });
  }
  for (const [path, bytes] of originals) assert.equal(await readFile(join(state, path), "utf8"), bytes);
});

test("generated hook configuration stays private in final captures and backups", async (t) => {
  const { automationHookConfiguration } = await import("../support/persona/make-automation-rows.mjs");
  const directory = await temporary(t), state = join(directory, "state"), output = join(directory, "copy");
  const marker = "synthetic-hook-fixture-value-0123456789";
  const config = automationHookConfiguration({ gateway: { mode: "local", bind: "loopback" }, hooks: { internal: { enabled: true } }, note: { token: "ordinary text" } }, () => marker);
  const expected = { ...config, hooks: { ...config.hooks, token: "" } };
  const files = ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.kova-12345678-1234-4234-8234-123456789012", "profiles/.openclaw-paired/openclaw.json5"];
  for (const path of files) {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), `// existing OpenClaw JSON5 configuration\n${JSON.stringify(config)}`);
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

test("malformed known legacy credential files cannot publish raw JSON", async (t) => {
  const directory = await temporary(t), state = join(directory, "state");
  for (const [index, [path, bytes]] of [
    ["openclaw.json", "not JSON"],
    ["openclaw.json.bak", '{"hooks":{"token":{"nested":"material"}}}'],
    ["identity/device.json", "not JSON"],
    ["identity/device.json", '{"privateKeyPem":{"nested":"material"}}'],
    ["identity/device-auth.json", '{"tokens":[]}'],
    ["devices/paired.json.migrated", '{"device":{"tokens":{"operator":[]}}}'],
    ["profiles/.openclaw-paired/devices/bootstrap.json", '{"material":{"token":42}}']
  ].entries()) {
    await mkdir(dirname(join(state, path)), { recursive: true });
    await writeFile(join(state, path), bytes);
    const phase = { id: `intent/malformed-${index}`, checkpoint: [`state:${path}`] };
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
  const output = join(directory, "copy");
  await snapshotState(state, ["openclaw.sqlite", "openclaw.sqlite-journal", "journal-alias", "renamed-journal-pages", "notes-journal"], output);
  assert.deepEqual((await readdir(output)).sort(), ["notes-journal", "openclaw.sqlite"]);
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
        for (const key of ["OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_TTS_PREFS", "OPENCLAW_CACHE_TRACE_FILE"]) assert.equal(executionEnv[key], "");
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
  const standard = await readJSON(join(repoRoot, "verify/standard.json"));
  const phase = { ...standard.after.find((item) => item.id === "snapshot"), id: "standard/snapshot", from: "standard" };
  assert.deepEqual(phase.commands, ["ocm env show {env} --json"]);
  f.plan.phases.push(phase);
  await f.save();
  const makeClone = f.dependencies.cloneFactory;
  f.dependencies.cloneFactory = (options) => {
    const clone = makeClone(options), prepare = clone.prepare;
    clone.prepare = async () => {
      const metadata = await prepare();
      await mkdir(join(metadata.stateDir, "agents"));
      await writeFile(join(metadata.stateDir, "agents/state.json"), '{"observed":true}');
      await writeFile(join(metadata.stateDir, "openclaw.json"), '{"gateway":{"mode":"local"}}');
      return metadata;
    };
    return clone;
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.incomplete, []);
  assert.deepEqual(result.cleanupErrors, []);
  assert.equal(f.calls.some((command) => parseCatalogueCommand(command).tokens.includes("snapshot")), false);
  for (const name of Object.keys(result.clones)) {
    assert.equal(result.clones[name].phases[phase.id], "recorded");
    const checkpoint = join(f.dependencies.home, "verify", result.id, name, "checkpoints", phase.id);
    assert.deepEqual(await readJSON(join(checkpoint, "state/agents/state.json")), { observed: true });
    assert.deepEqual(await readJSON(join(checkpoint, "state/openclaw.json")), { gateway: { mode: "local" } });
    assert.equal((await readJSON(join(checkpoint, "responses.json")))[0].name, name);
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
  old.recordingFormat = 5;
  await writeFile(file, JSON.stringify(old));
  const second = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.equal(second.clones.baseline.cached, false);
  assert.equal((await readJSON(file)).recordingFormat, 6);
  assert.equal(f.created.length, 10);
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
    "node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.list --out {run}/checkpoints/standard/use-target/commands.json",
    "node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.list --out {run}/initial-state/openclaw.json"
  ]) {
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
  assert.doesNotThrow(() => validateRunPlan(f.plan, f.catalogue));
  f.plan.phases[1].commands = [`${cursor}/outside/target.json --out {run}/params.json`];
  f.plan.phasesSha256 = sha256(canonicalJSON(f.plan.phases));
  assert.throws(() => validateRunPlan(f.plan, f.catalogue), /--target-from must stay/);
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
  definition.traits[0].check = `node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.list --params '{}' --out ${f.root}/./durable/check.json`;
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
  const approved = `{logging:{level:'debug',file:${JSON.stringify(join(copy, "product.log"))}}}`;
  await writeFile(patch, approved);
  const prepared = await validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(patch)}`, context);
  const tokens = parseCatalogueCommand(prepared, { standard: true }).tokens, frozen = tokens[tokens.indexOf("--file") + 1];
  assert.notEqual(frozen, patch);assert.equal(dirname(frozen), join(output, ".inputs"));
  await writeFile(patch, JSON.stringify({ logging: { file: join(durable, "injected.log") } }));
  assert.equal(await readFile(frozen, "utf8"), approved);
  await assert.rejects(validateRunDestinations(`node /helper --out ${quoteShell(join(output, ".inputs/other.json"))}`, context), /protected evidence/);
  await assert.rejects(validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(patch)}`, context), /owned copy/);
  const second = join(root, "second");await mkdir(second);await symlink(durable, join(second, ".inputs"));
  await writeFile(patch, approved);
  await assert.rejects(validateRunDestinations(`ocm @copy -- config patch --file ${quoteShell(patch)}`, { ...context, run: second }), /owned directory/);
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
  const values = { OPENCLAW_CONFIG_PATH: join(f.root, "unrelated-config.json"), OPENCLAW_GATEWAY_TOKEN: "synthetic-unrelated-token", OPENCLAW_TTS_PREFS: join(f.root, "durable-preferences.json"), OPENCLAW_CACHE_TRACE_FILE: join(f.root, "durable-cache.jsonl") };
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
