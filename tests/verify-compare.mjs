import "./verify-streaming.mjs";
import "./verify-recorded-commands.mjs";
import "./verify-log-identities.mjs";
import "./verify-build-ids.mjs";
import "./verify-findings.mjs";
import "./verify-runtime-events.mjs";
import "./verify-runtime-identities.mjs";
import "./verify-state-observations.mjs";
import "./verify-verdict-output.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { pack } from "tar-stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { compareRecordedRun, compareVerification } from "../src/verify/compare.mjs";
import { canonicalJSON, sha256 } from "../src/verify/plan.mjs";
import { normalizeText } from "../src/verify/rows.mjs";
import { normalizeDeclaredIds } from "../src/verify/normalize.mjs";
import { createdIds, personaExistingIds } from "../src/verify/ids.mjs";
import { snapshotState, writeCheckpoint } from "../src/verify/checkpoint.mjs";

const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
const phaseId = "sessions/read";
const command = "node {kovaRoot}/support/compare-probe.mjs";
const entry = { id: "compare-probe", kind: "script", wraps: "inspect a saved response", command, flags: {}, prints: ["result"], creates: [], side: "read", background: false, status: "existing" };
const writeJSON = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

async function exportFixture(directory, files = {}) {
  const target = join(directory, ".persona", "persona.ocm-env.tar");
  await mkdir(join(directory, ".persona"), { recursive: true });
  const archive = pack();
  const pending = pipeline(archive, createWriteStream(target));
  const entry = (header, bytes) => new Promise((resolve, reject) => archive.entry(header, bytes, (error) => error ? reject(error) : resolve()));
  await entry({ name: "meta/env.json" }, JSON.stringify({ kind: "ocm-env-archive", formatVersion: 1, includeState: true, exportedAt: "2026-10-14T00:00:00Z", env: { name: "fixture" } }));
  await entry({ name: "root", type: "directory" });
  for (const [path, bytes] of Object.entries(files)) await entry({ name: `root/.openclaw/${path}` }, bytes);
  archive.finalize(); await pending;
  return [{ path: ".persona/persona.ocm-env.tar", sha256: sha256(await readFile(target)) }];
}

async function exportedFiles(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await exportedFiles(directory, path));
    else files[path] = await readFile(join(directory, path));
  }
  return files;
}

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), "kova-compare-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "artifacts", "verify", "sample");
  await mkdir(directory, { recursive: true });
  const phases = options.phases ?? [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "timing", "logs", ...(options.state ? ["state:files"] : [])] }];
  const plan = { schema: "kova.verify.plan.v1", change: { repo: "openclaw/openclaw", baseline: "a".repeat(40), change: "b".repeat(40), paths: ["src/example.ts"] }, persona: { id: "sample", version: "1" }, intent: { goal: "Return the new title.", protected: "Existing records.", expects: structuredClone(options.expects ?? []) }, phases, phasesSha256: sha256(canonicalJSON(phases)), withheld: [], unmapped: [], ignored: [] };
  await writeJSON(join(directory, "plan.json"), plan);
  const run = { schema: "kova.verify.run.v1", id: "sample", plan: { sha256: sha256(await readFile(join(directory, "plan.json"))) }, targets: { baseline: { commit: plan.change.baseline }, change: { commit: plan.change.change } }, clones: Object.fromEntries(names.map((name) => [name, { started: true, phases: Object.fromEntries(phases.map((phase) => [phase.id, "recorded"])) }])) };
  const standard = { schema: "kova.verify.standard.v1", stateIds: options.stateIds ?? [], compressed: options.compressed ?? [] };
  await writeJSON(join(directory, "standard.json"), standard);
  await writeJSON(join(directory, "catalogue.json"), { schema: "kova.verify.catalogue.v1", product: "openclaw", revision: "1", entries: [{ ...entry, creates: options.creates ?? [] }] });
  for (const [index, name] of names.entries()) {
    await mkdir(join(directory, name, "initial-state"), { recursive: true });
    await mkdir(join(directory, name, "initial-state", "files"));
    await options.initial?.(join(directory, name, "initial-state", "files"), name, index);
    for (const phase of phases) {
      if (options.missing?.includes(name)) { run.clones[name].phases[phase.id] = "no checkpoint"; continue; }
      const path = join(directory, name, "checkpoints", phase.id);
      await mkdir(path, { recursive: true });
      const data = options.copies?.[name] ?? {};
      await writeJSON(join(path, "commands.json"), [{ command: phase.commands[0], exit: data.exit ?? 0, stdout: data.stdout ?? null, stderr: "", durationMs: 100 + index, timedOut: data.bound ?? false, createdIds: createdIds(data.response ?? { title: "old" }, options.creates ?? []) }]);
      await writeJSON(join(path, "responses.json"), { 0: data.response ?? { title: "old" } });
      await writeJSON(join(path, "timing.json"), [{ durationMs: 1000 * (index + 1), reachedBound: data.bound ?? false }]);
      await writeFile(join(path, "logs.txt"), data.logs ?? "");
      if (options.state) { await mkdir(join(path, "state", "files"), { recursive: true }); await options.state(join(path, "state", "files"), name, index, phase); }
      if (phase.checkpoint.includes("screen")) await writeFile(join(path, "screen.png"), data.screen ?? "image");
    }
  }
  run.personaExports = await exportFixture(directory, { ...await exportedFiles(join(directory, "baseline", "initial-state")), ...options.originalFiles });
  await writeJSON(join(directory, "run.json"), run);
  return { home, directory, plan, run, async compare() { return compareRecordedRun(directory); }, async savePlan() { await writeJSON(join(directory, "plan.json"), plan); run.plan.sha256 = sha256(await readFile(join(directory, "plan.json"))); await writeJSON(join(directory, "run.json"), run); } };
}

const both = (data) => ({ "change-1": data, "change-2": data });
const expectTitle = { phase: phaseId, signal: "responses", at: "0/title", change: "new" };

test("compares recorded values, preserves null, and ignores absolute durations", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.compare()).verdict, "good-to-go");
  await writeJSON(join(f.directory, "change-1/checkpoints", phaseId, "responses.json"), { 0: { title: null } });
  await writeJSON(join(f.directory, "change-2/checkpoints", phaseId, "responses.json"), { 0: { title: null } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows, [{ phase: phaseId, signal: "responses", at: "0/title", clones: ["change-1", "change-2"], baseline: "old", change: null, class: "break", explainedBy: null }]);
});

test("both differing change values are breaks even when they disagree", async (t) => {
  const f = await fixture(t, { copies: { "change-1": { response: { title: "one" } }, "change-2": { response: { title: "two" } } } });
  const result = await f.compare();
  assert.deepEqual(result.rows.map((row) => [row.class, row.clones, row.change]), [["break", ["change-1"], "one"], ["break", ["change-2"], "two"]]);
});

test("shared failures win before expectations, including different warning counts", async (t) => {
  const data = { exit: 1, bound: true, logs: "WARN shared\n", findings: [{ code: "broken", message: "Broken config" }] };
  const f = await fixture(t, { copies: Object.fromEntries(names.map((name) => [name, { ...data, ...(name === "change-1" ? { logs: "WARN shared\nWARN shared\n" } : {}) }])), expects: [{ phase: phaseId, signal: "commands", at: "0/exit", change: 1 }] });
  const result = await f.compare();
  assert.equal(result.verdict, "good-to-go");
  assert.equal(result.rows.length, 4);
  assert.ok(result.rows.every((row) => row.class === "not-caused"));
  assert.equal(result.issues.length, 4);
  await compareVerification({ run: "sample" }, { home: join(f.home, "artifacts") });
  assert.match(await readFile(join(f.directory, "issues.md"), "utf8"), /baseline 1; change-1 2/);
});

test("baseline-only failures are fixed before intended or flaky", async (t) => {
  const f = await fixture(t, { copies: { baseline: { exit: 1, bound: true, logs: "ERROR old\n", findings: [{ code: "old" }] } }, expects: [{ phase: phaseId, signal: "commands", at: "0/exit", change: 0 }] });
  const result = await f.compare();
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every((row) => row.class === "fixed"));
  assert.equal(result.verdict, "good-to-go");
});

test("expectations match exact item and value, before repeatability", async (t) => {
  const f = await fixture(t, { copies: { "change-1": { response: { title: "new" } } }, expects: [expectTitle] });
  const result = await f.compare();
  assert.equal(result.verdict, "good-to-go");
  assert.equal(result.rows[0].class, "intended");
  assert.equal(result.rows[0].explainedBy, "intent:goal");
  f.plan.intent.expects[0].change = "wrong";
  await f.savePlan();
  assert.equal((await f.compare()).rows[0].class, "flaky");
});

test("a difference on only the second copy is flaky; a timeout on both is a break", async (t) => {
  const f = await fixture(t, { copies: { "change-2": { bound: true } } });
  let result = await f.compare();
  assert.equal(result.verdict, "unresolved");
  assert.deepEqual(result.rows[0].clones, ["change-2"]);
  assert.equal(result.rows[0].class, "flaky");
  await writeJSON(join(f.directory, "change-1/checkpoints", phaseId, "timing.json"), [{ reachedBound: true, durationMs: 999999 }]);
  result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.equal(result.rows[0].class, "break");
});

test("noise removes only the varying item; new response fields and log lines still break", async (t) => {
  const f = await fixture(t, { copies: { "noise-1": { response: { title: "old", clock: 1 } }, "noise-2": { response: { title: "old", clock: 2 } }, baseline: { response: { title: "old", clock: 3 } }, ...both({ response: { title: "new", clock: 4 }, logs: "ERROR new\n" }) } });
  const result = await f.compare();
  assert.equal(result.noiseExcluded, 1);
  assert.deepEqual(result.rows.map((row) => row.at), ["ERROR new", "0/title"]);
  assert.equal(result.verdict, "breaks");
});

test("undeclared address segments are dropped without dropping stable siblings", async (t) => {
  const copies = Object.fromEntries(names.map((name, index) => [name, { response: { values: { [`generated-${index}`]: true, stable: name.startsWith("change") ? "new" : "old" } } }]));
  const f = await fixture(t, { copies });
  const result = await f.compare();
  assert.deepEqual(result.undeclared, [`${phaseId}/responses/0/values/*`]);
  assert.equal(result.verdict, "breaks");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].at, "0/values/stable");
});

test("undeclared addresses alone are unresolved", async (t) => {
  const f = await fixture(t, { copies: Object.fromEntries(names.map((name, i) => [name, { response: { [`key-${i}`]: true } }])) });
  const result = await f.compare();
  assert.equal(result.rows.length, 0);
  assert.equal(result.verdict, "unresolved");
});

test("noiseExcluded counts distinct rows after equal change values are merged", async (t) => {
  const f = await fixture(t, { copies: Object.fromEntries(names.map((name, i) => [name, { response: { title: i } }])) });
  const result = await f.compare();
  assert.equal(result.rows.length, 0);
  assert.equal(result.noiseExcluded, 2);
});

test("one-sided noisy addresses remain undeclared while stable siblings compare", async (t) => {
  const f = await fixture(t, { copies: {
    baseline: { response: { stable: false, records: {} } },
    "noise-1": { response: { stable: false, records: {} } },
    "noise-2": { response: { stable: false, records: { "noise-id": true } } },
    "change-1": { response: { stable: true, records: { "first-id": true } } },
    "change-2": { response: { stable: true, records: { "second-id": true } } }
  } });
  const result = await f.compare();
  assert.deepEqual(result.undeclared, [`${phaseId}/responses/0/records/*`]);
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows.map((row) => [row.at, row.class]), [["0/stable", "break"]]);
});

test("breaks precede exit 2 on every copy and retain the unexercised command", async (t) => {
  for (const name of names) {
    const f = await fixture(t, { copies: { ...both({ response: { title: "new" } }), [name]: { exit: 2, response: { title: name.startsWith("change") ? "new" : "old" } } } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks", name);
    assert.deepEqual(result.incomplete, [phaseId]);
    assert.deepEqual(result.notExercised, [{ copy: name, phase: phaseId, command, index: 0, exit: 2, reason: "command exited 2" }]);
    assert.ok(result.rows.some((row) => row.class === "break"));
    f.run.clones[name].started = false;
    f.run.clones[name].incomplete = [phaseId];
    await f.savePlan();
    assert.deepEqual((await f.compare()).notExercised, result.notExercised, "captured startup failures retain their command even when the copy did not start");
  }
  const incompleteOnly = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { exit: 2 }])) });
  const result = await incompleteOnly.compare();
  assert.equal(result.verdict, "unresolved");
  assert.equal(result.notExercised.length, 5);
});

test("missing checkpoints record fixed, break, and incomplete cases", async (t) => {
  const baselineMissing = await fixture(t, { missing: ["baseline"] });
  const recovered = await baselineMissing.compare();
  assert.equal(recovered.verdict, "good-to-go");
  assert.deepEqual(recovered.rows.map((row) => [row.signal, row.class]), [["checkpoint", "fixed"]]);
  const oneMissing = await fixture(t, { missing: ["change-1"], copies: { "change-2": { response: { title: "new" } } } });
  const uncertain = await oneMissing.compare();
  assert.equal(uncertain.verdict, "unresolved");
  assert.ok(uncertain.rows.every((row) => row.class === "flaky"));
  assert.deepEqual(uncertain.rows.find((row) => row.signal === "responses").clones, ["change-2"]);
  const changesMissing = await fixture(t, { missing: ["change-1", "change-2"] });
  assert.equal((await changesMissing.compare()).verdict, "breaks");
  const bothMissing = await fixture(t, { missing: ["baseline", "change-1", "change-2"] });
  assert.equal((await bothMissing.compare()).verdict, "unresolved");
  const noiseMissing = await fixture(t, { missing: ["noise-1"] });
  assert.deepEqual((await noiseMissing.compare()).incomplete, [phaseId]);
  const neverStarted = await fixture(t, { missing: names });
  for (const copy of Object.values(neverStarted.run.clones)) copy.started = false;
  delete neverStarted.run.personaExports;
  await rm(join(neverStarted.directory, ".persona"), { recursive: true });
  await neverStarted.savePlan();
  assert.equal((await neverStarted.compare()).verdict, "unresolved");
});

test("breaks precede not-started and incomplete; withheld and unmapped remain informational", async (t) => {
  const f = await fixture(t, { copies: both({ response: { title: "new" } }) });
  f.run.clones["noise-1"].started = false;
  f.run.incomplete = [phaseId];
  f.plan.withheld = [{ id: "sessions/other", missing: ["trait:missing"] }];
  f.plan.unmapped = ["no phase for src/other.ts"];
  await f.savePlan();
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.notStarted, ["noise-1"]);
  assert.ok(result.notExercised.some(item => item.copy === "noise-1" && item.phase === phaseId && item.reason === "copy did not start" && item.command === null && item.exit === null));
  assert.deepEqual(result.withheld, f.plan.withheld);
  const clean = await fixture(t);
  clean.plan.withheld = f.plan.withheld;
  clean.plan.unmapped = f.plan.unmapped;
  await clean.savePlan();
  assert.equal((await clean.compare()).verdict, "good-to-go");
  clean.run.incomplete = [phaseId];
  await clean.savePlan();
  const incompleteOnly = await clean.compare();
  assert.equal(incompleteOnly.verdict, "unresolved");
  assert.deepEqual(incompleteOnly.notExercised, [{ copy: null, phase: phaseId, command: null, exit: null, reason: "phase marked incomplete; copy and command evidence unavailable" }]);
  const failedStart = await fixture(t, { copies: { "noise-1": { exit: 1 } } });
  failedStart.run.clones["noise-1"].started = false;
  await failedStart.savePlan();
  assert.deepEqual((await failedStart.compare()).notExercised, [{ copy: "noise-1", phase: phaseId, command, index: 0, exit: 1, reason: "command exited 1" }]);
});

test("catalogue ids normalize values, keys, paths and embedded references, but existing ids stay", async (t) => {
  const copies = Object.fromEntries(names.map((name, i) => [name, { response: { result: { id: `new-${i}` }, ref: `prefix:new-${i}`, keys: { [`new-${i}`]: true } }, logs: `INFO new-${i}\n` }]));
  const f = await fixture(t, { copies, creates: ["/result/id"], state: async (path, name, i) => writeJSON(join(path, `new-${i}.json`), { id: `new-${i}` }) });
  assert.equal((await f.compare()).verdict, "good-to-go");
  const old = await fixture(t, { copies, creates: ["/result/id"], initial: async (path) => writeJSON(join(path, "persona.json"), { reference: "prefix:new-0" }) });
  const result = await old.compare();
  assert.equal(result.verdict, "breaks");
  assert.ok(result.rows.some((row) => row.at === "0/result/id" && row.baseline === "new-0"));
});

test("state id ordering and rowid ties normalize generated owners before their children", async (t) => {
  const f = await fixture(t, { stateIds: [
    { path: "files/store.sqlite", table: "children", column: "child_id", recordKey: "owner_id", order: "created" },
    { path: "files/store.sqlite", table: "owners", column: "owner_id", recordKey: "name" }
  ], state: async (path, name, i) => {
    const db = new DatabaseSync(join(path, "store.sqlite"));
    try {
      db.exec("CREATE TABLE owners (name TEXT PRIMARY KEY, owner_id TEXT); CREATE TABLE children (child_id TEXT PRIMARY KEY, owner_id TEXT, created INTEGER, content TEXT)");
      db.prepare("INSERT INTO owners VALUES (?, ?)").run("stable", `owner-${i}`);
      for (let n = 0; n < 3; n++) db.prepare("INSERT INTO children VALUES (?, ?, ?, ?)").run(`child-${i}-${n}`, `owner-${i}`, n < 2 ? 1 : 2, JSON.stringify({ related: `child-${i}-${n}` }));
    } finally { db.close(); }
  } });
  assert.equal((await f.compare()).verdict, "good-to-go");
  const db = new DatabaseSync(join(f.directory, "change-1/checkpoints", phaseId, "state/files/store.sqlite"));
  try { db.exec("UPDATE children SET content = '{\"related\":\"changed\"}' WHERE rowid = 2"); } finally { db.close(); }
  const result = await f.compare();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].class, "flaky");
  assert.match(result.rows[0].at, /child_id~11\.2>/);
});

test("cyclic state record keys are undeclared while change-only timeouts remain breaks", async (t) => {
  const f = await fixture(t, { stateIds: [
    { path: "files/store.sqlite", table: "records", column: "id", recordKey: "owner" },
    { path: "files/store.sqlite", table: "children", column: "child_id", recordKey: "owner" }
  ], state: async (path, name, index) => {
    const db = new DatabaseSync(join(path, "store.sqlite"));
    try {
      db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE children (child_id TEXT PRIMARY KEY, owner TEXT)");
      const insert = db.prepare("INSERT INTO records VALUES (?, ?)");
      insert.run(`self-${index}`, `self-${index}`);
      insert.run(`left-${index}`, `right-${index}`);
      insert.run(`right-${index}`, `left-${index}`);
      insert.run(`ordinary-${index}`, "stable");
      db.prepare("INSERT INTO children VALUES (?, ?)").run(`child-${index}`, `left-${index}`);
    } finally { db.close(); }
  } });
  const runCli = () => spawnSync(process.execPath, ["bin/kova.mjs", "verify", "compare", "--run", "sample", "--json"], {
    cwd: process.cwd(), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8", timeout: 15000
  });
  const control = runCli();
  assert.equal(control.status, 0, control.stderr);
  const before = JSON.parse(control.stdout);
  assert.equal(before.verdict, "unresolved");
  for (const [index, name] of names.entries()) {
    const addresses = before.undeclared.filter((address) => address.startsWith(`${name}/stateIds:`));
    assert.equal(addresses.length, 4);
    assert.ok(addresses.some((address) => address.includes(`"self-${index}"`) && address.includes("depends on cycle:")));
    assert.ok(addresses.some((address) => address.includes(`"left-${index}"`) && address.includes(`"right-${index}"`)));
    assert.ok(addresses.some((address) => address.includes("/child_id/*") && address.includes("depends on cycle:")));
    assert.ok(addresses.every((address) => !address.includes('"stable"')));
    await writeJSON(join(f.directory, name, "checkpoints", phaseId, "responses.json"), { 0: {
      ordinaryChat: "completed", overlap: { chat: name.startsWith("change") ? "timeout" : "completed", replyPersisted: !name.startsWith("change") }
    } });
  }
  const changed = runCli();
  assert.equal(changed.status, 0, changed.stderr);
  const result = JSON.parse(changed.stdout);
  assert.equal(result.verdict, "breaks");
  assert.ok(result.rows.some((row) => row.signal === "responses" && row.at === "0/overlap/chat" && row.baseline === "completed" && row.change === "timeout" && row.class === "break" && row.clones.length === 2));
  assert.deepEqual(result.undeclared, before.undeclared);
  for (const file of ["verdict.json", "noise.json", "issues.md"]) assert.ok((await readFile(join(f.directory, file))).length);
});

test("unresolved state dependencies preserve literals and resolved alternatives", () => {
  const record = (id, key, field = "id") => ({ path: "files/store.sqlite", field, key, ordered: false, ids: new Map([[id, { id, order: null, rowid: 1 }]]) });
  const input = (records, candidates = new Map(), extra = []) => ({ candidates, records: new Map(records.map((r, i) => [i, r])), allIds: new Set([...candidates.keys(), ...records.flatMap((r) => [...r.ids.keys()]), ...extra]) });
  const missing = normalizeDeclaredIds(input([record("dependent", "missing")], new Map(), ["missing"]), new Set());
  assert.match(missing.undeclared[0], /unresolved generated ids: \["missing"\]/);
  assert.equal(missing.text("dependent missing"), "dependent missing");
  assert.equal(missing.hasId("INFO dependent"), true);
  assert.equal(missing.isId("dependent"), true);
  const alternate = normalizeDeclaredIds(input([record("owner", "owner"), record("owner", "stable")]), new Set());
  assert.deepEqual(alternate.undeclared, []);
  assert.equal(alternate.id("owner"), '<id:files/store.sqlite#"stable"/id/1>');
  const created = normalizeDeclaredIds(input([record("owner", "owner")], new Map([["owner", "<id:creator>"]])), new Set());
  assert.equal(created.id("owner"), "<id:creator>");
  assert.deepEqual(created.undeclared, []);
  const protectedId = normalizeDeclaredIds(input([record("owner", "owner")]), new Set(["owner"]));
  assert.equal(protectedId.id("owner"), "owner");
  assert.deepEqual(protectedId.undeclared, []);
  const overlapping = normalizeDeclaredIds(input([record("short", "short-long")], new Map([["short-long", "<id:creator>"]])), new Set());
  assert.deepEqual(overlapping.undeclared, []);
  assert.equal(overlapping.id("short"), '<id:files/store.sqlite#"<id:creator>"/id/1>');
  const ring = Array.from({ length: 512 }, (_, index) => record(`ring-${index};`, `ring-${(index + 1) % 512};`));
  const cyclic = normalizeDeclaredIds(input(ring), new Set());
  assert.equal(cyclic.undeclared.length, ring.length);
  assert.ok(cyclic.undeclared.every((address) => address.includes("depends on cycle:")));
  assert.ok(JSON.stringify(cyclic.undeclared).length < 1024 * 1024);
  const duplicates = normalizeDeclaredIds(input(Array.from({ length: 512 }, (_, index) => record("shared", `shared:${index}`))), new Set());
  assert.equal(duplicates.undeclared.length, 512);
  assert.ok(duplicates.undeclared.every((address) => address.includes("depends on cycle:")));
});

test("wildcard creates use concrete array indices and preserve embedded references", async (t) => {
  const f = await fixture(t, { creates: ["/createdIds/*"], copies: Object.fromEntries(names.map((name, i) => [name, { response: { createdIds: [`id-${i}-a`, `id-${i}-b`], result: { key: `session:id-${i}-b` } } }])) });
  assert.equal((await f.compare()).verdict, "good-to-go");
});

test("saved exit-2 metadata reports missing command evidence without hiding breaks", async (t) => {
  const phases = [phaseId, "sessions/complete"].map(id => ({ id, from: "template:sessions", commands: [command], checkpoint: ["responses"] }));
  const f = await fixture(t, { phases, copies: both({ response: { title: "new" } }) });
  await rm(join(f.directory, "noise-1", "checkpoints", phaseId), { recursive: true });
  f.run.clones["noise-1"].phases[phaseId] = "no checkpoint";
  f.run.clones["noise-1"].incomplete = [phaseId];
  await f.savePlan();
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.notExercised, [{ copy: "noise-1", phase: phaseId, command: null, exit: 2, reason: "command exited 2; command recording unavailable" }]);
});

test("decodes JSON5, JSONL, text, binary and compressed SQLite values", async (t) => {
  const f = await fixture(t, { compressed: [{ path: "files/data.sqlite", table: "events", column: "event_zstd", codec: "zstd" }], state: async (path, name, i) => {
    const changed = name.startsWith("change");
    await writeFile(join(path, "config.json5"), `{ /* comment */ label: '${changed ? "new" : "old"}', }`);
    await writeFile(join(path, "events.jsonl"), JSON.stringify({ value: changed ? 2 : 1 }) + "\n");
    await writeFile(join(path, "text.txt"), `pid=${100 + i} duration=${i + 1}ms\n`);
    await writeFile(join(path, "binary.bin"), Buffer.from([0, changed ? 2 : 1]));
    const db = new DatabaseSync(join(path, "data.sqlite"));
    try { db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, event_zstd BLOB)"); db.prepare("INSERT INTO events VALUES (1, ?)").run(zstdCompressSync(Buffer.from(JSON.stringify({ text: changed ? "new" : "old" })))); } finally { db.close(); }
  } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows.map((row) => row.at), ["files/binary.bin", "files/config.json5/label", "files/data.sqlite:events/1/event_zstd/text", "files/events.jsonl/0/value"]);
});

test("uses container shape and escapes JSON pointers", async (t) => {
  const f = await fixture(t, { copies: { baseline: { response: { "a/b~c": [] } }, "noise-1": { response: { "a/b~c": [] } }, "noise-2": { response: { "a/b~c": [] } }, ...both({ response: { "a/b~c": [true] } }) } });
  const result = await f.compare();
  assert.deepEqual(result.rows.map((row) => row.at), ["0/a~1b~0c", "0/a~1b~0c/0"]);
  assert.deepEqual(result.rows[1].baseline, { absent: true });
});

test("corrupted product JSON and compressed content remain differences", async (t) => {
  const f = await fixture(t, { compressed: [{ path: "files/data.sqlite", table: "events", column: "event_zstd", codec: "zstd" }], state: async (path, name) => {
    const changed = name.startsWith("change");
    await writeFile(join(path, "config.json"), changed ? '{"broken"' : '{"valid":true}');
    const db = new DatabaseSync(join(path, "data.sqlite"));
    try { db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, event_zstd BLOB)"); db.prepare("INSERT INTO events VALUES (1, ?)").run(changed ? Buffer.from("invalid compressed bytes") : zstdCompressSync(Buffer.from('{"valid":true}'))); } finally { db.close(); }
  } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.ok(result.rows.some((row) => row.at.startsWith("files/config.json/")));
  assert.ok(result.rows.some((row) => row.at.endsWith("event_zstd") && row.change.sha256));
});

test("normalizes volatile text only, leaving ordinary identifiers and values intact", () => {
  assert.equal(normalizeText("2026-10-14T10:22:33.123Z pid=22 port: 9000 http://localhost:9000 took 23ms model=abc123 hash=00ff"), "<time> pid=<pid> port: <port> http://localhost:<port> took <duration> model=abc123 hash=00ff");
  assert.equal(normalizeText("ws://[::1]:18789/path https://[2001:db8::1]:2345/path"), "ws://[::1]:<port>/path https://[2001:db8::1]:<port>/path");
});

test("rejects edited plans, duplicate expectations and malformed checkpoint files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "plan.json"), "{}");
  await assert.rejects(f.compare(), /plan/);
  await f.savePlan();
  f.plan.intent.expects = [expectTitle, expectTitle];
  await f.savePlan();
  await assert.rejects(f.compare(), /duplicate expected/);
  f.plan.intent.expects = [];
  await f.savePlan();
  await rm(join(f.directory, "change-1/checkpoints", phaseId, "timing.json"));
  await assert.rejects(f.compare(), /ENOENT/);
  await assert.rejects(compareVerification({ run: "../sample" }, { home: f.home }), /run id/);
});

test("the CLI writes repeatable verdict and issues files using the recorded inputs", async (t) => {
  const f = await fixture(t, { copies: both({ response: { title: "new" } }), expects: [expectTitle] });
  const cli = (...args) => spawnSync(process.execPath, ["bin/kova.mjs", "verify", "compare", ...args], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, KOVA_HOME: f.home } });
  const first = cli("--run", "sample", "--json");
  assert.equal(first.status, 0, first.stderr);
  const verdict = JSON.parse(first.stdout);
  assert.equal(verdict.schema, "kova.verify.v1");
  assert.equal(verdict.verdict, "good-to-go");
  assert.equal(verdict.rows[0].class, "intended");
  assert.equal(verdict.findings[0].count, 1);
  assert.equal(verdict.findings[0].class, "intended");
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, "verdict.json"), "utf8")), verdict);
  assert.equal(cli("--run", "sample", "--json").stdout, first.stdout);
  const markdown = await readFile(join(f.directory, "issues.md"), "utf8");
  assert.match(markdown, /^# Findings\n/);
  assert.match(markdown, /Representative baseline/);
  assert.match(markdown, /No shared failures/);
  assert.notEqual(cli("--run", "sample", "--threshold", "0").status, 0);
  assert.notEqual(cli("--run").status, 0);
  assert.notEqual(cli("--run", "missing").status, 0);
});

test("recorded build declarations align asset requests and keep endpoint failures", async (t) => {
  const asset = (hash, statusCode = 200) => ({ transport: "http", method: "GET", endpoint: `/assets/control-ui-boot-shared-${hash}.js`, origin: "gateway", resourceType: "script", params: { query: {}, body: null }, status: "result", elapsedMs: 10, statusCode });
  const rpc = { transport: "gateway", method: "sessions.list", params: {}, status: "result", elapsedMs: 3 };
  const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { response: { requests: name.startsWith("change") ? [{ ...rpc, elapsedMs: 99 }, asset("abcdefgh"), asset("1234_-AB")] : [asset("12345678"), rpc] } }])) });
  await writeJSON(join(f.directory, "catalogue.json"), { schema: "kova.verify.catalogue.v1", product: "openclaw", revision: "1", entries: [{ ...entry, id: "control-ui" }] });
  assert.equal((await f.compare()).verdict, "breaks", "old saved declarations remain authoritative");
  const standard = JSON.parse(await readFile(join(f.directory, "standard.json"), "utf8"));
  standard.buildIds = [{ kind: "asset-fingerprint", command: "control-ui", at: "/requests/*/endpoint" }];
  await writeJSON(join(f.directory, "standard.json"), standard);
  const result = await compareVerification({ run: "sample" }, { home: join(f.home, "artifacts") });
  assert.equal(result.verdict, "good-to-go");
  assert.deepEqual(result.rows, []);
  const noise = JSON.parse(await readFile(join(f.directory, "noise.json"), "utf8"));
  assert.ok(noise.items.some(item => item.category === "declaredIds" && item.at.endsWith("/endpoint")));
  assert.ok(noise.items.some(item => item.category === "derived" && item.at === "0/requests"));
  assert.equal(result.dropped[0].derived, noise.items.filter(item => item.category === "derived").length);
  for (const name of ["change-1", "change-2"]) await writeJSON(join(f.directory, name, "checkpoints", phaseId, "responses.json"), { 0: { requests: [rpc, asset("abcdefgh", 500)] } });
  const failed = await f.compare();
  assert.equal(failed.verdict, "breaks");
  assert.ok(failed.rows.some(row => row.at.includes("control-ui-boot-shared-<build-id>.js") && row.at.endsWith("/statusCode") && row.change === 500));
});

test("Control UI step durations are measurements while outcomes and malformed values remain", async (t) => {
  for (const mode of ["duration", "status", "action", "payload", "malformed"]) {
    const f = await fixture(t, { copies: Object.fromEntries(names.map(name => {
      const changed = name.startsWith("change");
      return [name, { response: { steps: [{ action: mode === "action" && changed ? "changed" : "inspect", status: mode === "status" && changed ? "error" : "result", elapsedMs: mode === "malformed" ? changed ? "slower" : "slow" : changed ? 11 : 10, output: { elapsedMs: mode === "payload" && changed ? 11 : 10 } }] } }];
    })) });
    await writeJSON(join(f.directory, "catalogue.json"), { schema: "kova.verify.catalogue.v1", product: "openclaw", revision: "1", entries: [{ ...entry, id: "control-ui" }] });
    assert.equal((await f.compare()).verdict, mode === "duration" ? "good-to-go" : "breaks", mode);
  }
});

test("native log measurements and generated WebSocket identities retain outcomes and foreign text", async (t) => {
  for (const mode of ["plain", "structured", "timing", "foreign", "foreign-payload", "error-payload", "bytes", "outcome", "literal"]) {
    const f = await fixture(t, { creates: ["/id"], copies: Object.fromEntries(names.map((name, index) => {
      const changed = name.startsWith("change"), id = `generated-${name}`;
      const identityIndex = mode === "foreign" ? changed ? 7 : 6 : index;
      const connection = mode === "literal" && changed ? "<connection>" : `${String(identityIndex).padStart(8, "0")}…1234`;
      let logs = `⇄ res ${mode === "outcome" && changed ? "✗" : "✓"} chat.send 12ms runId=${id} bytes=${mode === "bytes" && changed ? 25 : 24} conn=${connection} id=kova-${String(identityIndex).padStart(7, "0")}…5678`;
      if (mode === "plain") logs = `2026-10-17T15:00:00.000Z [ws] ${logs}`;
      if (mode === "structured") logs = JSON.stringify({ level: "info", subsystem: "gateway/ws", message: logs });
      if (mode === "foreign") logs = `application payload: ${logs}`;
      if (mode === "foreign-payload") logs = JSON.stringify({ level: "info", subsystem: "application", message: "application payload", runId: id, payload: `⇄ res ✓ chat.send conn=${changed ? "bbbbbbbb…2222" : "aaaaaaaa…1111"} id=literal` });
      if (mode === "error-payload") logs = `⇄ res ✗ chat.send runId=${id} errorMessage=invalid account-conn=${changed ? "bbbbbbbb…2222" : "aaaaaaaa…1111"} id=kova-${String(index).padStart(7, "0")}…5678`;
      if (mode === "timing") logs = `WARN agent turn milestone runId=${id} milestone=context_assembled totalMs=${index + 10} stages=prepare:2ms@2ms`;
      return [name, { response: { id }, logs }];
    })) });
    const inventory = [], result = await compareRecordedRun(f.directory, { noiseItems: inventory });
    assert.equal(result.verdict, ["plain", "structured", "timing"].includes(mode) ? "good-to-go" : "breaks", mode);
    if (["plain", "structured"].includes(mode)) assert.ok(inventory.some(item => item.category === "declaredIds" && item.reason.includes("WebSocket")), mode);
    if (mode === "timing") assert.ok(inventory.some(item => item.category === "measurements" && typeof item.before === "string" && item.before.includes("totalMs=")));
  }
});

test("overflow JSON log numbers remain distinct from null and literal marker objects", async (t) => {
  for (const original of ["null", '{"number":"Infinity"}', "1"]) for (const changed of ["1e400", "-1e400"]) {
    const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { logs: JSON.stringify({ level: "warn", message: `{"value":${name.startsWith("change") ? changed : original},"nested":[${name.startsWith("change") ? changed : original}]}` }) }])) });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks");
    assert.ok(result.rows.some(row => row.at.includes(changed)));
  }
});

test("structured logs reject normalized key collisions instead of losing changed values", async (t) => {
  for (const collision of [false, true]) {
    const f = await fixture(t, { creates: ["/id"], copies: Object.fromEntries(names.map(name => {
      const id = `generated-${name}`;
      return [name, { response: { id }, logs: JSON.stringify({ level: "info", [id]: name.startsWith("change") ? "new" : "old", [collision ? "<id:sessions/read/0/id>" : "literal-key"]: "kept" }) }];
    })) });
    if (collision) await assert.rejects(f.compare(), /normalization produced duplicate JSON keys/);
    else assert.equal((await f.compare()).verdict, "breaks");
  }
});

test("transcript FTS exclusions retain source identities, ordinary tables and prompt findings", async (t) => {
  const phases = ["sessions/read", "sessions/later"].map(id => ({ id, from: "template:sessions", commands: [command], checkpoint: ["responses", "state:agents", "state:files"] }));
  const createFTS = (db, id, text) => {
    db.exec("CREATE VIRTUAL TABLE session_transcript_fts USING fts5(text, session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, timestamp UNINDEXED); CREATE TABLE session_transcript_fts_rows (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT)");
    db.prepare("INSERT INTO session_transcript_fts(rowid,text,session_id) VALUES (?,?,?)").run(id, text, "original-session");
    db.prepare("INSERT INTO session_transcript_fts_rows VALUES (?, ?, ?)").run(id, "original-session", text);
  };
  for (const mode of ["derived", "ordinary", "sibling-index", "prompt", "source"]) {
    const f = await fixture(t, { phases, creates: ["/id"], copies: Object.fromEntries(names.map(name => [name, { response: { id: mode === "source" && name.startsWith("change") ? "source-existing" : `generated-${name}` } }])),
      initial: async files => {
        const root = join(files, "../agents/main/agent"); await mkdir(root, { recursive: true });
        const db = new DatabaseSync(join(root, "openclaw-agent.sqlite"));
        try { createFTS(db, 1, "source-existing"); } finally { db.close(); }
      },
      state: async (files, name, index) => {
        const root = join(files, "../agents/main/agent"); await mkdir(root, { recursive: true });
        const db = new DatabaseSync(join(root, "openclaw-agent.sqlite"));
        try {
          createFTS(db, index * 100 + 1, `indexed-${index}`);
          if (mode === "sibling-index") {
            db.exec("CREATE VIRTUAL TABLE session_transcript_fts_archive USING fts5(text)");
            db.prepare("INSERT INTO session_transcript_fts_archive(text) VALUES (?)").run(name.startsWith("change") ? "after" : "before");
          }
          db.exec("CREATE TABLE session_entry_snapshots (session_key TEXT, name TEXT, value_json TEXT, PRIMARY KEY(session_key,name))");
          db.prepare("INSERT INTO session_entry_snapshots VALUES (?,?,?)").run("original-session", "systemPromptReport", JSON.stringify({ skills: { entries: [{ blockChars: mode === "prompt" && name.startsWith("change") ? 358 : 360 }] } }));
        } finally { db.close(); }
        const ordinary = new DatabaseSync(join(files, "ordinary.sqlite"));
        try { ordinary.exec("CREATE TABLE session_transcript_fts_rows (id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT)"); ordinary.prepare("INSERT INTO session_transcript_fts_rows VALUES (1,'stable',?)").run(mode === "ordinary" && name.startsWith("change") ? "changed" : "same"); }
        finally { ordinary.close(); }
      }
    });
    const inventory = [], result = await compareRecordedRun(f.directory, { noiseItems: inventory });
    assert.equal(result.verdict, mode === "derived" ? "good-to-go" : "breaks", mode);
    assert.ok(!result.rows.some(row => /openclaw-agent\.sqlite:session_transcript_fts_(?:data|idx|content|docsize|config|rows)(?:\/|$)/.test(row.at)), mode);
    assert.ok(inventory.some(item => item.category === "derived" && item.at.endsWith(":session_transcript_fts_rows") && item.before.rows === 1));
    for (const phase of phases) assert.equal(result.dropped.find(item => item.phase === phase.id).derived, inventory.filter(item => item.phase === phase.id && item.category === "derived").length);
    if (mode === "prompt") {
      assert.ok(result.rows.some(row => row.at.endsWith("/blockChars") && row.baseline === 360 && row.change === 358));
      const finding = result.findings.find(item => item.pattern.endsWith("/blockChars"));
      assert.equal(finding.count, 2); assert.equal(finding.phases.length, 2);
    }
    if (mode === "ordinary") assert.ok(result.rows.some(row => row.at.startsWith("files/ordinary.sqlite:session_transcript_fts_rows")));
    if (mode === "sibling-index") assert.ok(result.rows.some(row => row.at.includes(":session_transcript_fts_archive_content/") && row.change === "after"));
    if (mode === "source") assert.ok(result.rows.some(row => row.signal === "responses" && row.change === "source-existing"));
  }
});

test("native transcript projections exclude derived rows while source and unknown shapes remain", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "state:agents", "state:files"] };
  for (const mode of ["derived", "source", "unknown"]) {
    const f = await fixture(t, { phases: [phase], state: async (files, name, index) => {
      const root = join(files, "../agents/main/agent"); await mkdir(root, { recursive: true });
      const db = new DatabaseSync(join(root, "openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE session_windows (session_id TEXT PRIMARY KEY); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, PRIMARY KEY(session_id,seq)); INSERT INTO session_windows VALUES ('session')");
        db.prepare("INSERT INTO transcript_events VALUES ('session',1,?)").run(JSON.stringify({ text: mode === "source" && name.startsWith("change") ? "changed product message" : "stable" }));
        db.exec(`CREATE TABLE session_transcript_active_events (session_id TEXT NOT NULL, active_position INTEGER NOT NULL, event_seq INTEGER NOT NULL, message_position INTEGER, context_eligible INTEGER${mode === "unknown" ? ", extra TEXT" : ""}, PRIMARY KEY(session_id,active_position)) STRICT;
          CREATE TABLE session_transcript_index_state (session_id TEXT NOT NULL PRIMARY KEY, indexed_seq INTEGER NOT NULL, leaf_event_id TEXT, needs_rebuild INTEGER NOT NULL, active_event_count INTEGER NOT NULL, active_message_count INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`);
        db.exec(`INSERT INTO session_transcript_active_events VALUES ('session',${mode === "unknown" ? 0 : index},1,${index},1${mode === "unknown" ? `,'${name.startsWith("change") ? "changed" : "stable"}'` : ""});
          INSERT INTO session_transcript_index_state VALUES ('session',${index},'leaf',0,${index},${index},${index})`);
      } finally { db.close(); }
    } });
    const inventory = [], result = await compareRecordedRun(f.directory, { noiseItems: inventory });
    assert.equal(result.verdict, mode === "derived" ? "good-to-go" : "breaks", mode);
    assert.equal(inventory.filter(item => item.category === "derived" && item.at.endsWith(":session_transcript_index_state") && item.before.rows === 1).length, 5);
    if (mode === "derived") assert.equal(inventory.filter(item => item.category === "derived" && item.at.endsWith(":session_transcript_active_events")).length, 5);
    if (mode === "source") assert.ok(result.rows.some(row => row.at.includes(":transcript_events/") && row.change === "changed product message"));
    if (mode === "unknown") assert.ok(result.rows.some(row => row.at.endsWith("/extra") && row.change === "changed"));
  }
});

test("runtime event rows compare normalized content and multiplicity without storage positions", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "state:agents"] };
  for (const mode of ["sequence", "state-run-id", "runtime-bindings", "different-runtime-port", "no-primary-key", "payload", "duplicate", "noisy-payload", "non-finite", "negative-non-finite", "tool-duration", "tool-outcome", "tool-output", "tool-payload", "tool-malformed"]) {
    const stateIds = mode === "state-run-id" ? [{ path: "agents/*/agent/openclaw-agent.sqlite", table: "trajectory_runtime_events", column: "run_id", recordKey: "session_id", order: "created_at" }] : [];
    const f = await fixture(t, { phases: [phase], stateIds, creates: mode === "state-run-id" ? ["/id"] : ["/id", "/run"], copies: Object.fromEntries(names.map(name => [name, { response: { id: `session-${name}`, run: `run-${name}` } }])),
      initial: async (files, name, index) => {
        if (["runtime-bindings", "different-runtime-port"].includes(mode)) await writeJSON(join(files, "../openclaw.json"), { gateway: { port: 20000 + index }, models: { providers: { mock: { baseUrl: `http://127.0.0.1:${30000 + index}/v1` } } } });
      }, state: async (files, name, index) => {
      const root = join(files, "../agents/main/agent"); await mkdir(root, { recursive: true });
      const db = new DatabaseSync(join(root, "openclaw-agent.sqlite"));
      try {
        db.exec(`CREATE TABLE trajectory_runtime_events (session_id TEXT, seq INTEGER, run_id TEXT, event_json TEXT, created_at INTEGER${mode === "no-primary-key" ? "" : ", PRIMARY KEY(session_id,seq)"})`);
        const ts = new Date(1700000000000 + index * 1000).toISOString();
        const event = { traceSchema: "openclaw-trajectory", schemaVersion: 1, traceId: `session-${name}`, source: "runtime", type: "compiled", ts, seq: index + 1, sourceSeq: index + 1, sessionId: `session-${name}`, runId: `run-${name}`, data: { blockChars: ["payload", "noisy-payload"].includes(mode) && name.startsWith("change") ? 358 : mode === "noisy-payload" && name === "noise-2" ? 362 : 360, durationMs: 10 } };
        if (["runtime-bindings", "different-runtime-port"].includes(mode)) {
          event.type = "trace.metadata";
          event.data = { capturedAt: ts, config: { redacted: { gateway: { port: mode === "different-runtime-port" && name.startsWith("change") ? 25000 : 20000 + index }, models: { providers: { mock: { baseUrl: `http://127.0.0.1:${30000 + index}/v1` } } } } } };
        }
        if (mode.startsWith("tool-")) {
          const changed = name.startsWith("change");
          event.type = "tool.result";
          event.data = { name: mode === "tool-payload" ? "custom" : "exec", success: true, result: {
            details: { durationMs: mode === "tool-malformed" ? changed ? "slower" : "slow" : changed ? 11 : 10, exitCode: mode === "tool-outcome" && changed ? 1 : 0 },
            content: [{ type: "text", text: mode === "tool-output" && changed ? "new" : "old" }]
          } };
        }
        if (mode.endsWith("non-finite")) event.data = { nested: { value: null }, values: [null] };
        const recordedEvent = mode.endsWith("non-finite") && name.startsWith("change")
          ? JSON.stringify(event).replaceAll("null", mode === "non-finite" ? "1e400" : "-1e400") : JSON.stringify(event);
        const insert = db.prepare("INSERT INTO trajectory_runtime_events(rowid,session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?,?)");
        insert.run(index + 20, `session-${name}`, index + 30, `run-${name}`, recordedEvent, Date.parse(ts));
        if (mode === "duplicate" && name.startsWith("change")) insert.run(index + 200, `session-${name}`, index + 300, `run-${name}`, JSON.stringify(event), Date.parse(ts));
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, ["sequence", "state-run-id", "runtime-bindings", "no-primary-key", "tool-duration"].includes(mode) ? "good-to-go" : "breaks", mode);
    if (mode === "duplicate") assert.ok(result.rows.some(row => row.at.endsWith(">") && row.baseline.count === 1 && row.change.count === 2));
    if (["payload", "noisy-payload"].includes(mode)) {
      assert.ok(result.rows.some(row => row.change.content?.event_json.data.blockChars === 358 && row.class === "break"));
      assert.ok(result.rows.every(row => !row.at.includes("/content/")), "full event payload stays in one observation rather than repeated sibling rows");
      assert.equal(result.findings.length, 1, "one full-content finding retains both event observations");
    }
    if (mode === "different-runtime-port") {
      const saved = await compareVerification({ run: "sample" }, { home: join(f.home, "artifacts") });
      assert.deepEqual(JSON.parse(await readFile(join(f.directory, "verdict.json"), "utf8")), JSON.parse(JSON.stringify(saved)), "full payloads use the plain JSON verdict form, including branded binding evidence");
    }
    if (mode.endsWith("non-finite")) {
      await compareVerification({ run: "sample" }, { home: join(f.home, "artifacts") });
      const saved = JSON.parse(await readFile(join(f.directory, "verdict.json"), "utf8"));
      const row = saved.rows.find(row => row.change.content?.event_json.data.nested);
      const number = mode === "non-finite" ? "Infinity" : "-Infinity";
      assert.equal(row.class, "break");
      assert.deepEqual(row.change.content.event_json.data, { nested: { value: { number } }, values: [{ number }] });
    }
  }
});

test("an existing id outside selected state stays visible through the real checkpoint writer", async (t) => {
  const f = await fixture(t, { creates: ["/id"], originalFiles: { "cron/jobs.json": '{"id":"persona-existing-id"}' } });
  for (const name of names) {
    const phase = f.plan.phases[0], directory = join(f.directory, name);
    await rm(join(directory, "checkpoints"), { recursive: true });
    const id = name.startsWith("change") ? "persona-existing-id" : `generated-${name}`;
    await writeCheckpoint({ phase, directory, creates: [["/id"]], collectLogs: async () => "", results: [{ command, status: 0, stdout: JSON.stringify({ id, findings: [] }), stderr: "", durationMs: 1, timedOut: false }] });
  }
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  const row = result.rows.find((row) => row.at === "0/id");
  assert.equal(row.class, "break");
  assert.equal(row.change, "persona-existing-id");
  assert.match(row.baseline, /^<id:/);
});

test("declared native message identities normalize new values while preserving originals and payload", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "state:agents"] };
  const declaration = { kind: "runtime-message-ids", path: "agents/*/agent/openclaw-agent.sqlite", table: "trajectory_runtime_events", column: "event_json", recordKey: "session_id", order: "created_at" };
  for (const mode of ["generated", "original", "payload", "undeclared"]) {
    const ids = (name, index) => ({ response: mode === "original" && name.startsWith("change") ? "persona-response" : `response-${index}`,
      signature: `signature-${index}`, call: `call-${index}`, run: `0000000${index}-0000-4000-8000-000000000000` });
    const f = await fixture(t, { phases: [phase], stateIds: mode === "undeclared" ? [] : [declaration], originalFiles: { "known.json": '{"response":"persona-response"}' },
      copies: Object.fromEntries(names.map((name, index) => [name, { response: { responseId: ids(name, index).response } }])),
      state: async (files, name, index) => {
        const root = join(files, "../agents/main/agent"); await mkdir(root, { recursive: true });
        const db = new DatabaseSync(join(root, "openclaw-agent.sqlite"));
        try {
          db.exec("CREATE TABLE trajectory_runtime_events (session_id TEXT, seq INTEGER, run_id TEXT, event_json TEXT, created_at INTEGER, PRIMARY KEY(session_id,seq))");
          const id = ids(name, index), timestamp = 1700000000000 + index;
          const event = { traceSchema: "openclaw-trajectory", schemaVersion: 1, source: "runtime", type: "model.completed", sessionId: "session-a", traceId: "session-a", runId: "run-a", seq: 1, sourceSeq: 1, ts: new Date(timestamp).toISOString(), data: {
            messagesSnapshot: [{ role: "assistant", api: "openai-responses", provider: "openai", model: "mock", usage: {}, stopReason: "stop", responseId: id.response,
              content: [{ type: "text", text: mode === "payload" && name.startsWith("change") ? "changed" : "reply", textSignature: JSON.stringify({ v: 1, id: id.signature }) }, { type: "toolCall", name: "exec", arguments: {}, id: id.call }] },
            { role: "toolResult", toolName: "exec", toolCallId: id.call, isError: false, content: [] }, { role: "user", content: "prompt", idempotencyKey: `${id.run}:user` }]
          } };
          db.prepare("INSERT INTO trajectory_runtime_events VALUES ('session-a',1,'run-a',?,?)").run(JSON.stringify(event), timestamp);
        } finally { db.close(); }
      }
    });
    const result = await f.compare();
    assert.equal(result.verdict, mode === "generated" ? "good-to-go" : "breaks", mode);
    if (mode === "original") assert.ok(result.rows.some(row => row.at === "0/responseId" && row.change === "persona-response" && row.class === "break"));
    if (mode === "payload") assert.ok(result.rows.some(row => row.change.content?.event_json.data.messagesSnapshot[0].content[0].text === "changed"));
    if (mode === "generated") {
      await writeJSON(join(f.directory, "standard.json"), { schema: "kova.verify.standard.v1", compressed: [], stateIds: [{ ...declaration, kind: "unknown-runtime-ids" }] });
      await assert.rejects(f.compare(), /invalid native runtime identity declaration/);
    }
  }
});

test("created ids survive unselected responses and expose a changed keyed state value", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:selected.json"] };
  const f = await fixture(t, { phases: [phase], creates: ["/id"] });
  for (const name of names) {
    const directory = join(f.directory, name), source = join(f.home, name);
    await mkdir(source); await writeJSON(join(source, "selected.json"), {});
    await snapshotState(source, ["selected.json"], join(directory, "initial-state"));
    await rm(join(directory, "checkpoints"), { recursive: true });
    const id = `generated-${name}`;
    await writeJSON(join(source, "selected.json"), { [id]: { enabled: name.startsWith("change") } });
    await writeCheckpoint({ phase, directory, stateDirectory: source, creates: [["/id"]], results: [{ command, status: 0, stdout: JSON.stringify({ id }), stderr: "", durationMs: 1, timedOut: false }] });
    await assert.rejects(readFile(join(directory, "checkpoints", phase.id, "responses.json")), { code: "ENOENT" });
  }
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.undeclared, []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].baseline, false);
  assert.equal(result.rows[0].change, true);
});

test("complete persona lookup covers escaped JSON, binary boundaries and declared compressed data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-ids-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "source.sqlite");
  const db = new DatabaseSync(dbPath);
  try { db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, event_zstd BLOB)"); db.prepare("INSERT INTO events VALUES (1, ?)").run(zstdCompressSync(Buffer.from('{"id":"compressed-original"}'))); } finally { db.close(); }
  const sources = await exportFixture(directory, {
    "escaped.json": '{"id":"escaped\\u002doriginal"}',
    "data.sqlite": await readFile(dbPath),
    "binary.bin": Buffer.concat([Buffer.alloc(65534), Buffer.from("prefix-original-tail")]),
    "plain.txt": "long-overlapping-id",
  });
  const candidates = new Set(["escaped-original", "compressed-original", "prefix-original-tail", "original", "long-overlapping-id", "long-overlapping", "overlapping-id", "absent-id"]);
  const found = await personaExistingIds(directory, sources, candidates, { stateIds: [], compressed: [{ path: "data.sqlite", table: "events", column: "event_zstd", codec: "zstd" }] });
  assert.deepEqual([...found].sort(), [...candidates].filter((id) => id !== "absent-id").sort());
  await assert.rejects(personaExistingIds(directory, [{ ...sources[0], sha256: "0".repeat(64) }], candidates, { compressed: [] }), /SHA256 differs/);
  await assert.rejects(personaExistingIds(directory, [{ ...sources[0], path: "../outside.tar" }], candidates, { compressed: [] }), /path|source|export/i);
});

test("persona source rejects a missing terminator and a redirected export", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-ids-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sources = await exportFixture(directory, { "zeros.bin": Buffer.alloc(4096) });
  const archive = join(directory, sources[0].path), bytes = await readFile(archive);
  const truncated = bytes.subarray(0, bytes.length - 1024);
  await writeFile(archive, truncated);
  await assert.rejects(personaExistingIds(directory, [{ ...sources[0], sha256: sha256(truncated) }], new Set(["absent"]), { compressed: [] }), /truncat|terminator/i);
  await rm(archive);
  const external = join(directory, "external.tar"); await writeFile(external, bytes); await symlink(external, archive);
  await assert.rejects(personaExistingIds(directory, sources, new Set(), { compressed: [] }), /ELOOP|symbolic|regular|link/i);
});


test("secondary environment commands compare through the actual checkpoint writer", async (t) => {
  const phase = { id: "standard/use-target", from: "standard", commands: [command], checkpoint: ["responses"] };
  const f = await fixture(t, { phases: [phase] });
  const source = f.run.personaExports[0];
  const extra = { ...source, path: ".persona/secondary.ocm-env.tar" };
  await writeFile(join(f.directory, extra.path), await readFile(join(f.directory, source.path)));
  f.run.personaExports.push(extra);
  await f.savePlan();
  for (const name of names) {
    const directory = join(f.directory, name);
    await rm(join(directory, "checkpoints"), { recursive: true });
    await writeCheckpoint({ phase, directory, results: ["primary", "secondary"].map((environment) => ({ command: "node '/retained source/support/compare-probe.mjs'", status: 0, stdout: JSON.stringify({ environment }), stderr: "", durationMs: 1 })) });
  }
  const result = await f.compare();
  assert.equal(result.verdict, "good-to-go");
  assert.deepEqual(result.rows, []);
});


test("response recordings require exactly the JSON command outputs", async (t) => {
  const f = await fixture(t);
  const response = join(f.directory, "change-1/checkpoints", phaseId, "responses.json");
  for (const invalid of [false, 1, null, [], [{ title: "old" }], {}, { 1: {} }, { "00": {} }, { 0: {}, 1: {} }]) {
    await writeJSON(response, invalid);
    await assert.rejects(f.compare(), /invalid response checkpoint/);
  }
  await writeJSON(response, { 0: { title: "old" } });
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of names) {
    const checkpoint = join(f.directory, name, "checkpoints", phaseId);
    const commands = JSON.parse(await readFile(join(checkpoint, "commands.json")));
    commands[0].stdout = "ordinary text\n";
    await writeJSON(join(checkpoint, "commands.json"), commands);
    await writeJSON(join(checkpoint, "responses.json"), {});
  }
  assert.equal((await f.compare()).verdict, "good-to-go");
  await writeJSON(response, { 0: null });
  await assert.rejects(f.compare(), /invalid response checkpoint/);
});

test("the CLI rejects a FIFO recording without waiting for a writer", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, "run.json");
  await rm(file);
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
  const result = spawnSync(process.execPath, ["bin/kova.mjs", "verify", "compare", "--run", "sample", "--json"], { cwd: new URL("..", import.meta.url), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a regular file/);
});

test("missing declared SQLite columns remain product differences", async (t) => {
  for (const column of ["id", "owner", "created"]) {
    const f = await fixture(t, { stateIds: [{ path: "files/store.sqlite", table: "records", column: "id", recordKey: "owner", order: "created" }], state: async (path, name, index) => {
      const db = new DatabaseSync(join(path, "store.sqlite"));
      try {
        db.exec("CREATE TABLE records (row_key TEXT PRIMARY KEY, owner TEXT, id TEXT, created INTEGER)");
        db.prepare("INSERT INTO records VALUES ('stable', 'same-owner', ?, 1)").run(`generated-${index}`);
        if (name.startsWith("change")) db.exec(`ALTER TABLE records DROP COLUMN "${column}"`);
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks", column);
    assert.ok(result.rows.some((row) => row.at.endsWith(`/${column}`) && row.class === "break"), column);
  }
});

test("mixed phases consume actual Doctor formats through the checkpoint writer", async (t) => {
  const doctor = "ocm @{env} -- doctor --json";
  const sqlite = "ocm @{env} -- doctor --session-sqlite inspect --session-sqlite-all-agents --json";
  const repair = "node {kovaRoot}/support/run-doctor-repair.mjs --env {env}";
  const phase = { id: phaseId, from: "template:sessions", commands: [command, doctor, sqlite, repair, doctor], checkpoint: ["doctor"] };
  const f = await fixture(t, { phases: [phase] });
  const shipped = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url)));
  // The captured repair output belongs to the earlier helper. A saved run
  // carries that helper's catalogue even after the installed catalogue changes.
  const recorded = shipped.entries.map((item) => item.id === "doctor-repair"
    ? { ...item, command: repair, flags: { "--env": { description: "OCM environment name", value: "required" } } }
    : item);
  await writeJSON(join(f.directory, "catalogue.json"), { ...shipped, entries: [...recorded, entry] });
  for (const name of names) {
    const changed = name.startsWith("change");
    const output = [
      { findings: ["unrelated output"] },
      { schemaVersion: 1, ok: false, findings: [{ checkId: "check", message: "shared" }, { checkId: "check", message: changed ? "new" : "fixed" }, { checkId: "changed-type", message: changed ? 42 : "readable" }], warnings: [{ checkId: "warning", message: "shared warning" }] },
      { mode: "inspect", targets: ["main", "other"].map((agentId) => ({ agentId, issues: [{ code: "transcript_missing", sessionKey: "stable", message: "Missing transcript" }] })) },
      { schemaVersion: "kova.doctorRepair.v1", errors: changed ? ["Repair failed"] : [] },
      changed ? { unexpected: true } : { findings: [] }
    ];
    const directory = join(f.directory, name);
    await rm(join(directory, "checkpoints"), { recursive: true });
    await writeCheckpoint({ phase, directory, results: output.map((value, index) => ({ command: phase.commands[index], status: index === 3 && changed ? 1 : 0, stdout: JSON.stringify(value), stderr: "", durationMs: 1 })) });
  }
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.ok(!result.rows.some((row) => row.at.includes("unrelated")));
  assert.equal(result.rows.find((row) => row.at === "shared").class, "not-caused");
  assert.equal(result.rows.find((row) => row.at === "shared warning").class, "not-caused");
  assert.equal(result.rows.find((row) => row.at === "fixed").class, "fixed");
  assert.equal(result.rows.find((row) => row.at === "new").class, "break");
  assert.equal(result.rows.find((row) => row.at === "Repair failed").class, "break");
  assert.equal(result.rows.filter((row) => row.at.includes("transcript_missing") && row.class === "not-caused").length, 2);
  assert.ok(result.rows.some((row) => row.at === "4/output/unexpected" && row.class === "break"));
  assert.ok(result.rows.some((row) => row.at.includes('"message":42') && row.class === "break"));
});


test("recorded target bindings normalize fresh and cached copies but expose a wrong binding", async (t) => {
  const start = "ocm start {env} --runtime {target} --no-service --json";
  const show = "ocm env show {env} --json";
  const phases = [{ id: "standard/use-target", from: "standard", commands: [start], checkpoint: ["responses"] }, { id: "standard/snapshot", from: "standard", commands: [show], checkpoint: ["responses"] }];
  const f = await fixture(t, { phases });
  await writeJSON(join(f.directory, "catalogue.json"), JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url))));
  f.run.targets.baseline.runtime = "kova-run-11111111-1111-4111-8111-111111111111-baseline";
  f.run.targets.change.runtime = "kova-run-22222222-2222-4222-8222-222222222222-change";
  for (const name of names) {
    const runtime = f.run.targets[name.startsWith("change") ? "change" : "baseline"].runtime;
    const directory = join(f.directory, name);
    await rm(join(directory, "checkpoints"), { recursive: true });
    for (const phase of phases) await writeCheckpoint({ phase, directory, results: [{ command: phase.commands[0].replace("{env}", name).replace("{target}", runtime), status: 0, stdout: JSON.stringify({ defaultRuntime: runtime, bindingText: `prefix:${runtime}`, preserved: "value" }), stderr: "", durationMs: 1 }] });
  }
  await f.savePlan();
  assert.equal((await f.compare()).verdict, "good-to-go");
  delete f.run.targets.baseline.runtime;
  for (const name of ["baseline", "noise-1", "noise-2"]) f.run.clones[name].cached = true;
  await f.savePlan();
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) {
    const path = join(f.directory, name, "checkpoints/standard/snapshot/responses.json");
    const response = JSON.parse(await readFile(path)); response[0].defaultRuntime = "wrong-runtime";
    await writeJSON(path, response);
  }
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows.map((row) => [row.at, row.baseline, row.change]), [["0/defaultRuntime", "<runtime:target>", "wrong-runtime"]]);
});

test("helper durations do not become differences when the two noise values happen to agree", async (t) => {
  const gateway = "node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.list --params '{}' --timeout 30000";
  const phase = { id: phaseId, from: "template:sessions", commands: [gateway], checkpoint: ["responses", "timing"] };
  const f = await fixture(t, { phases: [phase], copies: Object.fromEntries(names.map((name, index) => [name, { response: { method: "sessions.list", result: { elapsedMs: "product label" }, elapsedMs: name.startsWith("change") ? index + 10 : 10, durationMs: index + 1 } }])) });
  await writeJSON(join(f.directory, "catalogue.json"), JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url))));
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) {
    const path = join(f.directory, name, "checkpoints", phaseId, "responses.json");
    const response = JSON.parse(await readFile(path)); response[0].result.elapsedMs = "changed product label";
    await writeJSON(path, response);
  }
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.equal(result.rows[0].at, "0/result/elapsedMs");
});

test("search condition measurements preserve outcomes, counts and malformed values", async (t) => {
  const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url)));
  for (const id of ["session-search-overlap", "session-search-completeness"]) {
    const planned = `node {kovaRoot}/support/verify/${id}.mjs --env {env} --session-key fixed --query fixed --gateway-handle {run}/gateway.json --out {run}/condition.json${id === "session-search-completeness" ? " --scope-agent research" : ""}`;
    const phase = { id: phaseId, from: "template:sessions", commands: [planned], checkpoint: ["responses", "timing"] };
    const data = (name) => {
      const duration = name.startsWith("change") ? 11 : 10;
      return id === "session-search-overlap"
        ? { requests: [{ method: "chat.send", status: "completed", startedMs: duration, finishedMs: duration + 1, elapsedMs: duration, timeoutMs: 30000, payload: { elapsedMs: 7 } }], card: { status: "completed", elapsedMs: duration }, searchesAtSave: 8, chat: { status: "completed", persistedReply: true } }
        : { warm: [{ status: "completed", elapsedMs: duration }], trials: [{ status: "completed", elapsedMs: duration, matches: ["result"], payload: { elapsedMs: 7 } }], requestFailures: 0 };
    };
    const f = await fixture(t, { phases: [phase], copies: Object.fromEntries(names.map((name) => [name, { response: data(name) }])) });
    await writeJSON(join(f.directory, "catalogue.json"), catalogue);
    assert.equal((await f.compare()).verdict, "good-to-go", id);
    for (const name of ["change-1", "change-2"]) {
      const value = data(name);
      if (id === "session-search-overlap") {
        value.requests[0].elapsedMs = "invalid";
        value.requests[0].timeoutMs = 40000;
        value.requests[0].payload.elapsedMs = 9;
        value.card.status = "timeout";
        value.chat = { status: "timeout", persistedReply: false };
        value.searchesAtSave = 7;
      } else {
        value.warm[0].elapsedMs = "invalid";
        value.trials[0].status = "timeout";
        value.trials[0].matches = [];
        value.trials[0].payload.elapsedMs = 9;
        value.requestFailures = 1;
      }
      await writeJSON(join(f.directory, name, "checkpoints", phaseId, "responses.json"), { 0: value });
    }
    const changed = await f.compare();
    assert.equal(changed.verdict, "breaks", id);
    const addresses = new Set(changed.rows.filter((row) => row.class === "break" && row.clones.length === 2).map((row) => row.at));
    const expected = id === "session-search-overlap"
      ? ["0/requests/0/elapsedMs", "0/requests/0/timeoutMs", "0/requests/0/payload/elapsedMs", "0/card/status", "0/chat/status", "0/chat/persistedReply", "0/searchesAtSave"]
      : ["0/warm/0/elapsedMs", "0/trials/0/status", "0/trials/0/matches/0", "0/trials/0/payload/elapsedMs", "0/requestFailures"];
    for (const address of expected) assert.ok(addresses.has(address), `${id}: ${address}`);
  }
});

test("digit-only TEXT identities normalize without changing ordinary SQL or JSON numbers", async (t) => {
  const ids = ["baseline-id", "12345678", "9007199254740993", "first-noise-id", "second-noise-id"];
  const f = await fixture(t, { stateIds: [{ path: "files/store.sqlite", table: "records", column: "id", recordKey: "owner" }], state: async (path, name, index) => {
    const db = new DatabaseSync(join(path, "store.sqlite"));
    try {
      db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, owner INTEGER, reference TEXT, ordinary INTEGER, payload TEXT)");
      db.exec("CREATE TABLE fixed (id INTEGER PRIMARY KEY, big INTEGER); CREATE TABLE compound (label TEXT, id INTEGER, PRIMARY KEY (label, id)); CREATE TABLE unkeyed (value TEXT); INSERT INTO fixed VALUES (12345678, 9007199254740993); INSERT INTO fixed VALUES (9007199254740993, 12345678); INSERT INTO compound VALUES ('constant', 12345678); INSERT INTO unkeyed (rowid, value) VALUES (12345678, 'constant')");
      db.prepare("INSERT INTO records VALUES (?, 12345678, ?, 12345678, ?)").run(ids[index], `prefix:${ids[index]}`, JSON.stringify({ count: 12345678, ref: ids[index] }));
    } finally { db.close(); }
  } });
  assert.equal((await f.compare()).verdict, "good-to-go");
  const db = new DatabaseSync(join(f.directory, "change-1/checkpoints", phaseId, "state/files/store.sqlite"));
  try { db.exec("UPDATE records SET ordinary = 87654321"); } finally { db.close(); }
  const result = await f.compare();
  assert.equal(result.verdict, "unresolved");
  assert.equal(result.rows[0].change, 87654321);
  assert.ok(result.rows[0].at.endsWith("/ordinary"));
});

test("selected state requires its recording directory but permits absent product files", async (t) => {
  const f = await fixture(t, { state: async () => {} });
  for (const name of names) await rm(join(f.directory, name, "checkpoints", phaseId, "state/files"), { recursive: true });
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of names) await rm(join(f.directory, name, "checkpoints", phaseId, "state"), { recursive: true });
  await assert.rejects(f.compare(), /missing state checkpoint directory/);
});

test("virtual SQLite declarations and persisted backing data compare without loading modules", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "kova-virtual-state-")); t.after(() => rm(source, { recursive: true, force: true }));
  const make = async (path, changed) => {
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE vectors_chunks (id INTEGER PRIMARY KEY, data BLOB); CREATE VIRTUAL TABLE vectors USING fts5(body)");
      db.prepare("INSERT INTO vectors_chunks VALUES (1, ?)").run(Buffer.from(changed ? [2, 3] : [1, 2]));
    } finally { db.close(); }
    // Keep the SQLite file structurally valid while naming an unavailable module.
    // Equal-length SQL preserves the schema record's encoded size and page layout.
    const bytes = await readFile(path), before = Buffer.from("CREATE VIRTUAL TABLE vectors USING fts5(body)");
    const offset = bytes.indexOf(before);
    assert.ok(offset >= 0); assert.equal(bytes.indexOf(before, offset + 1), -1);
    Buffer.from("CREATE VIRTUAL TABLE vectors USING vec0(body)").copy(bytes, offset);
    await writeFile(path, bytes);
  };
  await make(join(source, "memory.sqlite"), false);
  const f = await fixture(t, { creates: ["/id"], copies: Object.fromEntries(names.map((name) => [name, { response: { id: `generated-${name}` } }])), originalFiles: { "memory.sqlite": await readFile(join(source, "memory.sqlite")) }, state: async (path, name) => make(join(path, "memory.sqlite"), name.startsWith("change")) });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.ok(result.rows.some((row) => row.at === "files/memory.sqlite:vectors_chunks/1/data" && row.class === "break"));
});


test("status measurements are excluded while health outcomes, bounds and settings remain", async (t) => {
  const status = "ocm @{env} -- status --json";
  const phase = { id: phaseId, from: "template:sessions", commands: [status], checkpoint: ["responses", "timing"] };
  const f = await fixture(t, { phases: [phase], copies: Object.fromEntries(names.map((name, index) => {
    const ms = name.startsWith("change") ? index + 11 : 10;
    return [name, { response: { gateway: { connectLatencyMs: name === "baseline" ? null : ms, reachable: true }, eventLoop: { degradedSinceMs: name === "baseline" ? null : ms, degraded: false, reasons: [], intervalMs: ms, delayMaxMs: ms, delayP99Ms: ms, utilization: ms / 100, cpuCoreRatio: ms / 100, cpuBreakdown: { hostUtilization: ms / 100, hostCpuCount: 8 } }, health: { durationMs: ms, eventLoop: { degradedSinceMs: name === "baseline" ? null : ms }, channels: { example: { authAgeMs: name === "baseline" ? null : ms, probe: { elapsedMs: ms, ok: true } } } }, lastHeartbeat: { durationMs: ms }, settings: { connectLatencyMs: 10 } } }];
  })) });
  await writeJSON(join(f.directory, "catalogue.json"), JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url))));
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) {
    const path = join(f.directory, name, "checkpoints", phaseId);
    const response = JSON.parse(await readFile(join(path, "responses.json")));
    response[0].gateway.reachable = false; response[0].settings.connectLatencyMs = 20;
    await writeJSON(join(path, "responses.json"), response);
    await writeJSON(join(path, "timing.json"), [{ reachedBound: true, durationMs: 11 }]);
  }
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows.map((row) => row.at), ["0/gateway/reachable", "0/settings/connectLatencyMs", "0"]);
});

test("non-finite JSON5 and SQLite values remain distinct from null", async (t) => {
  for (const number of ["NaN", "Infinity", "-Infinity"]) {
    const f = await fixture(t, { state: async (path, name) => {
      const changed = name.startsWith("change");
      await writeFile(join(path, "config.json5"), `{ value: ${changed ? number : "null"}, nested: [${changed ? number : "null"}] }`);
      const db = new DatabaseSync(join(path, "data.sqlite"));
      try { db.exec("CREATE TABLE data (id INTEGER PRIMARY KEY, value REAL)"); db.prepare("INSERT INTO data VALUES (1, ?)").run(changed ? Infinity : null); } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks", number);
    assert.deepEqual(result.rows.find((row) => row.at === "files/config.json5/value").change, { number });
    assert.deepEqual(result.rows.find((row) => row.at === "files/config.json5/nested/0").change, { number });
    assert.ok(result.rows.some((row) => row.at.includes("data.sqlite:data/1/value") && row.class === "break"));
    assert.ok(JSON.stringify(result).includes(number));
  }
});

test("command metadata and operation identity reject stale recordings", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, "change-1/checkpoints", phaseId, "commands.json");
  const original = JSON.parse(await readFile(path));
  for (const command of [undefined, null, {}, "", "   ", "node 'unterminated", "ocm @different -- status --json", "node /other/support/different.mjs"]) {
    await writeJSON(path, [{ ...original[0], command }]);
    await assert.rejects(f.compare(), /recorded command/);
  }
  for (const changed of [{ stderr: null }, { timedOut: "false" }, { durationMs: -1 }, { durationMs: null }, { exit: "0" }, { stdout: 1 }]) {
    await writeJSON(path, [{ ...original[0], ...changed }]);
    await assert.rejects(f.compare(), /recorded command metadata/);
  }
  await writeJSON(path, [{ ...original[0], exit: 2 }]);
  assert.equal((await f.compare()).verdict, "unresolved");
});

test("resolved helper, frozen input and environment bindings retain their planned operation", async (t) => {
  const cases = [
    ["node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.list --params '{}' --merge-from {run}/params.json --timeout 30000", "node '/retained source/support/verify/gateway-call.mjs' --env copy --method sessions.list --timeout 30000 --params '{\"limit\":25}'", "node /retained/support/verify/gateway-call.mjs --env copy --method sessions.describe --params '{\"key\":\"agent:main:test\"}' --timeout 30000"],
    ["ocm @{env} -- config patch --file {run}/patch.json --json", "ocm @copied-environment -- config patch --file /retained/.inputs/random.json --json", "ocm @copied-environment -- config get value --json"],
    ["node {kovaRoot}/support/verify/gateway-lifecycle.mjs start --env {env} --handle {run}/gateway.json --timeout 5000", "node /retained/support/verify/gateway-lifecycle.mjs start --env copy --handle /retained/gateway.json --timeout 5000", "node /retained/support/verify/gateway-lifecycle.mjs stop --wait /retained/gateway.json"]
  ];
  const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url)));
  for (const [planned, resolved, different] of cases) {
    const phase = { id: phaseId, from: "template:sessions", commands: [planned], checkpoint: ["responses"] };
    const f = await fixture(t, { phases: [phase] });
    await writeJSON(join(f.directory, "catalogue.json"), catalogue);
    for (const name of names) {
      const path = join(f.directory, name, "checkpoints", phaseId, "commands.json");
      const commands = JSON.parse(await readFile(path)); commands[0].command = resolved;
      await writeJSON(path, commands);
    }
    assert.equal((await f.compare()).verdict, "good-to-go", planned);
    const path = join(f.directory, "change-1/checkpoints", phaseId, "commands.json");
    const commands = JSON.parse(await readFile(path)); commands[0].command = different;
    await writeJSON(path, commands);
    await assert.rejects(f.compare(), /recorded command does not match/, different);
  }
});

test("supported observation durations stay separate from configuration and media metadata", async (t) => {
  const eventLoop = (ms) => ({ degraded: false, reasons: [], intervalMs: ms, delayP99Ms: ms, delayMaxMs: ms, utilization: ms / 100, cpuCoreRatio: ms / 100 });
  const probe = (ms) => ({ authAgeMs: ms, linked: true, probe: { elapsedMs: ms, latencyMs: ms, ok: true }, audit: { elapsedMs: ms, ok: true } });
  const cases = [
    ["status", (ms) => ({ agents: { agents: [{ lastActiveAgeMs: ms, lastUpdatedAt: 100 }] }, sessions: { recent: [{ age: ms, updatedAt: 100 }], byAgent: [{ recent: [{ age: ms, updatedAt: 100 }] }] }, linkChannel: { authAgeMs: ms, linked: true }, health: { sessions: { recent: [{ age: ms, updatedAt: 100 }] }, agents: [{ sessions: { recent: [{ age: ms, updatedAt: 100 }] } }], channels: { example: { ...probe(ms), accounts: { first: probe(ms) } } } } })],
    ["channels-status", (ms) => ({ eventLoop: eventLoop(ms), channels: { example: probe(ms) }, channelAccounts: { example: [probe(ms)] } })],
    ["sessions-list", (ms) => ({ sessions: [{ ageMs: ms, updatedAt: 100, fastAutoOnSeconds: 10 }] })],
    ["gateway-sessions-list", (ms) => ({ result: { sessions: [{ runtimeMs: ms, updatedAt: 100 }] } })],
    ["gateway-sessions-describe", (ms) => ({ result: { session: { runtimeMs: ms, updatedAt: 100 } } })],
    ["gateway-sessions-subscribe", (ms) => ({ result: { list: { sessions: [{ runtimeMs: ms, updatedAt: 100 }] } } })],
    ["gateway-sessions-patch", (ms) => ({ result: { entry: { runtimeMs: ms, updatedAt: 100 } } })],
    ["cron-list", (ms) => ({ jobs: [{ schedule: { everyMs: 1000 }, state: { lastDurationMs: ms, lastStatus: "ok" } }] })]
  ];
  const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url)));
  for (const [id, payload] of cases) {
    const entry = catalogue.entries.find((entry) => entry.id === id);
    const params = ["gateway-sessions-describe", "gateway-sessions-patch"].includes(id) ? '{"key":"agent:main:test"}' : '{}';
    const planned = entry.command.replace("<json>", params).replace("<ms>", "30000");
    const phase = { id: phaseId, from: "template:sessions", commands: [planned], checkpoint: ["responses"] };
    const f = await fixture(t, { phases: [phase], copies: Object.fromEntries(names.map((name, index) => [name, { response: payload(name.startsWith("change") ? index + 11 : 10) }])) });
    await writeJSON(join(f.directory, "catalogue.json"), catalogue);
    assert.equal((await f.compare()).verdict, "good-to-go", id);
    const path = join(f.directory, "change-1/checkpoints", phaseId, "responses.json");
    const response = JSON.parse(await readFile(path)); response[0].unexpectedProductValue = 1;
    await writeJSON(path, response);
    assert.equal((await f.compare()).verdict, "unresolved", id);
  }
  const media = await fixture(t, { copies: both({ response: { attachment: { durationMs: 2000 } } }) });
  const result = await media.compare();
  assert.equal(result.verdict, "breaks");
  assert.ok(result.rows.some((row) => row.at === "0/attachment/durationMs"));
});


test("creation metadata is consistent per pointer and with selected responses", async (t) => {
  const f = await fixture(t, { creates: ["/id"], copies: Object.fromEntries(names.map((name) => [name, { response: { id: `generated-${name}`, title: name.startsWith("change") ? "new" : "old" } }])) });
  assert.equal((await f.compare()).verdict, "breaks");
  const records = [];
  for (const name of names) {
    const path = join(f.directory, name, "checkpoints", phaseId, "commands.json");
    const commands = JSON.parse(await readFile(path)); records.push({ name, path, commands });
    await writeJSON(path, [{ ...commands[0], createdIds: [...commands[0].createdIds, { pointer: "/id", value: name.startsWith("change") ? "new" : "old" }] }]);
  }
  await assert.rejects(f.compare(), /contradictory createdIds/);
  for (const { name, path, commands } of records) await writeJSON(path, [{ ...commands[0], createdIds: [{ pointer: "/id", value: name.startsWith("change") ? "new" : "old" }] }]);
  await assert.rejects(f.compare(), /createdIds do not match/);
  for (const { path, commands } of records) await writeJSON(path, [{ ...commands[0], createdIds: [] }]);
  await assert.rejects(f.compare(), /createdIds do not match/);
  for (const { path, commands } of records) await writeJSON(path, [{ ...commands[0], createdIds: [...commands[0].createdIds, ...commands[0].createdIds] }]);
  assert.equal((await f.compare()).verdict, "breaks");
});

test("encoded SQLite scalars cannot collide with product JSON objects", async (t) => {
  const bytes = Buffer.from([1, 2, 3]);
  const f = await fixture(t, { state: async (path, name) => {
    const db = new DatabaseSync(join(path, "values.sqlite"));
    try {
      db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value)");
      const insert = db.prepare("INSERT INTO records VALUES (?, ?)");
      insert.run(1, name.startsWith("change") ? bytes : JSON.stringify({ sha256: sha256(bytes) }));
      insert.run(2, name.startsWith("change") ? 9007199254740993n : JSON.stringify({ integer: "9007199254740993" }));
    } finally { db.close(); }
  } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.ok(result.rows.some((row) => row.at === "files/values.sqlite:records/1/value" && row.change.sha256));
  assert.ok(result.rows.some((row) => row.at === "files/values.sqlite:records/2/value" && row.change.integer));
});

test("numeric diagnostic log durations preserve shared warnings and meaningful fields", async (t) => {
  for (const style of ["json", "console"]) {
    const log = (ms, overrides = {}) => {
      const fields = { operation: "sessions.list", handlerElapsedMs: ms, elapsedMs: ms, durationMs: ms, admissionWaitMs: ms, completionDelayMs: ms, mutationQueueWaitMs: ms, lifecycleQueueWaitMs: ms, queueWaitMs: ms, writerExecutionMs: ms, nativeMs: ms, serviceMs: ms, admissionMs: ms, nodeInventoryMs: ms, referencePlanningMs: ms, orphanPlanningMs: ms, markerScanMs: ms, prepareSyncMs: ms, rowSyncMs: ms, yieldWaitMs: ms, prepareThreadCpuMs: ms, rowThreadCpuMs: ms, responseThreadCpuMs: ms, phaseDurationsMs: { setup: ms, response: ms }, handlerOutcome: "returned", responseOutcome: "ok", selectedRowCount: 1, timeoutMs: 5000, busyTimeoutMs: 5000, nextWakeAtMs: 123456789, delayMs: 5000, ...overrides };
      return style === "json" ? JSON.stringify({ level: "warn", message: "slow session list", ...fields }) : `WARN slow session list ${Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`;
    };
    const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { logs: log(name.startsWith("change") ? 6000 : 5000) }])) });
    const shared = await f.compare();
    assert.equal(shared.verdict, "good-to-go");
    assert.equal(shared.rows.length, 1); assert.equal(shared.rows[0].class, "not-caused");
    for (const changed of [{ handlerOutcome: "threw" }, { responseOutcome: "error" }, { selectedRowCount: 2 }, { timeoutMs: 6000 }, { busyTimeoutMs: 6000 }, { nextWakeAtMs: 123456790 }, { delayMs: 6000 }, { phaseDurationsMs: { unexpected: 6000 } }]) {
      for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), log(6000, changed));
      assert.equal((await f.compare()).verdict, "breaks");
    }
  }
});

test("SQLite virtual and stored generated columns remain comparable", async (t) => {
  for (const storage of ["VIRTUAL", "STORED"]) {
    const f = await fixture(t, { state: async (path, name) => {
      const db = new DatabaseSync(join(path, "generated.sqlite"));
      try {
        const expression = name.startsWith("change") ? "upper(value)" : "lower(value)";
        db.exec(`CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT, derived TEXT GENERATED ALWAYS AS (${expression}) ${storage})`);
        db.prepare("INSERT INTO records (id, value) VALUES (1, ?)").run("Mixed");
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks");
    assert.deepEqual(result.rows.map(row => [row.at, row.baseline, row.change, row.class]), [["files/generated.sqlite:records/1/derived", "mixed", "MIXED", "break"]]);
  }
});

test("embedded command-queue durations retain shared errors and distinguish changed failures", async (t) => {
  const log = (ms, error = "same failure") => JSON.stringify({ level: "error", message: `lane task error: lane=main durationMs=${ms} error=${JSON.stringify(error)}` });
  const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { logs: log(name.startsWith("change") ? 20 : 10) }])) });
  const shared = await f.compare();
  assert.equal(shared.verdict, "good-to-go"); assert.equal(shared.rows[0].class, "not-caused");
  for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), log(20, "new failure"));
  assert.equal((await f.compare()).verdict, "breaks");
});

test("empty files and empty SQLite databases and tables retain state presence", async (t) => {
  for (const file of ["marker.txt", "events.jsonl", "invalid.json", "empty.sqlite", "table.sqlite"]) for (const added of [false, true]) {
    const f = await fixture(t, { state: async (path, name) => {
      if (name.startsWith("change") !== added) return;
      if (file.endsWith("sqlite")) {
        const db = new DatabaseSync(join(path, file));
        try { db.exec(file === "table.sqlite" ? "CREATE TABLE empty (id INTEGER PRIMARY KEY)" : "VACUUM"); } finally { db.close(); }
      } else await writeFile(join(path, file), "");
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks", `${file}: ${added}`);
    assert.ok(result.rows.some(row => row.at === `files/${file}` && row.class === "break"));
  }
});

test("serialized log strings normalize process ids without hiding runtime or error changes", async (t) => {
  const log = (pid, extra = {}) => JSON.stringify({ level: "warn", message: `native runtime: ${JSON.stringify({ pid, platform: "linux", arch: "x64", node: "24.21.0", ...extra })}` });
  const f = await fixture(t, { copies: Object.fromEntries(names.map((name, index) => [name, { logs: log(41000 + index) }])) });
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), log(50000, { node: "unexpected" }));
  assert.equal((await f.compare()).verdict, "breaks");
});

test("CLI drops low-level chatter with an inventory while retaining explicit warnings", async (t) => {
  const low = [
    'INFO authenticated user connected', 'DEBUG ERROR is message text',
    '[gateway] [INFO] ERROR is message text', '[silent] ERROR is message text', 'unlabelled ERROR message',
    JSON.stringify({ level: "trace", message: "WARN is message text" }),
    JSON.stringify({ time: "2026-10-15T17:45:00Z", level: "info", subsystem: "example", _meta: { logLevelName: "ERROR" }, message: "informational" }),
    JSON.stringify({ 0: { level: "ERROR" }, _meta: { logLevelName: "INFO" } }),
    JSON.stringify({ level: ["error"], message: "unrecognized level type" })
  ];
  const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { logs: name.startsWith("change") ? `${low.join("\n")}\n${low[0]}\n` : "" }])) });
  const cli = () => spawnSync(process.execPath, ["bin/kova.mjs", "verify", "compare", "--run", "sample", "--json"], { cwd: process.cwd(), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8" });
  const first = cli(); assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout), noise = JSON.parse(await readFile(join(f.directory, "noise.json"), "utf8"));
  assert.equal(result.verdict, "good-to-go"); assert.deepEqual(result.rows, []);
  assert.equal(result.noiseExcluded, 0);
  assert.equal(result.dropped[0].logLevel, low.length * 2);
  const dropped = noise.items.filter(item => item.category === "logLevel");
  assert.equal(dropped.length, low.length * 2);
  assert.ok(dropped.every(item => item.signal === "logs" && low.includes(item.before) && item.after.absent && item.reason));
  const high = [
    '2026-10-15T17:45:00Z [gateway] WARN new warning', '[gateway] [ERROR] new error', 'FATAL: new fatal',
    JSON.stringify({ level: "warn", message: "new warning" }),
    JSON.stringify({ 0: { level: "info" }, _meta: { logLevelName: "ERROR" } }),
    JSON.stringify({ level: "error", _meta: { logLevelName: "INFO" }, message: "console error" }),
    JSON.stringify({ level: "error", _meta: { logLevelName: 4 }, message: "fallback error" })
  ];
  for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), `${[...low, ...high].join("\n")}\n`);
  const second = cli(); assert.equal(second.status, 0, second.stderr);
  const warned = JSON.parse(second.stdout);
  assert.equal(warned.verdict, "breaks");
  assert.equal(warned.rows.length, high.length);
  assert.ok(warned.rows.every(row => row.signal === "logs" && row.class === "break"));
});

test("declared identities retain informational log differences including original and escaped IDs", async (t) => {
  for (const source of ["creation", "state", "original"]) {
    const id = name => source === "original" ? "original-log-id" : `generated-${name}`;
    const log = (name, changed) => {
      const encoded = JSON.stringify(id(name)).replace(id(name)[0], `\\u${id(name).charCodeAt(0).toString(16).padStart(4, "0")}`);
      return JSON.stringify({ level: "info", message: `{"id":${encoded},"outcome":"${changed ? "changed" : "same"}"}` });
    };
    const f = await fixture(t, {
      creates: source === "state" ? [] : ["/id"],
      originalFiles: source === "original" ? { "original.json": JSON.stringify({ id: id() }) } : {},
      copies: Object.fromEntries(names.map(name => [name, { response: source === "state" ? {} : { id: id(name) }, logs: log(name, name === "change-1") }])),
      stateIds: source === "state" ? [{ path: "files/declared.sqlite", table: "records", column: "id", recordKey: "key" }] : [],
      state: source === "state" ? async (path, name) => {
        const db = new DatabaseSync(join(path, "declared.sqlite"));
        try { db.exec("CREATE TABLE records (key TEXT PRIMARY KEY, id TEXT)"); db.prepare("INSERT INTO records VALUES ('stable', ?)").run(id(name)); }
        finally { db.close(); }
      } : undefined
    });
    const result = await f.compare();
    const logs = result.rows.filter(row => row.signal === "logs");
    assert.equal(result.verdict, "unresolved", source);
    assert.equal(logs.length, 2, source);
    assert.ok(logs.every(row => row.class === "flaky"), source);
    assert.equal(result.dropped[0].logLevel, 0, source);
    if (source === "original") assert.ok(logs.every(row => row.at.includes("original-log-id")));
    else assert.ok(logs.every(row => row.at.includes("<id:")));
    await writeFile(join(f.directory, "change-2/checkpoints", phaseId, "logs.txt"), log("change-2", true));
    assert.equal((await f.compare()).verdict, "breaks", source);
  }
});

test("log admission recovers intact escaped IDs in prefixed and truncated JSON without joining damaged tokens", async (t) => {
  const declared = "original-id";
  const f = await fixture(t, { creates: ["/id"], originalFiles: { "original.json": JSON.stringify({ id: declared }) }, copies: Object.fromEntries(names.map(name => [name, { response: { id: declared } }])) });
  for (const [label, message, retained, raw] of [
    ["standalone", String.raw`{"id":"\u006friginal-id","outcome":"changed"}`, true],
    ["prefixed", String.raw`result={"id":"\u006friginal-id","outcome":"changed"}`, true],
    ["truncated", String.raw`{"id":"\u006friginal-id","outcome":"changed"`, true],
    ["truncated outer record", String.raw`{"level":"info","id":"\u006friginal-id","outcome":"changed"`, true, true],
    ["bad escape", String.raw`result={"id":"\u006friginal\q-id"}`, false],
    ["split tokens", String.raw`result={"id":["\u006friginal","-id"]}`, false],
    ["unpaired surrogate", String.raw`result={"id":"\u006friginal\ud800-id"}`, false]
  ]) {
    for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), (raw ? message : JSON.stringify({ level: "info", message })) + "\n");
    const result = await f.compare();
    assert.equal(result.verdict, retained ? "breaks" : "good-to-go", label);
    assert.equal(result.rows.length, retained ? 1 : 0, label);
    assert.equal(result.dropped[0].logLevel, retained ? 0 : 2, label);
  }
  const replacementId = "original\uFFFD-id";
  const g = await fixture(t, { creates: ["/id"], originalFiles: { "original.json": JSON.stringify({ id: replacementId }) }, copies: Object.fromEntries(names.map(name => [name, { response: { id: replacementId } }])) });
  for (const [message, retained] of [[String.raw`result={"id":"original\ud800-id"}`, false], [String.raw`result={"id":"original\ufffd-id"}`, true]]) {
    for (const name of ["change-1", "change-2"]) await writeFile(join(g.directory, name, "checkpoints", phaseId, "logs.txt"), JSON.stringify({ level: "info", message }) + "\n");
    assert.equal((await g.compare()).verdict, retained ? "breaks" : "good-to-go");
  }
});

test("escaped generated IDs normalize in prefixed and truncated logs without hiding outcome changes", async (t) => {
  for (const source of ["creation", "state"]) {
    const f = await fixture(t, {
      creates: source === "creation" ? ["/id", "/other"] : ["/other"],
      copies: Object.fromEntries(names.map(name => [name, { response: { id: `generated-${name}`, other: "sessions" } }])),
      stateIds: source === "state" ? [{ path: "files/declared.sqlite", table: "records", column: "id", recordKey: "key" }] : [],
      state: source === "state" ? async (path, name) => {
        const db = new DatabaseSync(join(path, "declared.sqlite"));
        try { db.exec("CREATE TABLE records (key TEXT PRIMARY KEY, id TEXT)"); db.prepare("INSERT INTO records VALUES (?, ?)").run("stable\\key", `generated-${name}`); }
        finally { db.close(); }
      } : undefined
    });
    for (const shape of ["standalone", "prefixed", "truncated", "nested", "mixed", "mixed-spelling"]) {
      const writeLogs = async (changed) => {
        for (const name of names) {
          const id = `generated-${name}`;
          let message = JSON.stringify({ id, outcome: changed && name.startsWith("change") ? "changed" : "same" });
          if (shape !== "mixed-spelling" || name.startsWith("change")) message = message.replace("generated-", String.raw`\u0067enerated-`);
          if (shape !== "standalone") message = `result=${message}`;
          if (shape === "truncated") message = message.slice(0, -1);
          if (shape === "nested") message = `payload=${JSON.stringify(message)}`;
          if (shape === "mixed") message += ` literal=${id}`;
          await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), JSON.stringify({ level: "info", message }) + "\n");
        }
      };
      await writeLogs(false);
      const cli = spawnSync(process.execPath, ["bin/kova.mjs", "verify", "compare", "--run", "sample", "--json"], { cwd: process.cwd(), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
      const result = JSON.parse(cli.stdout);
      assert.equal(result.verdict, "good-to-go", shape);
      assert.equal(result.dropped[0].logLevel, 0, shape);
      const inventory = JSON.parse(await readFile(join(f.directory, "noise.json"), "utf8"));
      assert.ok(inventory.items.some(item => item.signal === "logs" && item.category === "declaredIds"), shape);
      await writeLogs(true);
      const changed = await f.compare();
      assert.equal(changed.verdict, "breaks", shape);
      assert.ok(changed.rows.some(row => row.signal === "logs" && row.class === "break"), shape);
    }
  }
});

test("log identity edits preserve literal overlap, JSON escaping and surrogate distinctions", () => {
  const token = '<id:state#"sessions"/id>';
  const candidates = new Map([["generated-id", token], ["sessions", "<other>"], ['edge","id', "<edge>"], ["emoji-😀", "<emoji>"], ["surrogate-\ud800", "<surrogate>"], ["surrogate-\ufffd", "<replacement>"]]);
  const normalize = normalizeDeclaredIds({ candidates, records: new Map(), allIds: new Set(candidates.keys()) }, new Set()).logText;
  assert.equal(normalize(String.raw`result={"id":"\u0067enerated-id"} literal=generated-id`), `result={"id":${JSON.stringify(token)}} literal=${token}`);
  assert.equal(normalize('result={"id":"generated-id"}'), `result={"id":${JSON.stringify(token)}}`);
  assert.equal(normalize(`payload=${JSON.stringify('result={"id":"generated-id"}')}`), `payload=${JSON.stringify(`result={"id":${JSON.stringify(token)}}`)}`);
  assert.equal(normalize('prefix="edge","id"'), 'prefix="<edge>"');
  assert.equal(normalize(String.raw`result={"id":"\u0067enerated\q-id"}`), String.raw`result={"id":"\u0067enerated\q-id"}`);
  assert.equal(normalize(String.raw`result={"id":"\u0067enerated-id`), String.raw`result={"id":"\u0067enerated-id`);
  assert.equal(normalize(String.raw`result={"id":"emoji-\ud83d\ude00","other":"surrogate-\ud800","replacement":"surrogate-\ufffd"}`), 'result={"id":"<emoji>","other":"<surrogate>","replacement":"<replacement>"}');
  assert.equal(normalize('result={"id":"generated-\ud800id"}'), 'result={"id":"generated-\ud800id"}');
});

test("recorded copy bindings normalize cached and secondary paths without hiding destinations", async (t) => {
  const start = "ocm start {env} --runtime {target} --no-service --json";
  const gateway = "node {kovaRoot}/support/verify/gateway-lifecycle.mjs start --env {env} --handle {run}/gateway.json --timeout 120000";
  const phases = [{ id: "standard/use-target", from: "standard", commands: [start], checkpoint: ["responses", "logs"] }, { id: "standard/start-gateway", from: "standard", commands: [gateway], checkpoint: ["responses", "logs"] }];
  const f = await fixture(t, { phases });
  await writeJSON(join(f.directory, "catalogue.json"), JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url))));
  await writeFile(join(f.directory, ".persona/secondary.ocm-env.tar"), await readFile(join(f.directory, f.run.personaExports[0].path)));
  f.run.personaExports.push({ ...f.run.personaExports[0], path: ".persona/secondary.ocm-env.tar" });
  f.run.targets.change.runtime = "shared-runtime";
  for (const name of names) {
    const env = `kova-run-owned-${name}`;
    f.run.clones[name].env = env;
    f.run.clones[name].cached = !name.startsWith("change");
    const directory = join(f.directory, name), root = `/original-recording/${name}`;
    await rm(join(directory, "checkpoints"), { recursive: true });
    for (const phase of phases) await writeCheckpoint({ phase, directory, collectLogs: async () => [0, 1].map(index => JSON.stringify({ level: "warn", message: `log file: /tmp/ocm/envs/${index ? `${env}-extra` : env}/root/.openclaw/logs/kova-product.log` })).join("\n"), results: [0, 1].map(index => {
      const environment = index ? `${env}-extra` : env, run = index ? `${root}/extra-1` : root;
      return { command: phase.commands[0].replace("{env}", environment).replace("{target}", "shared-runtime").replace("{kovaRoot}", "/source").replace("{run}", run), status: 0, stdout: JSON.stringify({ envName: environment, defaultRuntime: "shared-runtime", root: `/tmp/ocm/envs/${environment}`, ...(phase.id === "standard/start-gateway" ? { handle: `${run}/gateway.json` } : {}) }), stderr: "", durationMs: 1 };
    }) });
  }
  await f.savePlan();
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints/standard/start-gateway/logs.txt"), `WARN log file: /tmp/ocm/envs/${f.run.clones[name].env}/root/.openclaw/logs/wrong.log`);
  assert.equal((await f.compare()).verdict, "breaks");
});

test("removing an empty SQLite table differs even when both database files remain", async (t) => {
  const f = await fixture(t, { state: async (path, name) => {
    const db = new DatabaseSync(join(path, "empty.sqlite"));
    try { db.exec(name.startsWith("change") ? "VACUUM" : "CREATE TABLE removed (id INTEGER PRIMARY KEY)"); } finally { db.close(); }
  } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows.map(row => row.at), ["files/empty.sqlite:removed"]);
});

test("malformed JSONL records do not hide valid escaped persona identities", async (t) => {
  for (const history of [String.raw`{"id":"persona\u002dexisting\u002did"}` + "\n{", "{\n" + String.raw`{"id":"persona\u002dexisting\u002did"}`]) {
    const f = await fixture(t, { creates: ["/id"], originalFiles: { "agents/main/sessions/history.jsonl": history }, copies: Object.fromEntries(names.map(name => [name, { response: { id: name.startsWith("change") ? "persona-existing-id" : `generated-${name}` } }])) });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks"); assert.equal(result.rows[0].change, "persona-existing-id");
  }
});

test("protected numeric TEXT identities retain their exact values with or without record keys", async (t) => {
  const baselineId = "9007199254740992", changeId = "9007199254740993";
  for (const withOwner of [true, false]) {
    const f = await fixture(t, { originalFiles: { "original-ids.json": JSON.stringify([baselineId, changeId]) }, stateIds: [{ path: "files/store.sqlite", table: "records", column: "id", recordKey: "owner" }], state: async (path, name) => {
      const db = new DatabaseSync(join(path, "store.sqlite"));
      try {
        db.exec(`CREATE TABLE records (record_key TEXT PRIMARY KEY, id TEXT${withOwner ? ", owner TEXT" : ""})`);
        db.prepare("INSERT INTO records (record_key, id) VALUES (?, ?)").run("stable", name.startsWith("change") ? changeId : baselineId);
        if (withOwner) db.exec("UPDATE records SET owner = 'same-owner'");
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks"); assert.equal(result.rows[0].baseline, baselineId); assert.equal(result.rows[0].change, changeId);
  }
});

test("JSONL preserves valid records and malformed text as distinct evidence", async (t) => {
  const f = await fixture(t, { state: async (path, name) => writeFile(join(path, "events.jsonl"), name.startsWith("change") ? '{"value":2}\n"broken"\n' : '{"value":1}\nbroken\n') });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.ok(result.rows.some(row => row.at === "files/events.jsonl/0/value" && row.baseline === 1 && row.change === 2));
  assert.ok(result.rows.some(row => row.at === "files/events.jsonl/1" && row.baseline.invalidJSONL === "broken" && row.change === "broken"));
});

test("RSS and CPU observations preserve warning severity and configured bounds", async (t) => {
  for (const reason of ["heap_threshold", "rss_threshold"]) {
    const log = (reading, overrides = {}) => {
      const fields = { level: "warning", reason, rss: `${reading} GiB`, rssBytes: reading * 1073741824, heap: "800 MiB", used: reason === "rss_threshold" ? `${reading} GiB` : "800 MiB", usedBytes: reason === "rss_threshold" ? reading * 1073741824 : 838860800, thresholdRatio: reason === "rss_threshold" ? `${reading * 100}%` : "104.17%", thresholdBytes: 805306368, limitBytes: 1006632960, cpuCoreRatio: reading / 10, eventLoopUtilization: reading / 10, cpuUserMs: reading, cpuSystemMs: reading, cpuTotalMs: reading * 2, eventLoopDelayP99Ms: reading, eventLoopDelayMaxMs: reading, active: 1, ...overrides };
      return JSON.stringify({ level: "warn", message: `memory pressure: ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ")}` });
    };
    const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { logs: log(name.startsWith("change") ? 2 : 1) }])) });
    const shared = await f.compare();
    assert.equal(shared.verdict, "good-to-go"); assert.equal(shared.rows[0].class, "not-caused");
    for (const changed of [{ level: "critical" }, { thresholdBytes: 900000000 }, { limitBytes: 2000000000 }, { active: 2 }]) {
      for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), log(2, changed));
      assert.equal((await f.compare()).verdict, "breaks");
    }
  }
  assert.equal(normalizeText("Gateway event loop: ok max=10ms p99=5ms util=0.2 cpu=0.3"), "Gateway event loop: ok max=<duration> p99=<duration> util=<cpu> cpu=<cpu>");
});

test("native Node warning prefixes normalize without hiding warning codes or messages", async (t) => {
  const warning = (code) => {
    const result = spawnSync(process.execPath, ["-e", `process.emitWarning('same failure', {type:'ExampleWarning',code:${JSON.stringify(code)}})`], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" } });
    assert.equal(result.status, 0); assert.match(result.stderr, /^\(node:\d+\)/); return result.stderr;
  };
  const warnings = Object.fromEntries(names.map(name => [name, warning("KOVA_TEST")]));
  for (const serialized of [false, true]) {
    const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { logs: serialized ? JSON.stringify({ level: "warn", message: warnings[name] }) : warnings[name] }])) });
    const shared = await f.compare();
    assert.equal(shared.verdict, "good-to-go"); assert.equal(shared.rows[0].class, "not-caused");
    for (const name of ["change-1", "change-2"]) {
      const changed = warning("NEW_WARNING");
      await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), serialized ? JSON.stringify({ level: "warn", message: changed }) : changed);
    }
    assert.equal((await f.compare()).verdict, "breaks");
  }
});

test("SQLite primary-key storage types and repeated NULL keys remain distinct", async (t) => {
  for (const mode of ["mixed-types", "nullable-text", "composite-null"]) {
    const f = await fixture(t, { state: async (path, name) => {
      const db = new DatabaseSync(join(path, "keys.sqlite"));
      try {
        const value = name.startsWith("change") ? "new" : "old";
        if (mode === "composite-null") {
          db.exec("CREATE TABLE records (id TEXT, scope TEXT, value TEXT, PRIMARY KEY (id, scope))");
          const insert = db.prepare("INSERT INTO records VALUES (?, 'same', ?)");
          insert.run(null, "first"); insert.run(null, "second"); insert.run("null", value);
        } else {
          db.exec(`CREATE TABLE records (id ${mode === "nullable-text" ? "TEXT" : "BLOB"} PRIMARY KEY, value TEXT)`);
          const insert = db.prepare("INSERT INTO records VALUES (?, ?)");
          if (mode === "nullable-text") { insert.run(null, "first"); insert.run(null, "second"); insert.run("null", value); }
          else { insert.run(1, "integer"); insert.run("1", value); insert.run(Buffer.from("1"), "blob"); insert.run(JSON.stringify({ sha256: sha256(Buffer.from("1")) }), "text hash"); }
        }
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks"); assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].baseline, "old"); assert.equal(result.rows[0].change, "new");
    assert.ok(result.rows[0].at.endsWith("/value"));
  }
});

test("SQLite reserved-prefix filtering retains similarly named application tables", async (t) => {
  for (const table of ["records", "sqlitecache", "sqliteXcache", "SQLitecache"]) {
    const f = await fixture(t, { state: async (path, name) => {
      const db = new DatabaseSync(join(path, "store.sqlite"));
      try {
        db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)`);
        db.prepare(`INSERT INTO ${table} VALUES (1, ?)`).run(name.startsWith("change") ? "new" : "old");
        db.prepare("UPDATE sqlite_sequence SET seq = ?").run(name.startsWith("change") ? 20 : 10);
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks");
    assert.deepEqual(result.rows.map(row => row.at), [`files/store.sqlite:${table}/1/value`]);
  }
});

test("SQLite presence markers never become persona-existing identities", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "kova-source-marker-")); t.after(() => rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "original.db"), db = new DatabaseSync(path);
  try { db.exec("VACUUM"); } finally { db.close(); }
  const bytes = await readFile(path);
  for (const id of ["sqlite", "type"]) for (const existed of [false, true]) {
    assert.equal(bytes.includes(Buffer.from(id)), false);
    const f = await fixture(t, { creates: ["/id"], originalFiles: { "original.db": bytes, ...(existed ? { "content.txt": id } : {}) }, copies: Object.fromEntries(names.map(name => [name, { response: { id: name.startsWith("change") ? id : `generated-${name}` } }])) });
    assert.equal((await f.compare()).verdict, existed ? "breaks" : "good-to-go");
  }
});

test("decoded array positions do not invent existing persona IDs", async (t) => {
  for (const existed of [false, true]) {
    const f = await fixture(t, { creates: ["/id"], originalFiles: { "list.json": JSON.stringify([...Array(8).fill("same"), ...(existed ? ["7"] : [])]) }, copies: Object.fromEntries(names.map(name => [name, { response: { id: name.startsWith("change") ? "7" : `generated-${name}` } }])) });
    assert.equal((await f.compare()).verdict, existed ? "breaks" : "good-to-go");
  }
});

test("embedded IDs in preserved TEXT keys normalize once while prefixes remain meaningful", async (t) => {
  const id = name => name.startsWith("change") ? "generated-after" : "generated-before";
  const f = await fixture(t, { creates: ["/id"], copies: Object.fromEntries(names.map(name => [name, { response: { id: id(name) } }])), state: async (path, name) => {
    const db = new DatabaseSync(join(path, "store.sqlite"));
    try { db.exec("CREATE TABLE records (key TEXT PRIMARY KEY, reference TEXT)"); db.prepare("INSERT INTO records VALUES (?, ?)").run(`session:${id(name)}`, `prefix:${id(name)}`); } finally { db.close(); }
  } });
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) {
    const db = new DatabaseSync(join(f.directory, name, "checkpoints", phaseId, "state/files/store.sqlite"));
    try { db.prepare("UPDATE records SET key = ?").run(`different:${id(name)}`); } finally { db.close(); }
  }
  assert.equal((await f.compare()).verdict, "breaks");
});

test("state ID tokens preserve record-owner value types", async (t) => {
  const f = await fixture(t, { stateIds: [{ path: "files/store.sqlite", table: "records", column: "id", recordKey: "owner" }], state: async (path, name) => {
    const db = new DatabaseSync(join(path, "store.sqlite"));
    try {
      db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, owner BLOB, value TEXT)");
      const insert = db.prepare("INSERT INTO records VALUES (?, ?, ?)");
      for (const [index, owner] of [1, "1", null, "null"].entries()) insert.run(`generated-${name}-${index}`, owner, index === 1 && name.startsWith("change") ? "new" : "old");
    } finally { db.close(); }
  } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks"); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].baseline, "old"); assert.equal(result.rows[0].change, "new");
});

test("unselected state cannot supply IDs or rows that hide response differences", async (t) => {
  for (const selected of [[], ["state:kept"], ["state:files/selected.txt"], ["state:files"]]) {
    const f = await fixture(t, { phases: [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", ...selected] }], stateIds: [{ path: "files/store.sqlite", table: "records", column: "id", recordKey: "owner" }], copies: Object.fromEntries(names.map(name => [name, { response: { title: name.startsWith("change") ? "new-title" : "old-title" } }])) });
    for (const name of names) {
      const path = join(f.directory, name, "checkpoints", phaseId, "state/files"); await mkdir(path, { recursive: true });
      const db = new DatabaseSync(join(path, "store.sqlite"));
      try { db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, owner TEXT)"); db.prepare("INSERT INTO records VALUES (?, ?)").run(name.startsWith("change") ? "new-title" : "old-title", "stable-owner"); }
      finally { db.close(); }
    }
    const result = await f.compare();
    if (selected.includes("state:files")) assert.equal(result.verdict, "good-to-go");
    else {
      assert.equal(result.verdict, "breaks");
      assert.deepEqual(result.rows.map(row => [row.signal, row.at, row.baseline, row.change]), [["responses", "0/title", "old-title", "new-title"]]);
    }
  }
});

test("binary-damaged JSONL retains existing IDs and exact damaged-line evidence", async (t) => {
  const record = Buffer.from(String.raw`{"id":"persona\u002dexisting\u002did"}` + "\n");
  const sameRecord = Buffer.concat([record.subarray(0, record.length - 2), Buffer.from(',"note":"'), Buffer.from([255]), Buffer.from('"}\n')]);
  for (const history of [Buffer.concat([record, Buffer.from([0, 10])]), Buffer.concat([Buffer.from([255, 10]), record]), sameRecord]) {
    const f = await fixture(t, { creates: ["/id"], originalFiles: { "history.jsonl": history }, copies: Object.fromEntries(names.map(name => [name, { response: { id: name.startsWith("change") ? "persona-existing-id" : `generated-${name}` } }])) });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks"); assert.equal(result.rows[0].change, "persona-existing-id");
  }
  const f = await fixture(t, { state: async (path, name) => writeFile(join(path, "events.jsonl"), Buffer.concat([Buffer.from('{"valid":true}\n'), Buffer.from([name.startsWith("change") ? 254 : 255, 10])])) });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks"); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].at, "files/events.jsonl/1");
  assert.equal(result.rows[0].baseline.invalidJSONLBytes, sha256(Buffer.from([255])));
  assert.equal(result.rows[0].change.invalidJSONLBytes, sha256(Buffer.from([254])));
});

test("state ID ordering supports mixed numeric, text, BLOB and NULL values", async (t) => {
  for (const [changedIndex, ordinal] of [[2, "3.2"], [5, "7"]]) {
    const f = await fixture(t, { stateIds: [{ path: "files/store.sqlite", table: "records", column: "id", recordKey: "owner", order: "position" }], state: async (path, name) => {
      const db = new DatabaseSync(join(path, "store.sqlite"));
      try {
        db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, owner TEXT, position BLOB, value TEXT)");
        const insert = db.prepare("INSERT INTO records VALUES (?, 'stable-owner', ?, ?)");
        for (const [index, position] of [9007199254740993n, 1.5, 1.5, "1.5", Buffer.from("z"), Buffer.from("a"), null, null].entries()) insert.run(`generated-${name}-${index}`, position, index === changedIndex && name.startsWith("change") ? "new" : "old");
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks"); assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].change, "new");
    const key = JSON.parse(result.rows[0].at.split("/")[2].replaceAll("~1", "/").replaceAll("~0", "~"));
    assert.ok(key.endsWith(`/id/${ordinal}>`), key);
  }
});

test("invalid JSONL decoding does not invent replacement-character identities", async (t) => {
  for (const history of [Buffer.from([255, 10]), Buffer.from('"�"\n')]) {
    const f = await fixture(t, { creates: ["/id"], originalFiles: { "history.jsonl": history }, copies: Object.fromEntries(names.map(name => [name, { response: { id: name.startsWith("change") ? "�" : `generated-${name}` } }])) });
    assert.equal((await f.compare()).verdict, history[0] === 255 ? "good-to-go" : "breaks");
  }
});

test("retained archives and config backups preserve escaped persona IDs", async (t) => {
  const escaped = String.raw`{"id":"persona\u002dexisting\u002did"}` + "\n";
  const cases = {
    "agents/main/sessions/history.jsonl.reset.2026-10-14T00-00-00.000Z": escaped,
    "agents/main/sessions/history.jsonl.deleted.2026-10-14T00-00-00.000Z": `broken\n${escaped}`,
    "agents/main/sessions/history.jsonl.bak.2026-10-14T00-00-00.000Z": escaped,
    "openclaw.json.bak.1": escaped,
    "openclaw.json.pre-update": String.raw`{ id: 'persona\u002dexisting\u002did', }`,
    "backup/original": `// retained configuration\n${escaped}`,
    "other-format.history": `${escaped}${escaped}`,
  };
  for (const [path, bytes] of Object.entries(cases)) {
    const f = await fixture(t, { creates: ["/id"], originalFiles: { [path]: bytes }, copies: Object.fromEntries(names.map(name => [name, { response: { id: name.startsWith("change") ? "persona-existing-id" : `generated-${name}` } }])) });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks", path); assert.equal(result.rows[0].change, "persona-existing-id");
  }
  const f = await fixture(t, { creates: ["/id"], originalFiles: { "short-backup": String.raw`"\u004fLD"` }, copies: Object.fromEntries(names.map(name => [name, { response: { id: name.startsWith("change") ? "OLD" : `generated-${name}` } }])) });
  assert.equal((await f.compare()).verdict, "breaks");
});

test("SQLite rowid behavior comes from table metadata instead of schema text", async (t) => {
  const f = await fixture(t, { state: async (path, name) => {
    const db = new DatabaseSync(join(path, "metadata.sqlite"));
    try {
      db.exec("CREATE TABLE ordinary (value TEXT DEFAULT 'WITHOUT ROWID'); CREATE TABLE actual (id TEXT PRIMARY KEY, value TEXT) WITHOUT /* retained schema comment */ ROWID");
      db.prepare("INSERT INTO ordinary VALUES (?)").run(name.startsWith("change") ? "new" : "old");
      db.prepare("INSERT INTO actual VALUES ('stable', ?)").run(name.startsWith("change") ? "new" : "old");
    } finally { db.close(); }
  } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks"); assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.baseline === "old" && row.change === "new"));
});

test("persisted execution measurements do not hide outcomes, bounds or user payloads", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents", "state:state", "state:sessions"] };
  const build = (mode) => fixture(t, { phases: [phase], state: async (files, name) => {
    const root = join(files, "..");
    const changed = name.startsWith("change");
    const duration = changed ? 20 : 10;
    const meaningful = mode === "outcome" && changed;
    const session = { sessionId: "existing", runtimeMs: duration, status: meaningful ? "error" : "done", runTimeoutSeconds: meaningful ? 15 : 30, media: { durationMs: meaningful ? 2 : 1 } };
    await mkdir(join(root, "agents/main/agent"), { recursive: true });
    await mkdir(join(root, "agents/main/sessions"), { recursive: true });
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeJSON(join(root, "agents/main/sessions/sessions.json"), { existing: session });
    await writeJSON(join(root, "agents/main/sessions/sessions.json.bak"), { existing: session });
    await writeJSON(join(root, "sessions/sessions.json"), { existing: session });
    const agent = new DatabaseSync(join(root, "agents/main/agent/openclaw-agent.sqlite"));
    try {
      agent.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT)");
      agent.prepare("INSERT INTO session_nodes VALUES (?, ?)").run("existing", JSON.stringify(session));
    } finally { agent.close(); }
    await mkdir(join(root, "state"), { recursive: true });
    const state = new DatabaseSync(join(root, "state/openclaw.sqlite"));
    try {
      const tables = {
        cron_jobs: ["state_json", { lastDurationMs: duration, lastStatus: meaningful ? "error" : "ok" }],
        task_runs: ["detail_json", { kind: "cron-run", durationMs: duration, status: meaningful ? "error" : "ok" }],
        subagent_runs: ["payload_json", { accumulatedRuntimeMs: duration, execution: { outcome: { elapsedMs: duration, status: meaningful ? "error" : "ok" } }, parentCompletion: { accumulatedRuntimeMs: duration, execution: { outcome: { elapsedMs: duration } } }, runTimeoutSeconds: 30 }],
        gateway_restart_sentinel: ["stats_json", { durationMs: duration, steps: [{ durationMs: duration, status: meaningful ? "error" : "ok" }] }]
      };
      for (const [table, [column, value]] of Object.entries(tables)) {
        state.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, runtime TEXT, ${column} TEXT)`);
        state.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run("existing", "cron", JSON.stringify(value));
      }
      state.exec("ALTER TABLE gateway_restart_sentinel ADD COLUMN payload_json TEXT");
      state.prepare("UPDATE gateway_restart_sentinel SET payload_json = ?").run(JSON.stringify({ stats: tables.gateway_restart_sentinel[1] }));
      state.exec("CREATE TABLE cron_run_logs (id TEXT PRIMARY KEY, duration_ms INTEGER, entry_json TEXT)");
      state.prepare("INSERT INTO cron_run_logs VALUES (?, ?, ?)").run("existing", duration, JSON.stringify({ durationMs: duration, status: "ok" }));
      for (const [table, column] of [["audit_events", "duration_ms"], ["outbound_message_progress", "duration_ms"], ["update_runs", "downtime_ms"]]) {
        state.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, ${column} INTEGER, status TEXT)`);
        state.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run("existing", duration, meaningful ? "error" : "ok");
      }
      // A generic audit payload and a different task runtime own their data.
      state.exec("CREATE TABLE diagnostic_events (id TEXT PRIMARY KEY, scope TEXT, payload_json TEXT)");
      state.prepare("INSERT INTO diagnostic_events VALUES (?, ?, ?)").run("existing", "plugin", JSON.stringify({ durationMs: mode === "payload" ? duration : 1 }));
      state.prepare("INSERT INTO task_runs VALUES (?, ?, ?)").run("other", "plugin", JSON.stringify({ durationMs: mode === "payload" ? duration : 1 }));
    } finally { state.close(); }
  } });
  const measured = await (await build("measurements")).compare();
  assert.equal(measured.verdict, "good-to-go");
  assert.deepEqual(measured.rows, []);
  const outcomes = await (await build("outcome")).compare();
  assert.equal(outcomes.verdict, "breaks");
  assert.ok(outcomes.rows.some((row) => row.at.endsWith("/status")));
  assert.ok(outcomes.rows.some((row) => row.at.endsWith("/runTimeoutSeconds")));
  assert.ok(outcomes.rows.some((row) => row.at.endsWith("/media/durationMs")));
  const payload = await (await build("payload")).compare();
  assert.equal(payload.verdict, "breaks");
  assert.equal(payload.rows.filter((row) => row.at.endsWith("/durationMs")).length, 2);
});

test("persisted exec tool measurements stay separate from user and media durations", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents"] };
  for (const mode of ["measurement", "payload", "waiting", "web-result", "status-outcome", "corrupt-length", "corrupt-navigation"]) {
    const f = await fixture(t, { phases: [phase], state: async (files, name) => {
      const root = join(files, "../agents/main");
      await mkdir(join(root, "sessions"), { recursive: true });
      await mkdir(join(root, "agent"), { recursive: true });
      const changed = name.startsWith("change"), duration = changed ? 200 : 10;
      const input = { idleMs: duration, waitingForInput: changed && mode === "waiting", inputWaitIdleMs: 5000 };
      const messages = [
        { type: "message", message: { role: "toolResult", toolName: "exec", details: { durationMs: duration, exitCode: 0 }, content: [{ type: "text", text: "done" }] } },
        { type: "message", message: { role: "user", details: { durationMs: mode === "payload" ? duration : 1 }, content: [{ type: "audio", durationMs: mode === "payload" ? duration : 1 }] } },
        { type: "message", message: { role: "toolResult", toolName: "process", details: { status: "completed", sessions: [{ sessionId: "existing", status: "completed", runtimeMs: duration, ...input }] }, content: [{ type: "text", text: `existing completed ${duration}ms :: echo durationMs=1` }] } }
      ];
      const subagents = { action: "list", status: "ok", active: [], recent: [{ index: 1, label: "task", runtimeMs: duration, runtime: `${duration}ms`, execution: { state: "completed" } }], text: `active subagents:\n(none)\n\nrecent (last 30m):\n1. task (model, ${duration}ms) done` };
      messages.push({ type: "message", message: { role: "toolResult", toolName: "subagents", details: subagents, content: [{ type: "text", text: JSON.stringify(subagents) }] } });
      messages.push({ type: "message", message: { role: "toolResult", toolName: "process", details: { status: "running", sessionId: "existing", ...input }, content: [{ type: "text", text: "same output" }] } });
      const fetch = { url: "https://example.com/", status: changed && mode === "web-result" ? 500 : 200, tookMs: duration, text: "fixed page", length: 10 };
      const search = { kind: "results", tookMs: duration, results: [{ title: "fixed result" }] };
      for (const [toolName, payload] of [["web_fetch", fetch], ["web_search", search], ["web_search", { kind: "raw", data: { tookMs: mode === "web-result" ? duration : 10 } }]])
        messages.push({ type: "message", message: { role: "toolResult", toolName, details: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] } });
      const elapsed = changed ? "3m 20s" : "10s";
      const statusText = [`⏱️ Uptime: gateway ${elapsed} · system ${elapsed}`, `🧵 Session: existing • duration ${elapsed} • updated ${changed ? "2m ago" : "just now"}`, "🤖 Subagents: 1 active", `  • existing task · ${elapsed} · ${changed && mode === "status-outcome" ? "waiting · 2 children pending" : "running · 1 child pending"}`, `🎞️ Media: clip ${changed && mode === "status-outcome" ? "13s" : "12s"}`, "Queue debounce: 5000ms"].join("\n");
      messages.push({ type: "message", message: { role: "toolResult", toolName: "session_status", details: { statusText }, content: [{ type: "text", text: statusText }] } });
      for (const filename of ["existing.jsonl", "existing.jsonl.bak", "existing.jsonl.reset.2026-10-14", "existing.jsonl.deleted.2026-10-14"])
        await writeFile(join(root, "sessions", filename), messages.map((message) => JSON.stringify(message)).join("\n"));
      const db = new DatabaseSync(join(root, "agent/openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE transcript_events (seq INTEGER PRIMARY KEY, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT)");
        for (const [index, event] of messages.entries()) {
          const raw = JSON.stringify(event);
          const model = event.message.role === "toolResult" ? db.prepare("SELECT json_remove(?, '$.message.__openclaw.upstreamUserText', '$.message.details') AS value").get(raw).value : db.prepare("SELECT json_remove(?, '$.message.__openclaw.upstreamUserText') AS value").get(raw).value;
          const navigation = { version: 1, withoutCustomDataBytes: db.prepare("SELECT octet_length(json_remove(?, '$.data')) AS size").get(raw).size, modelBytes: Buffer.byteLength(model), modelWithoutCheckpointBytes: db.prepare("SELECT octet_length(json_remove(?, '$.message.providerReplay')) AS size").get(model).size + (mode === "corrupt-navigation" && changed ? 1 : 0) };
          db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)").run(index, index % 2 === 0 ? raw : null, index % 2 === 1 ? zstdCompressSync(Buffer.from(raw)) : null, Buffer.byteLength(raw) + (mode === "corrupt-length" && changed ? 1 : 0), JSON.stringify(navigation));
        }
      } finally { db.close(); }
    }, compressed: [{ path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_events", column: "event_zstd", codec: "zstd" }] });
    const result = await f.compare();
    assert.equal(result.verdict, mode === "measurement" ? "good-to-go" : "breaks");
    if (mode === "measurement") assert.deepEqual(result.rows, []);
    else if (mode === "payload") {
      assert.ok(result.rows.some((row) => row.at.endsWith("/durationMs")));
      assert.ok(result.rows.every((row) => row.at.includes("/1/")));
    } else if (mode === "waiting") assert.ok(result.rows.some((row) => row.at.endsWith("/waitingForInput")));
    else if (mode === "web-result") {
      assert.ok(result.rows.some((row) => row.at.endsWith("/status")));
      assert.ok(result.rows.some((row) => row.at.endsWith("/data/tookMs")));
    } else if (mode === "status-outcome") assert.ok(result.rows.some((row) => row.at.endsWith("/statusText")));
    else if (mode === "corrupt-navigation") assert.ok(result.rows.every((row) => row.at.endsWith("/navigation_json/modelWithoutCheckpointBytes")));
    else assert.ok(result.rows.some((row) => row.at.endsWith("/event_utf8_bytes")));
  }
});

test("derived measurement hashes retain counts and corruption evidence", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents", "state:state"] };
  for (const mode of ["measurements", "count", "corrupt", "corrupt-anchor", "corrupt-size", "missing-source"]) {
    const f = await fixture(t, { phases: [phase], state: async (files, name) => {
      const root = join(files, "..");
      const changed = name.startsWith("change"), duration = changed ? 200 : 10;
      await mkdir(join(root, "agents/main/agent"), { recursive: true });
      const db = new DatabaseSync(join(root, "agents/main/agent/openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE cache_entries (scope TEXT, key TEXT, value_json TEXT, blob BLOB, PRIMARY KEY(scope, key))");
        const rollup = { buckets: { "0": { timestampMs: 1, latency: { count: mode === "count" && changed ? 2 : 1, min: duration, max: duration, sum: duration, centroids: [{ count: 1, value: duration }] }, messageCounts: { total: 1 } } }, untimestamped: {} };
        const json = JSON.stringify(rollup), raw = Buffer.from(json), blob = zstdCompressSync(raw);
        const event = JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "exec", details: { durationMs: duration, exitCode: 0 }, content: [{ type: "text", text: "done" }] } });
        if (mode !== "missing-source") {
          db.exec("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_utf8_bytes INTEGER, PRIMARY KEY(session_id,seq))");
          db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run("existing", 1, event, Buffer.byteLength(event));
        }
        const anchor = mode === "corrupt-anchor" && changed ? "invalid-anchor" : Buffer.from(sha256(event), "hex").toString("base64url");
        const envelope = { version: 6, format: 1, pricingFingerprint: "sample", checkpoint: { kind: "sqlite", maxSeq: 1, eventCount: 1, size: Buffer.byteLength(event) + (mode === "corrupt-size" && changed ? 1 : 0), mtimeMs: 1, anchorHash: anchor }, scannedAt: 1, parsedRecords: 1, countedRecords: 1, body: { encoding: "zstd", bytes: raw.length, storedBytes: blob.length, utf16Length: json.length, sha256: mode === "corrupt" && changed ? "0".repeat(64) : sha256(raw) } };
        db.prepare("INSERT INTO cache_entries VALUES (?, ?, ?, ?)").run("session-cost-usage-rollup-v3", "sqlite:main:existing:/recorded/.openclaw/agents/main/agent/openclaw-agent.sqlite", JSON.stringify(envelope), blob);
        db.prepare("INSERT INTO cache_entries VALUES (?, ?, ?, ?)").run("session-cost-usage-rollup-v2", "existing", JSON.stringify({ rollup }), null);
      } finally { db.close(); }
      await mkdir(join(root, "state"), { recursive: true });
      const state = new DatabaseSync(join(root, "state/openclaw.sqlite"));
      try {
        state.exec("CREATE TABLE diagnostic_events (scope TEXT, event_key TEXT, payload_json TEXT, PRIMARY KEY(scope, event_key))");
        const entry = { sourceIndex: 0, reason: "invalid", job: null, raw: null, state: { lastDurationMs: duration, lastStatus: "ok" }, updatedAtMs: null, scheduleIdentity: null };
        const key = mode === "corrupt" && changed ? "0".repeat(64) : sha256(JSON.stringify(entry));
        state.prepare("INSERT INTO diagnostic_events VALUES (?, ?, ?)").run("cron.quarantine:existing", key, JSON.stringify({ ...entry, quarantinedAtMs: 1 }));
      } finally { state.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, mode === "measurements" ? "good-to-go" : "breaks");
    if (mode === "count") assert.ok(result.rows.some((row) => row.at.endsWith("/latency/count")));
    if (mode === "corrupt") assert.ok(result.rows.some((row) => row.at.includes("diagnostic_events")));
    if (["corrupt-anchor", "missing-source"].includes(mode)) assert.ok(result.rows.some((row) => row.at.endsWith("/checkpoint/anchorHash")));
    if (mode === "corrupt-size") assert.ok(result.rows.some((row) => row.at.endsWith("/checkpoint/size")));
  }
});


test("malformed response measurements remain comparable", async (t) => {
  const phase = { id: phaseId, from: "template:sessions", commands: ["ocm @{env} -- status --json"], checkpoint: ["responses"] };
  for (const latency of [20, "broken", { error: "invalid measurement" }, null, false, []]) {
    const f = await fixture(t, { phases: [phase], copies: Object.fromEntries(names.map((name) => [name, { response: { gateway: { reachable: true, connectLatencyMs: name.startsWith("change") ? latency : 10 } } }])) });
    await writeJSON(join(f.directory, "catalogue.json"), JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url))));
    const result = await f.compare();
    assert.equal(result.verdict, typeof latency === "number" || latency === null ? "good-to-go" : "breaks");
    if (typeof latency !== "number" && latency !== null) assert.ok(result.rows.some((row) => row.at === "0/gateway/connectLatencyMs"));
  }
});

test("JSONL cache anchors use selected transcript bytes and preserve inconsistent references", async (t) => {
  for (const mode of ["measurements", "corrupt-anchor", "content", "unselected"]) {
    const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents/main/agent", ...(mode === "unselected" ? [] : ["state:agents/main/sessions"])] };
    const f = await fixture(t, { phases: [phase], state: async (files, name) => {
      const root = join(files, "../agents/main"), changed = name.startsWith("change");
      await mkdir(join(root, "agent"), { recursive: true });
      await mkdir(join(root, "sessions"), { recursive: true });
      const event = { type: "message", message: { role: "toolResult", toolName: "exec", content: [{ type: "text", text: "𝌆".repeat(1200) + (mode === "content" && changed ? " changed" : "") }], details: { durationMs: changed ? 200 : 10, exitCode: 0 } } };
      const transcript = Buffer.from(`${JSON.stringify(event)}\n`);
      await writeFile(join(root, "sessions/existing.jsonl"), transcript);
      const blob = Buffer.from(JSON.stringify({ buckets: {}, untimestamped: {} }));
      const anchorHash = mode === "corrupt-anchor" && changed ? "invalid-anchor" : Buffer.from(sha256(transcript.subarray(Math.max(0, transcript.length - 4096))), "hex").toString("base64url");
      const envelope = { version: 6, format: 1, pricingFingerprint: "sample", checkpoint: { kind: "jsonl", parsedOffset: transcript.length, observedSize: transcript.length, observedMtimeMs: 1, device: 1, inode: 1, anchorHash }, scannedAt: 1, parsedRecords: 1, countedRecords: 1, body: { encoding: "identity", bytes: blob.length, storedBytes: blob.length, utf16Length: blob.toString().length, sha256: sha256(blob) } };
      const db = new DatabaseSync(join(root, "agent/openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE cache_entries (scope TEXT,key TEXT,value_json TEXT,blob BLOB,PRIMARY KEY(scope,key))");
        db.prepare("INSERT INTO cache_entries VALUES (?,?,?,?)").run("session-cost-usage-rollup-v3", "/recorded/.openclaw/agents/main/sessions/existing.jsonl", JSON.stringify(envelope), blob);
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, mode === "measurements" ? "good-to-go" : "breaks");
    if (["corrupt-anchor", "unselected"].includes(mode)) assert.ok(result.rows.some((row) => row.at.endsWith("/checkpoint/anchorHash")));
    if (mode === "content") assert.ok(result.rows.some((row) => row.at.endsWith("/message/content/0/text")));
  }
});

test("validated metadata cannot collide with inconsistent values or aggregate shapes", async (t) => {
  for (const mode of ["control", "valid-no-duration", "length-collision", "navigation-collision", "cache-collision", "centroid-loss", "centroid-shape", "centroid-sum", "centroid-zero-sum", "centroid-min", "centroid-max", "merged-min", "merged-max", "merged-valid", "fractional-valid", "cache-shape", "marker-shape", "cache-bom"]) {
    const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents"] };
    const f = await fixture(t, { phases: [phase], state: async (files, name) => {
      const directory = join(files, "../agents/main/agent"), changed = name.startsWith("change");
      await mkdir(directory, { recursive: true });
      const db = new DatabaseSync(join(directory, "openclaw-agent.sqlite"));
      try {
        const event = { type: "message", message: { role: "toolResult", toolName: "exec", details: { durationMs: 10, exitCode: 0 }, content: [{ type: "text", text: "done" }] } };
        const normalized = structuredClone(event); delete normalized.message.details.durationMs;
        const raw = JSON.stringify(mode === "valid-no-duration" && !changed ? normalized : event), next = JSON.stringify(normalized);
        const actual = Buffer.byteLength(raw), normalizedLength = Buffer.byteLength(next);
        db.exec("CREATE TABLE transcript_events (session_id TEXT,seq INTEGER,event_json TEXT,event_utf8_bytes,navigation_json TEXT,PRIMARY KEY(session_id,seq))");
        const projection = (text) => db.prepare("SELECT octet_length(json_remove(?, '$.data')) AS size").get(text).size;
        const length = changed && mode === "length-collision" ? normalizedLength : changed && mode === "marker-shape" ? JSON.stringify({ verifiedDerived: normalizedLength }) : actual;
        const navigation = { version: 1, withoutCustomDataBytes: projection(changed && mode === "navigation-collision" ? next : raw) };
        db.prepare("INSERT INTO transcript_events VALUES (?,1,?,?,?)").run("existing", raw, length, JSON.stringify(navigation));
        if (["cache-collision", "centroid-loss", "centroid-shape", "centroid-sum", "centroid-zero-sum", "centroid-min", "centroid-max", "merged-min", "merged-max", "merged-valid", "fractional-valid", "cache-shape", "cache-bom"].includes(mode)) {
          db.exec("CREATE TABLE cache_entries (scope TEXT,key TEXT,value_json TEXT,blob BLOB,PRIMARY KEY(scope,key))");
          let latency = changed && ["centroid-shape", "cache-shape"].includes(mode) ? { count: 1 } : { count: 1, min: 10, max: 10, sum: changed && mode === "centroid-sum" ? 20 : changed && mode === "centroid-zero-sum" ? 0 : 10, centroids: changed && mode === "centroid-loss" ? [] : [{ count: 1, value: 10 }] };
          if (mode === "centroid-min" && changed) latency.min = 0;
          if (mode === "centroid-max" && changed) latency.max = 100;
          if (mode.startsWith("merged-")) {
            const value = changed && mode === "merged-valid" ? 20 : 10;
            latency = { count: 65, min: changed && mode === "merged-min" ? 0 : value, max: changed && mode === "merged-max" ? 100 : value, sum: value * 65, centroids: [{ count: 2, value }, ...Array.from({ length: 63 }, () => ({ count: 1, value }))] };
          }
          if (mode === "fractional-valid") {
            const scale = changed ? 2 : 1;
            latency = { count: 7, min: 0.1 * scale, max: 0.3 * scale, sum: (0.1 + 0.2 + 0.3 + 0.1 + 0.2 + 0.3 + 0.1) * scale, centroids: [{ count: 3, value: (0.1 + 0.2 + 0.3) / 3 * scale }, { count: 4, value: (0.1 + 0.2 + 0.3 + 0.1) / 4 * scale }] };
          }
          const rollup = { buckets: { "0": { latency } }, untimestamped: {} }, text = JSON.stringify(rollup);
          const bytes = Buffer.concat([changed && mode === "cache-bom" ? Buffer.from([239, 187, 191]) : Buffer.alloc(0), Buffer.from(text)]);
          const wrong = changed && mode === "cache-collision";
          const envelope = { version: 6, format: 1, pricingFingerprint: "sample", checkpoint: { kind: "sqlite", maxSeq: 1, eventCount: 1, size: wrong ? normalizedLength : actual, mtimeMs: 1, anchorHash: Buffer.from(sha256(wrong ? canonicalJSON(normalized) : raw), "hex").toString("base64url") }, scannedAt: 1, parsedRecords: 1, countedRecords: 1, body: changed && mode === "cache-shape" ? { encoding: "decoded-json" } : { encoding: "identity", bytes: bytes.length, storedBytes: bytes.length, utf16Length: text.length, sha256: sha256(bytes) } };
          db.prepare("INSERT INTO cache_entries VALUES (?,?,?,?)").run("session-cost-usage-rollup-v3", "sqlite:main:existing:/recorded/.openclaw/agents/main/agent/openclaw-agent.sqlite", JSON.stringify(envelope), changed && mode === "cache-shape" ? text : bytes);
          if (["centroid-sum", "centroid-zero-sum", "centroid-min", "centroid-max", "merged-min", "merged-max", "merged-valid", "fractional-valid"].includes(mode)) db.prepare("INSERT INTO cache_entries VALUES (?,?,?,NULL)").run("session-cost-usage-rollup-v2", "existing", JSON.stringify({ rollup }));
        }
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, ["control", "valid-no-duration", "fractional-valid", "merged-valid"].includes(mode) ? "good-to-go" : "breaks", mode);
    if (["centroid-sum", "centroid-zero-sum", "centroid-min", "centroid-max", "merged-min", "merged-max"].includes(mode)) assert.ok(result.rows.some((row) => row.at.includes("session-cost-usage-rollup-v2")));
  }
});

test("compressed and plain state preserve BOM and malformed UTF-8 evidence", async (t) => {
  for (const mode of ["control", "bom", "invalid-utf8", "text-storage", "numeric-storage"]) {
    const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents"] };
    const f = await fixture(t, { phases: [phase], compressed: [{ path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_events", column: "event_zstd", codec: "zstd" }], state: async (files, name) => {
      const directory = join(files, "../agents/main/agent"); await mkdir(directory, { recursive: true });
      const raw = Buffer.from(JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "exec", details: { exitCode: 0 }, content: [{ type: "text", text: "done" }] } }));
      const extra = name.startsWith("change") && mode === "bom" ? Buffer.from([239, 187, 191]) : name.startsWith("change") && mode === "invalid-utf8" ? Buffer.from([255]) : Buffer.alloc(0);
      await writeFile(join(directory, "output.txt"), Buffer.concat([extra, Buffer.from("same text")]));
      const db = new DatabaseSync(join(directory, "openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE transcript_events (seq INTEGER PRIMARY KEY,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER)");
        db.prepare("INSERT INTO transcript_events VALUES (1,NULL,?,?)").run(name.startsWith("change") && mode === "text-storage" ? raw.toString() : name.startsWith("change") && mode === "numeric-storage" ? 1 : zstdCompressSync(Buffer.concat([extra, raw])), raw.length);
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, mode === "control" ? "good-to-go" : "breaks");
    if (mode !== "control") {
      assert.ok(result.rows.some((row) => row.at.includes("/event_zstd")));
      if (["bom", "invalid-utf8"].includes(mode)) assert.ok(result.rows.some((row) => row.at.includes("/output.txt")));
    }
  }
});

test("verified transcript metadata follows declared IDs and parsed JSON semantics", async (t) => {
  for (const mode of ["control", "id-only", "reordered", "changed-exit", "corrupt-length"]) {
    const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "state:agents", "state:state"] };
    const idFor = (name) => mode !== "control" && name.startsWith("change") ? "generated-after-with-a-longer-spelling" : "generated-before";
    const f = await fixture(t, { phases: [phase], creates: ["/id"], copies: Object.fromEntries(names.map((name) => [name, { response: { id: idFor(name) } }])), state: async (files, name) => {
      const root = join(files, "../agents/main"), changed = name.startsWith("change");
      await mkdir(join(root, "agent"), { recursive: true }); await mkdir(join(root, "sessions"), { recursive: true });
      const event = { type: "message", id: idFor(name), message: { role: "toolResult", toolName: "exec", details: { durationMs: 10, exitCode: mode === "changed-exit" && changed ? 1 : 0 }, content: [{ type: "text", text: "done" }] } };
      const raw = JSON.stringify(mode === "reordered" && changed ? { message: event.message, id: event.id, type: event.type } : event);
      const jsonl = Buffer.from(`${raw}\n`); await writeFile(join(root, "sessions/existing.jsonl"), jsonl);
      const db = new DatabaseSync(join(root, "agent/openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_utf8_bytes INTEGER,navigation_json TEXT,PRIMARY KEY(session_id,seq));CREATE TABLE cache_entries(scope TEXT,key TEXT,value_json TEXT,blob BLOB,PRIMARY KEY(scope,key))");
        const navigation = { version: 1, withoutCustomDataBytes: db.prepare("SELECT octet_length(json_remove(?, '$.data')) AS size").get(raw).size };
        db.prepare("INSERT INTO transcript_events VALUES (?,1,?,?,?)").run("existing", raw, Buffer.byteLength(raw) + (mode === "corrupt-length" && changed ? 1 : 0), JSON.stringify(navigation));
        const blob = Buffer.from(JSON.stringify({ buckets: {}, untimestamped: {} }));
        for (const kind of ["sqlite", "jsonl"]) {
          const checkpoint = kind === "sqlite" ? { kind, maxSeq: 1, eventCount: 1, size: Buffer.byteLength(raw), mtimeMs: 1, anchorHash: Buffer.from(sha256(raw), "hex").toString("base64url") } : { kind, parsedOffset: jsonl.length, observedSize: jsonl.length, observedMtimeMs: 1, device: 1, inode: 1, anchorHash: Buffer.from(sha256(jsonl), "hex").toString("base64url") };
          const envelope = { version: 6, format: 1, pricingFingerprint: "sample", checkpoint, scannedAt: 1, parsedRecords: 1, countedRecords: 1, body: { encoding: "identity", bytes: blob.length, storedBytes: blob.length, utf16Length: blob.toString().length, sha256: sha256(blob) } };
          const key = kind === "sqlite" ? "sqlite:main:existing:/recorded/.openclaw/agents/main/agent/openclaw-agent.sqlite" : "/recorded/.openclaw/agents/main/sessions/existing.jsonl";
          db.prepare("INSERT INTO cache_entries VALUES (?,?,?,?)").run("session-cost-usage-rollup-v3", key, JSON.stringify(envelope), blob);
        }
      } finally { db.close(); }
      const stateDirectory = join(files, "../state"); await mkdir(stateDirectory, { recursive: true });
      const state = new DatabaseSync(join(stateDirectory, "openclaw.sqlite"));
      try {
        state.exec("CREATE TABLE diagnostic_events(scope TEXT,event_key TEXT,payload_json TEXT,PRIMARY KEY(scope,event_key))");
        const entry = { sourceIndex: 0, reason: "invalid", job: { id: idFor(name) }, raw: null, state: { lastDurationMs: 10, lastStatus: "ok" }, updatedAtMs: null, scheduleIdentity: null };
        state.prepare("INSERT INTO diagnostic_events VALUES (?,?,?)").run("cron.quarantine:existing", sha256(JSON.stringify(entry)), JSON.stringify({ ...entry, quarantinedAtMs: 1 }));
      } finally { state.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, ["changed-exit", "corrupt-length"].includes(mode) ? "breaks" : "good-to-go", mode);
    if (mode === "changed-exit") assert.ok(result.rows.some((row) => row.at.endsWith("/exitCode")));
    if (mode === "corrupt-length") assert.ok(result.rows.some((row) => row.at.endsWith("/event_utf8_bytes")));
  }
});

test("native compressed transcript decoder bounds survive duration normalization", async (t) => {
  const limit = 4 * 1024 * 1024;
  for (const mode of ["within-bound", "crosses-bound", "oversized-frame"]) {
    const phase = { id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents"] };
    const f = await fixture(t, { phases: [phase], compressed: [{ path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_events", column: "event_zstd", codec: "zstd" }], state: async (files, name) => {
      const directory = join(files, "../agents/main/agent"); await mkdir(directory, { recursive: true });
      let padding = 0;
      const event = (durationMs) => ({ type: "message", message: { role: "toolResult", toolName: "exec", details: { durationMs, exitCode: 0 }, content: [{ type: "text", text: "x".repeat(padding) }] } });
      if (mode !== "oversized-frame") padding = limit - (mode === "within-bound" ? 1 : 0) - Buffer.byteLength(JSON.stringify(event(10)));
      const changed = name.startsWith("change"), raw = Buffer.from(JSON.stringify(event(changed ? 200 : 10)));
      let compressed = zstdCompressSync(raw);
      if (mode === "oversized-frame" && changed) compressed = Buffer.concat([compressed, Buffer.alloc(limit + 1 - compressed.length)]);
      const db = new DatabaseSync(join(directory, "openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE transcript_events (seq INTEGER PRIMARY KEY,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER) STRICT");
        db.prepare("INSERT INTO transcript_events VALUES (1,NULL,?,?)").run(compressed, raw.length);
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, mode === "within-bound" ? "good-to-go" : "breaks", mode);
    if (mode !== "within-bound") assert.ok(result.rows.some((row) => row.at.endsWith("/event_zstd") && row.class === "break"));
  }
});

// Captured from prepareTranscriptPayload at OpenClaw 7e80556f. The payload
// changes storage at 1,166/1,167 bytes when only its execution duration changes.
const nativeStorageNavigation = {
  "version": 1,
  "report": {
    "kind": "canonical",
    "hasParentId": true,
    "entry": {
      "id": "existing-event",
      "parentId": null,
      "timestamp": "2026-10-14T00:00:00.000Z",
      "type": "message"
    }
  },
  "navigation": {
    "type": "message",
    "id": "existing-event",
    "parentId": null,
    "timestamp": "2026-10-14T00:00:00.000Z",
    "message": {
      "role": "toolResult"
    }
  },
  "reset": {
    "type": "message",
    "id": "existing-event",
    "parentId": null,
    "timestamp": "2026-10-14T00:00:00.000Z",
    "message": {
      "role": "toolResult"
    }
  },
  "model": {
    "type": "message",
    "id": "existing-event",
    "parentId": null,
    "timestamp": "2026-10-14T00:00:00.000Z",
    "message": {
      "role": "toolResult",
      "toolCallId": "existing-call",
      "toolName": "exec",
      "isError": false,
      "content": [],
      "command": "",
      "output": "",
      "providerReplay": {
        "type": null
      },
      "details": {
        "openclawSyntheticMissingToolResult": false
      }
    }
  },
  "modelBytes": 1125,
  "modelWithoutCheckpointBytes": 1125,
  "withoutCustomDataBytes": 1167
};

for (const mode of ["duration", "exit", "report", "model", "version", "extra", "cost", "duplicate"]) {
  test(`native transcript storage transition preserves ${mode === "duration" ? "duration exclusion" : mode + " evidence"}`, async (t) => {
    const f = await fixture(t, {
      phases: [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents"] }],
      compressed: [{ path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_events", column: "event_zstd", codec: "zstd" }],
      state: async (files, name) => {
        const changed = name.startsWith("change");
        const event = { type: "message", id: "existing-event", parentId: null, timestamp: "2026-10-14T00:00:00.000Z", message: { role: "toolResult", toolCallId: "existing-call", toolName: "exec", isError: false, details: { durationMs: changed ? 200 : 10, exitCode: changed && mode === "exit" ? 1 : 0 }, content: [{ type: "text", text: "x".repeat(897) }] } };
        const raw = JSON.stringify(event), navigation = structuredClone(nativeStorageNavigation);
        if (mode === "report") navigation.report.entry.id = "wrong-event";
        if (mode === "model") navigation.model.message.isError = true;
        if (mode === "version") navigation.version = 2;
        if (mode === "extra") navigation.unrecognized = "retain";
        if (mode === "cost") navigation.modelBytes += 1;
        const directory = join(files, "../agents/main/agent");
        await mkdir(directory, { recursive: true });
        const db = new DatabaseSync(join(directory, "openclaw-agent.sqlite"));
        try {
          db.exec("CREATE TABLE transcript_events(seq INTEGER PRIMARY KEY,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER,navigation_json TEXT) STRICT");
          db.prepare("INSERT INTO transcript_events VALUES (1,?,?,?,?)").run(changed ? null : raw, changed ? zstdCompressSync(Buffer.from(raw)) : null, Buffer.byteLength(raw), changed ? (mode === "duplicate" ? JSON.stringify(navigation).replace('{"version":1', '{"version":2,"version":1') : JSON.stringify(navigation)) : null);
        } finally { db.close(); }
      }
    });
    const result = await f.compare();
    assert.equal(result.verdict, mode === "duration" ? "good-to-go" : "breaks");
    if (mode === "exit") assert.ok(result.rows.some((row) => row.at.endsWith("/event_json/message/details/exitCode") && row.class === "break"));
    if (["report", "model", "version", "extra", "cost", "duplicate"].includes(mode)) assert.ok(result.rows.some((row) => row.at.includes("/navigation_json")));
  });
}

const nativeCustomNavigation = {
  "version": 1,
  "report": {
    "kind": "canonical",
    "hasParentId": true,
    "entry": {
      "id": "existing-event",
      "parentId": null,
      "type": "custom"
    }
  },
  "navigation": {
    "type": "custom",
    "id": "existing-event",
    "parentId": null,
    "customType": "custom-value"
  },
  "reset": {
    "type": "custom",
    "id": "existing-event",
    "parentId": null,
    "customType": "custom-value",
    "message": {
      "role": null
    }
  },
  "model": {
    "type": "custom",
    "id": "existing-event",
    "parentId": null,
    "customType": "custom-value"
  },
  "modelBytes": 2185,
  "modelWithoutCheckpointBytes": 2185,
  "withoutCustomDataBytes": 2164
};

for (const storage of ["json", "zstd", "mixed-null"]) for (const mode of ["control", "first", "count", "array", "integer", "duration"]) {
  test(`native ${storage} transcript repeated members preserve ${mode}`, async (t) => {
    const f = await fixture(t, {
      phases: [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["state:agents"] }],
      compressed: [{ path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_events", column: "event_zstd", codec: "zstd" }],
      state: async (files, name) => {
        const changed = name.startsWith("change");
        let raw;
        if (mode === "duration") raw = JSON.stringify({ type: "message", id: "existing-event", parentId: null, timestamp: "2026-10-14T00:00:00.000Z", message: { role: "toolResult", toolCallId: "existing-call", toolName: "exec", isError: false, details: { durationMs: changed ? 200 : 10, exitCode: 0 }, content: [{ type: "text", text: "x".repeat(897) }] } });
        else raw = JSON.stringify({ type: "custom", id: "existing-event", parentId: null, customType: "custom-value", padding: "x".repeat(2048) });
        const first = mode === "first" && changed ? "other" : "first";
        const data = mode === "count" && changed ? ',"data":{"v":"last"}' : mode === "array" && changed ? ',"data":[{"v":"first"},{"v":"last"}]' : ',"data":{"v":"'+first+'"},"data":{"v":"last"}';
        raw = raw.slice(0, -1) + data + "}";
        if (mode === "integer") raw = raw.replace('"v":"first"', '"v":' + (changed ? "9007199254740993" : "9007199254740992"));
        const directory = join(files, "../agents/main/agent"); await mkdir(directory, { recursive: true });
        const db = new DatabaseSync(join(directory, "openclaw-agent.sqlite"));
        try {
          const navigation = structuredClone(mode === "duration" ? nativeStorageNavigation : nativeCustomNavigation);
          const projected = mode === "duration" ? db.prepare("SELECT json_remove(?, '$.message.details') AS value").get(raw).value : raw;
          navigation.modelBytes = Buffer.byteLength(projected);
          navigation.modelWithoutCheckpointBytes = Buffer.byteLength(projected);
          navigation.withoutCustomDataBytes = db.prepare("SELECT octet_length(json_remove(?, '$.data')) AS size").get(raw).size;
          db.exec("CREATE TABLE transcript_events(seq INTEGER PRIMARY KEY,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER,navigation_json TEXT) STRICT");
          const packed = storage === "zstd" || storage === "mixed-null" && !changed;
          db.prepare("INSERT INTO transcript_events VALUES (1,?,?,?,?)").run(packed ? null : raw, packed ? zstdCompressSync(Buffer.from(raw)) : null, storage === "mixed-null" && changed ? null : Buffer.byteLength(raw), packed ? JSON.stringify(navigation) : null);
        } finally { db.close(); }
      }
    });
    const result = await f.compare();
    assert.equal(result.verdict, ["control", "duration"].includes(mode) ? "good-to-go" : "breaks");
    if (["first", "count", "array", "integer"].includes(mode)) assert.ok(result.rows.some((row) => row.at.includes("/event_json/data") && row.class === "break"));
  });
}

test("complete source IDs include escaped earlier transcript members", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-compare-duplicate-ids-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "source.sqlite"), db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE transcript_events(event_json TEXT)");
    db.prepare("INSERT INTO transcript_events VALUES (?)").run('{"id":"\\u0065xisting-duplicate-id","id":"last-id"}');
  } finally { db.close(); }
  const sources = await exportFixture(directory, { "agents/main/agent/openclaw-agent.sqlite": await readFile(path) });
  const found = await personaExistingIds(directory, sources, new Set(["existing-duplicate-id"]), { stateIds: [], compressed: [] });
  assert.deepEqual(found, new Set(["existing-duplicate-id"]));
});

test("comparison settles decoded source cleanup before signal exit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-compare-interrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, { creates: ["/id"], originalFiles: { "source.json": JSON.stringify({ padding: "x".repeat(8192) }) }, copies: Object.fromEntries(names.map((name) => [name, { response: { id: `generated-${name}` } }])) });
  const child = String.raw`
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.promises.open;
    let injected = false;
    fs.promises.open = async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith("/contents")) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...values) => {
          const result = await write(...values);
          if (!injected && process.env.KOVA_INTERRUPT_SIGNAL !== "control") {
            injected = true;
            fs.writeSync(1, "scratch-written\n");
            process.kill(process.pid, process.env.KOVA_INTERRUPT_SIGNAL);
          }
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { main } = await import("./src/main.mjs");
    await main(["verify", "compare", "--run", "sample", "--json"]);
  `;
  for (const [mode, status] of [["control", 0], ["SIGINT", 130], ["SIGTERM", 143]]) {
    const scratch = join(root, mode); await mkdir(scratch);
    if (mode !== "control") {
      await writeFile(join(f.directory, "verdict.json"), "previous verdict");
      await writeFile(join(f.directory, "issues.md"), "previous issues");
      await writeFile(join(f.directory, "noise.json"), "previous noise");
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { cwd: process.cwd(), encoding: "utf8", timeout: 15000, env: { ...process.env, KOVA_HOME: f.home, TMPDIR: scratch, TMP: scratch, TEMP: scratch, KOVA_INTERRUPT_SIGNAL: mode } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.signal, null);
    assert.deepEqual(await readdir(scratch), []);
    if (mode !== "control") {
      assert.match(result.stdout, /scratch-written/);
      assert.equal(await readFile(join(f.directory, "verdict.json"), "utf8"), "previous verdict");
      assert.equal(await readFile(join(f.directory, "issues.md"), "utf8"), "previous issues");
      assert.equal(await readFile(join(f.directory, "noise.json"), "utf8"), "previous noise");
    }
  }
});

test("CLI inventories suppressed items by phase and category without hiding stable changes", async (t) => {
  const copies = Object.fromEntries(names.map((name, index) => [name, {
    response: { id: `created-${name}`, root: `compare-env-${name}`, noisy: name.startsWith("noise") ? name : "old", stable: name.startsWith("change") ? "new" : "old" },
    logs: `durationMs=${index + 10}\n`
  }]));
  for (const name of ["change-1", "change-2"]) copies[name].response.noisy = "changed";
  const f = await fixture(t, {
    copies, creates: ["/id"],
    phases: [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "timing", "logs", "state:state"] }],
    async state(files, name, index) {
      await mkdir(join(files, "../state"), { recursive: true });
      const db = new DatabaseSync(join(files, "../state/openclaw.sqlite"));
      try { db.exec(`CREATE TABLE cron_run_logs (id INTEGER PRIMARY KEY, duration_ms INTEGER, outcome TEXT); INSERT INTO cron_run_logs VALUES (1, ${index + 20}, 'ok')`); }
      finally { db.close(); }
    }
  });
  for (const name of names) f.run.clones[name].env = `compare-env-${name}`;
  await writeJSON(join(f.directory, "run.json"), f.run);
  const cli = spawnSync(process.execPath, ["bin/kova.mjs", "verify", "compare", "--run", "sample", "--json"], { cwd: process.cwd(), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const verdict = JSON.parse(cli.stdout);
  const saved = JSON.parse(await readFile(join(f.directory, "verdict.json"), "utf8"));
  const noise = JSON.parse(await readFile(join(f.directory, "noise.json"), "utf8"));
  assert.deepEqual(verdict, saved);
  const inventory = [];
  assert.deepEqual(await compareRecordedRun(f.directory, { noiseItems: inventory }), verdict);
  assert.deepEqual(noise.items, inventory);
  assert.equal(verdict.verdict, "breaks");
  assert.ok(verdict.rows.some((row) => row.at === "0/stable" && row.class === "break"));
  assert.ok(!verdict.rows.some((row) => /noisy|duration_ms|\/id$|\/root$/.test(row.at)));
  assert.equal(noise.schema, "kova.verify.noise.v1");
  assert.equal(noise.run, "sample");
  assert.equal(verdict.dropped.length, 1);
  for (const category of ["declaredIds", "pathRoots", "noiseClones", "measurements", "logLevel"]) {
    const items = noise.items.filter((item) => item.category === category);
    assert.ok(items.length > 0, category);
    assert.equal(verdict.dropped[0][category], items.length);
    assert.ok(items.every((item) => item.phase === phaseId && item.reason && item.signal && typeof item.at === "string"));
  }
  assert.equal(verdict.noiseExcluded, verdict.dropped[0].noiseClones);
  assert.ok(noise.items.some((item) => item.at.endsWith("/duration_ms") && item.before === 20 && item.after.absent));
  assert.ok(noise.items.some((item) => item.category === "declaredIds" && item.copy === "baseline" && item.before === "created-baseline"));
  assert.ok(noise.items.some((item) => item.category === "noiseClones" && item.at === "0/noisy" && item.clones.length === 2));
  assert.ok(!Object.hasOwn(verdict, "items"));
});

test("inventory write failure preserves previous reports and removes the partial file", async (t) => {
  const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, { logs: "durationMs=123\n" }])) });
  for (const file of ["noise.json", "verdict.json", "issues.md"]) await writeFile(join(f.directory, file), `previous ${file}`);
  const child = String.raw`
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await original(...args);
      if (/\/noise\.json\.[^/]+\.tmp$/.test(String(args[0]))) {
        const write = handle.writeFile.bind(handle);
        let writes = 0;
        handle.writeFile = async (...values) => {
          if (++writes === 2) throw Object.assign(new Error("injected inventory disk failure"), { code: "ENOSPC" });
          return write(...values);
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { main } = await import("./src/main.mjs");
    await main(["verify", "compare", "--run", "sample", "--json"]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { cwd: process.cwd(), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /injected inventory disk failure/);
  for (const file of ["noise.json", "verdict.json", "issues.md"]) assert.equal(await readFile(join(f.directory, file), "utf8"), `previous ${file}`);
  assert.equal((await readdir(f.directory)).some(file => file.endsWith(".tmp")), false);
});

test("CLI writes verdict files and JSON output without serializing the whole report", async (t) => {
  const f = await fixture(t, { copies: Object.fromEntries(names.map(name => [name, {
    response: { outcome: name.startsWith("change") ? "changed" : "original" }
  }])) });
  const child = String.raw`
    const stringify = JSON.stringify;
    JSON.stringify = (value, ...args) => {
      if (value?.schema === "kova.verify.v1") throw new RangeError("aggregate verdict exceeds string capacity");
      return stringify(value, ...args);
    };
    const { main } = await import("./src/main.mjs");
    await main(["verify", "compare", "--run", "sample", "--json"]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    cwd: process.cwd(), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const saved = await readFile(join(f.directory, "verdict.json"), "utf8");
  assert.equal(result.stdout, saved);
  assert.equal(saved, `${JSON.stringify(JSON.parse(saved), null, 2)}\n`);
  assert.equal(JSON.parse(saved).verdict, "breaks");
  assert.equal((await readdir(f.directory)).some(file => file.endsWith(".tmp")), false);
});

test("comparison rejects a linked run before opening output", async (t) => {
  const f = await fixture(t);
  await symlink(f.directory, join(f.home, "artifacts/verify/linked"));
  const child = String.raw`
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.promises.open;
    fs.promises.open = async (...args) => {
      if (args[1] === "wx") throw new Error("opened output before validating the run");
      return original(...args);
    };
    syncBuiltinESMExports();
    const { main } = await import("./src/main.mjs");
    await main(["verify", "compare", "--run", "linked", "--json"]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { cwd: process.cwd(), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /recorded run must be a directory, not a symbolic link/);
  assert.equal((await readdir(f.directory)).some(file => file.endsWith(".tmp")), false);
});
test("SQLite TEXT retains invalid encoding through recorded comparison", async (t) => {
  const invalid = (bytes) => ({ invalidText: { sha256: sha256(bytes) } });
  for (const [label, baseline, change, expectedBaseline, expectedChange] of [
    ["valid replacement to damaged", Buffer.from("\uFFFD"), Buffer.from([0x80]), "\uFFFD", invalid(Buffer.from([0x80]))],
    ["distinct damaged values", Buffer.from([0x80]), Buffer.from([0x81]), invalid(Buffer.from([0x80])), invalid(Buffer.from([0x81]))],
    ["identical damaged values", Buffer.from([0x80]), Buffer.from([0x80]), null, null]
  ]) {
    const f = await fixture(t, { state: async (path, name) => {
      const db = new DatabaseSync(join(path, "text.sqlite"));
      try {
        db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)");
        db.prepare("INSERT INTO records VALUES (1, CAST(? AS TEXT))").run(name.startsWith("change") ? change : baseline);
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, baseline.equals(change) ? "good-to-go" : "breaks", label);
    assert.deepEqual(result.undeclared, [], label);
    assert.equal(result.noiseExcluded, 0, label);
    assert.deepEqual(result.rows, baseline.equals(change) ? [] : [{
      phase: phaseId, signal: "state", at: "files/text.sqlite:records/1/value", clones: ["change-1", "change-2"],
      baseline: expectedBaseline, change: expectedChange, class: "break", explainedBy: null
    }], label);
  }
});

test("SQLite valid text encodings and BLOB storage remain distinct", async (t) => {
  for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"]) {
    const f = await fixture(t, { state: async (path, name) => {
      const db = new DatabaseSync(join(path, "text.sqlite"));
      try {
        db.exec(`PRAGMA encoding = '${encoding}'; CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)`);
        db.prepare("INSERT INTO records VALUES (1, ?)").run(name.startsWith("change") ? "\uFEFF\uFFFDé\u0000new" : "\uFEFF\uFFFDé\u0000old");
      } finally { db.close(); }
    } });
    const result = await f.compare();
    assert.equal(result.verdict, "breaks", encoding);
    assert.deepEqual(result.rows.map(({ baseline, change }) => [baseline, change]), [["\uFEFF\uFFFDé\u0000old", "\uFEFF\uFFFDé\u0000new"]], encoding);
  }
  const bytes = Buffer.from([0x80]);
  const f = await fixture(t, { state: async (path, name) => {
    const db = new DatabaseSync(join(path, "text.sqlite"));
    try {
      db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value)");
      db.prepare(name.startsWith("change") ? "INSERT INTO records VALUES (1, ?)" : "INSERT INTO records VALUES (1, CAST(? AS TEXT))").run(bytes);
    } finally { db.close(); }
  } });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows.map(({ baseline, change }) => [baseline, change]), [[{ invalidText: { sha256: sha256(bytes) } }, { sha256: sha256(bytes) }]]);
});

test("SQLite malformed TEXT does not invent persona or declared string identities", async (t) => {
  for (const bytes of [Buffer.from([0x80]), Buffer.from("\uFFFD")]) {
    const f = await fixture(t, {
      creates: ["/id"],
      copies: Object.fromEntries(names.map((name) => [name, { response: { id: name.startsWith("change") ? "\uFFFD" : `generated-${name}` } }])),
      initial: async (path) => {
        const db = new DatabaseSync(join(path, "source.sqlite"));
        try {
          db.exec("CREATE TABLE records (id TEXT)");
          db.prepare("INSERT INTO records VALUES (CAST(? AS TEXT))").run(bytes);
        } finally { db.close(); }
      }
    });
    const result = await f.compare();
    assert.equal(result.verdict, bytes[0] === 0x80 ? "good-to-go" : "breaks");
    if (bytes[0] !== 0x80) assert.equal(result.rows[0].change, "\uFFFD");
  }
  const f = await fixture(t, {
    stateIds: [{ path: "files/text.sqlite", table: "records", column: "id", recordKey: "owner" }],
    state: async (path, name) => {
      const db = new DatabaseSync(join(path, "text.sqlite"));
      try {
        db.exec("CREATE TABLE records (id TEXT, owner TEXT)");
        db.prepare("INSERT INTO records VALUES (CAST(? AS TEXT), 'stable-owner')").run(Buffer.from([name.startsWith("change") ? 0x81 : 0x80]));
      } finally { db.close(); }
    }
  });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.deepEqual(result.rows.map(({ at, baseline, change }) => [at, baseline, change]), [[
    "files/text.sqlite:records/1/id", { invalidText: { sha256: sha256(Buffer.from([0x80])) } }, { invalidText: { sha256: sha256(Buffer.from([0x81])) } }
  ]]);
});

test("SQLite damaged TEXT order values retain byte order and precede BLOBs", async (t) => {
  const f = await fixture(t, {
    stateIds: [{ path: "files/text.sqlite", table: "records", column: "id", recordKey: "owner", order: "position" }],
    state: async (path, name) => {
      const db = new DatabaseSync(join(path, "text.sqlite"));
      try {
        db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, owner TEXT, position, value TEXT)");
        const changed = name.startsWith("change");
        for (const index of changed ? [2, 1, 0] : [0, 1, 2]) {
          const query = index === 2 ? "INSERT INTO records VALUES (?, 'stable-owner', ?, ?)" : "INSERT INTO records VALUES (?, 'stable-owner', CAST(? AS TEXT), ?)";
          db.prepare(query).run(`generated-${name}-${index}`, Buffer.from([index === 2 ? 0 : 0x80 + index]), changed && index === 1 ? "new" : "old");
        }
      } finally { db.close(); }
    }
  });
  const result = await f.compare();
  assert.equal(result.verdict, "breaks");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].change, "new");
  const key = JSON.parse(result.rows[0].at.split("/")[2].replaceAll("~1", "/").replaceAll("~0", "~"));
  assert.ok(key.endsWith("/id/2>"), key);
});

test("suppression inventory distinguishes primary-key components in separate rows", async (t) => {
  const f = await fixture(t, {
    creates: ["/id"], copies: Object.fromEntries(names.map((name) => [name, { response: { id: `generated-${name}` } }])),
    async state(path, name) {
      const db = new DatabaseSync(join(path, "keys.sqlite"));
      try {
        db.exec("CREATE TABLE records(owner TEXT, suffix TEXT, PRIMARY KEY(owner, suffix))");
        for (const suffix of ["left", "right"]) db.prepare("INSERT INTO records VALUES (?, ?)").run(`generated-${name}`, suffix);
      } finally { db.close(); }
    }
  });
  const noiseItems = [];
  const verdict = await compareRecordedRun(f.directory, { noiseItems });
  assert.equal(verdict.verdict, "good-to-go");
  assert.equal(verdict.dropped[0].declaredIds, 25);
  const keys = noiseItems.filter((item) => item.copy === "baseline" && item.signal === "state" && item.kind === "key");
  assert.deepEqual(keys.map((item) => item.at), ["files/keys.sqlite:records/@row:0/owner", "files/keys.sqlite:records/@row:1/owner"]);
});
async function sourceIdentityFixture(t, family, bytes, id, encoding = "UTF-8") {
  const options = {
    creates: ["/id"],
    copies: Object.fromEntries(names.map((name) => [name, { response: { id: name.startsWith("change") ? id : `generated-${name}` } }]))
  };
  if (family.startsWith("sqlite")) {
    options.initial = async (path) => {
      const db = new DatabaseSync(join(path, "source.sqlite"));
      try {
        db.exec(`PRAGMA encoding = '${encoding}'; CREATE TABLE records (payload)`);
        db.prepare(family === "sqlite-zstd" ? "INSERT INTO records VALUES (?)" : "INSERT INTO records VALUES (CAST(? AS TEXT))").run(family === "sqlite-zstd" ? zstdCompressSync(bytes) : bytes);
      } finally { db.close(); }
    };
    if (family === "sqlite-zstd") options.compressed = [{ path: "files/source.sqlite", table: "records", column: "payload", codec: "zstd" }];
  } else options.originalFiles = { [family === "json5" ? "config.json5.pre-update" : `history.${family}`]: bytes };
  return fixture(t, options);
}

test("damaged source documents retain intact escaped identity values and keys", async (t) => {
  for (const family of ["sqlite", "sqlite-zstd", "json", "jsonl", "json5"]) {
    for (const key of [false, true]) {
      const start = family === "json5"
        ? key ? String.raw`{/* saved */ 'persona\u002dexisting\u002did':'present', note:'` : String.raw`{/* saved */ id:'persona\u002dexisting\u002did', note:'`
        : key ? String.raw`{"persona\u002dexisting\u002did":"present","note":"` : String.raw`{"id":"persona\u002dexisting\u002did","note":"`;
      const bytes = Buffer.concat([Buffer.from(start), Buffer.from([0x80]), Buffer.from(family === "json5" ? "'}\n" : '"}\n')]);
      const f = await sourceIdentityFixture(t, family, bytes, "persona-existing-id");
      const result = await f.compare();
      assert.equal(result.verdict, "breaks", `${family}: ${key ? "key" : "value"}`);
      assert.equal(result.rows[0].change, "persona-existing-id");
    }
  }
});

test("source identity discovery distinguishes real replacement characters from corrupt strings", async (t) => {
  for (const family of ["sqlite", "json", "jsonl", "json5"]) {
    for (const damaged of [false, true]) {
      const bytes = Buffer.concat([
        Buffer.from(family === "json5" ? "{ id:'" : '{"id":"'),
        damaged ? Buffer.from([0x80]) : Buffer.from("\uFFFD"),
        Buffer.from(family === "json5" ? "'}\n" : '"}\n')
      ]);
      const f = await sourceIdentityFixture(t, family, bytes, "\uFFFD");
      const result = await f.compare();
      assert.equal(result.verdict, damaged ? "good-to-go" : "breaks", `${family}: ${damaged ? "damaged" : "valid"}`);
    }
  }
});

test("source string fragments require valid escape syntax", async (t) => {
  for (const family of ["sqlite", "json", "jsonl"]) {
    for (const [suffix, expected] of [
      [String.raw`\"phantom\u002did","valid":"ordinary"}`, "breaks"],
      [String.raw`\"phantom\u002did\u00","valid":"ordinary"}`, "good-to-go"]
    ]) {
      const bytes = Buffer.concat([Buffer.from('{"broken":"'), Buffer.from([0x80]), Buffer.from(suffix)]);
      const f = await sourceIdentityFixture(t, family, bytes, "phantom-id");
      assert.equal((await f.compare()).verdict, expected, family);
    }
  }
});

test("source identity recovery respects damaged SQLite UTF-16 encodings", async (t) => {
  for (const encoding of ["UTF-16le", "UTF-16be"]) {
    const bytes = Buffer.concat([
      Buffer.from(String.raw`{"id":"persona\u002dexisting\u002did","note":"`, "utf16le"),
      Buffer.from([0x00, 0xd8]),
      Buffer.from('"}', "utf16le")
    ]);
    if (encoding === "UTF-16be") bytes.swap16();
    const f = await sourceIdentityFixture(t, "sqlite", bytes, "persona-existing-id", encoding);
    const result = await f.compare();
    assert.equal(result.verdict, "breaks", encoding);
    assert.equal(result.rows[0].change, "persona-existing-id");
  }
});

test("damaged JSON5 source retains intact escaped unquoted identity keys", async (t) => {
  for (const [start, end, expected] of [
    [String.raw`{persona\u0049d:'value', note:'`, "'}", "breaks"],
    [String.raw`{/* \"unrelated\" */ persona\u0049d /* retained key */ :'value', note:'`, "'}", "breaks"],
    ["{/* bad ", String.raw` */ persona\u0049d:'value'}`, "breaks"],
    [String.raw`{persona\u0049d /* bad `, " */ :'value'}", "breaks"],
    ["{// bad ", "\n" + String.raw`persona\u0049d:'value'}`, "breaks"],
    ["{// bad ", "\u2028" + String.raw`persona\u0049d:'value'}`, "breaks"],
    ["{// bad ", "\u2029" + String.raw`persona\u0049d:'value'}`, "breaks"],
    [String.raw`{persona\u0049d // bad `, "\n:'value'}", "breaks"],
    [String.raw`{persona\u0049/* bad `, " */ d:'value'}", "good-to-go"]
  ]) {
    const bytes = Buffer.concat([Buffer.from(start), Buffer.from([0x80]), Buffer.from(end)]);
    const f = await sourceIdentityFixture(t, "json5", bytes, "personaId");
    const result = await f.compare();
    assert.equal(result.verdict, expected);
    if (expected === "breaks") assert.equal(result.rows[0].change, "personaId");
  }
});

test("suppression inventory distinguishes separate Doctor findings", async (t) => {
  const doctor = "ocm @{env} -- doctor --json";
  const phase = { id: phaseId, from: "template:sessions", commands: [command, doctor], checkpoint: ["doctor"] };
  const f = await fixture(t, { phases: [phase] });
  const shipped = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url)));
  await writeJSON(join(f.directory, "catalogue.json"), { ...shipped, entries: [...shipped.entries, { ...entry, creates: ["/id"] }] });
  for (const name of names) {
    const directory = join(f.directory, name), id = `generated-${name}`;
    await rm(join(directory, "checkpoints"), { recursive: true });
    await writeCheckpoint({ phase, directory, creates: [["/id"], []], results: [
      { id }, { findings: [{ code: "one", message: id }, { code: "two", message: id }] }
    ].map((value, index) => ({ command: phase.commands[index], status: 0, stdout: JSON.stringify(value), stderr: "", durationMs: 1 })) });
  }
  const noiseItems = [];
  const verdict = await compareRecordedRun(f.directory, { noiseItems });
  assert.equal(verdict.verdict, "good-to-go");
  assert.equal(verdict.dropped[0].declaredIds, 10);
  assert.deepEqual(noiseItems.filter((item) => item.copy === "baseline" && item.category === "declaredIds").map((item) => item.at), ["1/@finding:0/message", "1/@finding:1/message"]);
});
test("damaged source strings preserve escaped fragments without joining damage", async (t) => {
  for (const family of ["sqlite", "sqlite-zstd", "json", "jsonl", "json5"]) {
    for (const [start, end, id, expected] of [
      [String.raw`{"id":"persona\u002dexisting\u002did `, '"}', "persona-existing-id", "breaks"],
      ['{"id":"', String.raw` persona\u002dexisting\u002did"}`, "persona-existing-id", "breaks"],
      [String.raw`{"id":"persona\u002dexist`, String.raw`ing\u002did"}`, "persona-existing-id", "good-to-go"],
      [String.raw`{"id":"\uFFFD `, '"}', "\uFFFD", "breaks"],
      ['{"id":"before ', ' after"}', "\uFFFD", "good-to-go"],
      [String.raw`{"id":"\u005fkovaInvalid0! `, '"}', "_kovaInvalid0!", "breaks"]
    ]) {
      const bytes = Buffer.concat([Buffer.from(start), Buffer.from([0x80]), Buffer.from(end)]);
      const f = await sourceIdentityFixture(t, family, bytes, id);
      const result = await f.compare();
      assert.equal(result.verdict, expected, `${family}: ${start}`);
      if (expected === "breaks") assert.equal(result.rows[0].change, id);
    }
  }
});

test("JSON5 escaped damaged bytes do not expose recovery markers or join fragments", async (t) => {
  for (const [start, end, id, expected] of [
    ["{id:'before\\", String.raw` persona\u002dexisting\u002did'}`, "persona-existing-id", "breaks"],
    [String.raw`{id:'persona\u002dexisting\u002did ` + "\\", " after'}", "persona-existing-id", "breaks"],
    ["{id:'before\\", " after'}", "_kovaInvalid0!", "good-to-go"],
    ["{id:'before\\", "after'}", "beforeafter", "good-to-go"]
  ]) {
    const bytes = Buffer.concat([Buffer.from(start), Buffer.from([0x80]), Buffer.from(end)]);
    const f = await sourceIdentityFixture(t, "json5", bytes, id);
    assert.equal((await f.compare()).verdict, expected);
  }
});

test("damaged SQLite UTF-16 retains literal and escaped identity fragments", async (t) => {
  for (const encoding of ["UTF-16le", "UTF-16be"]) {
    for (const [start, end, expected] of [
      [String.raw`{"id":"persona\u002dexisting\u002did `, '"}', "breaks"],
      ['{"id":"', String.raw` persona\u002dexisting\u002did"}`, "breaks"],
      ["persona-existing-id ", " trailing", "breaks"],
      ["before ", " persona-existing-id", "breaks"],
      ["persona-exist", "ing-id", "good-to-go"]
    ]) {
      const bytes = Buffer.concat([Buffer.from(start, "utf16le"), Buffer.from([0x00, 0xd8]), Buffer.from(end, "utf16le")]);
      if (encoding === "UTF-16be") bytes.swap16();
      const f = await sourceIdentityFixture(t, "sqlite", bytes, "persona-existing-id", encoding);
      assert.equal((await f.compare()).verdict, expected, `${encoding}: ${start}`);
    }
  }
});

test("recorded JSON reports damaged UTF-8 without comparing replacement characters", async (t) => {
  const f = await fixture(t, { copies: Object.fromEntries(names.map((name) => [name, { response: { title: "\uFFFD" } }])) });
  assert.equal((await f.compare()).verdict, "good-to-go");
  const encode = (bytes) => Buffer.concat([Buffer.from('{"0":{"title":"'), bytes, Buffer.from('"}}')]);
  for (const [before, after, damaged] of [
    [Buffer.from("\uFFFD"), Buffer.from("changed"), false],
    [Buffer.from("\uFFFD"), Buffer.from([0x80]), true],
    [Buffer.from([0x80]), Buffer.from([0x81]), true]
  ]) {
    for (const name of names) await writeFile(join(f.directory, name, "checkpoints", phaseId, "responses.json"), encode(name.startsWith("change") ? after : before));
    const result = await f.compare();
    if (damaged) {
      assert.equal(result.verdict, "unresolved");
      assert.deepEqual(result.rows, []);
      const copies = before[0] === 0x80 ? names : names.filter((name) => name.startsWith("change"));
      assert.deepEqual(result.damaged, copies.map((copy) => ({ copy, phase: phaseId, file: "responses.json", reason: "The encoded data was not valid for encoding utf-8" })));
      assert.deepEqual(result.dropped, [{ phase: phaseId, declaredIds: 0, pathRoots: 0, noiseClones: 0, measurements: 0, logLevel: 0, derived: 0 }]);
    } else {
      assert.equal(result.verdict, "breaks");
      assert.deepEqual(result.damaged, []);
    }
  }
  const planFixture = await fixture(t);
  const bytes = Buffer.from(JSON.stringify(planFixture.plan).replace("Return the new title.", "\uFFFD"));
  const damaged = Buffer.concat([bytes.subarray(0, bytes.indexOf(Buffer.from("\uFFFD"))), Buffer.from([0x80]), bytes.subarray(bytes.indexOf(Buffer.from("\uFFFD")) + 3)]);
  await writeFile(join(planFixture.directory, "plan.json"), damaged);
  planFixture.run.plan.sha256 = sha256(damaged);
  await writeJSON(join(planFixture.directory, "run.json"), planFixture.run);
  await assert.rejects(planFixture.compare(), /encoded data was not valid/);
});

test("recorded logs report damaged encoding without changing valid log comparison", async (t) => {
  const f = await fixture(t);
  for (const [before, after, damaged] of [
    [Buffer.from("\uFFFD"), Buffer.from("changed"), false],
    [Buffer.from("\uFFFD"), Buffer.from([0x80]), true],
    [Buffer.from([0x80]), Buffer.from([0x81]), true]
  ]) {
    for (const name of names) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), Buffer.concat([Buffer.from("WARN value="), name.startsWith("change") ? after : before, Buffer.from("\n")]));
    const result = await f.compare();
    if (damaged) {
      assert.equal(result.verdict, "unresolved");
      assert.deepEqual(result.rows, []);
      const copies = before[0] === 0x80 ? names : names.filter((name) => name.startsWith("change"));
      assert.deepEqual(result.damaged, copies.map((copy) => ({ copy, phase: phaseId, file: "logs.txt", reason: "The encoded data was not valid for encoding utf-8" })));
    } else assert.equal(result.verdict, "breaks");
  }
});


test("CLI writes unresolved damage and keeps only readable phases and their exclusions", async (t) => {
  const phases = ["sessions/read", "sessions/damaged", "sessions/healthy"].map((id) => ({ id, from: "template:sessions", commands: [command], checkpoint: ["responses", "timing", "logs"] }));
  const f = await fixture(t, { phases, creates: ["/id"], copies: Object.fromEntries(names.map((name, index) => [name, { response: { id: `generated-${index}`, title: name.startsWith("change") ? "new" : "old" }, logs: "WARN shared\n" }])) });
  // The producer is damaged; its otherwise valid createdIds must not normalize
  // the readable consumer. It also contains a shared warning that must be absent.
  const damage = [
    { copy: "change-1", phase: "sessions/read", file: "logs.txt" },
    { copy: "noise-2", phase: "sessions/damaged", file: "responses.json" },
    { copy: "noise-2", phase: "sessions/damaged", file: "logs.txt" }
  ];
  for (const item of damage) await writeFile(join(f.directory, item.copy, "checkpoints", item.phase, item.file), Buffer.from([0x80]));
  for (const name of names) {
    const path = join(f.directory, name, "checkpoints", "sessions/healthy");
    const commands = JSON.parse(await readFile(join(path, "commands.json"), "utf8"));
    commands[0].createdIds = [];
    await writeJSON(join(path, "commands.json"), commands);
    await writeJSON(join(path, "responses.json"), { 0: { reference: `generated-${names.indexOf(name)}`, title: name.startsWith("change") ? "new" : "old" } });
  }
  const cli = spawnSync(process.execPath, ["bin/kova.mjs", "verify", "compare", "--run", "sample", "--json"], { cwd: new URL("..", import.meta.url), env: { ...process.env, KOVA_HOME: f.home }, encoding: "utf8", timeout: 10000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.doesNotMatch(cli.stderr, /kova\.error/);
  const result = JSON.parse(cli.stdout);
  assert.deepEqual(result, JSON.parse(await readFile(join(f.directory, "verdict.json"), "utf8")));
  assert.equal(result.verdict, "unresolved");
  assert.deepEqual(result.damaged, damage.map((item) => ({ ...item, reason: "The encoded data was not valid for encoding utf-8" })));
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every((row) => row.phase === "sessions/healthy"));
  assert.ok(result.rows.some((row) => row.class === "break" && row.at === "0/title"));
  assert.deepEqual(result.issues.map((issue) => issue.phase), ["sessions/healthy"]);
  const issues = await readFile(join(f.directory, "issues.md"), "utf8");
  assert.match(issues, /sessions\/healthy/);
  assert.doesNotMatch(issues, /sessions\/(read|damaged)/);
  const noise = JSON.parse(await readFile(join(f.directory, "noise.json"), "utf8"));
  assert.ok(noise.items.length > 0);
  assert.ok(noise.items.every((item) => item.phase === "sessions/healthy" && item.category !== "declaredIds"));
  assert.ok(noise.items.some((item) => item.category === "noiseClones" && item.at === "0/reference"));
  for (const counts of result.dropped) for (const category of ["declaredIds", "pathRoots", "noiseClones", "measurements", "logLevel"]) {
    assert.equal(counts[category], noise.items.filter((item) => item.phase === counts.phase && item.category === category).length);
  }
});

test("checkpoint encoding damage covers metadata and selected text only", async (t) => {
  for (const file of ["commands.json", "timing.json", "doctor.json"]) {
    const f = await fixture(t, { phases: [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "timing", "doctor"] }] });
    for (const name of names) await writeJSON(join(f.directory, name, "checkpoints", phaseId, "doctor.json"), [null]);
    await writeFile(join(f.directory, "baseline", "checkpoints", phaseId, file), Buffer.from([0x80]));
    const result = await f.compare();
    assert.equal(result.verdict, "unresolved");
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.damaged, [{ copy: "baseline", phase: phaseId, file, reason: "The encoded data was not valid for encoding utf-8" }]);
  }
  const f = await fixture(t, { phases: [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["timing"] }] });
  for (const file of ["responses.json", "logs.txt"]) await writeFile(join(f.directory, "baseline", "checkpoints", phaseId, file), Buffer.from([0x80]));
  const result = await f.compare();
  assert.equal(result.verdict, "good-to-go");
  assert.deepEqual(result.damaged, []);
});


for (const mode of ["rows", "excluded"]) test(`large log phases retain every ${mode} item`, async (t) => {
  const count = 200000;
  const logs = Array.from({ length: count }, (_, index) => `INFO batch-log-id record-${index}`).join("\n") + "\n";
  const copies = Object.fromEntries(names.map((name) => [name, { logs: mode === "rows"
    ? name.startsWith("change") ? logs : ""
    : logs.repeat(name.startsWith("change") ? 2 : name === "noise-2" ? 3 : 1) }]));
  const f = await fixture(t, { creates: ["/id"], copies: Object.fromEntries(Object.entries(copies).map(([name, data]) => [name, { ...data, response: { id: "batch-log-id" } }])) }), inventory = [];
  const result = await compareRecordedRun(f.directory, { noiseItems: inventory });
  assert.equal(result.verdict, mode === "rows" ? "breaks" : "good-to-go");
  assert.equal(result.rows.length, mode === "rows" ? count : 0);
  assert.equal(result.noiseExcluded, mode === "excluded" ? count : 0);
  const items = mode === "rows" ? result.rows : inventory.filter((item) => item.category === "noiseClones");
  assert.equal(items.length, count);
  assert.ok(items.every((item) => item.class === "break" && item.clones.join(",") === "change-1,change-2"));
});


{
  const cases = [
    ["JSON", "source.json", String.raw`{"id":"persona\u002dexisting\u002did","id":"last-id"}`],
    ["JSON5", "source.json5", String.raw`{id:'persona\u002dexisting\u002did', /* earlier source value */ id:'last-id'}`],
    ["JSONL", "agents/main/sessions/source.jsonl", String.raw`{"id":"persona\u002dexisting\u002did","id":"last-id"}`],
    ["JSON backup", "source.json.bak", String.raw`{"record":{"id":"persona\u002dexisting\u002did"},"record":null}`],
    ["JSON5 escaped key", "keys.json5", String.raw`{record:{persona\u0045xistingId:true},record:null}`]
  ];
  for (const [format, path, content] of cases) {
    test(`complete ${format} persona sources preserve escaped identities in earlier duplicate members`, async t => {
      const original = format === "JSON5 escaped key" ? "personaExistingId" : "persona-existing-id";
      const f = await fixture(t, {
        creates: ["/id", "/fresh"], originalFiles: { [path]: `${content}\n` },
        copies: Object.fromEntries(names.map(name => [name, { response: {
          id: name.startsWith("change") ? original : `generated-${name}`,
          fresh: `ordinary-new-${name}`
        } }]))
      });
      const result = await f.compare();
      assert.equal(result.verdict, "breaks");
      assert.deepEqual(result.rows, [{ phase: "sessions/read", signal: "responses", at: "0/id",
        clones: ["change-1", "change-2"], baseline: "<id:sessions/read/0/id>", change: original,
        class: "break", explainedBy: null }]);
      assert.deepEqual(result.undeclared, []);
    });
  }
  test("duplicate source members do not protect absent newly generated identities", async t => {
    const f = await fixture(t, {
      creates: ["/id"],
      originalFiles: { "source.json": String.raw`{"id":"persona\u002dexisting\u002did","id":"last-id"}` },
      copies: Object.fromEntries(names.map(name => [name, { response: { id: `ordinary-new-${name}` } }]))
    });
    const result = await f.compare();
    assert.equal(result.verdict, "good-to-go");
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.undeclared, []);
  });
}
