#!/usr/bin/env node
import { join } from "node:path";
import { runEntry, productJson } from "./common.mjs";

await runEntry({ name: { type: "string", required: true, pattern: /^[a-z][a-z0-9-]*$/ } }, async ({ args, state }) => {
  const result = await productJson(args.env, ["agents", "add", args.name, "--workspace", join(state, `workspace-${args.name}`), "--non-interactive", "--json"]);
  if ([result.agentId, result.workspace, result.agentDir].some((value) => typeof value !== "string" || !value)) throw new Error("agent creation returned incomplete identifiers");
  return { agentId: result.agentId, workspace: result.workspace, agentDir: result.agentDir };
});
