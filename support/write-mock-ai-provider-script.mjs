#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptForMode as buildMockProviderScript } from "./channel-workflow-provider-script.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv.slice(2).some((arg) => arg === "--env" || arg.startsWith("--env=") || ["--add-held-turn", "--add-tool-call-model", "--add-single-slot-model", "--add-overflow-once"].includes(arg))) {
  const { runEntry } = await import("./persona/common.mjs");
  const { MOCK_TRAIT_OPTIONS, writeMockTrait, parseMockAddition } = await import("./persona/mock-content.mjs");
  await runEntry(MOCK_TRAIT_OPTIONS, writeMockTrait, process.argv.slice(2), parseMockAddition);
} else {
  const options = parseArgs(process.argv.slice(2));
  if (!options.output) throw new Error("--output is required");
  const providerScript = scriptForMode(options);
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(providerScript, null, 2)}\n`, "utf8");
}

function scriptForMode(options) {
  return buildMockProviderScript(options, repoRoot);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
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
