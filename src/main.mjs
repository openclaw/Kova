import { parseFlags, printHelp } from "./cli.mjs";
import { renderHelp } from "./reporting/render-help.mjs";

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
    const { runVersionCommand } = await import("./commands/version.mjs");
    await runVersionCommand(flags);
    return;
  }

  if (command === "setup") {
    const { runSetup } = await import("./setup.mjs");
    await runSetup(flags);
    return;
  }

  if (command === "self-check") {
    const { runSelfCheck } = await import("./selfcheck.mjs");
    await runSelfCheck(flags);
    return;
  }

  if (command === "plan") {
    const { runPlanCommand } = await import("./commands/plan.mjs");
    await runPlanCommand(flags);
    return;
  }

  if (command === "matrix") {
    const { runMatrixCommand } = await import("./commands/matrix.mjs");
    await runMatrixCommand(flags);
    return;
  }

  if (command === "inventory") {
    const { runInventoryCommand } = await import("./commands/inventory.mjs");
    await runInventoryCommand(flags);
    return;
  }

  if (command === "run") {
    const { runScenarioCommand } = await import("./commands/run.mjs");
    await runScenarioCommand(flags);
    return;
  }

  if (command === "report") {
    const { runReportCommand } = await import("./commands/report.mjs");
    await runReportCommand(flags);
    return;
  }

  if (command === "reports") {
    const { runReportsCommand } = await import("./commands/report.mjs");
    await runReportsCommand(flags);
    return;
  }

  if (command === "publish") {
    const { runPublishCommand } = await import("./commands/publish.mjs");
    await runPublishCommand(flags);
    return;
  }

  if (command === "cleanup") {
    const { runCleanupCliCommand } = await import("./commands/cleanup.mjs");
    await runCleanupCliCommand(flags);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}
