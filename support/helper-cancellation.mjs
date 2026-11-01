import { setTimeout as sleep } from "node:timers/promises";

// Only the verification adapters supply this deadline. The final portion is
// reserved for removing resources before the caller's own timeout expires.
export function helperCancellation(value, { terminationMs = 0, reapMs = 0, cleanupCommands = 0, cleanupExecutionMs = 0 } = {}) {
  const enabled = value !== undefined;
  const deadline = enabled ? Number(value) : Infinity;
  if (enabled && (!Number.isSafeInteger(deadline) || deadline <= 0)) throw new Error("--cleanup-deadline-ms must be a positive integer");
  // A command must leave its full termination and reaping window available
  // before it starts, including when the caller supplied a very short budget.
  const outputMargin = terminationMs || reapMs ? 100 : 0;
  const terminationWindow = terminationMs + reapMs;
  const minimumReserve = terminationWindow + cleanupCommands * (terminationWindow + cleanupExecutionMs) + outputMargin;
  const reserve = enabled ? Math.max(minimumReserve, Math.min(15000, Math.max(100, Math.floor((deadline - Date.now()) / 3)))) : 0;
  const reapMargin = enabled ? Math.max(terminationMs + reapMs + outputMargin, Math.min(500, Math.max(25, Math.floor(reserve / 3)))) : 0;
  const workDeadline = Math.min(deadline - reserve, deadline - reapMargin);
  const controller = enabled ? new AbortController() : null;
  const cancel = () => controller?.abort(Object.assign(new Error("verification timeout"), { code: "KOVA_HELPER_CANCELLED" }));
  const timer = enabled ? setTimeout(cancel, Math.max(1, workDeadline - Date.now())) : null;
  if (enabled) {
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
  }
  return {
    enabled, deadline, terminationMs, reapMs, outputMargin, signal: controller?.signal,
    get cancelled() { return controller?.signal.aborted ?? false; },
    check() {
      if (enabled && Date.now() >= workDeadline) cancel();
      controller?.signal.throwIfAborted();
    },
    limit(ms, cleanup = false, remainingCommands = 1) {
      if (!enabled) return ms;
      if (!cleanup) this.check();
      const remaining = cleanup && terminationWindow
        ? Math.floor((deadline - Date.now() - outputMargin - remainingCommands * terminationWindow) / remainingCommands)
        : (cleanup ? deadline - reapMargin : workDeadline) - Date.now();
      if (remaining <= 0) throw new Error("helper cleanup deadline exceeded");
      return Math.max(1, Math.min(ms, remaining));
    },
    async pause(ms) {
      this.check();
      await sleep(this.limit(ms), undefined, { signal: controller?.signal });
    },
    close() {
      clearTimeout(timer);
      if (enabled) {
        process.off("SIGTERM", cancel);
        process.off("SIGINT", cancel);
      }
    }
  };
}
