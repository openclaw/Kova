import { dirname, isAbsolute, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectOpenClawFileRuntime, openDirectGatewayRpcClient, prepareOpenClawRuntimeFromOcmEnv, readOpenClawGatewayConfiguration } from "../openclaw-runtime.mjs";
import { runWithShutdownScope } from "../../src/commands.mjs";
import { createStateFileIdentityResolver, createStateTextPolicy, inventoryConfigurationFiles, mergeStateTextPolicies, projectStateLogBytes, redactStateText, validateStateTextPolicy } from "../../src/verify/checkpoint.mjs";
import { abortable, CallError, failure, joinOperation, parseFlags, positiveMs, readJson, readOperation, serveOperation, startOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";
import { requestGatewayLifecycle } from "./gateway-fixture-client.mjs";
import { validateProfileCall } from "./gateway-profile.mjs";

const filename = fileURLToPath(import.meta.url);
const allowed = ["env", "method", "params", "timeout", "out", "session-from", "merge-from", "after-ms", "from", "background", "handle", "wait", "persona-profile", "gateway-handle", "expect-involved-key", "expect-excluded-key"];
const fromMethods = new Set(["sessions.patchMany", "sessions.processes.stop", "sessions.search", "sessions.setInvolvement"]);
// Single-session selectors from the Gateway schemas at catalogue revision
// 7e80556f. Collection, catalog and creation-preparation methods use --params.
const keyMethods = new Set([
  "sessions.create", "sessions.describe", "sessions.get", "sessions.send", "sessions.abort",
  "sessions.patch", "sessions.delete", "sessions.reset", "sessions.assignOwner", "sessions.setInvolvement",
  "sessions.compact", "sessions.recover", "sessions.resolve", "sessions.messages.subscribe",
  "sessions.messages.unsubscribe", "sessions.files.reveal", "sessions.processes.list", "sessions.processes.stop"
]);
const sessionKeyMethods = new Set([
  "chat.send", "chat.abort", "chat.history", "chat.inject", "chat.message.get", "chat.metadata", "chat.startup",
  "progressCard.get", "progressCard.put", "progressCard.refresh",
  "session.visibility.set", "session.publicShare.set", "session.members.list", "session.members.listEvidence", "session.members.add", "session.members.remove",
  "session.suggestions.add", "session.suggestions.list", "session.suggestions.resolve",
  "sessions.branches.list", "sessions.branches.switch", "sessions.fork", "sessions.rewind", "sessions.diff",
  "sessions.files.list", "sessions.files.get", "sessions.files.set", "sessions.files.assets",
  "sessions.companion.ask", "sessions.companion.state", "sessions.companion.reset",
  "sessions.github.options", "sessions.github.status"
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallError(`${label} must be a JSON object`);
  return value;
}

function text(value) { return typeof value === "string" && value.length > 0; }

function creationFields(method, params = {}, result) {
  if (method === "sessions.create") {
    const ids = Object.hasOwn(params, "key") ? [] : [result?.key, result?.sessionId];
    if (result?.runStarted === true) ids.push(result.runId);
    return { createdIds: ids.filter(text) };
  }
  if (method === "sessions.catalog.import") return { createdIds: result?.created === true && text(result.sessionKey) ? [result.sessionKey] : [] };
  return {};
}

const publicSharingMethods = new Set(["session.publicShare.set", "session.members.list", "session.members.listEvidence"]);
const fileMethods = new Set(["sessions.files.get", "sessions.files.set", "sessions.files.list", "sessions.files.assets"]);

function hasFileContent(method, result) {
  return fileMethods.has(method) && [result?.file, ...(Array.isArray(result?.files) ? result.files : []), ...(Array.isArray(result?.assets) ? result.assets : [])].some((file) => file && Object.hasOwn(file, "content"));
}

function inheritedFilePolicies(runtime) {
  const inherited = process.env.KOVA_VERIFY_STATE_POLICIES_JSON;
  if (!inherited) return undefined;
  const policies = JSON.parse(inherited), policy = policies[runtime.envName];
  if (!policy) throw new CallError("file capture has no declarations for the selected environment", 1);
  const paths = validateStateTextPolicy(policy);
  if (!paths.roots.includes(resolve(runtime.stateDir ?? join(runtime.root, ".openclaw")))) throw new CallError("file capture declarations do not match the selected state directory", 1);
  // Admission permits reads in every copy owned by this run, including a
  // companion used as the calling session's cwd. Keep that same policy scope.
  return Object.fromEntries(Object.entries(policies).map(([env, policy]) => [env, validateStateTextPolicy(policy)]));
}

function operationFilePolicy(operation, capture) {
  if (!capture) return undefined;
  if (capture.operationId !== operation.id || capture.env !== operation.env) throw new CallError("credential path declarations do not match their background operation", 1);
  return validateStateTextPolicy(capture.paths);
}

async function fileStatePolicy(runtime, readGatewayConfiguration, timeoutMs, readFilePolicy, inspectFileRuntime = inspectOpenClawFileRuntime) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    if (Date.now() >= deadline) throw new CallError("Gateway call timeout", 3);
    return Math.max(1, deadline - Date.now());
  };
  const inherited = inheritedFilePolicies(runtime) ?? {}, current = [];
  for (const env of new Set([runtime.envName, ...Object.keys(inherited)])) {
    const selected = env === runtime.envName ? runtime : await inspectFileRuntime(env, { timeoutMs: remaining() });
    const stateDirectory = selected.stateDir ?? join(selected.root, ".openclaw");
    if (selected.envName !== env || inherited[env] && !inherited[env].roots.includes(resolve(stateDirectory))) throw new CallError("file capture declarations do not match a readable environment", 1);
    const gateway = await readGatewayConfiguration(selected, { timeoutMs: remaining() });
    let configurations = [];
    try { if (selected.configPath) configurations = (await inventoryConfigurationFiles(selected.configPath)).declarations; }
    catch { throw new CallError("cannot read the selected configuration path declarations", 1); }
    current.push(await createStateTextPolicy({ stateDirectory, homeDirectory: selected.root, cwd: selected.runDir ?? selected.packageRoot, gateway, configurations }));
  }
  remaining();
  // A companion may commit a new declaration before the run owner observes
  // the completed mutation. Refresh every readable copy, then read history last.
  return mergeStateTextPolicies(...Object.values(inherited), ...current, await readFilePolicy?.(runtime));
}

async function recordedFile(file, root, requestedPath, policy, deadlineMs, projectedPolicy, identities) {
  if (!file || typeof file !== "object" || !Object.hasOwn(file, "content")) return file;
  if (typeof file.content !== "string") throw new CallError("invalid file content response", 1);
  const paths = [file.workspacePath, file.path, requestedPath].filter((path) => typeof path === "string");
  if (typeof root === "string") paths.push(...paths.filter((path) => !isAbsolute(path)).map((path) => resolve(root, path)));
  await identities?.resolve(paths);
  const encoding = file.contentEncoding ?? "utf8";
  const bytes = encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content);
  const logBytes = projectStateLogBytes(paths, bytes, policy, { deadlineMs, projectedPolicy });
  const content = redactStateText(paths, logBytes ?? bytes, policy);
  if (content === null && logBytes === null) return file;
  if (!["utf8", "base64"].includes(encoding) || encoding === "base64" && bytes.toString("base64") !== file.content) throw new CallError("invalid credential file encoding", 1);
  return { ...file, content: (content === null ? logBytes : Buffer.from(content)).toString(encoding) };
}

function relativeAssetPath(ref) {
  if (typeof ref !== "string" || !ref.trim() || ref.trim().startsWith("#")) return undefined;
  let path;
  try { path = decodeURIComponent(ref.trim().split(/[?#]/, 1)[0]).replaceAll("\\", "/"); }
  catch { return undefined; }
  if (!path || path.startsWith("/") || path.startsWith("~") || path.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(path)) return undefined;
  return path;
}

async function prepareAssetPaths(params) {
  const paths = new Map();
  for (const ref of params.refs ?? []) {
    const relativePath = relativeAssetPath(ref);
    if (!relativePath) continue;
    if (!isAbsolute(params.path ?? "")) throw new CallError("asset capture requires an absolute document path", 1);
    const path = resolve(dirname(params.path), relativePath);
    let actual;
    try { actual = await realpath(path); }
    catch (error) { if (error.code !== "ENOENT") throw new CallError("cannot establish asset file identity", 1); }
    paths.set(ref, { path, actual });
  }
  return paths;
}

async function captureAssetPaths(assets, before) {
  return Promise.all(assets.map(async (asset) => {
    if (!asset || !Object.hasOwn(asset, "content")) return null;
    const selected = before.get(asset.ref);
    if (!selected) throw new CallError("asset response has no admitted file identity", 1);
    let actual;
    try { actual = await realpath(selected.path); }
    catch { throw new CallError("cannot establish asset file identity", 1); }
    if (selected.actual && selected.actual !== actual) throw new CallError("asset file identity changed during its read", 1);
    return { ref: asset.ref, paths: [...new Set([selected.path, actual])] };
  }));
}

async function requestGatewayResult(client, method, params, remaining) {
  let beforeAssets;
  if (method === "sessions.files.assets") {
    let document = params.path;
    const hasReadableRef = (params.refs ?? []).some((ref) => relativeAssetPath(ref) !== undefined);
    if (hasReadableRef && !isAbsolute(document ?? "")) {
      // This file-route metadata uses the same workspace root as asset reads.
      // The original document need not exist, so a document get is insufficient.
      const metadata = await client.request("sessions.files.list", { sessionKey: params.sessionKey, ...(params.agentId ? { agentId: params.agentId } : {}) }, { timeoutMs: remaining() });
      if (!isAbsolute(metadata?.root ?? "")) throw new CallError("asset capture requires an authoritative local workspace root", 1);
      document = resolve(metadata.root, document);
      // Bind the actual read to this root too; a later session cwd change must
      // not make the returned bytes belong to a different document directory.
      params = { ...params, path: document };
    }
    beforeAssets = hasReadableRef ? await prepareAssetPaths({ ...params, path: document }) : new Map();
  }
  const result = await client.request(method, params, { timeoutMs: remaining() });
  const assetPaths = beforeAssets && Array.isArray(result?.assets) ? await captureAssetPaths(result.assets, beforeAssets) : undefined;
  return { result, assetPaths };
}

async function recordedAsset(asset, identity, policy, deadlineMs, projectedPolicy, identities) {
  if (!asset || !Object.hasOwn(asset, "content")) return asset;
  if (!identity || identity.ref !== asset.ref || !Array.isArray(identity.paths) || !identity.paths.length || identity.paths.some((path) => typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))) throw new CallError("asset response has no retained file identity", 1);
  if (typeof asset.content !== "string") throw new CallError("invalid asset content response", 1);
  const bytes = Buffer.from(asset.content, "base64");
  if (bytes.toString("base64") !== asset.content) throw new CallError("invalid asset content encoding", 1);
  await identities?.resolve(identity.paths);
  const logBytes = projectStateLogBytes(identity.paths, bytes, policy, { deadlineMs, projectedPolicy });
  const content = redactStateText(identity.paths, logBytes ?? bytes, policy);
  return content === null && logBytes === null ? asset : { ...asset, content: (content === null ? logBytes : Buffer.from(content)).toString("base64") };
}

async function recordedResult(method, result, params = {}, policy, assetPaths, deadlineMs, projectedPolicy, identities) {
  if (method === "attach.grant" && result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, ...(Object.hasOwn(result, "token") ? { token: "" } : {}),
      ...(result.env && typeof result.env === "object" && !Array.isArray(result.env) ? { env: { ...result.env, ...(Object.hasOwn(result.env, "OPENCLAW_MCP_TOKEN") ? { OPENCLAW_MCP_TOKEN: "" } : {}) } } : {})
    };
  }
  if (fileMethods.has(method) && result && typeof result === "object" && !Array.isArray(result)) {
    const recorded = { ...result };
    if (Object.hasOwn(result, "file")) recorded.file = await recordedFile(result.file, result.root, params.path, policy, deadlineMs, projectedPolicy, identities);
    if (Array.isArray(result.files)) {
      recorded.files = [];
      for (const file of result.files) recorded.files.push(await recordedFile(file, result.root, undefined, policy, deadlineMs, projectedPolicy, identities));
    }
    if (method === "sessions.files.assets" && Array.isArray(result.assets)) {
      recorded.assets = [];
      for (const [index, asset] of result.assets.entries()) recorded.assets.push(await recordedAsset(asset, assetPaths?.[index], policy, deadlineMs, projectedPolicy, identities));
    }
    return recorded;
  }
  if (!publicSharingMethods.has(method) || !result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "publicShare")) return result;
  const share = result.publicShare;
  if (!share || typeof share !== "object" || Array.isArray(share)) throw new CallError("invalid public sharing response", 1);
  return { ...result, publicShare: { ...share, ...(Object.hasOwn(share, "token") ? { token: "" } : {}) } };
}

function payload(value) {
  object(value, "input file");
  if (Object.hasOwn(value, "error") && value.error !== null) throw new CallError("input file contains an error");
  return Object.hasOwn(value, "result") ? object(value.result, "input result") : value;
}

function mergeSessionDescription(method, params, description) {
  const session = object(description.session, "--merge-from sessions.describe session");
  if (!text(session.key) || !text(session.sessionId)) throw new CallError("--merge-from requires a described session key and sessionId");
  const identity = { key: session.key, expectedSessionId: session.sessionId };
  if (session.agentId !== undefined) {
    if (!text(session.agentId)) throw new CallError("--merge-from contains an invalid session agentId");
    identity.agentId = session.agentId;
  }
  if (method === "sessions.patch" && session.lifecycleRevision !== undefined) {
    if (!text(session.lifecycleRevision)) throw new CallError("--merge-from contains an invalid session lifecycleRevision");
    identity.expectedLifecycleRevision = session.lifecycleRevision;
  }
  for (const field of ["key", "agentId", "expectedSessionId", "expectedLifecycleRevision"]) {
    if (params[field] !== undefined && params[field] !== identity[field]) throw new CallError(`--merge-from conflicts with ${field}`);
  }
  return { ...params, ...identity };
}

export function parseGatewayCallArgs(argv) {
  const options = parseFlags(argv, ["background"]);
  for (const name of Object.keys(options)) if (!allowed.includes(name)) throw new CallError(`unknown flag: --${name}`);
  options.timeoutMs = positiveMs(options.timeout, 120000);
  options.afterMs = options["after-ms"] === undefined ? 0 : Number(options["after-ms"]);
  if (!Number.isSafeInteger(options.afterMs) || options.afterMs < 0 || options.afterMs > 2147483647 - options.timeoutMs) throw new CallError("--after-ms must be a nonnegative number of milliseconds within the timer range");
  if (options.wait) {
    for (const name of ["params", "session-from", "merge-from", "after-ms", "from", "background", "handle", "persona-profile", "gateway-handle", "expect-involved-key", "expect-excluded-key"]) {
      if (options[name] !== undefined) throw new CallError(`--wait cannot be combined with --${name}`);
    }
  } else {
    if (!text(options.env) || !text(options.method)) throw new CallError("--env and --method are required");
    if (Boolean(options.background) !== Boolean(options.handle)) throw new CallError("--background and --handle are required together");
    try { options.params = object(JSON.parse(options.params ?? "{}"), "--params"); }
    catch (error) { throw new CallError(error.message); }
    if (options.from && !fromMethods.has(options.method)) throw new CallError("--from is unsupported for this method");
    validateProfileCall(options);
  }
  for (const key of ["wait", "handle", "out", "session-from", "merge-from", "from", "gateway-handle"]) if (options[key]) options[key] = resolve(options[key]);
  return options;
}

export async function resolveGatewayParams(options, { signal } = {}) {
  let params = { ...options.params };
  let description;
  if (options["merge-from"]) {
    const record = await readJson(options["merge-from"], { signal });
    const source = payload(record);
    if (record.method === "sessions.describe" && ["sessions.patch", "sessions.reset"].includes(options.method)) description = source;
    else params = { ...source, ...params };
  }
  if (options["session-from"]) {
    const source = payload(await readJson(options["session-from"], { signal }));
    const keys = [...new Set([source.key, source.sessionKey, source.session?.key, source.session?.sessionKey].filter(text))];
    if (keys.length !== 1) throw new CallError("--session-from requires exactly one session key");
    const field = keyMethods.has(options.method) ? "key" : sessionKeyMethods.has(options.method) ? "sessionKey" : null;
    if (!field) throw new CallError("--session-from has no single-session selector for this method; use --params");
    if (params[field] !== undefined && params[field] !== keys[0]) throw new CallError("--session-from conflicts with --params");
    params[field] = keys[0];
  }
  if (description) params = mergeSessionDescription(options.method, params, description);
  if (options.from) {
    const record = await readJson(options.from, { signal });
    const source = payload(record);
    if (fromMethods.has(options.method) && options.method !== "sessions.setInvolvement" && (record.error !== null || !Object.hasOwn(record, "result"))) throw new CallError("--from requires an error-free Gateway result");
    if (options.method === "sessions.processes.stop") {
      if (record.method !== "sessions.processes.list" || !text(params.sessionId) || source.sessionId !== params.sessionId) throw new CallError("--from does not identify this session");
      if (Object.hasOwn(params, "processId") || Object.hasOwn(params, "instanceId")) throw new CallError("--from refuses prefilled processId or instanceId");
      if (source.truncated !== false) throw new CallError("--from requires a non-truncated process list");
      const matches = Array.isArray(source.processes) ? source.processes.filter((row) => row?.status === "running" && row.canStop === true) : [];
      if (matches.length !== 1 || !text(matches[0].processId) || !text(matches[0].instanceId)) throw new CallError("--from requires exactly one process with status running and canStop true, including processId and instanceId");
      params.processId = matches[0].processId;
      params.instanceId = matches[0].instanceId;
    } else if (options.method === "sessions.patchMany") {
      const session = source.session;
      if (record.method !== "sessions.describe" || !text(session?.key) || !text(session?.sessionId)) throw new CallError("--from requires a described session key and sessionId");
      const matches = Array.isArray(params.targets) ? params.targets.filter((target) => target?.key === session.key) : [];
      if (matches.length !== 1) throw new CallError("--from requires exactly one matching target");
      const target = matches[0];
      if (target.expectedSessionId !== undefined && target.expectedSessionId !== session.sessionId) throw new CallError("--from conflicts with expectedSessionId");
      if (target.agentId !== undefined && target.agentId !== session.agentId) throw new CallError("--from conflicts with agentId");
      params.targets = params.targets.map((row) => row === target ? { ...row, expectedSessionId: session.sessionId } : row);
    } else if (options.method === "sessions.search") {
      if (!["sessions.create", "sessions.catalog.import"].includes(record.method)) throw new CallError("--from requires a sessions.create or sessions.catalog.import result");
      const keys = [...new Set([source.key, source.sessionKey].filter(text))];
      if (keys.length !== 1) throw new CallError("--from requires exactly one session key");
      if (Object.hasOwn(params, "scope")) throw new CallError("--from cannot be combined with scope");
      if (Object.hasOwn(params, "key") || Object.hasOwn(params, "sessionKey") || (params.sessionKeys !== undefined && (!Array.isArray(params.sessionKeys) || params.sessionKeys.length !== 1 || params.sessionKeys[0] !== keys[0]))) throw new CallError("--from conflicts with session selectors");
      params.sessionKeys = keys;
    } else if (options.method === "sessions.setInvolvement") {
      const key = source.key ?? source.session?.key;
      if (record.method !== "sessions.describe" || !text(params.key) || key !== params.key || !text(source.session?.sessionId)) throw new CallError("--from does not describe this session");
      if (params.expectedSessionId !== undefined && params.expectedSessionId !== source.session.sessionId) throw new CallError("--from conflicts with expectedSessionId");
      params.expectedSessionId = source.session.sessionId;
    } else throw new CallError("--from is unsupported for this method");
  }
  return params;
}

async function isolatedGatewayRequest(runtime, method, params, timeoutMs, signal) {
  signal.throwIfAborted();
  // Native WebSocket close is a handshake, so an uncooperative peer can keep
  // its thread alive. Termination joins all connection resources on every exit.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: "gateway-request", runtime, method, params, timeoutMs }, execArgv: []
  });
  try {
    const completed = new Promise((resolve, reject) => {
      worker.once("message", (message) => message.ok ? resolve(message.result) : reject(new Error(message.error)));
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Gateway request worker exited before its result (${code})`)));
    });
    return await abortable(completed, signal);
  } finally { await worker.terminate(); }
}

export async function executeGatewayCall(options, { signal, prepare = prepareOpenClawRuntimeFromOcmEnv, connect, readGatewayConfiguration = readOpenClawGatewayConfiguration, inspectFileRuntime = inspectOpenClawFileRuntime, captureFilePolicy, readFilePolicy, observeResult, requestLifecycle = requestGatewayLifecycle } = {}) {
  const startedAt = Date.now();
  let client;
  let deadlineSignal;
  let deadline;
  try {
    if (options.afterMs) await sleep(options.afterMs, undefined, { signal });
    deadline = Date.now() + options.timeoutMs;
    deadlineSignal = AbortSignal.timeout(options.timeoutMs);
    const activeSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    let params;
    try { params = await resolveGatewayParams(options, { signal: activeSignal }); } catch (error) { throw new CallError(error.message); }
    const remaining = () => {
      activeSignal.throwIfAborted();
      if (Date.now() >= deadline) throw new CallError("Gateway call timeout", 3);
      return Math.max(1, deadline - Date.now());
    };
    validateProfileCall({ ...options, params });
    if (options["persona-profile"]) {
      return await requestLifecycle({ ...options, params, operation: "profile-call", timeoutMs: remaining() }, { signal: activeSignal });
    }
    const runtime = prepare(options.env, { timeoutMs: remaining() });
    let result, assetPaths;
    if (connect) {
      const opening = connect(runtime, { timeoutMs: remaining(), authFromRuntimeConfig: true });
      opening.then((connection) => { if (activeSignal.aborted) connection.client.close(); }, () => {});
      ({ client } = await abortable(opening, activeSignal));
      ({ result, assetPaths } = await abortable(requestGatewayResult(client, options.method, params, remaining), activeSignal, () => client.close()));
    } else ({ result, assetPaths } = await isolatedGatewayRequest(runtime, options.method, params, remaining(), activeSignal));
    const policy = hasFileContent(options.method, result) ? await abortable(fileStatePolicy(runtime, readGatewayConfiguration, remaining(), readFilePolicy, inspectFileRuntime), activeSignal) : undefined;
    remaining();
    const identities = policy ? createStateFileIdentityResolver(policy, { deadlineMs: deadline }) : undefined;
    const recorded = await abortable(recordedResult(options.method, result ?? null, params, identities?.policy, assetPaths, deadline, undefined, identities), activeSignal);
    remaining();
    if (identities) captureFilePolicy?.(identities.policy, assetPaths);
    // Internal consumers may use the live response; persisted output stays projected.
    observeResult?.(result);
    return { output: { method: options.method, result: recorded, error: null, elapsedMs: Date.now() - startedAt, ...creationFields(options.method, params, result) }, exitCode: 0 };
  } catch (error) {
    const timedOut = deadlineSignal?.aborted || (deadline !== undefined && Date.now() >= deadline) || /^gateway direct RPC (connect|request) timeout /i.test(error?.message ?? "");
    const result = failure(options.method, timedOut ? new CallError("Gateway call timeout", 3) : signal?.aborted ? signal.reason : error, startedAt);
    if (options["persona-profile"] && error?.operationResult?.output) {
      for (const field of ["personaProfile", "authenticationRestored", "involvement"]) {
        if (Object.hasOwn(error.operationResult.output, field)) result.output[field] = error.operationResult.output[field];
      }
    }
    Object.assign(result.output, creationFields(options.method));
    return result;
  } finally { client?.close(); }
}

export async function gatewayCallMain(argv, { signal, prepare = prepareOpenClawRuntimeFromOcmEnv, readGatewayConfiguration = readOpenClawGatewayConfiguration, inspectFileRuntime = inspectOpenClawFileRuntime } = {}) {
  let options;
  let result;
  let waitDeadline, waitDeadlineSignal;
  try {
    options = parseGatewayCallArgs(argv);
    if (options.out) options.out = await validateGatewayOutput(options);
    if (options.wait) {
      const deadline = waitDeadline = Date.now() + options.timeoutMs;
      waitDeadlineSignal = AbortSignal.timeout(options.timeoutMs);
      const activeSignal = signal ? AbortSignal.any([signal, waitDeadlineSignal]) : waitDeadlineSignal;
      const remaining = () => {
        activeSignal.throwIfAborted();
        if (Date.now() >= deadline) throw new CallError("Gateway call timeout", 3);
        return Math.max(1, deadline - Date.now());
      };
      result = await abortable(joinOperation(options.wait, { timeoutMs: remaining(), method: options.method, env: options.env, signal: activeSignal }), activeSignal);
      let policy, projectedPolicy, identities;
      if (hasFileContent(result.output.method, result.output.result)) {
        const operation = await abortable(readOperation(options.wait), activeSignal);
        if (result.output.method === "sessions.files.assets" && !result.fileCapture?.assets) throw new CallError("asset result has no retained file identities", 1);
        if (result.fileCapture) {
          const retained = operationFilePolicy(operation, result.fileCapture);
          policy = mergeStateTextPolicies(retained, operationFilePolicy(operation, operation.fileCapture));
          if (result.exitCode === 0 && result.output.error === null) projectedPolicy = retained;
        } else policy = await abortable(fileStatePolicy(prepare(operation.env, { timeoutMs: remaining() }), readGatewayConfiguration, remaining(), undefined, inspectFileRuntime), activeSignal);
        // Older results have no proof that case-equivalent candidates were
        // checked. Revalidate those candidates while their files still exist;
        // missing or unreadable observed files fail instead of leaking bytes.
        if (!projectedPolicy || !Object.hasOwn(result.fileCapture.paths, "aliases")) {
          identities = createStateFileIdentityResolver(policy, { deadlineMs: deadline });
          policy = identities.policy;
        }
      }
      remaining();
      const recorded = await abortable(recordedResult(result.output.method, result.output.result, {}, policy, result.fileCapture?.assets, deadline, projectedPolicy, identities), activeSignal);
      remaining();
      result = { ...result, output: { ...result.output, result: recorded } };
    }
    else if (options.background) {
      const handle = await startOperation(filename, options, {
        entry: `gateway-${options.method.replaceAll(".", "-").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
        method: options.method, lifetimeMs: options.afterMs + options.timeoutMs + 1000, signal
      });
      return { output: handle, exitCode: 0 };
    } else result = await executeGatewayCall(options, { signal, prepare, readGatewayConfiguration, inspectFileRuntime });
    if (options.out) await writeGatewayOutput(options, result.output);
    return result;
  } catch (error) {
    const timedOut = waitDeadlineSignal?.aborted || (waitDeadline !== undefined && Date.now() >= waitDeadline);
    return failure(options?.method, timedOut ? new CallError("Gateway call timeout", 3) : signal?.aborted ? signal.reason : error);
  }
}

if (!isMainThread && workerData?.kind === "gateway-request") {
  let client;
  try {
    const { runtime, method, params, timeoutMs } = workerData;
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      if (Date.now() >= deadline) throw new CallError("Gateway call timeout", 3);
      return Math.max(1, deadline - Date.now());
    };
    ({ client } = await openDirectGatewayRpcClient(runtime, { timeoutMs, authFromRuntimeConfig: true }));
    parentPort.postMessage({ ok: true, result: await requestGatewayResult(client, method, params, remaining) });
  } catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
  finally { client?.close(); }
} else if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--worker") {
    await serveOperation(async (options, context) => {
      await context.publish({ method: options.method, pid: process.pid });
      let paths, assets;
      const result = await executeGatewayCall(options, {
        signal: context.signal, captureFilePolicy: (policy, identities) => { paths = policy; assets = identities; },
        readFilePolicy: async (runtime) => {
          const operation = await readOperation(context.operation.handlePath);
          if (operation.env !== runtime.envName) throw new CallError("file operation environment changed", 1);
          return operationFilePolicy(operation, operation.fileCapture);
        }
      });
      if (options.out) await writeGatewayOutput(options, result.output);
      return paths ? { ...result, fileCapture: { operationId: context.operation.id, env: options.env, paths, ...(assets ? { assets } : {}) } } : result;
    });
  } else {
    const result = await runWithShutdownScope((signal) => gatewayCallMain(process.argv.slice(2), { signal }));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  }
}
