#!/usr/bin/env node
import { runEntry } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { spawnChildren } from "./channel-content.mjs";

await runEntry({ parent: { type: "string", required: true, pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ }, "tool-model": { type: "string", required: true } }, ({ args, env, state }) => withSessionClient(env, (rpc) => spawnChildren({ rpc, state, parent: args.parent, toolModel: args["tool-model"] })), process.argv.slice(2), requireSessionContentRuntime);
