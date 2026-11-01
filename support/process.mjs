import { spawn } from "node:child_process";

// Cooperative helpers supply their existing deadline policy. Ordinary callers
// keep their options and direct-child timeout behavior.
export function createProcessRunner({ cancellation } = {}) {
  const enabled = cancellation?.enabled ?? false;
  const commandGroups = new Map();
  const killCommandGroups = () => {
    for (const child of commandGroups.keys()) {
      try { signalCommand(child, "SIGKILL"); }
      catch (error) { commandGroups.set(child, `helper command termination failed: ${error.code ?? error.message}`); }
    }
  };
  if (enabled) process.on("exit", killCommandGroups);

  function runProcess(command, args, commandTimeoutMs, envOverrides = {}, {
    cleanup = false, remainingCleanupCommands = 1, cwd, killGraceMs = 3000, normalizeStatus = true, rejectOnError = false
  } = {}) {
    const started = Date.now();
    if (cancellation) commandTimeoutMs = cancellation.limit(commandTimeoutMs, cleanup, remainingCleanupCommands);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd, env: { ...process.env, ...envOverrides }, detached: enabled && process.platform !== "win32" });
      if (enabled && child.pid) commandGroups.set(child, null);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer;
      let stopping = false;
      const signalOwned = (signal) => {
        try { signalCommand(child, signal); }
        catch (error) {
          if (!enabled) throw error;
          commandGroups.set(child, `helper command ${signal} failed: ${error.code ?? error.message}`);
        }
      };
      const stop = () => {
        // The operation deadline and command timeout can expire together.
        if (stopping) return;
        stopping = true;
        clearTimeout(timer);
        timedOut = true;
        signalOwned("SIGTERM");
        const graceMs = enabled ? cancellation.terminationMs : killGraceMs;
        if (graceMs !== null) {
          killTimer = setTimeout(() => signalOwned("SIGKILL"), graceMs);
          killTimer.unref();
        }
      };
      const timer = commandTimeoutMs === undefined ? null : setTimeout(stop, commandTimeoutMs);
      const signal = cleanup ? null : cancellation?.signal;
      signal?.addEventListener("abort", stop, { once: true });
      const finished = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop); };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        finished();
        if (child.pid) signalOwned("SIGKILL");
        if (rejectOnError) { reject(error); return; }
        resolve({ status: 127, signal: null, timedOut, durationMs: Date.now() - started, stdout, stderr: error.message });
      });
      child.on("close", async (status, signal) => {
        if (enabled && child.pid) {
          try {
            signalOwned("SIGKILL");
            const until = Math.min(cancellation.deadline - cancellation.outputMargin, Date.now() + cancellation.reapMs);
            while (commandGroupAlive(child) && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
            if (commandGroupAlive(child)) commandGroups.set(child, commandGroups.get(child) ?? "helper command processes did not finish");
            else commandGroups.delete(child);
          } catch (error) {
            commandGroups.set(child, `helper command exit could not be confirmed: ${error.code ?? error.message}`);
          }
          if (commandGroups.has(child)) {
            timedOut = true;
            stderr += `\n${commandGroups.get(child)}`;
          }
        }
        finished();
        resolve({ status: normalizeStatus ? (timedOut ? 124 : (status ?? 1)) : status, signal, timedOut, durationMs: Date.now() - started, stdout, stderr });
      });
    });
  }

  function signalCommand(child, signal) {
    try {
      if (enabled && process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  }

  function commandGroupAlive(child) {
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") {
        // Permission uncertainty is not proof of a surviving or absent group.
        // Keep the existing bounded observation window after the child closes.
        commandGroups.set(child, commandGroups.get(child) ?? "helper command exit could not be confirmed: EPERM");
        return true;
      }
      throw error;
    }
  }

  return {
    runProcess,
    get cleanupError() {
      return commandGroups.size
        ? [...commandGroups.values()].filter(Boolean).join("; ") || "helper command processes did not finish"
        : null;
    },
    close() {
      // Unresolved groups retain the exit guard until the helper exits.
      if (!commandGroups.size) process.off("exit", killCommandGroups);
    }
  };
}

export const runProcess = createProcessRunner().runProcess;
