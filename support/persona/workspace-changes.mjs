#!/usr/bin/env node
import { runEntry } from "./common.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { withSessionClient } from "./session-content.mjs";
import { populateWorkspace } from "./workspace-content.mjs";

await runEntry({
  key: { type: "string", required: true, pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ },
}, ({ args, env, state }) => withSessionClient(env, (rpc) => populateWorkspace({ rpc, key: args.key, state })), process.argv.slice(2), requireSessionContentRuntime);
