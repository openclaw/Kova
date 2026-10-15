import { CallError } from "./background.mjs";
import { disposableEnv, finishHelper, runHelper } from "./helper.mjs";
import { entrypoint, nonempty } from "./script.mjs";

export const definition = {
  id: "session-send-turn", url: import.meta.url,
  flags: ["env", "session-key", "create-session", "message", "timeout"],
  empty: () => ({ sessionKey: null, reply: null, elapsedMs: 0, createdIds: [] }),
  validate(o) {
    disposableEnv(o);
    if (!nonempty(o["session-key"])) throw new CallError("--session-key is required");
    if (o["create-session"] !== undefined && !["true", "false"].includes(o["create-session"])) throw new CallError("--create-session must be true or false");
  },
  async run(o, ctx) {
    const args = ["--env", o.env, "--session-key", o["session-key"], "--create-session", o["create-session"] ?? "true", "--timeout", String(ctx.remaining())];
    if (o.message !== undefined) args.push("--message", o.message);
    const result = await runHelper("run-gateway-session-send-turn", args, ctx);
    return finishHelper(result, {
      sessionKey: result.value.sessionKey ?? null,
      reply: result.value.finalAssistantVisibleText ?? null,
      createdIds: nonempty(result.value.runId) ? [result.value.runId] : []
    }, ctx);
  }
};
await entrypoint(definition);
