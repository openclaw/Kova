#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { createCompanion, checkCompanion } from "./companion-environment.mjs";

const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry(operation === "check" ? { "companion-env": { type: "string", pattern: /^[a-z][a-z0-9-]{0,127}$/ } } : {}, operation === "create" ? createCompanion : checkCompanion, argv, () => {
  if (!["create", "check"].includes(operation)) throw new EntryError("expected create or check", 2);
});
