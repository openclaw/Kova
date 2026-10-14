#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { buildSessionCollection, collectionAgentPattern, openCollectionFixture, requireCollectionKind } from "./session-collections.mjs";

const operations = { organized: "sessions-organized-mixed", "stale-dashboard": "sessions-stale-dashboard", "global-pair": "agents-multiple-with-global-key" };
const argv = process.argv.slice(2);
const operation = argv.shift();
const kind = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
await runEntry({ agent: { type: "string", required: true, pattern: collectionAgentPattern } }, ({ args, env, state }) => withSessionClient(env, async (rpc) => {
  const writeFixture = operation === "global-pair" ? undefined : await openCollectionFixture(env, state);
  return buildSessionCollection({ rpc, kind, agentId: args.agent, state, writeFixture });
}), argv, (args) => {
  if (!kind) throw new EntryError("unknown session organization operation", 2);
  requireCollectionKind(kind, args.agent);
});
