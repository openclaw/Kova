#!/usr/bin/env node
import { EntryError, runEntry } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { fillPairSession, watchPairSession, readChannelReceipt, requireChannelReceiptPath, writeChannelReceipt } from "./channel-content.mjs";

const argv = process.argv.slice(2);
const operation = argv.shift();
const options = operation === "watch" ? { watcher: { type: "string", required: true, pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ }, from: { type: "string", required: true } } : { out: { type: "string" } };
await runEntry(options, ({ args, env, state }) => withSessionClient(env, async (rpc) => {
  if (operation === "peer") return writeChannelReceipt(args.out, await fillPairSession({ rpc }));
  const { key } = await readChannelReceipt(args.from);
  return watchPairSession({ rpc, state, watcher: args.watcher, target: key });
}), argv, (args) => {
  requireSessionContentRuntime();
  if (!["peer", "watch"].includes(operation)) throw new EntryError("expected peer or watch", 2);
  requireChannelReceiptPath(args.out ?? args.from);
});
