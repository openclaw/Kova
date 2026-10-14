#!/usr/bin/env node
import { runEntry } from "./common.mjs";
import { buildReadonlySession, withProfileClients } from "./profile-content.mjs";

await runEntry({
  key: { type: "string", required: true, pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ },
  "member-profile-id": { type: "string", required: true },
}, ({ env, args }) => withProfileClients(env, (owner, member) => buildReadonlySession({ owner, member, key: args.key, memberProfileId: args["member-profile-id"] })));
