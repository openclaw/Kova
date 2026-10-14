import { CallError } from "./background.mjs";
import { entrypoint, nonempty } from "./script.mjs";
export const definition = {
  id: "cron-isolated-run", url: import.meta.url,
  flags: ["env", "job-id", "timeout"], empty: () => ({ sessionKey: null, result: null, elapsedMs: 0 }),
  validate(o) { if (!nonempty(o["job-id"])) throw new CallError("--job-id is required"); },
  async run(o, ctx) {
    const id = o["job-id"];
    const job = await ctx.rpc("cron.get", { id });
    if ((job?.job ?? job)?.sessionTarget !== "isolated") throw new CallError("job must use an isolated session");
    const result = await ctx.rpc("cron.run", { id, mode: "force", waitTimeoutMs: Math.min(60000, ctx.remaining()) });
    if (!nonempty(result?.runId) || result.ran === false) return { sessionKey: null, result };
    for (;;) {
      const runs = await ctx.rpc("cron.runs", { id, runId: result.runId, limit: 1 });
      const finished = runs?.entries?.find((entry) => entry.runId === result.runId && entry.action === "finished");
      if (finished) return { sessionKey: finished.sessionKey ?? null, result: { ...result, finished } };
      await ctx.pause(100);
    }
  }
};
await entrypoint(definition);
