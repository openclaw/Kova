import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import JSON5 from "json5";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { ocmInvocation, resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { conditionMain } from "./condition.mjs";

const expectedReply = "KOVA_AGENT_OK";
const prompt = `Reply with exact ASCII text ${expectedReply} only.`;

function contentText(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("") : "";
}

function historyRows(observation) {
  return observation.status === "completed" && Array.isArray(observation.result?.messages) ? observation.result.messages : [];
}

function compact(observation) {
  return { status: observation.status, elapsedMs: observation.elapsedMs, error: observation.error ?? null };
}

export function workerMockModel(config) {
  const candidates = [config.agents?.entries?.main?.model, config.agents?.defaults?.model];
  const configured = candidates.find((value) => value !== undefined);
  const model = typeof configured === "string" ? configured : configured?.primary;
  if (typeof model !== "string" || !model.includes("/")) throw new Error("worker condition requires an explicit configured model");
  if (candidates.some((value) => Array.isArray(value?.fallbacks) && value.fallbacks.length)) throw new Error("worker condition requires a model without provider fallbacks");
  const provider = model.slice(0, model.indexOf("/"));
  const selected = config.models?.providers?.[provider];
  let endpoint;
  try { endpoint = new URL(selected?.baseUrl); } catch { throw new Error("worker condition requires the local mock provider"); }
  if (provider !== "openai" || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password) throw new Error("worker condition requires the loopback OpenAI mock provider");
  return model;
}

export function workerReplyObservation(before, after) {
  const prior = before.filter((row) => row.role === "assistant");
  const current = after.filter((row) => row.role === "assistant");
  const identity = (row) => row.__openclaw?.id;
  if ([...prior, ...current].some((row) => typeof identity(row) !== "string" || !identity(row)) || new Set(current.map(identity)).size !== current.length) {
    return { assistantRows: [], assistantCount: null, expectedReplyCount: null, historyIdentityError: "assistant history rows lack unique stable message IDs" };
  }
  const beforeIds = new Set(prior.map(identity));
  const added = current.filter((row) => !beforeIds.has(identity(row)));
  const assistantRows = added.map((row) => ({ id: identity(row), runId: row.__openclaw?.runId ?? null, matchesExpected: contentText(row).trim() === expectedReply }));
  return { assistantRows, assistantCount: added.length, expectedReplyCount: assistantRows.filter((row) => row.matchesExpected).length };
}

export async function sessionWorkerCancel(ctx, dependencies = {}) {
  const { options, runtime } = ctx;
  if (resolveOcmTransport()) throw new Error("paired worker condition requires filesystem access under the selected environment owner");
  let readOperation = dependencies.readOperation;
  try { readOperation ??= (await import("./background.mjs")).readOperation; }
  catch { throw new Error("paired worker condition requires the foreground Gateway lifecycle helper"); }
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || operation.env !== options.env || operation.handle?.ref?.lifecycleState === "paused" || operation.handle?.ref?.port !== runtime.gatewayPort || operation.handle?.ref?.root !== runtime.root || !Number.isFinite(Date.parse(operation.expiresAt)) || Date.parse(operation.expiresAt) <= Date.now()) throw new Error("paired worker condition requires this clone's running foreground Gateway handle");
  try { await readFile(join(operation.directory, "result.json")); throw new Error("foreground Gateway operation has ended"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const model = workerMockModel(JSON5.parse(await readFile(await ctx.ownedPath(runtime.configPath), "utf8")));
  const state = await ctx.ownedPath(runtime.stateDir, { directory: true });
  const placementPath = await ctx.ownedPath(join(state, "state", "openclaw.sqlite"));
  const key = `agent:main:kova-worker-${randomUUID()}`;
  const nodeRoot = await mkdtemp(join(await ctx.ownedPath(runtime.root, { directory: true }), ".kova-worker-"));
  const report = { sessionKey: key, model, createdIds: [key], conditionEstablished: false, events: [], providerEntryCountsAvailable: false, deviceId: null, sessionId: null, create: null, dispatch: null, placement: null, placementError: null, ordinary: null, held: null, firstAfterAbort: null, duplicateOrdinaryReply: null, missingFirstAfterAbortReply: null, cleanupComplete: false };
  let client, child, deviceId, setupId, sessionAttempted = false;
  const runIds = new Set();
  ctx.cleanup(async () => {
    const errors = [];
    const attempt = async (operation) => { try { await operation(); } catch (error) { errors.push(error); } };
    if (client) {
      for (const runId of runIds) await attempt(() => client.request("chat.abort", { sessionKey: key, runId }, { timeoutMs: 10000 }));
      if (sessionAttempted) await attempt(() => client.request("sessions.delete", { key }, { timeoutMs: 30000 }));
    }
    let workerStopped = !child;
    if (child) await attempt(async () => { await child.stop(); workerStopped = true; });
    if (client) {
      if (!deviceId && setupId) await attempt(async () => {
        const status = await client.request("device.pair.setupStatus", { setupId }, { timeoutMs: 10000 });
        deviceId = status?.completion?.deviceId ?? status?.deliveryUncertain?.deviceId ?? status?.deviceId ?? status?.device?.deviceId;
      });
      if (deviceId) await attempt(() => client.request("device.pair.remove", { deviceId }, { timeoutMs: 10000 }));
    }
    if (workerStopped) await attempt(() => (dependencies.removeWorkerState ?? rm)(nodeRoot, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, "paired worker cleanup was incomplete");
    report.cleanupComplete = true;
  });
  try {
    client = await ctx.connect();
    const rpc = (method, params, timeoutMs = 60000) => ctx.observe(client, method, params, { timeoutMs });
    const required = async (method, params, timeoutMs = 30000) => {
      const result = await rpc(method, params, timeoutMs);
      if (result.status !== "completed") throw new Error(`${method} could not prepare the paired worker`);
      return result.result;
    };
    const streamRuns = new Set();
    const onEvent = (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      const payload = frame.payload;
      if (frame.type !== "event" || !["chat", "agent"].includes(frame.event) || payload?.sessionKey !== key) return;
      const streamed = frame.event === "agent" && payload.stream === "assistant" && typeof payload.data?.delta === "string" && payload.data.delta.length > 0 || frame.event === "chat" && payload.state === "delta" && (typeof payload.deltaText === "string" && payload.deltaText.length > 0 || contentText(payload.message).length > 0);
      if (streamed) streamRuns.add(payload.runId);
      if (report.events.length < 256) report.events.push({ event: frame.event, runId: payload.runId ?? null, state: payload.state ?? null, stream: payload.stream ?? null, phase: payload.phase ?? payload.data?.phase ?? null, streamed: Boolean(streamed) });
    };
    client.ws.addEventListener("message", onEvent);
    ctx.cleanup(() => client.ws?.removeEventListener("message", onEvent));
    const endpoint = new URL(client.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("paired worker Gateway must use a loopback address");
    endpoint.pathname = "/";
    const setup = await required("device.pair.setupCode", { publicUrl: endpoint.href, bootstrapProfile: "node", includeQr: false });
    if (typeof setup?.setupCode !== "string" || typeof setup.setupId !== "string") throw new Error("node pairing setup response is incomplete");
    setupId = setup.setupId;
    const targetFile = join(nodeRoot, "target");
    const configPath = join(nodeRoot, "openclaw.json");
    const temporaryPath = join(nodeRoot, "tmp");
    await mkdir(temporaryPath);
    await writeFile(targetFile, `${setup.setupCode}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(configPath, JSON.stringify({ logging: { file: join(nodeRoot, "node.log") } }), { flag: "wx", mode: 0o600 });
    const cleanEnvironment = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "SHELL"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
    Object.assign(cleanEnvironment, { OPENCLAW_HOME: nodeRoot, OPENCLAW_STATE_DIR: join(nodeRoot, ".openclaw"), OPENCLAW_CONFIG_PATH: configPath, TMPDIR: temporaryPath, TMP: temporaryPath, TEMP: temporaryPath, NODE_DISABLE_COMPILE_CACHE: "1" });
    const invocation = ocmInvocation(["env", "exec", options.env, "--", "env", "-i", ...Object.entries(cleanEnvironment).map(([name, value]) => `${name}=${value}`), "node", runtime.binaryPath, "connect", "--target-file", targetFile, "--session-host", "--display-name", `kova-worker-${key.split(":").at(-1)}`]);
    child = spawnOwnedProcess(invocation.file, invocation.args, { env: invocation.env, cwd: nodeRoot });
    child.child.stdout.resume();
    child.child.stderr.resume();
    let processResult;
    child.closed.then((value) => { processResult = value; });
    let node;
    const pairingDeadline = Date.now() + Math.min(90000, ctx.remaining());
    while (Date.now() < pairingDeadline) {
      ctx.signal.throwIfAborted();
      const status = await required("device.pair.setupStatus", { setupId: setup.setupId }, 10000);
      deviceId = status?.completion?.deviceId ?? status?.deliveryUncertain?.deviceId ?? status?.deviceId ?? status?.device?.deviceId ?? deviceId;
      if (deviceId) {
        const listed = await required("node.list", {}, 10000);
        node = listed?.nodes?.find((candidate) => candidate.nodeId === deviceId);
        if (node?.connected && node.sessionHost && node.paired && node.approvalState === "approved") break;
        const pending = await required("node.pair.list", {}, 10000);
        const match = pending?.pending?.find((candidate) => candidate.nodeId === deviceId);
        if (match) await required("node.pair.approve", { requestId: match.requestId }, 10000);
      }
      if (processResult) throw new Error("paired node process exited during setup");
      await sleep(250, undefined, { signal: ctx.signal });
    }
    if (!node?.connected || !node.sessionHost || !node.paired || node.approvalState !== "approved") throw new Error("paired session host did not connect");
    report.deviceId = deviceId;
    report.createdIds.push(deviceId);
    sessionAttempted = true;
    const created = await rpc("sessions.create", { key, agentRuntime: "openclaw", model, worktree: true, worktreeSource: "empty" });
    report.create = compact(created);
    if (created.status !== "completed") return report;
    const dispatched = await rpc("sessions.dispatch", { key, deviceId }, 120000);
    report.dispatch = compact(dispatched);
    if (dispatched.status !== "completed") return report;
    const sessionId = dispatched.result?.sessionId;
    if (typeof sessionId !== "string") { report.dispatch.missingSessionId = true; return report; }
    report.sessionId = sessionId;
    report.createdIds.push(sessionId);
    const placementDb = new DatabaseSync(placementPath, { readOnly: true });
    try {
      const deadline = Date.now() + Math.min(30000, ctx.remaining());
      while (Date.now() < deadline) {
        const placement = placementDb.prepare("SELECT state, execution_mode, environment_id FROM worker_session_placements WHERE session_id = ?").get(sessionId);
        report.placement = placement ? { state: placement.state, executionMode: placement.execution_mode, environmentId: placement.environment_id } : null;
        if (placement?.state === "active" && placement.execution_mode === "worker-turn") break;
        await sleep(250, undefined, { signal: ctx.signal });
      }
    } finally { placementDb.close(); }
    if (report.placement?.state !== "active" || report.placement.executionMode !== "worker-turn") { report.placementError = "native worker-turn placement was not active"; return report; }
    if (typeof report.placement.environmentId === "string") report.createdIds.push(report.placement.environmentId);
    const observeTurn = async () => {
      const before = await rpc("chat.history", { sessionKey: key, limit: 100 });
      if (before.status !== "completed") return { historyBefore: compact(before) };
      const send = await rpc("chat.send", { sessionKey: key, message: prompt, idempotencyKey: randomUUID() });
      const result = { send: compact(send), runId: send.result?.runId ?? null };
      if (send.status !== "completed" || typeof result.runId !== "string") return result;
      runIds.add(result.runId);
      report.createdIds.push(result.runId);
      const completion = await rpc("agent.wait", { runId: result.runId, timeoutMs: 60000 }, 65000);
      result.completion = { ...compact(completion), terminalStatus: completion.result?.status ?? null };
      const history = await rpc("chat.history", { sessionKey: key, limit: 100 });
      result.history = compact(history);
      if (history.status === "completed") {
        Object.assign(result, workerReplyObservation(historyRows(before), historyRows(history)));
        for (const row of result.assistantRows) if (typeof row.id === "string") report.createdIds.push(row.id);
      }
      return result;
    };
    report.ordinary = await observeTurn();
    report.duplicateOrdinaryReply = report.ordinary.expectedReplyCount == null ? null : report.ordinary.expectedReplyCount > 1;
    if (report.ordinary.completion?.terminalStatus !== "ok" || report.ordinary.history?.status !== "completed") return report;
    const held = await rpc("chat.send", { sessionKey: key, message: 'KOVA_VERIFY_HOLD {"holdMs":300000,"progressCards":false}', idempotencyKey: randomUUID() });
    const heldRunId = held.result?.runId;
    report.held = { send: compact(held), runId: heldRunId ?? null, streamObserved: false };
    if (held.status !== "completed" || typeof heldRunId !== "string") return report;
    report.createdIds.push(heldRunId);
    runIds.add(heldRunId);
    const streamDeadline = Date.now() + Math.min(30000, ctx.remaining());
    while (!streamRuns.has(heldRunId) && Date.now() < streamDeadline) await sleep(50, undefined, { signal: ctx.signal });
    report.held.streamObserved = streamRuns.has(heldRunId);
    if (!report.held.streamObserved) return report;
    const active = await rpc("sessions.describe", { key });
    const row = active.result?.session;
    const activeHistory = await rpc("chat.history", { sessionKey: key, limit: 1 });
    report.held.active = { describe: compact(active), history: compact(activeHistory), exactRun: active.status === "completed" && row?.key === key && row.sessionId === sessionId && row.hasActiveRun === true && row.status === "running" && (Array.isArray(row.activeRunIds) ? row.activeRunIds.includes(heldRunId) : activeHistory.status === "completed" && activeHistory.result?.inFlightRun?.runId === heldRunId) };
    if (!report.held.active.exactRun) return report;
    const cancelled = await rpc("chat.abort", { sessionKey: key, runId: heldRunId });
    report.held.cancel = compact(cancelled);
    if (cancelled.status !== "completed") return report;
    const settled = await rpc("agent.wait", { runId: heldRunId, timeoutMs: 30000 }, 35000);
    report.held.completion = { ...compact(settled), terminalStatus: settled.result?.status ?? null };
    if (settled.status !== "completed" || !["ok", "error", "aborted", "cancelled"].includes(settled.result?.status)) return report;
    report.firstAfterAbort = await observeTurn();
    report.conditionEstablished = true;
    report.missingFirstAfterAbortReply = report.firstAfterAbort.assistantCount == null ? null : report.firstAfterAbort.completion?.terminalStatus === "ok" && report.firstAfterAbort.history?.status === "completed" && report.firstAfterAbort.assistantCount === 0;
    report.createdIds = [...new Set(report.createdIds)];
    return report;
  } catch (error) {
    error.output = report;
    throw error;
  }
}

await conditionMain(import.meta.url, { id: "session-worker-cancel", flags: ["gateway-handle"], required: ["gateway-handle"], cleanupMs: 90000, timeoutMs: 480000 }, sessionWorkerCancel);
