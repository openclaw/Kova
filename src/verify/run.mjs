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
import { combineLogCollectors, createAttachmentLogFilter, createLogCollector, createStateFileIdentityResolver, isPrivateVerificationIdentity, redactCommandResult, requiresStateFileFiltering, snapshotState, writeCheckpoint } from "./checkpoint.mjs";
import { parseGatewayCallArgs, resolveGatewayParams } from "../../support/verify/gateway-call.mjs";
import { CallError, failure as gatewayFailure, readJson } from "../../support/verify/background.mjs";
import { cleanupGatewayHandle } from "../../support/verify/gateway-lifecycle.mjs";
import { gatewayFixtureCleanupMs } from "../../support/verify/gateway-fixture-client.mjs";
import { inboundParams } from "../../support/verify/channel-inbound-turn.mjs";
import { definition as toolDefinition, toolArguments, toolMessage } from "../../support/verify/agent-tool-turn.mjs";
import { definition as goalDefinition, resolveGoalRequest } from "../../support/verify/goal-control.mjs";
import { parseScriptArgs, sessionKey as scriptSessionKey } from "../../support/verify/script.mjs";
import { mockInstructionText, verificationRequest } from "../../support/verify/mock-request.mjs";
import { requestedMockTools } from "../../support/persona/mock-content.mjs";

const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
const baselineNames = ["baseline", "noise-1", "noise-2"];
const recordingFormat = 22;
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

function validateOcmSnapshotBoundary(tokens, label = "command") {
  if (tokens[0] === "ocm" && (tokens[1] === "upgrade" || tokens[1] === "env" && tokens[2] === "snapshot" && tokens[3] === "create")) {
    throw new Error(`${label}: snapshot-producing OCM operations on clones are not allowed; use planned target binding and checkpoint state selections`);
  }
}

export async function assertFixtureRecoveryComplete(handlePath) {
  let pending = false;
  try { await lstat(join(`${handlePath}.d`, "fixture-request.json")); pending = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (pending) throw new Error("fixture cleanup unresolved");
  let handle;
  try { handle = await readJSON(handlePath); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (handle?.ref?.fixtureRecoveryComplete === false) throw new Error("fixture recovery unresolved");
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
      validateOcmSnapshotBoundary(tokens, phase.id);
      const environment = option(tokens, "--env");
      if (environment !== undefined && environment !== "{env}" && !/^\{persona:[^:]+:env\}$/.test(environment)) throw new Error(`${phase.id}: --env must name a clone placeholder`);
      const timeout = Number(option(tokens, "--timeout") ?? phase.timeoutMs), delay = Number(option(tokens, "--after-ms") ?? 0);
      const cleanupMs = entry.id === "stage-session-store-fixture" ? gatewayFixtureCleanupMs : 0;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(delay) || delay < 0 || timeout + delay + cleanupMs + 1000 > 2147483647) throw new Error(`${phase.id}: invalid command timeout or delay`);
      if (tokens[0] === "ocm" && tokens[1] === "service") throw new Error(`${phase.id}: managed service commands cannot run in verification clones`);
      if (tokens[0] === "ocm") {
        if (tokens[1]?.startsWith("@")) {
          if (!isClone(tokens[1].slice(1))) throw new Error(`${phase.id}: OpenClaw command must target a clone`);
        } else {
          const operands = { "ocm-env-show": 3, "ocm-start": 2, "ocm-logs": 2 };
          if (!Object.hasOwn(operands, entry.id) || !isClone(tokens[operands[entry.id]])) throw new Error(`${phase.id}: OCM operation must target an owned clone and cannot run arbitrary programs or create environments`);
          if (entry.id === "ocm-start" && option(tokens, "--runtime") !== "{target}") throw new Error(`${phase.id}: runtime binding must use the planned target`);
        }
      }
      for (const flag of ["--out", "--handle", "--wait", "--from", "--session-from", "--merge-from", "--target-from", "--gateway-handle", "--handoff-from", "--url-from", "--incognito-handle"]) {
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
      const entry = await lstat(parent).catch((failure) => {
        if (failure.code !== "ENOENT") throw failure;
      });
      if (entry?.isSymbolicLink()) throw new Error("command destination contains an unresolved symbolic link");
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

// Match the Gateway's chat-input-sanitize.ts before interpreting message data.
function normalizeSessionMessage(message) {
  if (typeof message !== "string" || message.includes("\0")) return;
  return [...message.normalize("NFC")].filter((char) => {
    const code = char.charCodeAt(0);
    return code > 31 && code !== 127 || [9, 10, 13].includes(code);
  }).join("");
}

// The two configuration commands use dot paths and JSON-or-string values at
// OpenClaw 7e80556f. Other message text stays with its product handler.
function inspectSessionMessage(message) {
  const normalized = normalizeSessionMessage(message);
  if (normalized === undefined) return;
  let body = normalized.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  while (body.startsWith("[")) {
    if (["[Chat messages since your last reply - for context]", "[Recent chat messages - for context]", "[Current message - respond to this]"].some((marker) => body.startsWith(marker))) return;
    const prefix = /^\[[^\]\n]*\][ \t]*/.exec(body);
    if (!prefix) break;
    body = body.slice(prefix[0].length);
  }
  body = body.replace(/^(?:@?Kova Gateway RPC|Kova Gateway RPC \(@Kova Gateway RPC\)):[ \t]*/i, "").replace(/\\n/g, " ").trim();
  // Shell requests consume the whole message, including later lines.
  const shellBodies = [body];
  if (/^\/bash(?:\s|:|$)/i.test(body) || body.startsWith("!")) {
    const stripped = body.replace(/^[ \t]*(?!\/)[^\n:]{1,120}:\s+/gm, "").trim();
    if (stripped !== body) shellBodies.push(stripped);
  }
  for (const shellBody of shellBodies) {
    const bash = /^\/bash(?:\s*:\s*|\s+|$)([\s\S]*)$/i.exec(shellBody);
    let program = bash?.[1];
    if (!bash && shellBody.startsWith("!")) program = shellBody.slice(1).trimStart().replace(/^:/, "");
    if (program !== undefined && program.trim()) {
      const action = program.trimStart().match(/^\S+/)?.[0].toLowerCase();
      if (!["help", "poll", "stop"].includes(action)) throw new Error("executable messages cannot establish an owned program boundary");
    }
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

function readPathCandidates(path) {
  // OpenClaw's read tool probes these basename spellings after an exact miss.
  // Check every possible target without reading files or choosing a fallback.
  const name = basename(path), prefix = path.slice(0, path.length - name.length);
  const variants = new Set([path]);
  const spaces = name.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  for (const spaced of [spaces, spaces.replace(/ (?=(?:AM|PM)(?:\b|\.))/gi, "\u202f")]) {
    for (const quoted of [spaced.replace(/[\u2018\u2019]/g, "'"), spaced.replace(/['\u2018]/g, "\u2019")]) {
      variants.add(`${prefix}${quoted.normalize("NFC")}`);
      if (process.platform !== "darwin") variants.add(`${prefix}${quoted.normalize("NFD")}`);
    }
  }
  return [...variants];
}

function cronToolInputs(args) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const keyOf = (raw) => raw.trim().replace(/^(["'])(.*)\1$/, "$2").split(".").map((part) => part.trim()).join(".").replace(/^job\./, "");
  const inspect = (record, depth = 0) => {
    if (depth > 32) throw new Error("scheduler argument nesting exceeds its admission bound");
    for (const [raw, value] of Object.entries(record)) {
      const key = keyOf(raw);
      if (["action", "name", "sessionTargetName", "message", "text", "payload.message", "payload.text"].includes(key) && typeof value !== "string") throw new Error("scheduler prompt fields must be literal strings");
      if (["job", "data", "payload", "namePayload"].includes(key)) {
        if (!object(value)) throw new Error("scheduler argument containers must be literal objects");
        inspect(value, depth + 1);
      }
    }
  };
  // The native tool validator can decode JSON strings before execution. Admit
  // literal containers so prompt inspection sees the same authored values.
  inspect(args);
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (action === "wake") return { messages: [args.text], directories: [] };
  if (!["add", "update"].includes(action)) return { messages: [], directories: [] };
  const nested = object(args.job) && Object.keys(args.job).length > 0;
  let job = nested ? args.job : args;
  if (nested) job = object(job.data) ? job.data : object(job.job) ? job.job : job;
  const messages = [];
  const directories = [];
  // Inspect possible prompt fields in the pinned tool's nested, flat, padded
  // and dotted forms. Leave its normalization and non-prompt fields unchanged.
  for (const [raw, value] of Object.entries(job)) {
    const key = keyOf(raw);
    if (["name", "sessionTargetName", "message", "text", "payload.message", "payload.text"].includes(key)) messages.push(value);
    if (["payload", "namePayload"].includes(key) && object(value)) messages.push(value.message, value.text);
    // The native scheduler recovers flat/dotted cwd and scheduleKind objects
    // before launching stream commands. Inspect them before that recovery.
    if (["cwd", "schedule.cwd"].includes(key)) directories.push(value);
    if (["schedule", "scheduleKind"].includes(key)) {
      if (key === "scheduleKind" && ["at", "every", "cron", "on-exit", "stream"].includes(value)) continue;
      if (!object(value)) throw new Error("scheduler schedule containers must be literal objects");
      if (Object.hasOwn(value, "cwd")) directories.push(value.cwd);
    }
  }
  return { messages, directories };
}

export async function validateRunDestinations(command, context) {
  const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
  validateOcmSnapshotBoundary(tokens);
  const roots = await Promise.all([context.run, ...(context.ownedRoots ?? [])].map(physicalPath));
  const owned = async (path, allowed = roots) => {
    const physical = await physicalPath(resolve(context.cwd, path));
    if (await isPrivateVerificationIdentity(physical, { allowMissing: true })) throw new Error("private verification inputs are not command destinations");
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
    await context.observeCredentialPaths?.(env);
  };
  const toolDestination = async (path, { mutatingFile = false, filePath = mutatingFile, repairXml = filePath } = {}) => {
    if (typeof path !== "string" || !isAbsolute(path) || path !== path.trim() || path.includes("${") || path.includes("\0")) throw new Error("tool destinations must be direct canonical absolute owned paths");
    // OpenClaw repairs these destination spellings before resolving the target.
    if (repairXml && /<\/arg_value>>+$/.test(path) || filePath && /\.(doc|ppt|xls)(?:odex|codex|xodex|xcodex)$/i.test(path)) throw new Error("tool destinations must not require path repair");
    const physical = await productDestination(path);
    if (physical !== path) throw new Error("tool destinations must use canonical paths without aliases");
    if (mutatingFile && (await Promise.all((context.configPaths ?? []).map(physicalPath))).includes(physical)) throw new Error("tool writes cannot replace clone configuration; use config patch");
    return physical;
  };
  const validateCreationSource = (params) => {
    const selectors = ["projectId", "projectGitUrl", "repository", "catalogId", "execNode", "worktreeName", "worktreeBaseRef"];
    const hasSelector = selectors.some((field) => [field, field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)].some((key) => Object.hasOwn(params, key)));
    const placement = params.placement;
    const local = placement && typeof placement === "object" && !Array.isArray(placement) && placement.kind === "local" && Object.keys(placement).length === 1;
    if (hasSelector || Object.hasOwn(params, "placement") && !local || Object.hasOwn(params, "worktree") && params.worktree !== false) {
      throw new Error("creation requires a locally owned workspace; project, remote and managed worktree selectors are unsupported");
    }
  };
  const fileToolPolicies = new Map();
  const validateTool = async (name, args, env, depth = 0) => {
    if (depth > 32) throw new Error("tool request nesting exceeds its admission bound");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
    if (["read", "write", "edit"].includes(name) && Object.hasOwn(args, "file_path")) throw new Error("file tool destinations require canonical path arguments");
    if (["read", "write", "edit"].includes(name) && args.path !== undefined) {
      const path = await toolDestination(args.path, { mutatingFile: name !== "read", filePath: true });
      if (typeof context.readFilePolicy !== "function") throw new Error("file tools require the copied environment's file policy");
      if (!fileToolPolicies.has(env)) fileToolPolicies.set(env, Promise.resolve(context.readFilePolicy(env)).then((policy) => createStateFileIdentityResolver(policy, { allowMissing: true })));
      const identities = await fileToolPolicies.get(env);
      const paths = name === "read" ? await Promise.all(readPathCandidates(path).map((candidate) => productDestination(candidate))) : [path];
      if (requiresStateFileFiltering(await identities.resolve(paths), identities.policy)) throw new Error("file tools touching protected files require filtered file capture");
    }
    if (name === "exec") {
      if (Object.hasOwn(args, "node") || Object.hasOwn(args, "host") && !["auto", "sandbox", "gateway"].includes(args.host)) throw new Error("exec requires a locally owned destination");
      for (const field of ["workdir", "cwd"]) if (args[field] !== undefined) await toolDestination(args[field], { repairXml: field === "workdir" });
    }
    if (name === "sessions_spawn") validateCreationSource(args);
    if (["sessions_spawn", "sessions"].includes(name) && args.cwd !== undefined) await toolDestination(args.cwd);
    if (name === "tool_call") {
      if (typeof args.id !== "string" || !/^(?:openclaw:core:)?[a-zA-Z][a-zA-Z0-9_-]*$/.test(args.id.trim()) || Object.keys(args).some((key) => !["id", "args"].includes(key))) throw new Error("tool_call admission requires a canonical tool id and nested args");
      await validateTool(args.id.trim().replace(/^openclaw:core:/, ""), args.args, env, depth + 1);
    }
    const prompt = name === "sessions_spawn" ? "task" : ["sessions_send", "sessions"].includes(name) ? "message" : null;
    if (prompt && Object.hasOwn(args, prompt)) {
      if (typeof args[prompt] !== "string") throw new Error("tool prompt fields must be literal strings");
      await validateMessage(args[prompt], env, depth + 1);
    }
    if (["automations", "cron"].includes(name)) {
      const { messages, directories } = cronToolInputs(args);
      for (const directory of directories) await toolDestination(directory);
      for (const message of messages) await validateMockRequest(message, env, depth + 1);
    }
  };
  const inspectedMockMessages = new Set();
  const validateMockRequest = async (message, env, depth = 0) => {
    // Normalization and removal of external data can each change which request
    // the mock selects. Check every view without changing the outgoing bytes.
    const views = [message, normalizeSessionMessage(message)].filter((text) => typeof text === "string");
    for (const text of new Set(views.flatMap((text) => [text, mockInstructionText(text)]))) {
      if (typeof text !== "string" || inspectedMockMessages.has(text)) continue;
      inspectedMockMessages.add(text);
      // Authored input cannot exempt itself by spelling an external-data label;
      // the model parser separately ignores blocks actually wrapped by OpenClaw.
      verificationRequest(text, { includeExternalContent: true });
      // Later prompt composition can join a data boundary across fields. Check
      // every authored request, not only the first one currently selected.
      for (const tool of requestedMockTools(text, { includeExternalContent: true })) await validateTool(tool.name, tool.arguments, env, depth + 1);
    }
  };
  const validateConfigurationMessage = async (message, env) => {
    const mutation = inspectSessionMessage(message);
    if (!mutation) return;
    if (mutation.debug && mutation.action === "unset" && runtimeConfigPathPatterns.some((pattern) => mutation.path.every((part, index) => pattern[index] === "*" || pattern[index] === part))) throw new Error("debug storage path changes require observable runtime configuration");
    if (mutation.debug && (mutation.action === "reset" || mutation.action === "unset" && mutation.path[0] === "logging")) {
      const current = await context.readConfiguration?.(env);
      await validateConfiguration({ logging: current?.logging ?? null }, env);
    } else {
      if (!mutation.debug && mutation.action === "set" && mutation.path.length === 1 && mutation.path[0] === "logging" && typeof mutation.value?.file !== "string") throw new Error("config replacement must preserve the owned product log destination");
      const patch = mutation.path.reduceRight((value, key) => ({ [key]: value }), mutation.value);
      await validateConfiguration(patch, env, { debug: mutation.debug });
    }
  };
  const validateMessage = async (message, env, depth = 0) => {
    await validateMockRequest(message, env, depth);
    await validateConfigurationMessage(message, env);
  };
  for (const flag of ["--out", "--handle", "--wait", "--from", "--session-from", "--merge-from", "--target-from", "--gateway-handle", "--handoff-from", "--url-from", "--incognito-handle"]) {
    const value = option(tokens, flag);
    if (value !== undefined) {
      const physical = await owned(value, outputRoot);
      if (flag === "--gateway-handle") await owned(`${value}.d`, outputRoot);
      if (["--out", "--handle"].includes(flag)) {
        const parts = relative(outputRoot[0], physical).split(sep);
        if (/^(checkpoints|initial-state|\.persona|\.inputs|extra-\d+|mock-\d+)$/.test(parts[0]) || parts.some((part) => part.endsWith(".d") || /^persona-gateway-\d+\.json$/.test(part))) throw new Error("output overlaps protected evidence or a background operation");
      }
    }
  }
  if (tokens[0] === "node" && tokens[1] === join(context.kovaRoot ?? "", "support/verify/agent-tool-turn.mjs")) {
    const options = parseScriptArgs(toolDefinition, tokens.slice(2));
    if (!options.wait) {
      const input = { read: (path) => readJson(path, { signal: context.signal }) };
      const caller = await scriptSessionKey(options, input);
      const args = await toolArguments(options, input, caller);
      await validateMockRequest(toolMessage(options.tool, args), options.env);
      const frozen = [];
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (["--args", "--session-key", "--session-from", "--merge-from", "--from"].some((flag) => token === flag || token.startsWith(`${flag}=`))) {
          if (!token.includes("=")) index++;
        } else frozen.push(token);
      }
      frozen.push("--session-key", caller, "--args", JSON.stringify(args));
      return frozen.map(q).join(" ");
    }
  }
  if (tokens[0] === "node") {
    const helper = tokens[1];
    if (helper === join(context.kovaRoot ?? "", "support/verify/goal-control.mjs") && option(tokens, "--action") === "resume") {
      const options = parseScriptArgs(goalDefinition, tokens.slice(2));
      const { params } = await resolveGoalRequest(options, { read: (path) => readJson(path, { signal: context.signal }) });
      await validateMockRequest(params.note, options.env);
      if (!options.replay) return command;
      const frozen = [];
      for (let index = 0; index < tokens.length; index++) {
        if (tokens[index] === "--note") index++;
        else if (!tokens[index].startsWith("--note=")) frozen.push(tokens[index]);
      }
      // Replay checks this inline value against its saved request before RPC.
      // Empty and omitted notes both contribute no operator text.
      frozen.push("--note", params.note ?? "");
      return frozen.map(q).join(" ");
    }
    const messageFlag = helper === join(context.kovaRoot ?? "", "support/verify/chat-send.mjs") ? "--message"
      : helper === join(context.kovaRoot ?? "", "support/verify/channel-inbound-turn.mjs") ? "--text" : null;
    if (messageFlag && option(tokens, "--wait") === undefined) {
      const env = option(tokens, "--env");
      let message = option(tokens, messageFlag);
      if (messageFlag === "--text") {
        await validateMockRequest(message, env);
        inspectSessionMessage(message);
        if (typeof context.normalizeProbeCommand !== "function") throw new Error("channel commands require probe command normalization");
        const normalized = await context.normalizeProbeCommand(env, inboundParams({ text: message, peer: option(tokens, "--peer"), "chat-type": option(tokens, "--chat-type") }));
        if (normalized?.ok !== true || typeof normalized.commandBody !== "string" || typeof normalized.commandText !== "string" || typeof normalized.agentId !== "string" || !normalized.agentId || typeof normalized.sessionKey !== "string" || !normalized.sessionKey) throw new Error("probe command normalization is unavailable");
        // Bash consumes the full input even when the command SDK returns a short
        // canonical verb. Configuration admission still uses the canonical form.
        if (normalized.commandBody === "/bash" || normalized.commandBody.startsWith("/bash ") || normalized.commandBody.startsWith("!")) inspectSessionMessage(normalized.commandText);
        message = normalized.commandBody;
      }
      if (messageFlag === "--text") await validateConfigurationMessage(message, env);
      else await validateMessage(message, env);
    }
  }
  if (tokens[0] === "node" && tokens[1] === join(context.kovaRoot ?? "", "support/verify/gateway-call.mjs")) {
    const options = parseGatewayCallArgs(tokens.slice(2));
    if (!options.wait) {
      const params = await resolveGatewayParams(options, { signal: context.signal });
      if (options.method === "sessions.create") await validateMessage(typeof params.task === "string" && params.task.trim() ? params.task : params.message, options.env);
      if (["chat.send", "sessions.send"].includes(options.method)) await validateMessage(params.message, options.env);
      if (options.method === "sessions.goal.update" && params.action === "resume") await validateMockRequest(params.note, options.env);
      if (options.method === "sessions.companion.ask") {
        await validateMockRequest(params.question, options.env);
        if (typeof params.selectionContext === "string") await validateMockRequest(params.selectionContext.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"), options.env);
      }
      if (options.method === "sessions.create") validateCreationSource(params);
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
  if (tokens[0] === "ocm" && tokens[1]?.startsWith("@") && tokens[2] === "--" && tokens[3] === "cron" && tokens[4] === "add") {
    // The admitted form contains only scheduling metadata, names and prompt
    // text. Inspect each operand, including --flag=value and positionals after
    // --, without introducing a second CLI parser or changing outgoing bytes.
    for (const token of tokens.slice(5)) await validateMockRequest(token.trim(), tokens[1].slice(1));
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
  if (tokens[0] === "ocm" && tokens[1]?.startsWith("@") && tokens[3] === "config" && tokens[4] === "unset") await context.observeCredentialPaths?.(tokens[1].slice(1));
  if (tokens[0] === "ocm" && tokens[1]?.startsWith("@") && tokens[3] === "config" && tokens[4] === "patch") {
    const bytes = await readFile(await owned(option(tokens, "--file")));
    const patch = JSON5.parse(bytes.toString("utf8"));
    await validateConfiguration(patch, tokens[1].slice(1));
    const inputRoot = await owned(context.cwd, productRoots);
    const inputDirectory = await mkdtemp(join(inputRoot, ".kova-private-"));
    const frozenPath = join(inputDirectory, "patch.json");
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
  if (options.execute && process.env.KOVA_OCM_TRANSPORT_JSON !== undefined) throw new Error("verify run requires native OCM on the execution host; KOVA_OCM_TRANSPORT_JSON is unsupported");
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
    validateOcmSnapshotBoundary(tokens);
    // Import reads runtime ownership while start can change it, including aliases.
    const preparesRuntime = tokens[0] === "ocm" && (tokens[1] === "start" || tokens[1] === "env" && tokens[2] === "import");
    if (!preparesRuntime) return await perform();
    const previous = admission;
    let release;
    admission = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await perform(); }
    finally { release(); }
  };
  const executionEnv = { KOVA_OPENCLAW_CONFIG_CONTRACT: "canonical", OPENCLAW_CONFIG_PATH: "", OPENCLAW_GATEWAY_TOKEN: "", OPENCLAW_GATEWAY_PASSWORD: "", OPENCLAW_MCP_TOKEN: "", OPENCLAW_TTS_PREFS: "", OPENCLAW_CACHE_TRACE_FILE: "" };
  const invoke = (cancelable) => async (command, options = {}) => {
    const { observeResult, attachmentLogs, stateTextPolicies, publishAttachmentPolicy, ...executeOptions } = options;
    if (cancelable) signal?.throwIfAborted();
    const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    const attachment = tokens[0] === "ocm" && tokens[1]?.startsWith("@") && tokens[2] === "--" && tokens[3] === "attach" && tokens.includes("--print-config");
    let temporaryEnv;
    if (attachment) {
      if (!isAbsolute(executeOptions.cwd ?? "")) throw new Error("attachment requires a disposable working directory");
      const path = await mkdtemp(join(executeOptions.cwd, ".kova-private-"));
      temporaryEnv = { TMPDIR: path, TMP: path, TEMP: path };
    }
    let observed, result;
    if (attachment) attachmentLogs?.begin();
    try {
      if (attachment) await publishAttachmentPolicy?.();
      observed = await bind(command, () => {
        if (cancelable) signal?.throwIfAborted();
        const policies = typeof stateTextPolicies === "function" ? stateTextPolicies() : stateTextPolicies;
        return execute(command, { timeoutMs: 300000, finishOnShutdown: true, maxOutputChars: 16 * 1024 * 1024, ...executeOptions, env: { ...executeOptions.env, ...executionEnv, ...temporaryEnv, KOVA_VERIFY_STATE_POLICIES_JSON: policies ? JSON.stringify(policies) : "" } });
      });
      observeResult?.(observed);
      result = redactCommandResult(command, observed, attachmentLogs);
    } catch (error) {
      if (attachment) attachmentLogs?.markIncomplete();
      throw error;
    } finally {
      if (attachment) { attachmentLogs?.finish(); await publishAttachmentPolicy?.(); }
    }
    if (cancelable) signal?.throwIfAborted();
    if (!options.allowFailure && (result.status !== 0 || result.signal || result.timedOut || result.outputBudget?.truncated)) throw new Error(`command failed (${result.status}): ${command}: ${result.stderr || result.stdout}`);
    return result;
  };
  const call = invoke(true), cleanupCall = invoke(false);
  const normalizeProbeCommand = async (env, params) => {
    const method = "kova.channelProbe.normalizeCommand";
    const command = ["node", join(root, "support/verify/gateway-call.mjs"), "--env", env, "--method", method, "--params", JSON.stringify(params), "--timeout", "30000"].map(q).join(" ");
    const result = await call(command, { timeoutMs: 31000, finishOnShutdown: false });
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new Error("probe command normalization returned invalid JSON"); }
    if (response.method !== method || response.error !== null) throw new Error("probe command normalization failed");
    return response.result;
  };
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
        if (saved?.recordingFormat === recordingFormat && saved.key === key && canonicalJSON(saved.extras) === canonicalJSON(extras) && canonicalJSON(saved.files) === canonicalJSON(await fingerprintDirectory(cache)) && baselineNames.every((name) => saved.clones?.[name]?.started && !saved.clones[name].incomplete?.length && plan.phases.every((phase) => saved.clones[name].phases?.[phase.id] === "recorded"))) {
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
      const attachmentLogs = createAttachmentLogFilter();
      let clone;
      const copyCall = (command, options) => call(command, { ...options, attachmentLogs, stateTextPolicies: () => clone?.stateTextPolicies?.(), publishAttachmentPolicy: () => clone?.publishAttachmentPolicy?.() });
      const copyCleanupCall = (command, options) => cleanupCall(command, { ...options, attachmentLogs });
      clone = cloneFactory({ name, directory: join(directory, name), persona, root, call: copyCall, cleanupCall: copyCleanupCall, cleanupHandle, signal, executionEnv, attachmentLogs, validateCommand: (command, context) => validateRunDestinations(command, { ...context, signal, normalizeProbeCommand }) });
      resources.push({ clone, attachmentLogs });
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
      try {
        let metadata;
        try { metadata = await clone.prepare(); }
        finally {
          // Preparation runs the persona runtime, before any planned phase.
          // Keep its output without attributing it to the first target command.
          summary.preparation = { ...clone.preparation };
          try {
            const capture = await combineLogCollectors([logs, ...(clone.collectPreparationLogs ? [clone.collectPreparationLogs] : [])]).prepare();
            summary.preparation.logs = attachmentLogs.redact(capture.text);
            capture.commit();
          } catch (error) { summary.preparation.captureError = error.message; }
        }
        summary.env = metadata.name;
        const initialPaths = plan.phases.flatMap((phase) => phase.checkpoint.filter((name) => name.startsWith("state:")).map((name) => name.slice(6)));
        await snapshotState(metadata.stateDir, initialPaths, join(clone.directory, "initial-state"), initialPaths.length ? await clone.stateTextPolicy?.() : undefined);
        for (const phase of plan.phases) {
          signal?.throwIfAborted();
          const context = { cwd: metadata.root, ownedRoots: [metadata.root], ...clone.context(), standard: phase.from === "standard", signal, normalizeProbeCommand, target: targets[name.startsWith("change") ? "change" : "baseline"].runtime };
          const results = [];
          const logErrors = [];
          // Each phase owns only bytes emitted after its entry, even when the
          // previous phase omitted logs or its checkpoint could not publish.
          if (phase.checkpoint.includes("logs")) {
            try { (await logs.prepare({ skipExisting: true })).commit(); }
            catch (error) { logErrors.push(`phase start: ${error.message}`); }
          }
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
            let resolved = command, result, fixtureHandle;
            try {
              resolved = resolveRunCommand(command, commandContext);
              resolved = await validateRunDestinations(resolved, commandContext);
              if (entry.id === "stage-session-store-fixture") fixtureHandle = option(parseCatalogueCommand(resolved, { standard: context.standard }).tokens, "--gateway-handle");
            }
            catch (error) {
              signal?.throwIfAborted();
              const rejected = gatewayFailure(option(tokens, "--method") ?? entry.id, new CallError(error.message), startedAt);
              result = { command: resolved, status: rejected.exitCode, stdout: json(rejected.output), stderr: "", durationMs: Date.now() - startedAt, timedOut: false };
            }
            const cleanupMs = entry.id === "stage-session-store-fixture" ? gatewayFixtureCleanupMs : 0;
            result ??= await copyCall(resolved, { cwd: commandContext.cwd, timeoutMs: timeoutMs + delay + cleanupMs + (entry.kind === "gateway" || entry.kind === "script" ? 1000 : 0), allowFailure: true, finishOnShutdown: entry.id === "stage-session-store-fixture", observeResult });
            observeResult(result);
            result.reachedBound = result.timedOut || (["gateway", "script"].includes(entry.kind) && result.status === 3);
            results.push(result);
            if (fixtureHandle) {
              try { await assertFixtureRecoveryComplete(fixtureHandle); }
              catch (error) {
                summary.incomplete.push(phase.id);
                if (!record.incomplete.includes(phase.id)) record.incomplete.push(phase.id);
                throw new Error(`${error.message} in ${phase.id}; later commands and checkpoints were not run`);
              }
            }
            // Retain a destination even if another command restores the prior config.
            try { await clone.observeProductLogs?.(resolved); } catch (error) { logErrors.push(error.message); }
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
            const stateTextPolicy = phase.checkpoint.some((name) => name.startsWith("state:")) ? await clone.stateTextPolicy?.() : undefined;
            await writeCheckpoint({ phase, directory: clone.directory, results, stateDirectory: metadata.stateDir, stateTextPolicy, collectLogs: logs, screenPath, attachmentLogs });
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
  for (const { clone, attachmentLogs } of resources) {
    try { await clone.cleanup(); } catch (error) { record.cleanupErrors.push(error.message); }
    finally { attachmentLogs.dispose(); }
  }
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
      await writeFile(join(temporary, "cache.json"), json({ recordingFormat, key, extras: record.cache.extras, files: await fingerprintDirectory(temporary), clones: Object.fromEntries(baselineNames.map((name) => [name, record.clones[name]])) }), { mode: 0o600 });
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
