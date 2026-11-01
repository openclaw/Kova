#!/usr/bin/env node
import { runEntry, productJson, mockScript, findMockEntry } from "./common.mjs";
import { readMockTraits } from "./mock-content.mjs";

await runEntry({}, async ({ args, workspace }) => {
  const script = await mockScript(workspace);
  findMockEntry(script, "KOVA_AGENT_OK");
  const serial = readMockTraits(script).singleSlotModel;
  const models = await productJson(args.env, ["models", "list", "--json"]);
  if (!models.models?.some((model) => model.key === "openai/gpt-5.5")) throw new Error("scripted mock model is absent");
  const configured = await productJson(args.env, ["config", "get", "agents.defaults.model.primary", "--json"]);
  if (configured !== "openai/gpt-5.5") throw new Error("agents do not default to the mock model");
  const agents = await productJson(args.env, ["config", "get", "agents.entries", "--json"]);
  for (const [id, agent] of Object.entries(agents)) {
    const override = typeof agent.model === "string" ? agent.model : agent.model?.primary;
    if (override && override !== configured && !(id === serial?.agentId && override === `openai/${serial.modelId}`)) throw new Error("an agent overrides the mock model");
  }
  return { modelId: configured };
});
