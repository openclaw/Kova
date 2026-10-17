import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export class CallError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function parseFlags(argv, booleans = []) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf("=");
    const flag = equals < 0 ? raw : raw.slice(0, equals);
    if (!flag.startsWith("--") || Object.hasOwn(values, flag.slice(2))) throw new CallError(`invalid or repeated flag: ${flag}`);
    const name = flag.slice(2);
    if (booleans.includes(name)) {
      if (equals >= 0) throw new CallError(`${flag} does not take a value`);
      values[name] = true;
    }
    else {
      const value = equals < 0 ? argv[++index] : raw.slice(equals + 1);
      if (value === undefined || value.startsWith("--")) throw new CallError(`${flag} requires a value`);
      values[name] = value;
    }
  }
  return values;
}

export function positiveMs(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new CallError("timeout must be a positive number of milliseconds below 2147483648");
  return number;
}

export async function atomicJson(path, value, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    if (exclusive) {
      // A hard link publishes a complete file without replacing an existing one.
      const { link } = await import("node:fs/promises");
      await link(temporary, path);
    } else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function canonicalPath(path) {
  let parent = resolve(path);
  const suffix = [];
  while (true) {
    try { return join(await realpath(parent), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(parent) === parent) throw error;
      suffix.push(basename(parent));
      parent = dirname(parent);
    }
  }
}

async function rejectOperationDirectory(path, flag) {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    let record;
    try { record = await readJson(join(parent, "operation.json")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (record?.schema === "kova.gateway.operation.v1") throw new CallError(`${flag} cannot write inside a background operation directory`);
    if (dirname(parent) === parent) break;
  }
}

export async function validateGatewayOutput(options) {
  const path = await canonicalPath(options.out);
  for (const key of ["handle", "wait", "session-from", "merge-from", "from"]) {
    if (!options[key]) continue;
    const input = await canonicalPath(options[key]);
    if (path === input || (["handle", "wait"].includes(key) && (path === `${input}.d` || path.startsWith(`${input}.d${sep}`)))) {
      throw new CallError(`--out overlaps --${key}`);
    }
  }
  await rejectOperationDirectory(path, "--out");
  try { await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return path; throw error; }
  throw new CallError("--out already exists; choose a new output path");
}

export async function writeGatewayOutput(options, output) {
  const path = await validateGatewayOutput(options);
  try { await atomicJson(path, output, { exclusive: true }); }
  catch (error) {
    if (error.code === "EEXIST") throw new CallError("--out already exists; choose a new output path");
    throw error;
  }
}

export async function readJson(path, { signal } = {}) {
  return JSON.parse(await readFile(path, { encoding: "utf8", signal }));
}

async function optionalJson(path) {
  try { return await readJson(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function failure(method, error, startedAt = Date.now()) {
  return {
    output: { method: method ?? null, result: null, error: String(error?.message ?? error), elapsedMs: Date.now() - startedAt },
    exitCode: error?.exitCode ?? (error?.name === "TimeoutError" ? 3 : 1)
  };
}

export async function readOperation(handlePath) {
  const path = resolve(handlePath);
  const directory = `${path}.d`;
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CallError("invalid background directory");
  const descriptor = await readJson(join(directory, "operation.json"));
  if (descriptor.schema !== "kova.gateway.operation.v1" || descriptor.handlePath !== path || descriptor.directory !== directory) {
    throw new CallError("background directory does not match its handle");
  }
  const handle = await optionalJson(path);
  if (handle && (handle.ref?.directory !== directory || handle.ref?.id !== descriptor.id || handle.entry !== descriptor.entry)) {
    throw new CallError("background handle does not match its operation");
  }
  return { ...descriptor, handle };
}

export async function joinOperation(handlePath, { timeoutMs = 120000, method, env, signal } = {}) {
  signal?.throwIfAborted();
  const operation = await readOperation(handlePath);
  if ((method && operation.method !== method) || (env && operation.env !== env)) throw new CallError("background handle does not match this call");
  const deadline = Date.now() + positiveMs(timeoutMs);
  while (true) {
    signal?.throwIfAborted();
    const result = await optionalJson(join(operation.directory, "result.json"));
    if (result) return result;
    if (Date.now() >= deadline) throw new CallError("background join timeout", 3);
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

export async function cleanupGatewayHandle(handlePath, { timeoutMs = 30000 } = {}) {
  let operation;
  try { operation = await readOperation(handlePath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const result = await optionalJson(join(operation.directory, "result.json"));
  if (result) return requireCleanup(result);
  await writeFile(join(operation.directory, "stop"), "stop\n", { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return requireCleanup(await joinOperation(handlePath, { timeoutMs }));
}

function requireCleanup(result) {
  if (result.cleanupComplete !== true) throw new CallError(`background cleanup unresolved: ${result.cleanupError ?? "completion was not confirmed"}`, 1);
  return result;
}

export async function startOperation(modulePath, options, { entry, method, lifetimeMs, signal } = {}) {
  const handlePath = resolve(options.handle);
  await rejectOperationDirectory(await canonicalPath(handlePath), "--handle");
  const directory = `${handlePath}.d`;
  await mkdir(dirname(handlePath), { recursive: true, mode: 0o700 });
  // The directory is also the claim while the public handle is still absent.
  await mkdir(directory, { mode: 0o700 });
  const operation = {
    schema: "kova.gateway.operation.v1", id: randomUUID(), entry, method,
    startedAt: new Date().toISOString(), env: options.env, handlePath, directory,
    expiresAt: new Date(Date.now() + lifetimeMs).toISOString()
  };
  let child;
  try {
    try { await lstat(handlePath); throw new CallError("background handle already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await atomicJson(join(directory, "operation.json"), operation);
    signal?.throwIfAborted();
    child = fork(modulePath, ["--worker"], {
      detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [], serialization: "json"
    });
    const startupMs = options.startupTimeoutMs ?? 10000;
    const started = await new Promise((accept, reject) => {
      const timer = setTimeout(() => finish(reject, new CallError("background start timeout", 3)), startupMs);
      const onAbort = () => finish(reject, signal.reason ?? new CallError("background start interrupted", 1));
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        callback(value);
      };
      const onError = (error) => finish(reject, error);
      const onExit = () => finish(reject, new CallError("background process exited before publishing its handle", 1));
      const onMessage = (message) => {
        if (message?.type === "started") finish(accept, message.handle);
        if (message?.type === "complete") finish(reject, new CallError(message.result.output.error ?? "background operation ended during startup", message.result.exitCode || 1));
      };
      child.on("error", onError);
      child.on("exit", onExit);
      child.on("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.send({ options: { ...options, handle: handlePath }, operation }, (error) => { if (error) onError(error); });
    });
    if (child.connected) child.disconnect();
    child.unref();
    return started;
  } catch (error) {
    if (child) {
      // The child owns shutdown of any Gateway it started.
      if (child.connected) child.disconnect();
      try { await cleanupGatewayHandle(handlePath, { timeoutMs: 10000 }); }
      catch (cleanupError) { throw new CallError(`${error.message}; background cleanup unresolved: ${cleanupError.message}`, error.exitCode ?? 1); }
      finally { child.unref(); }
    } else {
      await atomicJson(join(directory, "result.json"), { ...failure(method, error), cleanupComplete: true });
    }
    throw error;
  }
}

export async function serveOperation(callback, { signal } = {}) {
  const message = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new CallError("background initialization timeout", 3)), 10000);
    process.once("message", (value) => { clearTimeout(timer); accept(value); });
    process.once("disconnect", () => { clearTimeout(timer); reject(new CallError("background initialization disconnected", 1)); });
  });
  const { options, operation } = message;
  const controller = new AbortController();
  let published = false;
  let checking = false;
  const abort = (error) => controller.abort(error);
  const aborted = () => abort(signal.reason);
  if (signal?.aborted) aborted();
  signal?.addEventListener("abort", aborted, { once: true });
  const disconnected = () => { if (!published) abort(new CallError("background startup disconnected", 1)); };
  process.on("disconnect", disconnected);
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const interrupted = () => abort(new CallError("background operation interrupted", 1));
  for (const signal of signals) process.on(signal, interrupted);
  const timer = setTimeout(() => abort(new CallError("background lifetime timeout", 3)), Math.max(1, Date.parse(operation.expiresAt) - Date.now()));
  const poll = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try { await lstat(join(operation.directory, "stop")); abort(new CallError("background operation stopped", 1)); }
    catch (error) { if (error.code !== "ENOENT") abort(error); }
    finally { checking = false; }
  }, 50);
  let result;
  try {
    result = await callback(options, {
      operation, signal: controller.signal,
      async publish(ref = {}) {
        controller.signal.throwIfAborted();
        const handle = {
          entry: operation.entry, startedAt: operation.startedAt, env: operation.env,
          ref: { id: operation.id, directory: operation.directory, expiresAt: operation.expiresAt, ...ref }
        };
        await atomicJson(operation.handlePath, handle, { exclusive: true });
        published = true;
        if (process.connected) process.send({ type: "started", handle }, () => {});
        return handle;
      }
    });
  } catch (error) {
    result = failure(operation.method, error, Date.parse(operation.startedAt));
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    signal?.removeEventListener("abort", aborted);
    process.off("disconnect", disconnected);
    for (const signal of signals) process.off(signal, interrupted);
  }
  try {
    result.cleanupComplete ??= true;
    await atomicJson(join(operation.directory, "result.json"), result);
    await unlink(join(operation.directory, "stop")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (process.connected) process.send({ type: "complete", result }, () => { if (process.connected) process.disconnect(); });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export async function abortable(promise, signal, onAbort = () => {}) {
  signal?.throwIfAborted();
  if (!signal) return await promise;
  let handler;
  const aborted = new Promise((_, reject) => {
    handler = () => { onAbort(); reject(signal.reason); };
    signal.addEventListener("abort", handler, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", handler); }
}
