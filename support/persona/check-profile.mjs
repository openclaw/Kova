#!/usr/bin/env node
import { EntryError, runEntry } from "./common.mjs";
import { checkHumanProfiles, checkPairedProfile, checkReadonlySession, withProfileClients } from "./profile-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";

const argv = process.argv.slice(2);
const content = argv.shift();
await runEntry({
  key: { type: "string", pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ },
  "member-profile-id": { type: "string" },
  "suggestion-id": { type: "string" },
}, ({ env, state, args }) => {
  if (content === "paired") return checkPairedProfile(env, state);
  return withProfileClients(env, (owner, member) => content === "human"
    ? checkHumanProfiles(owner, member)
    : checkReadonlySession({ owner, member, key: args.key, memberProfileId: args["member-profile-id"], suggestionId: args["suggestion-id"] }), { existingOnly: true });
}, argv, (args) => {
  if (!["human", "paired", "shared"].includes(content)) throw new EntryError("expected human, paired or shared profile content", 2);
  if (content === "shared" && !args.key) throw new EntryError("shared profile content requires --key", 2);
  if (content !== "shared" && (args.key || args["member-profile-id"] || args["suggestion-id"])) throw new EntryError("session arguments require shared profile content", 2);
  if (content === "paired") requireSessionContentRuntime();
});
