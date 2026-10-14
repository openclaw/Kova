#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { prepareCatalog, importDraft, addCron, configureHeartbeat, configureDm, writeLocale } from "./environment-content.mjs";

const operations = { "catalog": prepareCatalog, "import-draft": importDraft, "cron": addCron, "heartbeat": configureHeartbeat, "dm-scope": configureDm, "locale": writeLocale };
const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry({}, (context) => operations[operation](context), argv, () => {
  if (!Object.hasOwn(operations, operation)) throw new EntryError("unknown environment content operation", 2);
});
