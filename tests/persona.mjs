import "./persona-legacy-store.mjs";
import "./persona-stale-dm.mjs";
import "./persona-automation.mjs";
import "./persona-store.mjs";
import "./persona-cold-storage.mjs";
import "./persona-store-fixtures.mjs";
import "./persona-profile-operations.mjs";
import "./persona-channel-operations.mjs";
import "./persona-extras.mjs";
import "./persona-mock.mjs";
import "./persona-provenance.mjs";
import "./persona-support.mjs";
import "./persona-profiles.mjs";
import "./persona-collections.mjs";
import "./persona-channel-sessions.mjs";
import "./persona-environment.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadCatalogue, parseCatalogueCommand } from "../src/catalogue.mjs";
import { loadDefinition, validateDefinition, resolveCommand, readKeys, selectRuntimeTraits } from "../src/persona/definition.mjs";
import { createForegroundGateway } from "../src/persona/gateway.mjs";
import { buildPersona, verifyPersona, hashFile, checkPersonaTraits } from "../src/persona/lifecycle.mjs";

const source = new URL("../personas/openclaw-verification-user.json", import.meta.url);
const definition = JSON.parse(await readFile(source, "utf8"));
const lifecycleDefinition = { ...definition, traits: definition.traits.slice(0, 5) };
const { catalogue } = await loadCatalogue("openclaw");
const checkTraits = Object.fromEntries(lifecycleDefinition.traits.map((trait) => [trait.check.split("/").at(-1).split(" ")[0], trait.id]));
const foundationKeys = {
  "agents-three-configured": { mainAgentId: "main", secondAgentId: "research", thirdAgentId: "idle" },
  "mock-provider-scripted": { modelId: "openai/gpt-5.5" },
  "channels-test-accounts": { dmChannel: "kova-channel-probe", groupChannel: "kova-channel-probe" },
  "plugins-bundled-and-external": { externalPluginId: "kova-channel-probe" },
  "config-hand-edited": {},
};

test("dependency order and catalogue validation run before any environment is created", () => {
  const reversed = structuredClone(definition);
  reversed.traits.reverse();
  const order = validateDefinition(reversed, catalogue).map((trait) => trait.id);
  for (const trait of reversed.traits) for (const dependency of trait.needs) assert.ok(order.indexOf(dependency) < order.indexOf(trait.id));
  for (const [change, pattern] of [
    [(d) => d.traits[0].needs.push("channels-test-accounts"), /cycle/],
    [(d) => d.traits[0].needs.push("missing-trait"), /missing dependency/],
    [(d) => d.traits.push(d.traits[0]), /unique/],
    [(d) => d.traits[0].builder.push("ocm @{env} -- absent"), /no unique catalogue/],
    [(d) => d.traits[0].builder.push("ocm @{env} -- status; touch /tmp/invalid"), /metacharacter/],
    [(d) => d.traits[0].builder[0] += " --invented yes", /unlisted|match/],
    [(d) => d.traits[0].check = d.traits[0].builder[0], /read command/],
    [(d) => d.traits[0].builder[0] = "ocm @{env} -- config get {persona:missing:key} --json", /unresolved dependency/],
    [(d) => d.runtime.selector = "npm:latest", /exact npm/],
    [(d) => d.traits[0].minimumRuntime = ">=2026.10.3", /minimumRuntime/],
    [(d) => d.traits[0].minimumRuntime = "2026.10.3-beta.01", /minimumRuntime/],
    [(d) => d.traits[0].minimumRuntime = 2026, /minimumRuntime/],
    [(d) => d.credentials.push("external-account"), /empty credentials/],
  ]) {
    const invalid = structuredClone(definition); change(invalid);
    assert.throws(() => validateDefinition(invalid, catalogue), pattern);
  }
});

test("the pinned persona validates all definitions and withholds exactly two newer-runtime traits", () => {
  const traits = validateDefinition(definition, catalogue);
  assert.equal(traits.length, 50);
  assert.equal(definition.runtime.selector, "npm:2026.9.9");
  const selected = selectRuntimeTraits({ definition, traits });
  assert.equal(selected.traits.length, 48);
  assert.deepEqual(Object.keys(selected.withheldTraits).sort(), ["session-imported-draft", "sessions-organized-mixed"]);
  for (const row of Object.values(selected.withheldTraits)) assert.equal(row.minimumRuntime, "2026.10.3");
  for (const id of ["sessions-thousands-near-cap", "sessions-stale-dashboard"]) {
    const trait = selected.traits.find((item) => item.id === id);
    assert.ok(trait);
    assert.ok(!trait.needs.includes("sessions-organized-mixed"));
    assert.ok(trait.builder[0].includes("config set session.maintenance"));
    assert.ok(trait.builder[0].includes('"mode":"warn"'));
  }
  assert.equal(selectRuntimeTraits({ definition, traits }, "2026.10.3").traits.length, 50);
});

test("minimum runtime comparison respects release boundaries and prerelease precedence", () => {
  for (const [version, minimumRuntime, runnable] of [
    ["2026.10.2", "2026.10.3", false],
    ["2026.10.3-beta.10", "2026.10.3", false],
    ["2026.10.3", "2026.10.3", true],
    ["2026.10.4-beta.1", "2026.10.3", true],
    ["2026.10.3-beta.2", "2026.10.3-beta.10", false],
    ["2026.10.3-beta.10", "2026.10.3-beta.2", true],
    ["2026.10.3-beta", "2026.10.3-beta.1", false],
    ["2026.10.3-1", "2026.10.3-alpha", false],
    ["2027.1.1", "2026.10.3", true],
  ]) {
    const candidate = structuredClone(lifecycleDefinition);
    candidate.runtime.selector = `npm:${version}`;
    candidate.traits.find((trait) => trait.id === "config-hand-edited").minimumRuntime = minimumRuntime;
    const selected = selectRuntimeTraits({ definition: candidate, traits: validateDefinition(candidate, catalogue) });
    assert.equal(selected.traits.some((trait) => trait.id === "config-hand-edited"), runnable, `${version} / ${minimumRuntime}`);
  }
});

test("historical persona builds omit content until its required runtime behavior exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-persona-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "definition.json");
  for (const [id, before, first] of [
    ["session-pruned-projections", "2026.9.1", "2026.9.2"],
    ["session-public-shared", "2026.9.2", "2026.9.3"],
    ["sessions-thousands-near-cap", "2026.9.2", "2026.9.3"],
    ["store-stale-sessions-over-cap", "2026.9.2", "2026.9.3"],
    ["sessions-stale-dashboard", "2026.9.2", "2026.9.3"],
    ["agents-multiple-with-global-key", "2026.9.2", "2026.9.3"],
    ["cli-profile-paired", "2026.9.3", "2026.9.4"],
    ["gateway-multi-user-profiles", "2026.9.4", "2026.9.5"],
    ["session-orchestrator-idle", "2026.9.4", "2026.9.5"],
    ["transcripts-cold-stored", "2026.9.4", "2026.9.5"],
    ["session-interrupted-inputs", "2026.9.6", "2026.9.7"],
    ["session-main-rolling", "2026.9.8", "2026.9.9"],
  ]) {
    for (const version of [before, first]) {
      const candidate = structuredClone(definition);
      candidate.runtime.selector = `npm:${version}`;
      await writeFile(path, JSON.stringify(candidate));
      const plan = await buildPersona(path, join(root, "unused"));
      assert.equal(plan.traits.some((trait) => trait.id === id), version === first, `${id} on ${version}`);
      if (version === before) {
        assert.equal(plan.withheldTraits[id].minimumRuntime, first);
        assert.ok(plan.withheldTraits[id].reason.includes(`bound runtime is ${before}`));
      } else assert.equal(plan.withheldTraits[id], undefined);
      if (id === "session-main-rolling" && version === before) {
        assert.ok(!plan.traits.some((trait) => trait.id === "session-group-watched"));
        assert.deepEqual(plan.withheldTraits["session-group-watched"].dependencies, [id]);
        assert.equal(plan.withheldTraits["session-group-watched"].minimumRuntime, first);
      }
    }
  }
});

test("withholding propagates through dependencies while unrelated traits remain runnable", () => {
  const candidate = structuredClone(lifecycleDefinition);
  candidate.traits.find((trait) => trait.id === "mock-provider-scripted").minimumRuntime = "2026.10.3";
  const selected = selectRuntimeTraits({ definition: candidate, traits: validateDefinition(candidate, catalogue) });
  assert.deepEqual(selected.traits.map((trait) => trait.id), ["agents-three-configured", "config-hand-edited"]);
  assert.deepEqual(selected.withheldTraits["channels-test-accounts"].dependencies, ["mock-provider-scripted"]);
  assert.deepEqual(selected.withheldTraits["plugins-bundled-and-external"].dependencies, ["channels-test-accounts"]);
  assert.equal(selected.withheldTraits["plugins-bundled-and-external"].minimumRuntime, "2026.10.3");
});

test("placeholder quoting preserves spaces and keys are exactly the declared JSON fields", () => {
  const command = resolveCommand("node {kovaRoot}/script.mjs --env {env} --output {run}/out.json --key '{persona:first-trait:key}'", { env: "kova-persona-test", kovaRoot: "/some path/Kova", run: "/tmp/a'b", traits: { "first-trait": { keys: { key: "agent:main:test" } } } });
  assert.deepEqual(parseCatalogueCommand(command).tokens, ["node", "/some path/Kova/script.mjs", "--env", "kova-persona-test", "--output", "/tmp/a'b/out.json", "--key", "agent:main:test"]);
  const trait = { id: "first-trait", keys: { key: "identifier" } };
  assert.deepEqual(readKeys(trait, '{"key":"agent:main:test"}'), { key: "agent:main:test" });
  for (const output of ['[]', '{}', '{"key":false}', '{"key":"a;echo"}', '{"key":"ok","extra":"x"}', 'log\n{"key":"ok"}']) assert.throws(() => readKeys(trait, output), /first-trait/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-persona-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "definition.json");
  await writeFile(path, JSON.stringify(lifecycleDefinition));
  const calls = [];
  let failTrait = null, failDestroy = false, failProvision = null, occupied = false;
  let runtimeVersion = "2026.9.9";
  let keysFor = (trait) => foundationKeys[trait];
  const environments = new Set(), runs = new Set();
  t.after(async () => { for (const run of runs) await rm(run, { recursive: true, force: true }); });
  const execute = async (command) => {
    if (command.includes("/src/persona/provenance.mjs")) return { status: 0, stdout: JSON.stringify({ binary: "/fixture/native-ocm", version: "0.3.3", sha256: "a".repeat(64) }), stderr: "" };
    const tokens = parseCatalogueCommand(command).tokens;
    calls.push(tokens);
    let stdout = tokens[0] === "cat" ? "12345\n" : "";
    if (tokens[0] === "ocm" && tokens[2] === "--" && tokens[3] === "doctor") stdout = "Existing Doctor output\n";
    const operation = tokens[0] === "ocm" && tokens[1] === "env" ? tokens[2] : null;
    if (operation === "create" || operation === "import") {
      const env = operation === "create" ? tokens[3] : tokens[tokens.indexOf("--name") + 1];
      environments.add(env);
      if (operation === "import") runs.add(dirname(tokens[3]));
      if (operation === failProvision) return { status: 1, stderr: "planted post-commit provisioning failure" };
    }
    if (operation === "destroy") {
      if (failDestroy) return { status: 1, stderr: "planted cleanup refusal" };
      environments.delete(tokens[3]);
    }
    if (tokens[0] === "ocm" && tokens[1] === "start") stdout = JSON.stringify({ envName: tokens[2], defaultRuntime: "test-runtime", defaultLauncher: null });
    if (operation === "show") {
      if (!environments.has(tokens[3]) && !occupied) return { status: 1, stderr: `ocm: environment "${tokens[3]}" does not exist` };
      const envRoot = join(root, "envs", tokens[3]);
      stdout = JSON.stringify({ name: tokens[3], root: envRoot, stateDir: join(envRoot, ".openclaw") });
    }
    if (tokens[0] === "ocm" && tokens[1] === "runtime" && tokens[2] === "show") stdout = JSON.stringify({ name: "test-runtime", sourceKind: "installed", releaseVersion: runtimeVersion, sourceIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}` });
    if (tokens[0] === "ocm" && tokens[1] === "env" && tokens[2] === "export") await writeFile(tokens[tokens.indexOf("--output") + 1], "test export bytes");
    const trait = tokens[1]?.endsWith("/check-profile.mjs") && tokens[2] === "paired"
      ? "cli-profile-paired"
      : checkTraits[tokens[1]?.split("/").at(-1)];
    if (trait) {
      if (trait === failTrait) return { status: 1, stderr: "planted missing content" };
      const env = tokens[tokens.indexOf("--env") + 1];
      stdout = JSON.stringify(keysFor(trait, join(root, "envs", env)));
    }
    return { command, status: 0, stdout, stderr: "" };
  };
  return { root, path, calls, execute, environments, runtime: (version) => { runtimeVersion = version; }, keysFor: (fn) => { keysFor = fn; }, failProvision: (kind) => { failProvision = kind; }, occupy: () => { occupied = true; }, gatewayFactory: (env) => ({ assertOwned: async () => {}, start: async () => { calls.push(["foreground-start", env]); }, stop: async () => { calls.push(["foreground-stop", env]); } }), fail: (trait) => { failTrait = trait; }, failCleanup: () => { failDestroy = true; } };
}

test("build exports only checked content, verifies an import and keeps only the durable environment", async (t) => {
  const f = await fixture(t);
  const out = join(f.root, "built");
  const manifest = await buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory });
  assert.equal(manifest.schema, "kova.verify.persona-manifest.v1");
  assert.equal(manifest.doctor, "Existing Doctor output\n");
  assert.deepEqual(manifest.runtime.ocm, { binary: "/fixture/native-ocm", version: "0.3.3", sha256: "a".repeat(64) });
  assert.equal(manifest.env.sha256, await hashFile(manifest.env.export));
  assert.equal(manifest.env.includeState, true);
  assert.ok(f.calls.find((c) => c[0] === "ocm" && c[2] === "export").includes("--include-state"));
  assert.equal(f.calls.filter((c) => c[0] === "ocm" && c[2] === "snapshot" && c[3] === "create" && c[4] === manifest.env.name).length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.traits).map(([id, row]) => [id, row.keys])), foundationKeys);
  const destroyed = f.calls.filter((c) => c[0] === "ocm" && c[2] === "destroy");
  assert.equal(destroyed.length, 1);
  assert.ok(!f.calls.some((c) => c[0] === "ocm" && c[1] === "service"));
  const exportIndex = f.calls.findIndex((c) => c[0] === "ocm" && c[2] === "export");
  assert.ok(f.calls.slice(0, exportIndex).some((c) => c[0] === "foreground-stop" && c[1] === manifest.env.name));
  assert.match(destroyed[0][3], /^kova-persona-verify-/);
  assert.notEqual(destroyed[0][3], manifest.env.name);
  assert.equal(f.calls.filter((c) => checkTraits[c[1]?.split("/").at(-1)]).length, 10);
  assert.equal(f.calls.filter((c) => c[1]?.endsWith("add-agent.mjs")).length, 2);
  assert.deepEqual(manifest.withheldTraits, {});
  const legacyManifest = { ...manifest };
  delete legacyManifest.withheldTraits;
  await writeFile(join(out, "persona.json"), JSON.stringify(legacyManifest));
  f.calls.length = 0;
  const verify = await verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory });
  assert.equal(verify.ok, true);
  assert.deepEqual(verify.withheldTraits, {});
  assert.ok(!f.calls.some((c) => c.some((arg) => arg.endsWith("configure-openclaw-mock-auth.mjs"))));
  assert.ok(f.calls.some((c) => c.includes("models.providers.openai.baseUrl")));
  await assert.rejects(buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory }), /empty/);
});

test("gated builds skip unsupported commands and verify only justified omissions", async (t) => {
  const f = await fixture(t);
  const candidate = structuredClone(lifecycleDefinition);
  candidate.traits.find((trait) => trait.id === "channels-test-accounts").minimumRuntime = "2026.10.3";
  await writeFile(f.path, JSON.stringify(candidate));
  const out = join(f.root, "gated");
  const manifestPath = join(out, "persona.json");
  const options = { execute: f.execute, gatewayFactory: f.gatewayFactory };
  const manifest = await buildPersona(f.path, out, { ...options, executeBuild: true });
  assert.deepEqual(Object.keys(manifest.traits).sort(), ["agents-three-configured", "config-hand-edited", "mock-provider-scripted"]);
  assert.deepEqual(Object.keys(manifest.withheldTraits).sort(), ["channels-test-accounts", "plugins-bundled-and-external"]);
  assert.equal(manifest.withheldTraits["channels-test-accounts"].minimumRuntime, "2026.10.3");
  assert.deepEqual(manifest.withheldTraits["plugins-bundled-and-external"].dependencies, ["channels-test-accounts"]);
  assert.ok(!f.calls.some((call) => call.includes("plugins")));
  assert.ok(!f.calls.some((call) => call[1]?.endsWith("check-channels.mjs") || call[1]?.endsWith("check-plugins.mjs")));
  assert.ok(f.calls.some((call) => call[2] === "import"));
  assert.deepEqual((await verifyPersona(manifestPath, options)).withheldTraits, manifest.withheldTraits);
  for (const change of [
    (value) => { delete value.traits["agents-three-configured"]; },
    (value) => { delete value.withheldTraits; },
    (value) => { delete value.withheldTraits["channels-test-accounts"]; },
    (value) => { value.withheldTraits["channels-test-accounts"].minimumRuntime = "2026.9.9"; },
    (value) => { value.withheldTraits["channels-test-accounts"].reason = "unverified claim"; },
    (value) => { value.withheldTraits["plugins-bundled-and-external"].dependencies = ["config-hand-edited"]; },
    (value) => { value.withheldTraits["channels-test-accounts"].keys = { dmChannel: "invented" }; },
    (value) => { value.traits["channels-test-accounts"] = { keys: foundationKeys["channels-test-accounts"], checkedAt: new Date().toISOString() }; },
    (value) => { delete value.traits["config-hand-edited"]; value.withheldTraits["config-hand-edited"] = value.withheldTraits["channels-test-accounts"]; },
    (value) => { value.runtime.resolved = `2026.10.3@${value.runtime.resolved.split("@")[1]}`; },
  ]) {
    const altered = structuredClone(manifest);
    change(altered);
    await writeFile(manifestPath, JSON.stringify(altered));
    f.calls.length = 0;
    await assert.rejects(verifyPersona(manifestPath, options), /withheld|traits differ|bound runtime differs/);
    assert.equal(f.calls.length, 0, "invalid withholding must fail before provisioning");
  }
});

test("gated CLI dry plans show withholding without scheduling its builders", async (t) => {
  const f = await fixture(t);
  const candidate = structuredClone(lifecycleDefinition);
  candidate.traits.find((trait) => trait.id === "channels-test-accounts").minimumRuntime = "2026.10.3";
  await writeFile(f.path, JSON.stringify(candidate));
  const out = join(f.root, "dry-gated");
  const args = ["bin/kova.mjs", "persona", "build", "--definition", f.path, "--out", out];
  const json = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const plan = JSON.parse(json.stdout);
  assert.deepEqual(plan.traits.map((trait) => trait.id), ["agents-three-configured", "mock-provider-scripted", "config-hand-edited"]);
  assert.deepEqual(Object.keys(plan.withheldTraits).sort(), ["channels-test-accounts", "plugins-bundled-and-external"]);
  const plain = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /WITHHELD channels-test-accounts: requires OpenClaw 2026\.10\.3/);
  assert.match(plain.stdout, /WITHHELD plugins-bundled-and-external:/);
  assert.doesNotMatch(plain.stdout, /check-channels\.mjs|check-plugins\.mjs|plugins install/);
  await assert.rejects(access(out));
});

test("the exact minimum bound release builds the previously withheld content", async (t) => {
  const f = await fixture(t);
  const candidate = structuredClone(lifecycleDefinition);
  candidate.runtime.selector = "npm:2026.10.3";
  candidate.traits.find((trait) => trait.id === "channels-test-accounts").minimumRuntime = "2026.10.3";
  await writeFile(f.path, JSON.stringify(candidate));
  f.runtime("2026.10.3");
  const options = { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory };
  const manifest = await buildPersona(f.path, join(f.root, "minimum"), options);
  assert.match(manifest.runtime.resolved, /^2026\.10\.3@sha512-/);
  assert.deepEqual(manifest.withheldTraits, {});
  assert.deepEqual(Object.keys(manifest.traits).sort(), Object.keys(foundationKeys).sort());
  assert.ok(f.calls.some((call) => call[1]?.endsWith("check-channels.mjs")));
  f.calls.length = 0;
  f.runtime("2026.9.9");
  await assert.rejects(buildPersona(f.path, join(f.root, "wrong-bound-runtime"), options), /no exact version/);
  assert.ok(!f.calls.some((call) => call[1]?.endsWith("add-agent.mjs")));
});

test("hook personas omit snapshots even without a paired CLI profile", async (t) => {
  const f = await fixture(t);
  const hookTrait = { id: "sessions-synthetic-automation", content: "Saved local hook content.", keys: {}, needs: [], builder: ["node {kovaRoot}/support/persona/make-automation-rows.mjs configure-hook --env {env}"], check: "node {kovaRoot}/support/persona/make-automation-rows.mjs check --env {env} --job-id fixture-job" };
  await writeFile(f.path, JSON.stringify({ ...lifecycleDefinition, traits: [...lifecycleDefinition.traits, hookTrait] }));
  const execute = async (command, options) => {
    const result = await f.execute(command, options);
    if (command.includes("/make-automation-rows.mjs")) result.stdout = "{}";
    return result;
  };
  await buildPersona(f.path, join(f.root, "hook"), { executeBuild: true, execute, gatewayFactory: f.gatewayFactory });
  assert.ok(!f.calls.some((c) => c[0] === "ocm" && c[1] === "env" && c[2] === "snapshot"));
  assert.ok(f.calls.some((c) => c[0] === "ocm" && c[1] === "env" && c[2] === "export"));
});

test("paired personas protect and export their environment, verify an import, and never snapshot", async (t) => {
  const f = await fixture(t);
  const pairedTrait = definition.traits.find((trait) => trait.id === "cli-profile-paired");
  assert.ok(pairedTrait);
  await writeFile(f.path, JSON.stringify({ ...lifecycleDefinition, traits: [...lifecycleDefinition.traits, pairedTrait] }));
  f.keysFor((trait) => trait === "cli-profile-paired" ? { profile: "verify-cli" } : foundationKeys[trait]);
  const rebound = [];
  const execute = async (command, options) => {
    if (!command.includes("/src/persona/provenance.mjs")) {
      const tokens = parseCatalogueCommand(command).tokens;
      assert.ok(!(tokens[0] === "ocm" && tokens[1] === "env" && tokens[2] === "snapshot"), "paired builds must not request an OCM snapshot");
    }
    return f.execute(command, options);
  };
  const out = join(f.root, "paired");
  const manifest = await buildPersona(f.path, out, {
    executeBuild: true, execute, gatewayFactory: f.gatewayFactory,
    rebindPairedProfile: async (metadata, state) => {
      assert.ok(f.environments.has(metadata.name));
      assert.equal(state, join(metadata.root, ".openclaw"));
      assert.ok(f.calls.some((call) => call[0] === "foreground-start" && call[1] === metadata.name));
      rebound.push(metadata.name);
      f.calls.push(["paired-rebind", metadata.name]);
      return { profile: "verify-cli" };
    },
  });
  assert.deepEqual(manifest.traits["cli-profile-paired"].keys, { profile: "verify-cli" });
  assert.deepEqual(JSON.parse(await readFile(join(out, "persona.json"), "utf8")), manifest);
  assert.equal(manifest.env.sha256, await hashFile(manifest.env.export));
  assert.equal(manifest.env.includeState, true);
  const imported = f.calls.filter((call) => call[0] === "ocm" && call[2] === "import");
  assert.equal(imported.length, 1);
  const clone = imported[0][imported[0].indexOf("--name") + 1];
  assert.notEqual(clone, manifest.env.name);
  assert.deepEqual(rebound, [clone]);
  assert.ok(f.calls.some((call) => call[0] === "ocm" && call[2] === "protect" && call[3] === manifest.env.name && call[4] === "on"));
  assert.ok(f.calls.some((call) => call[0] === "ocm" && call[2] === "export" && call[3] === manifest.env.name && call.includes("--include-state")));
  assert.ok(f.calls.some((call) => call[0] === "ocm" && call[2] === "destroy" && call[3] === clone));
  assert.deepEqual([...f.environments], [manifest.env.name]);
  assert.deepEqual(f.calls.filter((call) => call[1]?.endsWith("/pair-cli-profile.mjs")).map((call) => call[2]), ["pair", "configure"]);
  const pairedChecks = f.calls.filter((call) => call[1]?.endsWith("/check-profile.mjs") && call[2] === "paired");
  assert.equal(pairedChecks.length, 2);
  assert.equal(pairedChecks[1][pairedChecks[1].indexOf("--env") + 1], clone);
  assert.ok(f.calls.findIndex((call) => call[0] === "paired-rebind") < f.calls.indexOf(pairedChecks[1]));
});

test("a failing trait names the trait, destroys the incomplete environment and publishes no manifest", async (t) => {
  const f = await fixture(t); f.fail("mock-provider-scripted");
  const out = join(f.root, "failed");
  await assert.rejects(buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory }), /trait mock-provider-scripted check failed/);
  await assert.rejects(access(join(out, "persona.json")));
  assert.ok(f.calls.some((c) => c[0] === "ocm" && c[2] === "destroy"));
  assert.ok(!f.calls.some((c) => c[0] === "ocm" && c[2] === "export"));
});

test("verify rejects changed definition and export bytes before importing", async (t) => {
  const f = await fixture(t);
  const out = join(f.root, "built");
  const manifest = await buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory });
  f.calls.length = 0;
  await writeFile(manifest.env.export, "changed");
  await assert.rejects(verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory }), /export hash/);
  assert.ok(!f.calls.some((c) => c[2] === "import"));
  await writeFile(f.path, `${JSON.stringify(definition)}\n`);
  await assert.rejects(verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory }), /definition hash/);
});

test("verification failure still destroys its clone and reports cleanup refusal", async (t) => {
  const f = await fixture(t), out = join(f.root, "built");
  await buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory });
  f.calls.length = 0; f.fail("channels-test-accounts");
  await assert.rejects(verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory }), /channels-test-accounts/);
  assert.ok(f.calls.some((c) => c[2] === "destroy"));
  f.failCleanup();
  await assert.rejects(verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory }), /cleanup failed.*planted cleanup refusal/);
});

test("real CLI dry run prints the ordered plan without creating output", async (t) => {
  const f = await fixture(t), out = join(f.root, "dry");
  const result = spawnSync(process.execPath, ["bin/kova.mjs", "persona", "build", "--definition", f.path, "--out", out, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).execute, false);
  await assert.rejects(access(out));
  for (const args of [["show", "--persona"], ["verify", "--persona", "missing", "--execute"], ["build", "--definition", f.path, "--out", out, "--invented"]]) {
    assert.notEqual(spawnSync(process.execPath, ["bin/kova.mjs", "persona", ...args], { encoding: "utf8" }).status, 0);
  }
});

test("foreground Gateway restarts and failed health checks stop their owned process", async (t) => {
  const { createServer } = await import("node:net");
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const root = await mkdtemp(join(tmpdir(), "kova-persona-gateway-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, "pid");
  const configPath = join(root, ".openclaw", "openclaw.json");
  const call = async () => ({ stdout: JSON.stringify({ root, configPath, gatewayPort: port }) });
  const connect = async () => ({ client: { request: async () => ({ path: configPath }), close() {} } });
  const source = 'require("fs").writeFileSync(process.argv[2],String(process.pid));require("http").createServer((q,s)=>{s.writeHead(q.url==="/readyz"?Number(process.argv[3]):200);s.end("health")}).listen(Number(process.argv[1]),"127.0.0.1")';
  const invocation = (status) => () => ({ file: process.execPath, args: ["-e", source, String(port), pidFile, String(status)], env: process.env });
  const gateway = createForegroundGateway("kova-persona-fixture", call, { connect, invocation: invocation(200), timeoutMs: 5000 });
  t.after(() => gateway.stop());
  await gateway.start();
  const first = Number(await readFile(pidFile, "utf8"));
  await gateway.start();
  const second = Number(await readFile(pidFile, "utf8"));
  assert.notEqual(first, second);
  assert.throws(() => process.kill(first, 0), { code: "ESRCH" });
  process.kill(second, "SIGTERM");
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    try { process.kill(second, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await assert.rejects(gateway.assertOwned(), /owned Gateway exited/);
  await gateway.stop();
  assert.throws(() => process.kill(second, 0), { code: "ESRCH" });
  const wrong = createForegroundGateway("kova-persona-fixture", call, { connect: async () => ({ client: { request: async () => ({ path: "/another/environment/openclaw.json" }), close() {} } }), invocation: invocation(200), timeoutMs: 5000 });
  t.after(() => wrong.stop());
  await assert.rejects(wrong.start(), /does not belong/);
  const wrongPid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(wrongPid, 0), { code: "ESRCH" });
  const unhealthy = createForegroundGateway("kova-persona-fixture", call, { connect, invocation: invocation(503), timeoutMs: 1000 });
  t.after(() => unhealthy.stop());
  await assert.rejects(unhealthy.start(), /did not become healthy/);
  const failed = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(failed, 0), { code: "ESRCH" });
});

for (const operation of ["create", "import"]) {
  test(`a late ${operation} error reconciles and removes the environment`, async (t) => {
    const f = await fixture(t), out = join(f.root, "failed");
    f.failProvision(operation);
    await assert.rejects(buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory }), /post-commit provisioning failure/);
    assert.equal(f.environments.size, 0);
    await assert.rejects(access(join(out, "persona.json")));
  });
}

test("an existing generated name is refused without destroying that environment", async (t) => {
  const f = await fixture(t); f.occupy();
  await assert.rejects(buildPersona(f.path, join(f.root, "occupied"), { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory }), /already exists/);
  assert.ok(!f.calls.some((c) => c[0] === "ocm" && ["create", "destroy", "protect"].includes(c[2])));
});

test("absolute keys preserve their relative identity across import", async (t) => {
  const f = await fixture(t), out = join(f.root, "paths");
  const pathKeys = (leaf) => (trait, root) => trait === "agents-three-configured"
    ? { ...foundationKeys[trait], mainAgentId: leaf.startsWith("/") ? leaf : join(root, leaf) }
    : foundationKeys[trait];
  f.keysFor(pathKeys("file-a"));
  await buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory });
  f.keysFor(pathKeys("file-b"));
  await assert.rejects(verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory }), /mainAgentId differs/);
  f.keysFor((trait) => foundationKeys[trait]);
  await assert.rejects(verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory }), /mainAgentId differs/);
  const manifest = JSON.parse(await readFile(join(out, "persona.json"), "utf8"));
  delete manifest.env.root;
  await writeFile(join(out, "persona.json"), JSON.stringify(manifest));
  f.calls.length = 0;
  await assert.rejects(verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory }), /require env.root/);
  assert.equal(f.calls.length, 0);
});

test("an unrelated listening Gateway is rejected without stopping it", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { res.writeHead(200); res.end("ready"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  let spawned = false;
  const gateway = createForegroundGateway("kova-persona-fixture", async () => ({ stdout: JSON.stringify({ gatewayPort: port }) }), { invocation: () => { spawned = true; throw new Error("must not spawn"); } });
  await assert.rejects(gateway.start(), /already has a listener/);
  assert.equal(spawned, false);
  assert.equal(server.listening, true);
});

for (const mode of ["build", "verify", "verify-cleanup", "build-create", "verify-import"]) {
  test(`SIGTERM awaits ${mode} environment and provider cleanup between commands`, async (t) => {
    const f = await fixture(t), built = join(f.root, "built");
    await buildPersona(f.path, built, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory });
    const root = join(f.root, `interrupt-${mode}`);
    await mkdir(root);
    const driver = `
      import { buildPersona, verifyPersona } from ${JSON.stringify(new URL("../src/persona/lifecycle.mjs", import.meta.url).href)};
      import { parseCatalogueCommand } from ${JSON.stringify(new URL("../src/catalogue.mjs", import.meta.url).href)};
      import { runCommand, quoteShell } from ${JSON.stringify(new URL("../src/commands.mjs", import.meta.url).href)};
      import { writeFile, rm } from 'node:fs/promises';
      import { dirname, join } from 'node:path';
      import { setTimeout as sleep } from 'node:timers/promises';
      const [mode, input, root] = process.argv.slice(1);
      let exists = false, name, waiting = false;
      const execute = async (command, options) => {
        if (command.includes("/src/persona/provenance.mjs")) return { status: 0, stdout: JSON.stringify({ binary: "/fixture/native-ocm", version: "0.3.3", sha256: "a".repeat(64) }), stderr: "" };
        const c = parseCatalogueCommand(command).tokens;
        const op = c[0] === 'ocm' && c[1] === 'env' ? c[2] : null;
        let stdout = c[0] === 'cat' ? '12345' : '';
        if (op === 'create' || op === 'import') {
          if (mode === 'build-create' || mode === 'verify-import') {
            const script = "setTimeout(()=>require('fs').writeFileSync(" + JSON.stringify(join(root, 'provision-child-finished')) + ",'done'),400)";
            const pending = runCommand(quoteShell(process.execPath) + ' -e ' + quoteShell(script), options);
            waiting = true;
            await writeFile(join(root, 'waiting'), 'yes');
            const result = await pending;
            if (result.status !== 0) return result;
          }
          exists = true; name = op === 'create' ? c[3] : c[c.indexOf('--name') + 1];
          await writeFile(join(root, 'state.json'), JSON.stringify({name}));
          if (op === 'import') await writeFile(join(root, 'copy.json'), JSON.stringify({run: dirname(c[3])}));
        }
        if (op === 'show') {
          if (!exists) return {status:1, stderr:'ocm: environment "' + c[3] + '" does not exist'};
          stdout = JSON.stringify({name, root});
        }
        if (c[1] === 'start') stdout = JSON.stringify({envName:c[2], defaultRuntime:'test-runtime'});
        if (c[1] === 'runtime' && c[2] === 'show') stdout = JSON.stringify({name:'test-runtime',sourceKind:'installed',releaseVersion:'2026.9.9',sourceIntegrity:'sha512-' + Buffer.alloc(64).toString('base64')});
        const trait = ${JSON.stringify(checkTraits)}[c[1]?.split('/').at(-1)];
        if (trait) stdout = JSON.stringify(${JSON.stringify(foundationKeys)}[trait]);
        if (mode !== 'verify-cleanup' && !waiting && (c.includes('models.providers.openai.baseUrl') || c.some(v => v.endsWith('configure-openclaw-mock-auth.mjs')))) {
          waiting = true;
          await writeFile(join(root, 'waiting'), 'yes');
          await sleep(400);
        }
        if (op === 'destroy') {
          if (mode === 'verify-cleanup') {
            const script = "setTimeout(()=>require('fs').writeFileSync(" + JSON.stringify(join(root, 'cleanup-child-finished')) + ",'done'),400)";
            const pending = runCommand(quoteShell(process.execPath) + ' -e ' + quoteShell(script), options);
            await writeFile(join(root, 'waiting'), 'yes');
            const result = await pending;
            if (result.status !== 0) return result;
          } else await sleep(200);
          exists = false;
          await rm(join(root, 'state.json'));
          await writeFile(join(root, 'destroyed'), 'yes');
        }
        if (c.some(v => v.endsWith('stop-mock-ai-provider.mjs'))) {
          await sleep(100);
          await writeFile(join(root, 'provider-stopped'), 'yes');
        }
        return {status:0,stdout,stderr:''};
      };
      const options = {execute, gatewayFactory: () => ({start:async()=>{},stop:async()=>{},assertOwned:async()=>{}})};
      try {
        if (mode.startsWith('build')) await buildPersona(input, join(root, 'output'), {...options,executeBuild:true});
        else await verifyPersona(input, options);
      } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", driver, mode, mode.startsWith("build") ? f.path : join(built, "persona.json"), root], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => child.kill("SIGKILL"));
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    let waiting = false;
    for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
      try { await access(join(root, "waiting")); waiting = true; break; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(waiting, output);
    child.kill("SIGTERM");
    let timer;
    const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("interrupted persona did not finish cleanup")), 10000); })]).finally(() => clearTimeout(timer));
    assert.equal(result.code, 143, output);
    await access(join(root, "destroyed"));
    await access(join(root, "provider-stopped"));
    if (mode === "build-create" || mode === "verify-import") await access(join(root, "provision-child-finished"));
    await assert.rejects(access(join(root, "state.json")));
    if (!mode.startsWith("build")) {
      const copy = JSON.parse(await readFile(join(root, "copy.json"), "utf8"));
      await assert.rejects(access(copy.run));
      if (mode === "verify-cleanup") await access(join(root, "cleanup-child-finished"));
    } else {
      await assert.rejects(access(join(root, "output", "persona.json")));
      await assert.rejects(access(join(root, "output", ".building")));
    }
  });
}


test("imported trait preparation rebinds pairing, switches identity, and checks remapped companions", async () => {
  const selected = ["gateway-multi-user-profiles", "session-shared-readonly", "cli-profile-paired", "catalog-claude-transcript", "gateway-second-instance"].map((id) => definition.traits.find((trait) => trait.id === id));
  const events = [];
  const keys = Object.fromEntries(selected.map((trait) => [trait.id, Object.fromEntries(Object.keys(trait.keys).map((key) => [key, key === "env" ? "companion-copy" : `saved-${key}`]))]));
  const context = { env: "primary-copy", run: "/tmp/check-copy", kovaRoot: "/kova", traits: Object.fromEntries(selected.map((trait) => [trait.id, { keys: keys[trait.id] }])) };
  const call = async (command) => {
    assert.equal(command, "ocm env show 'primary-copy' --json");
    return { stdout: JSON.stringify({ name: context.env, root: "/env/copy", stateDir: "/env/copy/state" }) };
  };
  const gateway = { identityMode: async (enabled, existing) => { events.push(["identity", enabled, existing]); }, assertOwned: async () => { events.push(["owned"]); } };
  let index = 0;
  const result = await checkPersonaTraits({ traits: selected }, context, call, {
    gateway,
    rebind: async (metadata, state) => { events.push(["rebind", metadata.name, state]); },
    checkCommand: async (command) => {
      const trait = selected[index++];
      events.push(["check", trait.id]);
      if (trait.id === "gateway-second-instance") assert.ok(command.endsWith(" --companion-env 'companion-copy'"));
      return { stdout: JSON.stringify(keys[trait.id]) };
    },
  });
  assert.deepEqual(events[0], ["rebind", "primary-copy", "/env/copy/state"]);
  assert.deepEqual(events.filter(([event]) => event === "identity").map(([, enabled]) => enabled), [true, true, false, false, false, false]);
  assert.deepEqual(result["gateway-second-instance"].keys, { env: "companion-copy" });
  assert.equal(index, selected.length);
});

test("companion construction copies only stopped Gateway state and resumes the primary for checks", async () => {
  const trait = definition.traits.find((value) => value.id === "gateway-second-instance");
  const events = [];
  let running = true;
  const gateway = {
    assertOwned: async () => { assert.ok(running); },
    identityMode: async () => {},
    stop: async () => { running = false; events.push("stop"); },
    start: async () => { running = true; events.push("start"); },
  };
  const call = async (command) => {
    if (command.includes("second-environment.mjs' create") || command.includes("second-environment.mjs create")) {
      assert.equal(running, false, "an active primary ownership lease would be copied");
      events.push("clone");
    }
    if (command.includes("env show")) return { stdout: JSON.stringify({ root: "/nonexistent-persona-copy", stateDir: "/nonexistent-persona-copy/.openclaw" }) };
    if (command.startsWith("cat ")) return { stdout: "12345" };
    return { stdout: "" };
  };
  const context = { env: "primary-copy", run: "/tmp/companion-check", kovaRoot: "/kova", traits: {} };
  await checkPersonaTraits({ traits: [trait] }, context, call, {
    build: true, gateway,
    checkCommand: async () => { assert.ok(running); events.push("check"); return { stdout: JSON.stringify({ env: "primary-copy-second" }) }; },
  });
  assert.deepEqual(events, ["stop", "clone", "stop", "start", "check"]);
});


test("verification preserves a saved recipe hash after its unused builders retire", async (t) => {
  const f = await fixture(t);
  const options = { execute: f.execute, gatewayFactory: f.gatewayFactory };
  const out = join(f.root, "historical-definition");
  const manifest = await buildPersona(f.path, out, { ...options, executeBuild: true });
  const historical = JSON.parse(await readFile(f.path, "utf8"));
  historical.traits[0].builder = ["node {kovaRoot}/support/persona/retired-builder.mjs --env {env}"];
  await writeFile(f.path, JSON.stringify(historical));
  manifest.definition.sha256 = await hashFile(f.path);
  const path = join(out, "persona.json");
  await writeFile(path, JSON.stringify(manifest));
  f.calls.length = 0;
  await verifyPersona(path, options);
  assert.ok(f.calls.some((call) => call[0] === "ocm" && call[2] === "import"));
  assert.ok(!f.calls.some((call) => call.some((value) => typeof value === "string" && value.includes("retired-builder"))));
  f.calls.length = 0;
  await assert.rejects(buildPersona(f.path, join(f.root, "invalid-new-build"), { ...options, executeBuild: true, forVerification: true }), /no unique catalogue/);
  assert.equal(f.calls.length, 0, "a build cannot use verification-only admission");
  await writeFile(f.path, `${JSON.stringify(historical)}\n`);
  await assert.rejects(verifyPersona(path, options), /definition hash/);
  assert.equal(f.calls.length, 0, "a changed saved recipe still fails before import");
  historical.traits[0].check = "node {kovaRoot}/support/persona/retired-check.mjs --env {env}";
  await writeFile(f.path, JSON.stringify(historical));
  manifest.definition.sha256 = await hashFile(f.path);
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyPersona(path, options), /no unique catalogue/);
  assert.equal(f.calls.length, 0, "verification validates every command it will execute");
});
