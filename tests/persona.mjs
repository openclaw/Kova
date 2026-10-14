import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadCatalogue, parseCatalogueCommand } from "../src/catalogue.mjs";
import { loadDefinition, validateDefinition, resolveCommand, readKeys } from "../src/persona/definition.mjs";
import { createForegroundGateway } from "../src/persona/gateway.mjs";
import { buildPersona, verifyPersona, hashFile } from "../src/persona/lifecycle.mjs";

const source = new URL("../personas/openclaw-verification-user.json", import.meta.url);
const definition = JSON.parse(await readFile(source, "utf8"));
const { catalogue } = await loadCatalogue("openclaw");
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
    [(d) => d.credentials.push("external-account"), /empty credentials/],
  ]) {
    const invalid = structuredClone(definition); change(invalid);
    assert.throws(() => validateDefinition(invalid, catalogue), pattern);
  }
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
  await writeFile(path, JSON.stringify(definition));
  const calls = [];
  let failTrait = null, failDestroy = false;
  const execute = async (command) => {
    const tokens = parseCatalogueCommand(command).tokens;
    calls.push(tokens);
    let stdout = tokens[0] === "cat" ? "12345\n" : "";
    if (tokens[0] === "ocm" && tokens[1] === "start") stdout = JSON.stringify({ envName: tokens[2], defaultRuntime: "test-runtime", defaultLauncher: null });
    if (tokens[0] === "ocm" && tokens[1] === "env" && tokens[2] === "show") stdout = JSON.stringify({ root, stateDir: join(root, ".openclaw") });
    if (tokens[0] === "ocm" && tokens[1] === "runtime" && tokens[2] === "show") stdout = JSON.stringify({ name: "test-runtime", sourceKind: "installed", releaseVersion: "2026.9.9", sourceIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}` });
    if (tokens[0] === "ocm" && tokens[1] === "env" && tokens[2] === "export") await writeFile(tokens[tokens.indexOf("--output") + 1], "test export bytes");
    if (tokens[1]?.endsWith("check-foundation.mjs")) {
      const trait = tokens[tokens.indexOf("--trait") + 1];
      if (trait === failTrait) return { status: 1, stderr: "planted missing content" };
      stdout = JSON.stringify(foundationKeys[trait]);
    }
    if (tokens[0] === "ocm" && tokens[2] === "destroy" && failDestroy) return { status: 1, stderr: "planted cleanup refusal" };
    return { command, status: 0, stdout, stderr: "" };
  };
  return { root, path, calls, execute, gatewayFactory: (env) => ({ start: async () => { calls.push(["foreground-start", env]); }, stop: async () => { calls.push(["foreground-stop", env]); } }), fail: (trait) => { failTrait = trait; }, failCleanup: () => { failDestroy = true; } };
}

test("build exports only checked content, verifies an import and keeps only the durable environment", async (t) => {
  const f = await fixture(t);
  const out = join(f.root, "built");
  const manifest = await buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory });
  assert.equal(manifest.schema, "kova.verify.persona-manifest.v1");
  assert.equal(manifest.env.sha256, await hashFile(manifest.env.export));
  assert.equal(manifest.env.includeState, true);
  assert.ok(f.calls.find((c) => c[0] === "ocm" && c[2] === "export").includes("--include-state"));
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.traits).map(([id, row]) => [id, row.keys])), foundationKeys);
  const destroyed = f.calls.filter((c) => c[0] === "ocm" && c[2] === "destroy");
  assert.equal(destroyed.length, 1);
  assert.ok(!f.calls.some((c) => c[0] === "ocm" && c[1] === "service"));
  const exportIndex = f.calls.findIndex((c) => c[0] === "ocm" && c[2] === "export");
  assert.ok(f.calls.slice(0, exportIndex).some((c) => c[0] === "foreground-stop" && c[1] === manifest.env.name));
  assert.match(destroyed[0][3], /^kova-persona-verify-/);
  assert.notEqual(destroyed[0][3], manifest.env.name);
  assert.equal(f.calls.filter((c) => c[1]?.endsWith("check-foundation.mjs")).length, 10);
  assert.equal(f.calls.filter((c) => c[1]?.endsWith("build-foundation.mjs")).length, 5);
  f.calls.length = 0;
  const verify = await verifyPersona(join(out, "persona.json"), { execute: f.execute, gatewayFactory: f.gatewayFactory });
  assert.equal(verify.ok, true);
  assert.ok(!f.calls.some((c) => c.some((arg) => arg.endsWith("configure-openclaw-mock-auth.mjs"))));
  assert.ok(f.calls.some((c) => c.includes("models.providers.openai.baseUrl")));
  await assert.rejects(buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory }), /empty/);
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
  const call = async () => ({ stdout: JSON.stringify({ gatewayPort: port }) });
  const source = 'require("fs").writeFileSync(process.argv[2],String(process.pid));require("http").createServer((q,s)=>{s.writeHead(q.url==="/readyz"?Number(process.argv[3]):200);s.end("health")}).listen(Number(process.argv[1]),"127.0.0.1")';
  const invocation = (status) => () => ({ file: process.execPath, args: ["-e", source, String(port), pidFile, String(status)], env: process.env });
  const gateway = createForegroundGateway("kova-persona-fixture", call, { invocation: invocation(200), timeoutMs: 5000 });
  t.after(() => gateway.stop());
  await gateway.start();
  const first = Number(await readFile(pidFile, "utf8"));
  await gateway.start();
  const second = Number(await readFile(pidFile, "utf8"));
  assert.notEqual(first, second);
  assert.throws(() => process.kill(first, 0), { code: "ESRCH" });
  await gateway.stop();
  assert.throws(() => process.kill(second, 0), { code: "ESRCH" });
  const unhealthy = createForegroundGateway("kova-persona-fixture", call, { invocation: invocation(503), timeoutMs: 1000 });
  t.after(() => unhealthy.stop());
  await assert.rejects(unhealthy.start(), /did not become healthy/);
  const failed = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(failed, 0), { code: "ESRCH" });
});
