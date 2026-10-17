import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointRows, normalizeText, prepareLogCorrelations } from "../src/verify/rows.mjs";
import { compareItems, noiseFloor } from "../src/verify/classify.mjs";

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

const diagnosticIds = hex => ({ root: hex.repeat(32), spans: [1, 2, 3, 4].map(index => hex.repeat(15) + index) });
function diagnosticLog(message, root, span, parent, extra = {}) {
  return JSON.stringify({ 0: '{"subsystem":"agent"}', 1: message, message, _meta: { logLevelName: "WARN" },
    traceId: root, spanId: span, ...(parent === undefined ? {} : { parentSpanId: parent }), ...extra });
}

async function diagnosticRecordings(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-log-correlation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let index = 0;
  return async (recording, supplied = {}) => {
    const directory = join(root, String(index++)), phaseItems = new Map(), audit = [], findingIds = new Set();
    const phases = Object.entries(recording).map(([id, lines]) => ({ id, lines, commands: [], checkpoint: ["logs"] }));
    for (const phase of phases) {
      const checkpoint = join(directory, "checkpoints", phase.id);
      await mkdir(checkpoint, { recursive: true });
      await writeFile(join(checkpoint, "commands.json"), "[]");
      await writeFile(join(checkpoint, "logs.txt"), phase.lines.join("\n") + "\n");
    }
    const normalization = { text: value => value, ...supplied, findingId: value => findingIds.add(value) };
    normalization.correlations = await prepareLogCorrelations(directory, phases, normalization);
    for (const phase of phases) {
      const result = await checkpointRows(join(directory, "checkpoints", phase.id), phase, {}, normalization, 0, [], item => audit.push({ phase: phase.id, ...item }));
      phaseItems.set(phase.id, result.items);
    }
    return { phaseItems, audit, findingIds, correlations: normalization.correlations };
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
    const original = await read({ "sessions/read": recording("a", independent) });
    for (const hex of ["a", "b"]) {
      const reordered = await read({ "sessions/read": recording(hex, independent).reverse() });
      assert.deepEqual(diagnosticLogs(original), diagnosticLogs(reordered));
      assert.equal(diagnosticDifferences(original, reordered).some(row => ["break", "flaky", "fixed"].includes(row.class)), false);
    }
    assert.ok(original.findingIds.size > 0);
    assert.ok(original.audit.filter(item => item.reason.startsWith("native diagnostic correlation ")).every(item => original.findingIds.has(item.after)));
    assert.equal(diagnosticLogs(original).find(([, line]) => JSON.parse(line).message === "first child warning")[2], 2, "duplicate occurrences remain counted");
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
  const baseline = await read(recording("a"));
  assert.deepEqual(diagnosticLogs(baseline), diagnosticLogs(await read(recording("b"))));
  for (const mode of ["collapsed", "reparented", "self", "different-root", "cross-phase"]) {
    assert.ok(diagnosticDifferences(baseline, await read(recording("b", mode))).some(row => row.class === "break"), mode);
  }
});

test("ambiguous diagnostic identities stay literal and ignored logs cannot provide anchors", async t => {
  const read = await diagnosticRecordings(t);
  const recording = (hex, extraInfo = false) => {
    const { root, spans } = diagnosticIds(hex);
    return [diagnosticLog("same warning", root, spans[1], spans[0]), diagnosticLog("same warning", root, spans[2], spans[0]),
      ...(extraInfo ? [diagnosticLog("otherwise unique informational message", root, spans[1], spans[0], { _meta: { logLevelName: "INFO" } })] : [])];
  };
  const before = await read({ "sessions/read": recording("a", true) });
  assert.deepEqual(diagnosticLogs(before), diagnosticLogs(await read({ "sessions/read": recording("a", true).reverse() })));
  assert.ok(diagnosticDifferences(before, await read({ "sessions/read": recording("b", true) })).some(row => row.class === "break"), "ambiguous span spellings remain evidence");
  assert.equal(before.audit.filter(item => item.category === "logLevel").length, 1);
  assert.ok(diagnosticLogs(before).every(([, line]) => diagnosticIds("a").spans.includes(JSON.parse(line).spanId)));
  const twoRoots = [diagnosticLog("same warning", "a".repeat(32), "1".repeat(16)), diagnosticLog("same warning", "b".repeat(32), "2".repeat(16))];
  assert.deepEqual(diagnosticLogs(await read({ "sessions/read": twoRoots })), diagnosticLogs(await read({ "sessions/read": twoRoots.toReversed() })), "ambiguous root groups are also order independent");
});

test("parent-only anchors retain shared-parent partitions and later observed parent ownership", async t => {
  const read = await diagnosticRecordings(t);
  const recording = (hex, mode = "distinct", observeParents = false) => {
    const { root, spans: [first, second, parentA, parentB] } = diagnosticIds(hex);
    return { "sessions/start": [diagnosticLog("first child warning", root, first, mode === "swapped" ? parentB : parentA),
      diagnosticLog("second child warning", root, second, ["shared", "swapped"].includes(mode) ? parentA : parentB)],
    "sessions/follow": observeParents ? [diagnosticLog("first parent warning", root, parentA), diagnosticLog("second parent warning", root, parentB)] : [] };
  };
  const distinct = await read(recording("a")), shared = await read(recording("a", "shared"));
  assert.deepEqual(diagnosticLogs(distinct), diagnosticLogs(await read(recording("b"))));
  assert.ok(diagnosticDifferences(distinct, await read(recording("b", "shared"))).some(row => row.class === "break"), "distinct parents cannot collapse");
  assert.ok(diagnosticDifferences(shared, await read(recording("b"))).some(row => row.class === "break"), "shared parent cannot split");
  assert.deepEqual(diagnosticLogs(distinct), diagnosticLogs(await read(recording("a", "swapped"))), "unobserved anonymous parents have only their referenced messages as semantic anchors");
  assert.ok(diagnosticDifferences(await read(recording("a", "distinct", true)), await read(recording("b", "swapped", true))).some(row => row.class === "break"), "later own observations govern cross-phase links");
});

test("prepared native root tokens do not rewrite authored payloads or permit literal spoofing", async t => {
  const read = await diagnosticRecordings(t), ids = diagnosticIds("a");
  const text = value => value.replaceAll("1", "declared-one");
  const baseline = await read({ "sessions/read": [diagnosticLog("same warning", ids.root, ids.spans[0], ids.spans[0])] }, { text });
  const line = JSON.parse(diagnosticLogs(baseline)[0][1]);
  assert.equal(line.traceId, baseline.correlations(ids.root));
  assert.equal(line.spanId, baseline.correlations(ids.root, ids.spans[0]), "generated marker is not sent through the generic mapper");
  const literal = diagnosticLog("same warning", line.traceId, line.spanId, line.parentSpanId);
  assert.ok(diagnosticDifferences(baseline, await read({ "sessions/read": [literal] }, { text })).some(row => row.class === "break"));
  const payload = hex => diagnosticLog("same warning", hex.repeat(32), hex.repeat(16), undefined, { payload: { traceId: hex.repeat(32) } });
  const original = await read({ "sessions/read": [payload("a")] }), changed = await read({ "sessions/read": [payload("b")] });
  assert.equal(JSON.parse(diagnosticLogs(original)[0][1]).payload.traceId, "a".repeat(32));
  assert.ok(diagnosticDifferences(original, changed).some(row => row.class === "break"));
});
