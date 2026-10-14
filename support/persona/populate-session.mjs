#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";
import { withSessionClient } from "./session-content.mjs";
import { buildSessionExtras } from "./session-extras.mjs";
import { buildHistoryContent } from "./session-history.mjs";

const operations = {
  "fill-to-threshold": "session-at-compaction-threshold",
  "prune-tool-results": "session-pruned-projections",
  "create-goal": "session-goal-active",
  "put-progress-card": "session-progress-card",
  "interrupt-inputs": "session-interrupted-inputs",
  "enable-public-share": "session-public-shared",
  "expire-idle": "session-idle-expired",
};
const argv = process.argv.slice(2);
const operation = argv.shift();
const kind = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
const usesTools = operation === "prune-tool-results" || operation === "create-goal";

await runEntry({
  key: { type: "string", required: true, pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ },
  ...(usesTools ? { "tool-model": { type: "string", required: true } } : {}),
}, ({ args, env, state, workspace }) => withSessionClient(env, async (rpc) => {
  const options = { kind, toolModel: args["tool-model"] };
  if (operation === "fill-to-threshold" || operation === "prune-tool-results") {
    await buildHistoryContent({ rpc, key: args.key, options, env, workspace });
  } else {
    return buildSessionExtras({ rpc, key: args.key, options, state });
  }
  return { key: args.key };
}), argv, (args) => {
  requireSessionContentRuntime();
  if (!kind) throw new EntryError("unknown session population operation", 2);
  if (operation === "expire-idle" && !/:thread:[^:]+$/.test(args.key)) throw new EntryError("idle content requires a thread session key", 2);
});
