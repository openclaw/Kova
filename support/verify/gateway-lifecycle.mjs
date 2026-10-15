import { createWriteStream } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess, runWithShutdownScope } from "../../src/commands.mjs";
import { ocmInvocation } from "../../src/ocm/transport.mjs";
import { resolveGatewayEndpoint } from "../gateway-endpoint.mjs";
import { openDirectGatewayRpcClient, prepareOpenClawRuntimeFromOcmEnv } from "../openclaw-runtime.mjs";
import { personaGatewayEnvironment } from "../persona/environment-content.mjs";
import { abortable, CallError, cleanupGatewayHandle, failure, joinOperation, parseFlags, positiveMs, serveOperation, startOperation } from "./background.mjs";

export { cleanupGatewayHandle } from "./background.mjs";
export const gatewayMaximumLifetimeMs = 6 * 60 * 60 * 1000;
const filename = fileURLToPath(import.meta.url);

async function requireUnusedPort(port, timeoutMs) {
  await new Promise((accept, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (error) => { socket.destroy(); error ? reject(error) : accept(); };
    socket.once("connect", () => finish(new CallError(`Gateway port ${port} already has a listener`, 1)));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? null : error));
    socket.setTimeout(Math.min(2000, timeoutMs), () => finish(new CallError("Gateway port check timeout", 3)));
  });
}

export function parseGatewayLifecycleArgs(argv) {
  const [action, ...args] = argv;
  if (!["start", "stop"].includes(action)) throw new CallError("expected start or stop");
  const options = parseFlags(args, ["background"]);
  const allowed = action === "start" ? ["env", "handle", "timeout", "background", "wait"] : ["wait", "timeout"];
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new CallError(`unknown flag: --${name}`);
  if (action === "start") {
    if (options.wait) {
      for (const name of ["env", "handle", "background"]) if (options[name] !== undefined) throw new CallError(`--wait cannot be combined with --${name}`);
    } else if (!options.env || !options.handle) throw new CallError("start requires --env and --handle");
  }
  if (action === "stop" && !options.wait) throw new CallError("stop requires --wait");
  options.timeoutMs = positiveMs(options.timeout, 120000);
  if (options.handle) options.handle = resolve(options.handle);
  if (options.wait) options.wait = resolve(options.wait);
  return { ...options, action };
}

export async function runForegroundGateway(options, context, dependencies = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const prepare = dependencies.prepare ?? prepareOpenClawRuntimeFromOcmEnv;
  const connect = dependencies.connect ?? openDirectGatewayRpcClient;
  const spawn = dependencies.spawn ?? spawnOwnedProcess;
  const available = dependencies.requireUnusedPort ?? requireUnusedPort;
  const fetchReady = dependencies.fetch ?? fetch;
  let owned;
  let connection;
  let ended;
  let output;
  let errorOutput;
  let published = false;
  let port;
  let result;
  const remaining = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new CallError("Gateway start timeout", 3);
    return Math.max(1, deadline - Date.now());
  };
  try {
    const runtime = prepare(options.env, { timeoutMs: remaining() });
    port = runtime.gatewayPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CallError("invalid Gateway port");
    await available(port, remaining());
    const expectedPath = resolve(runtime.configPath ?? join(runtime.root, ".openclaw", "openclaw.json"));
    const endpoint = resolveGatewayEndpoint(runtime, null, { protocol: "http" });
    const stdoutPath = join(context.operation.directory, "stdout.log");
    const stderrPath = join(context.operation.directory, "stderr.log");
    output = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
    errorOutput = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
    let logError;
    output.on("error", (error) => { logError = error; });
    errorOutput.on("error", (error) => { logError = error; });
    remaining();
    const invocation = (dependencies.invocation ?? ocmInvocation)([`@${options.env}`, "--", "gateway", "run", "--port", String(port)]);
    owned = spawn(invocation.file, invocation.args, { env: { ...invocation.env, ...await personaGatewayEnvironment(runtime) } });
    owned.child.stdout.pipe(output);
    owned.child.stderr.pipe(errorOutput);
    owned.closed.then((value) => { ended = value; });
    while (true) {
      remaining();
      if (logError) throw logError;
      if (ended) throw new CallError(`Gateway exited during startup: ${ended.error?.message ?? ended.status ?? ended.signal}`, 1);
      let healthy = false;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(2000, remaining()))]);
      try {
        const response = await fetchReady(`${endpoint.url}/readyz`, { signal });
        await response.body?.cancel();
        healthy = response.ok;
      } catch { context.signal.throwIfAborted(); }
      if (healthy) {
        const opening = connect(runtime, { timeoutMs: remaining(), authFromRuntimeConfig: true });
        opening.then((value) => { if (context.signal.aborted) value.client.close(); }, () => {});
        connection = await abortable(opening, context.signal);
        const snapshot = await abortable(connection.client.request("config.get", {}, { timeoutMs: Math.min(5000, remaining()) }), context.signal, () => connection.client.close());
        if (typeof snapshot?.path !== "string" || !isAbsolute(snapshot.path) || resolve(snapshot.path) !== expectedPath) throw new CallError("Gateway config path does not match the selected environment", 1);
        if (ended || owned.child.exitCode !== null || owned.child.signalCode !== null) throw new CallError("Gateway exited during identity check", 1);
        remaining();
        await context.publish({ pid: owned.child.pid, ownerPid: process.pid, port, stdoutPath, stderrPath });
        published = true;
        connection.client.close();
        connection = undefined;
        break;
      }
      await sleep(Math.min(100, remaining()), undefined, { signal: context.signal });
    }
    await abortable(owned.closed, context.signal);
    throw new CallError(`Gateway exited before stop: ${ended?.error?.message ?? ended?.status ?? ended?.signal}`, 1);
  } catch (error) {
    if (published && context.signal.aborted && context.signal.reason?.message === "background operation stopped") {
      result = { output: { method: "gateway.stop", result: { pid: owned.child.pid, port, stopped: true }, error: null, elapsedMs: Date.now() - startedAt }, exitCode: 0 };
    } else if (!published && Date.now() >= deadline) {
      result = failure("gateway.start", new CallError("Gateway start timeout", 3), startedAt);
    } else result = failure("gateway.start", context.signal.aborted ? context.signal.reason : error, startedAt);
  } finally {
    connection?.client.close();
    try { await owned?.stop(); }
    catch (error) { result = { ...failure("gateway.stop", error, startedAt), cleanupComplete: false, cleanupError: error.message }; }
    for (const stream of [output, errorOutput]) {
      if (!stream) continue;
      stream.end();
      try { await finished(stream); } catch (error) { result = { ...result, ...failure("gateway.stop", error, startedAt) }; }
    }
  }
  return result;
}

export async function gatewayLifecycleMain(argv, { signal } = {}) {
  let options;
  try {
    options = parseGatewayLifecycleArgs(argv);
    if (options.action === "stop") {
      return await cleanupGatewayHandle(options.wait, { timeoutMs: options.timeoutMs }) ?? failure("gateway.stop", new CallError("Gateway handle is absent"));
    }
    if (options.wait) return await joinOperation(options.wait, { timeoutMs: options.timeoutMs, method: "gateway.start", signal });
    const handle = await startOperation(filename, { ...options, startupTimeoutMs: options.timeoutMs + 1000 }, {
      entry: "foreground-gateway-start", method: "gateway.start", lifetimeMs: gatewayMaximumLifetimeMs, signal
    });
    return { output: handle, exitCode: 0 };
  } catch (error) { return failure(`gateway.${options?.action ?? "start"}`, error); }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") {
    await runWithShutdownScope((signal) => serveOperation(runForegroundGateway, { signal }));
  } else {
    const result = await runWithShutdownScope((signal) => gatewayLifecycleMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  }
}
