import { CallError } from "./background.mjs";
import { entrypoint, positiveInteger, sessionKey } from "./script.mjs";
import { recordedTurn, runningTurn, sendTurn } from "./turn.mjs";

export async function requireHeldTurn(o, ctx, key) {
  const source = await recordedTurn(ctx, o.from, o.env, key, { entries: ["session-turn-hold"] });
  const { holdMs, submittedAtMs, holdUntilMs, deadlineAtMs } = source.record;
  const startedAtMs = Date.parse(source.operation.startedAt);
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > 300000 || !Number.isSafeInteger(submittedAtMs) || submittedAtMs < startedAtMs || submittedAtMs > Date.now() || holdUntilMs !== submittedAtMs + holdMs) throw new CallError("held turn has no valid duration receipt");
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= submittedAtMs) throw new CallError("held turn has no valid completion deadline");
  const remaining = () => Math.min(holdUntilMs, deadlineAtMs, source.expiresAtMs) - Date.now();
  if (remaining() < o.minRemainingMs) throw new CallError("held turn has insufficient remaining time");
  await runningTurn(ctx, source, { wait: true });
  if (remaining() < o.minRemainingMs) throw new CallError("held turn has insufficient remaining time");
  return { runId: source.record.runId, sessionKey: key, reply: null, createdIds: [] };
}

export const definition = {
  id: "session-turn-hold", url: import.meta.url,
  flags: ["env", "session-key", "hold-ms", "progress-cards", "timeout", "background", "handle", "wait", "from", "require-active", "min-remaining-ms"],
  booleans: ["progress-cards", "background", "require-active"],
  empty: () => ({ runId: null, sessionKey: null, reply: null, elapsedMs: 0, createdIds: [] }),
  validate(o) {
    if (o.from) {
      if (!o["require-active"] || o["min-remaining-ms"] === undefined) throw new CallError("--from requires --require-active and --min-remaining-ms");
      for (const flag of ["hold-ms", "progress-cards", "background", "handle"]) if (o[flag] !== undefined) throw new CallError(`--from cannot be combined with --${flag}`);
      o.minRemainingMs = positiveInteger(o["min-remaining-ms"], undefined, 300000);
    } else {
      if (o["require-active"] || o["min-remaining-ms"] !== undefined) throw new CallError("active-turn assertions require --from");
      if (o["hold-ms"] === undefined) throw new CallError("--hold-ms is required");
      o.holdMs = positiveInteger(o["hold-ms"], undefined, 300000);
    }
  },
  async run(o, ctx) {
    const deadlineAtMs = Date.now() + ctx.remaining() - 1;
    const key = await sessionKey(o, ctx);
    if (o.from) return await requireHeldTurn(o, ctx, key);
    const message = `KOVA_VERIFY_HOLD ${JSON.stringify({ holdMs: o.holdMs, progressCards: o["progress-cards"] === true })}`;
    const { receipt, reply, createdIds } = await sendTurn(ctx, key, message, {
      method: "sessions.send",
      onSubmitted: async (receipt, { submittedAtMs }) => {
        // Submission precedes the mock provider's timer, so this is a lower bound.
        await ctx.recordSubmission?.({ sessionKey: key, runId: receipt.runId, submittedAtMs, holdMs: o.holdMs, holdUntilMs: submittedAtMs + o.holdMs, deadlineAtMs });
      }
    });
    return { runId: receipt?.runId ?? null, sessionKey: key, reply, createdIds };
  }
};
await entrypoint(definition);
