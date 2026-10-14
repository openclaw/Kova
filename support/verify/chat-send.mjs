import { CallError } from "./background.mjs";
import { entrypoint, nonempty, payload, sessionKey } from "./script.mjs";
import { sendTurn } from "./turn.mjs";
export const definition = {
  id: "chat-send", url: import.meta.url,
  flags: ["env", "session-key", "message", "queue-mode", "intent", "expected-leaf", "incognito-handle", "timeout", "background", "handle", "wait", "session-from", "after-ms"],
  booleans: ["background"],
  empty: () => ({ receipt: null, reply: null, elapsedMs: 0, createdIds: [] }),
  validate(o) {
    if (o.intent !== undefined && o.intent !== "session-goal-start") throw new CallError("invalid --intent");
    if (o.message === undefined) throw new CallError("--message is required");
    if (o["queue-mode"] !== undefined && !["steer", "followup", "collect", "interrupt"].includes(o["queue-mode"])) throw new CallError("invalid --queue-mode");
    o.afterMs = o["after-ms"] === undefined ? 0 : Number(o["after-ms"]);
    if (!Number.isSafeInteger(o.afterMs) || o.afterMs < 0 || o.afterMs > 2147483647 - o.timeoutMs - 1000) throw new CallError("invalid --after-ms");
  },
  async run(o, ctx) {
    if (o["incognito-handle"]) {
      const record = payload(await ctx.read(o["incognito-handle"]));
      const key = record.sessionKey ?? record.key;
      if (!nonempty(key) || o["session-key"] && o["session-key"] !== key || o["session-from"]) throw new CallError("incognito handle must identify the selected session");
      o = { ...o, "session-key": key };
    }
    const key = await sessionKey(o, ctx);
    const params = {};
    for (const [flag, field] of [["queue-mode", "queueMode"], ["expected-leaf", "expectedLeafEntryId"]]) if (o[flag] !== undefined) params[field] = o[flag];
    if (o.intent) params.intent = { kind: o.intent, version: 1, issuedAtMs: Date.now() };
    const { receipt, reply, createdIds } = await sendTurn(ctx, key, o.message, { params });
    return { receipt, reply, createdIds };
  }
};
await entrypoint(definition);
