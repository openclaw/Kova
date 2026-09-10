#!/usr/bin/env node
import { spawn } from "node:child_process";
import { ocmInvocation, resolveOcmTransport } from "../src/ocm/transport.mjs";

if (!resolveOcmTransport()) throw new Error("OCM transport dispatcher requires configuration");
const invocation = ocmInvocation(process.argv.slice(2));
const child = spawn(invocation.file, invocation.args, { env: invocation.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`OCM transport failed: ${error.message}`);
  process.exitCode = 127;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 }[signal] ?? 1);
});
