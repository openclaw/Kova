import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchesPaths, selectPhases } from "../src/verify/select.mjs";
import { canonicalJSON, loadPlanInputs, loadTemplates, sha256, validateTemplate } from "../src/verify/plan.mjs";
import { checkCatalogueCommands } from "../src/catalogue.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = (value = "required") => ({ description: "input", value });
const read = "node {kovaRoot}/support/read.mjs";
const write = "node {kovaRoot}/support/write.mjs";
const remove = "node {kovaRoot}/support/remove.mjs";
const entries = [read, write, remove].map((command, i) => ({ id: ["read", "write", "remove"][i], kind: "script", wraps: ["read", "write", "remove"][i], command, flags: { "--out": flag(), "--handle": flag(), "--wait": flag(), "--from": flag(), "--session-from": flag(), "--value": flag(), "--background": flag("none") }, prints: [], creates: [], side: ["read", "write", "destructive"][i], background: false, status: "existing" }));
const catalogue = { schema: "kova.verify.catalogue.v1", product: "openclaw", revision: "example", entries };
const phase = (id, options = {}) => ({ id, kind: "operation", intent: "Read the stored result.", paths: ["src/**"], requires: [], commands: [read], checkpoint: ["responses"], timeoutMs: 1000, browser: false, slow: false, ...options });
const template = (id, phases) => ({ schema: "kova.verify.template.v1", id, title: id, objective: "Exercise this area.", paths: ["src/**"], requires: [], support: { existing: [], toWrite: [] }, phases });
const standard = { ignore: { documentation: ["docs/**", "**/*.md", "!docs/reference/templates/**", "!skills/**"], tests: ["**/*.test.ts", "test/**"] }, before: [{ id: "start", commands: [read], checkpoint: [], timeoutMs: 1000 }], after: [{ id: "stop", commands: [read], checkpoint: [], timeoutMs: 1000 }] };
const select = (overrides = {}) => selectPhases({ paths: ["src/a.ts"], standard, templates: [], areas: [], persona: { traits: {} }, catalogue, ...overrides });
const ids = (result) => result.phases.map((item) => item.id);

test("ignore exclusions are order independent and shipped content remains selectable", () => {
  for (const globs of [["**/*.md", "!skills/**"], ["!skills/**", "**/*.md"]]) {
    assert.equal(matchesPaths("skills/example/SKILL.md", globs), false);
    assert.equal(matchesPaths("README.md", globs), true);
  }
  assert.equal(matchesPaths("src/config/io.ts", ["src/config/[a-z]*.ts"]), true);
  const empty = select({ paths: ["docs/a.md", "src/a.test.ts"] });
  assert.deepEqual(ids(empty), []);
  assert.deepEqual(empty.ignored, ["docs/a.md", "src/a.test.ts"]);
  assert.deepEqual(empty.unmapped, []);
  assert.deepEqual(ids(select({ paths: ["skills/example/SKILL.md"] })), ["standard/start", "standard/stop"]);
});

test("selection uses every phase's paths, records area ownership and retains standard phases", () => {
  const result = select({ paths: ["src/other/caller.ts", "src/owned/a.ts", "unknown.ts"], templates: [template("sessions", [phase("caller", { paths: ["src/other/**"] })])], areas: [{ id: "sessions", paths: ["src/owned/**"] }] });
  assert.deepEqual(ids(result), ["standard/start", "sessions/caller", "standard/stop"]);
  assert.deepEqual(result.unmapped, ["no phase for src/owned/a.ts in sessions", "no template for unknown.ts"]);
  assert.equal(result.phases[1].from, "template:sessions");
  assert.deepEqual(select({ paths: ["package.json", "support/input.ts"], areas: [{ id: "config", paths: [], bound: { includes: ["package.json: shipped configuration", "support/input.ts: product entry"] } }] }).unmapped, ["no phase for package.json in config", "no phase for support/input.ts in config"]);
});

test("dependencies close across sources and setup, without selecting unrelated slow phases", () => {
  const result = select({ templates: [
    template("alpha", [phase("consumer", { commands: [`${read} --session-from={run}/child.json`] }), phase("slow", { paths: ["slow/**"], slow: true })]),
    template("zeta", [phase("prepare", { kind: "setup", paths: [] }), phase("producer", { paths: [], commands: [`${write} --from {run}/parent.json --out {run}/child.json`] })]),
  ], extraPhases: { phases: [phase("parent", { paths: [], from: "intent:goal", commands: [`${write} --out {run}/parent.json`] })] } });
  assert.deepEqual(ids(result), ["standard/start", "zeta/prepare", "intent/parent", "zeta/producer", "alpha/consumer", "standard/stop"]);
});

test("traits, keys and toWrite entries are withheld transitively, including setup peers", () => {
  const result = select({ templates: [template("sessions", [
    phase("prepare", { kind: "setup", requires: ["held-turn"], paths: [] }),
    phase("prepare-peer", { kind: "setup", paths: [] }),
    phase("writer", { commands: [`${write} --out {run}/result.json --value {persona:present:missing}`] }),
    phase("reader", { commands: [`${read} --from {run}/result.json`] }),
  ])], persona: { traits: { present: { keys: {} } } }, catalogue: { ...catalogue, entries: entries.map((entry) => entry.id === "write" ? { ...entry, status: "toWrite" } : entry) } });
  assert.deepEqual(ids(result), ["standard/start", "standard/stop"]);
  const missing = Object.fromEntries(result.withheld.map((item) => [item.id, item.missing]));
  assert.ok(missing["sessions/prepare"].includes("trait:held-turn"));
  assert.ok(missing["sessions/prepare-peer"].includes("phase:sessions/prepare"));
  assert.ok(missing["sessions/writer"].includes("key:present:missing"));
  assert.ok(missing["sessions/writer"].includes("entry:write"));
  assert.ok(missing["sessions/reader"].includes("phase:sessions/writer"));
});

test("persona keys resolve only after checking written commands and environment keys remain symbolic", () => {
  const source = template("sessions", [phase("read", { commands: [`${read} --value '{"key":"{persona:history:key}","env":"{persona:second:env}"}'`] })]);
  const result = select({ templates: [source], persona: { traits: { history: { keys: { key: "agent:main:known" } }, second: { keys: { env: "durable-second" } } } } });
  assert.match(result.phases[1].commands[0], /agent:main:known/);
  assert.match(result.phases[1].commands[0], /\{persona:second:env\}/);
  assert.match(source.phases[0].commands[0], /\{persona:history:key\}/);
  assert.throws(() => select({ templates: [source], persona: { traits: { history: { keys: { key: "bad' value" } }, second: { keys: { env: "safe" } } } } }), /unsafe persona key/);
});

test("catalogue errors refuse even a phase already missing its persona", () => {
  for (const command of ["node absent.mjs", `${read} --unknown value`, `${read}; echo bad`, `${read} --value {target}`]) {
    assert.throws(() => select({ templates: [template("sessions", [phase("bad", { requires: ["absent"], commands: [command] })])] }), /catalogue check refused plan/);
  }
});

test("missing, ambiguous and forward self file dependencies are refused", () => {
  assert.throws(() => select({ templates: [template("sessions", [phase("read", { commands: [`${read} --from {run}/missing.json`] })])] }), /no writer.*missing.json/);
  assert.throws(() => select({ templates: [template("sessions", [phase("a", { commands: [`${write} --out {run}/same.json`] }), phase("b", { commands: [`${write} --out {run}/same.json`] })])] }), /multiple writers.*sessions\/a.*sessions\/b/);
  assert.throws(() => select({ templates: [template("sessions", [phase("read", { commands: [`${read} --from {run}/self.json`, `${write} --out {run}/self.json`] })])] }), /before writing/);
  assert.deepEqual(ids(select({ templates: [template("sessions", [phase("same", { commands: [`${write} --out {run}/self.json`, `${read} --from {run}/self.json`] })])] })), ["standard/start", "sessions/same", "standard/stop"]);
  assert.throws(() => select({ templates: [template("sessions", [phase("escape", { commands: [`${write} --out {run}/../outside`] })])] }), /invalid run file/);
  const persona = { traits: { output: { keys: { one: "same", two: "same", escape: "../outside" } } } };
  assert.throws(() => select({ persona, templates: [template("sessions", [phase("a", { commands: [`${write} --out {run}/{persona:output:one}`] }), phase("b", { commands: [`${write} --out {run}/{persona:output:two}`] })])] }), /multiple writers/);
  assert.throws(() => select({ persona, templates: [template("sessions", [phase("escape", { commands: [`${write} --out {run}/{persona:output:escape}`] })])] }), /invalid run file/);
});

test("ordering honors destruction, source order and intent kinds and refuses cycles", () => {
  const persona = { traits: { history: { keys: { key: "known" } } } };
  const result = select({ persona, templates: [template("alpha", [phase("delete", { commands: [`${remove} --value {persona:history:key}`] })]), template("zeta", [phase("read", { requires: ["history"] })])] });
  assert.deepEqual(ids(result), ["standard/start", "zeta/read", "alpha/delete", "standard/stop"]);
  assert.throws(() => select({ persona, templates: [template("sessions", [phase("delete", { commands: [`${remove} --value {persona:history:key}`] }), phase("read", { requires: ["history"] })])] }), /phase order conflicts.*sessions\/delete.*sessions\/read/);
  const kinds = select({ templates: [template("zeta", [phase("event", { kind: "event" })])], extraPhases: { phases: [phase("extra", { from: "intent:protected", kind: "setup", paths: [] })] } });
  assert.deepEqual(ids(kinds), ["standard/start", "intent/extra", "zeta/event", "standard/stop"]);
});

test("loader reads the shipped sessions template and standard commands pass the catalogue", async () => {
  const inputs = await loadPlanInputs();
  const sessions = inputs.templates.find((item) => item.id === "sessions");
  assert.ok(sessions.phases.some((item) => item.id === "search-history"));
  const findings = checkCatalogueCommands(inputs.catalogue, [...inputs.standard.before, ...inputs.standard.after].flatMap((item) => item.commands.map((command) => ({ command, standard: true }))));
  assert.deepEqual(findings, []);
  const all = checkCatalogueCommands(inputs.catalogue, sessions.phases.flatMap((item) => item.commands.map((command) => ({ command }))));
  assert.deepEqual(all.filter((item) => item.code !== "toWrite"), []);
  assert.ok(all.some((item) => item.code === "toWrite"));
  assert.throws(() => validateTemplate({ ...sessions, phases: [sessions.phases[0], sessions.phases[0]] }), /duplicate phase/);
});

test("canonical phase hashing ignores object key insertion order and retains array order", () => {
  assert.equal(sha256(canonicalJSON([{ z: 1, a: { y: 2, x: 3 } }])), sha256(canonicalJSON([{ a: { x: 3, y: 2 }, z: 1 }])));
  assert.notEqual(sha256(canonicalJSON([1, 2])), sha256(canonicalJSON([2, 1])));
});

test("real CLI writes sessions and docs-only plans, and refuses a planted command without replacing output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kova-verify-plan-"));
  try {
    const repo = join(dir, "repo"); await mkdir(join(repo, "src/config/sessions"), { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--quiet"); git("config", "user.name", "Kova Test"); git("config", "user.email", "kova-test@example.invalid"); git("remote", "add", "origin", "git@github.com:openclaw/openclaw.git");
    const file = join(repo, "src/config/sessions/session-transcript-search.ts"); await writeFile(file, "export const value = 1;\n"); git("add", "."); git("commit", "--quiet", "-m", "baseline"); const baseline = git("rev-parse", "HEAD");
    await writeFile(file, "export const value = 2;\n"); git("commit", "--quiet", "-am", "change"); const change = git("rev-parse", "HEAD");
    const intent = join(dir, "intent.txt"), manifest = join(dir, "persona.json"), out = join(dir, "plan.json"), extra = join(dir, "extra.json");
    await writeFile(intent, "Goal: Search saved history.\nProtected: Other history stays available.\n");
    const traits = Object.fromEntries(["agents-three-configured", "mock-provider-scripted", "channels-test-accounts", "plugins-bundled-and-external", "config-hand-edited"].map((trait) => [trait, { keys: {}, checkedAt: "2026-10-13T00:00:00Z" }]));
    const bytes = JSON.stringify({ schema: "kova.verify.persona-manifest.v1", persona: "openclaw-verification-user", version: "20261013T000000Z", runtime: { selector: "npm:2026.9.9", resolved: "2026.9.9" }, definition: { path: "definition.json", sha256: "example" }, env: { name: "example", export: "example.tar", sha256: "example" }, doctor: "", traits });
    await writeFile(manifest, bytes);
    const invoke = (...additional) => spawnSync(process.execPath, [join(root, "bin/kova.mjs"), "verify", "plan", "--repo", repo, "--baseline", baseline, "--change", change, "--intent", intent, "--persona", manifest, "--out", out, ...additional], { encoding: "utf8" });
    let result = invoke(); assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(await readFile(out));
    assert.equal(plan.change.repo, "openclaw/openclaw"); assert.equal(plan.change.baseline, baseline); assert.equal(plan.change.change, change);
    assert.equal(plan.persona.sha256, sha256(bytes)); assert.equal(plan.persona.manifest, resolve(manifest));
    assert.deepEqual(plan.change.paths, ["src/config/sessions/session-transcript-search.ts"]);
    assert.ok(plan.withheld.some((item) => item.id === "sessions/search-history" && item.missing.includes("trait:session-long-compacted")));
    assert.ok(plan.withheld.some((item) => item.missing.some((reason) => reason.startsWith("entry:"))));
    assert.deepEqual(plan.unmapped, []);
    assert.deepEqual(plan.phases.map((item) => item.id), ["standard/use-target", "standard/start-gateway", "standard/status-before", "standard/status-after", "standard/doctor", "standard/stop-gateway", "standard/snapshot"]);
    const before = await readFile(out, "utf8");
    await writeFile(extra, JSON.stringify({ phases: [phase("bad", { from: "intent:goal", commands: ["node not-in-catalogue.mjs"] })] }));
    result = invoke("--extra-phases", extra); assert.equal(result.status, 1); assert.match(result.stderr, /unlisted-command/); assert.equal(await readFile(out, "utf8"), before);
    await mkdir(join(repo, "docs")); await writeFile(join(repo, "docs/guide.md"), "# Guide\n"); git("add", "."); git("commit", "--quiet", "-m", "docs");
    result = invoke("--baseline", change, "--change", "HEAD", "--json"); assert.equal(result.status, 0, result.stderr);
    const empty = JSON.parse(result.stdout); assert.deepEqual(empty.phases, []); assert.deepEqual(empty.ignored, ["docs/guide.md"]); assert.deepEqual(empty.withheld, []);
    result = invoke("--change", "--bad"); assert.equal(result.status, 1);
    result = invoke("--invented", "true"); assert.equal(result.status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
