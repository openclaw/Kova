#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { buildSessionCollection, collectionAgentPattern, openCollectionFixture, requireCollectionKind } from "./session-collections.mjs";

const operations = { "near-cap": "sessions-thousands-near-cap", "stale-over-cap": "store-stale-sessions-over-cap" };
const argv = process.argv.slice(2);
const operation = argv.shift();
const kind = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
await runEntry({ agent: { type: "string", required: true, pattern: collectionAgentPattern } }, ({ args, env, state }) => withSessionClient(env, async (rpc) => {
  const writeFixture = operation === "stale-over-cap" ? await openCollectionFixture(env, state) : undefined;
  return buildSessionCollection({ rpc, kind, agentId: args.agent, state, writeFixture });
}), argv, (args) => {
  if (!kind) throw new EntryError("unknown bulk session operation", 2);
  requireCollectionKind(kind, args.agent);
});
