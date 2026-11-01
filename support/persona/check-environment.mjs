#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { withSessionClient } from "./session-content.mjs";
import { checkCatalog, checkDraft, checkCron, checkHeartbeat, checkDm, checkLocale } from "./environment-content.mjs";

const operations = {
  "catalog-claude-transcript": ({ env }) => withSessionClient(env, checkCatalog),
  "session-imported-draft": checkDraft,
  "cron-job-isolated": ({ env }) => withSessionClient(env, checkCron),
  "config-heartbeat-short": checkHeartbeat,
  "dm-scope-isolated": checkDm,
  "ui-locale-rtl": checkLocale,
};
const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry({}, (context) => operations[operation](context), argv, () => {
  if (!Object.hasOwn(operations, operation)) throw new EntryError("unknown environment content check", 2);
});
