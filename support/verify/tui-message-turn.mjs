import { CallError } from "./background.mjs";
import { disposableEnv, finishHelper, runHelper } from "./helper.mjs";
import { entrypoint, nonempty } from "./script.mjs";

export const definition = {
  cancellationExitCode: 3,
  id: "tui-message-turn", url: import.meta.url,
  flags: ["env", "session", "message", "timeout"],
  empty: () => ({ reply: null, elapsedMs: 0 }),
  validate(o) {
    disposableEnv(o);
    if (!nonempty(o.session) || !nonempty(o.message)) throw new CallError("--session and --message are required");
  },
  async run(o, ctx) {
    const result = await runHelper("run-tui-message-turn", ["--env", o.env, "--session", o.session, "--message", o.message, "--timeout", String(ctx.remaining())], ctx);
    return finishHelper(result, { reply: result.value.matchedText ?? null }, ctx);
  }
};
await entrypoint(definition);
