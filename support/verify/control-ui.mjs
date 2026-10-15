import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runWithShutdownScope } from "../../src/commands.mjs";
import { prepareOpenClawRuntimeFromOcmEnv, runOcmJson } from "../openclaw-runtime.mjs";
import { abortable, CallError, cleanupGatewayHandle, parseFlags, positiveMs, readJson, readOperation, requestOperation, serveOperation, serveOperationRequests, startOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";
import { controlUiFlows } from "./control-ui-flows.mjs";
import { observeControlUiHttp, observeControlUiSocket } from "./control-ui-requests.mjs";
export { observeControlUiHttp, observeControlUiSocket } from "./control-ui-requests.mjs";

const filename = fileURLToPath(import.meta.url);
const flags = ["env", "flow", "session-key", "session-from", "incognito-handle", "locale", "gateway-env", "artifact-dir", "out", "timeout", "background", "handle", "wait"];

function emptyOutput(flow) {
  return { flow: flow ?? null, steps: [], screens: [], requests: [], elapsedMs: 0, createdIds: [], sessionKey: null, url: null, handoff: null, error: null };
}

function errorResult(flow, error, startedAt = Date.now(), deadline = Infinity) {
  const exitCode = Date.now() >= deadline || error?.name === "TimeoutError" ? 3 : error?.exitCode ?? 1;
  return { output: { ...emptyOutput(flow), elapsedMs: Date.now() - startedAt, error: exitCode === 3 ? "Control UI timeout" : error instanceof CallError ? error.message : "Control UI operation failed" }, exitCode };
}

export function parseControlUiArgs(argv) {
  const options = parseFlags(argv, ["background"]);
  for (const name of Object.keys(options)) if (!flags.includes(name)) throw new CallError(`unknown flag: --${name}`);
  options.timeoutMs = positiveMs(options.timeout, 120000);
  if (options.wait) {
    for (const key of Object.keys(options)) if (!["wait", "timeout", "timeoutMs", "out"].includes(key)) throw new CallError(`--wait cannot be combined with --${key}`);
  } else {
    for (const name of ["env", "flow", "artifact-dir"]) if (!options[name]?.trim()) throw new CallError(`--${name} is required`);
    if (!Object.hasOwn(controlUiFlows, options.flow)) throw new CallError("unknown Control UI flow");
    if (options.background && !options.handle) throw new CallError("--background requires --handle");
    if (options.flow === "reconnect-and-send" && options.background) throw new CallError("reconnect-and-send requires an existing browser handle");
    if (options["session-key"] && options["session-from"]) throw new CallError("choose --session-key or --session-from");
    if (["open-session-keep-open", "reconnect-and-send"].includes(options.flow) && !options.handle) throw new CallError(`${options.flow} requires a retained browser --handle`);
    if (options.locale) {
      try { new Intl.Locale(options.locale); } catch { throw new CallError("--locale must be a language tag"); }
    }
  }
  for (const name of ["artifact-dir", "out", "session-from", "incognito-handle", "handle", "wait"]) if (options[name]) options[name] = resolve(options[name]);
  return options;
}

export async function resolveControlUiSession(options) {
  if (!options["session-from"]) return options["session-key"];
  let source;
  try { source = await readJson(options["session-from"]); }
  catch { throw new CallError("cannot read --session-from JSON"); }
  if (source?.error) throw new CallError("--session-from contains an error");
  const value = source?.result ?? source;
  const keys = [...new Set([value?.key, value?.sessionKey, value?.session?.key].filter((key) => typeof key === "string" && key.trim()))];
  if (keys.length !== 1) throw new CallError("--session-from requires exactly one session key");
  return keys[0];
}

export async function createControlUiBrowser(options, { signal, prepare = prepareOpenClawRuntimeFromOcmEnv, ocm = runOcmJson, launch, onRequest, onHttpRequest } = {}) {
  const startedAt = Date.now();
  const budget = () => {
    signal?.throwIfAborted();
    const remaining = options.timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new CallError("Control UI startup timeout", 3);
    return remaining;
  };
  const runtime = prepare(options.env, { timeoutMs: budget() });
  const pairing = ocm([`@${options.env}`, "--", "dashboard", "--json"], { timeoutMs: budget() });
  if (!pairing.ok || typeof pairing.browserUrl !== "string") throw new CallError("Gateway did not return a browser pairing URL", 1);
  const initialUrl = new URL(pairing.browserUrl);
  if (!["http:", "https:"].includes(initialUrl.protocol)) throw new CallError("Gateway returned an unsupported browser URL", 1);
  const uiRoot = `${initialUrl.origin}${initialUrl.pathname.replace(/\/$/, "")}`;
  const uiUrl = (path) => /^https?:\/\//.test(path) ? path : `${uiRoot}/${path.replace(/^\//, "")}`;
  const chromium = launch ? null : createRequire(join(runtime.packageRoot, "package.json"))("playwright-core").chromium;
  const browser = await (launch ?? ((settings) => chromium.launch(settings)))({ headless: true, channel: "chrome", timeout: budget() });
  let currentOutput, closed = false, closing, page, context, switchedGateway = false;
  const connection = new Map(), pendingAudits = new Set(), gatewayOrigins = new Set([initialUrl.origin]);
  const gatewayEndpoints = new Set([uiRoot]);
  const close = () => { closed = true; return closing ??= browser.close(); };
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const observePage = (target) => {
    connection.set(target, false);
    const sockets = new Set();
    let pageClosed = false;
    target.once("close", () => {
      pageClosed = true;
      for (const state of sockets) state.finish();
      sockets.clear(); connection.delete(target);
    });
    target.on("websocket", (socket) => {
      if (pageClosed) return;
      const state = { socket, connected: false };
      state.finish = observeControlUiSocket(socket, () => currentOutput, {
        gatewayEndpoints,
        connecting: () => { connection.get(target)?.finish?.(); connection.set(target, state); },
        onRequest, pendingAudits, connected: () => { if (connection.get(target) === state) state.connected = true; },
        disconnected: () => { if (connection.get(target) === state) state.connected = false; }
      });
      sockets.add(state);
      socket.once("close", () => sockets.delete(state));
    });
  };
  try {
    budget();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(options.locale ? { locale: options.locale } : {}) });
    observeControlUiHttp(context, () => currentOutput, { onHttpRequest, pendingAudits, gatewayOrigins });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: initialUrl.origin });
    context.on("page", observePage);
    page = await context.newPage();
    const session = {
      env: options.env, locale: options.locale, page, browser,
      async close() { signal?.removeEventListener("abort", abort); await close(); },
      async run(call, { signal: callSignal } = {}) {
        if (closed) throw new CallError("retained browser is closed", 1);
        if (switchedGateway) throw new CallError("retained browser cannot be reused after switching Gateways; close it with --wait");
        if (call.env !== options.env) throw new CallError("browser environment does not match this call");
        if (call.locale && call.locale !== options.locale) throw new CallError("retained browser locale cannot change");
        const output = emptyOutput(call.flow), began = Date.now();
        currentOutput = output;
        const expiry = new AbortController();
        // Own the deadline even if the browser disconnects while an audit is
        // pending; AbortSignal.timeout alone does not keep Node running.
        const expiryTimer = setTimeout(() => expiry.abort(new CallError("Control UI timeout", 3)), call.timeoutMs);
        const active = AbortSignal.any([expiry.signal, ...[signal, callSignal].filter(Boolean)]);
        let exitCode = 0;
        const remaining = () => { active.throwIfAborted(); return Math.max(1, call.timeoutMs - (Date.now() - began)); };
        active.addEventListener("abort", abort, { once: true });
        const waitConnected = async () => {
          while (!connection.get(page)?.connected) { remaining(); await sleep(Math.min(25, remaining()), undefined, { signal: active }); }
        };
        const shot = async (label, targetPage = page) => {
          const target = join(call["artifact-dir"], `${String(output.screens.length + 1).padStart(2, "0")}-${label.replace(/[^a-z0-9-]/gi, "-")}.png`);
          const bytes = await targetPage.screenshot({ type: "png", timeout: remaining() });
          await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
          output.screens.push(target);
        };
        const step = async (action, perform, { screen = page } = {}) => {
          // Leave a small part of the same deadline for the failed action's
          // screenshot; the outer timeout still closes the browser.
          const actionTimeout = Math.max(1, remaining() - 1000);
          page.setDefaultTimeout(actionTimeout); page.setDefaultNavigationTimeout(actionTimeout);
          const record = { action, status: "pending", elapsedMs: 0 }; output.steps.push(record);
          const start = Date.now();
          let result;
          const actionSignal = AbortSignal.any([active, AbortSignal.timeout(actionTimeout)]);
          try { result = await abortable(Promise.resolve().then(perform), actionSignal); record.status = "result"; }
          catch (error) { record.status = "error"; throw error; }
          finally { record.elapsedMs = Date.now() - start; }
          await shot(action, screen);
          return result;
        };
        try {
          const sessionKey = await resolveControlUiSession(call);
          await mkdir(call["artifact-dir"], { recursive: true, mode: 0o700 });
          const requireSession = () => { if (!sessionKey) throw new CallError("this flow requires --session-key or --session-from"); return sessionKey; };
          const sessionUrl = (key) => `${uiRoot}/chat?session=${encodeURIComponent(key)}`;
          let pairedDestination;
          const waitForDocument = () => page.locator(".sidebar-footer-bar, #settings-session-storage, main[data-public-session]:not([data-entry-pending])").first().waitFor({ state: "visible" });
          const reload = async () => {
            connection.get(page)?.finish?.(); connection.set(page, null);
            await page.reload(); await waitForDocument();
          };
          const navigate = async (path, { waitForGateway = true } = {}) => {
            const destination = uiUrl(path);
            if (destination === pairedDestination) { pairedDestination = undefined; return; }
            pairedDestination = undefined;
            connection.get(page)?.finish?.(); connection.set(page, null); await page.goto(destination);
            if (waitForGateway) await waitConnected();
            await waitForDocument();
          };
          if (page.url() === "about:blank") await step("connect", async () => {
            const path = call.flow.startsWith("new-session-") ? "/new?agent=main"
              : call.flow.includes("session-storage") ? "/settings/ai-agents?section=session"
                : call.flow === "parent-mark-read-after-child" ? "/sessions"
                  : sessionKey ? sessionUrl(sessionKey) : "/chat?session=main";
            pairedDestination = uiUrl(path);
            const destination = new URL(pairedDestination);
            for (const [key, value] of initialUrl.searchParams) if (!destination.searchParams.has(key)) destination.searchParams.set(key, value);
            destination.hash = initialUrl.hash;
            await page.goto(destination.href); await waitConnected();
            await page.locator(call.flow.includes("session-storage") ? "#settings-session-storage" : ".sidebar-footer-bar").waitFor({ state: "visible" });
          });
          else await step("retained-browser", async () => {});
          const pairGateway = async () => {
            if (!call["gateway-env"]) throw new CallError("this flow requires --gateway-env");
            const next = ocm([`@${call["gateway-env"]}`, "--", "dashboard", "--json"], { timeoutMs: remaining() });
            if (!next.ok || typeof next.browserUrl !== "string") throw new CallError("second Gateway did not return a browser pairing URL", 1);
            switchedGateway = true;
            const nextUrl = new URL(next.browserUrl);
            gatewayOrigins.add(nextUrl.origin);
            gatewayEndpoints.add(`${nextUrl.origin}${nextUrl.pathname.replace(/\/$/, "")}`);
            connection.get(page)?.finish?.(); connection.set(page, null); await page.goto(next.browserUrl); await waitConnected();
          };
          await controlUiFlows[call.flow]({ page, step, options: call, sessionKey, origin: initialUrl.origin,
            requireSession, sessionUrl, navigate, reload, openSession: () => navigate(sessionUrl(requireSession())), waitConnected, pairGateway,
            captureValue(name, value) {
              if (["progressRefreshState", "effortChoice", "storageAgeSequence"].includes(name)) {
                output.steps.at(-1).observation = { name, value }; return;
              }
              if (!["sessionKey", "url", "handoff"].includes(name) || typeof value !== "string") throw new CallError("invalid flow output", 1);
              if (name === "url") { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => /token|auth|grant|pair/i.test(key))) throw new CallError("refusing privileged browser URL", 1); }
              output[name] = value;
            },
            async newPage(url) { const other = await context.newPage(); await other.goto(url); return other; }
          });
          // RPC replies are finite; streaming updates arrive as separate events.
          // Include UI writes such as chat.send absent from the RPC catalogue.
          while (output.requests.some((request) => request.transport !== "http" && request.status === "pending")) {
            remaining(); await sleep(Math.min(25, remaining()), undefined, { signal: active });
          }
          await abortable(Promise.all([...pendingAudits]), active);
        } catch (error) {
          const failure = errorResult(call.flow, active.aborted ? active.reason : error, began, began + call.timeoutMs);
          exitCode = failure.exitCode; output.error = failure.output.error;
          if (!closed && !active.aborted) await shot("error").catch(() => {});
          if (exitCode === 3) await close();
        } finally {
          currentOutput = undefined;
          // Failure paths also retain completed validation receipts. The same
          // deadline bounds hooks; an unfinished audit is explicit evidence.
          try {
            await abortable(Promise.all([...pendingAudits]), active);
            if (Date.now() >= began + call.timeoutMs) throw new CallError("Control UI timeout", 3);
          } catch (error) {
            const failure = errorResult(call.flow, active.aborted ? active.reason : error, began, began + call.timeoutMs);
            exitCode = failure.exitCode; output.error = failure.output.error;
            if (exitCode === 3) await close();
          } finally {
            clearTimeout(expiryTimer);
            active.removeEventListener("abort", abort);
          }
          for (const task of pendingAudits) {
            if (task.output !== output) continue;
            task.request.validation ??= { status: "invalid", code: "OBSERVER_INCOMPLETE" };
            output.error ??= "Control UI request validation incomplete";
            if (exitCode === 0) exitCode = 1;
          }
          for (const request of output.requests) if (request.status === "pending") request.status = "unanswered";
          output.elapsedMs = Date.now() - began;
        }
        // Classify after the final audit drain: an admitted request can arrive
        // during the first wait and report a validation failure during finally.
        if (output.requests.some((request) => request.transport !== "http" && request.status === "error")) output.error ??= "Gateway returned an error";
        if (output.error && exitCode === 0) exitCode = 1;
        // Socket callbacks may still settle after the flow's deadline. They
        // cannot revise a result that has already been returned or written.
        return { output: structuredClone(output), exitCode };
      }
    };
    return session;
  } catch (error) { signal?.removeEventListener("abort", abort); await close(); throw error; }
}

export async function executeControlUi(options, controls = {}) {
  const began = Date.now();
  let session, result;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...[controls.signal].filter(Boolean)]);
  const bounded = { ...controls, signal };
  try { session = await createControlUiBrowser(options, bounded); result = await session.run({ ...options, timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - began)) }, bounded); }
  catch (error) { result = errorResult(options.flow, signal.aborted ? signal.reason : error, began, began + options.timeoutMs); }
  finally { await session?.close(); }
  result.output.elapsedMs = Date.now() - began;
  return result;
}

export async function runRetainedBrowser(options, context, { createBrowser = createControlUiBrowser } = {}) {
  const began = Date.now(), deadline = Date.parse(context.operation.expiresAt);
  let session, last;
  try {
    if (Date.now() >= deadline) throw new CallError("Control UI startup timeout", 3);
    session = await createBrowser({ ...options, timeoutMs: Math.max(1, deadline - Date.now()) }, { signal: context.signal });
    last = await session.run({ ...options, timeoutMs: Math.max(1, Date.parse(context.operation.expiresAt) - Date.now()) }, { signal: context.signal });
    last.output.elapsedMs = Date.now() - began;
    if (options.out) await writeGatewayOutput(options, last.output);
    if (last.exitCode !== 0) return last;
    await context.publish({ pid: process.pid, acceptsRequests: true });
    await serveOperationRequests(context, async (call, controls) => {
      try {
        const parsed = parseControlUiArgs(Object.entries(call).filter(([key]) => flags.includes(key) && !["background", "wait"].includes(key)).flatMap(([key, value]) => [`--${key}`, String(value)]));
        if (parsed.out) parsed.out = await validateGatewayOutput({ ...parsed, from: parsed["incognito-handle"] });
        last = await session.run(parsed, controls);
        if (parsed.out) await writeGatewayOutput(parsed, last.output);
        return last;
      } catch (error) { return errorResult(call?.flow, error); }
    });
  } catch (error) {
    const stopped = context.signal.aborted && context.signal.reason?.message === "background operation stopped";
    if (last && (last.exitCode !== 0 || stopped)) return last;
    const failure = errorResult(last?.output.flow ?? options.flow, context.signal.aborted ? context.signal.reason : error, began, deadline);
    if (last) failure.output = { ...last.output, error: failure.output.error };
    return failure;
  } finally {
    try { await session?.close(); }
    catch {
      const failure = errorResult(last?.output.flow ?? options.flow, new CallError("Browser cleanup failed", 1), began);
      if (last) failure.output = { ...last.output, error: failure.output.error };
      return { ...failure, cleanupComplete: false, cleanupError: "Browser closure was not confirmed" };
    }
  }
}

export async function controlUiMain(argv, controls = {}) {
  const began = Date.now();
  let options;
  try {
    options = parseControlUiArgs(argv);
    if (options.out) options.out = await validateGatewayOutput({ ...options, from: options["incognito-handle"] });
    let result;
    if (options.wait) {
      const operation = await readOperation(options.wait);
      if (operation.entry !== "control-ui") throw new CallError("--wait requires a Control UI handle");
      result = await cleanupGatewayHandle(options.wait, { timeoutMs: options.timeoutMs });
    } else if (options.background) {
      return { output: await startOperation(filename, { ...options, startupTimeoutMs: Math.min(2147483647, options.timeoutMs + 1000) }, { entry: "control-ui", method: "control-ui", lifetimeMs: options.timeoutMs, signal: controls.signal }), exitCode: 0 };
    } else if (options.handle) {
      // Output is written by the resource owner, before the reply is published.
      return await requestOperation(options.handle, options, { entry: "control-ui", env: options.env, timeoutMs: options.timeoutMs, signal: controls.signal });
    } else result = await executeControlUi(options, controls);
    if (options.out) await writeGatewayOutput(options, result.output);
    return result;
  } catch (error) { return errorResult(options?.flow, error, began); }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") await serveOperation(runRetainedBrowser);
  else {
    const result = await runWithShutdownScope((signal) => controlUiMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`); process.exitCode = result.exitCode;
  }
}
