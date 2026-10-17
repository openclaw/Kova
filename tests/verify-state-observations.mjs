import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkpointRows } from "../src/verify/rows.mjs";
import { compareItems, noiseFloor } from "../src/verify/classify.mjs";
import { responseData, transcriptMeasurements } from "../src/verify/measurements.mjs";

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
