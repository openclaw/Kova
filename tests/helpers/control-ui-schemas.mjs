import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { extname, join, resolve } from "node:path";

const revision = "7e80556f503d26ddde64e274bfb50cbbec7830f5";
const schemaRoot = "packages/gateway-protocol/src/schema/";
const schemasByMethod = new Map();
for (const [file, methods] of [
  ["agent.ts", "agent.wait"],
  ["agents-models-skills.ts", "agents.list models.authStatus"],
  ["model-catalog.ts", "models.list"],
  ["artifacts.ts", "artifacts.list"],
  ["board.ts", "board.get"],
  ["logs-chat.ts", "chat.abort chat.history chat.metadata chat.send chat.startup"],
  ["config.ts", "config.get config.schema config.set update.status"],
  ["frames.ts", "connect"],
  ["cron.ts", "cron.list cron.status"],
  ["environments.ts", "environments.list"],
  ["human-mentions.ts", "mentions.list"],
  ["plugins.ts", "plugins.controlUi.list plugins.list"],
  ["progress-card.ts", "progressCard.get progressCard.put progressCard.refresh"],
  ["projects.ts", "projects.list"],
  ["questions.ts", "question.list"],
  ["session-discussion.ts", "session.discussion.info"],
  ["sessions-sharing.ts", "session.visibility.set"],
  ["sessions-reactions.ts", "session.reactions.list"],
  ["sessions.ts", "sessions.assignOwner sessions.branches.list sessions.companion.state sessions.describe sessions.diff sessions.files.list sessions.fork sessions.groups.defaults sessions.groups.list sessions.groups.put sessions.messages.subscribe sessions.messages.unsubscribe sessions.observer.visibility"],
  ["sessions-create.ts", "sessions.create"],
  ["sessions-catalog.ts", "sessions.catalog.list sessions.catalog.import"],
  ["sessions-delete.ts", "sessions.delete"],
  ["sessions-list.ts", "sessions.list"],
  ["sessions-patch.ts", "sessions.patch sessions.patchMany"],
  ["session-processes.ts", "sessions.processes.list"],
  ["sessions-recover.ts", "sessions.recover"],
  ["sessions-resolve.ts", "sessions.resolve"],
  ["sessions-search.ts", "sessions.search"],
  ["system-info.ts", "system.info"],
  ["channels.ts", "talk.catalog"],
  ["task-suggestions.ts", "taskSuggestions.list"],
  ["tools-catalog.ts", "tools.effective"],
  ["users.ts", "users.list users.prefs.get users.prefs.set users.self"],
  ["worktrees.ts", "worktrees.branches"],
]) {
  for (const method of methods.split(" ")) {
    const name = `${method.split(".").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}ParamsSchema`;
    schemasByMethod.set(method, { file, name });
  }
}
for (const [method, file, name] of [
  ["agent.identity.get", "agent.ts", "AgentIdentityParamsSchema"],
  ["sessions.subscribe", "sessions-list.ts", "SessionsListParamsSchema"],
  ["session.members.listEvidence", "sessions-sharing.ts", "SessionMembersListParamsSchema"],
  ["sessions.github.options", "session-github-publication.ts", "SessionGitHubOptionsParamsSchema"],
  ["sessions.storage.status", "sessions-storage.ts", "SessionsStorageParamsSchema"],
  ["sessions.storage.run", "sessions-storage.ts", "SessionsStorageParamsSchema"],
  ["sessions.viewers.set", "sessions-viewer-presence.ts", "SessionsViewerPresenceSetParamsSchema"],
]) schemasByMethod.set(method, { file, name });

const schemaLessHandlers = new Map([
  ["exec.approval.list", "src/gateway/server-methods/exec-approval.ts:110"],
  ["plugin.approval.list", "src/gateway/server-methods/plugin-approval.ts:59"],
  ["openclaw.approval.list", "src/gateway/server-methods/system-agent-approvals.ts:5"],
]);
const specialMethods = new Set(["presence.activity", "mcp.app.discover", "controlUi.sessionPullRequests.subscribe", "plugin.surface.refresh"]);
const knownMethods = new Set([...schemasByMethod.keys(), ...schemaLessHandlers.keys(), ...specialMethods]);
const specialSources = new Map([
  ["presence.activity", `${schemaRoot}presence.ts#validatePresenceActivityParams`],
  ["mcp.app.discover", "src/gateway/server-methods/mcp-app-extensions.ts#targetSchema"],
  ["controlUi.sessionPullRequests.subscribe", "src/gateway/control-ui-session-pr-subscriptions.ts#parseControlUiSessionPullRequestsSubscribeParams"],
  ["plugin.surface.refresh", "src/gateway/server-methods/nodes.read.ts#normalizePluginSurfaceRefreshParams"],
]);
const errorCodes = new Set(["type", "required", "additionalProperties", "minLength", "maxLength", "pattern", "format", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "anyOf", "oneOf", "allOf", "not", "propertyNames"]);
const resourceRoutes = ["agentAvatar", "catalogIcon", "channelAvatar", "linkFavicon", "pluginIcon", "pluginActivityIcon", "pluginThemeArt", "userAvatar", "workspaceIcon"];
const documentPaths = new Set(["/", "/index.html", "/__openclaw__/", "/__openclaw__/index.html", "/chat", "/chat/", "/new", "/sessions", "/dashboard", "/settings/ai-agents"]);
const staticPaths = new Set(["/favicon.ico", "/favicon.svg", "/favicon.png", "/apple-touch-icon.png", "/manifest.webmanifest"]);
const staticDirectories = ["/assets/", "/community-art/", "/fonts/", "/provider-icons/", "/themes/"];

function receipt(kind, source, status, code) {
  return { kind, source, status, errors: code ? [{ path: "$", code }] : [] };
}

function schemaProperties(schema, properties = new Set(), seen = new Set()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return properties;
  seen.add(schema);
  for (const key of Object.keys(schema.properties ?? {})) properties.add(key);
  for (const value of Object.values(schema)) schemaProperties(value, properties, seen);
  return properties;
}

function safeErrors(errors, properties) {
  return [...errors].slice(0, 12).map((error) => {
    const rawPath = typeof error?.instancePath === "string" ? error.instancePath : typeof error?.path === "string" ? error.path : "";
    // Dynamic record keys can contain private text. Retain only schema-authored
    // property names and bounded array positions, never values or error messages.
    const parts = rawPath.split("/").filter(Boolean).slice(0, 12).map((part) => {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      return properties.has(key) || /^\d{1,8}$/.test(key) ? part : "*";
    });
    return { path: parts.length ? `/${parts.join("/")}` : "$", code: errorCodes.has(error?.keyword) ? error.keyword : "schema" };
  });
}

function noBody(body) {
  return body === undefined || body === null || body === "" || Buffer.isBuffer(body) && body.length === 0;
}

/** Proof-only audit. Raw request parameters and HTTP bodies are never retained. */
export async function loadControlUiSchemaAudit({ checkout = process.env.KOVA_OPENCLAW_CHECKOUT } = {}) {
  if (!checkout) throw new Error("KOVA_OPENCLAW_CHECKOUT is required for the Control UI schema audit");
  const root = resolve(checkout);
  try { await access(root); }
  catch { throw new Error("Pinned OpenClaw checkout is unavailable for the Control UI schema audit"); }
  let head;
  try { head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error("Cannot identify the Control UI schema checkout"); }
  if (head !== revision) throw new Error("Control UI schema audit requires the pinned OpenClaw revision");
  const packagePath = join(root, "package.json");
  let jiti, schemas, Compile;
  try {
    const { createJiti } = createRequire(packagePath)("jiti");
    jiti = createJiti(packagePath, { fsCache: false, alias: { "@openclaw/normalization-core": join(root, "packages/normalization-core/src") } });
    schemas = await jiti.import(join(root, "packages/gateway-protocol/src/schema-modules.ts"));
    ({ Compile } = await jiti.import("typebox/schema"));
  } catch { throw new Error("Cannot load the pinned Control UI schema dependencies"); }
  const modules = new Map(), validators = new Map();
  const load = (path) => {
    if (!modules.has(path)) modules.set(path, jiti.import(join(root, path)));
    return modules.get(path);
  };
  let parserModule;
  const sourceFiles = new Map();
  // These parsers are private or share modules with live runtime machinery.
  // Evaluate their exact pinned declarations and explicit dependency closure,
  // without importing the surrounding handlers or starting their runtime graph.
  const loadIsolated = (owner, selections, exports) => {
    const key = `isolated:${owner}`;
    if (!modules.has(key)) modules.set(key, (async () => {
      const { parse } = await (parserModule ??= jiti.import("@babel/parser"));
      const snippets = [], exported = new Set();
      for (const { path, names, imports = [] } of selections) {
        if (!sourceFiles.has(path)) sourceFiles.set(path, readFile(join(root, path), "utf8").then((source) => ({ source, ast: parse(source, { sourceType: "module", plugins: ["typescript"] }) })));
        const { source, ast } = await sourceFiles.get(path);
        const remaining = new Set(names), remainingImports = new Set(imports);
        for (const statement of ast.program.body) {
          if (statement.type === "ImportDeclaration") {
            const localNames = statement.specifiers.map((entry) => entry.local.name);
            if (localNames.some((name) => remainingImports.has(name))) {
              if (statement.importKind === "type" || statement.specifiers.some((entry) => entry.importKind === "type") || localNames.some((name) => !remainingImports.has(name))) throw new Error("Isolated schema import is not narrowly declared");
              snippets.push(source.slice(statement.start, statement.end));
              for (const name of localNames) remainingImports.delete(name);
            }
            continue;
          }
          const exportedDeclaration = statement.type === "ExportNamedDeclaration";
          const declaration = exportedDeclaration ? statement.declaration : statement;
          if (!declaration) continue;
          const declarations = declaration.type === "VariableDeclaration" ? declaration.declarations : [];
          const name = declaration.type === "FunctionDeclaration" ? declaration.id?.name : declarations.length === 1 && declarations[0].id.type === "Identifier" ? declarations[0].id.name : undefined;
          if (!remaining.has(name)) continue;
          snippets.push(source.slice(statement.start, statement.end));
          remaining.delete(name);
          if (exportedDeclaration) exported.add(name);
        }
        if (remaining.size || remainingImports.size) throw new Error("Pinned schema declaration is unavailable");
      }
      const privateExports = exports.filter((name) => !exported.has(name));
      if (privateExports.length) snippets.push(`export { ${privateExports.join(", ")} };`);
      return await jiti.evalModule(snippets.join("\n"), { filename: join(root, `${owner}.schema-audit.ts`), ext: ".ts", async: true, forceTranspile: true });
    })());
    return modules.get(key);
  };
  const counts = { requests: 0, valid: 0, invalid: 0, unmapped: 0 };
  const methods = new Map(), endpoints = new Map(), flows = new Map();
  let pending = 0;
  const add = (map, key, result) => {
    const value = map.get(key) ?? { requests: 0, valid: 0, invalid: 0, unmapped: 0 };
    value.requests++;
    value[result.status]++;
    map.set(key, value);
  };
  const recordResult = (transport, name, result, { flow, record } = {}) => {
    counts.requests++;
    counts[result.status]++;
    add(transport === "gateway" ? methods : endpoints, name, result);
    const flowName = typeof flow === "string" && /^[a-z0-9-]{1,100}$/.test(flow) ? flow : "<unattributed>";
    add(flows, flowName, result);
    if (record && typeof record === "object") record.validation = structuredClone(result);
    return result;
  };

  async function checkGateway(method, rawParams, { clientInfo } = {}) {
    // The native dispatcher gives omitted/null params to handlers as {}.
    let params = rawParams ?? {};
    let normalization;
    if (method === "chat.send") {
      const path = "src/gateway/server-methods/chat-server-timing.ts";
      const name = "resolveControlUiReconnectResumeParams";
      const { resolveControlUiReconnectResumeParams } = await loadIsolated(path, [
        {
          path: "packages/gateway-protocol/src/client-info.ts",
          names: ["GATEWAY_CLIENT_IDS", "GATEWAY_CLIENT_NAMES", "GATEWAY_CLIENT_ID_SET", "normalizeGatewayClientId", "normalizeGatewayClientName"],
          imports: ["normalizeOptionalLowercaseString"],
        },
        { path: "src/utils/message-channel.ts", names: ["isOperatorUiClient"] },
        { path, names: ["CONTROL_UI_RECONNECT_RESUME_PARAM", name] },
      ], [name]);
      // The native resolver copies only for an eligible reconnect. Its input
      // and the driver's original request record remain untouched.
      const resolved = resolveControlUiReconnectResumeParams(params, clientInfo);
      params = resolved.params;
      if (resolved.resumeRequested) normalization = { source: `${path}#${name}` };
    }
    const entry = schemasByMethod.get(method);
    if (entry) {
      const source = `${schemaRoot}${entry.file}#${entry.name}`;
      const schemaReceipt = (status, code) => ({ ...receipt("schema", source, status, code), ...(normalization ? { normalization } : {}) });
      const schema = schemas[entry.name];
      if (!schema) return schemaReceipt("unmapped", "validator-unavailable");
      if (!validators.has(entry.name)) validators.set(entry.name, { validator: Compile(schema), properties: schemaProperties(schema) });
      const { validator, properties } = validators.get(entry.name);
      if (validator.Check(params)) return schemaReceipt("valid");
      return { ...schemaReceipt("invalid"), errors: safeErrors(validator.Errors(params), properties) };
    }
    if (schemaLessHandlers.has(method)) {
      // These native handlers ignore params; do not invent an empty-object schema.
      return receipt("no-schema", schemaLessHandlers.get(method), "valid");
    }
    if (method === "presence.activity") {
      const path = `${schemaRoot}presence.ts`;
      const { validatePresenceActivityParams } = await load(path);
      const valid = validatePresenceActivityParams(params);
      return {
        ...receipt("schema", `${path}#validatePresenceActivityParams`, valid ? "valid" : "invalid"),
        errors: valid ? [] : safeErrors(validatePresenceActivityParams.errors ?? [], schemaProperties(validatePresenceActivityParams.schema)),
      };
    }
    if (method === "controlUi.sessionPullRequests.subscribe") {
      const path = "src/gateway/control-ui-session-pr-subscriptions.ts";
      const { parseControlUiSessionPullRequestsSubscribeParams } = await loadIsolated(path, [
        { path: "src/gateway/control-ui-contract.ts", names: ["CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS"] },
        { path: `${schemaRoot}primitives.ts`, names: ["CHAT_SEND_SESSION_KEY_MAX_LENGTH"] },
        { path, names: ["parseSessionKeys", "parseControlUiSessionPullRequestsSubscribeParams"] },
      ], ["parseControlUiSessionPullRequestsSubscribeParams"]);
      const valid = parseControlUiSessionPullRequestsSubscribeParams(params) !== null;
      return receipt("handler", `${path}#parseControlUiSessionPullRequestsSubscribeParams`, valid ? "valid" : "invalid", valid ? undefined : "handler-params");
    }
    if (method === "mcp.app.discover" || method === "plugin.surface.refresh") {
      const mcp = method === "mcp.app.discover";
      const path = mcp ? "src/gateway/server-methods/mcp-app-extensions.ts" : "src/gateway/server-methods/nodes.read.ts";
      const name = mcp ? "targetSchema" : "normalizePluginSurfaceRefreshParams";
      const module = await loadIsolated(path, [{ path, names: mcp ? ["text", name] : [name], imports: [mcp ? "z" : "normalizeOptionalString"] }], [name]);
      const valid = mcp ? module[name].safeParse(params).success : module[name](params) !== undefined;
      return receipt(mcp ? "schema" : "handler", `${path}#${name}`, valid ? "valid" : "invalid", valid ? undefined : "handler-params");
    }
    return receipt("unmapped", null, "unmapped", "unknown-method");
  }

  async function checkHttp({ method, url, body }, { gatewayOrigin, basePath } = {}) {
    let parsed;
    try { parsed = new URL(url); }
    catch { return { name: "<unmapped>", result: receipt("unmapped", null, "unmapped", "unknown-route") }; }
    if (!["http:", "https:"].includes(parsed.protocol)) return { name: "<unmapped>", result: receipt("unmapped", null, "unmapped", "unknown-protocol") };
    // Only the driver knows which origins belong to its selected Gateways.
    // An external URL with the same path must not borrow a core route contract.
    if (typeof gatewayOrigin !== "string" || parsed.origin !== gatewayOrigin) {
      return { name: "<unmapped>", result: receipt("unmapped", null, "unmapped", "external-route") };
    }
    // A request cannot establish its own trusted mount. The driver may supply
    // the configured base path; current native fixtures use the root mount.
    const mount = typeof basePath === "string" && /^\/(?!\/)[^?#]*$/.test(basePath) ? basePath.replace(/\/$/, "") : "";
    const configSuffix = "/control-ui-config.json";
    const mounted = parsed.pathname === mount || parsed.pathname.startsWith(`${mount}/`);
    const path = mounted ? parsed.pathname.slice(mount.length) || "/" : parsed.pathname;
    const read = ["GET", "HEAD"].includes(method) && noBody(body);
    const finish = (name, source, valid = read, kind = "no-schema") => ({ name, result: receipt(kind, source, valid ? "valid" : "invalid", valid ? undefined : "http-request-shape") });
    if (mounted && (path === configSuffix || !mount && path === `/__openclaw__${configSuffix}`)) return finish("control-ui-config", "src/gateway/control-ui.ts:717");
    if (mounted && documentPaths.has(path)) return finish("control-ui-document", "src/gateway/control-ui-routing.ts#classifyControlUiRequest");
    const staticPath = path.startsWith("/__openclaw__/") ? path.slice("/__openclaw__".length) : path;
    if (mounted && (staticPaths.has(staticPath) || /^\/[^/]+\.[^/]+$/.test(staticPath) || staticDirectories.some((directory) => staticPath.startsWith(directory)))) {
      const source = "src/gateway/control-ui-static.ts";
      const { isControlUiStaticAssetExtension } = await loadIsolated(source, [{ path: source, names: ["CONTROL_UI_CONTENT_TYPES", "isControlUiStaticAssetExtension"] }], ["isControlUiStaticAssetExtension"]);
      if (isControlUiStaticAssetExtension(extname(staticPath).toLowerCase())) return finish("control-ui-static", `${source}#isControlUiStaticAssetExtension`);
    }
    if (mounted && path.startsWith("/__openclaw__/plugins/control-ui/")) {
      let valid = false;
      try {
        const [pluginId, revision = "", ...parts] = path.slice("/__openclaw__/plugins/control-ui/".length).split("/").map(decodeURIComponent);
        valid = read && Boolean(pluginId) && /^[a-f0-9]{64}$/.test(revision) && parts.length > 0 && parts.every((part) => part && part !== "." && part !== ".." && !/[\\/\0]/.test(part));
      } catch {}
      return finish("control-ui-plugin-static", "src/gateway/control-ui-plugin-assets.ts#handleControlUiPluginAssetRequest", valid, "handler");
    }
    if (path === "/healthz") return finish("gateway-health", "src/gateway/gateway-http-route-contracts.ts#classifyGatewayProbePath");
    if (path === "/.well-known/openclaw/browser-bootstrap") return finish("browser-bootstrap", "ui/src/app/browser-bootstrap.runtime.ts:40", method === "GET" && noBody(body));
    if (path.startsWith("/chat/") || path === "/__openclaw__/session-entry") {
      const parserPath = "src/gateway/control-ui-session-entry-path.ts";
      const { parseControlUiSessionReturnPath } = await load(parserPath);
      const query = parsed.searchParams;
      if (path === "/__openclaw__/session-entry") {
        const valid = method === "GET" && noBody(body) && query.getAll("path").length === 1 && query.getAll("probe").length <= 1 && (!query.has("probe") || query.get("probe") === "1") && [...query.keys()].every((key) => key === "path" || key === "probe") && Boolean(parseControlUiSessionReturnPath(query.get("path"), mount));
        return finish("session-entry", `${parserPath}#parseControlUiSessionReturnPath`, valid, "handler");
      }
      if (["catalog", "host", "thread"].every((key) => query.getAll(key).length === 1 && query.get(key)?.trim())) {
        const { parseControlUiSessionPath } = await load("packages/session-url-contract/src/parse.ts");
        if (parseControlUiSessionPath(parsed.pathname, mount)?.kind === "main") {
          return finish("catalog-chat-document", "src/gateway/control-ui-session-routes.ts:43", read, "handler");
        }
      }
      const entryQuery = new URLSearchParams(query);
      entryQuery.delete("offset");
      const entryPath = parsed.pathname + (entryQuery.size ? `?${entryQuery}` : "");
      const valid = read && query.getAll("offset").length <= 1 && /^(?:0|[1-9][0-9]{0,9})$/.test(query.get("offset") ?? "0") && Boolean(parseControlUiSessionReturnPath(entryPath, mount));
      return finish("public-chat", `${parserPath}#parseControlUiSessionReturnPath`, valid, "handler");
    }
    const resourcePath = "src/gateway/control-ui-resource-routes.ts";
    const { parseControlUiResourcePath } = await load(resourcePath);
    for (const route of resourceRoutes) {
      const resource = parseControlUiResourcePath(route, parsed.pathname, mount);
      if (resource.matched) return finish(`resource:${route}`, `${resourcePath}#parseControlUiResourcePath`, read && resource.value !== null, "handler");
    }
    if (path === "/__openclaw__/assistant-media") {
      const metaAllow = method === "POST" && parsed.searchParams.get("meta") === "1" && parsed.searchParams.get("allow") === "1";
      return finish("assistant-media", "src/gateway/control-ui.ts:309", (read || metaAllow && noBody(body)) && Boolean(parsed.searchParams.get("source")?.trim()));
    }
    if (/^\/api\/artifacts\/download\/[^/]+\/[^/]+$/.test(path)) return finish("artifact-download", "src/gateway/artifact-downloads.ts");
    if (path.startsWith("/__openclaw__/board/")) {
      const parts = /^\/__openclaw__\/board\/([^/]+)\/([^/]+)\/index\.html$/.exec(path);
      let valid = false;
      try { valid = read && Boolean(parts && decodeURIComponent(parts[1]) && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(decodeURIComponent(parts[2]))); } catch {}
      return finish("board-document", "src/gateway/board-http.ts#parseBoardWidgetPath", valid, "handler");
    }
    if (path === "/plugins/geolocation/lookup") return finish("geolocation", "extensions/geolocation/src/lookup-route.ts", read && isIP(parsed.searchParams.get("ip")?.trim() ?? "") !== 0, "handler");
    return { name: "<unmapped>", result: receipt("unmapped", null, "unmapped", "unknown-route") };
  }

  const summary = () => ({
    revision,
    ...counts,
    pending,
    methods: Object.fromEntries([...methods].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, { ...value }])),
    http: Object.fromEntries([...endpoints].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, { ...value }])),
    flows: Object.fromEntries([...flows].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, { ...value }])),
  });
  return {
    async onRequest(method, params, context = {}) {
      pending++;
      try {
        let result;
        try { result = await checkGateway(method, params, context); }
        catch {
          const entry = schemasByMethod.get(method);
          const source = entry ? `${schemaRoot}${entry.file}#${entry.name}` : specialSources.get(method) ?? schemaLessHandlers.get(method) ?? null;
          result = receipt("unmapped", source, "unmapped", "validator-unavailable");
        }
        return recordResult("gateway", knownMethods.has(method) ? method : "<unmapped>", result, context);
      } finally { pending--; }
    },
    async onHttpRequest(request, context = {}) {
      pending++;
      try {
        let checked;
        try { checked = await checkHttp(request, context); }
        catch { checked = { name: "<unmapped>", result: receipt("unmapped", null, "unmapped", "validator-unavailable") }; }
        return recordResult("http", checked.name, checked.result, context);
      } finally { pending--; }
    },
    summary,
    assertComplete(outputs, { expectedFlows = [] } = {}) {
      assert.equal(pending, 0, "Control UI schema audit still has pending requests");
      assert.ok(counts.requests > 0 && methods.size > 0 && endpoints.size > 0, "Control UI schema audit requires live Gateway and HTTP requests");
      assert.equal(counts.invalid, 0, "Control UI schema audit found invalid requests");
      assert.equal(counts.unmapped, 0, "Control UI schema audit has unmapped requests");
      const actual = new Set();
      for (const entry of Array.isArray(outputs) ? outputs : [outputs]) {
        const output = entry?.output ?? entry;
        assert.ok(output && typeof output.flow === "string" && Array.isArray(output.requests), "Control UI schema audit requires flow outputs");
        actual.add(output.flow);
        const requests = [...output.requests, ...(output.httpRequests ?? [])];
        assert.ok(requests.length > 0, "Control UI flow has no recorded requests");
        for (const request of requests) assert.equal(request?.validation?.status, "valid", "Control UI request is missing a valid schema or handler receipt");
        assert.ok(flows.has(output.flow), "Control UI output was not observed by this schema audit");
      }
      for (const flow of expectedFlows) assert.ok(actual.has(flow) && flows.has(flow), "Control UI schema audit is missing an expected flow");
      return summary();
    },
  };
}
