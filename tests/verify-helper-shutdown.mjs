import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { repoRoot } from "../src/paths.mjs";
import { canonicalJSON, sha256 } from "../src/verify/plan.mjs";
import { originalScriptCatalogue } from "./helpers/original-script-catalogue.mjs";

const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
const borrowed = { id: "foreign-job", name: "kova-cron-runtime-foreign" };
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));
const optionalJSON = async (path) => readJSON(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(20);
  }
}

async function prepare(directory) {
  const source = join(directory, "source"), root = join(directory, "kova"), bin = join(directory, "bin");
  await mkdir(source);
  await mkdir(join(root, "catalogue"), { recursive: true });
  await mkdir(join(root, "verify"));
  await mkdir(bin);
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Kova");
  git("config", "user.email", "kova@example.invalid");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(source, "package.json"), '{"name":"openclaw","version":"2026.10.2"}');
  git("add", ".");
  git("commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  await writeFile(join(root, "catalogue/openclaw.json"), JSON.stringify(originalScriptCatalogue(await readJSON(join(repoRoot, "catalogue/openclaw.json")))));
  await writeFile(join(root, "package.json"), '{"version":"1.0.0"}');
  await writeFile(join(root, "verify/standard.json"), '{"stateIds":[],"compressed":[]}');
  const definition = {
    schema: "kova.verify.persona.v1", id: "shutdown", title: "Shutdown copy", objective: "Finish owned cleanup before removing the copy.",
    runtime: { selector: "npm:2026.9.9", policy: "Pin the exported runtime and package integrity." }, credentials: [],
    traits: [{ id: "configured", content: "A configured environment.", keys: {}, needs: [], builder: ["ocm @{env} -- status --json"], check: "ocm @{env} -- status --json" }]
  };
  await writeFile(join(directory, "definition.json"), JSON.stringify(definition));
  await writeFile(join(directory, "persona.tar"), "archive");
  const manifest = {
    schema: "kova.verify.persona-manifest.v1", persona: "shutdown", version: "20261014T000000Z",
    runtime: { selector: definition.runtime.selector, resolved: `2026.9.9@sha512-${Buffer.alloc(64, 0x42).toString("base64")}` },
    env: { name: "durable", export: "persona.tar", includeState: true, sha256: sha256("archive") },
    definition: { path: "definition.json", sha256: sha256(JSON.stringify(definition)) }, traits: { configured: { keys: {}, checkedAt: "2026-10-14T00:00:00Z" } }, doctor: "fixture doctor output"
  };
  await writeFile(join(directory, "persona.json"), JSON.stringify(manifest));
  const phases = [
    { id: "standard/use-target", commands: ["ocm start {env} --runtime {target} --no-service --json"] },
    { id: "standard/legacy", commands: [
      "ocm @{env} -- status --json",
      "node {kovaRoot}/support/verify/stage-session-store-fixture.mjs --env {env} --agent main --restore --gateway-handle {run}/gateway.json --timeout 1000"
    ] },
    { id: "standard/cron", commands: ["node {kovaRoot}/support/verify/cron-runtime-smoke.mjs --env {env} --artifact-dir {run}/cron --timeout 10000"] }
  ].map((phase) => ({ ...phase, from: "standard", timeoutMs: 10000, checkpoint: ["responses", "timing"] }));
  const plan = {
    schema: "kova.verify.plan.v1", change: { baseline: commit, change: commit },
    persona: { manifest: "persona.json", sha256: sha256(JSON.stringify(manifest)) }, phases, phasesSha256: sha256(canonicalJSON(phases))
  };
  await writeFile(join(directory, "plan.json"), JSON.stringify(plan));
  await writeFile(join(directory, "fixture.json"), JSON.stringify({
    root, commandRoot: repoRoot, borrowed,
    options: { plan: join(directory, "plan.json"), targetBaseline: `local-build:${source}`, targetChange: `local-build:${source}` }
  }));
  await writeFile(join(bin, "ocm"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
const env = args[0] === "env" ? args[2] : args[0].slice(1);
const root = path.join(process.env.KOVA_SHUTDOWN_TEST_ROOT, "copies", env);
const jobsPath = path.join(root, "jobs.json");
const jobs = () => JSON.parse(fs.readFileSync(jobsPath, "utf8"));
const save = (file, value) => { fs.writeFileSync(file + ".next", JSON.stringify(value)); fs.renameSync(file + ".next", file); };
const reply = (value) => console.log(JSON.stringify(value));
if (args[0] === "env") reply({ configPath: path.join(root, "config.json") });
else if (args[3] === "status") reply({ enabled: true });
else if (args[3] === "add") {
  save(jobsPath, [...jobs(), { id: "owned-job", name: args[args.indexOf("--name") + 1] }]);
  reply({ id: "owned-job" });
} else if (args[3] === "run") {
  save(path.join(root, "pending.json"), { pid: process.pid, ownerPid: process.ppid });
  setTimeout(() => process.exit(2), 15000);
} else if (args[3] === "rm") {
  const started = Date.now();
  setTimeout(() => {
    save(jobsPath, jobs().filter((job) => job.id !== args[4]));
    save(path.join(root, "removed.json"), { started, finished: Date.now() });
    reply({ removed: true });
  }, 1400);
} else if (args[3] === "list") reply({ jobs: jobs() });
else process.exit(2);
`);
  await chmod(join(bin, "ocm"), 0o755);
  return bin;
}

for (const shell of ["/bin/sh", "/bin/bash"]) test(`verification shutdown through ${shell} joins cooperative cron cleanup before removing clones`, { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kova-verify-helper-shutdown-"));
  const copies = names.map((name) => join(directory, "copies", `kova-helpers-shutdown-${name}`));
  let child, completion;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await completion;
    // An old runner can exit before its detached helper. Join the helper's
    // bounded cleanup even when the assertions below expose that regression.
    try {
      await waitFor(async () => (await Promise.all(copies.map(async (copy) => {
        if (!await optionalJSON(join(copy, "pending.json"))) return true;
        const output = await readJSON(join(copy, "output.json"));
        return Boolean(await optionalJSON(join(output, "cron", "cron-runtime-smoke.json")));
      }))).every(Boolean), 12000, "detached cron cleanup did not settle");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const bin = await prepare(directory);
  const env = { ...process.env, SHELL: shell, PATH: `${bin}${delimiter}${process.env.PATH}`, KOVA_SHUTDOWN_TEST_ROOT: directory };
  delete env.KOVA_OCM_TRANSPORT_JSON;
  delete env.NODE_OPTIONS;
  completion = new Promise((resolve) => {
    child = execFile(process.execPath, [fileURLToPath(new URL("./fixtures/verify-helper-shutdown-runner.mjs", import.meta.url)), directory], {
      env, timeout: 20000, killSignal: "SIGKILL"
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      const completed = await completion;
      const events = await readFile(join(directory, "events.jsonl"), "utf8").catch(() => "");
      throw new Error(`runner exited before cron became pending: ${completed.stderr || completed.stdout}; ${events}`);
    }
    return (await Promise.all(copies.map((copy) => optionalJSON(join(copy, "pending.json"))))).every(Boolean);
  }, 7000, "cron commands did not become pending");
  const sentAt = Date.now();
  assert.equal(child.kill("SIGTERM"), true);
  const completed = await completion;
  assert.equal(completed.error?.code, 143, completed.stderr || completed.stdout);
  assert.equal(completed.stderr, "");
  const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "outer-signal").length, 1);
  const catalogue = await readJSON(join(repoRoot, "catalogue/openclaw.json"));
  const declaredKeys = catalogue.entries.find((entry) => entry.id === "cron-runtime-smoke").prints;
  const cleanups = events.filter((event) => event.type === "clone-cleanup");
  assert.equal(cleanups.length, names.length);
  for (const cleanup of cleanups) {
    assert.equal(cleanup.command?.status, 3, JSON.stringify(cleanup.command));
    assert.equal(cleanup.command.timedOut, false);
    assert.equal(cleanup.command.signal, null);
    assert.equal(cleanup.command.stderr, "");
    const output = JSON.parse(cleanup.command.stdout);
    assert.deepEqual(Object.keys(output).sort(), [...declaredKeys].sort());
    assert.equal(output.error, "interrupted by SIGTERM");
    assert.equal(cleanup.helper?.cancelled, true);
    assert.equal(cleanup.helper.cleanupComplete, true, cleanup.helper.cleanupError);
    assert.deepEqual(cleanup.jobs, [borrowed]);
    const copy = join(directory, "copies", cleanup.env), removed = await readJSON(join(copy, "removed.json"));
    assert.ok(removed.started >= sentAt);
    assert.ok(removed.finished - removed.started >= 1300, "cleanup must exceed the old one-second shutdown cutoff");
    assert.ok(cleanup.at >= removed.finished, "clone cleanup must follow job removal");
    assert.deepEqual(await readJSON(join(copy, "jobs.json")), [borrowed]);
  }
  assert.deepEqual(events.find((event) => event.type === "run-finished")?.cleanupErrors, []);
  const dispatches = events.filter((event) => event.type === "dispatch");
  const setup = dispatches.find(({ tokens }) => tokens.join(" ") === "ocm --version");
  assert.equal(setup?.finishOnShutdown, true);
  assert.equal(Boolean(setup?.signalOnShutdown), false);
  const legacy = dispatches.filter(({ tokens }) => tokens[0] === "ocm" && tokens[1]?.startsWith("@"));
  assert.equal(legacy.length, names.length);
  assert.ok(legacy.every((event) => event.finishOnShutdown === false && !event.signalOnShutdown));
  const recovery = dispatches.filter(({ tokens }) => tokens[1]?.endsWith("/stage-session-store-fixture.mjs"));
  assert.equal(recovery.length, names.length);
  assert.ok(recovery.every((event) => event.finishOnShutdown === true && !event.signalOnShutdown));
});
