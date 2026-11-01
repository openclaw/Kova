import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runWithShutdownScope } from "../../src/commands.mjs";
import { prepareOpenClawRuntimeFromOcmEnv, runOcmJson } from "../openclaw-runtime.mjs";
import { abortable, CallError, cleanupGatewayHandle, parseFlags, positiveMs, readJson, readOperation, requestOperation, serveOperation, serveOperationRequests, startOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";
import { controlUiFlows } from "./control-ui-flows.mjs";
import { atStartupStage, ControlUiStartupError, controlUiException, startupFailure } from "./control-ui-errors.mjs";
import { observeControlUiHttp, observeControlUiSocket } from "./control-ui-requests.mjs";
export { observeControlUiHttp, observeControlUiSocket } from "./control-ui-requests.mjs";

const filename = fileURLToPath(import.meta.url);
const flags = ["env", "flow", "session-key", "session-from", "incognito-handle", "locale", "gateway-env", "artifact-dir", "out", "timeout", "background", "handle", "wait"];
const hasStartupDiagnostic = (message) => typeof message === "string" && /^Control UI (?:startup failed|timeout) at /.test(message);

function emptyOutput(flow) {
  return { flow: flow ?? null, steps: [], screens: [], requests: [], elapsedMs: 0, createdIds: [], sessionKey: null, url: null, handoff: null, error: null };
}

function errorResult(flow, error, startedAt = Date.now(), deadline = Infinity) {
  const exitCode = Date.now() >= deadline || error?.name === "TimeoutError" ? 3 : [1, 2, 3].includes(error?.exitCode) ? error.exitCode : 1;
  const message = error instanceof ControlUiStartupError ? error.describe(exitCode === 3)
    : error instanceof CallError && hasStartupDiagnostic(error.message) ? (exitCode === 3 ? error.message.replace(/^Control UI startup failed/, "Control UI timeout") : error.message)
    : exitCode === 3 ? "Control UI timeout" : error instanceof CallError ? error.message : "Control UI operation failed";
  return { output: { ...emptyOutput(flow), elapsedMs: Date.now() - startedAt, error: message }, exitCode,
    ...(error instanceof ControlUiStartupError && error.cleanup ? { cleanupComplete: false, cleanupError: "Browser closure was not confirmed" } : {}) };
}

async function writeControlUiOutput(options, result) {
  try { await writeGatewayOutput(options, result.output); }
  catch (error) {
    if (result.output.steps.length && !hasStartupDiagnostic(result.output.error)) throw error;
    const failure = errorResult(result.output.flow, startupFailure("output-write", error));
    return { ...result, exitCode: result.exitCode || failure.exitCode,
      output: { ...result.output, error: [result.output.error, failure.output.error].filter(Boolean).join("; ") } };
  }
  return result;
}

function cleanupFailure(result, error) {
  if (result.cleanupComplete === false) return result;
  const message = `Browser cleanup failed: ${JSON.stringify(controlUiException(error))}`;
  result.output.error = result.output.error ? `${result.output.error}; ${message}` : message;
  if (result.exitCode === 0) result.exitCode = 1;
  return { ...result, cleanupComplete: false, cleanupError: "Browser closure was not confirmed" };
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
  catch (error) { throw Object.assign(new CallError("cannot read --session-from JSON"), { cause: controlUiException(error) }); }
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
  const mapOcmError = (stage) => (error, ocmCommand) => startupFailure(stage, { name: "Error", ocmCommand, cause: error });
  const runtime = await atStartupStage("runtime", () => prepare(options.env, { timeoutMs: budget(), mapError: mapOcmError("runtime") }));
  const pairing = await atStartupStage("dashboard", () => ocm([`@${options.env}`, "--", "dashboard", "--json"], { timeoutMs: budget(), mapError: mapOcmError("dashboard") }));
  const initialUrl = await atStartupStage("pairing-url", () => {
    if (!pairing?.ok || typeof pairing.browserUrl !== "string") throw Object.assign(new CallError("Gateway did not return a browser pairing URL", 1), { dashboardResult: pairing });
    const url = new URL(pairing.browserUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new CallError("Gateway returned an unsupported browser URL", 1);
    return url;
  });
  const uiRoot = `${initialUrl.origin}${initialUrl.pathname.replace(/\/$/, "")}`;
  const uiUrl = (path) => /^https?:\/\//.test(path) ? path : `${uiRoot}/${path.replace(/^\//, "")}`;
  const chromium = launch ? null : await atStartupStage("playwright", () => createRequire(join(runtime.packageRoot, "package.json"))("playwright-core").chromium);
  const browser = await atStartupStage("browser-launch", () => (launch ?? ((settings) => chromium.launch(settings)))({ headless: true, channel: "chrome", timeout: budget() }));
  let currentOutput, closed = false, closing, page, context, switchedGateway = false;
  const connection = new Map(), pageSockets = new Map(), pendingAudits = new Set(), gatewayOrigins = new Set([initialUrl.origin]);
  const gatewayEndpoints = new Set([uiRoot]);
  const retirePage = (target) => { for (const state of pageSockets.get(target) ?? []) state.finish(); };
  const close = () => { closed = true; for (const target of pageSockets.keys()) retirePage(target); return closing ??= browser.close(); };
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const observePage = (target) => {
    connection.set(target, false);
    const sockets = new Set();
    pageSockets.set(target, sockets);
    let pageClosed = false;
    target.once("close", () => {
      pageClosed = true;
      for (const state of sockets) state.finish(false);
      sockets.clear(); pageSockets.delete(target); connection.delete(target);
    });
    target.on("websocket", (socket) => {
      if (pageClosed) return;
      const state = { socket, connected: false };
      state.finish = observeControlUiSocket(socket, () => currentOutput, {
        gatewayEndpoints,
        connecting: () => {
          const previous = connection.get(target);
          if (previous && previous !== state) previous.finish(false);
          connection.set(target, state);
        },
        onRequest, pendingAudits, connected: () => { if (connection.get(target) === state) state.connected = true; },
        disconnected: () => { if (connection.get(target) === state) state.connected = false; }
      });
      sockets.add(state);
      socket.once("close", () => sockets.delete(state));
    });
  };
  try {
    context = await atStartupStage("browser-context", () => {
      budget();
      return browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(options.locale ? { locale: options.locale } : {}) });
    });
    observeControlUiHttp(context, () => currentOutput, { onHttpRequest, pendingAudits, gatewayOrigins });
    await atStartupStage("browser-permissions", () => context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: initialUrl.origin }));
    context.on("page", observePage);
    page = await atStartupStage("browser-page", () => context.newPage());
    const session = {
      env: options.env, locale: options.locale, page, browser,
      async close() { signal?.removeEventListener("abort", abort); await close(); },
      async run(call, { signal: callSignal } = {}) {
        await atStartupStage("retained-browser", () => {
          if (closed) throw new CallError("retained browser is closed", 1);
          if (switchedGateway) throw new CallError("retained browser cannot be reused after switching Gateways; close it with --wait");
          if (call.env !== options.env) throw new CallError("browser environment does not match this call");
          if (call.locale && call.locale !== options.locale) throw new CallError("retained browser locale cannot change");
        });
        const output = emptyOutput(call.flow), began = Date.now();
        currentOutput = output;
        const expiry = new AbortController();
        // Own the deadline even if the browser disconnects while an audit is
        // pending; AbortSignal.timeout alone does not keep Node running.
        const expiryTimer = setTimeout(() => expiry.abort(new CallError("Control UI timeout", 3)), call.timeoutMs);
        const active = AbortSignal.any([expiry.signal, ...[signal, callSignal].filter(Boolean)]);
        let exitCode = 0, startupError, closeError, startingFlow = true, startupStage = "flow-start";
        const startupAt = (stage, perform) => { startupStage = stage; return atStartupStage(stage, perform); };
        const closeOnTimeout = async () => {
          expiry.abort(new CallError("Control UI timeout", 3));
          try { await close(); } catch (error) { closeError = error; }
        };
        const remaining = () => { active.throwIfAborted(); return Math.max(1, call.timeoutMs - (Date.now() - began)); };
        active.addEventListener("abort", abort, { once: true });
        const waitForReplies = async () => {
          while (output.requests.some((request) => request.transport !== "http" && request.status === "pending")) {
            remaining(); await sleep(Math.min(25, remaining()), undefined, { signal: active });
          }
        };
        const waitConnected = async () => {
          while (!connection.get(page)?.connected) { remaining(); await sleep(Math.min(25, remaining()), undefined, { signal: active }); }
        };
        const shot = async (label, targetPage = page) => {
          const target = join(call["artifact-dir"], `${String(output.screens.length + 1).padStart(2, "0")}-${label.replace(/[^a-z0-9-]/gi, "-")}.png`);
          const bytes = await targetPage.screenshot({ type: "png", timeout: remaining() });
          await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
          output.screens.push(target);
        };
        const step = async (action, perform, { screen = page, startup = false } = {}) => {
          // Leave a small part of the same deadline for the failed action's
          // screenshot; the outer timeout still closes the browser.
          const actionTimeout = Math.max(1, remaining() - 1000);
          try { page.setDefaultTimeout(actionTimeout); page.setDefaultNavigationTimeout(actionTimeout); }
          catch (error) { throw startingFlow ? startupFailure("first-step", error) : error; }
          const record = { action, status: "pending", elapsedMs: 0 }; output.steps.push(record);
          if (!startup) startingFlow = false;
          const start = Date.now();
          let result;
          const actionSignal = AbortSignal.any([active, AbortSignal.timeout(actionTimeout)]);
          try { result = await abortable(Promise.resolve().then(perform), actionSignal); record.status = "result"; }
          catch (error) { record.status = "error"; throw error; }
          finally { record.elapsedMs = Date.now() - start; }
          if (startup) await startupAt("initial-capture", () => shot(action, screen));
          else await shot(action, screen);
          return result;
        };
        try {
          const sessionKey = await startupAt("session-input", () => resolveControlUiSession(call));
          await startupAt("artifact-directory", () => mkdir(call["artifact-dir"], { recursive: true, mode: 0o700 }));
          const requireSession = () => { if (!sessionKey) throw new CallError("this flow requires --session-key or --session-from"); return sessionKey; };
          const sessionUrl = (key) => `${uiRoot}/chat?session=${encodeURIComponent(key)}`;
          let pairedDestination;
          const waitForDocument = () => page.locator(".sidebar-footer-bar, #settings-session-storage, main[data-public-session]:not([data-entry-pending])").first().waitFor({ state: "visible" });
          const reload = async () => {
            retirePage(page); connection.set(page, null);
            await page.reload(); await waitForDocument();
          };
          const navigate = async (path, { waitForGateway = true } = {}) => {
            const destination = uiUrl(path);
            if (destination === pairedDestination) { pairedDestination = undefined; return; }
            pairedDestination = undefined;
            retirePage(page); connection.set(page, null); await page.goto(destination);
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
            await startupAt("gateway-navigation", () => page.goto(destination.href));
            await startupAt("gateway-connect", waitConnected);
            await startupAt("gateway-document", () => page.locator(call.flow.includes("session-storage") ? "#settings-session-storage" : ".sidebar-footer-bar").waitFor({ state: "visible" }));
          }, { startup: true });
          else await step("retained-browser", async () => {}, { startup: true });
          const pairGateway = async () => {
            if (!call["gateway-env"]) throw new CallError("this flow requires --gateway-env");
            const next = ocm([`@${call["gateway-env"]}`, "--", "dashboard", "--json"], { timeoutMs: remaining() });
            if (!next.ok || typeof next.browserUrl !== "string") throw new CallError("second Gateway did not return a browser pairing URL", 1);
            switchedGateway = true;
            const nextUrl = new URL(next.browserUrl);
            gatewayOrigins.add(nextUrl.origin);
            gatewayEndpoints.add(`${nextUrl.origin}${nextUrl.pathname.replace(/\/$/, "")}`);
            retirePage(page); connection.set(page, null); await page.goto(next.browserUrl); await waitConnected();
          };
          startupStage = "flow-start";
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
            async newPage(url) { const other = await context.newPage(); await other.goto(url); return other; },
            async closePage(target) { retirePage(target); await target.close(); }
          });
          // RPC replies are finite; streaming updates arrive as separate events.
          // Include UI writes such as chat.send absent from the RPC catalogue.
          await waitForReplies();
          await abortable(Promise.all([...pendingAudits]), active);
        } catch (error) {
          if (startingFlow) startupError = startupFailure(startupStage, error);
          const failure = errorResult(call.flow, startupError ?? (active.aborted ? active.reason : error), began, began + call.timeoutMs);
          exitCode = failure.exitCode; output.error = failure.output.error;
          if (!closed && !active.aborted) await shot("error").catch(() => {});
          if (exitCode === 3) await closeOnTimeout();
        } finally {
          currentOutput = undefined;
          // Failure paths also retain completed validation receipts. The same
          // deadline bounds hooks; an unfinished audit is explicit evidence.
          try {
            // Requests admitted during the first audit wait still own their
            // replies. Admission is closed above; drain them under the same deadline.
            await waitForReplies();
            await abortable(Promise.all([...pendingAudits]), active);
            if (Date.now() >= began + call.timeoutMs) throw new CallError("Control UI timeout", 3);
          } catch (error) {
            const failure = errorResult(call.flow, startupError ?? (active.aborted ? active.reason : error), began, began + call.timeoutMs);
            exitCode = failure.exitCode; output.error = failure.output.error;
            if (exitCode === 3) await closeOnTimeout();
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
        // The UI discovers apps in the background, but the Gateway excludes
        // incognito targets. Retain that refusal without failing creation of
        // the same session; other authorization and creation failures still fail.
        const creationDiscovery = (request) => call.flow === "new-session-incognito"
          && typeof output.sessionKey === "string" && output.createdIds.includes(output.sessionKey)
          && request.method === "mcp.app.discover" && request.errorCode === "FORBIDDEN"
          && request.errorReason === "incognito-session" && request.params?.sessionKey === output.sessionKey;
        if (output.requests.some((request) => request.transport !== "http" && request.status === "error" && !creationDiscovery(request))) output.error ??= "Gateway returned an error";
        if (output.error && exitCode === 0) exitCode = 1;
        // Socket callbacks may still settle after the flow's deadline. They
        // cannot revise a result that has already been returned or written.
        const result = { output: structuredClone(output), exitCode };
        return closeError ? cleanupFailure(result, closeError) : result;
      }
    };
    return session;
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    const failure = startupFailure("browser-observation", error);
    try { await close(); } catch (cleanup) { failure.cleanup = controlUiException(cleanup); }
    throw failure;
  }
}

export async function executeControlUi(options, controls = {}) {
  const began = Date.now();
  let session, result;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...[controls.signal].filter(Boolean)]);
  const bounded = { ...controls, signal };
  try { session = await createControlUiBrowser(options, bounded); result = await session.run({ ...options, timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - began)) }, bounded); }
  catch (error) { result = errorResult(options.flow, startupFailure("browser", error), began, began + options.timeoutMs); }
  finally {
    try { await session?.close(); }
    catch (error) { result = cleanupFailure(result, error); }
  }
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
    if (options.out) last = await writeControlUiOutput(options, last);
    if (last.exitCode !== 0) return last;
    await context.publish({ pid: process.pid, acceptsRequests: true });
    await serveOperationRequests(context, async (call, controls) => {
      try {
        const parsed = await atStartupStage("arguments", () => parseControlUiArgs(Object.entries(call).filter(([key]) => flags.includes(key) && !["background", "wait"].includes(key)).flatMap(([key, value]) => [`--${key}`, String(value)])));
        if (parsed.out) parsed.out = await atStartupStage("output-validation", () => validateGatewayOutput({ ...parsed, from: parsed["incognito-handle"] }));
        last = await session.run(parsed, controls);
        if (parsed.out) last = await writeControlUiOutput(parsed, last);
        return last;
      } catch (error) { return errorResult(call?.flow, error); }
    });
  } catch (error) {
    const stopped = context.signal.aborted && context.signal.reason?.message === "background operation stopped";
    if (last && (last.exitCode !== 0 || stopped)) return last;
    const failure = errorResult(last?.output.flow ?? options.flow, last?.output.steps.length && !hasStartupDiagnostic(last.output.error) ? (context.signal.aborted ? context.signal.reason : error) : startupFailure("browser", error), began, deadline);
    if (last) failure.output = { ...last.output, error: failure.output.error };
    last = failure;
    return last;
  } finally {
    try { await session?.close(); }
    catch (error) {
      return cleanupFailure(last ?? errorResult(options.flow, startupFailure("browser-close", error), began, deadline), error);
    }
  }
}

export async function controlUiMain(argv, controls = {}) {
  const began = Date.now();
  let options, result, stage = "arguments";
  try {
    options = parseControlUiArgs(argv);
    stage = "output-validation";
    if (options.out) options.out = await validateGatewayOutput({ ...options, from: options["incognito-handle"] });
    if (options.wait) {
      stage = "browser-join";
      const operation = await readOperation(options.wait);
      if (operation.entry !== "control-ui") throw new CallError("--wait requires a Control UI handle");
      result = await cleanupGatewayHandle(options.wait, { timeoutMs: options.timeoutMs });
    } else if (options.background) {
      stage = "background-start";
      return { output: await startOperation(filename, { ...options, startupTimeoutMs: Math.min(2147483647, options.timeoutMs + 1000) }, {
        entry: "control-ui", method: "control-ui", lifetimeMs: options.timeoutMs, signal: controls.signal,
        failureResult: (error) => errorResult(options.flow, startupFailure("background-start", error), began),
      }), exitCode: 0 };
    } else if (options.handle) {
      stage = "browser-dispatch";
      // Output is written by the resource owner, before the reply is published.
      return await requestOperation(options.handle, options, { entry: "control-ui", env: options.env, timeoutMs: options.timeoutMs, signal: controls.signal });
    } else { stage = "browser"; result = await executeControlUi(options, controls); }
    stage = "output-write";
    if (options.out) result = await writeControlUiOutput(options, result);
    return result;
  } catch (error) {
    // The worker has already projected this message before the handle handoff.
    if (error instanceof CallError && hasStartupDiagnostic(error.message)) return errorResult(options?.flow, error, began);
    return errorResult(options?.flow, result?.output.steps.length && !hasStartupDiagnostic(result.output.error) ? error : startupFailure(stage, error), began);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") await serveOperation(runRetainedBrowser);
  else {
    const result = await runWithShutdownScope((signal) => controlUiMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`); process.exitCode = result.exitCode;
  }
}
