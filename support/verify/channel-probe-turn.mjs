import { resolve } from "node:path";
import { repoRoot } from "../../src/paths.mjs";
import { readChannelWorkflowCaseCatalogSync } from "../channel-workflow-catalog.mjs";
import { CallError } from "./background.mjs";
import { disposableEnv, finishHelper, runHelper } from "./helper.mjs";
import { entrypoint, nonempty } from "./script.mjs";

export const definition = {
  cancellationExitCode: 3,
  id: "channel-probe-turn", url: import.meta.url,
  flags: ["env", "case", "artifact-dir", "timeout"],
  empty: () => ({ case: null, reply: null, elapsedMs: 0 }),
  validate(o) {
    disposableEnv(o);
    if (!nonempty(o.case) || !nonempty(o["artifact-dir"])) throw new CallError("--case and --artifact-dir are required");
    if (!readChannelWorkflowCaseCatalogSync(repoRoot).cases.some((item) => item.id === o.case)) throw new CallError("--case must name one channel workflow case");
    o["artifact-dir"] = resolve(o["artifact-dir"]);
  },
  async run(o, ctx) {
    ctx.record({ case: o.case });
    const result = await runHelper("run-channel-probe-turn", ["--env", o.env, "--case", o.case, "--artifact-dir", o["artifact-dir"], "--timeout-ms", String(ctx.remaining())], ctx, { cooperative: true });
    let artifact = null;
    if (result.value.artifactPath) {
      try { artifact = await ctx.read(result.value.artifactPath); }
      catch (error) { throw new CallError(error.message, 1); }
    }
    const output = { case: o.case, reply: artifact?.observations ?? null };
    // The helper's summary keeps global errors in its detailed artifact.
    if (artifact?.error) result.value.error = artifact.error;
    return finishHelper(result, output, ctx);
  }
};
await entrypoint(definition);
