import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchesPaths, selectPhases } from "../src/verify/select.mjs";
import { canonicalJSON, loadPlanInputs, sha256, validateTemplate } from "../src/verify/plan.mjs";
import { checkCatalogueCommands, parseCatalogueCommand } from "../src/catalogue.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = (value = "required") => ({ description: "input", value });
const read = "node {kovaRoot}/support/read.mjs";
const write = "node {kovaRoot}/support/write.mjs";
const remove = "node {kovaRoot}/support/remove.mjs";
const entries = [read, write, remove].map((command, i) => ({ id: ["read", "write", "remove"][i], kind: "script", wraps: ["read", "write", "remove"][i], command, flags: { "--out": flag(), "--handle": flag(), "--wait": flag(), "--from": flag(), "--session-from": flag(), "--gateway-handle": flag(), "--value": flag(), "--background": flag("none") }, prints: [], creates: [], side: ["read", "write", "destructive"][i], background: false, status: "existing" }));
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

test("loader validates shipped commands and exposes unfinished standard helpers", async () => {
  const inputs = await loadPlanInputs();
  const sessions = inputs.templates.find((item) => item.id === "sessions");
  assert.ok(sessions.phases.some((item) => item.id === "search-history"));
  const findings = checkCatalogueCommands(inputs.catalogue, [...inputs.standard.before, ...inputs.standard.after].flatMap((item) => item.commands.map((command) => ({ command, standard: true }))));
  assert.ok(findings.every((finding) => finding.code === "toWrite"));
  assert.deepEqual(findings.map((finding) => finding.entryId).sort(), ["foreground-gateway-start", "foreground-gateway-stop"]);
  const all = checkCatalogueCommands(inputs.catalogue, sessions.phases.flatMap((item) => item.commands.map((command) => ({ command }))));
  assert.deepEqual(all.filter((item) => item.code !== "toWrite"), []);
  assert.ok(all.some((item) => item.code === "toWrite"));
  assert.doesNotMatch(JSON.stringify(sessions.phases), /\{persona:[^}:]+:(?:processId|instanceId|inputId|queuedInputId|cancelRunId|yieldingChildKey)\}/);
  const missingIdentities = selectPhases({ ...inputs, paths: ["src/gateway/server-methods/sessions-sharing.ts", "src/gateway/server-methods/session-processes.ts"], persona: { traits: {
    "session-shared-readonly": { keys: {} }, "session-workspace-changes": { keys: {} },
  } } });
  for (const [id, keys] of [["share-session", ["key:session-shared-readonly:sessionId", "key:session-shared-readonly:memberIdentityId", "key:session-shared-readonly:suggestionId"]], ["session-files-changes", ["key:session-workspace-changes:sessionId"]]]) {
    const withheld = missingIdentities.withheld.find((item) => item.id === `sessions/${id}`);
    for (const key of keys) assert.ok(withheld?.missing.includes(key), key);
  }
  assert.throws(() => validateTemplate({ ...sessions, phases: [sessions.phases[0], sessions.phases[0]] }), /duplicate phase/);
});

test("sessions plans order every available phase and ordinary owner selections", async () => {
  const inputs = await loadPlanInputs();
  const sessions = inputs.templates.find((item) => item.id === "sessions");
  const traits = Object.fromEntries(sessions.requires.map((trait) => [trait, { keys: {} }]));
  for (const phase of sessions.phases) for (const command of phase.commands) {
    for (const [, trait, key] of command.matchAll(/\{persona:([^}:]+):([^}]+)\}/g)) {
      traits[trait].keys[key] = `fixture-${trait}-${key}`;
    }
  }
  // Availability is simulated; planning executes none of these unfinished helpers.
  const catalogue = { ...inputs.catalogue, entries: inputs.catalogue.entries.map((entry) => ({ ...entry, status: "existing" })) };
  const all = selectPhases({ ...inputs, catalogue, templates: [{ ...sessions, phases: sessions.phases.map((phase) => ({ ...phase, paths: ["all"] })) }], paths: ["all"], persona: { traits } });
  assert.deepEqual(all.withheld, []);
  assert.equal(all.phases.length, sessions.phases.length + inputs.standard.before.length + inputs.standard.after.length);
  for (const [path, operation] of [["src/gateway/server-methods/sessions-create.ts", "start-new-session"], ["src/agents/tools/subagents-tool.ts", "run-subagents"], ["src/config/sessions/session-transcript-search.ts", "search-history"], ["src/gateway/server-methods/sessions-read.ts", "browse-sessions"], ["ui/src/components/app-sidebar.ts", "read-history-ui"]]) {
    const result = selectPhases({ ...inputs, catalogue, paths: [path], persona: { traits } });
    assert.deepEqual(result.withheld, [], path);
    const order = ids(result);
    assert.ok(order.indexOf("sessions/setup-subagents-working") < order.indexOf(`sessions/${operation}`), path);
    for (const missing of ["mock-provider-held-turn", "session-main-rolling", "session-orchestrator-idle"]) {
      const incomplete = { ...traits }; delete incomplete[missing];
      const withheld = selectPhases({ ...inputs, catalogue, paths: [path], persona: { traits: incomplete } });
      assert.ok(withheld.withheld.some((phase) => phase.id === `sessions/${operation}` && phase.missing.some((reason) => reason === `trait:${missing}` || reason.startsWith("phase:sessions/setup-"))), `${path}: ${missing}`);
    }
  }
});

test("sessions restart output coexists with another template's restart handle", async () => {
  const inputs = await loadPlanInputs();
  const peer = template("plugins", [phase("restart", { paths: ["src/plugins/**"], commands: [`${write} --handle {run}/restart-turn.json`] })]);
  const combined = { ...inputs, templates: [...inputs.templates, peer], catalogue: { ...inputs.catalogue, entries: [...inputs.catalogue.entries, ...entries] }, paths: ["src/config/sessions/session-transcript-search.ts"], persona: { traits: {} } };
  const result = selectPhases(combined);
  assert.ok(result.withheld.some((item) => item.id === "sessions/event-gateway-restart-during-work"));
  assert.ok(![...result.phases, ...result.withheld].some((item) => item.id === "plugins/restart"));
  const colliding = structuredClone(combined);
  const restart = colliding.templates.find((item) => item.id === "sessions").phases.find((item) => item.id === "event-gateway-restart-during-work");
  restart.commands = restart.commands.map((command) => command.replaceAll("{run}/sessions-restart-turn.json", "{run}/restart-turn.json"));
  assert.throws(() => selectPhases(colliding), /multiple writers for \{run\}\/restart-turn\.json/);
});

test("sessions identity consumers distinguish callers, children and lifecycle targets", async () => {
  const { templates, catalogue } = await loadPlanInputs();
  const sessions = templates.find((item) => item.id === "sessions");
  const outputs = new Map();
  let consumers = 0, waits = 0, restores = 0, childReads = 0, createdTargets = 0;
  for (const phase of sessions.phases) for (const command of phase.commands) {
    const { tokens } = parseCatalogueCommand(command);
    const flag = (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
    if (tokens[1] === "{kovaRoot}/support/verify/gateway-call.mjs") {
      const params = JSON.parse(flag("--params") ?? "{}");
      if (flag("--method") === "sessions.describe" && flag("--out")) {
        outputs.set(flag("--out"), { method: "sessions.describe", result: { session: { key: params.key, sessionId: "fixture-target-id" } } });
      }
      if (flag("--method") === "sessions.create" && flag("--out")) {
        outputs.set(flag("--out"), { method: "sessions.create", result: { key: params.key ?? "agent:main:created" } });
      }
      const producer = outputs.get(flag("--session-from"));
      if (producer?.tool === "sessions_spawn") {
        // Gateway --session-from consumes top-level sessionKey, never callerSessionKey.
        assert.equal(producer.record.sessionKey, producer.record.toolResult.details.childSessionKey, phase.id);
        assert.notEqual(producer.record.sessionKey, producer.record.callerSessionKey, phase.id);
        childReads += 1;
      }
      continue;
    }
    if (tokens[1] !== "{kovaRoot}/support/verify/agent-tool-turn.mjs") continue;
    if (flag("--wait")) continue;
    const tool = flag("--tool"), args = JSON.parse(flag("--args"));
    const caller = flag("--session-key") ?? flag("--session-from");
    assert.ok(caller, phase.id);
    if (flag("--from")) {
      const producer = outputs.get(flag("--from"));
      if (producer?.method === "sessions.create") {
        assert.ok(["sessions_send", "session_status"].includes(tool), phase.id);
        assert.equal(args.sessionKey, undefined, phase.id);
        args.sessionKey = producer.result.key;
        createdTargets += 1;
      } else if (tool === "sessions" && args.action === "patch" && typeof args.archived === "boolean") {
        assert.equal(producer?.method, "sessions.describe", phase.id);
        assert.equal(producer.result.session.key, args.sessionKey, phase.id);
        assert.equal(args.expectedSessionId, undefined, phase.id);
        args.expectedSessionId = producer.result.session.sessionId;
        restores += 1;
      } else {
        assert.equal(producer?.tool, "sessions_spawn", phase.id);
        assert.equal(producer.record.callerSessionKey, caller, `${phase.id}: spawn must belong to the caller`);
        const result = producer.record.toolResult.details;
        assert.equal(result.status, "accepted", phase.id);
        if (tool === "subagents") {
          const field = args.action === "wait" ? "runIds" : "runId";
          assert.ok(["wait", "cancel"].includes(args.action), phase.id);
          assert.equal(args[field], undefined, phase.id);
          args[field] = field === "runIds" ? [result.runId] : result.runId;
        } else {
          assert.equal(tool, "sessions_send", phase.id);
          assert.equal(args.sessionKey, undefined, phase.id);
          args.sessionKey = result.childSessionKey;
        }
        consumers += 1;
      }
    }
    if (tool === "sessions" && args.action === "patch" && typeof args.archived === "boolean") assert.ok(args.expectedSessionId, phase.id);
    if (tool === "subagents" && args.action === "wait") {
      assert.ok(Array.isArray(args.runIds) && args.runIds.length > 0, phase.id);
      assert.ok(args.timeoutSeconds === undefined || (Number.isInteger(args.timeoutSeconds) && args.timeoutSeconds >= 0 && args.timeoutSeconds <= 60), phase.id);
      waits += 1;
    }
    if (flag("--out")) {
      assert.ok(!outputs.has(flag("--out")), `${phase.id}: duplicate output`);
      const details = { status: "accepted", runId: "fixture-run", childSessionKey: "agent:main:fixture-child" };
      outputs.set(flag("--out"), { tool, record: { callerSessionKey: caller, ...(tool === "sessions_spawn" ? { sessionKey: details.childSessionKey } : {}), toolResult: { details } } });
    }
  }
  assert.equal(consumers, 8);
  assert.equal(waits, 5);
  assert.equal(restores, 1);
  assert.equal(childReads, 1);
  assert.equal(createdTargets, 3);
  const entry = catalogue.entries.find((item) => item.id === "agent-tool-turn");
  assert.ok(entry.flags["--from"]);
  assert.ok(entry.prints.includes("sessionKey"));
  assert.ok(entry.prints.includes("callerSessionKey"));
});

test("reindex searches follow actual import and rewind operations on recorded targets", async () => {
  const { templates } = await loadPlanInputs();
  const phase = templates.find((item) => item.id === "sessions").phases.find((item) => item.id === "event-search-reindex-after-import");
  const outputs = new Map(), rewound = new Set(), searched = new Map();
  for (const command of phase.commands) {
    const { tokens } = parseCatalogueCommand(command);
    const flag = (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
    const method = flag("--method");
    if (method === "sessions.rewind") {
      const input = flag("--session-from");
      assert.equal(outputs.get(input), "sessions.create");
      assert.equal(JSON.parse(flag("--params")).sessionKey, undefined);
      rewound.add(input);
    }
    if (method === "sessions.search") {
      const input = flag("--from"), producer = outputs.get(input);
      assert.ok(producer === "sessions.catalog.import" || (producer === "sessions.create" && rewound.has(input)), "search must follow its import or rewind");
      searched.set(producer, (searched.get(producer) ?? 0) + 1);
    }
    if (flag("--out")) outputs.set(flag("--out"), method);
  }
  assert.equal(searched.get("sessions.catalog.import"), 2);
  assert.equal(searched.get("sessions.create"), 2);
});

test("handle inputs select their writer and enforce producer ordering", () => {
  const result = select({ templates: [template("handles", [
    phase("start", { paths: ["start.ts"], commands: [`${write} --handle {run}/gateway.json`] }),
    phase("fixture", { paths: ["fixture.ts"], commands: [`${read} --gateway-handle {run}/gateway.json`] }),
  ])], paths: ["fixture.ts"] });
  assert.ok(ids(result).indexOf("handles/start") < ids(result).indexOf("handles/fixture"));
  assert.throws(() => select({ templates: [template("handles", [phase("fixture", { commands: [`${read} --gateway-handle {run}/missing.json`] })])] }), /no writer/);
});

test("sessions follow-up commands retain replay, cursor and owned Gateway inputs", async () => {
  const { templates, standard, catalogue } = await loadPlanInputs();
  const phases = templates.find((item) => item.id === "sessions").phases;
  const commands = phases.flatMap((phase) => phase.commands);
  const flags = (command) => {
    const { tokens } = parseCatalogueCommand(command);
    return (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
  };
  const goal = phases.find((phase) => phase.id === "keep-goal").commands;
  const replay = goal.findIndex((command) => command.includes("--replay"));
  const previous = flags(goal[replay - 1]), repeated = flags(goal[replay]);
  assert.equal(previous("--action"), "resume");
  assert.equal(previous("--out"), repeated("--from"));
  const watched = phases.find((phase) => phase.id === "event-watched-session-change").commands;
  const projection = watched.findIndex((command) => command.includes("session-status-cursor.mjs"));
  const source = flags(watched[projection]);
  assert.ok(commands.some((command) => flags(command)("--out") === source("--from")));
  assert.ok(watched.slice(projection + 1).some((command) => flags(command)("--merge-from") === source("--out")));
  const fixture = commands.find((command) => command.includes("stage-session-store-fixture.mjs"));
  const handle = flags(fixture)("--gateway-handle");
  assert.equal(handle, "{run}/gateway.json");
  assert.ok(standard.before.some((phase) => phase.commands.some((command) => flags(command)("--handle") === handle)));
  assert.ok(standard.after.some((phase) => phase.commands.some((command) => flags(command)("--wait") === handle)));
  const compaction = phases.find((phase) => phase.id === "event-auto-compaction");
  assert.ok(compaction.commands.some((command) => flags(command)("--require-auto-compaction") === "true" && flags(command)("--session-key") === "{persona:session-at-compaction-threshold:key}"));
  assert.ok(compaction.checkpoint.includes("responses"));
  assert.match(catalogue.entries.find((entry) => entry.id === "channel-inbound-turn").flags["--peer"].description, /group:<parent>\/thread:<id>/);
});

test("held child tasks invoke the verification tool adapter before holding children", async (t) => {
  const caller = process.env.KOVA_GATEWAY_CALLER;
  if (!caller) return t.skip("Set KOVA_GATEWAY_CALLER to the actual Gateway helper consumer");
  const { selectVerificationReply } = await import(new URL("mock-replies.mjs", pathToFileURL(caller)));
  const { templates } = await loadPlanInputs();
  const script = { kovaPersona: { version: 1, heldTurn: { marker: "VERIFY_HOLD", holdMs: 90000, progressCard: true } } };
  let checked = 0;
  for (const phase of templates.find((item) => item.id === "sessions").phases) {
    if (!["setup-subagents-working", "setup-subagents-working-child", "run-subagents"].includes(phase.id)) continue;
    for (const command of phase.commands) {
      const { tokens } = parseCatalogueCommand(command);
      const flag = (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
      if (flag("--tool") !== "sessions_spawn") continue;
      const args = JSON.parse(flag("--args").replaceAll("{persona:mock-provider-held-turn:marker}", "VERIFY_HOLD"));
      if (phase.id === "run-subagents" && flag("--out") !== "{run}/cancel-child.json") continue;
      const parent = selectVerificationReply({ model: "gpt-5.5", input: `KOVA_TOOL_CALL ${JSON.stringify({ name: "sessions_spawn", arguments: args })}`, tools: [{ name: "sessions_spawn" }] }, script);
      assert.equal(parent.respond.type, "tool-calls");
      assert.equal(parent.holdMs, undefined);
      const emitted = JSON.parse(parent.respond.toolCalls[0].arguments);
      assert.deepEqual(emitted, args);
      assert.equal(selectVerificationReply({ model: "gpt-5.5", input: emitted.task }, script)?.holdMs, 240000);
      checked++;
    }
  }
  assert.equal(checked, 4);
  assert.equal(selectVerificationReply({ model: "gpt-5.5", input: "Hold your reply open for four minutes." }, script), null);
});

test("restart and offline repair require explicit owned lifecycle contracts", async () => {
  const inputs = await loadPlanInputs();
  const phases = inputs.templates.find((item) => item.id === "sessions").phases;
  const flags = (command) => {
    const { tokens } = parseCatalogueCommand(command);
    return (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
  };
  const restart = phases.find((phase) => phase.id === "event-gateway-restart-during-work");
  const trigger = restart.commands.find((command) => command.includes("restart-during-turn.mjs"));
  assert.equal(flags(trigger)("--gateway-handle"), "{run}/gateway.json");
  assert.equal(flags(trigger)("--drain-ms"), "1000");
  const producer = restart.commands.find((command) => flags(command)("--handle") === flags(trigger)("--from"));
  assert.equal(JSON.parse(flags(producer)("--message").slice("KOVA_VERIFY_HOLD ".length)).holdMs, 240000);
  const queued = restart.commands.find((command) => flags(command)("--queue-mode") === "followup");
  assert.ok(queued.includes("--background"));
  assert.ok(restart.commands.some((command) => flags(command)("--wait") === flags(queued)("--handle")));
  const repair = phases.find((phase) => phase.id === "event-legacy-store-doctor");
  assert.ok(repair.commands.some((command) => command.includes("/verify/doctor-repair.mjs") && flags(command)("--gateway-handle") === "{run}/gateway.json"));
  assert.doesNotMatch([...restart.commands, ...repair.commands].join("\n"), /ocm @\{env\} -- gateway (?:stop|restart)/);
  for (const id of ["restart-during-turn", "doctor-repair"]) assert.equal(inputs.catalogue.entries.find((entry) => entry.id === id).status, "toWrite");
});

test("reset and recovery observations consume explicit prepared conditions", async () => {
  const { templates, catalogue } = await loadPlanInputs();
  const phases = templates.find((item) => item.id === "sessions").phases;
  const commands = (id) => phases.find((phase) => phase.id === id).commands.map((command) => {
    const { tokens } = parseCatalogueCommand(command);
    const flag = (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
    return { tokens, flag };
  });
  const reset = commands("event-reset-clears-session-state");
  const boundary = reset.findIndex(({ flag }) => flag("--message") === "/new");
  const source = reset[boundary].flag("--session-from");
  assert.ok(source && source !== "{run}/new-session.json");
  assert.ok(reset.slice(0, boundary).some(({ flag }) => flag("--method") === "sessions.create" && flag("--out") === source));
  assert.ok(reset.slice(0, boundary).some(({ flag }) => flag("--tool") === "create_goal" && flag("--session-from") === source));
  assert.ok(reset.slice(0, boundary).some(({ flag }) => flag("--method") === "progressCard.put" && flag("--session-from") === source));
  const recovery = commands("event-recovery-after-restart");
  const prepare = recovery.findIndex(({ tokens }) => tokens[1] === "{kovaRoot}/support/verify/restart-for-recovery.mjs");
  assert.ok(prepare >= 0);
  const target = recovery[prepare].flag("--out");
  assert.ok(recovery.slice(0, prepare).some(({ flag }) => flag("--method") === "sessions.create" && flag("--out") === recovery[prepare].flag("--session-from")));
  const consumers = recovery.slice(prepare + 1).filter(({ flag }) => flag("--method") === "sessions.recover" || flag("--flow") === "resume-in-new-session");
  assert.equal(consumers.length, 2);
  assert.ok(consumers.every(({ flag }) => flag("--session-from") === target));
  assert.equal(catalogue.entries.find((entry) => entry.id === "restart-for-recovery").status, "toWrite");
});

test("creation contracts declare generated IDs without treating reads as creation", async () => {
  const { catalogue } = await loadPlanInputs();
  for (const id of ["agent-tool-turn", "chat-send", "session-turn-hold", "control-ui", "goal-control", "session-send-turn", "run-resume", "channel-inbound-turn", "gateway-sessions-create", "gateway-sessions-catalog-import", "restart-for-recovery"]) {
    const entry = catalogue.entries.find((item) => item.id === id);
    assert.ok(entry.prints.includes("createdIds"), id);
    assert.deepEqual(entry.creates, id === "session-send-turn" ? ["/createdIds/*", "/compaction/newEntryIds/*"] : ["/createdIds/*"], id);
  }
  const recover = catalogue.entries.find((entry) => entry.id === "gateway-sessions-recover");
  assert.deepEqual(recover.creates, ["/result/key", "/result/sessionId", "/result/continuation/runId"]);
  for (const id of ["gateway-sessions-list", "gateway-sessions-describe", "gateway-sessions-search"]) {
    assert.deepEqual(catalogue.entries.find((entry) => entry.id === id).creates, [], id);
  }
});

test("spawn output resolves the child through the Gateway session-file reader", async (t) => {
  const helper = process.env.KOVA_GATEWAY_CALLER ?? join(root, "support/verify/gateway-call.mjs");
  try { await access(helper); } catch (error) {
    if (error.code === "ENOENT") return t.skip("Gateway caller is absent; set KOVA_GATEWAY_CALLER to its module");
    throw error;
  }
  const { resolveGatewayParams } = await import(pathToFileURL(resolve(helper)).href);
  const dir = await mkdtemp(join(tmpdir(), "kova-spawn-result-"));
  try {
    const path = join(dir, "child.json");
    const record = { callerSessionKey: "agent:main:parent", sessionKey: "agent:main:child", toolCall: { name: "sessions_spawn", args: {} }, toolResult: { details: { status: "accepted", childSessionKey: "agent:main:child", runId: "fixture-run" } }, reply: "", elapsedMs: 1 };
    await writeFile(path, JSON.stringify(record));
    const options = { method: "sessions.describe", params: {}, "session-from": path };
    assert.deepEqual(await resolveGatewayParams(options), { key: record.toolResult.details.childSessionKey });
    await assert.rejects(() => resolveGatewayParams({ ...options, params: { key: record.callerSessionKey } }), /conflict/);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test("background joins use their producer before a separate observation", async () => {
  const { templates } = await loadPlanInputs();
  const phases = templates.find((item) => item.id === "sessions").phases;
  const handles = new Map();
  let joins = 0;
  for (const phase of phases) {
    for (const command of phase.commands) {
      const { tokens } = parseCatalogueCommand(command);
      const flag = (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
      const owner = [tokens[1], flag("--method")];
      if (flag("--handle")) handles.set(flag("--handle"), owner);
      if (flag("--wait")?.startsWith("{run}/")) {
        assert.deepEqual(owner, handles.get(flag("--wait")), command);
        joins++;
      }
    }
  }
  assert.equal(joins, 8);
  const completion = phases.find((phase) => phase.commands.some((command) => command.includes("--wait {run}/subagents.json")));
  const joined = completion.commands.findIndex((command) => command.includes("--wait {run}/subagents.json"));
  assert.match(completion.commands[joined + 1], /chat-history-read\.mjs/);
  assert.doesNotMatch(completion.commands[joined + 1], /--wait/);
});

test("state declarations identify reset boundary addresses in pinned storage", async (t) => {
  const { standard } = await loadPlanInputs();
  const declaration = standard.stateIds.find((item) => item.table === "transcript_event_identities");
  assert.deepEqual(declaration, {
    path: "agents/*/agent/openclaw-agent.sqlite", table: "transcript_event_identities",
    column: "event_id", recordKey: "session_id", order: "seq",
  });
  const owner = standard.stateIds.find((item) => item.column === declaration.recordKey);
  assert.equal(owner?.table, "session_windows");
  assert.equal(owner.recordKey, "session_key");
  const checkout = process.env.KOVA_OPENCLAW_CHECKOUT;
  if (!checkout) return t.skip("Set KOVA_OPENCLAW_CHECKOUT to exercise the pinned reset producer and storage schema");
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "7e80556f503d26ddde64e274bfb50cbbec7830f5");
  const { createJiti } = createRequire(join(resolve(checkout), "package.json"))("jiti");
  const jiti = createJiti(join(resolve(checkout), "package.json"), {
    fsCache: false, alias: { "@openclaw/normalization-core": join(resolve(checkout), "packages/normalization-core/src") },
  });
  const { buildSessionResetBoundaryEvent, createSessionResetBoundaryId } = await jiti.import(join(resolve(checkout), "src/config/sessions/session-reset-boundary-event.ts"));
  const schema = await readFile(join(checkout, "src/state/openclaw-agent-schema.sql"), "utf8");
  const { DatabaseSync } = await import("node:sqlite");
  const collect = () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const table of [owner.table, declaration.table]) {
        const statement = schema.match(new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\) STRICT;`))?.[0];
        assert.ok(statement, table);
        db.exec(statement);
      }
      const sessionId = createSessionResetBoundaryId();
      db.prepare("INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)").run(sessionId, "agent:main:reset-probe");
      const events = [{ id: "persona-message", type: "message", parentId: null }];
      const insert = db.prepare("INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (let seq = 1; seq <= 2; seq++) {
        const event = buildSessionResetBoundaryEvent({ events, context: "clear", reason: "reset", boundaryId: createSessionResetBoundaryId() });
        insert.run(sessionId, event.id, seq, event.type, event.parentId, 100 + seq);
        events.push(event);
      }
      // Check the declared address mapping on real schema rows; this is not the compare implementation.
      const ownerRow = db.prepare(`SELECT ${owner.column} AS id, ${owner.recordKey} AS owner FROM ${owner.table}`).get();
      const ownerToken = `<id:${owner.path}#${ownerRow.owner}/${owner.column}/1>`;
      const rows = db.prepare(`SELECT ${declaration.column} AS id, ${declaration.recordKey} AS owner, ${declaration.order} AS sequence, event_type, parent_id FROM ${declaration.table} ORDER BY ${declaration.order}, rowid`).all();
      const replacements = new Map([[ownerRow.id, ownerToken], ...rows.map((row, index) => [row.id, `<id:${declaration.path}#${ownerToken}/${declaration.column}/${index + 1}>`])]);
      const normalized = rows.map((row) => [replacements.get(row.owner), replacements.get(row.id), row.event_type, replacements.get(row.parent_id) ?? row.parent_id]);
      assert.equal(normalized[0][3], "persona-message");
      assert.equal(normalized[1][3], normalized[0][1]);
      return { ids: rows.map((row) => row.id), normalized };
    } finally { db.close(); }
  };
  const first = collect(), second = collect();
  assert.notDeepEqual(first.ids, second.ids);
  assert.deepEqual(first.normalized, second.normalized);
});

test("archive declarations retain row and file addresses after session deletion", async (t) => {
  const { standard } = await loadPlanInputs();
  const declarations = standard.stateIds.filter((item) => item.table === "session_transcript_archives");
  assert.deepEqual(declarations.map(({ column, recordKey, order }) => [column, recordKey, order]), [
    ["session_id", "session_key", "created_at"], ["generation", "session_id", "created_at"], ["archive_name", "session_id", "created_at"],
  ]);
  const checkout = process.env.KOVA_OPENCLAW_CHECKOUT;
  if (!checkout) return t.skip("Set KOVA_OPENCLAW_CHECKOUT to exercise the pinned archive name producer and schema");
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "7e80556f503d26ddde64e274bfb50cbbec7830f5");
  const { createJiti } = createRequire(join(resolve(checkout), "package.json"))("jiti");
  const jiti = createJiti(join(resolve(checkout), "package.json"), {
    fsCache: false, alias: { "@openclaw/normalization-core": join(resolve(checkout), "packages/normalization-core/src") },
  });
  const { resolveRegisteredSqliteTranscriptArchiveName } = await jiti.import(join(resolve(checkout), "src/config/sessions/session-accessor.sqlite-archive-artifact.ts"));
  const schema = await readFile(join(checkout, "src/state/openclaw-agent-schema.sql"), "utf8");
  const { DatabaseSync } = await import("node:sqlite");
  const { randomUUID } = await import("node:crypto");
  const collect = (clock) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const table of ["session_windows", "session_transcript_archives"]) {
        const statement = schema.match(new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\) STRICT;`))?.[0];
        assert.ok(statement, table); db.exec(statement);
      }
      const sessionId = randomUUID();
      db.prepare("INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)").run(sessionId, "agent:main:archive-probe");
      const insert = db.prepare("INSERT INTO session_transcript_archives (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const [index, reason, encoding] of [[0, "reset", "identity"], [1, "deleted", "zstd"]]) {
        const generation = randomUUID().replaceAll("-", "");
        const createdAt = clock + index;
        const name = resolveRegisteredSqliteTranscriptArchiveName({ sessionId, generation, createdAt, reason, encoding });
        insert.run(sessionId, generation, "agent:main:archive-probe", reason, encoding, Buffer.from("fixture"), "a".repeat(64), name, createdAt);
      }
      // Retained declarations must suffice even after the live session row is gone.
      db.exec("DELETE FROM session_windows");
      const rows = db.prepare("SELECT * FROM session_transcript_archives ORDER BY created_at, rowid").all();
      const replacements = new Map();
      for (const declaration of declarations) {
        const owners = new Map();
        for (const row of rows) {
          if (replacements.has(row[declaration.column])) continue;
          const owner = replacements.get(row[declaration.recordKey]) ?? row[declaration.recordKey];
          const ordinal = (owners.get(owner) ?? 0) + 1; owners.set(owner, ordinal);
          replacements.set(row[declaration.column], `<id:${declaration.path}#${owner}/${declaration.column}/${ordinal}>`);
        }
      }
      const normalize = (text) => {
        // Whole generated filenames precede the component ids they contain.
        const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
        for (const key of keys) text = text.split(key).join(replacements.get(key));
        return text;
      };
      assert.equal(replacements.get(sessionId), "<id:agents/*/agent/openclaw-agent.sqlite#agent:main:archive-probe/session_id/1>");
      return {
        names: rows.map((row) => row.archive_name),
        addresses: rows.map((row) => [normalize(row.session_id), normalize(row.generation), normalize(`agents/main/sessions/${row.archive_name}`), row.reason, row.encoding, row.archive_sha256]),
      };
    } finally { db.close(); }
  };
  const first = collect(1700000000000), second = collect(1701000000000);
  assert.notDeepEqual(first.names, second.names);
  assert.deepEqual(first.addresses, second.addresses);
  assert.deepEqual(first.addresses.map((row) => row.slice(3, 5)), [["reset", "identity"], ["deleted", "zstd"]]);
  assert.ok(first.addresses.every((row) => row[2].startsWith("agents/main/sessions/<id:") && row[5] === "a".repeat(64)));
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
      if (method === "sessions.patchMany") {
        assert.equal(source.method, "sessions.describe", label);
        const matches = params.targets.filter((target) => target.key === source.result.session.key);
        assert.equal(matches.length, 1, `${label}: described target must match exactly once`);
        assert.equal(matches[0].expectedSessionId, undefined, label);
        matches[0].expectedSessionId = source.result.session.sessionId;
      } else if (method === "sessions.search") {
        assert.ok(["sessions.create", "sessions.catalog.import"].includes(source.method), label);
        assert.equal(params.sessionKeys, undefined, label);
        assert.equal(params.scope, undefined, label);
        params.sessionKeys = [source.result.key ?? source.result.sessionKey];
      } else if (method === "sessions.setInvolvement") {
        assert.equal(source.params.key, params.key, `${label}: input belongs to another session`);
        assert.equal(source.method, "sessions.describe", label);
        assert.equal(params.expectedSessionId, undefined, `${label}: identity must come from the read`);
        params.expectedSessionId = source.result.session.sessionId;
      } else if (method === "sessions.processes.stop") {
        assert.equal(source.params.key, params.key, `${label}: input belongs to another session`);
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
        : method === "sessions.create" ? { ok: true, key: params.key ?? "agent:main:created", sessionId: "fixture-created" }
        : method === "sessions.catalog.import" ? { sessionKey: "agent:main:imported", importedItems: 1, totalItems: 1, complete: true, created: true }
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
    // sessions-patch-admission.ts requires identities beyond the permissive parameter schema.
    if (["sessions.patch", "sessions.patchMany"].includes(method)) {
      const patch = method === "sessions.patchMany" ? params.patch : params;
      if (typeof patch.archived === "boolean" || Object.hasOwn(patch, "snoozedUntil")) {
        const targets = method === "sessions.patchMany" ? params.targets.map((target) => ({ ...patch, ...target })) : [params];
        for (const target of targets) assert.ok(typeof target.expectedSessionId === "string" && target.expectedSessionId.length, `${label}: lifecycle identity required`);
      }
    }
    if (!validators.has(name)) validators.set(name, Compile(schema));
    const validator = validators.get(name);
    if (!validator.Check(params)) failures.push(`${label}: ${JSON.stringify(validator.Errors(params))}`);
  }
  assert.equal(requests, 185);
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
    assert.deepEqual(plan.phases.map((item) => item.id), ["standard/use-target", "standard/status-before", "standard/status-after", "standard/doctor", "standard/snapshot"]);
    assert.deepEqual(plan.withheld.filter((item) => item.id.startsWith("standard/")).map((item) => item.id), ["standard/start-gateway", "standard/stop-gateway"]);
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

test("yield continuations create and observe each fresh child before sending", async (t) => {
  const caller = process.env.KOVA_GATEWAY_CALLER;
  if (!caller) return t.skip("Set KOVA_GATEWAY_CALLER to the actual Gateway helper consumer");
  const { selectVerificationReply } = await import(new URL("mock-replies.mjs", pathToFileURL(caller)));
  const { templates } = await loadPlanInputs();
  const phase = templates.find((item) => item.id === "sessions").phases.find((item) => item.id === "event-subagent-completion");
  const commands = phase.commands.map((command) => {
    const { tokens } = parseCatalogueCommand(command);
    return (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined;
  });
  const receipts = new Set();
  for (const offset of [0, 3]) {
    const [spawn, wait, send] = commands.slice(offset, offset + 3);
    assert.equal(spawn("--tool"), "sessions_spawn");
    const args = JSON.parse(spawn("--args"));
    const parent = selectVerificationReply({ model: "gpt-5.5", input: `KOVA_TOOL_CALL ${JSON.stringify({ name: "sessions_spawn", arguments: args })}`, tools: [{ name: "sessions_spawn" }] }, {});
    assert.equal(parent.respond.type, "tool-calls");
    const emitted = JSON.parse(parent.respond.toolCalls[0].arguments);
    assert.deepEqual(emitted, args);
    const child = selectVerificationReply({ model: "gpt-5.5", input: emitted.task, tools: [{ name: "sessions_yield" }] }, {});
    assert.equal(child.respond.toolCalls[0].name, "sessions_yield");
    assert.deepEqual(JSON.parse(child.respond.toolCalls[0].arguments), { waitFor: "message", acknowledgment: "KOVA_YIELD_OK" });
    assert.equal(wait("--tool"), "subagents");
    assert.deepEqual(JSON.parse(wait("--args")), { action: "wait", timeoutSeconds: 60 });
    assert.equal(send("--tool"), "sessions_send");
    for (const consumer of [wait, send]) {
      assert.equal(consumer("--from"), spawn("--out"));
      assert.equal(consumer("--session-key"), spawn("--session-key"));
      assert.equal(consumer("--session-from"), spawn("--session-from"));
    }
    assert.ok(!receipts.has(spawn("--out")));
    receipts.add(spawn("--out"));
  }
  assert.ok(commands.every((flag) => flag("--from") !== "{run}/hidden-child.json" && flag("--tool") !== "sessions_yield"));
  assert.equal(selectVerificationReply({ model: "gpt-5.5", input: "Report KOVA_YIELD_OK, then yield with waitFor message." }, {}), null);
});

test("sessions command deadlines fit phase bounds and setup stays short", async () => {
  const { templates } = await loadPlanInputs();
  for (const phase of templates.find((item) => item.id === "sessions").phases) {
    const total = phase.commands.reduce((sum, command) => {
      const { tokens } = parseCatalogueCommand(command);
      const index = tokens.indexOf("--timeout");
      return sum + (index >= 0 ? Number(tokens[index + 1]) : 0);
    }, 0);
    assert.ok(total <= phase.timeoutMs, `${phase.id}: ${total} > ${phase.timeoutMs}`);
    if (phase.timeoutMs > 300000) assert.equal(phase.slow, true, phase.id);
    if (phase.kind === "setup") assert.ok(phase.timeoutMs <= 300000 && !phase.slow, phase.id);
  }
});

test("sessions use the declared helper adapters with owned startup inputs", async () => {
  const { templates, catalogue } = await loadPlanInputs();
  const commands = templates.find((item) => item.id === "sessions").phases.flatMap((phase) => phase.commands);
  assert.doesNotMatch(commands.join("\n"), /\{kovaRoot\}\/support\/(?:ensure-gateway-running|run-(?:gateway-session-send-turn|tui-message-turn|doctor-repair|channel-probe-turn|cron-runtime-smoke))\.mjs/);
  let checked = 0;
  for (const command of commands) {
    const { tokens } = parseCatalogueCommand(command);
    if (tokens[1] !== "{kovaRoot}/support/verify/ensure-gateway-running.mjs") continue;
    assert.equal(tokens[tokens.indexOf("--gateway-handle") + 1], "{run}/gateway.json");
    assert.ok(tokens.includes("--artifact-dir"));
    checked++;
  }
  assert.equal(checked, 3);
  for (const id of ["ensure-gateway-running", "session-send-turn", "tui-message-turn", "doctor-repair", "channel-probe-turn", "cron-runtime-smoke"]) {
    assert.ok(catalogue.entries.find((entry) => entry.id === id).command.includes(`/support/verify/${id}.mjs`));
  }
});

test("recovery preparation passes the owned Gateway handle to its actual helper", async (t) => {
  const { templates, catalogue } = await loadPlanInputs();
  const phase = templates.find((item) => item.id === "sessions").phases.find((item) => item.id === "event-recovery-after-restart");
  const command = phase.commands.find((value) => value.includes("/restart-for-recovery.mjs"));
  const { tokens } = parseCatalogueCommand(command);
  const options = {};
  for (let i = 2; i < tokens.length; i += 2) options[tokens[i].slice(2)] = tokens[i + 1];
  assert.equal(options["gateway-handle"], "{run}/gateway.json");
  assert.ok(catalogue.entries.find((item) => item.id === "restart-for-recovery").flags["--gateway-handle"]);
  if (!process.env.KOVA_RECOVERY_HELPER) return t.skip("Set KOVA_RECOVERY_HELPER to the actual recovery helper");
  const { definition } = await import(pathToFileURL(process.env.KOVA_RECOVERY_HELPER));
  for (const name of Object.keys(options)) assert.ok(definition.flags.includes(name), name);
  options.env = "kova-run-recovery-probe";
  assert.doesNotThrow(() => definition.validate(options));
  delete options["gateway-handle"];
  assert.throws(() => definition.validate(options), /--gateway-handle is required/);
});

test("store phases prepare staged legacy, DM scope and cold extraction under one owner", async () => {
  const { templates, standard, catalogue } = await loadPlanInputs();
  const phases = templates.find((item) => item.id === "sessions").phases;
  const command = (value) => {
    const { tokens } = parseCatalogueCommand(value);
    return { tokens, flag: (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined };
  };
  const owner = "{run}/gateway.json";
  for (const id of ["maintain-session-store", "event-cold-extraction-and-restore"]) {
    const phase = phases.find((item) => item.id === id), commands = phase.commands.map(command);
    const extraction = commands.findIndex(({ tokens }) => tokens[1] === "{kovaRoot}/support/persona/cold-storage.mjs" && tokens[2] === "extract");
    assert.ok(extraction >= 3, id);
    const [pause, config, resume, extract] = commands.slice(extraction - 3, extraction + 1);
    assert.equal(pause.tokens[2], "pause", id);
    assert.equal(pause.flag("--gateway-handle"), owner, id);
    assert.deepEqual(config.tokens, ["ocm", "@{env}", "--", "config", "set", "session.maintenance.coldStorage.enabled", "true"], id);
    assert.equal(resume.tokens[2], "resume", id);
    assert.equal(resume.flag("--gateway-handle"), owner, id);
    assert.ok(!resume.tokens.includes("--expect-refusal"), id);
    assert.equal(extract.flag("--key"), "{persona:transcripts-cold-stored:eligibleKey}", id);
    assert.ok(commands.slice(extraction + 1).some(({ flag }) => flag("--method") === "sessions.storage.status"), id);
    assert.ok(commands.every(({ flag }) => flag("--method") !== "sessions.storage.run"), id);
  }
  const maintenance = phases.find((item) => item.id === "maintain-session-store").commands;
  const scope = maintenance.indexOf("ocm @{env} -- config set session.dmScope main");
  assert.ok(scope >= 0 && scope < maintenance.findIndex((value) => value.includes("--fix-dm-scope")));
  const legacy = phases.find((item) => item.id === "event-legacy-store-doctor").commands.map(command);
  assert.equal(legacy[0].tokens[2], "pause");
  assert.equal(legacy[0].flag("--gateway-handle"), owner);
  assert.equal(legacy[1].tokens[1], "{kovaRoot}/support/persona/legacy-store.mjs");
  assert.equal(legacy[1].tokens[2], "activate");
  assert.equal(legacy[1].flag("--legacy"), "{persona:store-legacy-sessions-json:path}");
  assert.equal(legacy[1].flag("--aliases"), "{persona:store-rows-legacy-aliases:path}");
  assert.equal(legacy[2].tokens[2], "resume");
  assert.ok(legacy[2].tokens.includes("--expect-refusal"));
  assert.equal(legacy[2].flag("--gateway-handle"), owner);
  assert.equal(legacy[3].tokens[1], "{kovaRoot}/support/verify/doctor-repair.mjs");
  assert.equal(legacy[3].flag("--gateway-handle"), owner);
  const all = [...standard.before, ...phases, ...standard.after].flatMap((phase) => phase.commands.map(command));
  assert.equal(all.filter(({ flag }) => flag("--handle") === owner).length, 1);
  assert.ok(all.some(({ tokens, flag }) => tokens[2] === "stop" && flag("--wait") === owner));
  for (const id of ["foreground-gateway-pause", "foreground-gateway-resume", "doctor-repair"]) assert.equal(catalogue.entries.find((entry) => entry.id === id).status, "toWrite");
  assert.match(catalogue.entries.find((entry) => entry.id === "doctor-repair").wraps, /doctor --fix --non-interactive/);
});

test("corruption restoration follows its checkpoint and inherits preparation withholding", async () => {
  const inputs = await loadPlanInputs();
  const sessions = inputs.templates.find((item) => item.id === "sessions");
  const corruptIndex = sessions.phases.findIndex((phase) => phase.id === "event-corrupt-store-quarantine");
  const corrupt = sessions.phases[corruptIndex], restore = sessions.phases[corruptIndex + 1];
  assert.equal(restore.id, "restore-store-after-quarantine");
  assert.equal(sessions.phases[corruptIndex + 2].id, "event-legacy-store-doctor");
  assert.deepEqual(restore.paths, corrupt.paths);
  assert.ok(corrupt.checkpoint.includes("state:agents/main/agent"));
  const flags = (value) => {
    const { tokens } = parseCatalogueCommand(value);
    return { tokens, flag: (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined };
  };
  const staged = flags(corrupt.commands[0]), restored = flags(restore.commands[0]);
  assert.equal(staged.flag("--out"), "{run}/sessions-corrupt-store.json");
  assert.equal(restored.flag("--from"), staged.flag("--out"));
  assert.ok(restored.tokens.includes("--restore"));
  assert.equal(restored.flag("--fixture"), undefined);
  assert.equal(restored.flag("--gateway-handle"), staged.flag("--gateway-handle"));
  assert.equal(restored.flag("--agent"), staged.flag("--agent"));
  const available = { ...inputs.catalogue, entries: inputs.catalogue.entries.map((entry) => ({ ...entry, status: "existing" })) };
  const reduced = { ...sessions, phases: [corrupt, restore] };
  const result = selectPhases({ ...inputs, catalogue: available, templates: [reduced], paths: ["src/config/sessions/store.ts"], persona: { traits: {} } });
  assert.ok(result.withheld.find((phase) => phase.id === `sessions/${restore.id}`).missing.includes(`phase:sessions/${corrupt.id}`));
  assert.throws(() => selectPhases({ ...inputs, catalogue: available, templates: [{ ...reduced, phases: [restore] }], paths: ["src/config/sessions/store.ts"], persona: { traits: {} } }), /no writer/);
  const legacyOnly = selectPhases({ ...inputs, paths: ["src/gateway/session-utils-store.ts"], persona: { traits: {} } });
  assert.ok(![...legacyOnly.phases, ...legacyOnly.withheld].some((phase) => phase.id === `sessions/${restore.id}`));
});

test("later incognito consumers create fresh handles before their own observations", async () => {
  const { templates } = await loadPlanInputs();
  const phases = templates.find((item) => item.id === "sessions").phases;
  const receipts = new Set();
  for (const id of ["send-message", "open-by-link", "event-gateway-restart-during-work"]) {
    const phase = phases.find((item) => item.id === id);
    const commands = phase.commands.map((value) => {
      const { tokens } = parseCatalogueCommand(value);
      return { tokens, flag: (name) => tokens.includes(name) ? tokens[tokens.indexOf(name) + 1] : undefined };
    });
    const created = commands.findIndex(({ flag }) => flag("--flow") === "new-session-incognito");
    assert.ok(created >= 0, id);
    const receipt = commands[created].flag("--out");
    assert.ok(receipt && receipt !== "{run}/incognito-session.json" && !receipts.has(receipt), id);
    receipts.add(receipt);
    const consumers = commands.flatMap(({ flag }, index) => flag("--incognito-handle") === receipt || flag("--session-from") === receipt ? [index] : []);
    assert.ok(consumers.length && consumers.every((index) => index > created), id);
    if (id === "event-gateway-restart-during-work") {
      const held = commands.findIndex(({ flag }) => flag("--handle") === "{run}/sessions-restart-turn.json");
      const restart = commands.findIndex(({ tokens }) => tokens[1] === "{kovaRoot}/support/verify/restart-during-turn.mjs");
      assert.ok(created < held && held < restart && consumers.every((index) => restart < index));
    } else {
      assert.equal(created + 1, consumers[0], id);
    }
  }
  for (const phase of phases) {
    if (["setup-incognito-session", "setup-incognito-session-followup"].includes(phase.id)) continue;
    assert.ok(phase.commands.every((command) => !command.includes("{run}/incognito-session.json")), phase.id);
  }
});
