#!/usr/bin/env node
import { context, mockScript, findMockEntry } from "./common.mjs";

const { args, workspace } = context();
if (!args.marker) throw new Error("--marker is required");
const entry = findMockEntry(await mockScript(workspace), args.marker);
console.log(JSON.stringify({ present: "true", entry: entry.id }));
