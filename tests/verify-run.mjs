import { parseCatalogueCommand } from "../src/catalogue.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, appendFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createLogCollector, recordPhase, snapshotState, writeCheckpoint } from "../src/verify/checkpoint.mjs";
import { quoteShell, runCommand } from "../src/commands.mjs";
import { runVerification, compareVersions, prepareRun, validateRunPlan, validateTarget, validateRunDestinations } from "../src/verify/run.mjs";
import { resolveRunCommand } from "../src/verify/clones.mjs";
import { canonicalJSON, sha256 } from "../src/verify/plan.mjs";
import { repoRoot } from "../src/paths.mjs";

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

async function fixture(t) {
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
  const definition = { schema: "kova.verify.persona.v1", id: "test", runtime: { selector: "npm:2026.9.9" }, credentials: [], traits: [{ id: "configured", keys: {}, check: "ocm @{env} -- status --json" }] };
  const definitionBytes = JSON.stringify(definition), archive = join(root, "persona.tar");
  await writeFile(join(root, "definition.json"), definitionBytes); await writeFile(archive, "archive");
  const manifest = { schema: "kova.verify.persona-manifest.v1", persona: "test", version: "20261014T000000Z", runtime: { selector: "npm:2026.9.9", resolved: "fixture" }, env: { name: "durable", export: archive, includeState: true, sha256: sha256("archive") }, definition: { path: join(root, "definition.json"), sha256: sha256(definitionBytes) }, traits: { configured: { keys: {} } } };
  const manifestBytes = JSON.stringify(manifest), manifestPath = join(root, "persona.json");
  await writeFile(manifestPath, manifestBytes);
  const phases = ["use-target", "second"].map((name) => ({ id: `standard/${name}`, from: "standard", commands: [name === "use-target" ? "ocm start {env} --runtime {target} --no-service --json" : "ocm @{env} -- status --json"], checkpoint: ["responses", "timing", "logs"], timeoutMs: 5000 }));
  const plan = { schema: "kova.verify.plan.v1", change: { baseline: commit, change: commit }, persona: { manifest: manifestPath, sha256: sha256(manifestBytes) }, phases, phasesSha256: sha256(canonicalJSON(phases)) };
  const path = join(root, "plan.json");
  const save = () => writeFile(path, JSON.stringify({ ...plan, phasesSha256: sha256(canonicalJSON(plan.phases)) }));
  await save();
  const calls = [], created = [], removed = [];
  const bindings = new Map();
  let fail;
  const dependencies = {
    root: kova, home: join(root, "artifacts"), cleanupHandle: async () => {},
    execute: async (command) => {
      calls.push(command);
      const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
      if (tokens[0] === "ocm" && tokens[1] === "start") bindings.set(tokens[2], tokens[tokens.indexOf("--runtime") + 1]);
      const shown = tokens[1] === "env" && tokens[2] === "show" ? JSON.stringify({ name: tokens[3], defaultRuntime: bindings.get(tokens[3]) }) : null;
      return { command, status: fail?.(command) ?? 0, stdout: shown ?? (command === "ocm --version" ? "0.3.3\n" : command === "ocm runtime list --json" ? "[]" : '{"ok":true}'), stderr: "", durationMs: 1, timedOut: false };
    },
    cloneFactory: ({ name, directory }) => ({
      directory, handles: new Set(),
      context: () => ({ env: name, run: directory, kovaRoot: kova, traits: {}, roots: [] }),
      async prepare() { created.push(name); await mkdir(join(directory, "state"), { recursive: true }); return { name, root: directory, stateDir: join(directory, "state") }; },
      async cleanup() { removed.push(name); }
    })
  };
  return { root, source, catalogue, plan, save, calls, created, removed, dependencies, setFailure: (callback) => { fail = callback; }, options: { plan: path, targetBaseline: `local-build:${source}`, targetChange: `local-build:${source}` } };
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

test("first-phase failure is not started, while exit 2 on one later copy is incomplete", async (t) => {
  const f = await fixture(t);
  f.setFailure((command) => command.includes("'start' 'baseline'") ? 1 : 0);
  const failed = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(failed.notStarted, ["baseline"]);
  assert.equal(failed.clones.baseline.phases["standard/use-target"], "recorded");
  assert.equal(failed.clones.baseline.phases["standard/second"], "no checkpoint");
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
      await options.call(`ocm upgrade ${options.name}-extra --runtime alias --no-service --json`);
      return prepare();
    };
    return clone;
  };
  f.dependencies.execute = async (command) => {
    const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    if (tokens[0] === "ocm" && (["start", "upgrade"].includes(tokens[1]) || tokens[1] === "env" && tokens[2] === "import")) {
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

test("placeholder resolution quotes paths and binds extra persona environments to copies", () => {
  const context = { standard: true, env: "copy", target: "runtime", run: "/tmp/a b", kovaRoot: "/tmp/kova", traits: { second: { keys: { env: "copy-second" } } }, roots: [["/durable/source", "/copy/source"]] };
  assert.equal(resolveRunCommand("ocm @{persona:second:env} -- config get path --json", context), "'ocm' '@copy-second' '--' 'config' 'get' 'path' '--json'");
  assert.equal(resolveRunCommand("node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --out {run}/a.json --params '{\"path\":\"/durable/source/a\"}'", context), "'node' '/tmp/kova/support/verify/gateway-call.mjs' '--env' 'copy' '--out' '/tmp/a b/a.json' '--params' '{\"path\":\"/copy/source/a\"}'");
});


test("OCM operands and output files cannot escape clone or evidence ownership", async (t) => {
  const f = await fixture(t);
  for (const command of [
    "ocm env exec durable -- printf %s {env}",
    "ocm env exec {env} -- ocm env protect durable-persona off --json",
    "ocm env snapshot create durable --label {env} --json",
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
    { plugins: { load: { paths: [durable] } } },
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
  const call = (method, params, extra = "") => `${helper} --method ${method} --params ${quoteShell(JSON.stringify(params))} ${extra}`;
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


test("verification child commands cannot inherit another environment's Gateway credentials", async (t) => {
  const f = await fixture(t), execute = f.dependencies.execute;
  const previous = { config: process.env.OPENCLAW_CONFIG_PATH, token: process.env.OPENCLAW_GATEWAY_TOKEN };
  t.after(() => {
    for (const [name, value] of [["OPENCLAW_CONFIG_PATH", previous.config], ["OPENCLAW_GATEWAY_TOKEN", previous.token]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.OPENCLAW_CONFIG_PATH = join(f.root, "unrelated-config.json");
  process.env.OPENCLAW_GATEWAY_TOKEN = "synthetic-unrelated-token";
  f.dependencies.execute = (command, options) => {
    assert.equal(options.env.OPENCLAW_CONFIG_PATH, "");
    assert.equal(options.env.OPENCLAW_GATEWAY_TOKEN, "");
    assert.equal(options.env.KOVA_OPENCLAW_CONFIG_CONTRACT, "canonical");
    return execute(command, options);
  };
  const result = await runVerification({ ...f.options, execute: true }, f.dependencies);
  assert.deepEqual(result.notStarted, []);assert.deepEqual(result.incomplete, []);
  assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN, "synthetic-unrelated-token");
  assert.equal(process.env.OPENCLAW_CONFIG_PATH, join(f.root, "unrelated-config.json"));
});
