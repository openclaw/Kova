import { setTimeout as sleep } from "node:timers/promises";

// Only the verification adapters supply this deadline. The final portion is
// reserved for removing resources before the caller's own timeout expires.
export function helperCancellation(value) {
  const enabled = value !== undefined;
  const deadline = enabled ? Number(value) : Infinity;
  if (enabled && (!Number.isSafeInteger(deadline) || deadline <= 0)) throw new Error("--cleanup-deadline-ms must be a positive integer");
  const reserve = enabled ? Math.min(15000, Math.max(100, Math.floor((deadline - Date.now()) / 3))) : 0;
  const reapMargin = enabled ? Math.min(500, Math.max(25, Math.floor(reserve / 3))) : 0;
  const workDeadline = deadline - reserve;
  const controller = enabled ? new AbortController() : null;
  const cancel = () => controller?.abort(Object.assign(new Error("verification timeout"), { code: "KOVA_HELPER_CANCELLED" }));
  const timer = enabled ? setTimeout(cancel, Math.max(1, workDeadline - Date.now())) : null;
  if (enabled) {
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
  }
  return {
    enabled, deadline, signal: controller?.signal,
    get cancelled() { return controller?.signal.aborted ?? false; },
    check() {
      if (enabled && Date.now() >= workDeadline) cancel();
      controller?.signal.throwIfAborted();
    },
    limit(ms, cleanup = false) {
      if (!enabled) return ms;
      if (!cleanup) this.check();
      const remaining = (cleanup ? deadline - reapMargin : workDeadline) - Date.now();
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
