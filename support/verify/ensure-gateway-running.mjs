import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicJson, CallError, readOperation } from "./background.mjs";
import { gatewayLifecycleMain } from "./gateway-lifecycle.mjs";
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
  },
  async run(o, ctx) {
    const handle = resolve(o["gateway-handle"]);
    const read = ctx.operation ?? readOperation;
    let operation;
    try { operation = await read(handle); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!operation) {
      const result = await (ctx.lifecycle ?? gatewayLifecycleMain)(["start", "--env", o.env, "--handle", handle, "--timeout", String(ctx.remaining())], { signal: ctx.signal });
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
    if (o["artifact-dir"]) {
      await mkdir(o["artifact-dir"], { recursive: true, mode: 0o700 });
      await atomicJson(join(o["artifact-dir"], "gateway-ready.json"), output);
    }
    return output;
  }
};
await entrypoint(definition);
