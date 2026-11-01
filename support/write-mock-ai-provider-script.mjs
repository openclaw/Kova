#!/usr/bin/env node
import { parseCompactArgs } from "./cli-args.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptForMode as buildMockProviderScript } from "./channel-workflow-provider-script.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const options = parseArgs(process.argv.slice(2));
if (!options.output) {
  throw new Error("--output is required");
}

const providerScript = scriptForMode(options);
mkdirSync(dirname(options.output), { recursive: true });
writeFileSync(options.output, `${JSON.stringify(providerScript, null, 2)}\n`, "utf8");

function scriptForMode(options) {
  return buildMockProviderScript(options, repoRoot);
}

function parseArgs(args) {
  const parsed = parseCompactArgs(args);
  return {
    output: parsed.output,
    marker: parsed.marker,
    mode: parsed.mode,
    delayMs: parsed.delayms,
    stallMs: parsed.stallms,
    errorStatus: parsed.errorstatus,
    channelWorkflowCases: String(parsed.channelworkflowcases ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
}
