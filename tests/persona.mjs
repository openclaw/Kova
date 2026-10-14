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
import { loadDefinition, validateDefinition, resolveCommand, readKeys } from "../src/persona/definition.mjs";
import { createForegroundGateway } from "../src/persona/gateway.mjs";
import { buildPersona, verifyPersona, hashFile } from "../src/persona/lifecycle.mjs";

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
  await writeFile(path, JSON.stringify(lifecycleDefinition));
  const calls = [];
  let failTrait = null, failDestroy = false, failProvision = null, occupied = false;
  let keysFor = (trait) => foundationKeys[trait];
  const environments = new Set(), runs = new Set();
  t.after(async () => { for (const run of runs) await rm(run, { recursive: true, force: true }); });
  const execute = async (command) => {
    if (command.includes("/src/persona/provenance.mjs")) return { status: 0, stdout: JSON.stringify({ binary: "/fixture/native-ocm", version: "0.3.3", sha256: "a".repeat(64) }), stderr: "" };
    const tokens = parseCatalogueCommand(command).tokens;
    calls.push(tokens);
    let stdout = tokens[0] === "cat" ? "12345\n" : "";
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
    if (tokens[0] === "ocm" && tokens[1] === "runtime" && tokens[2] === "show") stdout = JSON.stringify({ name: "test-runtime", sourceKind: "installed", releaseVersion: "2026.9.9", sourceIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}` });
    if (tokens[0] === "ocm" && tokens[1] === "env" && tokens[2] === "export") await writeFile(tokens[tokens.indexOf("--output") + 1], "test export bytes");
    const trait = checkTraits[tokens[1]?.split("/").at(-1)];
    if (trait) {
      if (trait === failTrait) return { status: 1, stderr: "planted missing content" };
      const env = tokens[tokens.indexOf("--env") + 1];
      stdout = JSON.stringify(keysFor(trait, join(root, "envs", env)));
    }
    return { command, status: 0, stdout, stderr: "" };
  };
  return { root, path, calls, execute, environments, keysFor: (fn) => { keysFor = fn; }, failProvision: (kind) => { failProvision = kind; }, occupy: () => { occupied = true; }, gatewayFactory: (env) => ({ assertOwned: async () => {}, start: async () => { calls.push(["foreground-start", env]); }, stop: async () => { calls.push(["foreground-stop", env]); } }), fail: (trait) => { failTrait = trait; }, failCleanup: () => { failDestroy = true; } };
}

test("build exports only checked content, verifies an import and keeps only the durable environment", async (t) => {
  const f = await fixture(t);
  const out = join(f.root, "built");
  const manifest = await buildPersona(f.path, out, { executeBuild: true, execute: f.execute, gatewayFactory: f.gatewayFactory });
  assert.equal(manifest.schema, "kova.verify.persona-manifest.v1");
  assert.deepEqual(manifest.runtime.ocm, { binary: "/fixture/native-ocm", version: "0.3.3", sha256: "a".repeat(64) });
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
  assert.equal(f.calls.filter((c) => checkTraits[c[1]?.split("/").at(-1)]).length, 10);
  assert.equal(f.calls.filter((c) => c[1]?.endsWith("add-agent.mjs")).length, 2);
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
