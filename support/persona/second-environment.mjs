#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { createCompanion, protectCompanion, checkCompanion } from "./companion-environment.mjs";

const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry(operation === "check" ? { "companion-env": { type: "string", pattern: /^[a-z][a-z0-9-]{0,127}$/ } } : {}, operation === "create" ? createCompanion : operation === "protect" ? protectCompanion : checkCompanion, argv, () => {
  if (!["create", "protect", "check"].includes(operation)) throw new EntryError("expected create, protect or check", 2);
});
