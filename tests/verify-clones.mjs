import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, link, mkdtemp, mkdir, readFile, readdir, realpath as realpathForTest, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { pipeline } from "node:stream/promises";
import { extract as extractTar, pack as packTar } from "tar-stream";
import JSON5 from "json5";
import { parseCatalogueCommand } from "../src/catalogue.mjs";
import { repoRoot } from "../src/paths.mjs";
import { createClone, hashEnvironmentExport, hashFile, resolveRunCommand, stagePersona } from "../src/verify/clones.mjs";
import { combineLogCollectors, createLogCollector, writeCheckpoint } from "../src/verify/checkpoint.mjs";

const version = "2026.9.9";
const integrity = `sha512-${Buffer.alloc(64, 0x42).toString("base64")}`;
const runtime = "fixture-runtime";
const checkScript = join(repoRoot, "support/fixture-copy-check.mjs");
const lifecycleScript = join(repoRoot, "support/verify/gateway-lifecycle.mjs");

async function writeArchive(path, metadata, files, { fileMode = 0o600 } = {}) {
  const archive = packTar();
  const completed = pipeline(archive, createWriteStream(path));
  const append = (name, type, contents = Buffer.alloc(0), mode = fileMode) => new Promise((accept, reject) => {
    archive.entry({ name, type, mode, mtime: new Date(0), uid: 0, gid: 0 }, contents, (error) => error ? reject(error) : accept());
  });
  try {
    await append("meta/env.json", "file", Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`), 0o644);
    const directories = new Set(["root"]);
    for (const file of Object.keys(files)) {
      let parent = dirname(`root/${file.split(sep).join("/")}`);
      while (parent !== ".") { directories.add(parent); parent = dirname(parent); }
    }
    for (const directory of [...directories].sort()) await append(directory, "directory", Buffer.alloc(0), 0o700);
    for (const [file, bytes] of Object.entries(files)) await append(`root/${file.split(sep).join("/")}`, "file", Buffer.from(bytes, "base64"));
    archive.finalize();
    await completed;
  } catch (error) {
    archive.destroy(error);
    await completed.catch(() => {});
    throw error;
  }
}

async function readArchive(path) {
  const extractor = extractTar();
  const files = {};
  let metadata;
  extractor.on("entry", (header, stream, next) => {
    stream.on("error", () => {});
    void (async () => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (header.name === "meta/env.json") metadata = JSON.parse(bytes.toString("utf8"));
      else if (header.type === "file") {
        assert.ok(header.name.startsWith("root/"));
        files[header.name.slice(5)] = bytes.toString("base64");
      }
    })().then(() => next(), (error) => next(error));
  });
  await pipeline(createReadStream(path), extractor);
  assert.equal(metadata.kind, "ocm-env-archive");
  return { metadata: metadata.env, files, archiveMetadata: metadata };
}

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

async function fixture(t, { configureImported } = {}) {
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
  let exportSequence = 0;

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

  // Match OCM's meta/env.json plus root/ layout with captured file bytes.
  async function exportFiles(metadata, path) {
    await writeArchive(path, {
      kind: "ocm-env-archive", formatVersion: 1, includeState: true,
      exportedAt: new Date(Date.UTC(2026, 9, 14, 0, 0, 0, exportSequence++)).toISOString(),
      env: {
        name: metadata.name, sourceRoot: metadata.root, gatewayPort: metadata.gatewayPort, gatewayPortAutoAssigned: false,
        serviceEnabled: metadata.serviceEnabled, serviceRunning: metadata.serviceRunning,
        defaultRuntime: metadata.defaultRuntime, defaultLauncher: metadata.defaultLauncher, protected: metadata.protected,
        createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", lastUsedAt: null
      }
    }, await filesUnder(metadata.root));
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
      checks.push({ env, path, marker: content.marker, cwd: options.cwd });
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
      assert.deepEqual(tokens.slice(4), ["--output", path, "--include-state", "--json"]);
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
      const saved = await readArchive(path);
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
      await configureImported?.(metadata, saved.metadata.name);
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
      const config = JSON5.parse(await readFile(metadata.configPath, "utf8"));
      assert.ok(config.logging.file.startsWith(`${metadata.root}${sep}`) || config.logging.file.startsWith(`${await realpathForTest(metadata.root)}${sep}`), "product log destination must be owned before runtime binding");
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
  const clone = (name, options = {}) => createClone({ name, directory: join(root, "runs", name), persona, root: repoRoot, call, cleanupCall: call, cleanupHandle, ...options });
  const restage = async (label) => {
    const directory = join(root, label);
    await mkdir(directory);
    return await stagePersona({ manifest, definition, archive }, directory, call);
  };
  return { root, primary, extra, persona, manifest, originalFiles, environments, imports, exports, removed, calls, starts, checks, handles, clone, restage, failImport: (sourceName) => { failImportSource = sourceName; } };
}

test("captured export digests ignore only export time while retaining content and metadata", async (t) => {
  const f = await fixture(t);
  const first = f.persona.extra.get(f.extra.name);
  const repeated = (await f.restage("repeated-export")).extra.get(f.extra.name);
  assert.notEqual(repeated.sha256, first.sha256);
  assert.equal(repeated.contentSha256, first.contentSha256);
  assert.equal(repeated.sha256, await hashFile(repeated.archive));
  const saved = await readArchive(first.archive);
  const changedTime = join(f.root, "changed-time.tar");
  await writeArchive(changedTime, { ...saved.archiveMetadata, exportedAt: "2030-01-01T00:00:00Z" }, saved.files);
  assert.equal((await hashEnvironmentExport(changedTime)).contentSha256, first.contentSha256);
  const changedMode = join(f.root, "changed-mode.tar");
  await writeArchive(changedMode, saved.archiveMetadata, saved.files, { fileMode: 0o644 });
  assert.notEqual((await hashEnvironmentExport(changedMode)).contentSha256, first.contentSha256);
  f.extra.gatewayPort += 1;
  const changedMetadata = (await f.restage("changed-metadata")).extra.get(f.extra.name);
  assert.notEqual(changedMetadata.contentSha256, first.contentSha256);
  f.extra.gatewayPort -= 1;
  await writeFile(join(f.extra.workspaceDir, "first.json"), '{"marker":"changed-content"}\n');
  // Hashing the captured archive must not observe later changes to its source.
  assert.deepEqual(await hashEnvironmentExport(first.archive), { sha256: first.sha256, contentSha256: first.contentSha256 });
  const changedContent = (await f.restage("changed-content")).extra.get(f.extra.name);
  assert.notEqual(changedContent.contentSha256, first.contentSha256);
});

test("extra environment snapshots are deduplicated and every run receives independent content and routing", async (t) => {
  const f = await fixture(t);
  assert.equal(f.persona.extra.size, 1);
  assert.deepEqual(f.exports.map((item) => item.name), [f.extra.name]);
  assert.equal(await hashFile(f.persona.archive), f.manifest.env.sha256);
  const snapshot = f.persona.extra.get(f.extra.name);
  assert.equal(await hashFile(snapshot.archive), snapshot.sha256);
  assert.deepEqual((await readArchive(snapshot.archive)).files, f.originalFiles.get(f.extra.name));
  const first = f.clone("baseline"), second = f.clone("change-1");
  try {
    await first.prepare();
    await second.prepare();
    assert.equal(f.imports.length, 4);
    assert.equal(new Set(f.imports.map((item) => item.name)).size, 4);
    assert.equal(f.imports.filter((item) => item.archive === snapshot.archive).length, 2);
    for (const imported of f.imports) {
      const actual = await filesUnder(imported.root), expected = { ...f.originalFiles.get(imported.source) };
      const configKey = join(".openclaw", "openclaw.json");
      const originalConfig = JSON.parse(Buffer.from(expected[configKey], "base64").toString("utf8"));
      const copyConfig = JSON5.parse(Buffer.from(actual[configKey], "base64").toString("utf8"));
      assert.deepEqual(copyConfig, { ...originalConfig, logging: { file: join(await realpathForTest(imported.root), ".openclaw/logs/kova-product.log") } });
      delete actual[configKey]; delete expected[configKey];
      assert.deepEqual(actual, expected);
    }
    const firstContext = first.context(), secondContext = second.context();
    const firstExtra = firstContext.traits["extra-first"].keys.env;
    const secondExtra = secondContext.traits["extra-first"].keys.env;
    assert.notEqual(firstExtra, secondExtra);
    assert.notEqual(firstExtra, f.extra.name);
    assert.equal(firstContext.traits["extra-second"].keys.env, firstExtra);
    assert.equal(secondContext.traits["extra-second"].keys.env, secondExtra);
    assert.equal(firstContext.traits.primary.keys.env, first.metadata.name);
    assert.equal(secondContext.traits.primary.keys.env, second.metadata.name);
    assert.equal(firstContext.cwd, first.metadata.workspaceDir);
    assert.deepEqual(firstContext.ownedRoots, first.contexts().map((context) => f.environments.get(context.env).root));
    for (const copy of [first, second]) {
      const context = copy.context();
      const target = context.traits["extra-first"].keys.env;
      const resolved = resolveRunCommand("ocm @{persona:extra-first:env} -- status --json", context);
      assert.deepEqual(parseCatalogueCommand(resolved).tokens, ["ocm", `@${target}`, "--", "status", "--json"]);
      assert.deepEqual(copy.contexts().map((item) => item.env), [copy.metadata.name, target]);
      assert.deepEqual(copy.contexts().map((item) => item.run), [copy.directory, join(copy.directory, "extra-1")]);
      assert.deepEqual(copy.contexts().map((item) => item.cwd), copy.contexts().map((item) => f.environments.get(item.env).workspaceDir));
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

test("clone-owned file logs reach checkpoints with silent consoles, rotation and destination changes", async (t) => {
  const explicit = new Map();
  const f = await fixture(t, { configureImported: async (metadata, source) => {
    if (source === "persona-primary") {
      await writeFile(metadata.configPath, "{ gateway: { mode: 'local' }, logging: { consoleLevel: 'silent' } }\n");
    } else {
      const file = join(metadata.stateDir, "logs/custom.log");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "imported history\n");
      const config = `{ gateway: { mode: 'local' }, logging: { consoleLevel: 'silent', file: ${JSON.stringify(file)} } }\n`;
      await writeFile(metadata.configPath, config);
      explicit.set(metadata.name, { file, config });
    }
  } });
  const copy = f.clone("file-logs");
  try {
    await copy.prepare();
    const primary = copy.metadata;
    const extra = f.environments.get(copy.context().traits["extra-first"].keys.env);
    const primaryConfig = JSON5.parse(await readFile(primary.configPath, "utf8"));
    assert.equal(primaryConfig.logging.consoleLevel, "silent");
    assert.equal(await readFile(extra.configPath, "utf8"), explicit.get(extra.name).config, "an explicit owned destination keeps its authored config");
    const primaryFile = primaryConfig.logging.file, extraFile = explicit.get(extra.name).file;
    await mkdir(dirname(primaryFile), { recursive: true });
    await writeFile(primaryFile, "file-only primary error\n");
    await appendFile(extraFile, "file-only auxiliary error\n");
    await assert.rejects(writeCheckpoint({
      phase: { id: "intent/rejected-file-errors", checkpoint: ["logs", "state:../outside"] },
      directory: copy.directory, stateDirectory: primary.stateDir, results: [], collectLogs: copy.collectProductLogs
    }), /invalid checkpoint state path/);
    const checkpoint = await writeCheckpoint({ phase: { id: "intent/file-errors", checkpoint: ["logs"] }, directory: copy.directory, results: [], collectLogs: copy.collectProductLogs });
    const text = await readFile(join(checkpoint.path, "logs.txt"), "utf8");
    assert.match(text, /file-only primary error/);
    assert.match(text, /file-only auxiliary error/);
    assert.doesNotMatch(text, /imported history/);
    assert.equal(await copy.collectProductLogs(), "");
    await appendFile(extraFile, "unread before rotation\n");
    await rename(extraFile, join(dirname(extraFile), "custom.1.log"));
    await writeFile(extraFile, "new active file\n");
    const rotated = await copy.collectProductLogs();
    assert.match(rotated, /unread before rotation/);
    assert.match(rotated, /new active file/);
    assert.doesNotMatch(rotated, /imported history|file-only auxiliary error/);
    const changedFile = join(primary.stateDir, "changed.log");
    primaryConfig.logging.file = changedFile;
    await writeFile(primary.configPath, JSON.stringify(primaryConfig));
    await writeFile(changedFile, "changed destination error\n");
    await appendFile(primaryFile, "late previous destination error\n");
    const changed = await copy.collectProductLogs();
    assert.match(changed, /changed destination error/);
    assert.match(changed, /late previous destination error/);
    assert.equal(await copy.collectProductLogs(), "");
    await writeFile(changedFile, "x\n");
    assert.equal(await copy.collectProductLogs(), "x\n");
    await appendFile(changedFile, "retained across failed capture\n");
    await truncate(extraFile, 16 * 1024 * 1024 + 100);
    await assert.rejects(copy.collectProductLogs(), /16 MiB output budget/);
    await writeFile(extraFile, "small\n");
    const recovered = await copy.collectProductLogs();
    assert.match(recovered, /retained across failed capture/);
    assert.match(recovered, /small/);
    const shared = join(f.root, "unowned.log");
    await writeFile(shared, "unowned content\n");
    primaryConfig.logging.file = shared;
    await writeFile(primary.configPath, JSON.stringify(primaryConfig));
    await assert.rejects(writeCheckpoint({ phase: { id: "intent/unsafe-file", checkpoint: ["logs"] }, directory: copy.directory, results: [], collectLogs: copy.collectProductLogs }), /inside its clone root/);
    await assert.rejects(readFile(join(copy.directory, "checkpoints/intent/unsafe-file/logs.txt")), { code: "ENOENT" });
    const alias = join(primary.stateDir, "alias.log");
    primaryConfig.logging.file = alias;
    await writeFile(primary.configPath, JSON.stringify(primaryConfig));
    await symlink(shared, alias);
    await assert.rejects(copy.collectProductLogs(), /aliased paths/);
    await rm(alias);
    await link(shared, alias);
    await assert.rejects(copy.collectProductLogs(), /aliased paths/);
    await rm(alias);
    const aliasDirectory = join(primary.stateDir, "alias-directory");
    await symlink(f.root, aliasDirectory, "dir");
    primaryConfig.logging.file = join(aliasDirectory, "unowned.log");
    await writeFile(primary.configPath, JSON.stringify(primaryConfig));
    await assert.rejects(copy.collectProductLogs(), /aliased paths/);
    primaryConfig.logging.file = "relative.log";
    await writeFile(primary.configPath, JSON.stringify(primaryConfig));
    await assert.rejects(copy.collectProductLogs(), /direct absolute/);
    delete primaryConfig.logging.file;
    await writeFile(primary.configPath, JSON.stringify(primaryConfig));
    await assert.rejects(copy.collectProductLogs(), /logging.file is missing/);
    await writeFile(primary.configPath, '{"$include":"logging.json"}');
    await assert.rejects(copy.collectProductLogs(), /directly authored/);
    assert.equal(await readFile(shared, "utf8"), "unowned content\n");
  } finally { await copy.cleanup(); }
  for (const source of [f.primary, f.extra]) assert.deepEqual(await filesUnder(source.root), f.originalFiles.get(source.name));
});

test("external imported log destinations are refused before product startup", async (t) => {
  const f = await fixture(t, { configureImported: async (metadata) => {
    await writeFile(metadata.configPath, JSON.stringify({ logging: { file: join(dirname(metadata.root), "outside.log") } }));
  } });
  const copy = f.clone("unowned-logs");
  try {
    await assert.rejects(copy.prepare(), /inside its clone root/);
    assert.deepEqual(f.starts, []);
    assert.equal(f.calls.filter((tokens) => tokens[0] === "ocm" && tokens[1] === "start").length, 0);
  } finally { await copy.cleanup(); }
  for (const source of [f.primary, f.extra]) assert.deepEqual(await filesUnder(source.root), f.originalFiles.get(source.name));
});

test("trait commands are validated before execution with an owned cwd and clean up after refusal", async (t) => {
  const f = await fixture(t);
  const validated = [];
  const copy = f.clone("validated-checks", { validateCommand: async (command, context) => {
    assert.equal(f.checks.length, validated.length, "each check must wait for its validation");
    assert.equal(context.cwd, copy.metadata.workspaceDir);
    assert.ok(context.ownedRoots.some((root) => context.cwd.startsWith(`${root}${sep}`)));
    assert.equal(parseCatalogueCommand(command).tokens[1], checkScript);
    validated.push({ command, cwd: context.cwd });
  } });
  try {
    await copy.prepare();
    assert.equal(validated.length, f.persona.definition.traits.length);
    assert.deepEqual(f.checks.map((check) => check.cwd), validated.map((check) => check.cwd));
  } finally { await copy.cleanup(); }
  const before = f.checks.length;
  const refused = f.clone("refused-checks", { validateCommand: async () => { throw new Error("trait destination refused"); } });
  try {
    await assert.rejects(refused.prepare(), /trait destination refused/);
    assert.equal(f.checks.length, before);
    assert.equal(f.handles.size, 0);
  } finally { await refused.cleanup(); }
  assert.deepEqual(new Set(f.environments.keys()), new Set([f.primary.name, f.extra.name]));
  assert.deepEqual(new Set(f.removed), new Set(f.imports.map((value) => value.name)));
});

async function checkpointLogFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "kova-checkpoint-logs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stdout = join(directory, "stdout.log"), product = join(directory, "product.log");
  await writeFile(stdout, "console error\n");
  await writeFile(product, "product error\n");
  const collect = combineLogCollectors([createLogCollector([stdout]), combineLogCollectors([createLogCollector([product])])]);
  const phase = { id: "intent/log-capture", checkpoint: ["logs"] };
  return { directory, stdout, product, collect, options: { phase, directory, results: [], collectLogs: collect } };
}

test("screenshot and publication failures retain all log bytes for a later checkpoint", async (t) => {
  const f = await checkpointLogFixture(t);
  const screenPath = join(f.directory, "screen.png");
  await writeFile(screenPath, "invalid screenshot");
  const options = { ...f.options, screenPath, phase: { ...f.options.phase, browser: true, checkpoint: ["logs", "screen"] } };
  await assert.rejects(writeCheckpoint(options), /not a PNG/);
  assert.deepEqual(await readdir(join(f.directory, "checkpoints/intent")), []);
  await appendFile(f.stdout, "after screenshot failure\n");
  await writeFile(screenPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xQAAAAASUVORK5CYII=", "base64"));
  const destination = join(f.directory, "checkpoints/intent/log-capture");
  await mkdir(destination);
  await writeFile(join(destination, "retained.json"), "existing checkpoint");
  await assert.rejects(writeCheckpoint(options), (error) => ["ENOTEMPTY", "EEXIST"].includes(error.code));
  assert.equal(await readFile(join(destination, "retained.json"), "utf8"), "existing checkpoint");
  assert.deepEqual(await readdir(join(f.directory, "checkpoints/intent")), ["log-capture"]);
  await rm(destination, { recursive: true });
  const published = await writeCheckpoint(options);
  assert.equal(await readFile(join(published.path, "logs.txt"), "utf8"), "console error\nafter screenshot failure\n\nproduct error\n");
  assert.equal(await f.collect(), "");
  await appendFile(f.product, "after publication\n");
  const next = await writeCheckpoint({ ...f.options, phase: { id: "intent/next", checkpoint: ["logs"] } });
  assert.equal(await readFile(join(next.path, "logs.txt"), "utf8"), "after publication\n");
});

test("a later nested reader failure cannot consume earlier console or product logs", async (t) => {
  const f = await checkpointLogFixture(t);
  const later = join(f.directory, "later.log");
  await mkdir(later);
  const collect = combineLogCollectors([
    createLogCollector([f.stdout]),
    combineLogCollectors([createLogCollector([f.product]), createLogCollector([later])])
  ]);
  const options = { ...f.options, collectLogs: collect };
  await assert.rejects(writeCheckpoint(options), /not a regular file/);
  await rm(later, { recursive: true });
  await writeFile(later, "later product error\n");
  const published = await writeCheckpoint(options);
  assert.equal(await readFile(join(published.path, "logs.txt"), "utf8"), "console error\n\nproduct error\n\nlater product error\n");
  assert.equal(await collect(), "");
});

test("the combined budget rejects oversized capture without consuming any reader", async (t) => {
  const f = await checkpointLogFixture(t);
  await truncate(f.product, 16 * 1024 * 1024);
  await assert.rejects(writeCheckpoint(f.options), /16 MiB output budget/);
  await writeFile(f.product, "bounded product error\n");
  const published = await writeCheckpoint(f.options);
  assert.equal(await readFile(join(published.path, "logs.txt"), "utf8"), "console error\n\nbounded product error\n");
  assert.equal(await f.collect(), "");
});
