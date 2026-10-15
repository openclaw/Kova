import { CallError } from "./background.mjs";
import { entrypoint, jsonObject, nonempty, object, payload, sessionKey } from "./script.mjs";
import { sendTurn } from "./turn.mjs";

export const toolMessage = (name, args) => `KOVA_TOOL_CALL ${JSON.stringify({ name, arguments: args })}`;

export async function toolArguments(o, ctx, caller) {
  let args = jsonObject(o.args, "--args");
  if (o["merge-from"]) {
    const prior = payload(await ctx.read(o["merge-from"]));
    const values = object(prior.toolResult?.details ?? prior, "--merge-from result");
    args = { ...values, ...args };
  }
  if (!o.from) return args;
  const prior = await ctx.read(o.from);
  const source = payload(prior);
  const set = (field, value) => {
    if (!nonempty(value) && !(Array.isArray(value) && value.length === 1 && nonempty(value[0]))) throw new CallError(`--from has no ${field}`);
    if (args[field] !== undefined && JSON.stringify(args[field]) !== JSON.stringify(value)) throw new CallError(`--from conflicts with ${field}`);
    args[field] = value;
  };
  if (prior.method === "sessions.create" && ["sessions_send", "session_status"].includes(o.tool)) {
    if (prior.error !== null) throw new CallError("--from requires an error-free creation");
    set("sessionKey", source.key);
  } else if (prior.method === "sessions.describe" && o.tool === "sessions" && args.action === "patch" && typeof args.archived === "boolean") {
    if (prior.error !== null || source.session?.key !== args.sessionKey) throw new CallError("--from describes a different session");
    set("expectedSessionId", source.session?.sessionId);
  } else {
    if (prior.error !== null || source.callerSessionKey !== caller || source.toolCall?.name !== "sessions_spawn" || source.toolResult?.details?.status !== "accepted") throw new CallError("--from must be this caller's accepted spawn");
    const spawned = source.toolResult.details;
    if (o.tool === "subagents" && args.action === "cancel") set("runId", spawned.runId);
    else if (o.tool === "subagents" && args.action === "wait") set("runIds", [spawned.runId]);
    else if (o.tool === "sessions_send") set("sessionKey", spawned.childSessionKey);
    else throw new CallError("--from is unsupported for this tool operation");
  }
  return args;
}

function readToolResult(response, runId, call) {
  if (!Array.isArray(response?.messages)) throw new CallError("sessions.get did not return messages", 1);
  const candidates = response.messages.filter((message) => message?.__openclaw?.runId === runId)
    .flatMap((message) => [message, ...(Array.isArray(message.content) ? message.content : [])]);
  for (const message of response.messages) {
    if (message?.role !== "custom" || message.customType !== "openclaw.nested-tool.v1" || message.details?.runId !== runId) continue;
    const { input, result, ...callData } = message.details;
    if (result && typeof result === "object" && !Array.isArray(result)) candidates.push({ ...callData, ...result, type: "toolResult" });
  }
  const matches = candidates.filter((message) => message &&
    (["toolResult", "tool"].includes(message.role) || message.type === "toolResult") &&
    (message.toolCallId ?? message.tool_call_id) === call.id &&
    (message.toolName === undefined || message.toolName === call.name));
  if (matches.length !== 1) throw new CallError("bounded sessions.get read must contain exactly one result for the submitted run and tool call", 1);
  return matches[0];
}

export const definition = {
  id: "agent-tool-turn", url: import.meta.url,
  flags: ["env", "session-key", "tool", "args", "out", "timeout", "background", "handle", "wait", "session-from", "merge-from", "from"],
  booleans: ["background"],
  empty: () => ({ callerSessionKey: null, sessionKey: null, toolCall: null, toolResult: null, reply: null, elapsedMs: 0, createdIds: [] }),
  validate(o) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(o.tool ?? "")) throw new CallError("--tool must be a tool name");
    jsonObject(o.args, "--args");
  },
  async run(o, ctx) {
    const caller = await sessionKey(o, ctx);
    const args = await toolArguments(o, ctx, caller);
    ctx.record?.({ callerSessionKey: caller });
    const sent = await sendTurn({ ...ctx, record: undefined }, caller, toolMessage(o.tool, args));
    const calls = sent.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((part) => part.type === "toolCall" && (part.name === o.tool || part.name === "tool_call" && part.arguments?.id === o.tool));
    const call = calls.at(-1);
    const toolCall = call ? { ...call, name: o.tool, args } : null;
    ctx.record?.({ toolCall, reply: sent.reply });
    const result = call ? readToolResult(await ctx.rpc("sessions.get", { key: caller, limit: 200 }), sent.receipt.runId, call) : null;
    const details = result?.details ?? null;
    const createdIds = [];
    let child = null;
    if (o.tool === "sessions_spawn" && details?.status === "accepted" && result?.isError !== true) {
      child = nonempty(details.childSessionKey) ? details.childSessionKey : null;
      createdIds.push(...[child, details.runId].filter(nonempty));
    } else if (o.tool === "sessions_send") {
      if (details?.status === "queued" && details.runStarted === false && nonempty(details.notificationId) && result?.isError !== true) createdIds.push(details.notificationId);
      else if (nonempty(details?.runId) && ((["accepted", "ok", "no_reply"].includes(details.status) && result?.isError !== true) || details.sentBeforeError === true)) createdIds.push(details.runId);
    } else if (o.tool === "exec" && details?.status === "running" && nonempty(details?.sessionId) && result?.isError !== true) createdIds.push(details.sessionId);
    else if (o.tool === "create_goal" && details?.status === "created" && nonempty(details?.goal?.id) && result?.isError !== true) createdIds.push(details.goal.id);
    return { callerSessionKey: caller, sessionKey: child, toolCall, toolResult: result ? { ...result, details } : null, reply: sent.reply, createdIds };
  }
};
await entrypoint(definition);
