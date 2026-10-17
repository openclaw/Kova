import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { pack } from "tar-stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointRows, normalizeText, prepareLogCorrelations } from "../src/verify/rows.mjs";
import { compareItems, noiseFloor } from "../src/verify/classify.mjs";
import { compareRecordedRun } from "../src/verify/compare.mjs";
import { canonicalJSON, sha256 } from "../src/verify/plan.mjs";

const advertised = (counter, extra = {}) => `bonjour: advertised gateway fqdn=${extra.name ?? "lab-host"}${counter ? ` (${counter})` : ""}._openclaw-gw._tcp.local. host=lab-host${counter ? `-(${counter})` : ""}.local. port=22341 state=${extra.state ?? "announcing"}`;

test("Bonjour collision counters normalize with an identity audit and retain product text", () => {
  const audits = [];
  const normalized = (text) => normalizeText(text, value => value, () => {}, (...item) => audits.push(item));
  assert.equal(normalized(advertised(8)), normalized(advertised(9)));
  assert.equal(normalized(advertised(8)), normalized(advertised(0)));
  assert.equal(normalized('bonjour: gateway name conflict resolved; newName="lab-host (8)"'), 'bonjour: gateway name conflict resolved; newName="lab-host"');
  assert.equal(normalized('bonjour: gateway hostname conflict resolved; newHostname="lab-host-(8)"'), 'bonjour: gateway hostname conflict resolved; newHostname="lab-host"');
  assert.ok(audits.length > 0);
  assert.ok(audits.every(([reason, before, after]) => reason === "Bonjour collision counter in run-environment identity" && before !== after));
  assert.notEqual(normalized(advertised(8)), normalized(advertised(9, { name: "wrong-host" })));
  assert.notEqual(normalized(advertised(8)), normalized(advertised(9, { state: "unannounced" })));
  for (const text of [
    'bonjour: advertise failed; newName="lab-host (8)"',
    'product message: bonjour: gateway name conflict resolved; newName="lab-host (8)"',
    'bonjour: gateway name conflict resolved; newName="lab-host (8)" unexpected'
  ]) assert.equal(normalized(text), text);
  assert.equal(normalized(advertised(8).replace("_openclaw-gw", "_different-service")), advertised(8).replace("_openclaw-gw", "_different-service").replace("22341", "<port>"));
});

test("recorded Bonjour lines preserve warning severity, count and source-address identity audits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-log-identities-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "commands.json"), "[]");
  const message = 'bonjour: gateway hostname conflict resolved; newHostname="lab-host-(8)"';
  const raw = JSON.stringify({ level: "warn", message });
  await writeFile(join(directory, "logs.txt"), `${raw}\n${raw}\n2026-10-15T16:51:50.603+02:00 [plugins] ${advertised(8)}\n`);
  const audit = [];
  const result = await checkpointRows(directory, { id: "standard/use-target", commands: [], checkpoint: ["logs"] }, {}, { text: value => value }, 0, [], item => audit.push(item));
  const logs = [...result.items.values()].filter(item => item.signal === "logs");
  assert.equal(logs.length, 1);
  const warning = logs.find(item => item.failure);
  assert.equal(warning.value, 2);
  assert.equal(JSON.parse(warning.at).message, 'bonjour: gateway hostname conflict resolved; newHostname="lab-host"');
  assert.equal(audit.filter(item => item.category === "logLevel").length, 1);
  const identities = audit.filter(item => item.category === "declaredIds");
  assert.equal(identities.length, 2);
  assert.ok(identities.every(item => item.signal === "logs" && item.at.includes("(8)")));
  assert.ok(identities.every(item => item.reason === "Bonjour collision counter in run-environment identity" && item.before !== item.after));
});

test("native Bonjour name negotiation is inventoried without hiding failures or foreign payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-log-identities-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "commands.json"), "[]");
  const message = 'bonjour: gateway hostname conflict resolved; newHostname="lab-host-(8)"';
  const native = [
    `2026-10-17T17:37:56.434+02:00 [plugins] ${message}`,
    JSON.stringify({ level: "warn", subsystem: "plugins", message }),
    JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: message, message, hostname: "lab-host", _meta: { logLevelName: "WARN" } })
  ];
  const retained = [
    JSON.stringify({ level: "error", subsystem: "plugins", message }),
    JSON.stringify({ level: "warn", subsystem: "application", message }),
    JSON.stringify({ level: "warn", subsystem: "plugins", message, payload: { error: "timeout" } }),
    JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: { error: "timeout" }, message, _meta: { logLevelName: "WARN" } }),
    JSON.stringify({ 0: '{"subsystem":"plugins","error":"timeout"}', 1: message, message, _meta: { logLevelName: "WARN" } }),
    JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: message, message, level: "warn", _meta: { logLevelName: "ERROR" } }),
    JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: message, message, subsystem: "application", _meta: { logLevelName: "WARN" } }),
    JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: message, message, hostname: { error: "timeout" }, _meta: { logLevelName: "WARN" } }),
    JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: message, message, _meta: { logLevelName: "WARN", logLevelId: 5 } }),
    JSON.stringify({ 0: '{"subsystem":"plugins"}', 1: message, message, _meta: { logLevelName: "WARN", payload: { error: "timeout" } } }),
    'WARN [plugins] bonjour: advertise failed; timeout',
    `ERROR [plugins] ${message}`,
    `WARN [plugins] ${message} unexpected`
  ];
  await writeFile(join(directory, "logs.txt"), [...native, ...retained].join("\n") + "\n");
  const audit = [];
  const result = await checkpointRows(directory, { id: "standard/use-target", commands: [], checkpoint: ["logs"] }, {}, { text: value => value }, 0, [], item => audit.push(item));
  assert.equal([...result.items.values()].filter(item => item.signal === "logs").length, retained.length);
  const excluded = audit.filter(item => item.reason === "native Bonjour shared-host name negotiation event");
  assert.equal(excluded.length, native.length);
  assert.deepEqual(excluded.map(item => item.before), native);
  assert.ok(excluded.every(item => item.category === "declaredIds" && item.after.absent));
});

test("nested cron storeKey strings reach path normalization without suppressing job payloads", () => {
  const root = "/tmp/envs/clone-a", normalizedRoot = "/tmp/envs/<env:0>";
  const store = JSON.stringify({ module: "cron", storeKey: `${root}/.openclaw/cron/jobs.json` });
  const raw = JSON.stringify({ 0: store, 1: { jobId: "generated-job-a", nextWakeAtMs: 1792075952897 }, _meta: { name: store }, message: "cron: started" });
  const visited = [];
  const result = JSON.parse(normalizeText(raw, value => { visited.push(value); return value.replaceAll(root, normalizedRoot); }));
  assert.equal(JSON.parse(result[0]).storeKey, `${normalizedRoot}/.openclaw/cron/jobs.json`);
  assert.equal(JSON.parse(result._meta.name).storeKey, `${normalizedRoot}/.openclaw/cron/jobs.json`);
  assert.ok(visited.includes(`${root}/.openclaw/cron/jobs.json`));
  assert.deepEqual(result[1], { jobId: "generated-job-a", nextWakeAtMs: 1792075952897 });
  assert.equal(result.message, "cron: started");
  const wrongPath = JSON.parse(normalizeText(raw.replaceAll("jobs.json", "wrong.json"), value => value.replaceAll(root, normalizedRoot)));
  assert.notEqual(result[0], wrongPath[0]);
});

function sqlitePhaseLog(style, phases, operation = "append") {
  const fields = { async: false, database: "store.sqlite", operation, elapsedMs: 1531, phases,
    isMainThread: false, mode: "immediate", pid: 123, threadId: 9, thresholdMs: 1000 };
  const message = "slow SQLite transaction hold";
  if (style === "json") return JSON.stringify({ level: "warn", subsystem: "sqlite/transaction", message, ...fields });
  if (style === "file") return JSON.stringify({ 0: '{"subsystem":"sqlite/transaction"}', 1: fields, 2: message, message, _meta: { logLevelName: "WARN" } });
  return `WARN [sqlite/transaction] ${message} ${Object.entries(fields).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ")}`;
}

test("native SQLite phase values retain malformed types and contents through the complete reader", async t => {
  const root = await mkdtemp(join(tmpdir(), "kova-sqlite-phase-values-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const phase = { id: "sessions/logs", commands: [], checkpoint: ["logs"] };
  let index = 0;
  const read = async line => {
    const directory = join(root, String(index++));
    await mkdir(directory); await writeFile(join(directory, "commands.json"), "[]"); await writeFile(join(directory, "logs.txt"), line);
    return (await checkpointRows(directory, phase, {}, { text: value => value })).items;
  };
  const cases = [
    [{ prepareMs: 3 }, { prepareMs: "3ms" }],
    [{ prepareMs: "3ms" }, { prepareMs: "4ms" }],
    [{ prepareMs: "2026-10-17T12:00:00Z" }, { prepareMs: "2026-10-17T13:00:00Z" }],
    [{ prepareMs: "<duration>" }, { prepareMs: "<<duration>>" }],
    [{ prepareMs: ["3ms"] }, { prepareMs: ["4ms"] }],
    [{ prepareMs: { durationMs: 3 } }, { prepareMs: { durationMs: 4 } }],
    [{ unknown: "3ms" }, { unknown: "4ms" }],
    [{ unknown: { elapsedMs: 3, port: 123 } }, { unknown: { elapsedMs: 4, port: 124 } }],
    [{ prepareMs: "$&" }, { prepareMs: "$` $' $$" }],
    ["3ms", "4ms"],
    [["3ms"], ["4ms"]]
  ];
  for (const style of ["console", "json", "file"]) for (const [before, after] of cases) {
    const baseline = await read(sqlitePhaseLog(style, before)), change = await read(sqlitePhaseLog(style, after));
    const result = compareItems({ phase: phase.id, baseline, changes: [change, change], noise: noiseFloor(baseline, baseline), expects: [] });
    assert.ok(result.rows.some(row => row.class === "break"), `${style}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

test("native SQLite phase shielding cannot collide with mapped literals or replacement syntax", () => {
  const first = "\uE000sqlite_phase_0\uE001", second = "\uE000sqlite_phase_1\uE001", temporary = "\uE000sqlite_phase_2\uE001";
  const phases = { prepareMs: 3, literal: second, nested: { elapsedMs: 9, text: "$& $` $' $$ 3ms" } };
  const projected = { ...phases, prepareMs: "<duration>" };
  for (const style of ["console", "json", "file"]) {
    const audit = [];
    const result = normalizeText(sqlitePhaseLog(style, phases, "mapped-operation"), value => value.replaceAll("mapped-operation", first),
      (before, after) => audit.push({ before, after }), () => {}, true);
    assert.ok(result.includes(first), "the mapped operation stays literal");
    assert.ok(result.includes(JSON.stringify(projected)), "phase types, dollar syntax and nested values survive restoration");
    assert.ok(!result.includes(temporary), "the private placeholder is restored before output");
    assert.ok(audit.some(item => item.before.includes(JSON.stringify(phases)) && item.after.includes(JSON.stringify(projected))));
    assert.ok(audit.every(item => !item.before.includes(temporary) && !item.after.includes(temporary)), "audit never receives the placeholder");
  }
});

test("native SQLite phase boundaries distinguish the trailing value from quoted field lookalikes", () => {
  const operation = 'append phases={"prepareMs":81}';
  const unknown = { text: 'literal phases={"prepareMs":"3ms"} with \\"quoted\\" delimiters' };
  for (const style of ["console", "json", "file"]) {
    const read = value => normalizeText(sqlitePhaseLog(style, { prepareMs: value, unknown }, operation), value => value, () => {}, () => {}, true);
    const normalized = read(3);
    assert.equal(normalized, read(4), "only the actual numeric phase is projected");
    assert.ok(normalized.includes(JSON.stringify({ prepareMs: "<duration>", unknown })), "nested field lookalikes stay literal");
    assert.notEqual(normalized, normalizeText(sqlitePhaseLog(style, { prepareMs: 3, unknown }, operation.replace("81", "82")), value => value, () => {}, () => {}, true));
  }
});

test("native SQLite phase ownership requires consistent source, message and severity envelopes", async t => {
  const root = await mkdtemp(join(tmpdir(), "kova-sqlite-phase-owners-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const phase = { id: "sessions/logs", commands: [], checkpoint: ["logs"] };
  let index = 0;
  const read = async line => {
    const directory = join(root, String(index++));
    await mkdir(directory); await writeFile(join(directory, "commands.json"), "[]"); await writeFile(join(directory, "logs.txt"), line);
    return (await checkpointRows(directory, phase, {}, { text: value => value })).items;
  };
  const binding = '{"subsystem":"sqlite/transaction"}', foreign = '{"subsystem":"application"}';
  const cases = [
    ["json", "conflicting subsystem", value => { value.subsystem = "application"; value[0] = binding; }],
    ["json", "conflicting binding", value => { value[0] = foreign; }],
    ["json", "conflicting name", value => { value._meta = { name: foreign, logLevelName: "WARN" }; }],
    ["json", "numeric metadata cannot redirect console ownership", value => { value[1] = { phases: value.phases }; value.phases = { prepareMs: 9 }; }],
    ["json", "mixed matching bindings remain ambiguous", value => { value[0] = binding; value[1] = { phases: value.phases }; value[2] = value.message; value.phases = { prepareMs: 9 }; }],
    ["json", "conflicting severity", value => { value._meta = { name: binding, logLevelName: "ERROR" }; }],
    ["json", "changed native severity", value => { value.level = "error"; }],
    ["file", "conflicting subsystem", value => { value.subsystem = "application"; }],
    ["file", "conflicting binding", value => { value[0] = foreign; value._meta.name = binding; }],
    ["file", "conflicting name", value => { value._meta.name = foreign; }],
    ["file", "malformed binding", value => { value[0] = "not JSON"; value._meta.name = binding; }],
    ["file", "malformed name", value => { value._meta.name = {}; }],
    ["file", "metadata subsystem disagrees", value => { value[1].subsystem = "application"; }],
    ["file", "numeric message disagrees", value => { value[2] = "application message"; }],
    ["file", "metadata message disagrees", value => { value[1].message = "application message"; }],
    ["file", "metadata severity disagrees", value => { value[1].level = "error"; }],
    ["file", "root severity disagrees", value => { value.level = "error"; }],
    ["file", "numeric severity disagrees", value => { value._meta.logLevelId = 5; }],
    ["file", "changed native severity", value => { value._meta.logLevelName = "ERROR"; }]
  ];
  for (const [style, label, alter] of cases) {
    const log = prepareMs => { const value = JSON.parse(sqlitePhaseLog(style, { prepareMs })); alter(value); return JSON.stringify(value); };
    const baseline = await read(log(3)), change = await read(log(4));
    const result = compareItems({ phase: phase.id, baseline, changes: [change, change], noise: noiseFloor(baseline, baseline), expects: [] });
    assert.ok(result.rows.some(row => row.class === "break"), `${style}: ${label}`);
  }
  for (const style of ["console", "json", "file"]) {
    const normalize = prepareMs => normalizeText(sqlitePhaseLog(style, { prepareMs }), value => value, () => {}, () => {}, true);
    assert.equal(normalize(3), normalize(4), `${style}: genuine numeric phases still normalize`);
  }
  const namedFile = prepareMs => {
    const value = JSON.parse(sqlitePhaseLog("file", { prepareMs }));
    value._meta.name = binding; value._meta.logLevelId = 4;
    return normalizeText(JSON.stringify(value), item => item, () => {}, () => {}, true);
  };
  assert.equal(namedFile(3), namedFile(4), "matching native file name and severity remain supported");
});

const diagnosticIds = hex => ({ root: hex.repeat(32), spans: [1, 2, 3, 4].map(index => hex.repeat(15) + index) });
function diagnosticLog(message, root, span, parent, extra = {}) {
  return JSON.stringify({ 0: '{"subsystem":"agent"}', 1: message, message, _meta: { logLevelName: "WARN" },
    traceId: root, spanId: span, ...(parent === undefined ? {} : { parentSpanId: parent }), ...extra });
}

async function diagnosticRecordings(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-log-correlation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let index = 0;
  return async (recordings, supplied = {}) => {
    const phases = Object.keys(recordings[0]).map(id => ({ id, commands: [], checkpoint: ["logs"] })), copies = [];
    for (const recording of recordings) {
      const directory = join(root, String(index++)), phaseItems = new Map(), audit = [], findingIds = new Set();
      const normalization = { text: value => value, ...supplied, findingId: value => findingIds.add(value) };
      for (const phase of phases) {
        const checkpoint = join(directory, "checkpoints", phase.id);
        await mkdir(checkpoint, { recursive: true });
        await writeFile(join(checkpoint, "commands.json"), "[]");
        await writeFile(join(checkpoint, "logs.txt"), recording[phase.id].join("\n") + "\n");
      }
      copies.push({ directory, normalization, phaseItems, audit, findingIds, reference: copies.length === 0 });
    }
    const projections = await prepareLogCorrelations(copies, phases);
    for (const [index, copy] of copies.entries()) {
      copy.normalization.correlations = copy.correlations = projections[index];
      for (const phase of phases) {
        const result = await checkpointRows(join(copy.directory, "checkpoints", phase.id), phase, {}, copy.normalization, 0, [], item => copy.audit.push({ phase: phase.id, ...item }));
        copy.phaseItems.set(phase.id, result.items);
      }
    }
    return copies;
  };
}

function diagnosticDifferences(before, after) {
  return [...before.phaseItems].flatMap(([phase, baseline]) => compareItems({ phase, baseline,
    changes: [after.phaseItems.get(phase), after.phaseItems.get(phase)], noise: noiseFloor(baseline, baseline), expects: [] }).rows);
}
const diagnosticLogs = result => [...result.phaseItems].flatMap(([phase, items]) => [...items.values()]
  .filter(item => item.signal === "logs").map(item => [phase, item.at, item.value])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test("prepared diagnostic identities are invariant to reordered log multisets and generated spellings", async t => {
  const read = await diagnosticRecordings(t);
  const recording = (hex, independent = false) => {
    const { root, spans } = diagnosticIds(hex);
    return [diagnosticLog("root warning", root, spans[0]),
      diagnosticLog("first child warning", root, spans[1], spans[0]),
      diagnosticLog("second child warning", independent ? "c".repeat(32) : root, spans[2], spans[0]),
      diagnosticLog("first child warning", root, spans[1], spans[0])];
  };
  for (const independent of [false, true]) {
    for (const hex of ["a", "b"]) {
      const [original, reordered] = await read([{ "sessions/read": recording("a", independent) }, { "sessions/read": recording(hex, independent).reverse() }]);
      assert.deepEqual(diagnosticLogs(original), diagnosticLogs(reordered));
      assert.equal(diagnosticDifferences(original, reordered).some(row => ["break", "flaky", "fixed"].includes(row.class)), false);
      assert.ok(original.findingIds.size > 0);
      assert.ok(original.audit.filter(item => item.reason.startsWith("native diagnostic correlation ")).every(item => original.findingIds.has(item.after)));
      assert.equal(diagnosticLogs(original).find(([, line]) => JSON.parse(line).message === "first child warning")[2], 2, "duplicate occurrences remain counted");
    }
  }
});

test("prepared correlation anchors preserve parent links, scope equality and cross-phase changes", async t => {
  const read = await diagnosticRecordings(t);
  const recording = (hex, mode = "same") => {
    const { root, spans: [first, second, third, fourth] } = diagnosticIds(hex);
    return { "sessions/start": [diagnosticLog("root warning", root, first),
      diagnosticLog("first child warning", root, second, mode === "self" ? second : first),
      diagnosticLog("second child warning", mode === "different-root" ? "c".repeat(32) : root, mode === "collapsed" ? second : third, mode === "reparented" ? second : first)].reverse(),
    "sessions/follow": [diagnosticLog("later child warning", root, fourth, mode === "cross-phase" ? second : first)] };
  };
  const [baseline, equivalent] = await read([recording("a"), recording("b")]);
  assert.deepEqual(diagnosticLogs(baseline), diagnosticLogs(equivalent));
  for (const mode of ["collapsed", "reparented", "self", "different-root", "cross-phase"]) {
    const [before, after] = await read([recording("a"), recording("b", mode)]);
    assert.ok(diagnosticDifferences(before, after).some(row => row.class === "break"), mode);
  }
});

test("ambiguous diagnostic identities stay literal and ignored logs cannot provide anchors", async t => {
  const read = await diagnosticRecordings(t);
  const recording = (hex, extraInfo = false) => {
    const { root, spans } = diagnosticIds(hex);
    return [diagnosticLog("same warning", root, spans[1], spans[0]), diagnosticLog("same warning", root, spans[2], spans[0]),
      ...(extraInfo ? [diagnosticLog("otherwise unique informational message", root, spans[1], spans[0], { _meta: { logLevelName: "INFO" } })] : [])];
  };
  const [original, reordered] = await read([{ "sessions/read": recording("a", true) }, { "sessions/read": recording("a", true).reverse() }]);
  assert.deepEqual(diagnosticLogs(original), diagnosticLogs(reordered));
  const [before, after] = await read([{ "sessions/read": recording("a", true) }, { "sessions/read": recording("b", true) }]);
  assert.ok(diagnosticDifferences(before, after).some(row => row.class === "break"), "ambiguous span spellings remain evidence");
  assert.equal(before.audit.filter(item => item.category === "logLevel").length, 1);
  assert.ok(diagnosticLogs(before).every(([, line]) => diagnosticIds("a").spans.includes(JSON.parse(line).spanId)));
  const twoRoots = [diagnosticLog("same warning", "a".repeat(32), "1".repeat(16)), diagnosticLog("same warning", "b".repeat(32), "2".repeat(16))];
  const [roots, reversedRoots] = await read([{ "sessions/read": twoRoots }, { "sessions/read": twoRoots.toReversed() }]);
  assert.deepEqual(diagnosticLogs(roots), diagnosticLogs(reversedRoots), "ambiguous root groups are also order independent");
  assert.equal(JSON.parse(diagnosticLogs(roots)[0][1]).traceId.length, 32, "indistinguishable components never receive a colliding token");
});

test("parent-only anchors retain shared-parent partitions and later observed parent ownership", async t => {
  const read = await diagnosticRecordings(t);
  const recording = (hex, mode = "distinct", observeParents = false) => {
    const { root, spans: [first, second, parentA, parentB] } = diagnosticIds(hex);
    return { "sessions/start": [diagnosticLog("first child warning", root, first, mode === "swapped" ? parentB : parentA),
      diagnosticLog("second child warning", root, second, ["shared", "swapped"].includes(mode) ? parentA : parentB)],
    "sessions/follow": observeParents ? [diagnosticLog("first parent warning", root, parentA), diagnosticLog("second parent warning", root, parentB)] : [] };
  };
  const [distinct, equivalent] = await read([recording("a"), recording("b")]);
  assert.deepEqual(diagnosticLogs(distinct), diagnosticLogs(equivalent));
  for (const [from, to] of [["distinct", "shared"], ["shared", "distinct"]]) {
    const [before, after] = await read([recording("a", from), recording("b", to)]);
    assert.ok(diagnosticDifferences(before, after).some(row => row.class === "break"), "parent partitions cannot collapse or split");
  }
  const [anonymous, renamed] = await read([recording("a"), recording("b", "swapped")]);
  assert.deepEqual(diagnosticLogs(anonymous), diagnosticLogs(renamed), "unobserved renamed parents have only their referenced messages as semantic anchors");
  for (const hex of ["a", "b"]) {
    const [before, after] = await read([recording("a", "distinct", true), recording(hex, "swapped", true)]);
    assert.ok(diagnosticDifferences(before, after).some(row => row.class === "break"), "later own observations govern cross-phase links");
  }
});

test("prepared native root tokens do not rewrite authored payloads or permit literal spoofing", async t => {
  const read = await diagnosticRecordings(t), ids = diagnosticIds("a");
  const text = value => value.replaceAll("1", "declared-one");
  const recording = { "sessions/read": [diagnosticLog("same warning", ids.root, ids.spans[0], ids.spans[0])] };
  const [baseline] = await read([recording, recording], { text });
  const line = JSON.parse(diagnosticLogs(baseline)[0][1]);
  assert.equal(line.traceId, baseline.correlations(ids.root));
  assert.equal(line.spanId, baseline.correlations(ids.root, ids.spans[0]), "generated marker is not sent through the generic mapper");
  const literal = diagnosticLog("same warning", line.traceId, line.spanId, line.parentSpanId);
  const [original, , spoofed] = await read([recording, recording, { "sessions/read": [literal] }], { text });
  assert.ok(diagnosticDifferences(original, spoofed).some(row => row.class === "break"));
  const payload = hex => diagnosticLog("same warning", hex.repeat(32), hex.repeat(16), undefined, { payload: { traceId: hex.repeat(32) } });
  const [authored, changed] = await read([{ "sessions/read": [payload("a")] }, { "sessions/read": [payload("b")] }]);
  assert.equal(JSON.parse(diagnosticLogs(authored)[0][1]).payload.traceId, "a".repeat(32));
  assert.ok(diagnosticDifferences(authored, changed).some(row => row.class === "break"));
});

async function recordedDiagnosticComparison(t, recording, createdIds = []) {
  const directory = await mkdtemp(join(tmpdir(), "kova-recorded-log-correlation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
  const command = "node {kovaRoot}/support/compare-probe.mjs";
  const phases = Object.keys(recording("baseline")).map(id => ({ id, from: "template:sessions", commands: [command], checkpoint: ["logs"] }));
  const plan = { schema: "kova.verify.plan.v1", change: { repo: "openclaw/openclaw", baseline: "a".repeat(40), change: "b".repeat(40) },
    persona: { id: "sample", version: "1" }, intent: { goal: "Compare retained warnings.", protected: "Warning content and relationships.", expects: [] },
    phases, phasesSha256: sha256(canonicalJSON(phases)), withheld: [], unmapped: [], ignored: [] };
  const json = (path, value) => writeFile(path, JSON.stringify(value));
  await json(join(directory, "plan.json"), plan);
  await json(join(directory, "standard.json"), { schema: "kova.verify.standard.v1", stateIds: [], compressed: [] });
  await json(join(directory, "catalogue.json"), { schema: "kova.verify.catalogue.v1", product: "openclaw", revision: "1", entries: [{
    id: "compare-probe", kind: "script", wraps: "inspect a saved response", command, flags: {}, prints: ["result"], creates: createdIds.map(item => item.pointer), side: "read", background: false, status: "existing"
  }] });
  for (const name of names) {
    await mkdir(join(directory, name, "initial-state"), { recursive: true });
    const observations = recording(name);
    for (const phase of phases) {
      const path = join(directory, name, "checkpoints", phase.id);
      await mkdir(path, { recursive: true });
      await json(join(path, "commands.json"), [{ command, exit: 0, stdout: null, stderr: "", durationMs: 1, timedOut: false, createdIds }]);
      await writeFile(join(path, "logs.txt"), observations[phase.id].join("\n") + "\n");
    }
  }
  await mkdir(join(directory, ".persona"));
  const archivePath = join(directory, ".persona", "sample.ocm-env.tar"), archive = pack();
  const pending = pipeline(archive, createWriteStream(archivePath));
  const entry = (header, bytes) => new Promise((resolve, reject) => archive.entry(header, bytes, error => error ? reject(error) : resolve()));
  await entry({ name: "meta/env.json" }, JSON.stringify({ kind: "ocm-env-archive", formatVersion: 1, includeState: true, exportedAt: "2026-10-14T00:00:00Z", env: { name: "fixture" } }));
  await entry({ name: "root", type: "directory" });
  archive.finalize(); await pending;
  await json(join(directory, "run.json"), { schema: "kova.verify.run.v1", id: "sample", plan: { sha256: sha256(await readFile(join(directory, "plan.json"))) },
    targets: { baseline: { commit: plan.change.baseline }, change: { commit: plan.change.change } },
    clones: Object.fromEntries(names.map(name => [name, { started: true, phases: Object.fromEntries(phases.map(phase => [phase.id, "recorded"])) }])),
    personaExports: [{ path: ".persona/sample.ocm-env.tar", sha256: sha256(await readFile(archivePath)) }] });
  return compareRecordedRun(directory);
}

test("prepared diagnostic recorded comparison preserves surviving warnings after any anchor removal", async t => {
  for (const generated of [false, true]) for (const mode of ["reordered", "remove-child", "remove-root", "remove-shared-span-message", "remove-group", "remove-occurrence"]) {
    const result = await recordedDiagnosticComparison(t, name => {
      const change = name.startsWith("change"), hex = generated ? ({ baseline: "a", "change-1": "b", "change-2": "c", "noise-1": "d", "noise-2": "e" })[name] : "a";
      const { root, spans: [parent, child] } = diagnosticIds(hex);
      let lines = [diagnosticLog("root warning", root, parent), diagnosticLog("child warning", root, child, parent)];
      if (mode === "remove-shared-span-message") lines.push(diagnosticLog("another root warning", root, parent));
      if (mode === "remove-occurrence") lines.push(lines[1]);
      if (change) {
        if (mode === "remove-child") lines.splice(1, 1);
        if (["remove-root", "remove-shared-span-message"].includes(mode)) lines.shift();
        if (mode === "remove-group") lines = [];
        if (mode === "remove-occurrence") lines.pop();
      }
      if (change || name === "noise-2") lines.reverse();
      return { "sessions/read": lines };
    });
    assert.equal(result.verdict, "good-to-go", `${mode}, generated=${generated}`);
    assert.equal(result.noiseExcluded, 0, "joint correspondence must not invent a varying noise floor");
    assert.equal(result.rows.some(row => ["break", "flaky"].includes(row.class)), false);
    const rows = result.rows.filter(row => row.signal === "logs");
    const removed = mode === "remove-group" ? ["root warning", "child warning"]
      : mode === "remove-child" ? ["child warning"] : ["remove-root", "remove-shared-span-message"].includes(mode) ? ["root warning"] : [];
    assert.deepEqual(rows.filter(row => row.class === "fixed").map(row => JSON.parse(row.at).message).sort(), removed.sort());
    assert.ok(rows.filter(row => !removed.includes(JSON.parse(row.at).message)).every(row => row.class === "not-caused"));
    if (mode === "remove-occurrence") {
      const child = rows.find(row => JSON.parse(row.at).message === "child warning");
      assert.equal(child.baseline, 2); assert.equal(child.change, 1);
    }
  }
});

test("prepared diagnostic recorded comparison retains added warnings, changed content and relations", async t => {
  for (const mode of ["add-child", "add-group", "change-message", "collapse", "self-parent", "cross-phase-parent", "split-root"]) {
    const result = await recordedDiagnosticComparison(t, name => {
      const change = name.startsWith("change"), hex = ({ baseline: "a", "change-1": "b", "change-2": "c", "noise-1": "d", "noise-2": "e" })[name];
      const { root, spans: [parent, first, second, later] } = diagnosticIds(hex);
      const lines = [diagnosticLog("root warning", root, parent),
        diagnosticLog(change && mode === "change-message" ? "changed child warning" : "first child warning", root, first, change && mode === "self-parent" ? first : parent),
        diagnosticLog("second child warning", change && mode === "split-root" ? hex.repeat(31) + "f" : root, change && mode === "collapse" ? first : second, parent)];
      if (change && mode.startsWith("add-")) lines.push(diagnosticLog("new warning", mode === "add-group" ? hex.repeat(31) + "f" : root, later, mode === "add-group" ? undefined : parent));
      return { "sessions/read": lines.toReversed(), "sessions/follow": [diagnosticLog("later warning", root, later, change && mode === "cross-phase-parent" ? first : parent)] };
    });
    assert.equal(result.verdict, "breaks", mode);
    assert.ok(result.rows.some(row => row.signal === "logs" && row.class === "break"), mode);
    assert.equal(result.noiseExcluded, 0, "ambiguous relationships must not become noise");
    if (["add-child", "add-group", "change-message"].includes(mode)) {
      assert.equal(result.rows.find(row => row.signal === "logs" && JSON.parse(row.at).message === "root warning").class, "not-caused");
    }
  }
});

test("prepared diagnostic changed relations cannot poison frozen noise correspondence", async t => {
  for (const mode of ["collapse", "split-root", "reparent"]) {
    const result = await recordedDiagnosticComparison(t, name => {
      const change = name.startsWith("change");
      // A raw baseline identity also appears in noise-1. If changed ambiguity
      // invalidates reference projection, the noise floor can hide that row.
      const hex = ({ baseline: "a", "noise-1": "a", "noise-2": "d", "change-1": "b", "change-2": "c" })[name];
      const { root, spans: [parent, first, second] } = diagnosticIds(hex);
      return { "sessions/read": [diagnosticLog("root warning", root, parent),
        diagnosticLog("first child warning", root, first, parent),
        diagnosticLog("second child warning", change && mode === "split-root" ? hex.repeat(31) + "f" : root,
          change && mode === "collapse" ? first : second, change && mode === "reparent" ? first : parent)] };
    });
    assert.equal(result.verdict, "breaks", mode);
    assert.equal(result.noiseExcluded, 0, mode);
    assert.ok(result.rows.some(row => row.signal === "logs" && row.class === "break" && row.clones.length === 2), "the changed relation repeats across both copies");
    assert.equal(result.rows.some(row => row.class === "flaky"), false, mode);
  }
});

test("prepared diagnostic correspondence admits transitive partial overlap and singleton references", async t => {
  const ids = [{ pointer: "/operationId", value: "recorded-operation" }];
  const result = await recordedDiagnosticComparison(t, name => {
    const hex = ({ baseline: "a", "noise-1": "d", "noise-2": "e", "change-1": "b", "change-2": "c" })[name];
    const { root, spans: [parent, child] } = diagnosticIds(hex);
    const a = diagnosticLog("A message", root, parent, undefined, { _meta: { logLevelName: "INFO" }, operationId: "recorded-operation" });
    const b = diagnosticLog("B warning", root, child, parent);
    return { "sessions/read": name === "change-1" ? [a, b] : name === "change-2" ? [b] : [a] };
  }, ids);
  const logs = result.rows.filter(row => row.signal === "logs");
  assert.equal(result.verdict, "breaks");
  assert.equal(result.noiseExcluded, 0);
  assert.deepEqual(logs.find(row => JSON.parse(row.at).message === "B warning").clones, ["change-1", "change-2"]);
  assert.equal(logs.find(row => JSON.parse(row.at).message === "B warning").class, "break");
  assert.equal(logs.find(row => JSON.parse(row.at).message === "A message").class, "flaky");

  const singleton = await recordedDiagnosticComparison(t, name => {
    const { root, spans } = diagnosticIds(name === "baseline" ? "a" : name === "change-1" ? "b" : "c");
    return { "sessions/read": name.startsWith("noise") ? [] : [diagnosticLog("shared warning", root, spans[0])] };
  });
  assert.equal(singleton.verdict, "good-to-go");
  assert.deepEqual(singleton.rows.filter(row => row.signal === "logs").map(row => row.class), ["not-caused"]);
});

test("standalone diagnostic checkpoints keep same raw identities stable under warning removal", async t => {
  const root = await mkdtemp(join(tmpdir(), "kova-single-log-correlation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = diagnosticIds("a"), phase = { id: "sessions/read", commands: [], checkpoint: ["logs"] };
  const lines = [diagnosticLog("root warning", ids.root, ids.spans[0]), diagnosticLog("child warning", ids.root, ids.spans[1], ids.spans[0])];
  const items = [];
  for (const [index, selected] of [lines, lines.slice(0, 1), lines.slice(1)].entries()) {
    const directory = join(root, String(index));
    await mkdir(directory); await writeFile(join(directory, "commands.json"), "[]"); await writeFile(join(directory, "logs.txt"), selected.join("\n"));
    items.push((await checkpointRows(directory, phase, {}, { text: value => value })).items);
  }
  for (const change of items.slice(1)) {
    const result = compareItems({ phase: phase.id, baseline: items[0], changes: [change, change], noise: noiseFloor(items[0], items[0]), expects: [] });
    assert.deepEqual(result.rows.map(row => row.class).sort(), ["fixed", "not-caused"]);
  }
});
