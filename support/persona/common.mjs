import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runCommand, quoteShell } from "../../src/commands.mjs";

export class EntryError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

export async function runEntry(options, operation) {
  try {
    let args;
    try {
      args = parseArgs({ options: { env: { type: "string" }, ...Object.fromEntries(Object.entries(options).map(([key, value]) => [key, { type: value.type }])) }, strict: true, allowPositionals: false }).values;
      for (const key of ["env", ...Object.keys(options).filter((key) => options[key].required)]) {
        if (!args[key]?.trim()) throw new Error(`--${key} is required`);
      }
      for (const [key, option] of Object.entries(options)) {
        if (args[key] !== undefined && option.pattern && !option.pattern.test(args[key])) throw new Error(`invalid --${key}`);
      }
      if (args.timeout !== undefined && (!/^\d+$/.test(args.timeout) || !Number.isSafeInteger(Number(args.timeout)) || Number(args.timeout) < 1)) throw new Error("--timeout must be a positive number of milliseconds");
    } catch (error) { throw new EntryError(error.message, 2); }
    const env = await commandJson(["ocm", "env", "show", args.env, "--json"]);
    const state = env.stateDir ?? join(env.root, ".openclaw");
    const result = await operation({ args, env, state, workspace: env.workspaceDir ?? join(state, "workspace") });
    console.log(JSON.stringify(result));
  } catch (error) {
    const exitCode = error.exitCode ?? 1;
    console.log(JSON.stringify({ error: { code: { 1: "product", 2: "usage", 3: "timeout" }[exitCode], message: error.message } }));
    process.exitCode = exitCode;
  }
}

async function commandJson(args) {
  return JSON.parse(await command(args));
}

async function command(args) {
  const result = await runCommand(args.map(quoteShell).join(" "), { timeoutMs: 120000, maxOutputChars: 1000000 });
  if (result.timedOut) throw new EntryError(`${args[0]} command timed out`, 3);
  if (result.status || result.signal || result.outputBudget?.truncated) throw new EntryError(`${args[0]} command failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export async function productJson(env, args) {
  return commandJson(["ocm", `@${env}`, "--", ...args]);
}

export async function mockScript(workspace) {
  return JSON.parse(await readFile(join(workspace, "kova-persona", "mock-script.json"), "utf8"));
}

export function findMockEntry(script, marker) {
  const entry = script.steps?.find((entry) => entry.respond?.type === "final-text" && entry.respond.text === marker);
  if (!entry) throw new Error(`mock reply table has no entry for ${marker}`);
  return entry;
}
