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
  assert.deepEqual(result.withheld, f.plan.withheld);
  const clean = await fixture(t);
  clean.plan.withheld = f.plan.withheld;
  clean.plan.unmapped = f.plan.unmapped;
  await clean.savePlan();
  assert.equal((await clean.compare()).verdict, "good-to-go");
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
  assert.ok(result.rows.some((row) => row.at.endsWith("event_zstd") && row.change.sha256));
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
  await writeJSON(join(f.directory, "catalogue.json"), { ...shipped, entries: [...shipped.entries, entry] });
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
    return [name, { response: { gateway: { connectLatencyMs: ms, reachable: true }, eventLoop: { degraded: false, reasons: [], intervalMs: ms, delayMaxMs: ms, delayP99Ms: ms, utilization: ms / 100, cpuCoreRatio: ms / 100, cpuBreakdown: { hostUtilization: ms / 100, hostCpuCount: 8 } }, health: { durationMs: ms, channels: { example: { probe: { elapsedMs: ms, ok: true } } } }, lastHeartbeat: { durationMs: ms }, settings: { connectLatencyMs: 10 } } }];
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
  const log = (pid, extra = {}) => JSON.stringify({ level: "info", message: `native runtime: ${JSON.stringify({ pid, platform: "linux", arch: "x64", node: "24.21.0", ...extra })}` });
  const f = await fixture(t, { copies: Object.fromEntries(names.map((name, index) => [name, { logs: log(41000 + index) }])) });
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints", phaseId, "logs.txt"), log(50000, { node: "unexpected" }));
  assert.equal((await f.compare()).verdict, "breaks");
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
    for (const phase of phases) await writeCheckpoint({ phase, directory, collectLogs: async () => [0, 1].map(index => JSON.stringify({ level: "info", message: `log file: /tmp/ocm/envs/${index ? `${env}-extra` : env}/root/.openclaw/logs/kova-product.log` })).join("\n"), results: [0, 1].map(index => {
      const environment = index ? `${env}-extra` : env, run = index ? `${root}/extra-1` : root;
      return { command: phase.commands[0].replace("{env}", environment).replace("{target}", "shared-runtime").replace("{kovaRoot}", "/source").replace("{run}", run), status: 0, stdout: JSON.stringify({ envName: environment, defaultRuntime: "shared-runtime", root: `/tmp/ocm/envs/${environment}`, ...(phase.id === "standard/start-gateway" ? { handle: `${run}/gateway.json` } : {}) }), stderr: "", durationMs: 1 };
    }) });
  }
  await f.savePlan();
  assert.equal((await f.compare()).verdict, "good-to-go");
  for (const name of ["change-1", "change-2"]) await writeFile(join(f.directory, name, "checkpoints/standard/start-gateway/logs.txt"), `INFO log file: /tmp/ocm/envs/${f.run.clones[name].env}/root/.openclaw/logs/wrong.log`);
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
