import { constants } from "node:fs";
import JSON5 from "json5";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { runCommand } from "../commands.mjs";
import { parseCatalogueCommand } from "../catalogue.mjs";
import { createdIds } from "./ids.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function parseOutput(text) {
  try { return { json: true, value: JSON.parse(text) }; }
  catch { return { json: false, value: text }; }
}

export function isPrivateVerificationPath(path) {
  return typeof path === "string" && /(?:^|[\\/])\.kova-private-[A-Za-z0-9]{6}(?:[\\/]|$)/.test(path);
}

export async function isPrivateVerificationIdentity(path, { allowMissing = false } = {}) {
  if (isPrivateVerificationPath(path)) return true;
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const absolute = resolve(path), root = parsePath(absolute).root;
  let parent = root;
  for (const component of absolute.slice(root.length).split(sep)) {
    const observedPath = join(parent, component);
    const folded = caseIdentityIndex(component);
    if (/^\.kova-private-[a-z0-9]{6}$/.test(folded)) {
      const native = join(parent, folded);
      let observed, declared;
      try { observed = await stat(observedPath, { bigint: true }); }
      catch (error) { if (allowMissing && error.code === "ENOENT") return false; throw new Error("cannot establish private verification file identity"); }
      try { declared = await stat(native, { bigint: true }); }
      catch (error) { if (error.code === "ENOENT") { parent = observedPath; continue; } throw new Error("cannot establish private verification file identity"); }
      if (observed.dev === declared.dev && observed.ino === declared.ino &&
          (observed.isDirectory() && declared.isDirectory() || observed.isFile() && declared.isFile())) return true;
    }
    parent = observedPath;
  }
  return false;
}

function firstJsonObject(text) {
  if (typeof text !== "string" || text.length > 16 * 1024 * 1024) throw new Error();
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== "{") throw new Error();
  const stack = [];
  let quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (stack.length >= 128) throw new Error();
      stack.push(char);
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) throw new Error();
      if (!stack.length) return { value: JSON.parse(text.slice(start, index + 1)), prefix: text.slice(0, start), suffix: text.slice(index + 1) };
    }
  }
  throw new Error();
}

function credentialForms(value) {
  return value ? [...new Set([value, JSON.stringify(value).slice(1, -1)])].sort((left, right) => right.length - left.length) : [];
}

const observedLogBudgetMs = 30000;
const observedLogChunkBytes = 64 * 1024;
const checksumBase = 257;
const increment = (stats, name, value = 1) => { if (stats) stats[name] = (stats[name] ?? 0) + value; };
const scanTime = (deadlineMs) => { if (Date.now() >= deadlineMs) throw new Error("observed log projection exceeded its time budget"); };

function checksum(bytes, deadlineMs) {
  let value = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (deadlineMs !== undefined && (index & 65535) === 0) scanTime(deadlineMs);
    value = (Math.imul(value, checksumBase) + bytes[index]) >>> 0;
  }
  return value;
}

function validateObservedLogContext(value) {
  if (!value || typeof value.owner !== "string" || !value.owner || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.pending !== "boolean" || typeof value.incomplete !== "boolean" || !Array.isArray(value.fingerprints) ||
      value.fingerprints.some((entry) => !entry || Object.keys(entry).length !== 3 || !Number.isSafeInteger(entry.length) || entry.length < 1 || entry.length > 96 * 1024 * 1024 ||
        !Number.isInteger(entry.checksum) || entry.checksum < 0 || entry.checksum > 0xffffffff || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256))) throw new Error("invalid observed log credential context");
  return value;
}

function mergeObservedLogs(rules) {
  const owners = new Map();
  for (const input of rules) {
    const rule = validateObservedLogContext(input);
    for (const field of ["paths", "datedDirectories"]) if (!Array.isArray(rule[field]) || rule[field].some((path) => typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))) throw new Error("invalid observed product log declaration");
    const prior = owners.get(rule.owner);
    if (prior && prior.revision === rule.revision && (prior.pending !== rule.pending || prior.incomplete !== rule.incomplete)) throw new Error("conflicting observed log credential revisions");
    const current = !prior || rule.revision > prior.revision ? rule : prior;
    owners.set(rule.owner, {
      owner: rule.owner, revision: current.revision, pending: current.pending, incomplete: Boolean(prior?.incomplete || rule.incomplete),
      fingerprints: [...new Map([...(prior?.fingerprints ?? []), ...rule.fingerprints].map((entry) => [JSON.stringify(entry), entry])).values()],
      paths: [...new Set([...(prior?.paths ?? []), ...rule.paths])],
      datedDirectories: [...new Set([...(prior?.datedDirectories ?? []), ...rule.datedDirectories])]
    });
  }
  return [...owners.values()];
}

function compileObservedLogs(contexts) {
  const groups = new Map();
  for (const context of contexts) {
    validateObservedLogContext(context);
    if (context.pending) throw new Error("cannot safely capture logs while native attach output is pending");
    if (context.incomplete) throw new Error("cannot safely capture logs after incomplete native attach output");
    for (const entry of context.fingerprints) {
      let group = groups.get(entry.length);
      if (!group) {
        let power = 1, factor = checksumBase, exponent = entry.length - 1;
        while (exponent) {
          if (exponent % 2) power = Math.imul(power, factor) >>> 0;
          factor = Math.imul(factor, factor) >>> 0; exponent = Math.floor(exponent / 2);
        }
        group = { length: entry.length, power, checksums: new Map() }; groups.set(entry.length, group);
      }
      const hashes = group.checksums.get(entry.checksum) ?? new Set();
      hashes.add(entry.sha256); group.checksums.set(entry.checksum, hashes);
    }
  }
  return [...groups.values()];
}

// The rolling checksum only avoids expensive candidates. Every removal is
// confirmed by SHA-256 of the complete original byte window, without regexes.
function markObservedBytes(bytes, groups, deadlineMs, stats, mask = null) {
  scanTime(deadlineMs); increment(stats, "bytes", bytes.length);
  for (const group of groups) {
    const { length, power, checksums } = group;
    if (length > bytes.length) continue;
    let sum = checksum(bytes.subarray(0, length), deadlineMs);
    for (let index = 0; index <= bytes.length - length; index++) {
      if ((index & 4095) === 0) scanTime(deadlineMs);
      if (index) sum = (Math.imul((sum - Math.imul(bytes[index - 1], power)) >>> 0, checksumBase) + bytes[index + length - 1]) >>> 0;
      increment(stats, "windows");
      const hashes = checksums.get(sum);
      if (!hashes) continue;
      increment(stats, "checksumHits"); increment(stats, "sha256Checks");
      if (!hashes.has(createHash("sha256").update(bytes.subarray(index, index + length)).digest("hex"))) continue;
      mask ??= new Uint8Array(bytes.length);
      mask.fill(1, index, index + length); increment(stats, "matches");
    }
  }
  return mask;
}

function unmarkedBytes(bytes, mask, end = bytes.length, deadlineMs) {
  if (!mask) return bytes.subarray(0, end);
  const output = Buffer.allocUnsafe(end);
  let written = 0, start = 0;
  for (let index = 0; index < end; index++) {
    if (deadlineMs !== undefined && (index & 65535) === 0) scanTime(deadlineMs);
    if (mask[index]) {
      if (index > start) written += bytes.copy(output, written, start, index);
      start = index + 1;
    }
  }
  if (start < end) written += bytes.copy(output, written, start, end);
  return output.subarray(0, written);
}

function completeLogRecord(bytes, active) {
  if (active && bytes.length && bytes.at(-1) !== 10) throw new Error("cannot capture an incomplete native product log record");
}

function matchingLogContexts(paths, policy) {
  paths = stateFileIdentities(paths, policy);
  return (policy?.observedLogs ?? []).filter((rule) => paths.some((path) => {
    if (typeof path !== "string" || !isAbsolute(path)) return false;
    const actual = resolve(path);
    return rule.paths.includes(actual) || rule.datedDirectories.some((directory) => /^openclaw-\d{4}-\d{2}-\d{2}(?:\.[1-5])?\.log$/.test(relative(directory, actual)));
  }));
}

export function projectStateLogBytes(paths, bytes, policy, { deadlineMs = Date.now() + observedLogBudgetMs, stats, projectedPolicy } = {}) {
  const contexts = matchingLogContexts(paths, policy);
  if (!contexts.length) return null;
  const groups = compileObservedLogs(contexts);
  // A successful retained result already applied this owner's log policy.
  // Repeating deletion could join ordinary fragments into a new false match.
  // Still check the latest pending/incomplete status above before replaying it.
  const applied = matchingLogContexts(paths, projectedPolicy);
  if (contexts.every((current) => applied.some((prior) => prior.owner === current.owner && prior.revision <= current.revision && !prior.pending && !prior.incomplete))) return bytes;
  completeLogRecord(bytes, groups.length > 0);
  return unmarkedBytes(bytes, markObservedBytes(bytes, groups, deadlineMs, stats), bytes.length, deadlineMs);
}

// Raw grant values are used only to derive exact-match descriptors here. Neither
// private child contexts nor retained operation envelopes contain those values.
export function createAttachmentLogFilter() {
  const fingerprints = new Map(), owner = randomUUID();
  let revision = 0, pending = 0, incomplete = false, disposed = false;
  const snapshot = () => ({ owner, revision, pending: pending > 0, incomplete, fingerprints: [...fingerprints.values()].map((entry) => ({ ...entry })) });
  const redactBytes = (bytes, { deadlineMs = Date.now() + observedLogBudgetMs, stats } = {}) => unmarkedBytes(bytes, markObservedBytes(bytes, compileObservedLogs([snapshot()]), deadlineMs, stats), bytes.length, deadlineMs);
  return {
    begin() { if (disposed) throw new Error("attachment capture is disposed"); pending++; revision++; },
    finish() { if (pending) { pending--; revision++; } },
    register(value) {
      if (disposed) throw new Error("attachment capture is disposed");
      for (const form of credentialForms(value)) {
        const bytes = Buffer.from(form), entry = { length: bytes.length, checksum: checksum(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
        if (!fingerprints.has(entry.sha256)) { fingerprints.set(entry.sha256, entry); revision++; }
      }
    },
    markIncomplete() { if (!incomplete) { incomplete = true; revision++; } },
    isActive: () => pending > 0 || incomplete || fingerprints.size > 0,
    snapshot, redactBytes,
    redact: (text) => redactBytes(Buffer.from(text)).toString("utf8"),
    dispose() { if (!disposed) { fingerprints.clear(); pending = 0; incomplete = true; revision++; disposed = true; } }
  };
}

export function redactCommandResult(command, result, attachmentLogs) {
  const { tokens, findings } = parseCatalogueCommand(command, { standard: true });
  if (findings.length || tokens[0] !== "ocm" || !/^@.+$/.test(tokens[1] ?? "") || tokens[2] !== "--" || tokens[3] !== "attach" || !tokens.slice(4).includes("--print-config")) return result;
  try {
    if (result.outputBudget?.truncated || typeof (result.stderr ?? "") !== "string") throw new Error();
    const { value, prefix, suffix } = firstJsonObject(result.stdout);
    const output = record(value), environment = record(output.env);
    const token = environment.OPENCLAW_MCP_TOKEN;
    if (typeof token !== "string") throw new Error();
    attachmentLogs?.register(token);
    const scrub = (text) => credentialForms(token).reduce((value, form) => value.replaceAll(form, ""), text);
    return {
      ...result,
      stdout: prefix + JSON.stringify({ ...output, env: { ...environment, OPENCLAW_MCP_TOKEN: "" } }, null, 2) + scrub(suffix),
      stderr: scrub(result.stderr ?? "")
    };
  } catch {
    attachmentLogs?.markIncomplete();
    const message = "cannot safely capture native attach output";
    return { ...result, stdout: "", stderr: message, captureError: message };
  }
}

function inside(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function statePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid checkpoint state path: ${JSON.stringify(value)}`);
  }
  return value;
}

async function sqliteFileType(path) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead === 16 && header.equals(Buffer.from("SQLite format 3\0"))) return "database";
    if (bytesRead >= 4 && [0x377f0682, 0x377f0683].includes(header.readUInt32BE(0))) return "wal";
    if (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from("d9d505f920a163d7", "hex"))) return "journal";
    return null;
  } finally { await file.close(); }
}

async function isSqliteSidecar(root, path) {
  const suffix = ["-wal", "-shm", "-journal"].find((value) => caseIdentityIndex(path).endsWith(value));
  if (!suffix) return false;
  const databasePath = path.slice(0, path.lastIndexOf("-"));
  if (!path.endsWith(suffix)) {
    const observed = await stat(path, { bigint: true });
    let declared;
    try { declared = await stat(databasePath + suffix, { bigint: true }); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!observed.isFile() || !declared.isFile() || observed.dev !== declared.dev || observed.ino !== declared.ino) return false;
  }
  let database;
  try { database = await realpath(databasePath); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!inside(root, database)) throw new Error(`checkpoint database escapes OpenClaw state directory: ${path}`);
  return (await lstat(database)).isFile() && await sqliteFileType(database) === "database";
}

// Generated credentials belong only in the environment and its private export.
// Keep rows and their nonsecret fields available for comparison.
const credentialColumns = {
  device_identities: { private_key_pem: "''" },
  device_auth_tokens: { token: "''" },
  gateway_origin_device_tokens: { token: "''" },
  device_bootstrap_tokens: { token_key: 'kova_redact_key("token_key")', token: "''" },
  device_pairing_paired: { tokens_json: 'kova_omit_role_tokens("tokens_json")' },
  device_pairing_join_codes: { shortcode: "''", payload_json: 'kova_omit_bootstrap_token("payload_json")' },
  channel_pairing_requests: { code: "''" },
  config_revision_keys: { hmac_key: "zeroblob(32)" },
  audit_identity_keys: { key: "zeroblob(32)" },
  config_machine_state: { value_json: 'kova_omit_private_key("value_json")' },
  native_hook_relay_bridges: { token: "''" },
  exec_approvals_config: { raw_json: 'kova_omit_socket_token("raw_json")' },
  secret_store_entries: { value: "''" },
  web_push_vapid_keys: { private_key: "''" }
};

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cannot capture malformed credential metadata");
  return value;
}

function omitField(value, name, required = false) {
  const object = record(value);
  if (!Object.hasOwn(object, name) && !required) return { ...object };
  if (typeof object[name] !== "string") throw new Error("cannot capture malformed credential metadata");
  return { ...object, [name]: "" };
}

function redactConfigCredential(value, references) {
  if (typeof value === "string") {
    const input = value.trim();
    if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(input) || references && /^(?:\$|secretref-env:|__env__:)[A-Z][A-Z0-9_]{0,127}$/.test(input)) return value;
    return "";
  }
  const ref = record(value);
  if (!references || Object.keys(ref).length !== 3 || !["source", "provider", "id"].every((key) => Object.hasOwn(ref, key)) ||
      typeof ref.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(ref.provider) || typeof ref.id !== "string") throw new Error("cannot capture malformed credential metadata");
  const validId = ref.source === "env" || ref.source === "store"
    ? /^[A-Z][A-Z0-9_]{0,127}$/.test(ref.id)
    : ref.source === "file"
      ? ref.id === "value" || ref.id.startsWith("/") && ref.id.slice(1).split("/").every((part) => /^(?:[^~]|~0|~1)*$/.test(part))
      : ref.source === "exec" && /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(ref.id) && !ref.id.split("/").some((part) => part === "." || part === "..");
  if (!validId) throw new Error("cannot capture malformed credential metadata");
  return { ...ref };
}

function redactConfigFields(value, fields, references) {
  const output = { ...record(value) };
  for (const field of fields) if (Object.hasOwn(output, field)) output[field] = redactConfigCredential(output[field], references);
  return output;
}

function redactedKey(value) {
  if (typeof value !== "string") throw new Error("cannot capture malformed credential metadata");
  return `redacted:${createHash("sha256").update(value).digest("hex")}`;
}

function omitRoleTokens(value) {
  return Object.fromEntries(Object.entries(record(value)).map(([role, entry]) => [role, omitField(entry, "token")]));
}

function omitBootstrapRecords(value) {
  return Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => [redactedKey(key), omitField(entry, "token", true)]));
}

function redactJson(text, redact, parse = JSON.parse) {
  try {
    return JSON.stringify(redact(parse(text)));
  } catch { throw new Error("cannot capture malformed credential metadata"); }
}

const configSuffix = /^(?:\.bak(?:\.\d+)?|\.(?:last-good|pre-update)|\.(?:rejected|clobbered)\.(?<timestamp>[0-9TZ-]+)|\.kova-[0-9a-f-]{36}|\.(?:\d+\.)?[0-9a-f-]{36}\.tmp)$/;
const caseConfigSuffix = new RegExp(configSuffix.source, "i");

function nativeConfigSuffix(value) {
  const match = caseConfigSuffix.exec(value);
  if (!match) return undefined;
  const lower = value.toLowerCase(), timestamp = match.groups?.timestamp;
  return timestamp ? lower.slice(0, -timestamp.length) + timestamp.toUpperCase() : lower;
}

function credentialTextRules(path, policy) {
  if (!policy || typeof path !== "string" || !isAbsolute(path)) return [];
  if (isPrivateKeyPath(path, policy)) return [{ kind: "privateKey" }];
  const absolute = resolve(path), rules = [];
  for (const entry of policy.configurations) {
    if (absolute === entry.path || absolute.startsWith(`${entry.path}.`) && configSuffix.test(absolute.slice(entry.path.length))) rules.push({ kind: "configuration", at: entry.at });
  }
  for (const root of policy.roots) {
    const local = relative(root, absolute).split(sep).join("/");
    if (/^\.?openclaw-config-backup[^/]*\/original$/.test(local)) rules.push({ kind: "configuration", at: [] });
    if (/^identity\/device\.json(?:\.(?:doctor|native)-importing)?$/.test(local)) rules.push({ kind: "identity" });
    if (/^identity\/device-auth\.json$/.test(local)) rules.push({ kind: "authentication" });
    if (/^devices\/paired\.json(?:\.migrated)?$/.test(local)) rules.push({ kind: "paired" });
    if (/^devices\/bootstrap\.json(?:\.migrated)?$/.test(local)) rules.push({ kind: "bootstrap" });
    if (/^exec-approvals\.json(?:\.doctor-importing|\.migrated\.[0-9a-f]{64}\.[0-9a-f-]{36})?$/.test(local)) rules.push({ kind: "approvals" });
    if (/^push\/vapid-keys\.json(?:\.doctor-importing)?$/.test(local)) rules.push({ kind: "vapid" });
    if (/^credentials\/[^/]+-pairing\.json(?:\.doctor-importing)?$/.test(local)) rules.push({ kind: "channelPairing" });
    if (/^nodes\/paired\.json(?:\.migrated)?$/.test(local)) rules.push({ kind: "nodes" });
    if (/^node\.json(?:\.doctor-importing)?$/.test(local)) rules.push({ kind: "node" });
  }
  return rules;
}

// These are OpenClaw-owned stores, not a filename-extension heuristic. A
// damaged header does not turn their remaining credential pages into text.
function credentialDatabaseKind(path, policy) {
  if (!policy || typeof path !== "string" || !isAbsolute(path)) return null;
  for (const root of policy.roots) {
    const local = relative(root, resolve(path)).split(sep).join("/");
    const match = /^(?:state\/openclaw\.sqlite|agents\/[^/]+\/agent\/openclaw-agent\.sqlite|(?:state|agents\/[^/]+\/agent)\/(?:\.sqlite-snapshot-|openclaw-index-recovery-)[^/]+\/database\.sqlite|state\/openclaw-task-delivery-recovery-[^/]+\/database\.sqlite)(.*)$/.exec(local);
    if (!match) continue;
    const suffix = match[1];
    // Update rollback retains the displaced native family under its run ID.
    // Generated IDs are UUIDs; other admitted IDs still identify databases.
    if (/^\.migrated-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?:wal|shm|journal)$/i.test(suffix)) return "sidecar";
    if (/^\.migrated-[a-zA-Z0-9_-]{1,128}$/.test(suffix)) return "database";
    if (!suffix || /^\.corrupt-\d+(?:\.\d+)?$/.test(suffix) || /^\.(?:pre-(?:startup|exec-approvals)-migration-|doctor-gateway-token\.)[0-9a-f-]{36}\.bak$/.test(suffix)) return "database";
    if (/^-(?:wal|shm|journal)(?:\.corrupt-\d+(?:\.\d+)?|\.orphaned-\d+(?:-\d+)?)?$/.test(suffix)) return "sidecar";
  }
  return null;
}

// Inventory declarations only; OpenClaw still owns merging and environment
// resolution. Include positions tell the recorder which fields a fragment owns.
export async function inventoryConfigurationFiles(configPath, config, { validatePath = async (path) => resolve(path) } = {}) {
  configPath = await validatePath(configPath);
  if (config === undefined) config = JSON5.parse(await readFile(configPath, "utf8"));
  const parsedFiles = new Map([[configPath, config]]), declarations = [];
  const visitFile = async (path, value, at, ancestors, depth) => {
    declarations.push({ path, at });
    await visit(value, path, at, ancestors, depth);
  };
  const visit = async (value, source, at, ancestors, depth) => {
    if (value === null || typeof value !== "object") return;
    if (!Array.isArray(value) && Object.hasOwn(value, "$include")) {
      const include = value.$include;
      if (typeof include !== "string" && !Array.isArray(include)) throw new Error("clone config include must be a string or array of strings");
      for (const entry of Array.isArray(include) ? include : [include]) {
        if (typeof entry !== "string" || !entry) throw new Error("clone config include paths must be non-empty strings");
        if (depth >= 10) throw new Error("clone config exceeds the maximum include depth of 10");
        const path = await validatePath(resolve(dirname(source), entry));
        if (ancestors.has(path)) throw new Error("clone config contains an include cycle");
        if (!parsedFiles.has(path)) parsedFiles.set(path, JSON5.parse(await readFile(path, "utf8")));
        await visitFile(path, parsedFiles.get(path), at, new Set([...ancestors, path]), depth + 1);
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== "$include") await visit(child, source, [...at, key], ancestors, depth);
  };
  await visitFile(configPath, config, [], new Set([configPath]), 0);
  return { paths: [...parsedFiles.keys()], declarations, fingerprint: createHash("sha256").update(JSON.stringify([...parsedFiles])).digest("hex") };
}

// Paths accumulate for a copy's lifetime; a config edit cannot declassify an
// existing key or previously active configuration file.
export function mergeStateTextPolicies(...policies) {
  policies = policies.filter(Boolean).map(validateStateTextPolicy);
  return {
    ...Object.fromEntries(["roots", "keys", "tlsDirectories"].map((field) => [field, [...new Set(policies.flatMap((policy) => policy[field]))]])),
    configurations: [...new Map(policies.flatMap((policy) => policy.configurations).map((entry) => [JSON.stringify(entry), entry])).values()],
    observedLogs: mergeObservedLogs(policies.flatMap((policy) => policy.observedLogs)),
    aliases: [...new Map(policies.flatMap((policy) => policy.aliases).map((entry) => [JSON.stringify(entry), entry])).values()]
  };
}

export async function createStateTextPolicy({ stateDirectory, homeDirectory, cwd, gateway = {}, configurations = [] }) {
  if (!isAbsolute(stateDirectory ?? "")) throw new Error("credential policy requires an absolute OpenClaw state directory");
  record(gateway);
  const canonical = async (path) => {
    try { return await realpath(path); }
    catch (error) { if (error.code === "ENOENT") return path; throw error; }
  };
  const roots = new Set(), correspondingRoots = [];
  const registerRoot = async (path, state = false) => {
    const logical = resolve(path), physical = await canonical(logical);
    if (logical !== physical) correspondingRoots.push([logical, physical]);
    if (state) { roots.add(logical); roots.add(physical); }
  };
  await registerRoot(stateDirectory, true);
  for (const path of [homeDirectory, cwd]) if (isAbsolute(path ?? "")) await registerRoot(path);
  let profiles = [];
  try { profiles = await readdir(join(stateDirectory, "profiles"), { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const entry of profiles) if ((entry.isDirectory() || entry.isSymbolicLink()) && /^\.openclaw-[^/]+$/i.test(entry.name)) {
    const path = join(stateDirectory, "profiles", entry.name);
    const native = join(stateDirectory, "profiles", entry.name.replace(/^\.openclaw-/i, ".openclaw-"));
    try {
      const actual = await stat(path, { bigint: true }), declared = native === path ? actual : await stat(native, { bigint: true });
      if (actual.isDirectory() && declared.isDirectory() && actual.dev === declared.dev && actual.ino === declared.ino) {
        await registerRoot(path, true);
        if (native !== path) await registerRoot(native, true);
      }
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const exactIdentities = async (path) => {
    const logical = resolve(path), physical = new Set([await canonical(logical)]);
    // Materialize equivalent identities from corresponding roots only. This
    // also works before a declared key exists, when realpath cannot resolve it.
    for (const [from, to] of correspondingRoots) if (inside(from, logical)) physical.add(resolve(to, relative(from, logical)));
    const identities = new Set([logical, ...physical]);
    for (const path of physical) for (const [from, to] of correspondingRoots) if (inside(to, path)) identities.add(resolve(from, relative(to, path)));
    return identities;
  };
  for (const root of [...roots]) for (const identity of await exactIdentities(root)) roots.add(identity);
  const keys = new Set(), tlsDirectories = new Set(), declaredConfig = [];
  const declareKey = async (path) => {
    for (const identity of await exactIdentities(path)) keys.add(identity);
    for (const identity of await exactIdentities(dirname(path))) tlsDirectories.add(identity);
  };
  for (const root of roots) {
    await declareKey(join(root, "gateway/tls/gateway-key.pem"));
    for (const name of ["openclaw.json", "openclaw.json5"]) declaredConfig.push({ path: join(root, name), at: [] });
  }
  for (const entry of configurations) {
    declaredConfig.push(entry);
    for (const identity of await exactIdentities(entry.path)) declaredConfig.push({ ...entry, path: identity });
  }
  const configured = gateway?.tls?.keyPath;
  if (configured !== undefined && typeof configured !== "string") throw new Error("invalid Gateway TLS key path declaration");
  if (configured?.trim()) {
    if (!isAbsolute(homeDirectory ?? "") || !isAbsolute(cwd ?? "")) throw new Error("credential policy requires the Gateway home and working directory");
    await declareKey(resolve(cwd, configured.trim().replace(/^~(?=$|[\\/])/, () => homeDirectory)));
  }
  return mergeStateTextPolicies({ roots: [...roots], keys: [...keys], tlsDirectories: [...tlsDirectories], configurations: declaredConfig });
}

// This is only an index: filesystem identity still authorizes every alias.
// Include canonical decomposition and expanding case mappings used by macOS.
function caseIdentityIndex(value) {
  return value.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
}

function fileCaseIndex(path) {
  return caseIdentityIndex(resolve(path));
}

export function validateStateTextPolicy(policy) {
  const fields = ["roots", "keys", "tlsDirectories"];
  if (!policy || typeof policy !== "object" || Object.keys(policy).some((key) => ![...fields, "configurations", "observedLogs", "aliases"].includes(key)) ||
      !fields.every((key) => Array.isArray(policy[key]) && policy[key].length > 0 && policy[key].every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0")))) {
    throw new Error("invalid retained credential path declarations");
  }
  // Earlier private envelopes declared only state roots and TLS paths.
  const configurations = policy.configurations ?? policy.roots.flatMap((root) => ["openclaw.json", "openclaw.json5"].map((name) => ({ path: join(root, name), at: [] })));
  if (!Array.isArray(configurations) || !configurations.every((entry) => entry && Object.keys(entry).length === 2 && typeof entry.path === "string" && isAbsolute(entry.path) && !entry.path.includes("\0") && Array.isArray(entry.at) && entry.at.every((part) => typeof part === "string"))) throw new Error("invalid retained configuration path declarations");
  const aliases = policy.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.some((entry) => !entry || Object.keys(entry).length !== 2 || ![entry.path, entry.target].every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0")) || entry.path === entry.target || fileCaseIndex(entry.path) !== fileCaseIndex(entry.target))) throw new Error("invalid retained file identity aliases");
  return { ...policy, configurations, observedLogs: mergeObservedLogs(policy.observedLogs ?? []), aliases };
}

function stateFileIdentities(paths, policy) {
  const aliases = new Map();
  for (const entry of policy?.aliases ?? []) {
    const targets = aliases.get(entry.path) ?? [];
    targets.push(entry.target); aliases.set(entry.path, targets);
  }
  return [...new Set(paths.flatMap((path) => [path, ...(typeof path === "string" && isAbsolute(path) ? aliases.get(resolve(path)) ?? [] : [])]))];
}

// Case folding finds candidates, never authorizes a match. Keep this index for
// one capture and re-stat every observed candidate: paths can be replaced while
// the copy lives. Only verified spellings travel with a retained result.
export function createStateFileIdentityResolver(input, { deadlineMs } = {}) {
  const policy = { ...validateStateTextPolicy(input), aliases: [] };
  const exact = new Map(), configurations = new Map(), directories = new Map(), directoryScopes = new Map();
  const index = (map, path) => {
    const key = fileCaseIndex(path), values = map.get(key) ?? new Set();
    values.add(resolve(path)); map.set(key, values);
  };
  const directoryScope = (path) => {
    path = resolve(path); index(directories, path);
    let scope = directoryScopes.get(path);
    if (!scope) { scope = { roots: [], keys: [], configurations: [], tlsDirectories: [], observedLogs: [] }; directoryScopes.set(path, scope); }
    return scope;
  };
  for (const path of policy.keys) index(exact, path);
  for (const entry of policy.configurations) { index(exact, entry.path); index(configurations, entry.path); }
  for (const path of policy.roots) directoryScope(path).roots.push(path);
  for (const path of policy.tlsDirectories) directoryScope(path).tlsDirectories.push(path);
  for (const context of policy.observedLogs) {
    for (const path of context.paths) index(exact, path);
    for (const path of context.datedDirectories) directoryScope(path).observedLogs.push({ ...context, paths: [], datedDirectories: [path] });
  }
  return {
    policy,
    async resolve(paths) {
      for (const raw of new Set(paths)) {
        if (typeof raw !== "string" || !isAbsolute(raw)) continue;
        if (await isPrivateVerificationIdentity(raw)) throw new Error("cannot capture private verification file contents");
        const path = resolve(raw), folded = fileCaseIndex(path);
        policy.aliases = policy.aliases.filter((entry) => entry.path !== path);
        const candidates = new Set(exact.get(folded));
        // Reuse the authoritative native rules for state-relative paths and
        // generated config backups instead of introducing another registry.
        for (let parent = dirname(path); ; parent = dirname(parent)) {
          for (const root of directories.get(fileCaseIndex(parent)) ?? []) {
            const candidate = resolve(root, relative(parent, path).toLowerCase());
            const scope = directoryScopes.get(root);
            if (credentialTextRules(candidate, scope).length || credentialDatabaseKind(candidate, scope) || matchingLogContexts([candidate], scope).length) candidates.add(candidate);
          }
          if (dirname(parent) === parent) break;
        }
        for (let dot = folded.lastIndexOf("."); dot > folded.lastIndexOf(sep); dot = folded.lastIndexOf(".", dot - 1)) {
          for (const base of configurations.get(folded.slice(0, dot)) ?? []) {
            const suffix = nativeConfigSuffix(folded.slice(dot));
            if (!suffix) continue;
            const candidate = base + suffix;
            candidates.add(candidate);
          }
        }
        candidates.delete(path);
        if (!candidates.size) continue;
        if (deadlineMs !== undefined) scanTime(deadlineMs);
        let observed;
        try { observed = await stat(path, { bigint: true }); }
        catch { throw new Error("cannot establish captured file identity"); }
        if (!observed.isFile()) throw new Error("captured file identity is not a regular file");
        for (const target of candidates) {
          if (deadlineMs !== undefined) scanTime(deadlineMs);
          let declared;
          try { declared = await stat(target, { bigint: true }); }
          catch (error) { if (error.code === "ENOENT") continue; throw new Error("cannot establish declared file identity"); }
          if (!declared.isFile() || observed.dev !== declared.dev || observed.ino !== declared.ino) continue;
          policy.aliases.push({ path, target });
        }
      }
      if (deadlineMs !== undefined) scanTime(deadlineMs);
      return stateFileIdentities(paths, policy);
    }
  };
}

function isPrivateKeyPath(path, policy) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const absolute = resolve(path);
  if (policy.keys.includes(absolute)) return true;
  for (const directory of policy.tlsDirectories) if (/^\.openclaw-gateway-tls-key-[^/]+\/key\.pem$/.test(relative(directory, absolute).split(sep).join("/"))) return true;
  for (const root of policy.roots) {
    const local = relative(root, absolute).split(sep).join("/");
    if (local === "config-journal-fingerprint.key") return true;
    if (/^(?:debug-proxy\/certs|secret-egress-proxy\/gateway-[^/]+)\/(?:\.root-ca-[^/]+\/)?(?:root-ca-key|leaf-key)\.pem$/.test(local)) return true;
  }
  return false;
}

const credentialTextRedactors = {
  configuration(value) {
    const config = { ...record(value) };
    if (Object.hasOwn(config, "hooks")) config.hooks = redactConfigFields(config.hooks, ["token"], false);
    if (Object.hasOwn(config, "gateway")) {
      config.gateway = { ...record(config.gateway) };
      for (const field of ["auth", "remote"]) if (Object.hasOwn(config.gateway, field)) config.gateway[field] = redactConfigFields(config.gateway[field], ["token", "password"], true);
    }
    return config;
  },
  identity(value) {
    if (!Object.hasOwn(record(value), "privateKeyPem") && !Object.hasOwn(value, "privateKey")) throw new Error("cannot capture malformed credential metadata");
    return omitField(omitField(value, "privateKeyPem"), "privateKey");
  },
  authentication: (value) => ({ ...record(value), tokens: omitRoleTokens(value.tokens) }),
  paired: (value) => Object.fromEntries(Object.entries(record(value)).map(([id, entry]) => {
    const device = record(entry);
    return [id, Object.hasOwn(device, "tokens") ? { ...device, tokens: omitRoleTokens(device.tokens) } : { ...device }];
  })),
  bootstrap: omitBootstrapRecords,
  approvals(value) {
    const output = { ...record(value) };
    if (Object.hasOwn(output, "socket")) output.socket = omitField(output.socket, "token");
    return output;
  },
  vapid: (value) => omitField(value, "privateKey"),
  channelPairing(value) {
    const output = { ...record(value) };
    if (!Array.isArray(output.requests)) throw new Error("cannot capture malformed credential metadata");
    output.requests = output.requests.map((entry) => omitField(entry, "code"));
    return output;
  },
  nodes: (value) => Object.fromEntries(Object.entries(record(value)).map(([id, entry]) => [id, omitField(entry, "token")])),
  node: (value) => omitField(value, "token")
};

// Apply the same policy to captured files and file bytes returned by the Gateway.
// Every known source identity contributes its policy; an alias cannot weaken it.
export function redactStateText(paths, contents, policy) {
  paths = stateFileIdentities(paths, policy);
  if (paths.some(isPrivateVerificationPath)) throw new Error("cannot capture private verification file contents");
  if (paths.some((path) => credentialDatabaseKind(path, policy))) throw new Error("database file responses require a filtered state snapshot");
  const rules = [...new Map(paths.flatMap((path) => credentialTextRules(path, policy)).map((rule) => [JSON.stringify(rule), rule])).values()];
  if (rules.some((rule) => rule.kind === "privateKey")) return "";
  if (!rules.length) return null;
  try {
    const text = typeof contents === "string" ? contents : new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return redactJson(text, (value) => rules.reduce((current, rule) => {
      if (rule.kind !== "configuration") return credentialTextRedactors[rule.kind](current);
      const wrapped = rule.at.reduceRight((child, key) => ({ [key]: child }), current);
      return rule.at.reduce((child, key) => child[key], credentialTextRedactors.configuration(wrapped));
    }, value), rules.some((rule) => rule.kind === "configuration") ? JSON5.parse : JSON.parse);
  } catch { throw new Error("cannot capture malformed credential metadata"); }
}

function requireWritableTable(database, name, requiredColumns) {
  const schema = database.prepare("SELECT type FROM sqlite_schema WHERE name = ? COLLATE NOCASE").get(name);
  if (!schema) return false;
  if (schema.type !== "table" || database.prepare("SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = ? COLLATE NOCASE").get(name)?.type !== "table" ||
      database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE").get(name)) throw new Error("cannot safely capture credential metadata schema");
  const fields = database.prepare(`PRAGMA table_info("${name}")`).all();
  if (requiredColumns.some((column) => !fields.some((field) => field.name.toLowerCase() === column))) throw new Error("cannot safely capture credential metadata schema");
  return true;
}

async function copyObservedLog(source, target, contexts) {
  const groups = compileObservedLogs(contexts);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (!groups.length) { await copyFile(source, target); return; }
  const deadlineMs = Date.now() + observedLogBudgetMs;
  const input = await open(source, "r");
  let output;
  try {
    const { size } = await input.stat();
    if (size) {
      const tail = Buffer.alloc(1);
      if ((await input.read(tail, 0, 1, size - 1)).bytesRead !== 1) throw new Error("product log changed during capture");
      completeLogRecord(tail, true);
    }
    output = await open(target, "wx", 0o600);
    let carry = Buffer.alloc(0), carryMask = null, readBytes = 0, lastByte;
    const overlap = Math.max(...groups.map((group) => group.length)) - 1;
    if (size) for await (const chunk of input.createReadStream({ start: 0, end: size - 1, highWaterMark: observedLogChunkBytes, autoClose: false })) {
      readBytes += chunk.length; lastByte = chunk.at(-1);
      const bytes = Buffer.concat([carry, chunk]);
      let mask = null;
      if (carryMask) { mask = new Uint8Array(bytes.length); mask.set(carryMask); }
      mask = markObservedBytes(bytes, groups, deadlineMs, undefined, mask);
      const end = Math.max(0, bytes.length - overlap);
      await output.writeFile(unmarkedBytes(bytes, mask, end, deadlineMs));
      carry = Buffer.from(bytes.subarray(end));
      carryMask = mask ? Uint8Array.from(mask.subarray(end)) : null;
    }
    if (readBytes !== size || size && lastByte !== 10) throw new Error("product log changed during capture");
    scanTime(deadlineMs);
    await output.writeFile(unmarkedBytes(carry, carryMask, carry.length, deadlineMs));
  } catch (error) {
    if (output) { await output.close(); output = undefined; await rm(target, { force: true }); }
    throw error;
  } finally { await output?.close(); await input.close(); }
}

async function snapshotFile(root, source, target, requested, identities) {
  const paths = await identities.resolve([source, requested]), policy = identities.policy;
  const databaseKinds = paths.map((path) => credentialDatabaseKind(path, policy));
  if (databaseKinds.includes("sidecar")) return;
  const logs = matchingLogContexts(paths, policy);
  const fileType = await sqliteFileType(source);
  if (databaseKinds.includes("database") && fileType !== "database") throw new Error("cannot safely capture an unreadable credential database");
  // Recognizable journal pages remain private even when the file has another name.
  if (fileType === "wal" || fileType === "journal") return;
  if (paths.some((path) => credentialTextRules(path, policy).length)) {
    const bytes = await readFile(source);
    const contents = redactStateText(paths, projectStateLogBytes(paths, bytes, policy) ?? bytes, policy);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents ? `${contents}\n` : "", { flag: "wx", mode: 0o600 });
    return;
  }
  if (logs.length && fileType !== "database") { await copyObservedLog(source, target, logs); return; }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (fileType !== "database") {
    await copyFile(source, target);
    return;
  }
  const { DatabaseSync, backup } = await import("node:sqlite");
  if (typeof backup !== "function") throw new Error("SQLite checkpoints require Node.js 22.16.0 or newer");
  // The unfiltered online backup stays inside the disposable environment as a
  // private export. No original database page is written to retained evidence.
  const temporary = await mkdtemp(join(root, ".kova-snapshot-"));
  const exported = join(temporary, "private.sqlite");
  let snapshot;
  try {
    const file = await open(exported, "wx", 0o600);
    await file.close();
    const database = new DatabaseSync(source, { readOnly: true });
    try { await backup(database, exported); }
    finally { database.close(); }
    snapshot = new DatabaseSync(exported);
    snapshot.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF");
    // Table names alone do not identify an OpenClaw credential store.
    if (databaseKinds.includes("database")) {
      snapshot.function("kova_redact_key", redactedKey);
      snapshot.function("kova_omit_role_tokens", (value) => redactJson(value, omitRoleTokens));
      snapshot.function("kova_omit_bootstrap_token", (value) => redactJson(value, (object) => omitField(object, "bootstrapToken", true)));
      snapshot.function("kova_omit_private_key", (value) => redactJson(value, (object) => omitField(object, "privateKey", true)));
      snapshot.function("kova_omit_socket_token", (value) => redactJson(value, credentialTextRedactors.approvals));
      const redactedTables = [];
      for (const [table, columns] of Object.entries(credentialColumns)) {
        const required = [...Object.keys(columns), ...(table === "config_machine_state" ? ["state_key"] : table === "secret_store_entries" ? ["kind"] : [])];
        if (!requireWritableTable(snapshot, table, required)) continue;
        const condition = table === "config_machine_state" ? " AND state_key = 'webPush.vapidKeys'" : table === "secret_store_entries" ? " AND kind = 'secret'" : "";
        for (const [column, value] of Object.entries(columns)) snapshot.exec(`UPDATE "${table}" SET "${column}" = ${value} WHERE "${column}" IS NOT NULL${condition}`);
        redactedTables.push(table);
      }
      for (const table of ["sqlite_stat2", "sqlite_stat3", "sqlite_stat4"]) {
        if (!requireWritableTable(snapshot, table, ["tbl"])) continue;
        const remove = snapshot.prepare(`DELETE FROM "${table}" WHERE tbl = ? COLLATE NOCASE`);
        for (const name of redactedTables) remove.run(name);
      }
    }
    // Rebuild the file to exclude deleted pages and overwritten credential bytes.
    // VACUUM INTO preserves rowids as well as the selected non-secret values.
    snapshot.prepare("VACUUM INTO ?").run(target);
  } finally {
    snapshot?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function snapshotPath(root, source, target, identities, ancestors = new Set()) {
  if (isPrivateVerificationPath(source)) return;
  let metadata;
  try { metadata = await lstat(source); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (await isPrivateVerificationIdentity(source)) return;
  const actual = await realpath(source);
  if (await isPrivateVerificationIdentity(actual)) return;
  if (!inside(root, actual)) throw new Error(`checkpoint state escapes OpenClaw state directory: ${source}`);
  if (ancestors.has(actual)) throw new Error(`checkpoint state contains a directory cycle: ${source}`);
  if (metadata.isSymbolicLink()) metadata = await lstat(actual);
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const visited = new Set([...ancestors, actual]);
    for (const name of (await readdir(actual)).sort()) {
      await snapshotPath(root, join(source, name), join(target, name), identities, visited);
    }
  } else if (metadata.isFile()) {
    // Direct selections and symbolic aliases use the same online database snapshot.
    if (await isSqliteSidecar(root, source) || (source !== actual && await isSqliteSidecar(root, actual))) return;
    await snapshotFile(root, actual, target, source, identities);
  } else throw new Error(`checkpoint state is not a file or directory: ${source}`);
}

export async function snapshotState(stateDirectory, paths, outputDirectory, policy) {
  const root = await realpath(stateDirectory);
  policy ??= await createStateTextPolicy({ stateDirectory });
  const identities = createStateFileIdentityResolver(policy);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const selected = [...new Set(paths.map(statePath))].sort();
  for (const path of selected) {
    if (selected.some((parent) => parent !== path && path.startsWith(`${parent}/`))) continue;
    await snapshotPath(root, resolve(root, path), join(outputDirectory, path), identities);
  }
}

export async function writeCheckpoint(options) {
  const attachmentLogs = options.attachmentLogs ?? createAttachmentLogFilter();
  try { return await captureCheckpoint({ ...options, attachmentLogs }); }
  finally { if (!options.attachmentLogs) attachmentLogs.dispose(); }
}

async function captureCheckpoint({ phase, directory, results, stateDirectory, stateTextPolicy, collectLogs, screenPath, attachmentLogs, captureError, creates = [] }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase.id)) throw new Error("invalid checkpoint phase id");
  results = results.map((result, index) => redactCommandResult(result.command ?? phase.commands?.[index], result, attachmentLogs));
  const destination = join(directory, "checkpoints", phase.id);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // Only complete captures use the canonical path consumed by comparison.
  const temporary = `${destination}.incomplete`;
  await mkdir(temporary, { mode: 0o700 });
  let logCapture;
  try {
    const responses = {};
    const commands = results.map((result, index) => {
      const output = parseOutput(result.stdout);
      if (output.json) responses[index] = output.value;
      return {
        command: result.command, exit: result.status, stdout: output.json ? null : result.stdout,
        ...(output.json ? { response: output.value } : {}),
        stderr: result.stderr, durationMs: result.durationMs, timedOut: result.timedOut === true,
        createdIds: output.json ? createdIds(output.value, creates[index % phase.commands.length] ?? []) : [],
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.outputBudget ? { outputBudget: result.outputBudget } : {})
      };
    });
    await writeFile(join(temporary, "commands.json"), json(commands), { mode: 0o600 });
    if (captureError) throw new Error(captureError);
    if (results.some((result) => result.captureError)) throw new Error("checkpoint command output could not be captured");
    if (results.some((result) => result.outputBudget?.truncated)) throw new Error("checkpoint command output was truncated");
    for (const signal of phase.checkpoint) {
      if (signal === "responses") await writeFile(join(temporary, "responses.json"), json(responses), { mode: 0o600 });
      else if (signal === "timing") await writeFile(join(temporary, "timing.json"), json(results.map((result) => ({ durationMs: result.durationMs, reachedBound: result.timedOut === true || result.reachedBound === true }))), { mode: 0o600 });
      else if (signal === "logs") {
        if (!collectLogs) throw new Error("log collector is required by checkpoint");
        logCapture ??= collectLogs.prepare ? await collectLogs.prepare() : { text: await collectLogs(), commit() {} };
        await writeFile(join(temporary, "logs.txt"), attachmentLogs.redact(logCapture.text), { mode: 0o600 });
      } else if (signal === "doctor") {
        await writeFile(join(temporary, "doctor.json"), json(results.map((result) => parseOutput(result.stdout).value)), { mode: 0o600 });
      } else if (signal === "screen") {
        if (!phase.browser || !screenPath) throw new Error("screen checkpoint requires a browser screenshot");
        const source = await open(screenPath, "r");
        try {
          const signature = Buffer.alloc(8);
          await source.read(signature, 0, 8, 0);
          if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("screen checkpoint is not a PNG");
        } finally { await source.close(); }
        await copyFile(screenPath, join(temporary, "screen.png"));
      } else if (!signal.startsWith("state:")) throw new Error(`unknown checkpoint signal: ${signal}`);
    }
    const paths = phase.checkpoint.filter((signal) => signal.startsWith("state:")).map((signal) => signal.slice(6));
    if (paths.length) await snapshotState(stateDirectory, paths, join(temporary, "state"), stateTextPolicy);
    await rename(temporary, destination);
    logCapture?.commit();
    return { path: destination, incomplete: commands.some((command) => command.exit === 2) };
  } catch (error) {
    await writeFile(join(temporary, "capture-error.json"), json({ error: error.message }), { mode: 0o600 });
    throw error;
  }
}

export async function recordPhase(options) {
  const { phase, execute = runCommand, env, bounds = [] } = options;
  const attachmentLogs = options.attachmentLogs ?? createAttachmentLogFilter();
  const results = [];
  try {
    for (const [index, command] of phase.commands.entries()) {
      const timeoutMs = bounds[index] ?? phase.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid phase command bound");
      results.push(redactCommandResult(command, await execute(command, { timeoutMs, env }), attachmentLogs));
    }
    return { ...await writeCheckpoint({ ...options, results, attachmentLogs }), results };
  } finally { if (!options.attachmentLogs) attachmentLogs.dispose(); }
}

export function createLogCollector(paths, { validatePath, trackIdentity = false, requireCompleteRecord } = {}) {
  const offsets = new Map();
  const prepare = async ({ maxBytes = 16 * 1024 * 1024, skipExisting = false, onlyNew = false, selectedPaths } = {}) => {
    const chunks = [];
    const pendingOffsets = new Map(offsets);
    let bytes = 0;
    const selected = selectedPaths ?? (typeof paths === "function" ? await paths() : paths);
    for (const path of new Set(selected)) {
      await validatePath?.(path);
      let file;
      try {
        if (!(await lstat(path)).isFile()) throw new Error(`log is not a regular file: ${path}`);
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || (validatePath && metadata.nlink !== 1)) throw new Error(`log is not an unaliased regular file: ${path}`);
        const key = trackIdentity ? `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}` : path;
        const previous = pendingOffsets.get(key);
        if (skipExisting && onlyNew && previous) continue;
        const start = skipExisting ? metadata.size : previous && previous.dev === metadata.dev && previous.ino === metadata.ino && previous.size <= metadata.size ? previous.size : 0;
        const completeRecord = requireCompleteRecord?.() === true;
        if (metadata.size > start && completeRecord) {
          const tail = Buffer.alloc(1);
          if ((await file.read(tail, 0, 1, metadata.size - 1)).bytesRead !== 1) throw new Error("product log changed during capture");
          completeLogRecord(tail, true);
        }
        bytes += metadata.size - start;
        if (bytes > maxBytes) throw new Error("log capture exceeds the 16 MiB output budget");
        if (metadata.size > start) {
          let readBytes = 0, lastByte;
          for await (const chunk of file.createReadStream({ start, end: metadata.size - 1, autoClose: false })) {
            chunks.push(chunk); readBytes += chunk.length; lastByte = chunk.at(-1);
          }
          if (completeRecord && (readBytes !== metadata.size - start || lastByte !== 10)) throw new Error("product log changed during capture");
        }
        pendingOffsets.set(key, { dev: metadata.dev, ino: metadata.ino, size: metadata.size });
      } finally {
        await file.close();
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error("log capture exceeds the 16 MiB output budget");
    return { text, bytes, commit() { for (const [key, value] of pendingOffsets) offsets.set(key, value); } };
  };
  return Object.assign(async () => { const result = await prepare(); result.commit(); return result.text; }, {
    prepare,
    hasIdentity: (key) => offsets.has(key),
    async seed(selectedPaths) { (await prepare({ skipExisting: true, onlyNew: true, selectedPaths })).commit(); }
  });
}

export function combineLogCollectors(collectors) {
  const prepare = async ({ maxBytes = 16 * 1024 * 1024, skipExisting = false } = {}) => {
    const selected = typeof collectors === "function" ? await collectors() : collectors;
    const captures = [];
    let bytes = 0;
    let nonempty = false;
    for (const collect of new Set(selected)) {
      if (typeof collect.prepare !== "function") throw new Error("combined log readers must support deferred capture");
      const capture = await collect.prepare({ maxBytes: maxBytes - bytes, skipExisting });
      if (capture.bytes > 0) {
        bytes += capture.bytes + (nonempty ? 1 : 0);
        nonempty = true;
        if (bytes > maxBytes) throw new Error("log capture exceeds the 16 MiB output budget");
      }
      captures.push(capture);
    }
    return {
      text: captures.map((capture) => capture.text).filter(Boolean).join("\n"), bytes,
      commit() { for (const capture of captures) capture.commit(); }
    };
  };
  return Object.assign(async () => { const result = await prepare(); result.commit(); return result.text; }, { prepare });
}
