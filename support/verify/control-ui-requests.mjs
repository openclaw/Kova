const creationFlows = new Set(["new-session-page", "new-session-incognito", "palette-background-session", "palette-background-start"]);
const requestLimit = 20000;
const errorCodes = new Set(["NOT_LINKED", "NOT_PAIRED", "AGENT_TIMEOUT", "INVALID_REQUEST", "FORBIDDEN", "APPROVAL_NOT_FOUND", "UNAVAILABLE"]);
const privateFields = /auth|token|secret|password|credential|cookie|signature|nonce|ticket|capability|url|uri/i;
const privateBodies = new Set(["raw", "body", "content", "contents", "text", "message", "messages", "prompt", "query", "title", "label", "name", "description", "attachments", "toolBindings", "data", "config", "patch", "prefs", "settings", "value", "values"]);
const identifierFields = new Set(["key", "id", "sessionKey", "sessionKeys", "refreshSessionKeys", "sessionId", "expectedSessionId", "parentSessionKey", "agentId", "runId", "goalId", "operationId", "instanceId", "requestId", "identityId", "ownerIdentityId", "groupId", "groupIds", "nodeId", "pluginId", "serverName", "resourceId", "channelId", "peerId", "model", "modelId", "provider", "providerId", "mode", "role", "roles", "scope", "scopes", "state", "status", "action", "sort", "sortBy", "sortDir", "direction", "kind", "kinds", "category", "categories", "view", "filter", "cursor", "locale", "timeZone", "thinkingLevel", "reasoningLevel", "effort", "color", "visibility", "leafEntryId", "branchId", "baseHash"]);
const redacted = "[redacted]";

// Preserve structure and non-content selectors. Arbitrary strings, bodies,
// authentication proofs and capability URLs are never evidence-file contents.
export function redactControlUiParams(params) {
  let nodes = 0;
  const visit = (value, key, depth) => {
    if (++nodes > 2000 || depth > 12 || privateFields.test(key) || privateBodies.has(key)) return redacted;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (!identifierFields.has(key) || value.length > 1024 || /:\/\/|^(?:data:|file:|bearer\s|sk-|gh[pousr]_)/i.test(value)) return redacted;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, key, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 2000).map(([name, item]) => [name.length > 128 ? "[redacted key]" : name, visit(item, name, depth + 1)]));
    return null;
  };
  const result = visit(params, "", 0);
  return JSON.stringify(result).length > 65536 ? "[redacted oversized parameters]" : result;
}

function notifyRequest(callback, args, record, output, pendingAudits, metadata = {}) {
  if (!callback) return;
  const failed = () => {
    record.validation ??= { status: "invalid", code: "OBSERVER_FAILED" };
    if (output) output.error ??= "Control UI request validation failed";
  };
  const completed = () => {
    if (["invalid", "unmapped"].includes(record.validation?.status) && output) output.error ??= "Control UI request validation failed";
  };
  try {
    const result = callback(...args, { ...metadata, flow: output?.flow ?? null, record });
    if (result && typeof result.then === "function") {
      const task = Promise.resolve(result).then(completed, failed).finally(() => pendingAudits?.delete(task));
      task.request = record;
      task.output = output;
      pendingAudits?.add(task);
    } else completed();
  } catch { failed(); }
}

function publicHttpPath(path) {
  if (/^\/(?:|chat|new|sessions|healthz|readyz|control-ui-config\.json|favicon\.ico|favicon\.svg|logo\.svg)$/.test(path)
    || /^\/(?:assets|settings)\/[a-zA-Z0-9_.\/-]+$/.test(path)
    || /^\/chat\/[a-zA-Z0-9_.%:/-]+$/.test(path)
    || path === "/__openclaw__/session-entry") return path;
  return "/[redacted]";
}

// Context-level observation includes popups and frames. Headers are not read.
// HTTP status describes transport completion; it does not assert UI content.
export function observeControlUiHttp(context, getOutput, { onHttpRequest, pendingAudits, gatewayOrigins = new Set() } = {}) {
  const pending = new Map();
  context.on("request", (source) => {
    let url;
    try { url = new URL(source.url()); } catch { return; }
    if (!["http:", "https:"].includes(url.protocol)) return;
    const output = typeof getOutput === "function" ? getOutput() : getOutput;
    const method = source.method(), resourceType = source.resourceType();
    let body = source.postData();
    if (body !== null) { try { body = JSON.parse(body); } catch {} }
    const query = Object.create(null);
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key);
      query[key] = values.length === 1 ? values[0] : values;
    }
    const record = { transport: "http", method, endpoint: publicHttpPath(url.pathname), origin: gatewayOrigins.has(url.origin) ? "gateway" : "external", resourceType, params: { query: redactControlUiParams(query), body: redactControlUiParams(body) }, status: "pending", elapsedMs: null };
    if (record.endpoint === "/[redacted]") record.pathRedacted = true;
    notifyRequest(onHttpRequest, [{ method, url: url.href, body, resourceType }], record, output, pendingAudits, { gatewayOrigin: gatewayOrigins.has(url.origin) ? url.origin : null });
    if (!output) return;
    if (output.requests.length >= requestLimit) { output.error = "Control UI request recording limit reached"; return; }
    output.requests.push(record);
    pending.set(source, { record, startedAt: Date.now() });
  });
  context.on("response", (response) => {
    const match = pending.get(response.request());
    if (!match) return;
    match.record.statusCode = response.status();
    match.record.status = "response";
    match.record.elapsedMs = Date.now() - match.startedAt;
  });
  const finish = (source, status) => {
    const match = pending.get(source);
    if (!match) return;
    pending.delete(source); match.record.status = status; match.record.elapsedMs = Date.now() - match.startedAt;
  };
  context.on("requestfinished", (source) => finish(source, "result"));
  context.on("requestfailed", (source) => finish(source, "failed"));
  context.once("close", () => { for (const source of pending.keys()) finish(source, "closed"); });
}

export function observeControlUiSocket(socket, getOutput, { onRequest, connecting = () => {}, connected = () => {}, disconnected = () => {}, pendingAudits } = {}) {
  const pending = new Map();
  let retired = false, clientInfo;
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
    if (frame.method === "connect") {
      clientInfo = { id: frame.params?.client?.id, mode: frame.params?.client?.mode };
      connecting();
    }
    const output = typeof getOutput === "function" ? getOutput() : getOutput;
    const request = { transport: "gateway", method: frame.method, params: frame.method === "connect" ? "[redacted authentication]" : redactControlUiParams(frame.params), status: "pending", elapsedMs: null };
    if (!Object.hasOwn(frame, "params")) request.paramsOmitted = true;
    notifyRequest(onRequest, [frame.method, frame.params], request, output, pendingAudits, { clientInfo });
    if (!output && frame.method !== "connect") return;
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
