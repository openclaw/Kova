import { fileURLToPath } from "node:url";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { abortable, CallError } from "./background.mjs";

export function disposableEnv(options) {
  if (!/^kova-(?:run|helpers|scripts)-[a-z0-9][a-z0-9-]*$/i.test(options.env ?? "")) throw new CallError("--env must name a disposable Kova clone");
}

export async function runHelper(name, args, context) {
  context.remaining();
  if (context.helper) return context.helper(name, args);
  const owned = spawnOwnedProcess(process.execPath, [fileURLToPath(new URL(`../${name}.mjs`, import.meta.url)), ...args]);
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
  try {
    const signal = context.signal ? AbortSignal.any([context.signal, overflow.signal]) : overflow.signal;
    const result = await abortable(owned.closed, signal);
    if (result.error) throw result.error;
    let value;
    try { value = JSON.parse(stdout); }
    catch { throw new CallError("helper did not return JSON", 1); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallError("helper did not return a JSON object", 1);
    return { value, status: result.status, signal: result.signal };
  } finally { await owned.stop(); }
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
