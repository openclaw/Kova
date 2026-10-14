import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, quoteShell } from "../../src/commands.mjs";
import { runOcmJson, parseSupportArgs } from "../openclaw-runtime.mjs";

export function context() {
  const args = parseSupportArgs(process.argv.slice(2));
  if (!args.env) throw new Error("--env is required");
  const env = runOcmJson(["env", "show", args.env, "--json"]);
  const state = env.stateDir ?? join(env.root, ".openclaw");
  return { args, env, state, workspace: env.workspaceDir ?? join(state, "workspace") };
}

export async function product(env, args) {
  const command = ["ocm", `@${env}`, "--", ...args].map(quoteShell).join(" ");
  const result = await runCommand(command, { timeoutMs: 120000, maxOutputChars: 1000000 });
  if (result.status || result.outputBudget?.truncated) throw new Error(`OpenClaw ${args[0]} ${args[1] ?? ""} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export async function productJson(env, args) {
  return JSON.parse(await product(env, args));
}

export async function mockScript(workspace) {
  return JSON.parse(await readFile(join(workspace, "kova-persona", "mock-script.json"), "utf8"));
}

export function findMockEntry(script, marker) {
  const entry = script.steps?.find((entry) => entry.respond?.type === "final-text" && entry.respond.text === marker);
  if (!entry) throw new Error(`mock reply table has no entry for ${marker}`);
  return entry;
}
