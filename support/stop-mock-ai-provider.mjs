#!/usr/bin/env node
import { parseControlFileArgs } from "./cli-args.mjs";
import { stopOwnedMockProvider } from "../src/process-safety.mjs";

const options = parseArgs(process.argv.slice(2));
await stopOwnedMockProvider(options);

function parseArgs(args) {
  const values = parseControlFileArgs(args, ["pid-file", "supervisor", "legacy-executable", "script", "request-log", "server-log"]);
  return {
    pidFile: values["pid-file"],
    supervisorPath: values.supervisor,
    legacyExecutablePath: values["legacy-executable"],
    scriptPath: values.script,
    requestLog: values["request-log"],
    serverLog: values["server-log"]
  };
}
