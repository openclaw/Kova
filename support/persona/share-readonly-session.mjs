#!/usr/bin/env node
import { EntryError, runEntry } from "./common.mjs";
import { addSharedSuggestion, setSharedVisibility, withProfileClient } from "./profile-content.mjs";

const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry({
  key: { type: "string", required: true, pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ },
  ...(operation === "visibility" ? { visibility: { type: "string", required: true, pattern: /^(suggest|read-only)$/ } } : {}),
}, ({ env, args }) => withProfileClient(env, operation === "suggest" ? "member" : "owner", (rpc) => {
  if (operation === "visibility") return setSharedVisibility(rpc, args.key, args.visibility);
  return addSharedSuggestion(rpc, args.key);
}), argv, () => {
  if (!["visibility", "suggest"].includes(operation)) throw new EntryError("expected visibility or suggest", 2);
});
