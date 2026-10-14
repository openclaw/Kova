import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runWithShutdownScope } from "../../src/commands.mjs";
import { prepareOpenClawRuntimeFromOcmEnv, runOcmJson } from "../openclaw-runtime.mjs";
import { abortable, CallError, cleanupGatewayHandle, parseFlags, positiveMs, readJson, readOperation, requestOperation, serveOperation, serveOperationRequests, startOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";
import { controlUiFlows } from "./control-ui-flows.mjs";

const filename = fileURLToPath(import.meta.url);
const flags = ["env", "flow", "session-key", "session-from", "incognito-handle", "locale", "gateway-env", "artifact-dir", "out", "timeout", "background", "handle", "wait"];
const creationFlows = new Set(["new-session-page", "new-session-incognito", "palette-background-session", "palette-background-start"]);
const requestLimit = 20000;
const errorCodes = new Set(["NOT_LINKED", "NOT_PAIRED", "AGENT_TIMEOUT", "INVALID_REQUEST", "FORBIDDEN", "APPROVAL_NOT_FOUND", "UNAVAILABLE"]);

function emptyOutput(flow) {
  return { flow: flow ?? null, steps: [], screens: [], requests: [], elapsedMs: 0, createdIds: [], sessionKey: null, url: null, handoff: null, error: null };
}

function errorResult(flow, error, startedAt = Date.now()) {
  const exitCode = error?.name === "TimeoutError" ? 3 : error?.exitCode ?? 1;
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

// Only protocol metadata and explicitly created identities enter the output.
// Pairing URLs, auth frames, message bodies and arbitrary responses stay private.
export function observeControlUiSocket(socket, getOutput, { onRequest, connecting = () => {}, connected = () => {}, disconnected = () => {} } = {}) {
  const pending = new Map();
  let retired = false;
  const finish = () => {
    retired = true;
    for (const { request, startedAt } of pending.values()) { request.status = "closed"; request.elapsedMs = Date.now() - startedAt; }
    pending.clear();
  };
  socket.on("framesent", ({ payload }) => {
    if (retired) return;
    let frame;
    try { frame = JSON.parse(String(payload)); } catch { return; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.type !== "req" || typeof frame.method !== "string") return;
    if (frame.method === "connect") connecting();
    onRequest?.(frame.method, frame.params);
    const output = typeof getOutput === "function" ? getOutput() : getOutput;
    if (!output && frame.method !== "connect") return;
    const request = { method: frame.method, status: "pending", elapsedMs: null };
    if (output) {
      if (output.requests.length >= requestLimit) { output.error = "Control UI request recording limit reached"; return; }
      output.requests.push(request);
    }
    pending.set(frame.id, { request, output, startedAt: Date.now() });
  });
  socket.on("framereceived", ({ payload }) => {
    if (retired) return;
    let frame;
    try { frame = JSON.parse(String(payload)); } catch { return; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.type !== "res") return;
    const match = pending.get(frame.id);
    if (!match) return;
    pending.delete(frame.id);
    match.request.status = frame.ok ? "result" : "error";
    if (!frame.ok) match.request.errorCode = errorCodes.has(frame.error?.code) ? frame.error.code : null;
    match.request.elapsedMs = Date.now() - match.startedAt;
    if (match.request.method === "connect") frame.ok ? connected() : disconnected();
    const { output, request } = match;
    if (!frame.ok || !output) return;
    const value = frame.payload;
    let ids = [];
    if (request.method === "sessions.create" && creationFlows.has(output.flow)) {
      ids = [value?.key, value?.sessionId, ...(value?.runStarted === true ? [value.runId] : [])];
      if (typeof value?.key === "string") output.sessionKey = value.key;
    } else if (request.method === "chat.send" && value?.status === "started" && value.replayed !== true) {
      ids = [value.runId];
      if (value.action === "start") ids.push(value.goalId, value.operationId);
    } else if (request.method === "sessions.fork" && output.flow === "fork-from-message") {
      ids = [value?.sessionKey];
      output.sessionKey = value?.sessionKey ?? null;
    } else if (request.method === "sessions.catalog.import" && output.flow === "catalog-import-row" && value?.created === true) {
      ids = [value.sessionKey]; output.sessionKey = value.sessionKey;
    } else if (request.method === "sessions.recover" && output.flow === "resume-in-new-session" && value?.ok === true) {
      // Recovery can reuse an existing successor; its response has no created
      // flag. Preserve the observed key without claiming that it is new.
      output.sessionKey = value.key ?? null;
    }
    for (const id of ids) if (typeof id === "string" && id && !output.createdIds.includes(id)) output.createdIds.push(id);
  });
  socket.on("close", () => {
    disconnected();
    finish();
  });
  return finish;
}

export async function createControlUiBrowser(options, { signal, prepare = prepareOpenClawRuntimeFromOcmEnv, ocm = runOcmJson, launch, onRequest } = {}) {
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
  const connection = new Map();
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
        connecting: () => { connection.get(target)?.finish?.(); connection.set(target, state); },
        onRequest, connected: () => { if (connection.get(target) === state) state.connected = true; },
        disconnected: () => { if (connection.get(target) === state) state.connected = false; }
      });
      sockets.add(state);
      socket.once("close", () => sockets.delete(state));
    });
  };
  try {
    budget();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(options.locale ? { locale: options.locale } : {}) });
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
        const expiry = AbortSignal.timeout(call.timeoutMs);
        const active = AbortSignal.any([expiry, ...[signal, callSignal].filter(Boolean)]);
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
          while (output.requests.some((request) => request.status === "pending")) {
            remaining(); await sleep(Math.min(25, remaining()), undefined, { signal: active });
          }
          if (output.requests.some((request) => request.status === "error")) output.error ??= "Gateway returned an error";
          if (output.error) exitCode = 1;
        } catch (error) {
          const failure = errorResult(call.flow, active.aborted ? active.reason : error, began);
          exitCode = failure.exitCode; output.error = failure.output.error;
          if (!closed && !active.aborted) await shot("error").catch(() => {});
          if (exitCode === 3) await close();
        } finally {
          active.removeEventListener("abort", abort);
          currentOutput = undefined;
          for (const request of output.requests) if (request.status === "pending") request.status = "unanswered";
          output.elapsedMs = Date.now() - began;
        }
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
  catch (error) { result = errorResult(options.flow, error, began); }
  finally { await session?.close(); }
  result.output.elapsedMs = Date.now() - began;
  return result;
}

async function runRetainedBrowser(options, context) {
  const began = Date.now();
  let session, last;
  try {
    session = await createControlUiBrowser(options, { signal: context.signal });
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
    if (context.signal.aborted && context.signal.reason?.message === "background operation stopped") return last ?? errorResult(options.flow, error);
    return errorResult(options.flow, context.signal.aborted ? context.signal.reason : error);
  } finally {
    try { await session?.close(); }
    catch { return { ...errorResult(options.flow, new CallError("Browser cleanup failed", 1)), cleanupComplete: false, cleanupError: "Browser closure was not confirmed" }; }
  }
}

export async function controlUiMain(argv, controls = {}) {
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
  } catch (error) { return errorResult(options?.flow, error); }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") await serveOperation(runRetainedBrowser);
  else {
    const result = await runWithShutdownScope((signal) => controlUiMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`); process.exitCode = result.exitCode;
  }
}
