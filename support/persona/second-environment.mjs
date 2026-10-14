#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { createCompanion, checkCompanion } from "./companion-environment.mjs";

const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry({}, operation === "create" ? createCompanion : checkCompanion, argv, () => {
  if (!["create", "check"].includes(operation)) throw new EntryError("expected create or check", 2);
});
