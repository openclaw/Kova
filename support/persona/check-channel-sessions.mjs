#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { channelSessionKinds, checkChannelSessions } from "./channel-content.mjs";

const argv = process.argv.slice(2);
const kind = argv.shift();
await runEntry({ key: { type: "string", pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ } }, ({ args, env, state }) => withSessionClient(env, (rpc) => checkChannelSessions({ rpc, state, kind, key: args.key })), argv, () => {
  requireSessionContentRuntime();
  if (!channelSessionKinds.includes(kind)) throw new EntryError("a supported channel session content name is required", 2);
});
