import { CallError } from "./background.mjs";
import { entrypoint, nonempty } from "./script.mjs";
export function inboundParams(o) {
  const params = { message: o.text, targetId: o.peer, chatType: o["chat-type"] === "direct" ? "direct" : "group" };
  if (params.chatType === "group") {
    if (o["chat-type"] === "thread") {
      const match = /^group:([^/]+)\/thread:(.+)$/.exec(o.peer);
      if (!match) throw new CallError("thread --peer must be group:<parent>/thread:<id>");
      params.targetId = `group:${match[1]}`; params.threadId = match[2];
    } else if (!o.peer.startsWith("group:")) params.targetId = `group:${o.peer}`;
    params.wasMentioned = /(?:^|\s)@bot(?:\s|$|[,.!?])/.test(o.text);
  }
  return params;
}
export const definition = {
  id: "channel-inbound-turn", url: import.meta.url,
  flags: ["env", "chat-type", "peer", "text", "timeout"],
  empty: () => ({ sessionKey: null, reply: null, elapsedMs: 0, createdIds: [] }),
  validate(o) {
    if (!["direct", "group", "thread"].includes(o["chat-type"]) || !nonempty(o.peer) || !nonempty(o.text)) throw new CallError("--chat-type, --peer and --text are required");
    inboundParams(o);
  },
  async run(o, ctx) {
    const result = await ctx.rpc("kova.channelProbe.inject", inboundParams(o));
    const observed = result?.observation;
    const createdIds = [...new Set([observed?.inboundEvent?.id, ...(Array.isArray(observed?.outboundRecords) ? observed.outboundRecords : []).map((row) => row.messageId)].filter(nonempty))];
    const output = { sessionKey: observed?.routeSessionKey ?? null, reply: observed ?? result, createdIds };
    ctx.record?.(output);
    const error = observed?.error ?? (result?.ok === false ? result.error ?? "channel probe refused the request" : null);
    if (error) throw new CallError(String(error), 1);
    return output;
  }
};
await entrypoint(definition);
