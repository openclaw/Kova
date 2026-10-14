#!/usr/bin/env node
import { runEntry, mockScript, findMockEntry } from "./common.mjs";

await runEntry({ marker: { type: "string", required: true } }, async ({ args, workspace }) => {
  const entry = findMockEntry(await mockScript(workspace), args.marker);
  return { present: "true", entry: entry.id };
});
