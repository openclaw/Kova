#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { fillMainSession, requireChannelReceiptPath, writeChannelReceipt } from "./channel-content.mjs";

const argv = process.argv.slice(2);
const ingress = argv.shift();
await runEntry({ turns: { type: "string" }, out: { type: "string" } }, ({ args, env }) => withSessionClient(env, async (rpc) => writeChannelReceipt(args.out, await fillMainSession({ rpc, ingress, turns: Number(args.turns ?? 45) }))), argv, (args) => {
  requireSessionContentRuntime();
  if (!["direct", "ui"].includes(ingress)) throw new EntryError("expected direct or ui", 2);
  requireChannelReceiptPath(args.out);
  if (args.turns !== undefined && (!/^\d+$/.test(args.turns) || Number(args.turns) < 1 || Number(args.turns) > 500)) throw new EntryError("--turns must be between 1 and 500", 2);
});
