import { spawn } from "node:child_process";

export function runProcess(command, args, timeoutMs, envOverrides = {}, {
  cwd, killGraceMs = 3000, normalizeStatus = true, rejectOnError = false
} = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: { ...process.env, ...envOverrides }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      if (killGraceMs !== null) setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (rejectOnError) { reject(error); return; }
      resolve({ status: 127, signal: null, timedOut, durationMs: Date.now() - started, stdout, stderr: error.message });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: normalizeStatus ? (timedOut ? 124 : (status ?? 1)) : status, signal, timedOut, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}
