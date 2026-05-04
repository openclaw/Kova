import { parseFlags, printHelp } from "./cli.mjs";
import { runCleanupCliCommand } from "./commands/cleanup.mjs";
import { runMatrixCommand } from "./commands/matrix.mjs";
import { runPlanCommand } from "./commands/plan.mjs";
import { runReportCommand } from "./commands/report.mjs";
import { runScenarioCommand } from "./commands/run.mjs";
import { runVersionCommand } from "./commands/version.mjs";
import { runSelfCheck } from "./selfcheck.mjs";
import { runSetup } from "./setup.mjs";

export async function main(argv) {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);

  if (command === "help" || flags.help) {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version") {
    await runVersionCommand(flags);
    return;
  }

  if (command === "setup") {
    await runSetup(flags);
    return;
  }

  if (command === "self-check") {
    await runSelfCheck(flags);
    return;
  }

  if (command === "plan") {
    await runPlanCommand(flags);
    return;
  }

  if (command === "matrix") {
    await runMatrixCommand(flags);
    return;
  }

  if (command === "run") {
    await runScenarioCommand(flags);
    return;
  }

  if (command === "report") {
    await runReportCommand(flags);
    return;
  }

  if (command === "cleanup") {
    await runCleanupCliCommand(flags);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}
