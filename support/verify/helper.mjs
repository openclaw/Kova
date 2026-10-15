import { fileURLToPath } from "node:url";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { abortable, CallError } from "./background.mjs";

export function disposableEnv(options) {
  if (!/^kova-(?:run|helpers|scripts)-[a-z0-9][a-z0-9-]*$/i.test(options.env ?? "")) throw new CallError("--env must name a disposable Kova clone");
}

export async function runHelper(name, args, context, { cooperative = false } = {}) {
  const deadline = Date.now() + context.remaining();
  if (context.helper) return context.helper(name, args);
  if (cooperative) args = [...args, "--cleanup-deadline-ms", String(deadline)];
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: "", OPENCLAW_GATEWAY_TOKEN: "", OPENCLAW_GATEWAY_PASSWORD: "" };
  const owned = spawnOwnedProcess(process.execPath, [fileURLToPath(new URL(`../${name}.mjs`, import.meta.url)), ...args], { env, finishOnShutdown: cooperative });
  let stdout = "";
  const overflow = new AbortController();
  let size = 0;
  const limit = 4 * 1024 * 1024;
  owned.child.stdout.setEncoding("utf8");
  owned.child.stdout.on("data", (chunk) => {
    size += Buffer.byteLength(chunk, "utf8");
    if (size > limit) overflow.abort(new CallError("helper output exceeded 4 MiB", 1));
    else stdout += chunk;
  });
  // Helpers may print command diagnostics here. The adapter's JSON contains
  // the helper's structured error without forwarding incidental process output.
  owned.child.stderr.resume();
  let forced = false;
  const hardStop = () => {
    forced = true;
    if (!owned.child.pid) return;
    try {
      if (process.platform === "win32") owned.child.kill("SIGKILL");
      else process.kill(-owned.child.pid, "SIGKILL");
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const timer = cooperative ? setTimeout(hardStop, Math.max(1, deadline - Date.now())) : null;
  try {
    const signal = context.signal ? AbortSignal.any([context.signal, overflow.signal]) : overflow.signal;
    let cancelled;
    let result;
    try { result = await abortable(owned.closed, signal); }
    catch (error) {
      if (!cooperative) throw error;
      cancelled = error;
      if (!forced) owned.child.kill("SIGTERM");
      result = await owned.closed;
    }
    if (result.error) throw result.error;
    if (forced) throw Object.assign(new CallError("verification timeout", 3), { cleanupError: "helper was terminated before cleanup was confirmed" });
    let value;
    try { value = JSON.parse(stdout); }
    catch { throw Object.assign(new CallError("helper did not return JSON", 1), cooperative ? { cleanupError: "helper cleanup was not confirmed" } : {}); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new CallError("helper did not return a JSON object", 1), cooperative ? { cleanupError: "helper cleanup was not confirmed" } : {});
    if (cooperative && (cancelled || value.cancelled || value.cleanupComplete !== true)) {
      const error = cancelled ?? new CallError(value.cancelled ? "verification timeout" : "helper cleanup failed", value.cancelled ? 3 : 1);
      if (value.cleanupComplete !== true) error.cleanupError = value.cleanupError ?? "helper cleanup was not confirmed";
      throw error;
    }
    return { value, status: result.status, signal: result.signal };
  } finally { clearTimeout(timer); await owned.stop(); }
}

export function helperError(result) {
  const value = result.value;
  const errors = Array.isArray(value.errors) ? value.errors.filter(Boolean) : [];
  const failed = result.status !== 0 || result.signal || value.ok === false || Boolean(value.error) || errors.length > 0;
  if (!failed) return null;
  const message = (value.error ?? errors.join("; ")) || `helper exited ${result.status ?? result.signal}`;
  return value.recordStatus === "BLOCKED" ? `BLOCKED: ${message}` : String(message);
}

export function finishHelper(result, output, context) {
  context.record(output);
  const error = helperError(result);
  if (error) throw new CallError(error, 1);
  return output;
}
