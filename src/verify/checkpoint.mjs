import { constants } from "node:fs";
import JSON5 from "json5";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand } from "../commands.mjs";
import { parseCatalogueCommand } from "../catalogue.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function parseOutput(text) {
  try { return { json: true, value: JSON.parse(text) }; }
  catch { return { json: false, value: text }; }
}

export function isPrivateVerificationPath(path) {
  return typeof path === "string" && /(?:^|[\\/])\.kova-private-[A-Za-z0-9]{6}(?:[\\/]|$)/.test(path);
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

export function redactCommandResult(command, result) {
  const { tokens, findings } = parseCatalogueCommand(command, { standard: true });
  if (findings.length || tokens[0] !== "ocm" || !/^@.+$/.test(tokens[1] ?? "") || tokens[2] !== "--" || tokens[3] !== "attach" || !tokens.slice(4).includes("--print-config")) return result;
  try {
    if (result.outputBudget?.truncated || typeof (result.stderr ?? "") !== "string") throw new Error();
    const { value, prefix, suffix } = firstJsonObject(result.stdout);
    const output = record(value), environment = record(output.env);
    const token = environment.OPENCLAW_MCP_TOKEN;
    if (typeof token !== "string") throw new Error();
    const scrub = (text) => token ? text.replaceAll(token, "") : text;
    return {
      ...result,
      stdout: prefix + JSON.stringify({ ...output, env: { ...environment, OPENCLAW_MCP_TOKEN: "" } }, null, 2) + scrub(suffix),
      stderr: scrub(result.stderr ?? "")
    };
  } catch {
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
  const suffix = ["-wal", "-shm", "-journal"].find((value) => path.endsWith(value));
  if (!suffix) return false;
  let database;
  try { database = await realpath(path.slice(0, -suffix.length)); }
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

function credentialTextKind(path) {
  const normalized = path.split(sep).join("/");
  if (/(?:^|\/)openclaw\.json5?(?:\.bak(?:\.\d+)?|\.(?:last-good|pre-update)|\.(?:rejected|clobbered)\.[0-9TZ-]+|\.kova-[0-9a-f-]{36}|\.(?:\d+\.)?[0-9a-f-]{36}\.tmp)?$/.test(normalized)) return "configuration";
  if (/(?:^|\/)\.?openclaw-config-backup[^/]*\/original$/.test(normalized)) return "configuration";
  if (/(?:^|\/)identity\/device\.json(?:\.(?:doctor|native)-importing)?$/.test(normalized)) return "identity";
  if (/(?:^|\/)identity\/device-auth\.json$/.test(normalized)) return "authentication";
  if (/(?:^|\/)devices\/paired\.json(?:\.migrated)?$/.test(normalized)) return "paired";
  if (/(?:^|\/)devices\/bootstrap\.json(?:\.migrated)?$/.test(normalized)) return "bootstrap";
  if (/(?:^|\/)exec-approvals\.json(?:\.doctor-importing|\.migrated\.[0-9a-f]{64}\.[0-9a-f-]{36})?$/.test(normalized)) return "approvals";
  if (/(?:^|\/)push\/vapid-keys\.json(?:\.doctor-importing)?$/.test(normalized)) return "vapid";
  if (/(?:^|\/)credentials\/[^/]+-pairing\.json(?:\.doctor-importing)?$/.test(normalized)) return "channelPairing";
  if (/(?:^|\/)nodes\/paired\.json(?:\.migrated)?$/.test(normalized)) return "nodes";
  if (/(?:^|\/)node\.json(?:\.doctor-importing)?$/.test(normalized)) return "node";
  if (/(?:^|\/)config-journal-fingerprint\.key$/.test(normalized)) return "privateKey";
  // These files are owned by OpenClaw's TLS and proxy key producers. A PEM
  // header in an unrelated document does not declare that document secret.
  if (/(?:^|\/)gateway\/tls\/gateway-key\.pem$/.test(normalized)) return "privateKey";
  if (/(?:^|\/)\.openclaw-gateway-tls-key-[^/]+\/key\.pem$/.test(normalized)) return "privateKey";
  if (/(?:^|\/)(?:debug-proxy\/certs|secret-egress-proxy\/gateway-[^/]+)\/(?:\.root-ca-[^/]+\/)?(?:root-ca-key|leaf-key)\.pem$/.test(normalized)) return "privateKey";
  return null;
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
export function redactStateText(paths, contents) {
  if (paths.some(isPrivateVerificationPath)) throw new Error("cannot capture private verification file contents");
  const kinds = [...new Set(paths.filter((path) => typeof path === "string").map(credentialTextKind).filter(Boolean))];
  if (kinds.includes("privateKey")) return "";
  if (!kinds.length) return null;
  try {
    const text = typeof contents === "string" ? contents : new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return redactJson(text, (value) => kinds.reduce((current, kind) => credentialTextRedactors[kind](current), value), kinds.includes("configuration") ? JSON5.parse : JSON.parse);
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

async function snapshotFile(root, source, target, requested) {
  const fileType = await sqliteFileType(source);
  // Recognizable journal pages remain private even when the file has another name.
  if (fileType === "wal" || fileType === "journal") return;
  if ([source, requested].some(credentialTextKind)) {
    const contents = redactStateText([source, requested], await readFile(source));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents ? `${contents}\n` : "", { flag: "wx", mode: 0o600 });
    return;
  }
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
    // Rebuild the file to exclude deleted pages and overwritten credential bytes.
    // VACUUM INTO preserves rowids as well as the selected non-secret values.
    snapshot.prepare("VACUUM INTO ?").run(target);
  } finally {
    snapshot?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function snapshotPath(root, source, target, ancestors = new Set()) {
  if (isPrivateVerificationPath(source)) return;
  let metadata;
  try { metadata = await lstat(source); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const actual = await realpath(source);
  if (isPrivateVerificationPath(actual)) return;
  if (!inside(root, actual)) throw new Error(`checkpoint state escapes OpenClaw state directory: ${source}`);
  if (ancestors.has(actual)) throw new Error(`checkpoint state contains a directory cycle: ${source}`);
  if (metadata.isSymbolicLink()) metadata = await lstat(actual);
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const visited = new Set([...ancestors, actual]);
    for (const name of (await readdir(actual)).sort()) {
      await snapshotPath(root, join(source, name), join(target, name), visited);
    }
  } else if (metadata.isFile()) {
    // Direct selections and symbolic aliases use the same online database snapshot.
    if (await isSqliteSidecar(root, source) || (source !== actual && await isSqliteSidecar(root, actual))) return;
    await snapshotFile(root, actual, target, source);
  } else throw new Error(`checkpoint state is not a file or directory: ${source}`);
}

export async function snapshotState(stateDirectory, paths, outputDirectory) {
  const root = await realpath(stateDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const selected = [...new Set(paths.map(statePath))].sort();
  for (const path of selected) {
    if (selected.some((parent) => parent !== path && path.startsWith(`${parent}/`))) continue;
    await snapshotPath(root, resolve(root, path), join(outputDirectory, path));
  }
}

export async function writeCheckpoint({ phase, directory, results, stateDirectory, collectLogs, screenPath }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase.id)) throw new Error("invalid checkpoint phase id");
  results = results.map((result, index) => redactCommandResult(result.command ?? phase.commands?.[index], result));
  if (results.some((result) => result.captureError)) throw new Error("checkpoint command output could not be captured");
  if (results.some((result) => result.outputBudget?.truncated)) throw new Error("checkpoint command output was truncated");
  const destination = join(directory, "checkpoints", phase.id);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(`${destination}.pending-`);
  let logCapture;
  try {
    const responses = {};
    const commands = results.map((result, index) => {
      const output = parseOutput(result.stdout);
      if (output.json) responses[index] = output.value;
      return {
        command: result.command, exit: result.status, stdout: output.json ? null : result.stdout,
        stderr: result.stderr, durationMs: result.durationMs, timedOut: result.timedOut === true,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.outputBudget ? { outputBudget: result.outputBudget } : {})
      };
    });
    await writeFile(join(temporary, "commands.json"), json(commands), { mode: 0o600 });
    for (const signal of phase.checkpoint) {
      if (signal === "responses") await writeFile(join(temporary, "responses.json"), json(responses), { mode: 0o600 });
      else if (signal === "timing") await writeFile(join(temporary, "timing.json"), json(results.map((result) => ({ durationMs: result.durationMs, reachedBound: result.timedOut === true || result.reachedBound === true }))), { mode: 0o600 });
      else if (signal === "logs") {
        if (!collectLogs) throw new Error("log collector is required by checkpoint");
        logCapture ??= collectLogs.prepare ? await collectLogs.prepare() : { text: await collectLogs(), commit() {} };
        await writeFile(join(temporary, "logs.txt"), logCapture.text, { mode: 0o600 });
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
    if (paths.length) await snapshotState(stateDirectory, paths, join(temporary, "state"));
    await rename(temporary, destination);
    logCapture?.commit();
    return { path: destination, incomplete: commands.some((command) => command.exit === 2) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function recordPhase(options) {
  const { phase, execute = runCommand, env, bounds = [] } = options;
  const results = [];
  for (const [index, command] of phase.commands.entries()) {
    const timeoutMs = bounds[index] ?? phase.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid phase command bound");
    results.push(redactCommandResult(command, await execute(command, { timeoutMs, env })));
  }
  return { ...await writeCheckpoint({ ...options, results }), results };
}

export function createLogCollector(paths, { validatePath, trackIdentity = false } = {}) {
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
        bytes += metadata.size - start;
        if (bytes > maxBytes) throw new Error("log capture exceeds the 16 MiB output budget");
        if (metadata.size > start) {
          for await (const chunk of file.createReadStream({ start, end: metadata.size - 1, autoClose: false })) chunks.push(chunk);
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
  const prepare = async ({ maxBytes = 16 * 1024 * 1024 } = {}) => {
    const selected = typeof collectors === "function" ? await collectors() : collectors;
    const captures = [];
    let bytes = 0;
    let nonempty = false;
    for (const collect of new Set(selected)) {
      if (typeof collect.prepare !== "function") throw new Error("combined log readers must support deferred capture");
      const capture = await collect.prepare({ maxBytes: maxBytes - bytes });
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
