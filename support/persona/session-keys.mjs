#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { readSessionKeys, withSessionClient, sessionRequests } from "./session-content.mjs";
import { checkSessionExtra, sessionExtraKinds } from "./session-extras.mjs";
import { checkHistoryContent, historyKinds } from "./session-history.mjs";

const argv = process.argv.slice(2);
const kind = argv[0]?.startsWith("--") ? undefined : argv.shift();
await runEntry({ key: { type: "string", pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ }, label: { type: "string", pattern: /^[a-z0-9-]+$/ } }, async ({ args, env, state }) => {
  return withSessionClient(env, async (rpc) => {
    const key = args.key ?? (await rpc(sessionRequests.resolveLabel(args.label))).key;
    if (typeof key !== "string" || !key) throw new Error("session label did not resolve");
    if (sessionExtraKinds.includes(kind)) return checkSessionExtra({ rpc, key, kind, state });
    if (historyKinds.includes(kind)) return checkHistoryContent({ rpc, key, kind, state });
    return readSessionKeys(rpc, key);
  });
}, argv, (args) => {
  if (Boolean(args.key) === Boolean(args.label)) throw new EntryError("exactly one of --key and --label is required", 2);
  if (kind && ![...sessionExtraKinds, ...historyKinds].includes(kind)) throw new EntryError("unknown session content kind", 2);
});
