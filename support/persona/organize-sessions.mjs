#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { createCollectionSessions, patchStaleCollection, writeCollectionHistory, populateCollectionParent, forkCollectionParent, collectionAgentPattern, openCollectionFixture, requireCollectionKind } from "./session-collections.mjs";

const operations = { create: createCollectionSessions, patch: patchStaleCollection, historical: writeCollectionHistory, populate: populateCollectionParent, fork: forkCollectionParent };
const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry({
  agent: { type: "string", required: true, pattern: collectionAgentPattern },
  collection: { type: "string", required: true },
  start: { type: "string", pattern: /^\d+$/ }, count: { type: "string", pattern: /^\d+$/ },
  fields: { type: "string" }, out: { type: "string" },
}, ({ args, env, state }) => withSessionClient(env, async (rpc) => {
  const writeFixture = operation === "historical" ? await openCollectionFixture(env, state) : undefined;
  const result = await operations[operation]({ rpc, kind: args.collection, agentId: args.agent, state, writeFixture, start: Number(args.start), count: Number(args.count), fields: args.fields ? JSON.parse(args.fields) : undefined });
  if (args.out) await writeFile(args.out, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}), argv, (args) => {
  if (!Object.hasOwn(operations, operation)) throw new EntryError("unknown collection operation", 2);
  requireCollectionKind(args.collection, args.agent);
  if (["populate", "fork"].includes(operation) && args.collection !== "sessions-organized-mixed") throw new EntryError("operation requires the organized collection", 2);
  if (operation === "patch") {
    if (args.collection !== "store-stale-sessions-over-cap" || args.start === undefined || args.count === undefined || !args.fields) throw new EntryError("patch requires a stale collection range and fields", 2);
    try { JSON.parse(args.fields); } catch { throw new EntryError("invalid patch JSON", 2); }
  } else if (args.start !== undefined || args.count !== undefined || args.fields !== undefined) throw new EntryError("range and fields require patch", 2);
});
