#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { fillGroupSession } from "./channel-content.mjs";

await runEntry({ turns: { type: "string" } }, ({ args, env }) => withSessionClient(env, (rpc) => fillGroupSession({ rpc, turns: Number(args.turns ?? 40) })), process.argv.slice(2), (args) => {
  requireSessionContentRuntime();
  if (args.turns !== undefined && (!/^\d+$/.test(args.turns) || Number(args.turns) < 40 || Number(args.turns) > 500)) throw new EntryError("--turns must be between 40 and 500", 2);
});
