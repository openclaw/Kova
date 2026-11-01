#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry, EntryError } from "./common.mjs";
import { stageLegacyAliases, checkLegacyAliases } from "./legacy-store.mjs";

export { legacyAliasKey } from "./legacy-store.mjs";

/** Legacy state is durable staged content until an explicit clone activation. */
export async function legacyAliasRows(state, { write = false, env } = {}) {
  return write ? stageLegacyAliases({ state, env }) : checkLegacyAliases(state);
}

async function main() {
  const argv = process.argv.slice(2), operation = argv.shift();
  await runEntry({}, ({ state, env }) => legacyAliasRows(state, { write: operation === "write", env }), argv, () => {
    if (!["write", "check"].includes(operation)) throw new EntryError("expected write or check", 2);
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
