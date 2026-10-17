import { join } from "node:path";
import { CallError, joinOperation } from "./background.mjs";
import { entrypoint, nonempty, payload, sessionKey } from "./script.mjs";
import { inputReceipt, readTurnFile, recordedTurn, runningTurn, sendTurn } from "./turn.mjs";

async function queuedAdmission(ctx, source, sessionId, runId) {
  if (runId === source.record.runId) throw new CallError("queued input reused the active run identity");
  for (;;) {
    // The started ACK precedes queue transfer; its newer controller can briefly
    // replace the producer in the session's single in-flight presentation.
    await runningTurn(ctx, source, { sessionId, wait: true });
    const input = await inputReceipt(ctx, source.record.sessionKey, sessionId, runId);
    if (input?.state === "pending" && input.queued === true && input.cancelled !== true) {
      await runningTurn(ctx, source, { sessionId });
      return {
        sessionKey: source.record.sessionKey, sessionId, runId,
        producerOperationId: source.operation.id, producerRunId: source.record.runId,
        input, observedAtMs: Date.now()
      };
    }
    if (input && (input.state !== "pending" || input.cancelled === true)) throw new CallError("submitted input was consumed or cancelled before queued admission was confirmed");
    await ctx.pause(Math.min(100, ctx.remaining()));
  }
}

async function waitForCancellation(o, ctx) {
  const key = await sessionKey(o, ctx);
  const source = await recordedTurn(ctx, o.wait, o.env, key, { entries: ["chat-send"], live: false, waitForReceipt: false });
  const admission = await readTurnFile(ctx, join(source.operation.directory, "queue-admission.json"));
  if (!admission || admission.operationId !== source.operation.id || admission.entry !== "chat-send" || admission.env !== o.env || admission.sessionKey !== key || admission.runId !== source.record.runId || !nonempty(admission.sessionId) || !nonempty(admission.producerOperationId) || !nonempty(admission.producerRunId) || admission.producerRunId === admission.runId || admission.input?.runId !== admission.runId || admission.input.state !== "pending" || admission.input.queued !== true || admission.input.cancelled === true) throw new CallError("cancellation wait requires this operation's confirmed queued input");
  const joined = await joinOperation(o.wait, { method: "chat-send", env: o.env, timeoutMs: ctx.remaining(), signal: ctx.signal });
  if (joined.exitCode !== 0 || joined.output?.error !== null) throw new CallError(joined.output?.error ?? "queued operation did not complete successfully", joined.exitCode || 1);
  const receipt = joined.output.receipt;
  if (receipt?.runId !== admission.runId || receipt.completion?.runId !== admission.runId) throw new CallError("joined result does not identify the admitted input");
  ctx.record({ receipt, reply: joined.output.reply });
  for (;;) {
    const input = await inputReceipt(ctx, key, admission.sessionId, admission.runId);
    if (input?.state === "pending" && input.cancelled === true && input.queued !== true) {
      return { receipt: { ...receipt, cancellation: input }, reply: joined.output.reply, createdIds: [] };
    }
    if (!input || input.state !== "pending" || input.cancelled === true) throw new CallError("admitted input has no native cancellation receipt");
    await ctx.pause(Math.min(100, ctx.remaining()));
  }
}

export const definition = {
  id: "chat-send", url: import.meta.url,
  cancellationExitCode: (argv) => argv.some((arg) => arg === "--busy-from" || arg.startsWith("--busy-from=") || arg === "--expect-cancelled") ? 3 : undefined,
  recordsTurn: true,
  flags: ["env", "session-key", "message", "queue-mode", "intent", "expected-leaf", "incognito-handle", "timeout", "background", "handle", "wait", "session-from", "after-ms", "busy-from", "expect-cancelled"],
  booleans: ["background", "expect-cancelled"],
  waitFlags: ["session-key", "expect-cancelled"],
  validateWait(o) {
    if (o["expect-cancelled"]) {
      if (!nonempty(o.env) || !nonempty(o["session-key"])) throw new CallError("--expect-cancelled requires --env and --session-key");
    } else if (o["session-key"] !== undefined) throw new CallError("--wait with --session-key requires --expect-cancelled");
  },
  waitHandler: (o) => o["expect-cancelled"] ? waitForCancellation : undefined,
  deferBackground: (o) => Boolean(o["busy-from"]),
  empty: () => ({ receipt: null, reply: null, elapsedMs: 0, createdIds: [] }),
  validate(o) {
    if (o["expect-cancelled"]) throw new CallError("--expect-cancelled requires --wait");
    if (o["busy-from"] && (!o.background || o["queue-mode"] !== "followup")) throw new CallError("--busy-from requires --background and --queue-mode followup");
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
    const source = o["busy-from"] ? await recordedTurn(ctx, o["busy-from"], o.env, key) : null;
    const active = source ? await runningTurn(ctx, source, { wait: true }) : null;
    const params = {};
    for (const [flag, field] of [["queue-mode", "queueMode"], ["expected-leaf", "expectedLeafEntryId"]]) if (o[flag] !== undefined) params[field] = o[flag];
    if (o.intent) params.intent = { kind: o.intent, version: 1, issuedAtMs: Date.now() };
    let admission;
    const { receipt, reply, createdIds } = await sendTurn(ctx, key, o.message, {
      params,
      ...(source ? { onSubmitted: async (submitted) => {
        admission = await queuedAdmission(ctx, source, active.sessionId, submitted.runId);
        ctx.remaining();
        await ctx.recordAdmission?.(admission);
        ctx.remaining();
        await ctx.publishBackground?.();
      } } : {})
    });
    return { receipt: admission ? { ...receipt, admission } : receipt, reply, createdIds };
  }
};
await entrypoint(definition);
