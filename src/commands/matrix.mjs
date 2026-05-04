import { runMatrixPlan } from "./matrix-plan.mjs";
import { runMatrixRun } from "./matrix-run.mjs";

export async function runMatrixCommand(flags) {
  const [subcommand = "plan"] = flags._;

  if (subcommand === "plan") {
    await runMatrixPlan(flags);
    return;
  }

  if (subcommand === "run") {
    await runMatrixRun(flags);
    return;
  }

  throw new Error(`unknown matrix command: ${subcommand}`);
}
