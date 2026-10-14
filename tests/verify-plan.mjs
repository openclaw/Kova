import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchesPaths, selectPhases } from "../src/verify/select.mjs";
import { canonicalJSON, loadPlanInputs, sha256, validateTemplate } from "../src/verify/plan.mjs";
import { checkCatalogueCommands, parseCatalogueCommand } from "../src/catalogue.mjs";

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

test("intent phases cannot hide unmapped paths, even when active or withheld", () => {
  for (const options of [{}, { requires: ["missing"] }, { commands: [write] }]) {
    const result = select({ paths: ["unowned/file.ts"], extraPhases: { phases: [phase("extra", { paths: ["unowned/**"], from: "intent:goal", ...options })] }, catalogue: { ...catalogue, entries: entries.map((entry) => entry.id === "write" ? { ...entry, status: "toWrite" } : entry) } });
    assert.deepEqual(result.unmapped, ["no template for unowned/file.ts"]);
    const withheld = Boolean(options.requires || options.commands);
    assert.equal(result.withheld.some((item) => item.id === "intent/extra"), withheld);
    assert.equal(ids(result).includes("intent/extra"), !withheld);
  }
});

test("dependencies close across sources and setup, without selecting unrelated slow phases", () => {
  const result = select({ templates: [
    template("alpha", [phase("consumer", { commands: [`${read} --session-from={run}/child.json`] }), phase("slow", { paths: ["slow/**"], slow: true })]),
    template("zeta", [phase("prepare", { kind: "setup", paths: [] }), phase("producer", { paths: [], commands: [`${write} --from {run}/parent.json --out {run}/child.json`] })]),
  ], extraPhases: { phases: [phase("parent", { paths: [], from: "intent:goal", commands: [`${write} --out {run}/parent.json`] })] } });
  assert.deepEqual(ids(result), ["standard/start", "zeta/prepare", "intent/parent", "zeta/producer", "alpha/consumer", "standard/stop"]);
});

test("setup-only selection includes every sibling setup and its missing traits", () => {
  const result = select({ templates: [template("sessions", [phase("first", { kind: "setup" }), phase("second", { kind: "setup", paths: [], requires: ["missing"] })])] });
  assert.deepEqual(ids(result), ["standard/start", "standard/stop"]);
  assert.deepEqual(result.withheld.map((item) => item.id), ["sessions/first", "sessions/second"]);
  assert.ok(result.withheld[0].missing.includes("phase:sessions/second"));
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

test("substituted positional values must still pass the catalogue", () => {
  const command = "ocm @{env} -- sessions archive";
  const entry = { ...entries[0], id: "archive", kind: "product", wraps: "sessions archive", command: `${command} <key> --json`, flags: { "--json": flag("none") }, side: "destructive" };
  assert.throws(() => select({ catalogue: { ...catalogue, entries: [...entries, entry] }, persona: { traits: { history: { keys: { key: "--not-a-flag" } } } }, templates: [template("sessions", [phase("archive", { commands: [`${command} {persona:history:key} --json`] })])] }), /catalogue check refused plan.*unlisted-/);
  assert.throws(() => select({ persona: { traits: { history: { keys: { key: "1..3" } } } }, templates: [template("sessions", [phase("expand", { commands: [`${read} --value {{persona:history:key}}`] })])] }), /catalogue check refused plan.*shell/);
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
  const intent = select({ persona, extraPhases: { phases: [phase("delete", { from: "intent:goal", commands: [`${remove} --value {persona:history:key}`] }), phase("reader", { from: "intent:protected", requires: ["history"] }), phase("prepare", { from: "intent:protected", kind: "setup" })] } });
  assert.deepEqual(ids(intent), ["standard/start", "intent/prepare", "intent/reader", "intent/delete", "standard/stop"]);
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
  assert.doesNotMatch(JSON.stringify(sessions.phases), /\{persona:[^}:]+:(?:processId|instanceId|inputId|queuedInputId)\}/);
  const missingIdentities = selectPhases({ ...inputs, paths: ["src/gateway/server-methods/sessions-sharing.ts", "src/gateway/server-methods/session-processes.ts"], persona: { traits: {
    "session-shared-readonly": { keys: {} }, "session-workspace-changes": { keys: {} },
  } } });
  for (const [id, keys] of [["share-session", ["key:session-shared-readonly:sessionId", "key:session-shared-readonly:memberIdentityId", "key:session-shared-readonly:suggestionId"]], ["session-files-changes", ["key:session-workspace-changes:sessionId"]]]) {
    const withheld = missingIdentities.withheld.find((item) => item.id === `sessions/${id}`);
    for (const key of keys) assert.ok(withheld?.missing.includes(key), key);
  }
  assert.throws(() => validateTemplate({ ...sessions, phases: [sessions.phases[0], sessions.phases[0]] }), /duplicate phase/);
});

test("sessions caller paths select the phases that exercise them", async () => {
  const inputs = await loadPlanInputs();
  const cases = [
    ["src/commands/sessions.ts", ["browse-sessions"]],
    ["src/commands/sessions-table.ts", ["browse-sessions"]],
    ["src/commands/sessions-display-model.ts", ["browse-sessions"]],
    ["src/commands/sessions-tail.ts", ["inspect-status"]],
    ["src/commands/sessions-lifecycle.ts", ["archive-restore", "delete-session"]],
    ["src/commands/sessions-compact.ts", ["compact-session"]],
    ["src/commands/sessions-cleanup.ts", ["maintain-session-store"]],
    ["src/commands/sessions-cleanup.runtime.ts", ["maintain-session-store"]],
    ["src/cli/program/register.status-health-sessions.ts", ["browse-sessions", "inspect-status", "archive-restore", "delete-session", "compact-session", "maintain-session-store", "import-transcript", "export-session"]],
    ["ui/src/lib/session-progress-cards.ts", ["publish-progress"]],
    ["ui/src/pages/config/session-storage.ts", ["maintain-session-store"]],
  ];
  for (const [path, expected] of cases) {
    const result = selectPhases({ ...inputs, paths: [path], persona: { traits: {} } });
    assert.deepEqual(result.unmapped, [], path);
    const selected = new Set([...result.phases, ...result.withheld].map((item) => item.id));
    for (const id of expected) assert.ok(selected.has(`sessions/${id}`), `${path}: ${id}`);
  }
});

test("sessions Gateway requests match the pinned OpenClaw schemas", async (t) => {
  const checkout = process.env.KOVA_OPENCLAW_CHECKOUT;
  if (!checkout) return t.skip("Set KOVA_OPENCLAW_CHECKOUT to the pinned OpenClaw checkout");
  try { await access(checkout); } catch (error) {
    if (error.code === "ENOENT") return t.skip("OpenClaw checkout is absent");
    throw error;
  }
  const revision = "7e80556f503d26ddde64e274bfb50cbbec7830f5";
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), revision);
  const require = createRequire(join(resolve(checkout), "package.json"));
  const { createJiti } = require("jiti");
  const jiti = createJiti(join(resolve(checkout), "package.json"), {
    fsCache: false,
    alias: { "@openclaw/normalization-core": join(resolve(checkout), "packages/normalization-core/src") },
  });
  const schemas = await jiti.import(join(resolve(checkout), "packages/gateway-protocol/src/schema-modules.ts"));
  const { Compile } = await jiti.import("typebox/schema");
  // These method names share or abbreviate schemas in their actual handlers.
  const aliases = {
    "sessions.subscribe": "SessionsListParamsSchema",
    "sessions.github.options": "SessionGitHubOptionsParamsSchema",
    "sessions.github.status": "SessionGitHubStatusParamsSchema",
    "session.members.add": "SessionMemberAddParamsSchema",
    "session.members.remove": "SessionMemberRemoveParamsSchema",
    "session.members.listEvidence": "SessionMembersListParamsSchema",
    "sessions.storage.status": "SessionsStorageParamsSchema",
    "sessions.storage.run": "SessionsStorageParamsSchema",
  };
  const { templates } = await loadPlanInputs();
  const sessions = templates.find((item) => item.id === "sessions");
  const handles = new Map(), validators = new Map(), failures = [], outputs = new Map(), processStarts = new Map();
  let requests = 0, joins = 0;
  for (const phase of sessions.phases) for (const command of phase.commands) {
    const { tokens, findings } = parseCatalogueCommand(command);
    assert.deepEqual(findings, [], phase.id);
    const flag = (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
    if (tokens[1] === "{kovaRoot}/support/verify/agent-tool-turn.mjs" && flag("--tool") === "exec") {
      const args = JSON.parse(flag("--args"));
      assert.equal(args.background, true, phase.id);
      assert.ok(args.timeoutSeconds > 0, phase.id);
      processStarts.set(phase.id, flag("--session-key"));
    }
    if (tokens[1] !== "{kovaRoot}/support/verify/gateway-call.mjs") continue;
    const method = flag("--method"), label = `${phase.id}: ${method}`;
    if (flag("--wait")) {
      assert.equal(handles.get(flag("--wait")), method, label);
      joins += 1;
      continue;
    }
    if (flag("--handle")) handles.set(flag("--handle"), method);
    // The manifest supplies a hexadecimal content hash, not the placeholder text.
    const params = JSON.parse((flag("--params") ?? "{}").replaceAll("{persona:session-workspace-changes:fileHash}", "a".repeat(64)));
    if (flag("--merge-from")) {
      // These descriptions supply optimistic-concurrency expectations.
      const fixtures = {
        "{run}/archive-describe.json": { method: "sessions.patch", params: { expectedSessionId: "fixture-session", expectedLifecycleRevision: "1" } },
        "{run}/reset-describe.json": { method: "sessions.reset", params: { expectedSessionId: "fixture-session" } },
      };
      const fixture = fixtures[flag("--merge-from")];
      assert.equal(fixture?.method, method, `${label}: missing merge fixture`);
      Object.assign(params, fixture.params);
    }
    requests += 1;
    if (method === "sessions.get") {
      // This handler has no ParamsSchema: sessions-read-by-key.ts accepts key/sessionKey,
      // optional agentId and a positive limit. Keep this exception explicit.
      if (flag("--session-from")) params.key = "agent:main:fixture";
      assert.equal(typeof (params.key ?? params.sessionKey), "string", label);
      assert.ok((params.key ?? params.sessionKey).trim(), label);
      assert.ok(params.limit === undefined || (Number.isInteger(params.limit) && params.limit > 0), label);
      assert.ok(params.agentId === undefined || (typeof params.agentId === "string" && params.agentId.trim()), label);
      assert.ok(Object.keys(params).every((key) => ["key", "sessionKey", "agentId", "limit"].includes(key)), label);
      continue;
    }
    const name = aliases[method] ?? `${method.split(".").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}ParamsSchema`;
    const schema = schemas[name];
    assert.ok(schema, `${label}: missing ${name}`);
    if (flag("--session-from")) {
      const keys = ["key", "sessionKey"].filter((key) => schema.properties?.[key]);
      assert.equal(keys.length, 1, `${label}: ambiguous session identity`);
      assert.equal(params[keys[0]], undefined, `${label}: duplicate session identity`);
      params[keys[0]] = "agent:main:fixture";
    }
    if (flag("--from")) {
      const source = outputs.get(flag("--from"));
      assert.equal(source?.phase, phase.id, `${label}: input must be written earlier in this phase`);
      assert.equal(source.params.key, params.key, `${label}: input belongs to another session`);
      if (method === "sessions.setInvolvement") {
        assert.equal(source.method, "sessions.describe", label);
        assert.equal(params.expectedSessionId, undefined, `${label}: identity must come from the read`);
        params.expectedSessionId = source.result.session.sessionId;
      } else if (method === "sessions.processes.stop") {
        assert.equal(source.method, "sessions.processes.list", label);
        assert.equal(source.result.sessionId, params.sessionId, label);
        assert.equal(source.result.truncated, false, label);
        const matches = source.result.processes.filter((item) => item.status === "running" && item.canStop);
        assert.equal(matches.length, 1, `${label}: process identity must match exactly once`);
        assert.equal(params.processId, undefined, `${label}: process id must come from the read`);
        assert.equal(params.instanceId, undefined, `${label}: incarnation must come from the read`);
        params.processId = matches[0].processId;
        params.instanceId = matches[0].instanceId;
      } else assert.fail(`${label}: missing --from contract`);
    }
    if (flag("--out")) {
      // Synthetic read results exercise the declared input mapping, not live handlers.
      const result = method === "sessions.describe" ? { session: { key: params.key, sessionId: "fixture-session" } }
        : method === "sessions.processes.list" ? {
          sessionId: "{persona:session-workspace-changes:sessionId}",
          processes: [{ processId: "fixture-process", instanceId: "fixture-incarnation", name: "fixture", status: "running", startedAt: 1, tail: "", truncated: false, canStop: true }],
          truncated: false,
        } : undefined;
      if (method === "sessions.processes.list") {
        assert.equal(processStarts.get(phase.id), params.key, `${label}: process must start earlier in this phase and session`);
        assert.ok(Compile(schemas.SessionsProcessesListResultSchema).Check(result), label);
      }
      outputs.set(flag("--out"), { phase: phase.id, method, params, result });
    }
    if (!validators.has(name)) validators.set(name, Compile(schema));
    const validator = validators.get(name);
    if (!validator.Check(params)) failures.push(`${label}: ${JSON.stringify(validator.Errors(params))}`);
  }
  assert.equal(requests, 179);
  assert.equal(joins, 2);
  t.diagnostic(`${requests} Gateway requests and ${joins} handle joins checked at ${revision}`);
  assert.deepEqual(failures, []);
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
