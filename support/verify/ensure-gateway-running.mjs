import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CallError, readOperation, validateGatewayOutput, writeGatewayOutput } from "./background.mjs";
import { gatewayLifecycleMain, gatewayStartupReserveMs } from "./gateway-lifecycle.mjs";
import { disposableEnv } from "./helper.mjs";
import { entrypoint, nonempty } from "./script.mjs";

export const definition = {
  id: "ensure-gateway-running", url: import.meta.url,
  flags: ["env", "gateway-handle", "artifact-dir", "timeout"],
  empty: () => ({ ready: false, elapsedMs: 0 }),
  validate(o) {
    disposableEnv(o);
    if (!nonempty(o["gateway-handle"])) throw new CallError("--gateway-handle is required");
    if (o["artifact-dir"] !== undefined && !nonempty(o["artifact-dir"])) throw new CallError("--artifact-dir must be nonempty");
    if (o["artifact-dir"]) o["artifact-dir"] = resolve(o["artifact-dir"]);
  },
  async run(o, ctx) {
    const handle = resolve(o["gateway-handle"]);
    const artifact = o["artifact-dir"] && { out: join(o["artifact-dir"], "gateway-ready.json"), handle };
    if (artifact) await validateGatewayOutput(artifact);
    const read = ctx.operation ?? readOperation;
    let operation;
    try { operation = await read(handle); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!operation) {
      // The foreground owner also joins a failed startup. Keep its cleanup
      // window and a result-writing margin inside this call's total budget.
      const startupMs = ctx.remaining() - gatewayStartupReserveMs - 1000;
      if (startupMs < 1) throw new CallError("insufficient timeout for Gateway startup and cleanup", 3);
      const result = await (ctx.lifecycle ?? gatewayLifecycleMain)(["start", "--env", o.env, "--handle", handle, "--timeout", String(startupMs)], { signal: ctx.signal });
      if (result.exitCode) throw new CallError(result.output.error, result.exitCode);
      operation = await read(handle);
    }
    if (operation.entry !== "foreground-gateway-start" || operation.env !== o.env || operation.method !== "gateway.start" || !operation.handle) throw new CallError("Gateway handle does not identify this environment's foreground operation");
    {
      try { await access(join(operation.directory, "result.json")); throw new CallError("foreground Gateway has ended", 1); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const config = await ctx.rpc("config.get", {});
    if (typeof config?.path !== "string" || resolve(config.path) !== operation.handle.ref.configPath) throw new CallError("Gateway configuration does not match its foreground operation", 1);
    await ctx.rpc("health", {});
    const output = { ready: true };
    if (artifact) await writeGatewayOutput(artifact, output);
    return output;
  }
};
await entrypoint(definition);
