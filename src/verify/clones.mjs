import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { pipeline } from "node:stream/promises";
import { extract as extractTar } from "tar-stream";
import JSON5 from "json5";
import { quoteShell as q } from "../commands.mjs";
import { isMissingOcmResource } from "../ocm/missing-resource.mjs";
import { captureTargetIdentity } from "../target-identity.mjs";
import { mockAiProviderServeCommand, mockProviderPortCommand, mockProviderCleanupCommand } from "../auth.mjs";
import { checkCatalogueCommands, parseCatalogueCommand, createCatalogueResolver } from "../catalogue.mjs";
import { canonicalJSON, sha256 } from "./plan.mjs";
import { createLogCollector } from "./checkpoint.mjs";

function within(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

async function ownedCloneFile(metadata, path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.includes("${")) throw new Error("product log capture requires a direct absolute clone-owned file path");
  const rootStat = await lstat(metadata.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("product log capture requires an unaliased clone root");
  const root = await realpath(metadata.root);
  const requested = resolve(path);
  const relativePath = within(resolve(metadata.root), requested) ? relative(resolve(metadata.root), requested) : within(root, requested) ? relative(root, requested) : null;
  if (!relativePath) throw new Error("product log path must stay inside its clone root");
  let current = root;
  const parts = relativePath.split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error("product log capture refuses aliased paths");
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error("product log capture requires regular files and directories");
  }
  return current;
}

async function readCloneLogging(metadata, { allowDefault = false } = {}) {
  const configPath = await ownedCloneFile(metadata, metadata.configPath ?? join(metadata.stateDir, "openclaw.json"));
  const config = JSON5.parse(await readFile(configPath, "utf8"));
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(config) || Object.hasOwn(config, "$include") || (config.logging !== undefined && !isObject(config.logging))) throw new Error("product log capture requires a directly authored logging configuration");
  const logging = config.logging ?? {};
  const hasInclude = (value) => value !== null && typeof value === "object" && (Object.hasOwn(value, "$include") || Object.values(value).some(hasInclude));
  if (hasInclude(logging)) throw new Error("product log capture does not resolve logging includes");
  if (logging.file === undefined && !allowDefault) throw new Error("product logging.file is missing; shared default logs cannot be captured");
  const file = await ownedCloneFile(metadata, logging.file === undefined ? join(metadata.stateDir, "logs/kova-product.log") : logging.file);
  return { config, configPath, file, defaulted: logging.file === undefined };
}

function activeLogFile(file) {
  if (!/^openclaw-(?:YYYY-MM-DD|\d{4}-\d{2}-\d{2})\.log$/.test(basename(file))) return file;
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return join(dirname(file), `openclaw-${today}.log`);
}

async function prepareProductLogs(metadata) {
  const settings = await readCloneLogging(metadata, { allowDefault: true });
  if (settings.defaulted) {
    settings.config.logging = { ...settings.config.logging, file: settings.file };
    const temporary = join(dirname(settings.configPath), `.kova-log-config-${randomUUID()}.json`);
    try {
      const serialized = JSON.stringify(settings.config, null, 2);
      if (!isDeepStrictEqual(JSON.parse(serialized), settings.config)) throw new Error("clone logging configuration cannot be represented without changing values");
      await writeFile(temporary, `${serialized}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, settings.configPath);
    } finally { await rm(temporary, { force: true }); }
  }
  const files = new Set();
  const collect = createLogCollector(async () => {
    files.add(activeLogFile((await readCloneLogging(metadata)).file));
    return [...files].flatMap((file) => {
      const extension = extname(file), base = file.slice(0, file.length - extension.length);
      return [...[5, 4, 3, 2, 1].map((index) => `${base}.${index}${extension}`), file];
    });
  }, { validatePath: (path) => ownedCloneFile(metadata, path), trackIdentity: true });
  // Imported history predates this copy's product commands.
  (await collect.prepare({ skipExisting: true })).commit();
  return collect;
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function hashEnvironmentExport(path) {
  const raw = createHash("sha256");
  const entries = new Map();
  const extractor = extractTar();
  let metadataSeen = false;
  extractor.on("entry", (header, stream, next) => {
    stream.on("error", () => {});
    void (async () => {
      const name = header.name.replace(/\/$/, "");
      if (entries.has(name) || (name !== "meta/env.json" && name !== "root" && !name.startsWith("root/"))) throw new Error("invalid environment export entry");
      const fields = JSON.parse(JSON.stringify(header));
      fields.name = name;
      const content = createHash("sha256");
      if (name === "meta/env.json") {
        if (metadataSeen || header.type !== "file" || header.size > 1024 * 1024) throw new Error("invalid environment export metadata");
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (metadata?.kind !== "ocm-env-archive" || metadata.formatVersion !== 1 || metadata.includeState !== true || typeof metadata.exportedAt !== "string" || !metadata.env) throw new Error("invalid state-inclusive environment export metadata");
        // OCM records capture time here; all source metadata remains significant.
        delete metadata.exportedAt;
        const normalized = canonicalJSON(metadata);
        fields.size = Buffer.byteLength(normalized);
        content.update(normalized);
        metadataSeen = true;
      } else {
        for await (const chunk of stream) content.update(chunk);
      }
      entries.set(name, { header: fields, sha256: content.digest("hex") });
    })().then(() => next(), (error) => next(error));
  });
  await pipeline(createReadStream(path), new Transform({
    transform(chunk, encoding, callback) { raw.update(chunk); callback(null, chunk); }
  }), extractor);
  if (!metadataSeen || entries.get("root")?.header.type !== "directory") throw new Error("environment export is missing metadata or root directory");
  return {
    sha256: raw.digest("hex"),
    contentSha256: sha256(canonicalJSON([...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)))
  };
}

export async function readPersona(path, expectedHash, catalogue) {
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedHash) throw new Error("persona manifest hash differs from plan");
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== "kova.verify.persona-manifest.v1" || manifest.env?.includeState !== true || !/^npm:\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.runtime?.selector ?? "")) throw new Error("persona requires an exact runtime and a state-inclusive export");
  if (manifest.env.root !== undefined && (typeof manifest.env.root !== "string" || !isAbsolute(manifest.env.root))) throw new Error("persona source root must be absolute");
  for (const trait of Object.values(manifest.traits ?? {})) for (const value of Object.values(trait.keys ?? {})) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9._:/@-]+$/.test(value)) throw new Error("invalid persona key value");
    if (isAbsolute(value) && !manifest.env.root) throw new Error("absolute persona keys require the source root");
  }
  const definitionBytes = await readFile(resolve(dirname(path), manifest.definition.path));
  if (sha256(definitionBytes) !== manifest.definition.sha256) throw new Error("persona definition hash differs from manifest");
  const definition = JSON.parse(definitionBytes);
  if (definition.schema !== "kova.verify.persona.v1" || definition.id !== manifest.persona || definition.runtime?.selector !== manifest.runtime.selector || !Array.isArray(definition.credentials) || definition.credentials.length || !Array.isArray(definition.traits) || !definition.traits.length) throw new Error("persona definition identity differs from manifest");
  if (new Set(definition.traits.map((trait) => trait.id)).size !== definition.traits.length || Object.keys(manifest.traits ?? {}).length !== definition.traits.length) throw new Error("persona traits differ from definition");
  const resolveEntry = createCatalogueResolver(catalogue);
  for (const trait of definition.traits) {
    if (!manifest.traits?.[trait.id]?.keys || JSON.stringify(Object.keys(trait.keys).sort()) !== JSON.stringify(Object.keys(manifest.traits[trait.id].keys).sort()) || Object.keys(trait.keys).some((key) => typeof manifest.traits[trait.id].keys[key] !== "string")) throw new Error(`persona trait ${trait.id} keys differ from definition`);
    const findings = checkCatalogueCommands(catalogue, [{ command: trait.check, source: trait.id }]);
    if (findings.length || resolveEntry(trait.check)?.side !== "read") throw new Error(`persona trait ${trait.id} requires an available read-only check: ${findings.map((item) => item.message).join("; ")}`);
  }
  const archive = resolve(dirname(path), manifest.env.export);
  if (await hashFile(archive) !== manifest.env.sha256) throw new Error("persona export hash differs from manifest");
  return { manifest, definition, archive };
}

export function resolveRunCommand(command, context) {
  const { tokens, findings } = parseCatalogueCommand(command, { standard: context.standard });
  if (findings.length) throw new Error(`invalid phase command: ${findings.map((item) => item.message).join("; ")}`);
  // Resolve tokens before quoting once, so quotes and path suffixes cannot turn data into shell syntax.
  return tokens.map((token) => {
    let value = token.replace(/\{(env|kovaRoot|run|target|persona:([^:}]+):([^}]+))\}/g, (_, name, trait, key) => {
      const replacement = trait ? context.traits?.[trait]?.keys?.[key] : context[name];
      if (typeof replacement !== "string") throw new Error(`unresolved placeholder ${name}`);
      return replacement;
    });
    for (const [source, destination] of context.roots ?? []) {
      // Rooted persona keys may already have been resolved by plan.
      value = value.replaceAll(source, (match, offset, text) => {
        const after = text[offset + match.length];
        return after === undefined || /[\/\\"'\s,}\]]/.test(after) ? destination : match;
      });
    }
    return q(value);
  }).join(" ");
}

export async function stagePersona(persona, directory, call) {
  const archive = join(directory, "persona.ocm-env.tar");
  await copyFile(persona.archive, archive);
  if (await hashFile(archive) !== persona.manifest.env.sha256) throw new Error("persona export changed while copying");
  const extra = new Map();
  for (const trait of Object.values(persona.manifest.traits)) {
    const name = trait.keys?.env;
    if (!name || name === persona.manifest.env.name || extra.has(name)) continue;
    const metadata = JSON.parse((await call(`ocm env show ${q(name)} --json`)).stdout);
    if (metadata.name !== name || !metadata.defaultRuntime || metadata.defaultLauncher || !isAbsolute(metadata.root ?? "")) throw new Error(`persona environment ${name} needs a runtime binding and absolute root`);
    const runtime = JSON.parse((await call(`ocm runtime show ${q(metadata.defaultRuntime)} --json`)).stdout);
    if (runtime.name !== metadata.defaultRuntime || typeof runtime.releaseVersion !== "string") throw new Error(`persona environment ${name} has no runtime version`);
    const path = join(directory, `persona-${extra.size}.ocm-env.tar`);
    await call(`ocm env export ${q(name)} --output ${q(path)} --include-state --json`);
    extra.set(name, { archive: path, ...await hashEnvironmentExport(path), metadata, version: runtime.releaseVersion });
  }
  return { ...persona, archive, extra };
}

export function createClone({ name, directory, persona, root, call, cleanupCall, cleanupHandle, signal }) {
  const environments = [];
  const handles = new Set();
  const mocks = [];
  const traits = structuredClone(persona.manifest.traits);
  const roots = [];
  const copies = [];
  const productLogs = new Map();
  let metadata;
  const inspect = async (env, invoke) => {
    const result = await invoke(`ocm env show ${q(env)} --json`, { allowFailure: true });
    if (result.status !== 0) {
      if (!result.timedOut && isMissingOcmResource(result, "environment", env)) return null;
      throw new Error(`cannot establish environment state: ${env}`);
    }
    const value = JSON.parse(result.stdout);
    if (value.name !== env) throw new Error("OCM returned a different environment");
    return value;
  };
  async function importCopy(archive, runtime, sourceRoot, suffix) {
    const env = `kova-run-${randomUUID()}-${suffix}`;
    if (await inspect(env, call)) throw new Error(`clone already exists: ${env}`);
    environments.push(env); // Retain ownership if import succeeds but its response is interrupted.
    await call(`ocm env import ${q(archive)} --name ${q(env)} --json`);
    await call(`ocm env protect ${q(env)} off --json`);
    const imported = await inspect(env, call);
    if (!imported) throw new Error("imported clone is missing");
    const importedRoot = await realpath(imported.root);
    for (const source of [persona.manifest.env.root, ...[...persona.extra.values()].map((value) => value.metadata.root)].filter(Boolean)) {
      let sourcePath;
      try { sourcePath = await realpath(source); } catch (error) { if (error.code !== "ENOENT") throw error; sourcePath = resolve(source); }
      if (within(sourcePath, importedRoot) || within(importedRoot, sourcePath)) throw new Error("imported clone root overlaps a persona source");
    }
    productLogs.set(env, await prepareProductLogs(imported));
    const command = `ocm start ${q(env)} ${runtime} --no-service --json`;
    const binding = await call(command);
    const value = await inspect(env, call);
    if (!value || value.serviceEnabled || value.serviceRunning) throw new Error("imported clone must have no managed service");
    if (sourceRoot) roots.push([sourceRoot, value.root]);
    return { metadata: value, binding: { ...binding, command } };
  }
  const context = () => ({ env: metadata.name, run: directory, kovaRoot: root, traits, roots, cwd: metadata.workspaceDir ?? metadata.root, ownedRoots: copies.map((copy) => copy.root) });
  async function mockProvider(value) {
    const saved = join(value.workspaceDir ?? join(value.stateDir, "workspace"), "kova-persona/mock-script.json");
    let script;
    try { script = await readFile(saved); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const dir = join(directory, `mock-${mocks.length}`);
    await mkdir(dir, { mode: 0o700 });
    mocks.push(dir);
    const paths = { scriptPath: join(dir, "script.json"), requestLog: join(dir, "requests.jsonl"), serverLog: join(dir, "server.log"), pidFile: join(dir, "pid"), portFile: join(dir, "port") };
    await writeFile(paths.scriptPath, script, { mode: 0o600 });
    await call(mockAiProviderServeCommand(paths));
    await call(mockProviderPortCommand(paths));
    const port = (await readFile(paths.portFile, "utf8")).trim();
    if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error("invalid mock provider port");
    await call(`ocm @${q(value.name)} -- config set models.providers.openai.baseUrl ${q(`http://127.0.0.1:${port}/v1`)}`);
  }
  return {
    name, directory, handles, context,
    contexts() { return copies.map((copy, index) => ({ ...context(), env: copy.name, cwd: copy.workspaceDir ?? copy.root, run: index ? join(directory, `extra-${index}`) : directory })); },
    async collectProductLogs() {
      const captures = [];
      let remaining = 16 * 1024 * 1024;
      for (const collect of productLogs.values()) {
        const capture = await collect.prepare({ maxBytes: remaining });
        if (capture.bytes > 0) {
          remaining -= capture.bytes + (captures.some((value) => value.bytes > 0) ? 1 : 0);
          if (remaining < 0) throw new Error("log capture exceeds the 16 MiB output budget");
        }
        captures.push(capture);
      }
      for (const capture of captures) capture.commit();
      return captures.map((capture) => capture.text).filter(Boolean).join("\n");
    },
    get metadata() { return metadata; },
    async prepare() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const imported = await importCopy(persona.archive, `--version ${q(persona.manifest.runtime.selector.slice(4))}`, persona.manifest.env.root, name);
      metadata = imported.metadata;
      copies.push(metadata);
      await captureTargetIdentity(imported.binding, { kind: "npm", value: persona.manifest.runtime.selector.slice(4), selector: persona.manifest.runtime.selector }, metadata.name, { execute: (command) => call(command) });
      const identity = imported.binding.targetIdentity;
      if (!identity || `${identity.resolvedVersion}@${identity.npmIntegrity}` !== persona.manifest.runtime.resolved) throw new Error("clone runtime integrity differs from persona");
      for (const [source, data] of persona.extra) {
        const copy = await importCopy(data.archive, `--runtime ${q(data.metadata.defaultRuntime)}`, data.metadata.root, `extra-${environments.length}`);
        copies.push(copy.metadata);
        for (const trait of Object.values(traits)) if (trait.keys.env === source) trait.keys.env = copy.metadata.name;
        await mockProvider(copy.metadata);
      }
      for (const trait of Object.values(traits)) {
        if (trait.keys.env === persona.manifest.env.name) trait.keys.env = metadata.name;
        for (const [key, value] of Object.entries(trait.keys)) {
          if (!isAbsolute(value)) continue;
          for (const [source, destination] of roots) {
            const suffix = relative(source, value);
            if (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)) trait.keys[key] = resolve(destination, suffix);
          }
        }
      }
      await mockProvider(metadata);
      const checkHandles = [];
      try {
        for (const [index, copy] of copies.entries()) {
          const handle = join(directory, `persona-gateway-${index}.json`);
          handles.add(handle); checkHandles.push(handle);
          await call(`node ${q(join(root, "support/verify/gateway-lifecycle.mjs"))} start --env ${q(copy.name)} --handle ${q(handle)} --timeout 120000`);
        }
        for (const trait of persona.definition.traits) {
          signal?.throwIfAborted();
          const result = await call(resolveRunCommand(trait.check, context()));
          const keys = JSON.parse(result.stdout);
          if (JSON.stringify(Object.keys(keys).sort()) !== JSON.stringify(Object.keys(trait.keys).sort())) throw new Error(`trait ${trait.id}: check keys differ from definition`);
          for (const key of Object.keys(keys)) if (keys[key] !== traits[trait.id].keys[key]) throw new Error(`trait ${trait.id}: key ${key} differs from persona`);
        }
      } finally { for (const handle of checkHandles) await cleanupHandle(handle); }
      return metadata;
    },
    async cleanup() {
      const errors = [];
      for (const handle of handles) try { await cleanupHandle(handle); } catch (error) { errors.push(error.message); }
      for (const dir of mocks) try { await cleanupCall(mockProviderCleanupCommand(dir)); } catch (error) { errors.push(error.message); }
      if (!errors.length) for (const env of [...environments].reverse()) {
        try {
          if (await inspect(env, cleanupCall)) {
            await cleanupCall(`ocm env protect ${q(env)} off --json`);
            await cleanupCall(`ocm env destroy ${q(env)} --yes --json`);
            if (await inspect(env, cleanupCall)) throw new Error(`clone was not removed: ${env}`);
          }
        } catch (error) { errors.push(error.message); }
      }
      if (errors.length) throw new Error(`cleanup failed for ${name}: ${errors.join("; ")}`);
    }
  };
}
