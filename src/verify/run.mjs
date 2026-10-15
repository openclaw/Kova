import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactsDir, repoRoot } from "../paths.mjs";
import { quoteShell as q, runCommand, runWithShutdownScope } from "../commands.mjs";
import { checkCatalogueCommands, createCatalogueResolver, loadCatalogue, parseCatalogueCommand } from "../catalogue.mjs";
import { canonicalJSON, sha256 } from "./plan.mjs";
import { createClone, hashFile, readPersona, resolveRunCommand, stagePersona } from "./clones.mjs";
import { combineLogCollectors, createLogCollector, snapshotState, writeCheckpoint } from "./checkpoint.mjs";
import { parseGatewayCallArgs, resolveGatewayParams } from "../../support/verify/gateway-call.mjs";
import { CallError, failure as gatewayFailure } from "../../support/verify/background.mjs";
import { cleanupGatewayHandle } from "../../support/verify/gateway-lifecycle.mjs";

const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
const baselineNames = ["baseline", "noise-1", "noise-2"];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };
const git = (path, args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).trim();

export function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error(`invalid OpenClaw version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] < right.numbers[i] ? -1 : 1;
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx !== ny) return nx ? -1 : 1;
    return (nx ? BigInt(x) < BigInt(y) : x < y) ? -1 : 1;
  }
  return 0;
}

export async function validateTarget(selector, expectedCommit, personaVersion) {
  if (typeof selector !== "string" || !selector.startsWith("local-build:") || !selector.slice(12)) throw new Error("verify run targets must use local-build:<path>");
  const path = resolve(selector.slice(12));
  const commit = git(path, ["rev-parse", "HEAD"]);
  if (commit !== expectedCommit) throw new Error(`target commit differs from plan: ${path}`);
  if (git(path, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error(`target has uncommitted changes: ${path}`);
  const pkg = await readJSON(join(path, "package.json"));
  if (pkg.name !== "openclaw" || compareVersions(pkg.version, personaVersion) < 0) throw new Error(`target must be OpenClaw no older than persona ${personaVersion}: ${path}`);
  return { selector: `local-build:${path}`, commit, version: pkg.version };
}

function option(tokens, name) {
  const matches = tokens.flatMap((token, index) => token === name || token.startsWith(`${name}=`) ? [index] : []);
  if (matches.length > 1) throw new Error(`repeated ${name} is ambiguous`);
  const index = matches[0] ?? -1;
  return index < 0 ? undefined : tokens[index].includes("=") ? tokens[index].slice(name.length + 1) : tokens[index + 1];
}

export function validateRunPlan(plan, catalogue) {
  if (plan?.schema !== "kova.verify.plan.v1" || !/^[0-9a-f]{40}$/.test(plan.change?.baseline ?? "") || !/^[0-9a-f]{40}$/.test(plan.change?.change ?? "")) throw new Error("invalid verification plan identity");
  if (!Array.isArray(plan.phases) || !plan.phases.length) throw new Error("cannot run an empty verification plan");
  if (sha256(canonicalJSON(plan.phases)) !== plan.phasesSha256) throw new Error("plan phase hash differs");
  const binding = plan.phases[0];
  if (binding.id !== "standard/use-target" || binding.from !== "standard" || canonicalJSON(binding.commands) !== canonicalJSON(["ocm start {env} --runtime {target} --no-service --json"])) throw new Error("plan must begin with the standard target binding");
  const isClone = (value) => value === "{env}" || /^\{persona:[^:]+:env\}$/.test(value ?? "");
  const handles = new Set(plan.phases.flatMap((phase) => phase.commands.map((command) => option(parseCatalogueCommand(command, { standard: phase.from === "standard" }).tokens, "--handle"))).filter(Boolean));
  const ids = new Set();
  const resolver = createCatalogueResolver(catalogue);
  for (const phase of plan.phases) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase.id) || ids.has(phase.id) || !Number.isSafeInteger(phase.timeoutMs) || phase.timeoutMs < 1 || !Array.isArray(phase.commands) || !phase.commands.length || !Array.isArray(phase.checkpoint)) throw new Error("invalid verification phase");
    if (phase.timeoutMs > 2147483647 || phase.checkpoint.some((value) => typeof value !== "string" || !/^(responses|logs|timing|doctor|screen)$/.test(value) && (!value.startsWith("state:") || isAbsolute(value.slice(6)) || value.slice(6).split(/[\\/]/).some((part) => !part || part === "." || part === "..")))) throw new Error("invalid checkpoint or phase timeout");
    ids.add(phase.id);
    const standard = phase.from === "standard";
    const findings = checkCatalogueCommands(catalogue, phase.commands.map((command) => ({ command, standard })));
    if (findings.length) throw new Error(`catalogue refused ${phase.id}: ${findings.map((item) => item.message).join("; ")}`);
    for (const command of phase.commands) {
      const tokens = parseCatalogueCommand(command, { standard }).tokens;
      const entry = resolver(command, { standard });
      const environment = option(tokens, "--env");
      if (environment !== undefined && environment !== "{env}" && !/^\{persona:[^:]+:env\}$/.test(environment)) throw new Error(`${phase.id}: --env must name a clone placeholder`);
      const timeout = Number(option(tokens, "--timeout") ?? phase.timeoutMs), delay = Number(option(tokens, "--after-ms") ?? 0);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(delay) || delay < 0 || timeout + delay + 1000 > 2147483647) throw new Error(`${phase.id}: invalid command timeout or delay`);
      if (tokens[0] === "ocm" && tokens[1] === "service") throw new Error(`${phase.id}: managed service commands cannot run in verification clones`);
      if (tokens[0] === "ocm") {
        if (tokens[1]?.startsWith("@")) {
          if (!isClone(tokens[1].slice(1))) throw new Error(`${phase.id}: OpenClaw command must target a clone`);
        } else {
          const operands = { "ocm-env-show": 3, "ocm-env-snapshot-create": 4, "ocm-start": 2, "ocm-logs": 2, "ocm-upgrade": 2 };
          if (!Object.hasOwn(operands, entry.id) || !isClone(tokens[operands[entry.id]])) throw new Error(`${phase.id}: OCM operation must target an owned clone and cannot run arbitrary programs or create environments`);
          if (["ocm-start", "ocm-upgrade"].includes(entry.id) && option(tokens, "--runtime") !== "{target}") throw new Error(`${phase.id}: runtime binding must use the planned target`);
        }
      }
      for (const flag of ["--out", "--handle", "--wait", "--from", "--session-from", "--merge-from", "--target-from"]) {
        const value = option(tokens, flag);
        if (value !== undefined && (!value.startsWith("{run}/") || value.slice(6).split(/[\\/]/).some((part) => !part || part === "." || part === ".."))) throw new Error(`${phase.id}: ${flag} must stay under {run}`);
      }
      for (const flag of ["--out", "--handle"]) {
        const value = option(tokens, flag);
        if (value === undefined) continue;
        const parts = value.slice(6).split("/");
        if (/^(checkpoints|initial-state|\.persona|\.inputs|extra-\d+|mock-\d+)$/.test(parts[0]) || parts.some((part) => part.endsWith(".d") || /^persona-gateway-\d+\.json$/.test(part)) || flag === "--out" && handles.has(value)) throw new Error(`${phase.id}: output overlaps protected evidence or a background operation`);
      }
      if (entry.kind === "ocm" && tokens[1] === "start" && !tokens.includes("--no-service")) throw new Error(`${phase.id}: OCM start requires --no-service`);
    }
  }
}

async function physicalPath(path) {
  let parent = resolve(path);
  const tail = [];
  while (true) {
    try { return join(await realpath(parent), ...tail.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(parent) === parent) throw error;
      tail.push(basename(parent)); parent = dirname(parent);
    }
  }
}

const agentConfigPrefixes = ["agents.defaults", "agents.entries.*", "agents.list.*"];
// Host data paths in the pinned configuration contract. Trusted program and
// module selectors retain product validation; these checks are not a sandbox.
const configFilePatterns = [
  "logging.file", "worktreeRoot", "session.store", "gateway.controlUi.root",
  "gateway.tls.certPath", "gateway.tls.keyPath", "gateway.tls.caPath", "gateway.remote.sshIdentity",
  "proxy.tls.caFile", "desktop.host.passwordFile", "browser.profiles.*.userDataDir",
  "memory.search.extraPaths.*", "memory.search.extraPaths.*.path",
  "secrets.providers.*.path", "models.providers.*.localService.cwd",
  "env.vars.OPENCLAW_CACHE_TRACE_FILE", "env.OPENCLAW_CACHE_TRACE_FILE",
  "env.vars.OPENCLAW_TTS_PREFS", "env.OPENCLAW_TTS_PREFS", "tts.prefsPath",
  "channels.*.tts.prefsPath", "channels.*.accounts.*.tts.prefsPath",
  ...["mcp", "nodeHost.mcp"].flatMap((prefix) => ["cwd", "clientCert", "clientKey"].map((field) => `${prefix}.servers.*.${field}`)),
  ...agentConfigPrefixes.flatMap((prefix) => ["workspace", "cwd", "repoRoot", "agentDir", "runtime.acp.cwd", "tts.prefsPath", "sandbox.workspaceRoot", "sandbox.ssh.identityFile", "sandbox.ssh.certificateFile", "sandbox.ssh.knownHostsFile"].map((field) => `${prefix}.${field}`)),
  "bindings.*.acp.cwd",
  ...Object.entries({
    telegram: ["tokenFile", "webhookCertPath", "trustedLocalFileRoots.*"], whatsapp: ["authDir"],
    googlechat: ["serviceAccountFile"], signal: ["transport.configPath", "transport.socketPath"],
    imessage: ["dbPath", "attachmentRoots.*"], irc: ["passwordFile", "nickserv.passwordFile"],
    msteams: ["certificatePath"], line: ["tokenFile", "secretFile"], zalo: ["tokenFile"], "nextcloud-talk": ["botSecretFile", "apiPasswordFile"]
  }).flatMap(([channel, fields]) => fields.flatMap((field) => [`channels.${channel}.${field}`, `channels.${channel}.accounts.*.${field}`]))
].map((pattern) => pattern.split("."));
const configPathMatches = (path, pattern) => path.length === pattern.length && pattern.every((part, index) => part === "*" || part === path[index]);
const runtimeConfigPathPatterns = ["storage.locations.*.provider", "storage.locations.*.settings.path"].map((pattern) => pattern.split("."));

// Preserve the concrete key identity used by OpenClaw's config-set parser.
function configSetPath(raw) {
  const text = raw.trim(), parts = [];
  let current = "", emitted = false;
  const invalid = () => { throw new Error("invalid config set path"); };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      if (++index === text.length) invalid();
      current += text[index];
    } else if (char === ".") {
      if (current && !current.trim() || !emitted && !current.trim()) invalid();
      if (current) parts.push(current.trim());
      current = ""; emitted = false;
    } else if (char === "[") {
      if (current && !current.trim() || !current.trim() && !emitted && parts.length) invalid();
      if (current) parts.push(current.trim());
      current = "";
      const start = index + 1;
      let quote;
      for (index = start; index < text.length; index++) {
        const next = text[index];
        if (quote) {
          if (next === "\\") index++;
          else if (next === quote) quote = undefined;
        } else if (next === "]") break;
        else if ((next === "'" || next === '"') && !text.slice(start, index).trim()) quote = next;
      }
      if (index === text.length || quote) invalid();
      const value = text.slice(start, index).trim();
      const key = /^["']/.test(value) ? JSON5.parse(value) : value;
      if (typeof key !== "string" || !key.trim()) invalid();
      parts.push(key); emitted = true;
      if (text[index + 1] !== undefined && ![".", "["].includes(text[index + 1])) invalid();
    } else current += char;
  }
  if (!emitted && !current.trim()) invalid();
  if (current) parts.push(current.trim());
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) invalid();
  return parts;
}

// The two configuration commands use dot paths and JSON-or-string values at
// OpenClaw 7e80556f. Other message text stays with its product handler.
function inspectSessionMessage(method, params) {
  if (method !== "sessions.create") return;
  const message = typeof params.task === "string" && params.task.trim() ? params.task : params.message;
  if (typeof message !== "string" || message.includes("\0")) return;
  let body = [...message.normalize("NFC")].filter((char) => {
    const code = char.charCodeAt(0);
    return code > 31 && code !== 127 || [9, 10, 13].includes(code);
  }).join("").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  while (body.startsWith("[")) {
    if (["[Chat messages since your last reply - for context]", "[Recent chat messages - for context]", "[Current message - respond to this]"].some((marker) => body.startsWith(marker))) return;
    const prefix = /^\[[^\]\n]*\][ \t]*/.exec(body);
    if (!prefix) break;
    body = body.slice(prefix[0].length);
  }
  body = body.replace(/^(?:@?Kova Gateway RPC|Kova Gateway RPC \(@Kova Gateway RPC\)):[ \t]*/i, "").replace(/\\n/g, " ").trim();
  // Shell requests consume the whole message, including later lines.
  const bash = /^\/bash(?:\s*:\s*|\s+|$)([\s\S]*)$/i.exec(body);
  let program = bash?.[1];
  if (!bash && body.startsWith("!")) program = body.slice(1).trimStart().replace(/^:/, "");
  if (program !== undefined && program.trim()) {
    const action = program.trimStart().match(/^\S+/)?.[0].toLowerCase();
    if (!["help", "poll", "stop"].includes(action)) throw new Error("executable messages cannot establish an owned program boundary");
  }
  body = body.split("\n", 1)[0].trim().replace(/^\/(config|debug)\s*:\s*/i, "/$1 ");
  const command = /^\/(config|debug)(?:\s+([\s\S]*))?$/i.exec(body);
  if (!command) return;
  const tail = command[2]?.trim() ?? "", actionEnd = tail.search(/\s/);
  const action = (actionEnd < 0 ? tail : tail.slice(0, actionEnd)).toLowerCase() || "show";
  const args = actionEnd < 0 ? "" : tail.slice(actionEnd).trim();
  const debug = command[1].toLowerCase() === "debug";
  if (debug && action === "reset") return { action, debug };
  if (!["set", "unset"].includes(action)) return;
  const equals = args.indexOf("=");
  if (action === "set" && equals <= 0) return;
  const path = (action === "set" ? args.slice(0, equals) : args).trim().split(".").map((part) => part.trim());
  if (path.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) return;
  let value = null;
  if (action === "set") {
    const raw = args.slice(equals + 1).trim();
    if (!raw) return;
    if (raw.startsWith("{") || raw.startsWith("[")) { try { value = JSON.parse(raw); } catch { return; } }
    else if (["true", "false", "null"].includes(raw)) value = JSON.parse(raw);
    else if (/^-?\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))) value = Number(raw);
    else if (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'")) {
      try { value = JSON.parse(raw); } catch { value = raw.slice(1, -1); }
    } else value = raw;
  }
  return { action, debug, path, value };
}

export async function validateRunDestinations(command, context) {
  const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
  const roots = await Promise.all([context.run, ...(context.ownedRoots ?? [])].map(physicalPath));
  const owned = async (path, allowed = roots) => {
    const physical = await physicalPath(resolve(context.cwd, path));
    if (!allowed.some((root) => inside(root, physical))) throw new Error("command path must stay inside its owned copy");
    try { const stat = await lstat(physical); if (stat.isFile() && stat.nlink !== 1) throw new Error("command path must be an unaliased owned file"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return physical;
  };
  await owned(context.cwd);
  const outputRoot = [await physicalPath(context.run)];
  const productRoots = await Promise.all((context.ownedRoots ?? []).map(physicalPath));
  const productDestination = async (path) => {
    const physical = await owned(path, productRoots);
    if (inside(outputRoot[0], physical)) throw new Error("product destination cannot overlap verification evidence");
    return physical;
  };
  const validateConfiguration = async (patch, env, { debug = false } = {}) => {
    let existingConfig;
    const configuration = async () => existingConfig ??= await context.readConfiguration?.(env);
    const directFile = async (value) => {
      if (typeof value !== "string" || value.includes("${") || value.includes("\0") || value.startsWith("~") || !isAbsolute(value)) throw new Error("config patch paths must be direct absolute owned paths");
      return await productDestination(value);
    };
    const inspect = async (value, path = [], inline = false) => {
      if (debug && runtimeConfigPathPatterns.some((pattern) => configPathMatches(path, pattern))) throw new Error("debug storage path changes require observable runtime configuration");
      if (path.at(-1) === "$include") throw new Error("config patch includes cannot establish destination ownership");
      if (value !== null && typeof value === "object") {
        // This object form is inline template data, not a configuration tree.
        inline ||= configPathMatches(path, ["messages", "usageTemplate"]);
        for (const [child, entry] of Object.entries(value)) await inspect(entry, [...path, child], inline);
      } else if (typeof value === "string" && !inline) {
        let isFile = configFilePatterns.some((pattern) => configPathMatches(path, pattern)) || configPathMatches(path, ["messages", "usageTemplate"]);
        if (path[0] === "env" && (path.length === 2 || path.length === 3 && path[1] === "vars")) {
          const key = path.at(-1).trim();
          if (["OPENCLAW_TTS_PREFS", "OPENCLAW_CACHE_TRACE_FILE"].includes(process.platform === "win32" ? key.toUpperCase() : key)) isFile = true;
        }
        if (configPathMatches(path, ["memory", "search", "local", "modelPath"])) isFile = !/^(?:hf:|https?:\/\/)/i.test(value);
        if (configPathMatches(path, ["storage", "locations", "*", "settings", "path"])) {
          let provider = patch.storage.locations[path[2]].provider;
          if (provider === undefined) provider = (await configuration())?.storage?.locations?.[path[2]]?.provider;
          if (typeof provider !== "string") throw new Error("config patch storage paths require a known provider");
          isFile = provider === "filesystem";
        }
        if (configPathMatches(path, ["storage", "locations", "*", "provider"]) && value === "filesystem") {
          const location = patch.storage.locations[path[2]];
          if (location.settings !== null && location.settings?.path === undefined) {
            const current = (await configuration())?.storage?.locations?.[path[2]];
            if (current?.$include || current?.settings?.$include) throw new Error("config patch storage paths require directly authored settings");
            if (typeof current?.settings?.path === "string") await directFile(current.settings.path);
          }
        }
        if (agentConfigPrefixes.some((prefix) => ["docker", "browser"].some((kind) => configPathMatches(path, [...prefix.split("."), "sandbox", kind, "binds", "*"])))) {
          // Match the product's host:container[:options] split, including drive letters.
          const separator = value.indexOf(":", /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0);
          await directFile(separator < 0 ? value : value.slice(0, separator));
        }
        if (isFile) await directFile(value);
      }
    };
    if (Object.hasOwn(patch ?? {}, "logging") && (!patch.logging || typeof patch.logging !== "object" || Array.isArray(patch.logging) || Object.hasOwn(patch.logging, "file") && typeof patch.logging.file !== "string")) throw new Error("config patch must preserve the owned product log destination");
    await inspect(patch);
    if (typeof patch?.logging?.file === "string") await context.prepareLogDestination?.(env, patch.logging.file);
  };
  for (const flag of ["--out", "--handle", "--wait", "--from", "--session-from", "--merge-from", "--target-from"]) {
    const value = option(tokens, flag);
    if (value !== undefined) {
      const physical = await owned(value, outputRoot);
      if (["--out", "--handle"].includes(flag)) {
        const parts = relative(outputRoot[0], physical).split(sep);
        if (/^(checkpoints|initial-state|\.persona|\.inputs|extra-\d+|mock-\d+)$/.test(parts[0]) || parts.some((part) => part.endsWith(".d") || /^persona-gateway-\d+\.json$/.test(part))) throw new Error("output overlaps protected evidence or a background operation");
      }
    }
  }
  if (tokens[0] === "node" && tokens[1] === join(context.kovaRoot ?? "", "support/verify/gateway-call.mjs")) {
    const options = parseGatewayCallArgs(tokens.slice(2));
    if (!options.wait) {
      const params = await resolveGatewayParams(options, { signal: context.signal });
      const mutation = inspectSessionMessage(options.method, params);
      if (mutation) {
        if (mutation.debug && mutation.action === "unset" && runtimeConfigPathPatterns.some((pattern) => mutation.path.every((part, index) => pattern[index] === "*" || pattern[index] === part))) throw new Error("debug storage path changes require observable runtime configuration");
        if (mutation.debug && (mutation.action === "reset" || mutation.action === "unset" && mutation.path[0] === "logging")) {
          const current = await context.readConfiguration?.(options.env);
          await validateConfiguration({ logging: current?.logging ?? null }, options.env);
        } else {
          if (!mutation.debug && mutation.action === "set" && mutation.path.length === 1 && mutation.path[0] === "logging" && typeof mutation.value?.file !== "string") throw new Error("config replacement must preserve the owned product log destination");
          const patch = mutation.path.reduceRight((value, key) => ({ [key]: value }), mutation.value);
          await validateConfiguration(patch, options.env, { debug: mutation.debug });
        }
      }
      if (options.method === "sessions.create" && ["projectId", "catalogId", "execNode"].some((field) => params[field] != null)) throw new Error("Gateway creation requires a locally owned workspace; project, catalog and remote selectors are unsupported");
      if (["sessions.patch", "sessions.patchMany"].includes(options.method) && (params.execNode != null || params.patch?.execNode != null)) throw new Error("Gateway execution must remain local to its owned copy");
      const directPath = async (path) => {
        if (typeof path !== "string" || !isAbsolute(path) || path.includes("${") || path.includes("\0")) throw new Error("Gateway file paths must be direct absolute owned paths");
        return await productDestination(path);
      };
      if (["sessions.create", "sessions.groups.update"].includes(options.method) && params.cwd != null) params.cwd = await directPath(params.cwd);
      if (/^sessions\.files\.(list|get|set|assets)$/.test(options.method) && params.path !== undefined) {
        params.path = await directPath(params.path);
        if (options.method === "sessions.files.set") {
          const protectedFiles = await Promise.all((context.configPaths ?? []).map(physicalPath));
          if (protectedFiles.includes(params.path)) throw new Error("session file writes cannot replace clone configuration; use config patch");
        }
        if (options.method === "sessions.files.assets") for (const ref of params.refs ?? []) {
          let path;
          try { path = decodeURIComponent(ref.trim().split(/[?#]/, 1)[0]).replaceAll("\\", "/"); } catch { continue; }
          // The product rejects URL, absolute and fragment-only asset references.
          if (!path || path.startsWith("/") || path.startsWith("~") || path.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(path)) continue;
          await productDestination(resolve(dirname(params.path), path));
        }
      }
      const frozen = [];
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (["--params", "--session-from", "--merge-from", "--from"].some((flag) => token === flag || token.startsWith(`${flag}=`))) {
          if (!token.includes("=")) index++;
        } else frozen.push(token);
      }
      frozen.push("--params", JSON.stringify(params));
      return frozen.map(q).join(" ");
    }
  }
  if (tokens[0] === "ocm" && tokens[1]?.startsWith("@") && tokens[3] === "sessions" && tokens[4] === "export-trajectory") {
    const workspace = await productDestination(option(tokens, "--workspace") ?? context.cwd);
    const output = option(tokens, "--output");
    if (output !== undefined && (!output || output === "." || output === ".." || isAbsolute(output) || output.includes("/") || output.includes("\\"))) throw new Error("trajectory output must be a directory name");
    await productDestination(join(workspace, ".openclaw", "trajectory-exports", output ?? ""));
  }
  if (tokens[0] === "ocm" && tokens[1]?.startsWith("@") && tokens[3] === "config" && tokens[4] === "set") {
    const args = tokens.slice(5).filter((token) => token !== "--strict-json");
    if (args.length !== 2 || tokens.filter((token) => token === "--strict-json").length > 1) throw new Error("config set requires one path and value");
    const path = configSetPath(args[0]);
    let value;
    try { value = tokens.includes("--strict-json") ? JSON.parse(args[1].trim()) : JSON5.parse(args[1].trim()); }
    catch (error) { if (tokens.includes("--strict-json")) throw error; value = args[1]; }
    if (path.length === 1 && path[0] === "logging" && typeof value?.file !== "string") throw new Error("config replacement must preserve the owned product log destination");
    await validateConfiguration(path.reduceRight((entry, key) => ({ [key]: entry }), value), tokens[1].slice(1));
  }
  if (tokens[0] === "ocm" && tokens[1]?.startsWith("@") && tokens[3] === "config" && tokens[4] === "patch") {
    const bytes = await readFile(await owned(option(tokens, "--file")));
    const patch = JSON5.parse(bytes.toString("utf8"));
    await validateConfiguration(patch, tokens[1].slice(1));
    const inputDirectory = join(context.run, ".inputs");
    await mkdir(inputDirectory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const inputStat = await lstat(inputDirectory);
    if (!inputStat.isDirectory() || inputStat.isSymbolicLink() || !inside(outputRoot[0], await physicalPath(inputDirectory))) throw new Error("config input storage must be an owned directory");
    const frozenPath = join(inputDirectory, `${randomUUID()}.json`);
    await writeFile(frozenPath, bytes, { flag: "wx", mode: 0o400 });
    const frozen = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] === "--file") { frozen.push("--file", frozenPath); index++; }
      else if (tokens[index].startsWith("--file=")) frozen.push("--file", frozenPath);
      else frozen.push(tokens[index]);
    }
    return frozen.map(q).join(" ");
  }
  return command;
}

export function cacheKey({ baseline, manifest, phases, kova, ocm }) {
  return sha256([baseline, manifest, phases, kova, ocm].join("\n"));
}

async function fingerprintDirectory(directory, prefix = "") {
  const files = {};
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === "cache.json") continue;
    if (entry.isDirectory()) Object.assign(files, await fingerprintDirectory(directory, path));
    else if (entry.isFile()) files[path] = await hashFile(join(directory, path));
    else throw new Error("verification cache contains a non-regular file");
  }
  return files;
}

async function kovaIdentity(root) {
  try {
    if (await realpath(git(root, ["rev-parse", "--show-toplevel"])) === await realpath(root)) return { revision: git(root, ["rev-parse", "HEAD"]), dirty: Boolean(git(root, ["status", "--porcelain", "--untracked-files=normal"])) };
  } catch { /* Installed packages use their version even inside another checkout. */ }
  return { revision: (await readJSON(join(root, "package.json"))).version, dirty: false };
}

export async function prepareRun(options, { root = repoRoot } = {}) {
  const path = resolve(options.plan);
  const bytes = await readFile(path);
  const plan = JSON.parse(bytes);
  const { catalogue, findings } = await loadCatalogue("openclaw", { root });
  if (findings.length) throw new Error("invalid command catalogue");
  validateRunPlan(plan, catalogue);
  const persona = await readPersona(resolve(dirname(path), plan.persona.manifest), plan.persona.sha256, catalogue);
  const checks = persona.definition.traits.map((trait, index) => ({ id: `persona/check-${index}`, from: "persona", timeoutMs: 300000, checkpoint: [], commands: [trait.check] }));
  const validationPhases = [plan.phases[0], ...checks];
  validateRunPlan({ ...plan, phases: validationPhases, phasesSha256: sha256(canonicalJSON(validationPhases)) }, catalogue);
  const version = persona.manifest.runtime.selector.slice(4);
  const targets = {
    baseline: await validateTarget(options.targetBaseline, plan.change.baseline, version),
    change: await validateTarget(options.targetChange, plan.change.change, version)
  };
  const standard = await readJSON(join(root, "verify/standard.json"));
  return { plan, planPath: path, planBytes: bytes, planHash: sha256(bytes), catalogue, persona, targets, standard, root, identity: await kovaIdentity(root) };
}

export async function runVerification(options, dependencies = {}) {
  const prepared = await prepareRun(options, dependencies);
  if (!options.execute) return { schema: "kova.verify.dry-run.v1", execute: false, plan: prepared.planPath, targets: prepared.targets, clones: names, phases: prepared.plan.phases.map((phase) => phase.id) };
  return runWithShutdownScope((signal) => executeRun(prepared, { ...dependencies, signal }));
}

async function executeRun(prepared, { execute = runCommand, home = artifactsDir, signal, cloneFactory = createClone, cleanupHandle = cleanupGatewayHandle } = {}) {
  const { plan, planBytes, catalogue, targets, root, identity, standard } = prepared;
  home = resolve(home);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const directory = join(home, "verify", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let admission = Promise.resolve();
  const bind = async (command, perform) => {
    const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    // Import reads runtime ownership while start/upgrade can change it, including aliases.
    const preparesRuntime = tokens[0] === "ocm" && (["start", "upgrade"].includes(tokens[1]) || tokens[1] === "env" && tokens[2] === "import");
    if (!preparesRuntime) return await perform();
    const previous = admission;
    let release;
    admission = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await perform(); }
    finally { release(); }
  };
  const executionEnv = { KOVA_OPENCLAW_CONFIG_CONTRACT: "canonical", OPENCLAW_CONFIG_PATH: "", OPENCLAW_GATEWAY_TOKEN: "", OPENCLAW_GATEWAY_PASSWORD: "", OPENCLAW_TTS_PREFS: "", OPENCLAW_CACHE_TRACE_FILE: "" };
  const invoke = (cancelable) => async (command, options = {}) => {
    const { observeResult, ...executeOptions } = options;
    if (cancelable) signal?.throwIfAborted();
    const result = await bind(command, () => {
      if (cancelable) signal?.throwIfAborted();
      return execute(command, { timeoutMs: 300000, finishOnShutdown: true, maxOutputChars: 16 * 1024 * 1024, ...executeOptions, env: { ...executeOptions.env, ...executionEnv } });
    });
    observeResult?.(result);
    if (cancelable) signal?.throwIfAborted();
    if (!options.allowFailure && (result.status !== 0 || result.signal || result.timedOut || result.outputBudget?.truncated)) throw new Error(`command failed (${result.status}): ${command}: ${result.stderr || result.stdout}`);
    return result;
  };
  const call = invoke(true), cleanupCall = invoke(false);
  let key, cache;
  const record = { schema: "kova.verify.run.v1", id, plan: { path: join(directory, "plan.json"), sha256: prepared.planHash, source: prepared.planPath }, kova: identity.revision, ocm: null, targets, clones: Object.fromEntries(names.map((name) => [name, { cached: false, started: false, phases: Object.fromEntries(plan.phases.map((phase) => [phase.id, "no checkpoint"])) }])), incomplete: [], notStarted: [], cleanupErrors: [], cache: { key: null, enabled: false } };
  await writeFile(record.plan.path, planBytes, { mode: 0o600 });
  await writeFile(join(directory, "standard.json"), json(standard), { mode: 0o600 });
  await writeFile(join(directory, "catalogue.json"), json(catalogue), { mode: 0o600 });
  const resources = [], runtimes = [];
  let failure;
  let cached;
  let cacheLocked = false;
  try {
    record.ocm = (await call("ocm --version")).stdout.trim();
    key = cacheKey({ baseline: targets.baseline.commit, manifest: plan.persona.sha256, phases: plan.phasesSha256, kova: identity.revision, ocm: record.ocm });
    cache = join(home, "verify/cache", key);
    record.cache = { key, enabled: !identity.dirty };
    await mkdir(join(directory, ".persona"), { mode: 0o700 });
    const persona = await stagePersona(prepared.persona, join(directory, ".persona"), call);
    for (const [name, extra] of persona.extra) for (const target of Object.values(targets)) if (compareVersions(target.version, extra.version) < 0) throw new Error(`target is older than persona environment ${name}: ${extra.version}`);
    const extras = Object.fromEntries([...persona.extra].map(([name, value]) => [name, value.contentSha256]));
    if (!identity.dirty) {
      await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
      try { await mkdir(`${cache}.lock`, { mode: 0o700 }); cacheLocked = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; record.cache.skipped = "cache is in use"; }
    }
    if (cacheLocked) {
      try {
        const saved = await readJSON(join(cache, "cache.json"));
        if (saved?.recordingFormat === 2 && saved.key === key && canonicalJSON(saved.extras) === canonicalJSON(extras) && canonicalJSON(saved.files) === canonicalJSON(await fingerprintDirectory(cache)) && baselineNames.every((name) => saved.clones?.[name]?.started && !saved.clones[name].incomplete?.length && plan.phases.every((phase) => saved.clones[name].phases?.[phase.id] === "recorded"))) {
          for (const name of baselineNames) await cp(join(cache, name), join(directory, name), { recursive: true, errorOnExist: true });
          cached = saved;
        }
        if (!cached) await rm(cache, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        for (const name of baselineNames) await rm(join(directory, name), { recursive: true, force: true });
        await rm(cache, { recursive: true, force: true });
      }
    }
    for (const side of cached ? ["change"] : ["baseline", "change"]) {
      const target = targets[side];
      const runtime = `kova-run-${randomUUID()}-${side}`;
      const inventory = JSON.parse((await call("ocm runtime list --json")).stdout);
      if (!Array.isArray(inventory) || inventory.some((entry) => entry.name === runtime)) throw new Error("cannot establish a fresh runtime name");
      runtimes.push(runtime);
      await call(`ocm runtime build-local ${q(runtime)} --repo ${q(target.selector.slice(12))} --json`, { timeoutMs: 1800000 });
      // A build cannot silently change the source identity being verified.
      await validateTarget(target.selector, target.commit, persona.manifest.runtime.selector.slice(4));
      target.runtime = runtime;
    }
    const resolver = createCatalogueResolver(catalogue);
    await Promise.all(names.map(async (name) => {
      if (cached && baselineNames.includes(name)) {
        record.clones[name] = { ...cached.clones[name], cached: true };
        for (const phase of record.clones[name].incomplete ?? []) if (!record.incomplete.includes(phase)) record.incomplete.push(phase);
        return;
      }
      const summary = record.clones[name];
      summary.incomplete = [];
      const clone = cloneFactory({ name, directory: join(directory, name), persona, root, call, cleanupCall, cleanupHandle, signal, executionEnv, validateCommand: (command, context) => validateRunDestinations(command, { ...context, signal }) });
      resources.push(clone);
      try {
        const metadata = await clone.prepare();
        summary.env = metadata.name;
        const logReaders = new Map();
        const logs = combineLogCollectors(async () => {
          for (const handle of clone.handles) {
            try {
              const value = await readJSON(handle);
              const paths = [value.ref?.stdoutPath, value.ref?.stderrPath].filter((path) => typeof path === "string");
              if (paths.some((path) => !isAbsolute(path) || !inside(clone.directory, path))) throw new Error("Gateway logs must stay under clone output directory");
              if (paths.length && !logReaders.has(handle)) logReaders.set(handle, createLogCollector(paths));
            } catch (error) { if (error.code !== "ENOENT") throw error; }
          }
          return [...logReaders.values(), ...(clone.collectProductLogs ? [clone.collectProductLogs] : [])];
        });
        await snapshotState(metadata.stateDir, plan.phases.flatMap((phase) => phase.checkpoint.filter((name) => name.startsWith("state:")).map((name) => name.slice(6))), join(clone.directory, "initial-state"));
        for (const phase of plan.phases) {
          signal?.throwIfAborted();
          const context = { cwd: metadata.root, ownedRoots: [metadata.root], ...clone.context(), standard: phase.from === "standard", signal, target: targets[name.startsWith("change") ? "change" : "baseline"].runtime };
          const results = [];
          const logErrors = [];
          const observeResult = (result) => {
            if (result.status !== 2) return;
            if (!summary.incomplete.includes(phase.id)) summary.incomplete.push(phase.id);
            if (!record.incomplete.includes(phase.id)) record.incomplete.push(phase.id);
          };
          const contexts = ["standard/use-target", "standard/start-gateway", "standard/stop-gateway"].includes(phase.id) && clone.contexts ? clone.contexts().map((value) => ({ ...context, ...value })) : [context];
          for (const commandContext of contexts) for (const command of phase.commands) {
            const tokens = parseCatalogueCommand(command, { standard: context.standard }).tokens;
            const entry = resolver(command, { standard: context.standard });
            const handle = option(tokens, "--handle");
            if (handle) clone.handles.add(resolve(commandContext.run, handle.slice(6)));
            const ownTimeout = option(tokens, "--timeout");
            const timeoutMs = ownTimeout === undefined ? phase.timeoutMs : Number(ownTimeout);
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(`invalid command timeout in ${phase.id}`);
            const delay = Number(option(tokens, "--after-ms") ?? 0);
            if (!Number.isSafeInteger(delay) || delay < 0) throw new Error(`invalid command delay in ${phase.id}`);
            const startedAt = Date.now();
            let resolved = command, result;
            try { resolved = resolveRunCommand(command, commandContext); resolved = await validateRunDestinations(resolved, commandContext); }
            catch (error) {
              signal?.throwIfAborted();
              const rejected = gatewayFailure(option(tokens, "--method") ?? entry.id, new CallError(error.message), startedAt);
              result = { command: resolved, status: rejected.exitCode, stdout: json(rejected.output), stderr: "", durationMs: Date.now() - startedAt, timedOut: false };
            }
            result ??= await call(resolved, { cwd: commandContext.cwd, timeoutMs: timeoutMs + delay + (entry.kind === "gateway" || entry.kind === "script" ? 1000 : 0), allowFailure: true, finishOnShutdown: false, observeResult });
            observeResult(result);
            result.reachedBound = result.timedOut || (["gateway", "script"].includes(entry.kind) && result.status === 3);
            results.push(result);
            // Retain a destination even if another command restores the prior config.
            try { await clone.observeProductLogs?.(); } catch (error) { logErrors.push(error.message); }
          }
          const screens = results.flatMap((result) => { try { const value = JSON.parse(result.stdout); return typeof value.screen === "string" ? [value.screen] : Array.isArray(value.screens) ? value.screens : []; } catch { return []; } });
          const screenPath = screens.at(-1);
          const failedBeforeStart = !summary.started && results.some((result) => result.status !== 0 || result.timedOut);
          if (phase.id === "standard/use-target" && !failedBeforeStart) for (const commandContext of contexts) {
            const bound = JSON.parse((await call(`ocm env show ${q(commandContext.env)} --json`)).stdout);
            if (bound.name !== commandContext.env || bound.defaultRuntime !== context.target) throw new Error("clone did not bind the planned target runtime");
          }
          if (!failedBeforeStart) summary.started = true;
          try {
            if (logErrors.length) throw new Error(`product log capture: ${logErrors.join("; ")}`);
            if (screenPath && (!isAbsolute(screenPath) || !inside(clone.directory, screenPath))) throw new Error("screenshot must stay under clone output directory");
            await writeCheckpoint({ phase, directory: clone.directory, results, stateDirectory: metadata.stateDir, collectLogs: logs, screenPath });
            summary.phases[phase.id] = "recorded";
          } catch (error) {
            (summary.captureErrors ??= {})[phase.id] = error.message;
            if (!record.incomplete.includes(phase.id)) record.incomplete.push(phase.id);
          }
          if (failedBeforeStart) break;
        }
      } catch (error) { summary.error = error.message; }
    }));
    record.notStarted = names.filter((name) => !record.clones[name]?.started);
    for (const phase of plan.phases) {
      const missing = (name) => record.clones[name]?.phases[phase.id] !== "recorded";
      if (["noise-1", "noise-2"].some(missing) || missing("baseline") && ["change-1", "change-2"].some(missing)) {
        if (!record.incomplete.includes(phase.id)) record.incomplete.push(phase.id);
      }
    }
    record.cache.extras = extras;
  } catch (error) { failure = error; record.error = error.message; }
  for (const clone of resources) try { await clone.cleanup(); } catch (error) { record.cleanupErrors.push(error.message); }
  try { await rm(join(directory, ".persona"), { recursive: true, force: true }); } catch (error) { record.cleanupErrors.push(error.message); }
  if (!record.cleanupErrors.length) for (const runtime of runtimes) {
    try {
      const inventory = await cleanupCall("ocm runtime list --json");
      if (JSON.parse(inventory.stdout).some((entry) => entry.name === runtime)) await cleanupCall(`ocm runtime remove ${q(runtime)} --json`);
    } catch (error) { record.cleanupErrors.push(error.message); }
  }
  if (!failure && cacheLocked && !cached && !record.cleanupErrors.length && baselineNames.every((name) => record.clones[name]?.started && !record.clones[name].error && !record.clones[name].incomplete?.length && plan.phases.every((phase) => record.clones[name].phases[phase.id] === "recorded"))) {
    await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(`${cache}.pending-`);
    try {
      for (const name of baselineNames) for (const child of ["checkpoints", "initial-state"]) await cp(join(directory, name, child), join(temporary, name, child), { recursive: true });
      await writeFile(join(temporary, "cache.json"), json({ recordingFormat: 2, key, extras: record.cache.extras, files: await fingerprintDirectory(temporary), clones: Object.fromEntries(baselineNames.map((name) => [name, record.clones[name]])) }), { mode: 0o600 });
      // A complete cache is immutable. A competing complete writer may win.
      try { await rename(temporary, cache); } catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    } catch (error) { record.cache.error = error.message; }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (cacheLocked) await rm(`${cache}.lock`, { recursive: true, force: true });
  record.notStarted = names.filter((name) => !record.clones[name]?.started);
  await writeFile(join(directory, "run.json"), json(record), { mode: 0o600 });
  if (failure) throw new Error(`${failure.message}; run: ${join(directory, "run.json")}`);
  return { ...record, path: join(directory, "run.json") };
}
