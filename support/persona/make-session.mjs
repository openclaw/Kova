#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { buildSessionExtras, sessionExtraKinds } from "./session-extras.mjs";
import { buildHistoryContent, historyKinds } from "./session-history.mjs";
import { makeSession, withSessionClient } from "./session-content.mjs";

export function sessionOptions(args) {
  const number = (name, fallback, max) => {
    const value = args[name] ?? fallback;
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw new EntryError(`--${name} must be an integer from 1 to ${max}`, 2);
    return Number(value);
  };
  if (Boolean(args.key) === Boolean(args.label)) throw new EntryError("exactly one of --key and --label is required", 2);
  if (args.kind && ![...sessionExtraKinds, ...historyKinds].includes(args.kind)) throw new EntryError("unknown session content kind", 2);
  const messages = number("messages", 1, 10000);
  if (args["reset-once"] && messages < 2) throw new EntryError("--reset-once requires at least two messages", 2);
  return { key: args.key, label: args.label, kind: args.kind, toolModel: args["tool-model"], messages, compactEvery: args["compact-every"] === undefined ? undefined : number("compact-every", 0, messages), resetOnce: args["reset-once"] === true, plantWord: args["plant-word"], plantPrefix: args["plant-prefix"] };
}

await runEntry({
  key: { type: "string", pattern: /^agent:[a-z0-9][a-z0-9_-]*:[a-zA-Z0-9._:/@-]+$/ },
  label: { type: "string", pattern: /^[a-z0-9-]+$/ },
  kind: { type: "string" },
  "tool-model": { type: "string" },
  messages: { type: "string", required: true, pattern: /^(?:[1-9][0-9]{0,3}|10000)$/ },
  "compact-every": { type: "string", pattern: /^(?:[1-9][0-9]{0,3}|10000)$/ },
  "reset-once": { type: "boolean" },
  "plant-word": { type: "string", pattern: /^[a-zA-Z0-9._:-]+$/ },
  "plant-prefix": { type: "string", pattern: /^[a-zA-Z0-9._:-]+$/ },
}, async ({ args, env, state, workspace }) => {
  const options = sessionOptions(args);
  return withSessionClient(env, async (rpc) => {
    const made = await makeSession(rpc, options);
    if (sessionExtraKinds.includes(options.kind)) await buildSessionExtras({ rpc, key: made.key, options, env, state });
    if (historyKinds.includes(options.kind)) await buildHistoryContent({ rpc, key: made.key, options, env, workspace });
    return made;
  });
}, process.argv.slice(2), sessionOptions);
