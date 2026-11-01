import { entrypoint } from "./script.mjs";
export const definition = {
  id: "heartbeat-wake", url: import.meta.url,
  flags: ["env", "timeout"], empty: () => ({ woke: null, notices: null, elapsedMs: 0 }),
  async run(o, ctx) {
    const resolved = await ctx.rpc("sessions.resolve", { key: "main" });
    const sessionKey = resolved?.key;
    if (typeof sessionKey !== "string") return { woke: null, notices: { resolution: resolved } };
    const agentId = /^agent:([^:]+):/.exec(sessionKey)?.[1];
    const text = "Kova verification heartbeat wake.";
    const result = await ctx.rpc("wake", { mode: "now", text, sessionKey, ...(agentId ? { agentId } : {}) });
    // The response acknowledges scheduling; it does not attribute a later global heartbeat.
    return { woke: result, notices: { text, disposition: "submitted" } };
  }
};
await entrypoint(definition);
