import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, createWriteStream, openSync, readFileSync, readSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { repoRoot } from "../paths.mjs";

const transportVariable = "KOVA_OCM_TRANSPORT_JSON";
const forwardedVariables = [
  "KOVA_ENV_NAME",
  "OPENCLAW_OCM_RUNTIME_BUILD_PROFILE",
  "KOVA_OPENCLAW_CONFIG_CONTRACT",
  "OPENCLAW_DIAGNOSTICS",
  "OPENCLAW_DIAGNOSTICS_RUN_ID",
  "OPENCLAW_DIAGNOSTICS_ENV",
  "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH",
  "OPENCLAW_DIAGNOSTICS_EVENT_LOOP",
  "KOVA_NODE_PROFILE_DIR"
];
const transportedHelpers = new Set([
  "configure-openclaw-mock-auth.mjs",
  "prepare-many-plugin-pressure-state.mjs"
].map((name) => join(repoRoot, "support", name)));

export function resolveOcmTransport(env = process.env) {
  const text = env[transportVariable];
  if (text === undefined) return null;
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${transportVariable} must be a JSON object`);
  }
  if (!isRecord(config) || Object.keys(config).some((key) => !["prefix", "binary", "env", "cwd"].includes(key))) {
    throw new Error(`${transportVariable} has unsupported fields`);
  }
  if (!Array.isArray(config.prefix) || !config.prefix.every(validString) ||
      (config.prefix.length > 0 && !isAbsolute(config.prefix[0])) ||
      !validString(config.binary) || !isAbsolute(config.binary)) {
    throw new Error(`${transportVariable} requires an argv prefix and absolute executable paths`);
  }
  if (!isRecord(config.env) || !Object.entries(config.env).every(([key, value]) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string" && !value.includes("\0")
  ) || !validString(config.env.HOME) || !isAbsolute(config.env.HOME) || !validString(config.env.PATH)) {
    throw new Error(`${transportVariable} requires a string environment with absolute HOME and explicit PATH`);
  }
  if (Object.hasOwn(config.env, transportVariable)) {
    throw new Error(`${transportVariable} must not be forwarded to the candidate`);
  }
  const cwd = config.cwd ?? config.env.HOME;
  if (!validString(cwd) || !isAbsolute(cwd)) {
    throw new Error(`${transportVariable} cwd must be absolute`);
  }
  return { ...config, cwd };
}

export function ocmCommandEnvironment(env) {
  if (!resolveOcmTransport(env)) return env;
  const bin = join(repoRoot, "support", "ocm-bin");
  const commandEnv = {
    ...env,
    PATH: [bin, ...(env.PATH ?? "").split(delimiter).filter((path) => path !== bin)].join(delimiter),
    KOVA_OCM_TRANSPORT_NODE: process.execPath,
    KOVA_OCM_TRANSPORT_DISPATCH: join(repoRoot, "support", "ocm-transport.mjs")
  };
  // Ambient A options must reach neither B nor A's dispatcher. Only the
  // diagnostics owner sets KOVA_OCM_COMMAND_NODE_OPTIONS for B instrumentation.
  delete commandEnv.NODE_OPTIONS;
  return commandEnv;
}

export function ocmInvocation(args, env = process.env) {
  const config = resolveOcmTransport(env);
  if (!config) return { file: "ocm", args, env };
  const forwarded = Object.fromEntries(forwardedVariables.flatMap((key) =>
    typeof env[key] === "string" ? [[key, env[key]]] : []
  ));
  if (env.KOVA_OCM_COMMAND_NODE_OPTIONS !== undefined) forwarded.NODE_OPTIONS = env.KOVA_OCM_COMMAND_NODE_OPTIONS;
  // Cwd belongs to the target principal: the A-side spawn must never chdir
  // into a B-private directory. GNU env changes it after the configured prefix.
  const argv = [
    ...config.prefix, "/usr/bin/env", "-C", config.cwd, "-i",
    ...Object.entries({ ...config.env, ...forwarded, HOME: config.env.HOME, PATH: config.env.PATH }).map(([key, value]) => `${key}=${value}`),
    config.binary, ...transportHelper(args)
  ];
  const launcherEnv = { ...env };
  delete launcherEnv.NODE_OPTIONS;
  return { file: argv[0], args: argv.slice(1), env: launcherEnv };
}

function transportHelper(args) {
  if (args[0] !== "env" || args[1] !== "exec" || args[3] !== "--" ||
      args[4] !== "node" || !transportedHelpers.has(args[5])) return args;
  const helper = args[5];
  const helperArgs = args.slice(6);
  if (helper.endsWith("/configure-openclaw-mock-auth.mjs")) {
    const portIndex = helperArgs.indexOf("--port-file");
    if (portIndex >= 0) {
      const port = readMockPort(helperArgs[portIndex + 1]);
      helperArgs.splice(portIndex, 2, "--port", port);
    }
  }
  // Only these fixed, builtin-only state writers execute in B. Sending their
  // trusted source avoids exposing A's private checkout or mock-provider files.
  const source = readFileSync(helper, "utf8").replace(/^#![^\n]*\n/, "");
  return [...args.slice(0, 4), "node", "--input-type=module", "-e", source, "kova-helper", ...helperArgs];
}

function readMockPort(path) {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(65);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const port = bytes.subarray(0, size).toString("utf8").trim();
    if (size > 64 || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error("invalid mock-provider port");
    }
    return port;
  } finally {
    closeSync(fd);
  }
}

export function artifactExportArgs(envName, path, maxBytes) {
  if (!validString(path) || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("OCM artifact path must be relative to the environment home");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("OCM artifact maxBytes must be a nonnegative integer");
  }
  return ["env", "artifact", "export", envName, "--path", path, "--max-bytes", String(maxBytes)];
}

export function readOcmArtifactSync(envName, path, options) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const invocation = ocmInvocation(artifactExportArgs(envName, path, options.maxBytes), env);
  const result = spawnSync(invocation.file, invocation.args, {
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 10000,
    killSignal: "SIGKILL",
    maxBuffer: options.maxBytes + 1
  });
  if (result.error || result.status !== 0 || result.stdout.length > options.maxBytes) {
    throw new Error(`OCM artifact export failed: ${result.error?.message ?? result.stderr?.toString("utf8").slice(0, 1000) ?? result.status}`);
  }
  return result.stdout;
}

export async function exportOcmArtifact(envName, path, target, options) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const invocation = ocmInvocation(artifactExportArgs(envName, path, options.maxBytes), env);
  const remainingMs = Math.floor(options.deadlineEpochMs - Date.now());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error("OCM artifact export deadline expired");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.kova-export-${randomUUID()}.tmp`);
  const controller = new AbortController();
  const child = spawn(invocation.file, invocation.args, {
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  let bytes = 0;
  let stderr = "";
  let launcherTerminal = false;
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 2000); });
  const terminal = new Promise((resolve) => {
    child.on("error", (error) => {
      if (!child.pid) {
        launcherTerminal = true;
        resolve({ error });
      } else {
        controller.abort(error);
      }
    });
    child.once("exit", (code, signal) => {
      launcherTerminal = true;
      resolve({ code, signal });
    });
  });
  const exited = terminal.then(({ code, signal, error }) => {
    if (error || code !== 0 || signal) {
      throw new Error(`OCM artifact export failed (${signal ?? code}): ${error?.message ?? stderr}`);
    }
  });
  const bound = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > options.maxBytes ? new Error(`OCM artifact exceeds ${options.maxBytes} bytes`) : null, chunk);
    }
  });
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const fileClosed = new Promise((resolve) => output.once("close", resolve));
  const copy = pipeline(child.stdout, bound, output, { signal: controller.signal });
  let failure;
  try {
    await Promise.all([exited, copy]);
    if (controller.signal.aborted || Date.now() >= options.deadlineEpochMs) throw new Error("OCM artifact export deadline expired");
    await options.validate?.(temporary);
    if (Date.now() >= options.deadlineEpochMs) throw new Error("OCM artifact export deadline expired");
    await rename(temporary, target);
    return { path: target, bytes };
  } catch (error) {
    failure = error;
    if (controller.signal.aborted) {
      failure = new Error("OCM artifact export deadline expired", { cause: error });
    }
    failure.message += "; candidate descendants remain unverified (outer UID quiescence required)";
    throw failure;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (!launcherTerminal) child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    output.destroy();
    // Pipeline rejection alone does not mean an asynchronous file open has
    // settled. Join the file close as well before unlinking its pathname.
    const settled = Promise.allSettled([terminal, copy, fileClosed]);
    let cleanupTimer;
    const joined = await Promise.race([
      settled.then(() => true),
      new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve(false), 2000); })
    ]);
    clearTimeout(cleanupTimer);
    if (!joined) {
      throw new Error(`OCM export cleanup incomplete: launcher terminal=${launcherTerminal}, file closed=${output.closed}; temporary file retained; outer candidate UID quiescence required`, { cause: failure });
    }
    await rm(temporary, { force: true });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validString(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
