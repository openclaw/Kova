import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { parseCatalogueCommand } from "../src/catalogue.mjs";
import { repoRoot } from "../src/paths.mjs";
import { createClone, hashFile, resolveRunCommand, stagePersona } from "../src/verify/clones.mjs";

const version = "2026.9.9";
const integrity = `sha512-${Buffer.alloc(64, 0x42).toString("base64")}`;
const runtime = "fixture-runtime";
const checkScript = join(repoRoot, "support/fixture-copy-check.mjs");
const lifecycleScript = join(repoRoot, "support/verify/gateway-lifecycle.mjs");

async function filesUnder(root, prefix = "") {
  const files = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await filesUnder(root, path));
    else {
      assert.ok(entry.isFile());
      files[path] = (await readFile(join(root, path))).toString("base64");
    }
  }
  return files;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-verify-clones-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environments = new Map();
  const created = new Set();
  const imports = [];
  const exports = [];
  const removed = [];
  const calls = [];
  const starts = [];
  const checks = [];
  const handles = new Map();
  let failImportSource;

  async function source(name, markers, defaultRuntime) {
    const envRoot = join(root, "original-sources", name);
    const stateDir = join(envRoot, ".openclaw");
    const workspaceDir = join(stateDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(stateDir, "openclaw.json"), '{"gateway":{"mode":"local"}}\n');
    for (const [filename, marker] of Object.entries(markers)) await writeFile(join(workspaceDir, filename), `${JSON.stringify({ marker })}\n`);
    await writeFile(join(stateDir, "binary-state"), Buffer.from([0, 1, 127, 128, 255]));
    const metadata = { name, root: envRoot, openclawHome: envRoot, stateDir, configPath: join(stateDir, "openclaw.json"), workspaceDir, defaultRuntime, defaultLauncher: null, protected: true, serviceEnabled: false, serviceRunning: false, gatewayPort: 12345 };
    environments.set(name, metadata);
    return metadata;
  }

  const primary = await source("persona-primary", { "primary.json": "primary-content" }, runtime);
  const extra = await source("persona-extra", { "first.json": "first-extra-content", "second.json": "second-extra-content" }, "extra-runtime");
  const sources = new Map([[primary.name, primary], [extra.name, extra]]);
  const originalFiles = new Map(await Promise.all([...sources].map(async ([name, metadata]) => [name, await filesUnder(metadata.root)])));

  // OCM archives are opaque to the clone code. This fixture snapshots real file
  // bytes and metadata while retaining the CLI receipt fields consumed by Kova.
  async function exportFiles(metadata, path) {
    await writeFile(path, JSON.stringify({ metadata, files: await filesUnder(metadata.root) }));
  }
  const archive = join(root, "primary.ocm-env.tar");
  await exportFiles(primary, archive);
  const manifest = {
    schema: "kova.verify.persona-manifest.v1", persona: "copy-fixture", version: "20261014T000000Z",
    runtime: { selector: `npm:${version}`, resolved: `${version}@${integrity}` },
    env: { name: primary.name, root: primary.root, export: archive, includeState: true, sha256: await hashFile(archive) },
    traits: {
      primary: { keys: { env: primary.name, copy: join(primary.workspaceDir, "primary.json"), marker: "primary-content" } },
      "extra-first": { keys: { env: extra.name, copy: join(extra.workspaceDir, "first.json"), marker: "first-extra-content" } },
      "extra-second": { keys: { env: extra.name, copy: join(extra.workspaceDir, "second.json"), marker: "second-extra-content" } }
    }
  };
  const definition = {
    schema: "kova.verify.persona.v1", id: manifest.persona, runtime: { selector: manifest.runtime.selector }, credentials: [],
    traits: Object.keys(manifest.traits).map((id) => ({
      id, keys: { env: "environment", copy: "marker file", marker: "stored marker" },
      check: `node {kovaRoot}/support/fixture-copy-check.mjs --env {persona:${id}:env} --copy {persona:${id}:copy}`
    }))
  };
  const definitionPath = join(root, "definition.json");
  await writeFile(definitionPath, JSON.stringify(definition));
  manifest.definition = { path: definitionPath, sha256: await hashFile(definitionPath) };

  const response = (command, value) => ({ command, status: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false, signal: null });
  async function call(command, options = {}) {
    const { tokens, findings } = parseCatalogueCommand(command);
    assert.deepEqual(findings, [], command);
    calls.push(tokens);
    const [binary, kind, operation] = tokens;
    if (binary === "node" && kind === lifecycleScript) {
      assert.equal(operation, "start");
      assert.deepEqual(tokens.slice(3).filter((_, index) => index % 2 === 0), ["--env", "--handle", "--timeout"]);
      const env = tokens[4], handle = tokens[6];
      assert.equal(tokens[8], "120000");
      assert.ok(created.has(env), "Gateway must target a created copy");
      assert.ok(!handles.has(handle));
      handles.set(handle, env);
      starts.push(env);
      return response(command, { entry: "foreground-gateway-start", env, startedAt: "2026-10-14T00:00:00Z", ref: {} });
    }
    if (binary === "node" && kind === checkScript) {
      assert.deepEqual(tokens.filter((_, index) => index === 2 || index === 4), ["--env", "--copy"]);
      assert.equal(tokens.length, 6);
      const env = tokens[3], path = tokens[5];
      const metadata = environments.get(env);
      assert.ok(created.has(env), "trait check must target a created copy");
      assert.ok(path.startsWith(`${metadata.root}${sep}`), "trait file must belong to that copy");
      assert.ok([...handles.values()].includes(env), "trait checks require the recorded Gateway start");
      const content = JSON.parse(await readFile(path, "utf8"));
      checks.push({ env, path, marker: content.marker });
      return response(command, { env, copy: path, marker: content.marker });
    }
    assert.equal(binary, "ocm", `unexpected command: ${command}`);
    if (kind === "env" && operation === "show") {
      assert.deepEqual(tokens.slice(4), ["--json"]);
      const metadata = environments.get(tokens[3]);
      if (!metadata) {
        assert.equal(options.allowFailure, true);
        return { command, status: 1, stdout: "", stderr: `ocm: environment "${tokens[3]}" does not exist`, timedOut: false, signal: null };
      }
      return response(command, metadata);
    }
    if (kind === "env" && operation === "export") {
      const name = tokens[3], path = tokens[5];
      assert.deepEqual(tokens.slice(4), ["--out", path, "--include-state", "--json"]);
      const metadata = environments.get(name);
      assert.ok(sources.has(name));
      await exportFiles(metadata, path);
      exports.push({ name, path });
      return response(command, { includeState: true, name, root: metadata.root, archivePath: path, defaultRuntime: metadata.defaultRuntime, defaultLauncher: null, protected: metadata.protected });
    }
    if (kind === "env" && operation === "import") {
      const path = tokens[3], name = tokens[5];
      assert.deepEqual(tokens.slice(4), ["--name", name, "--json"]);
      assert.ok(!environments.has(name));
      const saved = JSON.parse(await readFile(path, "utf8"));
      const envRoot = join(root, "created copies", name);
      for (const [file, bytes] of Object.entries(saved.files)) {
        const destination = join(envRoot, file);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(bytes, "base64"));
      }
      const stateDir = join(envRoot, ".openclaw");
      const metadata = { ...saved.metadata, name, root: envRoot, openclawHome: envRoot, stateDir, configPath: join(stateDir, "openclaw.json"), workspaceDir: join(stateDir, "workspace"), serviceEnabled: false, serviceRunning: false };
      environments.set(name, metadata);
      created.add(name);
      imports.push({ name, source: saved.metadata.name, archive: path, root: envRoot });
      if (saved.metadata.name === failImportSource) throw new Error("import response interrupted after creating the copy");
      return response(command, { name, sourceName: saved.metadata.name, root: envRoot, archivePath: path, defaultRuntime: metadata.defaultRuntime, defaultLauncher: null, protected: metadata.protected });
    }
    if (kind === "env" && operation === "protect") {
      assert.deepEqual(tokens.slice(4), ["off", "--json"]);
      assert.ok(created.has(tokens[3]), "source protection must remain unchanged");
      environments.get(tokens[3]).protected = false;
      return response(command, environments.get(tokens[3]));
    }
    if (kind === "start") {
      const name = operation;
      assert.ok(created.has(name));
      assert.deepEqual(tokens.slice(5), ["--no-service", "--json"]);
      const metadata = environments.get(name);
      if (tokens[3] === "--version") {
        assert.equal(tokens[4], version);
        metadata.defaultRuntime = runtime;
      } else {
        assert.equal(tokens[3], "--runtime");
        assert.equal(tokens[4], extra.defaultRuntime);
        metadata.defaultRuntime = tokens[4];
      }
      return response(command, { envName: name, created: false, root: metadata.root, gatewayPort: metadata.gatewayPort, defaultRuntime: metadata.defaultRuntime, defaultLauncher: null, serviceRequested: false, serviceStarted: false });
    }
    if (kind === "runtime" && operation === "show") {
      assert.equal(tokens.length, 5);
      assert.equal(tokens[4], "--json");
      assert.ok([runtime, extra.defaultRuntime].includes(tokens[3]));
      return response(command, { name: tokens[3], sourceKind: "installed", releaseVersion: version, sourceIntegrity: integrity });
    }
    if (kind === "env" && operation === "destroy") {
      const name = tokens[3];
      assert.deepEqual(tokens.slice(4), ["--yes", "--json"]);
      assert.ok(created.has(name), "only created copies may be removed");
      assert.equal(environments.get(name).protected, false);
      assert.ok(![...handles.values()].includes(name), "Gateway cleanup must precede environment removal");
      await rm(environments.get(name).root, { recursive: true });
      environments.delete(name);
      removed.push(name);
      return response(command, { name, destroyed: true });
    }
    assert.fail(`unexpected OCM command: ${command}`);
  }
  const cleanupHandle = async (handle) => { handles.delete(handle); };
  const stagedDirectory = join(root, "staged persona");
  await mkdir(stagedDirectory);
  const persona = await stagePersona({ manifest, definition, archive }, stagedDirectory, call);
  const clone = (name) => createClone({ name, directory: join(root, "runs", name), persona, root: repoRoot, call, cleanupCall: call, cleanupHandle });
  return { root, primary, extra, persona, manifest, originalFiles, environments, imports, exports, removed, calls, starts, checks, handles, clone, failImport: (sourceName) => { failImportSource = sourceName; } };
}

test("extra environment snapshots are deduplicated and every run receives independent content and routing", async (t) => {
  const f = await fixture(t);
  assert.equal(f.persona.extra.size, 1);
  assert.deepEqual(f.exports.map((item) => item.name), [f.extra.name]);
  assert.equal(await hashFile(f.persona.archive), f.manifest.env.sha256);
  const snapshot = f.persona.extra.get(f.extra.name);
  assert.equal(await hashFile(snapshot.archive), snapshot.sha256);
  assert.deepEqual(JSON.parse(await readFile(snapshot.archive, "utf8")).files, f.originalFiles.get(f.extra.name));
  const first = f.clone("baseline"), second = f.clone("change-1");
  try {
    await first.prepare();
    await second.prepare();
    assert.equal(f.imports.length, 4);
    assert.equal(new Set(f.imports.map((item) => item.name)).size, 4);
    assert.equal(f.imports.filter((item) => item.archive === snapshot.archive).length, 2);
    for (const imported of f.imports) assert.deepEqual(await filesUnder(imported.root), f.originalFiles.get(imported.source));
    const firstContext = first.context(), secondContext = second.context();
    const firstExtra = firstContext.traits["extra-first"].keys.env;
    const secondExtra = secondContext.traits["extra-first"].keys.env;
    assert.notEqual(firstExtra, secondExtra);
    assert.notEqual(firstExtra, f.extra.name);
    assert.equal(firstContext.traits["extra-second"].keys.env, firstExtra);
    assert.equal(secondContext.traits["extra-second"].keys.env, secondExtra);
    assert.equal(firstContext.traits.primary.keys.env, first.metadata.name);
    assert.equal(secondContext.traits.primary.keys.env, second.metadata.name);
    for (const copy of [first, second]) {
      const context = copy.context();
      const target = context.traits["extra-first"].keys.env;
      const resolved = resolveRunCommand("ocm @{persona:extra-first:env} -- status --json", context);
      assert.deepEqual(parseCatalogueCommand(resolved).tokens, ["ocm", `@${target}`, "--", "status", "--json"]);
      assert.deepEqual(copy.contexts().map((item) => item.env), [copy.metadata.name, target]);
      assert.deepEqual(copy.contexts().map((item) => item.run), [copy.directory, join(copy.directory, "extra-1")]);
      for (const trait of Object.values(context.traits)) {
        const source = trait.keys.env === copy.metadata.name ? f.primary : f.extra;
        const pathInSource = join(source.root, relative(f.environments.get(trait.keys.env).root, trait.keys.copy));
        assert.deepEqual(await readFile(trait.keys.copy), await readFile(pathInSource));
      }
    }
    assert.equal(f.checks.length, 6);
    assert.deepEqual(new Set(f.starts), new Set(f.imports.map((item) => item.name)));
    assert.equal(f.handles.size, 0);
    await writeFile(firstContext.traits["extra-first"].keys.copy, '{"marker":"changed in first copy"}\n');
    assert.equal(JSON.parse(await readFile(secondContext.traits["extra-first"].keys.copy, "utf8")).marker, "first-extra-content");
    assert.equal(f.manifest.traits["extra-first"].keys.env, f.extra.name);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
  assert.deepEqual(new Set(f.removed), new Set(f.imports.map((item) => item.name)));
  assert.deepEqual(new Set(f.environments.keys()), new Set([f.primary.name, f.extra.name]));
  for (const source of [f.primary, f.extra]) {
    assert.equal(source.protected, true);
    assert.deepEqual(await filesUnder(source.root), f.originalFiles.get(source.name));
  }
  for (const imported of f.imports) await assert.rejects(readFile(join(imported.root, ".openclaw/openclaw.json")), { code: "ENOENT" });
});

test("an import that creates its environment before failing remains owned for cleanup", async (t) => {
  const f = await fixture(t);
  f.failImport(f.extra.name);
  const copy = f.clone("interrupted");
  try {
    await assert.rejects(copy.prepare(), /import response interrupted/);
    assert.equal(f.imports.length, 2);
    assert.equal(f.imports[1].source, f.extra.name);
    assert.ok(f.environments.has(f.imports[1].name));
    assert.deepEqual(await filesUnder(f.imports[1].root), f.originalFiles.get(f.extra.name));
  } finally { await copy.cleanup(); }
  assert.deepEqual(f.removed, f.imports.map((item) => item.name).reverse());
  assert.deepEqual(new Set(f.environments.keys()), new Set([f.primary.name, f.extra.name]));
  assert.deepEqual(f.starts, []);
  for (const source of [f.primary, f.extra]) assert.deepEqual(await filesUnder(source.root), f.originalFiles.get(source.name));
  await copy.cleanup();
  assert.equal(f.removed.length, 2);
});
