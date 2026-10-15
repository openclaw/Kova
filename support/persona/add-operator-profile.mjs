#!/usr/bin/env node
import { runEntry } from "./common.mjs";
import { checkHumanProfiles, withProfileClients } from "./profile-content.mjs";

await runEntry({}, ({ env }) => withProfileClients(env, checkHumanProfiles));
