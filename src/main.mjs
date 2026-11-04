import { parseFlags, printHelp } from "./cli.mjs";
import { renderHelp } from "./reporting/render-help.mjs";

const COMMANDS = new Map([
  ["version", ["./commands/version.mjs", "runVersionCommand"]],
  ["--version", ["./commands/version.mjs", "runVersionCommand"]],
  ["setup", ["./setup.mjs", "runSetup"]],
  ["self-check", ["./selfcheck.mjs", "runSelfCheck"]],
  ["plan", ["./commands/plan.mjs", "runPlanCommand"]],
  ["matrix", ["./commands/matrix.mjs", "runMatrixCommand"]],
  ["inventory", ["./commands/inventory.mjs", "runInventoryCommand"]],
  ["catalogue", ["./commands/catalogue.mjs", "runCatalogueCommand"]],
  ["persona", ["./commands/persona.mjs", "runPersonaCommand"]],
  ["run", ["./commands/run.mjs", "runScenarioCommand"]],
  ["report", ["./commands/report.mjs", "runReportCommand"]],
  ["reports", ["./commands/report.mjs", "runReportsCommand"]],
  ["publish", ["./commands/publish.mjs", "runPublishCommand"]],
  ["cleanup", ["./commands/cleanup.mjs", "runCleanupCliCommand"]]
]);

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

  const route = COMMANDS.get(command);
  if (route) {
    const [modulePath, exportName] = route;
    const { [exportName]: runCommand } = await import(modulePath);
    await runCommand(flags);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}
