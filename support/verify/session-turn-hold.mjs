import { CallError } from "./background.mjs";
import { entrypoint, positiveInteger, sessionKey } from "./script.mjs";
import { sendTurn } from "./turn.mjs";
export const definition = {
  id: "session-turn-hold", url: import.meta.url,
  flags: ["env", "session-key", "hold-ms", "progress-cards", "timeout", "background", "handle", "wait"],
  booleans: ["progress-cards", "background"],
  empty: () => ({ runId: null, sessionKey: null, reply: null, elapsedMs: 0, createdIds: [] }),
  validate(o) { if (o["hold-ms"] === undefined) throw new CallError("--hold-ms is required"); o.holdMs = positiveInteger(o["hold-ms"], undefined, 300000); },
  async run(o, ctx) {
    const key = await sessionKey(o, ctx);
    const message = `KOVA_VERIFY_HOLD ${JSON.stringify({ holdMs: o.holdMs, progressCards: o["progress-cards"] === true })}`;
    const { receipt, reply, createdIds } = await sendTurn(ctx, key, message, { method: "sessions.send" });
    return { runId: receipt?.runId ?? null, sessionKey: key, reply, createdIds };
  }
};
await entrypoint(definition);
