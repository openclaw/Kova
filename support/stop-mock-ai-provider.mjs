#!/usr/bin/env node
import { stopOwnedMockProvider } from "../src/process-safety.mjs";

const options = parseArgs(process.argv.slice(2));
await stopOwnedMockProvider(options);

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${flag ?? ""}`);
    }
    values[flag.slice(2)] = value;
  }
  for (const key of ["pid-file", "supervisor", "legacy-executable", "script", "request-log", "server-log"]) {
    if (!values[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return {
    pidFile: values["pid-file"],
    supervisorPath: values.supervisor,
    legacyExecutablePath: values["legacy-executable"],
    scriptPath: values.script,
    requestLog: values["request-log"],
    serverLog: values["server-log"]
  };
}
