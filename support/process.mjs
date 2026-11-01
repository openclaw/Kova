import { spawn } from "node:child_process";

export function runProcess(command, args, timeoutMs, envOverrides = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...envOverrides }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, signal: null, timedOut, durationMs: Date.now() - started, stdout, stderr: error.message });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? 124 : (status ?? 1), signal, timedOut, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}
