import { CallError } from "./background.mjs";
import { disposableEnv, finishHelper, runHelper } from "./helper.mjs";
import { entrypoint, nonempty } from "./script.mjs";

export const definition = {
  id: "cron-runtime-smoke", url: import.meta.url,
  flags: ["env", "artifact-dir", "timeout"],
  empty: () => ({ jobs: [], elapsedMs: 0 }),
  validate(o) {
    disposableEnv(o);
    if (!nonempty(o["artifact-dir"])) throw new CallError("--artifact-dir is required");
  },
  async run(o, ctx) {
    const result = await runHelper("run-cron-runtime-smoke", ["--env", o.env, "--artifact-dir", o["artifact-dir"], "--timeout-ms", String(ctx.remaining())], ctx);
    const v = result.value;
    return finishHelper(result, { jobs: v.cronId ? [{
      id: v.cronId, runId: v.runId ?? null, status: v.runStatus ?? null,
      completed: v.cronRunCompleted === true, timedOut: v.cronRunTimedOut === true,
      triggerAttributed: v.cronTriggerAttributed === true
    }] : [] }, ctx);
  }
};
await entrypoint(definition);
