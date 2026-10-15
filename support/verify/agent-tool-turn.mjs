import { CallError } from "./background.mjs";
import { entrypoint, jsonObject, nonempty, object, payload, sessionKey } from "./script.mjs";
import { sendTurn } from "./turn.mjs";

export const toolMessage = (name, args) => `KOVA_TOOL_CALL ${JSON.stringify({ name, arguments: args })}`;

function observedTool(call, result, response, runId) {
  const args = call?.args ?? call?.arguments ?? {};
  const wrapper = result?.details;
  const dispatched = call?.name === "tool_call" || call?.arguments?.id !== undefined;
  if (!dispatched || wrapper?.tool?.source !== "openclaw" || wrapper.tool.id !== `openclaw:core:${wrapper.tool.name}` || !wrapper.result || typeof wrapper.result !== "object") {
    return { name: call?.name, args, result, details: result?.details };
  }
  const activity = (response?.messages ?? []).filter((message) => message?.role === "custom" && message.customType === "openclaw.nested-tool.v1")
    .map((message) => message.details).filter((value) => value?.runId === runId && value.parentToolCallId === call.id && value.toolName === wrapper.tool.name && value.result);
  if (activity.length > 1) throw new CallError("bounded sessions.get read contains ambiguous dispatched tool input", 1);
  const selector = typeof args.id === "string" ? args.id.trim() : undefined;
  const canonicalInput = [wrapper.tool.id, wrapper.tool.name].includes(selector) && args.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
  const recordedInput = activity[0]?.input;
  const nativeInput = recordedInput && typeof recordedInput === "object" && !Array.isArray(recordedInput) ? recordedInput : canonicalInput;
  const input = call.name === "tool_call" ? nativeInput : args;
  const native = { ...wrapper.result, ...(result.isError === true ? { isError: true } : {}) };
  return { name: wrapper.tool.name, args: input, result: native, details: native.details };
}

export async function toolArguments(o, ctx, caller) {
  let args = jsonObject(o.args, "--args");
  if (o["merge-from"]) {
    const prior = payload(await ctx.read(o["merge-from"]));
    const values = object(observedTool(prior.toolCall, prior.toolResult).details ?? prior, "--merge-from result");
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
    const observed = observedTool(source.toolCall, source.toolResult);
    if (prior.error !== null || source.callerSessionKey !== caller || observed.name !== "sessions_spawn" || observed.details?.status !== "accepted" || observed.result?.isError === true) throw new CallError("--from must be this caller's accepted spawn");
    const spawned = observed.details;
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
    // Nested activity is a bounded display copy. The model's outer invocation
    // owns the complete raw result and its creation metadata.
    const calls = sent.messages.filter((message) => message?.role === "assistant")
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "toolCall" && !part.parentToolCallId && (part.name === o.tool || part.name === "tool_call" && part.arguments?.id === o.tool));
    const call = calls.at(-1);
    const toolCall = call ? { ...call, name: o.tool, args } : null;
    ctx.record?.({ toolCall, reply: sent.reply });
    const response = call ? await ctx.rpc("sessions.get", { key: caller, limit: 200 }) : null;
    const result = call ? readToolResult(response, sent.receipt.runId, call) : null;
    ctx.record?.({ toolResult: result ? { ...result, details: result.details ?? null } : null });
    const observed = observedTool(toolCall, result, response, sent.receipt.runId);
    const { name, args: input, details } = observed;
    const createdIds = [];
    let child = null;
    if (name === "sessions_spawn" && details?.status === "accepted" && observed.result?.isError !== true) {
      child = nonempty(details.childSessionKey) ? details.childSessionKey : null;
      createdIds.push(...[child, details.runId].filter(nonempty));
    } else if (name === "sessions_send") {
      if (details?.status === "queued" && details.runStarted === false && nonempty(details.notificationId) && observed.result?.isError !== true) createdIds.push(details.notificationId);
      else if (nonempty(details?.runId) && ((["accepted", "ok", "no_reply"].includes(details.status) && observed.result?.isError !== true) || details.sentBeforeError === true)) createdIds.push(details.runId);
    } else if (name === "exec" && details?.status === "running" && nonempty(details?.sessionId) && observed.result?.isError !== true) createdIds.push(details.sessionId);
    else if (name === "create_goal" && details?.status === "created" && nonempty(details?.goal?.id) && observed.result?.isError !== true) createdIds.push(details.goal.id);
    else if (["automations", "cron"].includes(name) && observed.result?.isError !== true) {
      const action = typeof input?.action === "string" ? input.action.trim() : "";
      if (action === "add" && details?.created !== false) {
        const id = details?.created === true ? details.job?.id : details?.job === undefined ? details?.id : undefined;
        if (nonempty(id)) createdIds.push(id);
      } else if (action === "run" && details?.ok === true && details.enqueued === true && nonempty(details.runId)) createdIds.push(details.runId);
    }
    return { callerSessionKey: caller, sessionKey: child, toolCall, toolResult: result ? { ...result, details: result.details ?? null } : null, reply: sent.reply, createdIds: [...new Set(createdIds)] };
  }
};
await entrypoint(definition);
