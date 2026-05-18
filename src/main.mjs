import { parseFlags, printHelp } from "./cli.mjs";
import { renderHelp } from "./reporting/render-help.mjs";
import { runCleanupCliCommand } from "./commands/cleanup.mjs";
import { runInventoryCommand } from "./commands/inventory.mjs";
import { runMatrixCommand } from "./commands/matrix.mjs";
import { runPlanCommand } from "./commands/plan.mjs";
import { runReportCommand, runReportsCommand } from "./commands/report.mjs";
import { runScenarioCommand } from "./commands/run.mjs";
import { runVersionCommand } from "./commands/version.mjs";
import { runSelfCheck } from "./selfcheck.mjs";
import { runSetup } from "./setup.mjs";

export async function main(argv) {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);

  if (command === "help" || flags.help) {
    const target = command === "help" ? (rest[0] ?? null) : command;
    if (flags.plain === true || flags.json === true) {
      printHelp();
    } else {
      console.log(renderHelp(target, flags));
    }
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

  if (command === "inventory") {
    await runInventoryCommand(flags);
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

  if (command === "reports") {
    await runReportsCommand(flags);
    return;
  }

  if (command === "cleanup") {
    await runCleanupCliCommand(flags);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}
