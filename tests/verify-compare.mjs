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
  const phases = options.phases ?? [{ id: phaseId, from: "template:sessions", commands: [command], checkpoint: ["responses", "timing", "logs", "doctor", ...(options.state ? ["state:files"] : [])] }];
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
      await writeJSON(join(path, "commands.json"), [{ command, exit: data.exit ?? 0, stdout: data.stdout ?? null, stderr: "", durationMs: 100 + index, timedOut: data.bound ?? false, createdIds: createdIds(data.response ?? { title: "old" }, options.creates ?? []) }]);
      await writeJSON(join(path, "responses.json"), { 0: data.response ?? { title: "old" } });
      await writeJSON(join(path, "timing.json"), [{ durationMs: 1000 * (index + 1), reachedBound: data.bound ?? false }]);
      await writeFile(join(path, "logs.txt"), data.logs ?? "");
      await writeJSON(join(path, "doctor.json"), [{ findings: data.findings ?? [] }]);
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
  assert.equal(result.rows.length, 5);
  assert.ok(result.rows.every((row) => row.class === "not-caused"));
  assert.equal(result.issues.length, 5);
  await compareVerification({ run: "sample" }, { home: join(f.home, "artifacts") });
  assert.match(await readFile(join(f.directory, "issues.md"), "utf8"), /baseline 1; change-1 2/);
});

test("baseline-only failures are fixed before intended or flaky", async (t) => {
  const f = await fixture(t, { copies: { baseline: { exit: 1, bound: true, logs: "ERROR old\n", findings: [{ code: "old" }] } }, expects: [{ phase: phaseId, signal: "commands", at: "0/exit", change: 0 }] });
  const result = await f.compare();
  assert.equal(result.rows.length, 4);
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

test("exit 2 on any copy overrides a break even when its item is noise", async (t) => {
  for (const name of names) {
    const f = await fixture(t, { copies: { ...both({ response: { title: "new" } }), [name]: { exit: 2, response: { title: name.startsWith("change") ? "new" : "old" } } } });
    const result = await f.compare();
    assert.equal(result.verdict, "unresolved", name);
    assert.deepEqual(result.incomplete, [phaseId]);
    assert.ok(result.rows.some((row) => row.class === "break"));
  }
});

test("missing checkpoints record fixed, break, and incomplete cases", async (t) => {
  const baselineMissing = await fixture(t, { missing: ["baseline"] });
  assert.equal((await baselineMissing.compare()).rows.find((row) => row.signal === "checkpoint").class, "fixed");
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
  assert.deepEqual(result.withheld, f.plan.withheld);
  const clean = await fixture(t);
  clean.plan.withheld = f.plan.withheld;
  clean.plan.unmapped = f.plan.unmapped;
  await clean.savePlan();
  assert.equal((await clean.compare()).verdict, "good-to-go");
});

test("catalogue ids normalize values, keys, paths and embedded references, but existing ids stay", async (t) => {
  const copies = Object.fromEntries(names.map((name, i) => [name, { response: { result: { id: `new-${i}` }, ref: `prefix:new-${i}`, keys: { [`new-${i}`]: true } }, stdout: `new-${i}\n`, logs: `INFO new-${i}\n` }]));
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

test("wildcard creates use concrete array indices and preserve embedded references", async (t) => {
  const f = await fixture(t, { creates: ["/createdIds/*"], copies: Object.fromEntries(names.map((name, i) => [name, { response: { createdIds: [`id-${i}-a`, `id-${i}-b`], result: { key: `session:id-${i}-b` } } }])) });
  assert.equal((await f.compare()).verdict, "good-to-go");
});

test("saved exit-2 metadata still overrides breaks after checkpoint capture failed", async (t) => {
  const f = await fixture(t, { missing: ["noise-1"], copies: both({ response: { title: "new" } }) });
  f.run.clones["noise-1"].incomplete = [phaseId];
  await f.savePlan();
  assert.equal((await f.compare()).verdict, "unresolved");
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
  assert.ok(result.rows.some((row) => row.at.endsWith("event_zstd/sha256")));
});

test("normalizes volatile text only, leaving ordinary identifiers and values intact", () => {
  assert.equal(normalizeText("2026-10-14T10:22:33.123Z pid=22 port: 9000 http://localhost:9000 took 23ms model=abc123 hash=00ff"), "<time> pid=<pid> port: <port> http://localhost:<port> took <duration> model=abc123 hash=00ff");
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
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, "verdict.json"), "utf8")), verdict);
  assert.equal(cli("--run", "sample", "--json").stdout, first.stdout);
  assert.match(await readFile(join(f.directory, "issues.md"), "utf8"), /No shared failures/);
  assert.notEqual(cli("--run", "sample", "--threshold", "0").status, 0);
  assert.notEqual(cli("--run").status, 0);
  assert.notEqual(cli("--run", "missing").status, 0);
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
    await writeCheckpoint({ phase, directory, results: ["primary", "secondary"].map((environment) => ({ command, status: 0, stdout: JSON.stringify({ environment }), stderr: "", durationMs: 1 })) });
  }
  const result = await f.compare();
  assert.equal(result.verdict, "good-to-go");
  assert.deepEqual(result.rows, []);
});
