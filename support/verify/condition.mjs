import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { runWithShutdownScope } from "../../src/commands.mjs";
import { resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { DirectGatewayRpcClient, openDirectGatewayRpcClient, prepareOpenClawRuntimeFromOcmEnv } from "../openclaw-runtime.mjs";

const inside = (root, path) => { const suffix = relative(root, path); return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`); };
class ConditionCallError extends Error {}

export function boundedInteger(value, fallback, maximum, minimum = 1) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new ConditionCallError(`expected an integer from ${minimum} to ${maximum}`);
  return n;
}
export function parseConditionOptions(spec, argv) {
  const options = {};
  const allowed = new Set(["env", "out", "timeout", "gateway-handle", ...spec.flags]);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !allowed.has(name) || Object.hasOwn(options, name) || !value || value.startsWith("--")) throw new ConditionCallError("invalid or repeated condition option");
    options[name] = value;
  }
  if (!/^kova-(?:run|helpers|scripts)-[a-z0-9][a-z0-9-]*$/i.test(options.env ?? "")) throw new ConditionCallError("--env must name a disposable Kova clone");
  for (const name of ["out", ...(spec.required ?? [])]) if (!options[name]?.trim()) throw new ConditionCallError(`--${name} is required`);
  options.out = resolve(options.out);
  options.timeoutMs = boundedInteger(options.timeout, spec.timeoutMs ?? 120000, 1800000);
  if (options.timeoutMs <= (spec.cleanupMs ?? 0) + 1000) throw new ConditionCallError("timeout does not reserve enough time for condition cleanup");
  if (options["gateway-handle"]) options["gateway-handle"] = resolve(options["gateway-handle"]);
  return options;
}

export async function conditionOwnedPath(root, path, { optional = false, directory = false } = {}) {
  const target = resolve(path);
  if (!inside(root, target)) throw new Error("condition path escapes the selected clone");
  let current = root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) { if (error.code === "ENOENT" && optional) return target; throw error; }
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("condition requires regular unaliased clone paths");
  }
  return target;
}

export async function admitConditionRuntime(runtime) {
  if (resolveOcmTransport()) throw new Error("conditions must execute on the selected clone host");
  if (!isAbsolute(runtime.root) || (await lstat(runtime.root)).isSymbolicLink()) throw new Error("invalid clone root");
  const root = await realpath(runtime.root);
  const stateDir = runtime.stateDir ?? join(root, ".openclaw");
  const configPath = runtime.configPath ?? join(stateDir, "openclaw.json");
  await conditionOwnedPath(root, configPath);
  const config = JSON5.parse(await readFile(configPath, "utf8"));
  const roots = [config.agents?.defaults?.workspace, ...[...Object.values(config.agents?.entries ?? {}), ...(config.agents?.list ?? [])].flatMap((agent) => [agent?.workspace, agent?.agentDir])].filter((path) => typeof path === "string");
  if (roots.some((path) => !isAbsolute(path) || !inside(root, resolve(path)))) throw new Error("clone configuration retains an external agent path");
  for (const path of roots) await conditionOwnedPath(root, path, { optional: true, directory: true });
  for (const path of [config.session?.store, config.logging?.file].filter((value) => typeof value === "string")) {
    if (!isAbsolute(path) || !inside(root, resolve(path))) throw new Error("clone configuration retains an external state path");
    const agents = new Set(["main", ...Object.keys(config.agents?.entries ?? {}), ...(config.agents?.list ?? []).map((agent) => agent.id).filter(Boolean)]);
    for (const agent of agents) await conditionOwnedPath(root, path.replaceAll("{agentId}", agent), { optional: true });
  }
  const envParent = dirname(root) + sep;
  const visit = (value) => {
    if (typeof value === "string" && value.includes(envParent) && !value.includes(root + sep) && value !== root) throw new Error("clone configuration retains a sibling environment path");
    if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
  };
  visit(config);
  return { ...runtime, root, stateDir, configPath };
}

export async function executeCondition(spec, options, run, dependencies = {}) {
  const started = Date.now(), workMs = options.timeoutMs - (spec.cleanupMs ?? 0), deadline = started + workMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("condition deadline exceeded")), workMs);
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  const cleanups = [], clients = [];
  let output, failure, exitCode = 0;
  const remaining = () => { signal.throwIfAborted(); return Math.max(1, deadline - Date.now()); };
  try {
    const runtime = await (dependencies.admit ?? admitConditionRuntime)((dependencies.prepare ?? prepareOpenClawRuntimeFromOcmEnv)(options.env, { timeoutMs: remaining() }));
    if (options["gateway-handle"]) {
      const { readOperation } = await import("./background.mjs");
      const owner = await readOperation(options["gateway-handle"]);
      const ref = owner.handle?.ref;
      if (owner.entry !== "foreground-gateway-start" || owner.method !== "gateway.start" || owner.env !== options.env || ref?.root !== runtime.root || ref?.port !== runtime.gatewayPort || ref?.lifecycleState === "paused" || !Number.isFinite(Date.parse(owner.expiresAt)) || Date.parse(owner.expiresAt) <= Date.now()) throw new Error("condition requires this clone's live foreground Gateway owner");
      try { await readFile(join(owner.directory, "result.json")); throw new Error("foreground Gateway has already ended"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const context = {
      options, runtime, signal, remaining,
      ownedPath: (path, flags) => conditionOwnedPath(runtime.root, path, flags),
      cleanup(fn) { cleanups.push(fn); },
      async connect(scopes) {
        remaining();
        let client = (await (dependencies.connect ?? openDirectGatewayRpcClient)(runtime, { timeoutMs: Math.min(15000, remaining()), authFromRuntimeConfig: true })).client;
        if (scopes) {
          const initial = client;
          class ScopedClient extends DirectGatewayRpcClient {
            buildConnectParams() { return { ...super.buildConnectParams(), scopes }; }
            async request(method, params, limits) { const result = await super.request(method, params, limits); if (method === "connect") this.grantedScopes = result?.auth?.scopes; return result; }
          }
          client = new ScopedClient({ url: initial.url, token: initial.token });
          initial.close();
          try { await client.connect(Math.min(15000, remaining())); }
          catch (error) { client.close(); throw error; }
        }
        clients.push(client);
        return client;
      },
      async observe(client, method, params, { timeoutMs } = {}) {
        const began = Date.now();
        try {
          const result = await client.request(method, params, { timeoutMs: Math.min(timeoutMs ?? remaining(), remaining()) });
          return { status: "completed", result, elapsedMs: Date.now() - began };
        } catch (error) {
          return { status: /timeout|deadline/i.test(error.message) ? "timeout" : "error", error: String(error.message), elapsedMs: Date.now() - began };
        }
      }
    };
    output = await run(context);
    signal.throwIfAborted();
  } catch (error) {
    output = error.output ?? output;
    failure = String(error.message);
    exitCode = controller.signal.aborted ? 3 : error instanceof ConditionCallError ? 2 : 1;
  }
  finally {
    clearTimeout(timer);
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failure = `${failure ? `${failure}; ` : ""}cleanup: ${error.message}`; exitCode ||= 1; }
    }
    for (const client of clients) client.close();
  }
  return { output: { operation: spec.id, ...output, ...(failure ? { error: failure } : {}), elapsedMs: Date.now() - started }, exitCode };
}

export async function conditionMain(url, spec, run) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(url)) return;
  await runWithShutdownScope(async (signal) => {
    let file, result;
    try {
      const options = parseConditionOptions({ ...spec, required: [...new Set(["gateway-handle", ...(spec.required ?? [])])] }, process.argv.slice(2));
      if (await realpath(dirname(options.out)) !== dirname(options.out)) throw new ConditionCallError("condition output parent must not be aliased");
      file = await open(options.out, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      result = await executeCondition(spec, options, run, { signal });
      await file.writeFile(JSON.stringify(result.output) + "\n");
      await file.sync();
    } catch (error) { result = { output: { operation: spec.id, error: String(error.message) }, exitCode: error instanceof ConditionCallError ? 2 : 1 }; }
    finally { await file?.close(); }
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result.output) + "\n", (error) => error ? reject(error) : resolve()));
    process.exitCode = result.exitCode;
  });
}
