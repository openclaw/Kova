import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GATEWAY_PROTOCOL_MIN_VERSION = 4;
const GATEWAY_PROTOCOL_MAX_VERSION = 4;
const GATEWAY_RPC_CLIENT_ID = "gateway-client";
const GATEWAY_RPC_CLIENT_MODE = "backend";
const GATEWAY_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.talk-secrets"
];

export function prepareOpenClawRuntimeFromOcmEnv(envName) {
  if (!envName) {
    throw new Error("--env is required");
  }
  const status = runOcmJson(["env", "status", envName, "--json"]);
  const resolved = runOcmJson(["env", "resolve", envName, "--json", "--", "status"]);
  const root = readRequiredString(status.root, "ocm env status root");
  const port = Number(status.gatewayPort);
  const binaryPath = readRequiredString(resolved.binaryPath, "ocm env resolve binaryPath");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid gateway port from OCM status: ${JSON.stringify(status.gatewayPort)}`);
  }
  const packageRoot = dirname(binaryPath);
  process.env.OPENCLAW_HOME = root;
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  process.chdir(packageRoot);
  return {
    envName,
    root,
    gatewayPort: port,
    binaryPath,
    packageRoot,
    runtime: {
      bindingKind: resolved.bindingKind ?? null,
      bindingName: resolved.bindingName ?? null,
      releaseVersion: resolved.runtimeReleaseVersion ?? null,
      releaseChannel: resolved.runtimeReleaseChannel ?? null,
      sourceKind: resolved.runtimeSourceKind ?? null
    }
  };
}

export function parseSupportArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

export function readTimeoutMs(value, fallbackMs) {
  if (value === undefined) {
    return fallbackMs;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid timeout: ${value}`);
  }
  return parsed;
}

export function runOcmJson(args) {
  let stdout = "";
  try {
    stdout = execFileSync("ocm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    throw new Error(`ocm ${args.join(" ")} failed: ${stderr.trim() || error.message}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`ocm ${args.join(" ")} did not return JSON: ${stdout.slice(0, 1000)}`);
  }
}

export async function openDirectGatewayRpcClient(runtimeContext) {
  if (typeof WebSocket !== "function") {
    throw new Error("direct Gateway RPC requires WebSocket support");
  }
  const token = readGatewayAuthToken(runtimeContext.root);
  if (!token) {
    throw new Error("direct Gateway RPC requires a gateway auth token");
  }

  const client = new DirectGatewayRpcClient({
    url: `ws://127.0.0.1:${runtimeContext.gatewayPort}`,
    token
  });
  await client.connect();
  return {
    client,
    transport: "direct-gateway-rpc"
  };
}

export async function waitForGatewayMethodOk(client, method, {
  params = {},
  timeoutMs = 120000,
  requestTimeoutMs = 5000,
  notReadyMessage = `${method} did not report ready`,
  timeoutMessage = `timed out waiting for ${method}`
} = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await client.request(method, params, { timeoutMs: requestTimeoutMs });
      if (status?.ok === true) {
        return status;
      }
      lastError = new Error(notReadyMessage);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw lastError ?? new Error(timeoutMessage);
}

class DirectGatewayRpcClient {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
    this.ws = null;
    this.pending = new Map();
    this.connectStarted = false;
    this.connected = false;
  }

  async connect(timeoutMs = 15000) {
    if (this.connected) {
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`gateway direct RPC connect timeout after ${timeoutMs}ms`));
        this.close();
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("gateway direct RPC closed before connect"));
      };
      const onError = () => {
        cleanup();
        reject(new Error("gateway direct RPC socket error before connect"));
      };
      const onMessage = (event) => {
        void this.handleMessage(event)
          .then((frame) => {
            if (frame?.type === "event" && frame.event === "connect.challenge" && !this.connectStarted) {
              this.connectStarted = true;
              void this.request("connect", this.buildConnectParams(), { timeoutMs })
                .then(() => {
                  this.connected = true;
                  cleanup();
                  ws.addEventListener("message", (messageEvent) => {
                    void this.handleMessage(messageEvent);
                  });
                  ws.addEventListener("close", () => {
                    this.rejectPending(new Error("gateway direct RPC closed"));
                  });
                  ws.addEventListener("error", () => {
                    this.rejectPending(new Error("gateway direct RPC socket error"));
                  });
                  resolve();
                })
                .catch((error) => {
                  cleanup();
                  reject(error);
                });
            }
          })
          .catch((error) => {
            cleanup();
            reject(error);
          });
      };
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    });
  }

  buildConnectParams() {
    return {
      minProtocol: GATEWAY_PROTOCOL_MIN_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_MAX_VERSION,
      client: {
        id: GATEWAY_RPC_CLIENT_ID,
        displayName: "Kova Gateway RPC",
        version: "kova",
        platform: process.platform,
        mode: GATEWAY_RPC_CLIENT_MODE,
        instanceId: `kova-${randomUUID()}`
      },
      caps: [],
      role: "operator",
      scopes: GATEWAY_OPERATOR_SCOPES,
      auth: {
        token: this.token
      }
    };
  }

  async request(method, params, { timeoutMs = 15000 } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway direct RPC is not connected");
    }
    const id = `kova-${randomUUID()}`;
    const frame = { type: "req", id, method, params };
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway direct RPC request timeout for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer
      });
    });
    this.ws.send(JSON.stringify(frame));
    return await response;
  }

  async handleMessage(event) {
    const raw = await readWebSocketData(event.data);
    const frame = JSON.parse(raw);
    if (frame?.type !== "res") {
      return frame;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return frame;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(new Error(formatGatewayRpcError(pending.method, frame.error)));
    }
    return frame;
  }

  close() {
    this.rejectPending(new Error("gateway direct RPC closed"));
    if (!this.ws) {
      return;
    }
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
  }

  rejectPending(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function readWebSocketData(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

function formatGatewayRpcError(method, error) {
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "gateway request failed";
  const code = typeof error?.code === "string" && error.code.trim() ? ` ${error.code.trim()}` : "";
  return `${method}${code}: ${message}`;
}

function readGatewayAuthToken(root) {
  const envToken = trimToNonEmptyString(process.env.OPENCLAW_GATEWAY_TOKEN);
  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(root, ".openclaw", "openclaw.json");
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return envToken;
  }

  const authToken = trimToNonEmptyString(config?.gateway?.auth?.token);
  if (authToken) {
    return authToken;
  }
  if (envToken) {
    return envToken;
  }
  return trimToNonEmptyString(config?.gateway?.remote?.token);
}

function trimToNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRequiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} missing`);
  }
  return value;
}

export function extractText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n");
  }
  for (const key of ["finalAssistantVisibleText", "finalAssistantRawText", "text", "content", "reply"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  return Object.values(value).map(extractText).filter(Boolean).join("\n");
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function finishJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function failJson(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...extra }, null, 2)}\n`);
  process.exit(1);
}
