#!/usr/bin/env node
import { EntryError, runEntry } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { spawnChild, resumeChild, readChannelReceipt, requireChannelReceiptPath, writeChannelReceipt } from "./channel-content.mjs";

const argv = process.argv.slice(2);
const operation = argv.shift();
const options = operation === "resume" ? { from: { type: "string", required: true } } : {
  parent: { type: "string", required: true, pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ },
  "tool-model": { type: "string", required: true }, yield: { type: "boolean" }, out: { type: "string" },
};
await runEntry(options, ({ args, env, state }) => withSessionClient(env, async (rpc) => {
  if (operation === "spawn") return writeChannelReceipt(args.out, await spawnChild({ rpc, state, parent: args.parent, toolModel: args["tool-model"], yielded: args.yield }));
  return resumeChild({ rpc, key: (await readChannelReceipt(args.from)).key });
}), argv, (args) => {
  requireSessionContentRuntime();
  if (!["spawn", "resume"].includes(operation)) throw new EntryError("expected spawn or resume", 2);
  requireChannelReceiptPath(args.out ?? args.from);
});
