#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../src/paths.mjs";
import { assertKovaEnvName, parseArgs, requiredArg } from "./cli-args.mjs";
import { runProcess } from "./process.mjs";

const options = parseArgs(process.argv.slice(2));
const envName = requiredArg(options, "env");
assertKovaEnvName(envName);
const pluginName = requiredArg(options, "plugin");
if (!/^kova-[a-z0-9][a-z0-9-]*$/.test(pluginName)) {
  throw new Error(`unsafe Kova plugin fixture name '${pluginName}'`);
}
const pluginDir = join(repoRoot, "support", "plugins", pluginName);
if (!existsSync(join(pluginDir, "package.json"))) {
  throw new Error(`unknown Kova plugin fixture '${pluginName}'`);
}

const installHelp = await ocm([`@${envName}`, "--", "plugins", "install", "--help"]);
const flags = ["--force"];
// Releases before explicit capability consent reject the flag; newer releases refuse to install without it.
if (/--accept-capabilities\b/.test(installHelp.stdout)) flags.push("--accept-capabilities");

const result = await ocm([`@${envName}`, "--", "plugins", "install", pluginDir, ...flags]);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

async function ocm(args) {
  const result = await runProcess("ocm", args);
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status);
  }
  return result;
}
