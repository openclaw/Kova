import { createReadStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile, readdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCommand, quoteShell } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import { captureTargetIdentity } from "../target-identity.mjs";
import { buildAuthPreparePhase, buildAuthSetupPhase, mockProviderCleanupCommand, mockAiProviderServeCommand, mockProviderPortCommand } from "../auth.mjs";
import { createForegroundGateway } from "./gateway.mjs";
import { keyValue, loadDefinition, readKeys, resolveCommand } from "./definition.mjs";

const q = quoteShell;
const auth = { mode: "mock", setup: true, mockProvider: {} };
const suffix = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function executor(execute = runCommand) {
  return async (command, label = "persona command") => {
    const result = await execute(command, { timeoutMs: 300000, maxOutputChars: 1000000, env: { KOVA_OPENCLAW_CONFIG_CONTRACT: "canonical" } });
    if (result.status !== 0 || result.signal || result.timedOut || result.outputBudget?.truncated) throw new Error(`${label} failed (exit ${result.status}): ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`);
    return result;
  };
}

async function mockSetup(run, env, call, configure = true) {
  const metadata = JSON.parse((await call(`ocm env show ${q(env)} --json`)).stdout);
  const workspace = metadata.workspaceDir ?? join(metadata.stateDir ?? join(metadata.root, ".openclaw"), "workspace");
  const saved = join(workspace, "kova-persona", "mock-script.json");
  let script;
  try { script = await readFile(saved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (script) {
    const dir = join(run, "mock-openai");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const paths = { scriptPath: join(dir, "script.json"), requestLog: join(dir, "requests.jsonl"), serverLog: join(dir, "server.log"), pidFile: join(dir, "pid"), portFile: join(dir, "port") };
    await writeFile(paths.scriptPath, script, { mode: 0o600 });
    await call(mockAiProviderServeCommand(paths), "start saved mock provider");
    await call(mockProviderPortCommand(paths), "read mock provider port");
  } else {
    for (const command of buildAuthPreparePhase(auth, run).commands) await call(command, "start mock provider");
  }
  if (configure) {
    for (const command of buildAuthSetupPhase(auth, env, run).commands) await call(command, "configure mock provider");
  } else {
    const port = (await call(`cat ${q(join(run, "mock-openai", "port"))}`)).stdout.trim();
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("invalid mock provider port");
    await call(`ocm @${q(env)} -- config set models.providers.openai.baseUrl ${q(`http://127.0.0.1:${port}/v1`)}`, "rebind mock provider");
  }
}

async function bindRuntime(env, selector, call, execute) {
  const version = selector.slice(4);
  const command = `ocm start ${q(env)} --version ${q(version)} --no-service --json`;
  const result = await call(command, "bind persona runtime");
  const receipt = { ...result, command };
  await captureTargetIdentity(receipt, { kind: "npm", value: version, selector }, env, { execute: execute ?? runCommand });
  if (!receipt.targetIdentity) throw new Error("persona runtime has no exact version and npm integrity receipt");
  return `${receipt.targetIdentity.resolvedVersion}@${receipt.targetIdentity.npmIntegrity}`;
}

async function checks(loaded, context, call, build, gateway) {
  for (const trait of loaded.traits) {
    if (build) {
      for (const command of trait.builder) await call(resolveCommand(command, context), `trait ${trait.id} builder`);
      await gateway.start();
    }
    const result = await call(resolveCommand(trait.check, context), `trait ${trait.id} check`);
    context.traits[trait.id] = { keys: readKeys(trait, result.stdout), checkedAt: new Date().toISOString() };
  }
  return context.traits;
}

export async function readManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && value.length > 0;
  if (manifest?.schema !== "kova.verify.persona-manifest.v1" || !text(manifest.persona) || !/^\d{8}T\d{6}Z$/.test(manifest.version ?? "") || !text(manifest.runtime?.selector) || !text(manifest.runtime?.resolved) || !text(manifest.definition?.path) || !text(manifest.env?.name) || !text(manifest.env?.export) || typeof manifest.doctor !== "string" || !/^[a-f0-9]{64}$/.test(manifest.env?.sha256 ?? "") || !/^[a-f0-9]{64}$/.test(manifest.definition?.sha256 ?? "") || !object(manifest.traits)) throw new Error("invalid persona manifest");
  if (manifest.env.includeState !== true) throw new Error("persona manifest requires a state-preserving export");
  for (const [id, trait] of Object.entries(manifest.traits)) {
    if (!object(trait) || !object(trait.keys) || !text(trait.checkedAt) || !Number.isFinite(Date.parse(trait.checkedAt)) || Object.values(trait.keys).some((value) => typeof value !== "string" || !keyValue.test(value))) throw new Error(`invalid persona manifest trait ${id}`);
  }
  return manifest;
}

export async function verifyPersona(path, options = {}) {
  const manifest = await readManifest(path);
  const base = dirname(resolve(path));
  const loaded = await loadDefinition(resolve(base, manifest.definition.path), options);
  if (loaded.sha256 !== manifest.definition.sha256) throw new Error("persona definition hash differs from manifest");
  if (loaded.definition.id !== manifest.persona || loaded.definition.runtime.selector !== manifest.runtime.selector) throw new Error("persona definition identity differs from manifest");
  if (Object.keys(manifest.traits).length !== loaded.traits.length) throw new Error("persona manifest traits differ from definition");
  for (const trait of loaded.traits) readKeys(trait, JSON.stringify(manifest.traits[trait.id]?.keys));
  const run = await mkdtemp(join(tmpdir(), "kova-persona-verify-"));
  const env = `kova-persona-verify-${suffix()}`;
  const call = executor(options.execute);
  const gateway = (options.gatewayFactory ?? createForegroundGateway)(env, call);
  let imported = false;
  let failure;
  let result;
  try {
    // Import exactly the bytes checked, even if the source export is replaced.
    const archive = join(run, "persona.ocm-env.tar");
    await copyFile(resolve(base, manifest.env.export), archive);
    if (await hashFile(archive) !== manifest.env.sha256) throw new Error("persona export hash differs from manifest");
    await call(`ocm env import ${q(archive)} --name ${q(env)} --json`, "import persona clone");
    imported = true;
    await call(`ocm env protect ${q(env)} off --json`);
    const resolved = await bindRuntime(env, manifest.runtime.selector, call, options.execute);
    if (resolved !== manifest.runtime.resolved) throw new Error("persona runtime integrity differs from manifest");
    await mockSetup(run, env, call, false);
    await gateway.start();
    const traits = await checks(loaded, { env, run, kovaRoot: repoRoot, traits: {} }, call, false);
    for (const trait of loaded.traits) {
      for (const key of Object.keys(trait.keys)) {
        // OCM remaps paths below the environment root when importing.
        const expected = manifest.traits[trait.id].keys[key];
        if (!expected.startsWith("/") && traits[trait.id].keys[key] !== expected) throw new Error(`trait ${trait.id}: key ${key} differs from manifest`);
      }
    }
    result = { ok: true, persona: manifest.persona, version: manifest.version, traits };
  } catch (error) { failure = error; }
  const cleanup = [];
  try { await gateway.stop(); } catch (error) { cleanup.push(error.message); }
  if (imported && !cleanup.length) {
    try { await call(`ocm env destroy ${q(env)} --yes --json`, "destroy persona clone"); } catch (error) { cleanup.push(error.message); }
  }
  try { await call(mockProviderCleanupCommand(join(run, "mock-openai")), "stop mock provider"); } catch (error) { cleanup.push(error.message); }
  if (!cleanup.length) await rm(run, { recursive: true, force: true });
  if (cleanup.length) throw new Error(`${failure ? `${failure.message}; ` : ""}cleanup failed for ${env}: ${cleanup.join("; ")}; files: ${run}`);
  if (failure) throw failure;
  return result;
}

export async function buildPersona(definitionPath, outputPath, options = {}) {
  const loaded = await loadDefinition(definitionPath, options);
  const out = resolve(outputPath);
  const plan = { execute: options.executeBuild === true, persona: loaded.definition.id, runtime: loaded.definition.runtime.selector, out, traits: loaded.traits.map(({ id, needs, builder, check }) => ({ id, needs, builder, check })) };
  if (!options.executeBuild) return plan;
  await mkdir(out, { recursive: true, mode: 0o700 });
  if ((await readdir(out)).length) throw new Error("persona output directory must be empty");
  const env = `kova-persona-${suffix()}`;
  const lock = join(out, ".building");
  await writeFile(lock, `${JSON.stringify({ env, startedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
  const run = join(out, "build");
  const call = executor(options.execute);
  const gateway = (options.gatewayFactory ?? createForegroundGateway)(env, call);
  let created = false, completed = false, failure, result;
  try {
    await mkdir(run, { mode: 0o700 });
    await call(`ocm env create ${q(env)} --json`, "create persona environment");
    created = true;
    const resolved = await bindRuntime(env, loaded.definition.runtime.selector, call, options.execute);
    await mockSetup(run, env, call);
    await gateway.start();
    const traits = await checks(loaded, { env, run, kovaRoot: repoRoot, traits: {} }, call, true, gateway);
    await gateway.stop();
    const doctor = await call(`ocm @${q(env)} -- doctor --non-interactive`, "Doctor");
    await call(`ocm env protect ${q(env)} on --json`);
    const versionId = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    await call(`ocm env snapshot create ${q(env)} --label ${q(`persona-${versionId}`)} --json`);
    const archive = join(out, "persona.ocm-env.tar");
    await call(`ocm env export ${q(env)} --include-state --output ${q(archive)} --json`, "export persona");
    const manifest = {
      schema: "kova.verify.persona-manifest.v1", persona: loaded.definition.id, version: versionId,
      runtime: { selector: loaded.definition.runtime.selector, resolved },
      definition: { path: loaded.path, sha256: loaded.sha256 },
      env: { name: env, export: archive, includeState: true, sha256: await hashFile(archive) },
      doctor: doctor.stdout, traits,
    };
    const candidate = join(out, ".persona-candidate.json");
    await writeFile(candidate, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await verifyPersona(candidate, options);
    await link(candidate, join(out, "persona.json"));
    completed = true;
    result = manifest;
  } catch (error) { failure = error; }
  const cleanup = [];
  try { await gateway.stop(); } catch (error) { cleanup.push(error.message); }
  if (created && !completed && !cleanup.length) {
    try {
      await call(`ocm env protect ${q(env)} off --json`);
      await call(`ocm env destroy ${q(env)} --yes --json`, "destroy failed persona");
    } catch (error) { cleanup.push(error.message); }
  }
  try { await call(mockProviderCleanupCommand(join(run, "mock-openai")), "stop mock provider"); } catch (error) { cleanup.push(error.message); }
  await rm(lock, { force: true });
  await rm(join(out, ".persona-candidate.json"), { force: true });
  if (!completed) await rm(join(out, "persona.ocm-env.tar"), { force: true });
  if (cleanup.length) throw new Error(`${failure ? `${failure.message}; ` : ""}cleanup failed for ${env}: ${cleanup.join("; ")}`);
  if (failure) throw failure;
  return result;
}
