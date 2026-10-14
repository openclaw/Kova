#!/usr/bin/env node
import { runEntry } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { fillPairSession } from "./channel-content.mjs";

await runEntry({ "tool-model": { type: "string", required: true } }, ({ args, env, state }) => withSessionClient(env, (rpc) => fillPairSession({ rpc, state, toolModel: args["tool-model"] })), process.argv.slice(2), requireSessionContentRuntime);
