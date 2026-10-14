#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { fillMainSession } from "./channel-content.mjs";

await runEntry({ turns: { type: "string" } }, ({ args, env }) => withSessionClient(env, (rpc) => fillMainSession({ rpc, turns: Number(args.turns ?? 90) })), process.argv.slice(2), (args) => {
  requireSessionContentRuntime();
  if (args.turns !== undefined && (!/^\d+$/.test(args.turns) || Number(args.turns) < 90 || Number(args.turns) > 500)) throw new EntryError("--turns must be between 90 and 500", 2);
});
