#!/usr/bin/env node
import { EntryError, runEntry } from "./common.mjs";
import { buildPairedProfile, writePairedProfileConfig } from "./profile-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";

const argv = process.argv.slice(2);
const operation = argv.shift();
await runEntry({}, ({ env, state }) => operation === "pair" ? buildPairedProfile(env, state) : writePairedProfileConfig(env, state), argv, () => {
  if (!["pair", "configure"].includes(operation)) throw new EntryError("expected pair or configure", 2);
  requireSessionContentRuntime();
});
