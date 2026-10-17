import { CallError } from "./background.mjs";

const names = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "TimeoutError", "AbortError", "AggregateError", "CallError"]);
const reasons = new Set(["Gateway did not return a browser pairing URL", "Gateway returned an unsupported browser URL", "retained browser is closed", "retained browser cannot be reused after switching Gateways; close it with --wait", "browser environment does not match this call", "retained browser locale cannot change", "cannot read --session-from JSON", "--session-from contains an error", "--session-from requires exactly one session key", "Control UI startup timeout", "OCM environment lookup timeout"]);
const callReasons = new Set(["unknown Control UI flow", "--background requires --handle", "reconnect-and-send requires an existing browser handle", "choose --session-key or --session-from", "--locale must be a language tag", "timeout must be a positive number of milliseconds below 2147483648", "--out already exists; choose a new output path", "--wait requires a Control UI handle", "background directory does not match its handle", "background handle does not match its operation", "background handle does not match this call", "background operation does not accept calls", "background operation has finished", "background operation already has a caller", "background operation ended before replying", "background join timeout", "background call timeout", "background startup timeout"]);
const flags = "env flow session-key session-from incognito-handle locale gateway-env artifact-dir out timeout background handle wait from".split(" ");
const flowReasons = new Set(["this flow requires --session-key or --session-from", "--incognito-handle is required for this flow", "cannot read --incognito-handle JSON", "--incognito-handle requires one incognito sessionKey", "link forms require a qualified agent session key"]);
const codes = new Set(["EACCES", "ENOENT", "ENOTDIR", "EEXIST", "EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EIO", "ENOSPC", "ERR_INVALID_URL", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_OUT_OF_RANGE", "ERR_INVALID_ARG_TYPE", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ABORT_ERR"]);
const signals = new Set(["SIGKILL", "SIGTERM", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGINT", "SIGHUP", "SIGPIPE", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGXCPU", "SIGXFSZ"]);
const browserCodes = new Set(["ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_EMPTY_RESPONSE", "ERR_NAME_NOT_RESOLVED", "ERR_TIMED_OUT", "ERR_ABORTED", "ERR_CERT_AUTHORITY_INVALID", "ERR_SSL_PROTOCOL_ERROR"]);
const commands = new Set(["env-status", "env-resolve", "dashboard", "other"]);
const playwrightOperations = ["browserType.launch", "browser.newContext", "browserContext.grantPermissions", "browserContext.newPage", "browserContext.close", "browser.close", "page.goto", "page.reload", "page.screenshot", "page.waitForFunction", "page.evaluate", "locator.waitFor", "locator.click", "locator.fill", "locator.check", "locator.selectOption"];

function boundedText(value, limit) {
  if (Buffer.isBuffer(value)) return value.length <= limit ? value.toString("utf8") : "";
  return typeof value === "string" && value.length <= limit ? value : "";
}

function property(value, key) {
  try { return value?.[key]; } catch { return undefined; }
}

function dashboardReason(value) {
  let result = value;
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    try { result = JSON.parse(boundedText(value, 1024 * 1024)); } catch { return undefined; }
  }
  const rawReason = property(result, "reason");
  if (property(result, "ok") !== false || typeof rawReason !== "string") return undefined;
  const reason = boundedText(rawReason, 8192);
  const exact = new Map([
    ["Gateway is not running.", "not-running"],
    ["Gateway is not healthy.", "not-healthy"],
    ["Control UI assets are still preparing.", "assets-preparing"],
    ["Control UI assets did not finish preparing in time.", "assets-preparation-timeout"],
    ["Dashboard loopback listener could not be verified as the configured Gateway.", "loopback-unverified"],
    ["Dashboard target resolution failed.", "target-resolution-failed"]
  ]);
  if (exact.has(reason)) return { category: exact.get(reason) };
  const http = /^Control UI dashboard is unavailable \(HTTP ([1-5][0-9]{2})\)\.$/.exec(reason);
  if (http) return { category: "http-status", status: Number(http[1]) };
  for (const [prefix, category] of [["Gateway check failed: ", "gateway-check-failure"], ["Control UI dashboard is unavailable: ", "document-unavailable"], ["OpenClaw config is invalid: ", "config-invalid"]]) {
    if (reason.startsWith(prefix)) return { category };
  }
  return { category: "other-refusal" };
}

// Native exceptions can embed pairing URLs, configuration and subprocess output.
// Keep the exception identity and known refusal categories, never their raw text.
export function controlUiException(error, seen = new Set()) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return { name: "NonError" };
  if (seen.has(error) || seen.size >= 4) return { causeTruncated: true };
  seen.add(error);
  const name = property(error, "name"), code = property(error, "code"), status = property(error, "status"), signal = property(error, "signal");
  const command = property(error, "ocmCommand"), cause = property(error, "cause");
  const result = { name: names.has(name) ? name : "Error" };
  if (codes.has(code)) result.code = code;
  if (Number.isInteger(status) && status >= 0 && status <= 255) result.status = status;
  if (signals.has(signal)) result.signal = signal;
  const message = boundedText(property(error, "message"), 65536);
  if (reasons.has(message) || callReasons.has(message) || flowReasons.has(message)) result.reason = message;
  else if (message.startsWith("invalid or repeated flag: ")) result.reason = "invalid or repeated flag";
  else if (message.startsWith("unknown flag: ")) result.reason = "unknown flag";
  else if (/^--[^ ]+ requires a value$/.test(message)) result.reason = "option requires a value";
  else if (flags.some((flag) => [`--${flag} is required`, `--${flag} does not take a value`, `--wait cannot be combined with --${flag}`, `--out overlaps --${flag}`].includes(message))) result.reason = message;
  else if (["open-session-keep-open", "reconnect-and-send"].some((flow) => message === `${flow} requires a retained browser --handle`)) result.reason = message;
  const operation = playwrightOperations.find((name) => message.startsWith(`${name}:`));
  if (operation) result.operation = operation;
  const browserCode = /^page\.(?:goto|reload): net::(ERR_[A-Z_]+)\b/.exec(message)?.[1];
  if (browserCodes.has(browserCode)) result.browserCode = browserCode;
  if (commands.has(command)) result.command = command;
  const stderr = boundedText(property(error, "stderr"), 8192);
  if (/^ocm: runtime "[^"\r\n]+" is busy with another operation; retry after it finishes\nRun "ocm help" for usage\.\n?$/.test(stderr)) result.ocmRefusal = "runtime-busy";
  const refusal = dashboardReason(property(error, "dashboardResult") ?? (command === "dashboard" ? property(cause, "stdout") : undefined));
  if (refusal) result.dashboardReason = refusal;
  if (cause !== undefined) result.cause = controlUiException(cause, seen);
  return result;
}

function timedOut(exception) {
  return exception.name === "TimeoutError" || exception.code === "ETIMEDOUT" || (exception.cause && timedOut(exception.cause));
}

export class ControlUiStartupError extends CallError {
  constructor(stage, cause) {
    super("Control UI startup failed", 1);
    this.stage = stage;
    this.exception = controlUiException(cause);
    const exitCode = property(cause, "exitCode");
    this.exitCode = timedOut(this.exception) ? 3 : [1, 2, 3].includes(exitCode) ? exitCode : 1;
    this.message = this.describe(this.exitCode === 3);
  }

  describe(timeout = false) {
    return `${timeout ? "Control UI timeout" : "Control UI startup failed"} at ${this.stage}: ${JSON.stringify({ exception: this.exception, ...(this.cleanup ? { cleanup: this.cleanup } : {}) })}`;
  }
}

export function startupFailure(stage, error) {
  return error instanceof ControlUiStartupError ? error : new ControlUiStartupError(stage, error);
}

export async function atStartupStage(stage, perform) {
  try { return await perform(); }
  catch (error) { throw startupFailure(stage, error); }
}
