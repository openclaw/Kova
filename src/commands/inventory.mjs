import { buildOpenClawInventoryPlan } from "../inventory/openclaw.mjs";

export async function runInventoryCommand(flags) {
  const [subcommand = "plan"] = flags._;
  if (subcommand !== "plan") {
    throw new Error(`unknown inventory command: ${subcommand}`);
  }

  const plan = await buildOpenClawInventoryPlan(flags);
  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log("OpenClaw inventory plan");
  console.log(`Discovered: ${plan.coverage.discoveredCount}`);
  console.log(`Matched: ${plan.coverage.matchedCount}`);
  console.log(`Unmodeled: ${plan.coverage.unmodeledCount}`);
  for (const source of plan.sources) {
    const count = source.commandCount ?? source.scriptCount ?? source.capabilityCount ?? 0;
    console.log(`- ${source.id}: ${source.status}${count ? ` (${count})` : ""}`);
  }
  if (plan.coverage.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of plan.coverage.warnings) {
      console.log(`- ${warning.message}`);
    }
  }
}
