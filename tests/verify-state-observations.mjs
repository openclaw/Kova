import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { checkpointRows } from "../src/verify/rows.mjs";
import { compareItems, noiseFloor } from "../src/verify/classify.mjs";
import { responseData, transcriptMeasurements, runtimeTranscriptMessages } from "../src/verify/measurements.mjs";
import { normalizeDeclaredIds } from "../src/verify/normalize.mjs";
import { sha256 } from "../src/verify/plan.mjs";

function installedIndex() {
  const signature = { size: 64, mtimeMs: 1000.25, ctimeMs: 2000.5, unknown: "keep" };
  return { revision: 1, index: {
    version: 1, migrationVersion: 1, hostContractVersion: "1", compatRegistryVersion: "1",
    policyHash: "policy", generatedAtMs: 100, installRecords: {}, diagnostics: [],
    plugins: [{
      pluginId: "fixture", manifestPath: "/plugins/fixture/openclaw.plugin.json", manifestHash: "manifest-hash",
      rootDir: "/plugins/fixture", origin: "bundled", enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] }, compat: [],
      manifestFile: { ...signature }, doctorContractHash: "doctor-hash", doctorContractFile: { ...signature },
      packageJson: { path: "package.json", hash: "package-hash", fileSignature: { ...signature } },
      packageInstall: { mtimeMs: 123, manifestFile: { ...signature } }, unknown: { ctimeMs: 456 }
    }]
  } };
}

async function recordings(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-state-observations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let count = 0;
  return async (value, { path = "state/openclaw.sqlite", table = "config_machine_state", key = "plugins.installedIndex" } = {}) => {
    const directory = join(root, String(count++)), file = join(directory, "state", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(join(directory, "commands.json"), "[]");
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE "${table}" (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)`);
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`).run(key, JSON.stringify(value), 100);
    } finally { db.close(); }
    const audit = [];
    const phase = { id: "plugins/read", commands: [], checkpoint: [`state:${path.split("/")[0]}`] };
    const result = await checkpointRows(directory, phase, { stateIds: [], compressed: [] }, { text: value => value, id: value => value }, 0, [], item => audit.push(item));
    return { ...result, audit };
  };
}

const differences = (before, after) => compareItems({ phase: "plugins/read", baseline: before.items,
  changes: [after.items, after.items], noise: noiseFloor(before.items, before.items), expects: [] }).rows;

test("runtime transcript companions require intact native JSON and declared compressed storage", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE transcript_events(session_id TEXT,event_json,event_zstd,event_utf8_bytes INTEGER)");
    const path = "agents/main/agent/openclaw-agent.sqlite", sessions = new Set(["session-a"]);
    const standard = { compressed: [{ path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_events", column: "event_zstd", codec: "zstd" }] };
    const event = { type: "message", id: "event-a", timestamp: "2026-10-17T15:00:00.000Z", message: { role: "assistant", timestamp: 1000 } };
    const text = JSON.stringify(event), insert = db.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)");
    insert.run("session-a", text, null, Buffer.byteLength(text));
    insert.run("session-a", null, zstdCompressSync(Buffer.from(text)), Buffer.byteLength(text));
    insert.run("session-b", text, null, Buffer.byteLength(text));
    insert.run("session-a", text.replace('{"type":', '{"type":"application","type":'), null, null);
    insert.run("session-a", Buffer.from(text), null, null);
    insert.run("session-a", null, zstdCompressSync(Buffer.from(text)), Buffer.byteLength(text) + 1);
    insert.run("session-a", "malformed", null, null);
    db.exec("INSERT INTO transcript_events VALUES ('session-a',CAST(X'FF' AS TEXT),NULL,NULL)");
    assert.deepEqual([...runtimeTranscriptMessages(db, path, standard, sessions)], Array(2).fill({ sessionId: "session-a", message: event.message }));
    assert.equal([...runtimeTranscriptMessages(db, path, { compressed: [] }, sessions)].length, 1);
    assert.deepEqual([...runtimeTranscriptMessages(db, "state/application.sqlite", standard, sessions)], []);
  } finally { db.close(); }
});

test("native skills prompt sizes require complete source attestation and retain per-skill evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "kova-skills-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const normalize = value => value.replaceAll(/\/runtimes\/(?:baseline|change)/g, "/runtimes/<runtime>");
  let index = 0;
  const read = async (changed, mode = "identity") => {
    const directory = join(root, String(index++)), path = mode === "foreign" ? "files/application.sqlite" : "agents/main/agent/openclaw-agent.sqlite";
    const file = join(directory, "state", path), table = mode === "foreign-table" ? "application_snapshots" : "session_entry_snapshots";
    await mkdir(dirname(file), { recursive: true }); await writeFile(join(directory, "commands.json"), "[]");
    const runtime = mode === "unchanged-count" ? "shared" : changed ? "change" : "baseline";
    const block = `<skill><name>native</name><description>${changed && mode === "content" ? "changed description 😀" : "description 😀"}</description><location>/runtimes/${runtime}/skills/native/SKILL.md</location></skill>`;
    const prompt = `\n<available_skills>\n${block}\n</available_skills>\n`, catalog = prompt.trim();
    const snapshot = { prompt, version: 1 }, report = { skills: { promptChars: catalog.length, hash: sha256(catalog), entries: [{ name: "native", blockChars: block.length }] } };
    if (!changed && mode === "unchanged-count") snapshot.prompt = prompt.replace("description 😀", "refreshed description 😀");
    if (changed && mode === "bad-count") report.skills.promptChars = normalize(catalog).length;
    if (changed && mode === "bad-hash") report.skills.hash = "0".repeat(64);
    if (changed && mode === "bad-entry") report.skills.entries[0].blockChars++;
    if (changed && mode === "missing-hash") delete report.skills.hash;
    if (changed && mode === "extra-entry") report.skills.entries.push({ name: "other", blockChars: 3 });
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE ${table}(session_key TEXT,field TEXT,value_json TEXT${mode === "duplicate-row" ? "" : ",PRIMARY KEY(session_key,field)"})`);
      const insert = db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`);
      if (!(changed && mode === "missing-source")) {
        let raw = JSON.stringify(snapshot);
        if (changed && mode === "duplicate-member") raw = raw.replace('{"prompt":', '{"prompt":"wrong","prompt":');
        if (changed && mode === "bad-encoding") raw = Buffer.from([0xff]);
        insert.run("session", "skillsSnapshot", raw);
        if (changed && mode === "duplicate-row") insert.run("session", "skillsSnapshot", "malformed");
      }
      insert.run("session", "systemPromptReport", JSON.stringify(report));
    } finally { db.close(); }
    const audit = [], phase = { id: "sessions/skills", commands: [], checkpoint: [`state:${path.split("/")[0]}`] };
    const result = await checkpointRows(directory, phase, { stateIds: [], compressed: [] }, { text: normalize, id: value => value }, 0, [], item => audit.push(item));
    return { ...result, audit };
  };
  const before = await read(false), after = await read(true), rows = differences(before, after);
  assert.ok(!rows.some(row => row.at.endsWith("/skills/promptChars")), "generated path length is excluded from the attested aggregate");
  assert.ok(rows.some(row => row.at.endsWith("/skills/entries/0/blockChars") && row.class === "break"), "per-skill sizes remain original observations");
  for (const copy of [before, after]) {
    const excluded = copy.audit.filter(item => item.at.endsWith("/skills/promptChars"));
    assert.equal(excluded.length, 1); assert.equal(excluded[0].category, "measurements");
    assert.match(excluded[0].reason, /catalog, digest and entries/);
  }
  await t.test("unchanged report counts stay literal with refreshed or matching catalog companions", async () => {
    const baseline = await read(false, "unchanged-count"), changed = await read(true, "unchanged-count");
    assert.ok(!differences(baseline, changed).some(row => row.at.endsWith("/skills/promptChars")));
    for (const copy of [baseline, changed]) assert.ok(!copy.audit.some(item => item.at.endsWith("/skills/promptChars")));
  });
  for (const mode of ["content", "foreign", "foreign-table", "bad-count", "bad-hash", "bad-entry", "missing-hash", "extra-entry", "missing-source", "duplicate-member", "bad-encoding", "duplicate-row"]) {
    const baseline = await read(false, mode), changed = await read(true, mode);
    assert.ok(differences(baseline, changed).some(row => row.at.endsWith("/skills/promptChars") && row.class === "break"), mode);
    if (!["content"].includes(mode)) assert.ok(!changed.audit.some(item => item.at.endsWith("/skills/promptChars")), `${mode}: unsupported evidence stays literal`);
  }
});

test("native Gateway process clocks preserve lease ownership and boot outcomes", async t => {
  const root = await mkdtemp(join(tmpdir(), "kova-state-observations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let index = 0;
  const read = async (changed, mode = "clock") => {
    const directory = join(root, String(index++)), state = join(directory, "state", mode === "other-database" ? "files" : "state");
    await mkdir(state, { recursive: true });
    await writeFile(join(directory, "commands.json"), "[]");
    const db = new DatabaseSync(join(state, "openclaw.sqlite"));
    const owner = { pid: mode === "invalid-owner" ? "123" : 123, host: "lab", startedAt: changed ? 1792251169 : 1792251163 };
    if (mode === "null" && changed) owner.startedAt = null;
    if (mode === "missing" && changed) delete owner.startedAt;
    if (mode === "literal" && changed) owner.startedAt = "<time>";
    if (mode === "malformed") owner.startedAt = changed ? -2 : -1;
    const payload = { owner, port: 18789, mode: changed && mode === "outcome" ? "supervised" : "foreground", supervisor: null, application: { startedAt: changed && mode === "application" ? 2 : 1 } };
    try {
      const columns = { boot_id: "TEXT PRIMARY KEY", started_at_ms: "INTEGER", completed_at_ms: "INTEGER", outcome: "TEXT", reason: "TEXT" };
      if (changed && mode === "missing-boot-start") delete columns.started_at_ms;
      if (changed && mode === "missing-boot-completion") delete columns.completed_at_ms;
      db.exec(`CREATE TABLE state_leases(scope TEXT, lease_key TEXT, payload_json TEXT, PRIMARY KEY(scope, lease_key)); CREATE TABLE gateway_boot_lifecycle(${Object.entries(columns).map(([name, type]) => `${name} ${type}`).join(",")})`);
      db.prepare("INSERT INTO state_leases VALUES(?,?,?)").run(mode === "other-scope" ? "application" : "gateway-owner", mode === "other-key" ? "application" : "global", JSON.stringify(payload));
      const start = changed ? 1792251169000 : 1792251163000;
      const boot = { boot_id: "same-boot", started_at_ms: changed && mode === "boot-literal" ? "<time>" : start,
        completed_at_ms: changed && mode === "null" ? null : start + 1000, outcome: changed && mode === "outcome" ? "failed" : "clean_stop", reason: "SIGTERM" };
      db.prepare(`INSERT INTO gateway_boot_lifecycle VALUES(${Object.keys(columns).map(() => "?").join(",")})`).run(...Object.keys(columns).map(name => boot[name]));
      if (changed && mode === "extra-boot") db.prepare("INSERT INTO gateway_boot_lifecycle VALUES(?,?,?,?,?)").run("extra-boot", start, null, "starting", null);
    } finally { db.close(); }
    const audit = [], phase = { id: "gateway/read", commands: [], checkpoint: [`state:${mode === "other-database" ? "files" : "state"}`] };
    const result = await checkpointRows(directory, phase, { stateIds: [], compressed: [] }, { text: value => value, id: value => value }, 0, [], item => audit.push(item));
    return { ...result, audit };
  };
  const before = await read(false), after = await read(true);
  assert.deepEqual(differences(before, after), []);
  for (const result of [before, after]) assert.equal(result.audit.filter(item => item.category === "measurements" && /(?:owner\/startedAt|started_at_ms|completed_at_ms)$/.test(item.at)).length, 3);
  for (const mode of ["other-database", "other-scope", "other-key", "invalid-owner", "null", "missing", "literal", "malformed", "outcome", "application", "extra-boot", "missing-boot-start", "missing-boot-completion", "boot-literal"]) {
    assert.ok(differences(await read(false, mode), await read(true, mode)).some(row => row.class === "break"), mode);
  }
});

test("native installed-plugin file timestamps are excluded and fully audited through SQLite checkpoints", async t => {
  const read = await recordings(t), before = installedIndex(), after = structuredClone(before);
  const plugin = after.index.plugins[0];
  for (const signature of [plugin.manifestFile, plugin.doctorContractFile, plugin.packageJson.fileSignature]) {
    signature.mtimeMs += 500;
    signature.ctimeMs += 500;
  }
  const baseline = await read(before), changed = await read(after);
  assert.deepEqual(differences(baseline, changed), []);
  const suffixes = ["manifestFile/mtimeMs", "manifestFile/ctimeMs", "doctorContractFile/mtimeMs", "doctorContractFile/ctimeMs", "packageJson/fileSignature/mtimeMs", "packageJson/fileSignature/ctimeMs"];
  for (const result of [baseline, changed]) {
    assert.equal(result.audit.length, 6);
    assert.ok(result.audit.every(item => item.category === "measurements" && item.after.absent && typeof item.before === "number"));
    assert.deepEqual(result.audit.map(item => suffixes.find(suffix => item.at.endsWith(`/${suffix}`))).sort(), suffixes.toSorted());
  }
  delete before.index.plugins[0].manifestFile.ctimeMs;
  delete after.index.plugins[0].manifestFile.ctimeMs;
  assert.deepEqual(differences(await read(before), await read(after)), [], "the native legacy signature permits an absent ctimeMs");
});

test("installed-plugin sizes, content fingerprints, paths and application fields stay comparable", async t => {
  const read = await recordings(t), before = installedIndex(), after = structuredClone(before);
  const plugin = after.index.plugins[0];
  plugin.manifestFile.size = 65;
  plugin.manifestHash = "changed-manifest";
  plugin.manifestPath = "/plugins/fixture/changed.json";
  plugin.doctorContractHash = "changed-doctor";
  plugin.packageJson.hash = "changed-package";
  plugin.packageJson.path = "changed-package.json";
  plugin.manifestFile.unknown = "changed-signature-field";
  plugin.unknown.ctimeMs++;
  plugin.packageInstall.mtimeMs++;
  plugin.packageInstall.manifestFile.ctimeMs++;
  const rows = differences(await read(before), await read(after));
  const suffixes = ["manifestFile/size", "manifestHash", "manifestPath", "doctorContractHash", "packageJson/hash", "packageJson/path", "manifestFile/unknown", "unknown/ctimeMs", "packageInstall/mtimeMs", "packageInstall/manifestFile/ctimeMs"];
  assert.equal(rows.length, suffixes.length);
  for (const suffix of suffixes) assert.ok(rows.some(row => row.at.endsWith(`/${suffix}`) && row.class === "break"), suffix);
});

test("installed-plugin timestamp normalization requires the native owner and valid signature structure", async t => {
  const read = await recordings(t);
  const gates = [
    ["other database", { path: "files/openclaw.sqlite" }],
    ["other table", { table: "other_machine_state" }],
    ["other state key", { key: "application.installedIndex" }],
    ["invalid revision", {}, value => { value.revision = "1"; }],
    ["unknown version", {}, value => { value.index.version = 2; }],
    ["unknown migration", {}, value => { value.index.migrationVersion = 2; }],
    ["object plugin collection", {}, value => { value.index.plugins = { 0: value.index.plugins[0] }; }],
    ["invalid plugin identity", {}, value => { value.index.plugins[0].pluginId = null; }],
    ["missing manifest path", {}, value => { delete value.index.plugins[0].manifestPath; }]
  ];
  for (const [name, options, mutate] of gates) {
    const value = installedIndex(); mutate?.(value);
    const result = await read(value, options);
    assert.deepEqual(result.audit, [], name);
    assert.ok([...result.items.values()].some(item => item.at.endsWith("/manifestFile/mtimeMs") && item.value === 1000.25), name);
  }
  const invalid = [
    ["string size", signature => { signature.size = "64"; }],
    ["negative size", signature => { signature.size = -1; }],
    ["fractional size", signature => { signature.size = 1.5; }],
    ["missing mtime", signature => { delete signature.mtimeMs; }],
    ["string mtime", signature => { signature.mtimeMs = "1000.25"; }],
    ["null ctime", signature => { signature.ctimeMs = null; }],
    ["object ctime", signature => { signature.ctimeMs = { value: 2000.5 }; }]
  ];
  for (const [name, mutate] of invalid) {
    const value = installedIndex(), signature = value.index.plugins[0].manifestFile;
    mutate(signature);
    const result = await read(value);
    assert.ok(!result.audit.some(item => item.at.includes("/manifestFile/")), name);
    for (const field of ["mtimeMs", "ctimeMs"]) {
      if (!Object.hasOwn(signature, field) || typeof signature[field] === "object" && signature[field] !== null) continue;
      assert.ok([...result.items.values()].some(item => item.at.endsWith(`/manifestFile/${field}`) && item.value === signature[field]), `${name}: ${field}`);
    }
  }
  const value = installedIndex();
  delete value.index.plugins[0].doctorContractHash;
  value.index.plugins[0].packageJson.path = null;
  const result = await read(value);
  assert.equal(result.audit.length, 2, "only the identified manifest signature is normalized");
  for (const path of ["doctorContractFile/mtimeMs", "packageJson/fileSignature/mtimeMs"]) {
    assert.ok([...result.items.values()].some(item => item.at.endsWith(`/${path}`) && item.value === 1000.25), path);
  }
});

async function responses(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-response-observations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let count = 0;
  return async (value, id) => {
    const directory = join(root, String(count++));
    await mkdir(directory);
    await writeFile(join(directory, "commands.json"), JSON.stringify([{ exit: 0, stdout: null, durationMs: 1 }]));
    await writeFile(join(directory, "responses.json"), JSON.stringify({ 0: value }));
    const audit = [];
    const result = await checkpointRows(directory, { id: "observations/read", commands: ["probe"], checkpoint: ["responses"] },
      { stateIds: [], compressed: [] }, { text: value => value, id: value => value }, 1, [{ id, kind: "script" }], item => audit.push(item));
    return { ...result, audit: audit.filter(item => item.signal === "responses") };
  };
}

test("Control UI pending request durations normalize without hiding outcomes or other null fields", async t => {
  const read = await responses(t);
  for (const grouped of [false, true]) {
    const request = { method: "sessions.get", status: "pending", elapsedMs: null, params: { elapsedMs: null } };
    const before = { requests: grouped ? { other: [request] } : [request], steps: [{ elapsedMs: null }], elapsedMs: null };
    const after = structuredClone(before), changed = grouped ? after.requests.other[0] : after.requests[0];
    delete changed.elapsedMs;
    const baseline = await read(before, "control-ui"), equivalent = await read(after, "control-ui");
    assert.deepEqual(differences(baseline, equivalent), []);
    assert.equal(baseline.audit.length, 1);
    assert.equal(baseline.audit[0].before, null);
    assert.ok(baseline.audit[0].after.absent);
    changed.status = "failed";
    changed.elapsedMs = "unknown";
    changed.params.elapsedMs = 7;
    after.steps[0].elapsedMs = "unknown";
    after.elapsedMs = "unknown";
    const rows = differences(baseline, await read(after, "control-ui"));
    for (const suffix of ["/status", "/elapsedMs", "/params/elapsedMs", "/steps/0/elapsedMs"]) {
      assert.ok(rows.some(row => row.at.endsWith(suffix) && row.class === "break"), suffix);
    }
    assert.ok(rows.some(row => row.at === "0/elapsedMs"));
    const other = responseData(before, { id: "application", kind: "script" });
    assert.deepEqual(other, before, "other producers retain pending request fields");
  }
});

function wrappedSubagents(runtimeMs, runtime, status = "done") {
  const details = { action: "list", active: [], recent: [{ index: 1, label: "worker", runtimeMs, runtime, status }], unknown: { runtimeMs: 9 } };
  const wrapper = { tool: { source: "openclaw", id: "openclaw:core:subagents", name: "subagents" },
    result: { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false }, unknown: { durationMs: 8 } };
  return { toolCall: { type: "toolCall", id: "call-1", name: "subagents", arguments: { id: "subagents", args: { action: "list" } }, args: { action: "list" } },
    toolResult: { role: "toolResult", toolCallId: "call-1", toolName: "tool_call", isError: false,
      details: wrapper, content: [{ type: "text", text: JSON.stringify(wrapper) }] } };
}

test("agent tool responses reuse native wrapped subagent measurements and preserve outcomes", async t => {
  const read = await responses(t), before = wrappedSubagents(2000, "2s"), after = wrappedSubagents(241000, "4m1s");
  const baseline = await read(before, "agent-tool-turn"), equivalent = await read(after, "agent-tool-turn");
  assert.deepEqual(differences(baseline, equivalent), []);
  assert.ok(baseline.audit.some(item => item.at.endsWith("/details/result/details/recent/0/runtimeMs")));
  assert.ok(baseline.audit.some(item => item.at.endsWith("/details/result/details/recent/0/runtime")));
  const changed = wrappedSubagents(241000, "4m1s", "failed");
  changed.toolResult.isError = true;
  changed.toolResult.details.result.isError = true;
  changed.toolResult.details.result.details.unknown.runtimeMs = 10;
  changed.toolResult.details.unknown.durationMs = 9;
  const rows = differences(baseline, await read(changed, "agent-tool-turn"));
  for (const suffix of ["/recent/0/status", "/isError", "/unknown/runtimeMs", "/unknown/durationMs"]) {
    assert.ok(rows.some(row => row.at.endsWith(suffix) && row.class === "break"), suffix);
  }
  const message = before.toolResult;
  const normalized = transcriptMeasurements({ type: "message", message }).message;
  assert.equal(Object.hasOwn(normalized.details.result.details.recent[0], "runtimeMs"), false);
  assert.equal(Object.hasOwn(JSON.parse(normalized.content[0].text).result.details.recent[0], "runtimeMs"), false);
});

test("tool response normalization preserves mismatched, unknown and recursive wrappers", () => {
  const controls = [
    value => { value.toolCall.id = "different"; },
    value => { value.toolCall.type = "text"; },
    value => { value.toolCall.name = "exec"; },
    value => { value.toolCall.arguments.id = "exec"; },
    value => { value.toolResult.role = "user"; },
    value => { value.toolResult.toolName = "other"; },
    value => { value.toolResult.details.tool.source = "mcp"; },
    value => { value.toolResult.details.tool.id = "plugin:subagents"; },
    value => { value.toolResult.details.tool.name = "tool_call"; value.toolResult.details.tool.id = "openclaw:core:tool_call"; },
    value => { value.toolResult.details.result.content = "not content blocks"; }
  ];
  for (const mutate of controls) {
    const value = wrappedSubagents(2000, "2s"); mutate(value);
    assert.deepEqual(responseData(value, { id: "agent-tool-turn", kind: "script" }), value);
  }
  const unknown = wrappedSubagents(2000, "2s");
  assert.equal(responseData(unknown, { id: "other-script", kind: "script" }), unknown);
  const recursive = { type: "message", message: structuredClone(unknown.toolResult) };
  recursive.message.details.tool = { source: "openclaw", name: "tool_call", id: "openclaw:core:tool_call" };
  assert.equal(transcriptMeasurements(recursive), recursive);
  const foreign = { type: "message", message: structuredClone(unknown.toolResult) };
  const text = JSON.parse(foreign.message.content[0].text);
  text.tool = { source: "openclaw", name: "exec", id: "openclaw:core:exec" };
  foreign.message.content[0].text = JSON.stringify(text);
  assert.equal(transcriptMeasurements(foreign).message.content[0].text, foreign.message.content[0].text);
});

test("direct native tool responses retain malformed durations, statuses and command text", () => {
  const value = { toolCall: { type: "toolCall", id: "call", name: "exec" }, toolResult: { role: "toolResult", toolCallId: "call", toolName: "exec",
    details: { durationMs: "slow", status: { malformed: true }, exitCode: 7 }, content: [{ type: "text", text: "durationMs=123 application output" }] } };
  assert.equal(responseData(value, { id: "agent-tool-turn", kind: "script" }), value);
  value.toolResult.details.durationMs = 123;
  const normalized = responseData(value, { id: "agent-tool-turn", kind: "script" });
  assert.deepEqual(normalized.toolResult.details, { status: { malformed: true }, exitCode: 7 });
  assert.deepEqual(normalized.toolResult.content, value.toolResult.content);
  const malformed = wrappedSubagents("slow", "not a duration");
  assert.equal(responseData(malformed, { id: "agent-tool-turn", kind: "script" }), malformed);
});

const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
function nestedWait(index, scopeId = scopeA, offset = 0) {
  const result = { status: "ok", action: "wait", reason: "completed", runs: [{
    runId: "child-run", sessionKey: "agent:main:child", status: "terminal", outcome: { status: "ok" },
    deliveryStatus: "pending", startedAt: 100 + offset, endedAt: 200 + offset
  }], completed: ["child-run"], attention: [], unknown: { startedAt: 7 } };
  const toolCallId = `nested-${index}`, startedAt = 300 + offset;
  return { type: "message", id: `event-${index}`, parentId: "parent", timestamp: "2026-10-17T15:45:03.089Z", message: {
    role: "custom", customType: "openclaw.nested-tool.v1", display: true, excludeFromContext: true, content: "",
    details: { runId: "parent-run", scopeId, afterEntryId: "parent", startOrder: index,
      parentToolCallId: "outer-call", toolCallId, toolName: "subagents", input: { action: "wait", runIds: ["child-run"], timeoutSeconds: 60 },
      result: { content: [{ type: "text", text: JSON.stringify(result) }], details: result },
      isError: false, startedAt, timestamp: startedAt + 1 }, timestamp: startedAt,
    idempotencyKey: `${scopeId}:${toolCallId}`
  } };
}

async function nestedRecordings(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-nested-observations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let index = 0;
  return async (events, { foreign = false, stateIds = [], normalization = { text: value => value, id: value => value }, runtime = false } = {}) => {
    const directory = join(root, String(index++)), path = foreign ? "files/application.sqlite" : "agents/main/agent/openclaw-agent.sqlite";
    const file = join(directory, "state", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(join(directory, "commands.json"), "[]");
    const db = new DatabaseSync(file);
    try {
      const table = runtime ? "trajectory_runtime_events" : "transcript_events";
      db.exec(`CREATE TABLE ${table}(session_id TEXT, seq INTEGER, event_json TEXT, PRIMARY KEY(session_id,seq))`);
      const insert = db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`);
      for (const [position, event] of events.entries()) insert.run("session-1", position, JSON.stringify(event));
    } finally { db.close(); }
    const audit = [], phase = { id: "sessions/nested", commands: [], checkpoint: [`state:${path.split("/")[0]}`] };
    const result = await checkpointRows(directory, phase, { stateIds, compressed: [] }, normalization, 0, [], item => audit.push(item));
    return { ...result, audit };
  };
}

const nestedScopeDeclaration = { kind: "nested-tool-scope-ids", path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_events", column: "event_json", recordKey: "session_id", order: "seq" };

test("nested identity declarations retain field-level transcript comparison and typed clocks", async t => {
  const read = await nestedRecordings(t), options = { stateIds: [nestedScopeDeclaration] };
  const event = (text, clock) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: clock } });
  const baseline = await read([event("pass", 100)], options), changed = await read([event("fail", 200)], options);
  const firstNoise = await read([event("pass", 300)], options), secondNoise = await read([event("pass", 400)], options);
  const compared = compareItems({ phase: "sessions/nested", baseline: baseline.items, changes: [changed.items, changed.items], noise: noiseFloor(firstNoise.items, secondNoise.items), expects: [] });
  const content = compared.rows.find(row => row.at.endsWith("/message/content/0/text"));
  assert.equal(content?.class, "break");
  const expected = compareItems({ phase: "sessions/nested", baseline: baseline.items, changes: [changed.items, changed.items], noise: noiseFloor(firstNoise.items, secondNoise.items), expects: [{ phase: "sessions/nested", signal: "state", at: content.at, change: "fail" }] });
  assert.equal(expected.rows.find(row => row.at === content.at)?.class, "intended");
  assert.deepEqual(differences(await read([{ type: "message", message: { role: "user", content: "hello" } }], options),
    await read([{ message: { content: "hello", role: "user" }, type: "message" }], options)), []);
  const native = nestedWait(0), literal = structuredClone(native);
  literal.message.details.result.details.runs[0].startedAt = "<time>";
  literal.message.details.result.details.runs[0].endedAt = "<time>";
  assert.ok(differences(await read([native], options), await read([literal], options)).some(row => row.class === "break" && row.at.endsWith("/runs/0/startedAt")));
});

test("measured wait text normalizes identities before noise filtering in transcript and runtime records", async t => {
  const read = await nestedRecordings(t);
  for (const runtime of [false, true]) {
    const copy = async (id, clock, corrupt = false) => {
      const event = JSON.parse(JSON.stringify(nestedWait(0, scopeA, clock)).replaceAll("child-run", id));
      if (corrupt) {
        const result = JSON.parse(event.message.details.result.content[0].text);
        result.runs[0].outcome.status = "failed";
        event.message.details.result.content[0].text = JSON.stringify(result);
      }
      const captured = runtime ? { traceSchema: "openclaw-trajectory", schemaVersion: 1, source: "runtime", type: "tool.result", data: { name: "subagents", result: event.message.details.result } } : event;
      const ids = normalizeDeclaredIds({ candidates: new Map([[id, "<id:child>"]]), records: new Map(), allIds: new Set([id]) }, new Set());
      const normalization = { ...ids, text: (value, report) => {
        const after = ids.text(value);
        if (after !== value) report?.("declaredIds", "declared generated identity", value, after);
        return after;
      } };
      return read([captured], { stateIds: runtime ? [] : [nestedScopeDeclaration], normalization, runtime });
    };
    const baseline = await copy("base-child", 100), changed = await copy("change-child", 200);
    const firstNoise = await copy("noise-child-one", 300), secondNoise = await copy("noise-child-two", 400);
    assert.deepEqual(differences(baseline, changed), [], `identity-only runtime=${runtime}`);
    const failed = await copy("change-child", 200, true);
    const result = compareItems({ phase: "sessions/nested", baseline: baseline.items, changes: [failed.items, failed.items], noise: noiseFloor(firstNoise.items, secondNoise.items), expects: [] });
    assert.ok(result.rows.some(row => row.class === "break"), `text-only outcome runtime=${runtime}`);
    assert.ok(changed.audit.some(item => item.category === "declaredIds" && item.at.includes("/content/0/text/") && item.before.includes("change-child") && item.after.includes("<id:child>")), `text identity inventory runtime=${runtime}`);
  }
});

test("wrapped wait JSON retains nested marker provenance and rejects lossy text decoding", async t => {
  const read = await nestedRecordings(t);
  for (const runtime of [false, true]) {
    const copy = async (mode, clock = 0, id = "child-run") => {
      const result = JSON.parse(JSON.stringify(nestedWait(0, scopeA, clock).message.details.result).replaceAll("child-run", id));
      result.details.extra = null;
      result.content[0].text = JSON.stringify(result.details);
      const wrapper = { tool: { source: "openclaw", id: "openclaw:core:subagents", name: "subagents" }, result };
      const projection = structuredClone(wrapper);
      if (mode === "inner-text" || mode === "inner-details") {
        const data = mode === "inner-text" ? JSON.parse(projection.result.content[0].text) : projection.result.details;
        data.runs[0].startedAt = "<time>"; data.runs[0].endedAt = "<time>";
        if (mode === "inner-text") projection.result.content[0].text = JSON.stringify(data);
      }
      if (mode === "outcome") {
        const data = JSON.parse(projection.result.content[0].text);
        data.runs[0].outcome.status = "failed";
        projection.result.content[0].text = JSON.stringify(data);
      }
      let text = JSON.stringify(projection);
      if (mode === "duplicate") text = text.replace('"extra":null', '"extra":1,"extra":null');
      if (mode === "overflow") text = text.replace('"extra":null', '"extra":1e400');
      if (mode === "pretty") text = JSON.stringify(projection, null, 2);
      const message = { role: "toolResult", toolName: "tool_call", details: wrapper, content: [{ type: "text", text }] };
      const event = runtime ? { traceSchema: "openclaw-trajectory", schemaVersion: 1, source: "runtime", type: "tool.result", data: { name: "tool_call", result: { details: message.details, content: message.content } } } : { type: "message", message };
      const normalization = normalizeDeclaredIds({ candidates: new Map([[id, "<id:child>"]]), records: new Map(), allIds: new Set([id]) }, new Set());
      return read([event], { stateIds: runtime ? [] : [nestedScopeDeclaration], normalization, runtime });
    };
    const baseline = await copy("native");
    assert.deepEqual(differences(baseline, await copy("native", 1000, "new-child")), [], `nested identity and clock control runtime=${runtime}`);
    assert.deepEqual(differences(baseline, await copy("pretty", 1000, "new-child")), [], `native pretty JSON runtime=${runtime}`);
    for (const mode of ["inner-text", "inner-details", "outcome", "duplicate", "overflow"]) {
      assert.ok(differences(baseline, await copy(mode)).some(row => row.class === "break"), `${mode} runtime=${runtime}`);
    }
  }
});

test("native nested activity clocks compare through persisted checkpoints without hiding correlations", async t => {
  const read = await nestedRecordings(t);
  const before = [nestedWait(0), nestedWait(1), nestedWait(2, scopeB)];
  const after = [nestedWait(0, scopeA, 1000), nestedWait(1, scopeA, 1000), nestedWait(2, scopeB, 1000)];
  const baseline = await read(before), equivalent = await read(after);
  assert.deepEqual(differences(baseline, equivalent), []);
  assert.equal(baseline.audit.some(item => item.at.endsWith("/details/scopeId")), false, "scope identities belong to declared-ID normalization");
  for (const suffix of ["/message/timestamp", "/details/startedAt", "/details/timestamp", "/runs/0/startedAt", "/runs/0/endedAt", "/result/content/0/text"]) {
    assert.ok(baseline.audit.some(item => item.at.endsWith(suffix)), suffix);
  }
  const changed = structuredClone(after);
  changed[0].message.details.input.timeoutSeconds = 61;
  changed[0].message.details.result.details.runs[0].outcome.status = "failed";
  changed[0].message.details.result.details.unknown.startedAt = 8;
  changed[0].message.details.isError = true;
  const changedRows = differences(baseline, await read(changed));
  for (const suffix of ["/input/timeoutSeconds", "/outcome/status", "/unknown/startedAt", "/details/isError"]) {
    assert.ok(changedRows.some(row => row.at.endsWith(suffix) && row.class === "break"), suffix);
  }
  const absent = structuredClone(after);
  delete absent[0].message.details.result.details.runs[0].startedAt;
  absent[0].message.details.result.details.runs[0].endedAt = null;
  assert.ok(differences(baseline, await read(absent)).some(row => row.at.endsWith("/runs/0/endedAt") && row.class === "break"));
  const literalMarkers = structuredClone(before);
  const textOnly = JSON.parse(literalMarkers[0].message.details.result.content[0].text);
  textOnly.runs[0].startedAt = "<time>";
  textOnly.runs[0].endedAt = "<time>";
  literalMarkers[0].message.details.result.content[0].text = JSON.stringify(textOnly);
  assert.ok(differences(baseline, await read(literalMarkers)).some(row => row.at.endsWith("/result/content/0/text") && row.class === "break"), "literal markers in text cannot impersonate normalized clocks while structured details remain valid");
  assert.ok(differences(await read(before, { foreign: true }), await read(after, { foreign: true })).some(row => row.class === "break"), "foreign SQLite payloads retain clocks");
  const withoutKeys = before.map(event => { const copy = structuredClone(event); delete copy.message.idempotencyKey; return copy; });
  const timedWithoutKeys = after.map(event => { const copy = structuredClone(event); delete copy.message.idempotencyKey; return copy; });
  assert.deepEqual(differences(await read(withoutKeys), await read(timedWithoutKeys)), [], "the native optional idempotency field remains absent");
  assert.ok(differences(baseline, await read([...after, nestedWait(3, scopeB, 1000)])).some(row => row.class === "break"), "extra native activity remains visible");
});

test("native nested normalization rejects foreign or malformed envelopes and preserves arbitrary text", () => {
  const controls = [
    event => { event.message.customType = "application.activity"; },
    event => { event.message.role = "user"; },
    event => { event.message.display = false; },
    event => { event.message.excludeFromContext = false; },
    event => { event.message.content = "application text"; },
    event => { event.message.details.scopeId = "not-a-native-uuid"; },
    event => { event.message.details.startedAt = -1; },
    event => { event.message.details.timestamp = null; },
    event => { event.message.timestamp++; },
    event => { event.message.details.extra = { startedAt: 123 }; },
    event => { event.message.idempotencyKey = "different"; }
  ];
  for (const mutate of controls) {
    const event = nestedWait(0); mutate(event);
    assert.equal(transcriptMeasurements(event), event);
  }
  const event = nestedWait(0);
  event.message.details.result.content[0].text = "application startedAt=123 endedAt=456";
  const normalized = transcriptMeasurements(event);
  assert.equal(normalized.message.details.result.content[0].text, event.message.details.result.content[0].text);
  assert.equal(normalized.message.details.scopeId, scopeA, "uncorroborated scope UUID is not deleted");
  const malformedResult = nestedWait(0);
  malformedResult.message.details.result.details.runs[0].endedAt = 50;
  assert.equal(transcriptMeasurements(malformedResult).message.details.result.details, malformedResult.message.details.result.details, "inverted lifecycle clocks remain literal");
});
