#!/usr/bin/env node
import { runEntry } from "./common.mjs";
import { buildPairedProfile } from "./profile-content.mjs";
import { requireSessionContentRuntime } from "./session-store-read.mjs";

await runEntry({}, ({ env, state }) => buildPairedProfile(env, state), process.argv.slice(2), requireSessionContentRuntime);
