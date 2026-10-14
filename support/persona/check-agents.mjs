#!/usr/bin/env node
import { runEntry, productJson } from "./common.mjs";
import { access } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

await runEntry({}, async ({ args, env }) => {
  const agents = await productJson(args.env, ["agents", "list", "--json"]);
  const selected = ["main", "research", "idle"].map((name) => agents.find((agent) => agent.id === name));
  if (selected.some((agent) => !agent) || new Set(selected.map((agent) => agent.workspace)).size !== 3 || new Set(selected.map((agent) => agent.agentDir)).size !== 3) throw new Error("three agents with separate workspaces and stores are required");
  for (const agent of selected) for (const path of [agent.workspace, agent.agentDir]) {
    const local = relative(env.root, path);
    if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("agent content points outside this environment");
  }
  for (const agent of selected) await access(agent.workspace);
  return { mainAgentId: "main", secondAgentId: "research", thirdAgentId: "idle" };
});
