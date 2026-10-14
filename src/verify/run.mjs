import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactsDir, repoRoot } from "../paths.mjs";
import { quoteShell as q, runCommand, runWithShutdownScope } from "../commands.mjs";
import { checkCatalogueCommands, createCatalogueResolver, loadCatalogue, parseCatalogueCommand } from "../catalogue.mjs";
import { canonicalJSON, sha256 } from "./plan.mjs";
import { createClone, hashFile, readPersona, resolveRunCommand, stagePersona } from "./clones.mjs";
import { createLogCollector, snapshotState, writeCheckpoint } from "./checkpoint.mjs";
import { cleanupGatewayHandle } from "../../support/verify/gateway-lifecycle.mjs";

const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
const baselineNames = ["baseline", "noise-1", "noise-2"];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };
const git = (path, args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).trim();

export function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error(`invalid OpenClaw version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] < right.numbers[i] ? -1 : 1;
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx !== ny) return nx ? -1 : 1;
    return (nx ? BigInt(x) < BigInt(y) : x < y) ? -1 : 1;
  }
  return 0;
}

export async function validateTarget(selector, expectedCommit, personaVersion) {
  if (typeof selector !== "string" || !selector.startsWith("local-build:") || !selector.slice(12)) throw new Error("verify run targets must use local-build:<path>");
  const path = resolve(selector.slice(12));
  const commit = git(path, ["rev-parse", "HEAD"]);
  if (commit !== expectedCommit) throw new Error(`target commit differs from plan: ${path}`);
  if (git(path, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error(`target has uncommitted changes: ${path}`);
  const pkg = await readJSON(join(path, "package.json"));
  if (pkg.name !== "openclaw" || compareVersions(pkg.version, personaVersion) < 0) throw new Error(`target must be OpenClaw no older than persona ${personaVersion}: ${path}`);
  return { selector: `local-build:${path}`, commit, version: pkg.version };
}

function option(tokens, name) {
  const index = tokens.findIndex((token) => token === name || token.startsWith(`${name}=`));
  return index < 0 ? undefined : tokens[index].includes("=") ? tokens[index].slice(name.length + 1) : tokens[index + 1];
}

export function validateRunPlan(plan, catalogue) {
  if (plan?.schema !== "kova.verify.plan.v1" || !/^[0-9a-f]{40}$/.test(plan.change?.baseline ?? "") || !/^[0-9a-f]{40}$/.test(plan.change?.change ?? "")) throw new Error("invalid verification plan identity");
  if (!Array.isArray(plan.phases) || !plan.phases.length) throw new Error("cannot run an empty verification plan");
  if (sha256(canonicalJSON(plan.phases)) !== plan.phasesSha256) throw new Error("plan phase hash differs");
  const binding = plan.phases[0];
  if (binding.id !== "standard/use-target" || binding.from !== "standard" || canonicalJSON(binding.commands) !== canonicalJSON(["ocm start {env} --runtime {target} --no-service --json"])) throw new Error("plan must begin with the standard target binding");
  const isClone = (value) => value === "{env}" || /^\{persona:[^:]+:env\}$/.test(value ?? "");
  const handles = new Set(plan.phases.flatMap((phase) => phase.commands.map((command) => option(parseCatalogueCommand(command, { standard: phase.from === "standard" }).tokens, "--handle"))).filter(Boolean));
  const ids = new Set();
  const resolver = createCatalogueResolver(catalogue);
  for (const phase of plan.phases) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase.id) || ids.has(phase.id) || !Number.isSafeInteger(phase.timeoutMs) || phase.timeoutMs < 1 || !Array.isArray(phase.commands) || !phase.commands.length || !Array.isArray(phase.checkpoint)) throw new Error("invalid verification phase");
    if (phase.timeoutMs > 2147483647 || phase.checkpoint.some((value) => typeof value !== "string" || !/^(responses|logs|timing|doctor|screen)$/.test(value) && (!value.startsWith("state:") || isAbsolute(value.slice(6)) || value.slice(6).split(/[\\/]/).some((part) => !part || part === "." || part === "..")))) throw new Error("invalid checkpoint or phase timeout");
    ids.add(phase.id);
    const standard = phase.from === "standard";
    const findings = checkCatalogueCommands(catalogue, phase.commands.map((command) => ({ command, standard })));
    if (findings.length) throw new Error(`catalogue refused ${phase.id}: ${findings.map((item) => item.message).join("; ")}`);
    for (const command of phase.commands) {
      const tokens = parseCatalogueCommand(command, { standard }).tokens;
      const entry = resolver(command, { standard });
      const environment = option(tokens, "--env");
      if (environment !== undefined && environment !== "{env}" && !/^\{persona:[^:]+:env\}$/.test(environment)) throw new Error(`${phase.id}: --env must name a clone placeholder`);
      const timeout = Number(option(tokens, "--timeout") ?? phase.timeoutMs), delay = Number(option(tokens, "--after-ms") ?? 0);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(delay) || delay < 0 || timeout + delay + 1000 > 2147483647) throw new Error(`${phase.id}: invalid command timeout or delay`);
      if (tokens[0] === "ocm" && tokens[1] === "service") throw new Error(`${phase.id}: managed service commands cannot run in verification clones`);
      if (tokens[0] === "ocm") {
        if (tokens[1]?.startsWith("@")) {
          if (!isClone(tokens[1].slice(1))) throw new Error(`${phase.id}: OpenClaw command must target a clone`);
        } else {
          const operands = { "ocm-env-show": 3, "ocm-env-exec": 3, "ocm-env-snapshot-create": 4, "ocm-start": 2, "ocm-logs": 2, "ocm-upgrade": 2 };
          if (!Object.hasOwn(operands, entry.id) || !isClone(tokens[operands[entry.id]])) throw new Error(`${phase.id}: OCM operation must target an owned clone and cannot create environments`);
          if (["ocm-start", "ocm-upgrade"].includes(entry.id) && option(tokens, "--runtime") !== "{target}") throw new Error(`${phase.id}: runtime binding must use the planned target`);
        }
      }
      for (const flag of ["--out", "--handle", "--wait", "--from", "--session-from", "--merge-from"]) {
        const value = option(tokens, flag);
        if (value !== undefined && (!value.startsWith("{run}/") || value.slice(6).split(/[\\/]/).some((part) => !part || part === "." || part === ".."))) throw new Error(`${phase.id}: ${flag} must stay under {run}`);
      }
      for (const flag of ["--out", "--handle"]) {
        const value = option(tokens, flag);
        if (value === undefined) continue;
        const parts = value.slice(6).split("/");
        if (/^(checkpoints|initial-state|\.persona|extra-\d+|mock-\d+)$/.test(parts[0]) || parts.some((part) => part.endsWith(".d") || /^persona-gateway-\d+\.json$/.test(part)) || flag === "--out" && handles.has(value)) throw new Error(`${phase.id}: output overlaps protected evidence or a background operation`);
      }
      if (entry.kind === "ocm" && tokens[1] === "start" && !tokens.includes("--no-service")) throw new Error(`${phase.id}: OCM start requires --no-service`);
    }
  }
}

export function cacheKey({ baseline, manifest, phases, kova, ocm }) {
  return sha256([baseline, manifest, phases, kova, ocm].join("\n"));
}

async function fingerprintDirectory(directory, prefix = "") {
  const files = {};
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === "cache.json") continue;
    if (entry.isDirectory()) Object.assign(files, await fingerprintDirectory(directory, path));
    else if (entry.isFile()) files[path] = await hashFile(join(directory, path));
    else throw new Error("verification cache contains a non-regular file");
  }
  return files;
}

async function kovaIdentity(root) {
  try {
    if (await realpath(git(root, ["rev-parse", "--show-toplevel"])) === await realpath(root)) return { revision: git(root, ["rev-parse", "HEAD"]), dirty: Boolean(git(root, ["status", "--porcelain", "--untracked-files=normal"])) };
  } catch { /* Installed packages use their version even inside another checkout. */ }
  return { revision: (await readJSON(join(root, "package.json"))).version, dirty: false };
}

export async function prepareRun(options, { root = repoRoot } = {}) {
  const path = resolve(options.plan);
  const bytes = await readFile(path);
  const plan = JSON.parse(bytes);
  const { catalogue, findings } = await loadCatalogue("openclaw", { root });
  if (findings.length) throw new Error("invalid command catalogue");
  validateRunPlan(plan, catalogue);
  const persona = await readPersona(resolve(dirname(path), plan.persona.manifest), plan.persona.sha256, catalogue);
  const version = persona.manifest.runtime.selector.slice(4);
  const targets = {
    baseline: await validateTarget(options.targetBaseline, plan.change.baseline, version),
    change: await validateTarget(options.targetChange, plan.change.change, version)
  };
  const standard = await readJSON(join(root, "verify/standard.json"));
  return { plan, planPath: path, planBytes: bytes, planHash: sha256(bytes), catalogue, persona, targets, standard, root, identity: await kovaIdentity(root) };
}

export async function runVerification(options, dependencies = {}) {
  const prepared = await prepareRun(options, dependencies);
  if (!options.execute) return { schema: "kova.verify.dry-run.v1", execute: false, plan: prepared.planPath, targets: prepared.targets, clones: names, phases: prepared.plan.phases.map((phase) => phase.id) };
  return runWithShutdownScope((signal) => executeRun(prepared, { ...dependencies, signal }));
}

async function executeRun(prepared, { execute = runCommand, home = artifactsDir, signal, cloneFactory = createClone, cleanupHandle = cleanupGatewayHandle } = {}) {
  const { plan, planBytes, catalogue, targets, root, identity, standard } = prepared;
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const directory = join(home, "verify", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bindings = new Map();
  const bind = async (command, perform) => {
    const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    const runtime = tokens[0] === "ocm" && ["start", "upgrade"].includes(tokens[1]) ? option(tokens, "--runtime") ?? option(tokens, "--version") : undefined;
    if (runtime === undefined) return await perform();
    const previous = bindings.get(runtime) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    bindings.set(runtime, current);
    await previous;
    try { return await perform(); }
    finally { release(); if (bindings.get(runtime) === current) bindings.delete(runtime); }
  };
  const invoke = (cancelable) => async (command, options = {}) => {
    if (cancelable) signal?.throwIfAborted();
    const result = await bind(command, () => {
      if (cancelable) signal?.throwIfAborted();
      return execute(command, { timeoutMs: 300000, finishOnShutdown: true, maxOutputChars: 16 * 1024 * 1024, env: { KOVA_OPENCLAW_CONFIG_CONTRACT: "canonical" }, ...options });
    });
    if (cancelable) signal?.throwIfAborted();
    if (!options.allowFailure && (result.status !== 0 || result.signal || result.timedOut || result.outputBudget?.truncated)) throw new Error(`command failed (${result.status}): ${command}: ${result.stderr || result.stdout}`);
    return result;
  };
  const call = invoke(true), cleanupCall = invoke(false);
  let key, cache;
  const record = { schema: "kova.verify.run.v1", id, plan: { path: join(directory, "plan.json"), sha256: prepared.planHash, source: prepared.planPath }, kova: identity.revision, ocm: null, targets, clones: Object.fromEntries(names.map((name) => [name, { cached: false, started: false, phases: Object.fromEntries(plan.phases.map((phase) => [phase.id, "no checkpoint"])) }])), incomplete: [], notStarted: [], cleanupErrors: [], cache: { key: null, enabled: false } };
  await writeFile(record.plan.path, planBytes, { mode: 0o600 });
  await writeFile(join(directory, "standard.json"), json(standard), { mode: 0o600 });
  await writeFile(join(directory, "catalogue.json"), json(catalogue), { mode: 0o600 });
  const resources = [], runtimes = [];
  let failure;
  let cached;
  let cacheLocked = false;
  try {
    record.ocm = (await call("ocm --version")).stdout.trim();
    key = cacheKey({ baseline: targets.baseline.commit, manifest: plan.persona.sha256, phases: plan.phasesSha256, kova: identity.revision, ocm: record.ocm });
    cache = join(home, "verify/cache", key);
    record.cache = { key, enabled: !identity.dirty };
    await mkdir(join(directory, ".persona"), { mode: 0o700 });
    const persona = await stagePersona(prepared.persona, join(directory, ".persona"), call);
    for (const [name, extra] of persona.extra) for (const target of Object.values(targets)) if (compareVersions(target.version, extra.version) < 0) throw new Error(`target is older than persona environment ${name}: ${extra.version}`);
    const extras = Object.fromEntries([...persona.extra].map(([name, value]) => [name, value.sha256]));
    if (!identity.dirty) {
      await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
      try { await mkdir(`${cache}.lock`, { mode: 0o700 }); cacheLocked = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; record.cache.skipped = "cache is in use"; }
    }
    if (cacheLocked) {
      try {
        const saved = await readJSON(join(cache, "cache.json"));
        if (saved?.key === key && canonicalJSON(saved.extras) === canonicalJSON(extras) && canonicalJSON(saved.files) === canonicalJSON(await fingerprintDirectory(cache)) && baselineNames.every((name) => saved.clones?.[name]?.started && plan.phases.every((phase) => saved.clones[name].phases?.[phase.id] === "recorded"))) {
          for (const name of baselineNames) await cp(join(cache, name), join(directory, name), { recursive: true, errorOnExist: true });
          cached = saved;
        }
        if (!cached) await rm(cache, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        for (const name of baselineNames) await rm(join(directory, name), { recursive: true, force: true });
        await rm(cache, { recursive: true, force: true });
      }
    }
    for (const side of cached ? ["change"] : ["baseline", "change"]) {
      const target = targets[side];
      const runtime = `kova-run-${randomUUID()}-${side}`;
      const inventory = JSON.parse((await call("ocm runtime list --json")).stdout);
      if (!Array.isArray(inventory) || inventory.some((entry) => entry.name === runtime)) throw new Error("cannot establish a fresh runtime name");
      runtimes.push(runtime);
      await call(`ocm runtime build-local ${q(runtime)} --repo ${q(target.selector.slice(12))} --json`, { timeoutMs: 1800000 });
      // A build cannot silently change the source identity being verified.
      await validateTarget(target.selector, target.commit, persona.manifest.runtime.selector.slice(4));
      target.runtime = runtime;
    }
    const resolver = createCatalogueResolver(catalogue);
    await Promise.all(names.map(async (name) => {
      if (cached && baselineNames.includes(name)) {
        record.clones[name] = { ...cached.clones[name], cached: true };
        for (const phase of record.clones[name].incomplete ?? []) if (!record.incomplete.includes(phase)) record.incomplete.push(phase);
        return;
      }
      const summary = record.clones[name];
      summary.incomplete = [];
      const clone = cloneFactory({ name, directory: join(directory, name), persona, root, call, cleanupCall, cleanupHandle, signal });
      resources.push(clone);
      try {
        const metadata = await clone.prepare();
        summary.env = metadata.name;
        const logReaders = new Map();
        const logs = async () => {
          for (const handle of clone.handles) {
            try {
              const value = await readJSON(handle);
              const paths = [value.ref?.stdoutPath, value.ref?.stderrPath].filter((path) => typeof path === "string");
              if (paths.some((path) => !isAbsolute(path) || !inside(clone.directory, path))) throw new Error("Gateway logs must stay under clone output directory");
              if (paths.length && !logReaders.has(handle)) logReaders.set(handle, createLogCollector(paths));
            } catch (error) { if (error.code !== "ENOENT") throw error; }
          }
          return (await Promise.all([...logReaders.values()].map((collect) => collect()))).join("\n");
        };
        await snapshotState(metadata.stateDir, plan.phases.flatMap((phase) => phase.checkpoint.filter((name) => name.startsWith("state:")).map((name) => name.slice(6))), join(clone.directory, "initial-state"));
        for (const phase of plan.phases) {
          signal?.throwIfAborted();
          const context = { ...clone.context(), standard: phase.from === "standard", target: targets[name.startsWith("change") ? "change" : "baseline"].runtime };
          const results = [];
          const contexts = ["standard/use-target", "standard/start-gateway", "standard/stop-gateway"].includes(phase.id) && clone.contexts ? clone.contexts().map((value) => ({ ...context, ...value })) : [context];
          for (const commandContext of contexts) for (const command of phase.commands) {
            const tokens = parseCatalogueCommand(command, { standard: context.standard }).tokens;
            const entry = resolver(command, { standard: context.standard });
            const handle = option(tokens, "--handle");
            if (handle) clone.handles.add(resolve(commandContext.run, handle.slice(6)));
            const ownTimeout = option(tokens, "--timeout");
            const timeoutMs = ownTimeout === undefined ? phase.timeoutMs : Number(ownTimeout);
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(`invalid command timeout in ${phase.id}`);
            const delay = Number(option(tokens, "--after-ms") ?? 0);
            if (!Number.isSafeInteger(delay) || delay < 0) throw new Error(`invalid command delay in ${phase.id}`);
            const result = await call(resolveRunCommand(command, commandContext), { timeoutMs: timeoutMs + delay + (entry.kind === "gateway" || entry.kind === "script" ? 1000 : 0), allowFailure: true, finishOnShutdown: false });
            result.reachedBound = result.timedOut || (["gateway", "script"].includes(entry.kind) && result.status === 3);
            results.push(result);
          }
          const screens = results.flatMap((result) => { try { const value = JSON.parse(result.stdout); return typeof value.screen === "string" ? [value.screen] : Array.isArray(value.screens) ? value.screens : []; } catch { return []; } });
          const screenPath = screens.at(-1);
          if (screenPath && (!isAbsolute(screenPath) || !inside(clone.directory, screenPath))) throw new Error("screenshot must stay under clone output directory");
          if (results.some((result) => result.status === 2)) {
            summary.incomplete.push(phase.id);
            if (!record.incomplete.includes(phase.id)) record.incomplete.push(phase.id);
          }
          const failedBeforeStart = !summary.started && results.some((result) => result.status !== 0 || result.timedOut);
          if (phase.id === "standard/use-target" && !failedBeforeStart) for (const commandContext of contexts) {
            const bound = JSON.parse((await call(`ocm env show ${q(commandContext.env)} --json`)).stdout);
            if (bound.name !== commandContext.env || bound.defaultRuntime !== context.target) throw new Error("clone did not bind the planned target runtime");
          }
          if (!failedBeforeStart) summary.started = true;
          try {
            await writeCheckpoint({ phase, directory: clone.directory, results, stateDirectory: metadata.stateDir, collectLogs: logs, screenPath });
            summary.phases[phase.id] = "recorded";
          } catch (error) {
            (summary.captureErrors ??= {})[phase.id] = error.message;
            if (!record.incomplete.includes(phase.id)) record.incomplete.push(phase.id);
          }
          if (failedBeforeStart) break;
        }
      } catch (error) { summary.error = error.message; }
    }));
    record.notStarted = names.filter((name) => !record.clones[name]?.started);
    for (const phase of plan.phases) if (baselineNames.some((name) => record.clones[name]?.phases[phase.id] !== "recorded") || ["change-1", "change-2"].every((name) => record.clones[name]?.phases[phase.id] !== "recorded")) {
      if (!record.incomplete.includes(phase.id)) record.incomplete.push(phase.id);
    }
    record.cache.extras = extras;
  } catch (error) { failure = error; record.error = error.message; }
  for (const clone of resources) try { await clone.cleanup(); } catch (error) { record.cleanupErrors.push(error.message); }
  try { await rm(join(directory, ".persona"), { recursive: true, force: true }); } catch (error) { record.cleanupErrors.push(error.message); }
  if (!record.cleanupErrors.length) for (const runtime of runtimes) {
    try {
      const inventory = await cleanupCall("ocm runtime list --json");
      if (JSON.parse(inventory.stdout).some((entry) => entry.name === runtime)) await cleanupCall(`ocm runtime remove ${q(runtime)} --json`);
    } catch (error) { record.cleanupErrors.push(error.message); }
  }
  if (!failure && cacheLocked && !cached && !record.cleanupErrors.length && baselineNames.every((name) => record.clones[name]?.started && !record.clones[name].error && plan.phases.every((phase) => record.clones[name].phases[phase.id] === "recorded"))) {
    await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(`${cache}.pending-`);
    try {
      for (const name of baselineNames) for (const child of ["checkpoints", "initial-state"]) await cp(join(directory, name, child), join(temporary, name, child), { recursive: true });
      await writeFile(join(temporary, "cache.json"), json({ key, extras: record.cache.extras, files: await fingerprintDirectory(temporary), clones: Object.fromEntries(baselineNames.map((name) => [name, record.clones[name]])) }), { mode: 0o600 });
      // A complete cache is immutable. A competing complete writer may win.
      try { await rename(temporary, cache); } catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    } catch (error) { record.cache.error = error.message; }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (cacheLocked) await rm(`${cache}.lock`, { recursive: true, force: true });
  record.notStarted = names.filter((name) => !record.clones[name]?.started);
  await writeFile(join(directory, "run.json"), json(record), { mode: 0o600 });
  if (failure) throw new Error(`${failure.message}; run: ${join(directory, "run.json")}`);
  return { ...record, path: join(directory, "run.json") };
}
