#!/usr/bin/env node
import { runEntry, mockScript, productJson } from "./common.mjs";
import { readMockTraits } from "./mock-content.mjs";
import { withSessionClient, readSessionKeys } from "./session-content.mjs";

const [operation, ...argv] = process.argv.slice(2);
if (!["held-turn", "tool-calls", "single-slot", "overflow"].includes(operation)) {
  console.log(JSON.stringify({ error: { code: "usage", message: "expected held-turn, tool-calls, single-slot or overflow" } }));
  process.exitCode = 2;
} else await runEntry({}, async ({ args, env, workspace }) => {
  const traits = readMockTraits(await mockScript(workspace));
  if (operation === "held-turn") {
    if (!traits.heldTurn?.progressCard || traits.heldTurn.marker !== "VERIFY_HOLD" || traits.heldTurn.holdMs !== 90000) throw new Error("held reply configuration differs");
    return { marker: traits.heldTurn.marker };
  }
  if (operation === "overflow") {
    if (traits.overflowOnce?.marker !== "VERIFY_OVERFLOW") throw new Error("overflow reply configuration is absent");
    const { key } = await withSessionClient(env, (rpc) => readSessionKeys(rpc, traits.overflowOnce.sessionKey));
    return { key };
  }
  const model = operation === "tool-calls" ? traits.toolCallModel : operation === "single-slot" ? traits.singleSlotModel : undefined;
  if (!model) throw new Error("mock trait is not configured");
  const ref = `openai/${model.modelId}`;
  const configured = await productJson(args.env, ["models", "list", "--json"]);
  if (!configured.models?.some((entry) => entry.key === ref)) throw new Error(`mock model is absent: ${ref}`);
  if (operation === "tool-calls") return { modelId: ref };
  const selected = await productJson(args.env, ["config", "get", "agents.entries.idle.model", "--json"]);
  if ((typeof selected === "string" ? selected : selected?.primary) !== ref) throw new Error("idle agent does not select the serial mock model");
  return { agentId: model.agentId };
}, argv);
