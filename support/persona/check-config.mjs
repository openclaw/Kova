#!/usr/bin/env node
import { runEntry, productJson } from "./common.mjs";

await runEntry({}, async ({ args }) => {
  const patterns = await productJson(args.env, ["config", "get", "logging.redactPatterns", "--json"]);
  const scope = await productJson(args.env, ["config", "get", "session.dmScope", "--json"]);
  const name = await productJson(args.env, ["config", "get", "agents.entries.research.identity.name", "--json"]);
  if (!patterns.includes("KOVA_PRIVATE_[A-Z]+") || scope !== "per-channel-peer" || name !== "Research Notebook") throw new Error("custom config values are absent");
  return {};
});
