import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, quoteShell } from "../../src/commands.mjs";
import { isMissingOcmResource } from "../../src/ocm/missing-resource.mjs";
import { savedContent } from "./environment-content.mjs";
import { EntryError } from "./common.mjs";

async function execute(command) {
  const result = await runCommand(command, { timeoutMs: 120000, maxOutputChars: 1000000 });
  if (result.timedOut) throw new EntryError("companion environment command timed out", 3);
  return result;
}
async function call(command) {
  const result = await execute(command);
  if (result.status || result.signal || result.outputBudget?.truncated) throw new Error("companion environment command failed");
  return result;
}

export async function createCompanion({ env, state }) {
  const name = `${env.name}-second`;
  const probe = await execute(`ocm env show ${quoteShell(name)} --json`);
  if (!isMissingOcmResource(probe, "environment", name)) throw new Error("companion destination already exists or could not be inspected");
  await savedContent(state, "companion-environment.json", { source: env.name, env: name });
  await call(`ocm env clone ${quoteShell(env.name)} ${quoteShell(name)} --json`);
  return { env: name };
}

export async function protectCompanion({ env, state }) {
  const record = await savedContent(state, "companion-environment.json");
  if (record.source !== env.name || record.env !== `${env.name}-second`) throw new Error("companion ownership record is invalid");
  await call(`ocm env protect ${quoteShell(record.env)} on --json`);
  return { env: record.env };
}

export async function checkCompanion({ env, state, args = {} }, inspect = call) {
  const record = await savedContent(state, "companion-environment.json");
  if (typeof record.source !== "string" || record.env !== `${record.source}-second` || record.env === env.name) throw new Error("companion environment identity is invalid");
  const target = args["companion-env"] ?? record.env;
  if (typeof target !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(target) || target === env.name) throw new Error("companion destination is invalid");
  const metadata = JSON.parse((await inspect(`ocm env show ${quoteShell(target)} --json`)).stdout);
  if (metadata.name !== target || (target === record.env && !metadata.protected) || metadata.defaultRuntime !== env.defaultRuntime || metadata.gatewayPort === env.gatewayPort) throw new Error("companion runtime, protection or port differs");
  return { env: target };
}

/** A copied record never grants permission to remove the original companion. */
export async function cleanupCompanion(env, call) {
  const inspected = await call(`ocm env show ${quoteShell(env)} --json`, "inspect companion owner", { missingEnvironment: env });
  if (inspected === null) return;
  const metadata = JSON.parse(inspected.stdout);
  if (metadata.name !== env) throw new Error("companion owner inspection returned another environment");
  let record;
  try { record = JSON.parse(await readFile(join(metadata.stateDir ?? join(metadata.root, ".openclaw"), "kova-persona", "companion-environment.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (record.source !== env) return;
  if (record.env !== `${env}-second`) throw new Error("companion ownership record is invalid");
  const found = await call(`ocm env show ${quoteShell(record.env)} --json`, "inspect owned companion", { missingEnvironment: record.env });
  if (found === null) return;
  await call(`ocm env protect ${quoteShell(record.env)} off --json`, "unprotect companion");
  await call(`ocm env destroy ${quoteShell(record.env)} --yes --json`, "destroy companion", { timeoutMs: 120000 });
}
