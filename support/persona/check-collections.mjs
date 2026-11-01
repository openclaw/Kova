#!/usr/bin/env node
import { runEntry } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { checkSessionCollection, collectionAgentPattern, requireCollectionKind } from "./session-collections.mjs";

const argv = process.argv.slice(2);
const kind = argv.shift();
await runEntry({ agent: { type: "string", required: true, pattern: collectionAgentPattern } }, ({ args, env, state }) => withSessionClient(env, (rpc) => checkSessionCollection({ rpc, kind, agentId: args.agent, state })), argv, (args) => requireCollectionKind(kind, args.agent));
