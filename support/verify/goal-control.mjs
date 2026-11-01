import { randomUUID } from "node:crypto";
import { CallError } from "./background.mjs";
import { entrypoint, nonempty, object, sessionKey } from "./script.mjs";
export async function resolveGoalRequest(o, ctx) {
  const key = await sessionKey(o, ctx);
  const method = o.action === "clear" ? "sessions.goal.clear" : "sessions.goal.update";
  let params = { sessionKey: key, goalId: o["goal-id"], operationId: randomUUID(), issuedAtMs: Date.now(), ...(o.action === "clear" ? {} : { action: o.action }), ...(o.objective === undefined ? {} : { objective: o.objective }), ...(o.note === undefined ? {} : { note: o.note }) };
  if (o.replay) {
    const source = object(await ctx.read(o.from), "--from");
    const request = object(source.request, "earlier request");
    const earlier = object(request.params, "earlier params");
    if (source.error !== null || source.operationId !== earlier.operationId || request.method !== method || earlier.sessionKey !== key || earlier.goalId !== o["goal-id"] || (earlier.action ?? "clear") !== o.action || !nonempty(earlier.operationId) || earlier.operationId.length > 128 || !Number.isSafeInteger(earlier.issuedAtMs) || earlier.issuedAtMs < 0) throw new CallError("--from does not identify the same successful goal operation");
    const allowed = ["sessionKey", "goalId", "operationId", "issuedAtMs", ...(o.action === "clear" ? [] : ["action"]), ...(o.action === "edit" ? ["objective"] : o.action === "clear" ? [] : ["note"])];
    if (Object.keys(earlier).some((field) => !allowed.includes(field)) || o.objective !== undefined && o.objective !== earlier.objective || o.note !== undefined && o.note !== (earlier.note ?? "")) throw new CallError("replay conflicts with the original request");
    if (o.action === "edit" && (!nonempty(earlier.objective) || earlier.objective.length > 16000) || earlier.note !== undefined && (typeof earlier.note !== "string" || earlier.note.length > 2000)) throw new CallError("invalid prior goal request");
    params = earlier;
  }
  return { method, params };
}

export const definition = {
  id: "goal-control", url: import.meta.url,
  flags: ["env", "session-key", "action", "goal-id", "note", "objective", "replay", "from", "out", "timeout"],
  booleans: ["replay"],
  empty: () => ({ goal: null, operationId: null, request: null, elapsedMs: 0, createdIds: [] }),
  validate(o) {
    if (!["edit", "pause", "resume", "block", "complete", "clear"].includes(o.action)) throw new CallError("invalid --action");
    if (!nonempty(o["goal-id"])) throw new CallError("--goal-id is required");
    if (Boolean(o.replay) !== Boolean(o.from)) throw new CallError("--replay requires --from and vice versa");
    if (!o.replay && o.action === "edit" && (!nonempty(o.objective) || o.objective.length > 16000)) throw new CallError("edit requires --objective (1 to 16000 characters)");
    if (o.note !== undefined && (o.note.length > 2000 || ["clear", "edit"].includes(o.action))) throw new CallError("--note applies to status changes and has at most 2000 characters");
    if (o.objective !== undefined && o.action !== "edit") throw new CallError("--objective applies only to edit");
  },
  async run(o, ctx) {
    const { method, params } = await resolveGoalRequest(o, ctx);
    const result = await ctx.rpc(method, params);
    return { goal: result?.goal ?? null, operationId: result?.operationId ?? null, request: { method, params }, createdIds: result?.replayed === true ? [] : [...new Set([result?.operationId, result?.runId].filter(nonempty))] };
  }
};
await entrypoint(definition);
