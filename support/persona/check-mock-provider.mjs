#!/usr/bin/env node
import { runEntry, productJson, mockScript, findMockEntry } from "./common.mjs";

await runEntry({}, async ({ args, workspace }) => {
  findMockEntry(await mockScript(workspace), "KOVA_AGENT_OK");
  const models = await productJson(args.env, ["models", "list", "--json"]);
  if (!models.models?.some((model) => model.key === "openai/gpt-5.5")) throw new Error("scripted mock model is absent");
  const configured = await productJson(args.env, ["config", "get", "agents.defaults.model.primary", "--json"]);
  if (configured !== "openai/gpt-5.5") throw new Error("agents do not default to the mock model");
  const agents = await productJson(args.env, ["config", "get", "agents.entries", "--json"]);
  for (const agent of Object.values(agents)) {
    const override = typeof agent.model === "string" ? agent.model : agent.model?.primary;
    if (override && override !== configured) throw new Error("an agent overrides the mock model");
  }
  return { modelId: configured };
});
