#!/usr/bin/env node
import { join } from "node:path";
import { repoRoot } from "../src/paths.mjs";
import { assertKovaEnvName, parseArgs, positiveInt, requiredArg } from "./cli-args.mjs";
import { runProcess } from "./process.mjs";

const options = parseArgs(process.argv.slice(2));
const envName = requiredArg(options, "env");
assertKovaEnvName(envName);
const expectedCount = positiveInt(options["expected-count"] ?? "80", "expected-count");
if (expectedCount > 500) throw new Error("--expected-count must not exceed 500");
const pluginIndex = Number(requiredArg(options, "plugin-index"));
if (!Number.isInteger(pluginIndex) || pluginIndex < 0 || pluginIndex >= expectedCount) {
  throw new Error("--plugin-index must identify a prepared plugin");
}

const installHelp = await command([`@${envName}`, "--", "plugins", "install", "--help"]);
const flags = ["--link", "--force"];
// The minimum supported release predates explicit capability consent.
if (/--accept-capabilities\b/.test(installHelp.stdout)) flags.push("--accept-capabilities");

const prepared = JSON.parse((await command([
  "env", "exec", envName, "--", "node",
  join(repoRoot, "support", "prepare-many-plugin-pressure-state.mjs"),
  "--expected-count", String(expectedCount), "--inspect-index", String(pluginIndex)
])).stdout);

await command([`@${envName}`, "--", "plugins", "install", prepared.pluginDir, ...flags]);

console.log(JSON.stringify({
  schemaVersion: "kova.manyPluginPressure.install.v1",
  ok: true,
  env: envName,
  pluginId: prepared.pluginId,
  installedCount: 1
}, null, 2));

async function command(args) {
  const result = await runProcess("ocm", args);
  if (result.status !== 0) {
    console.log(JSON.stringify({
      schemaVersion: "kova.manyPluginPressure.install.v1",
      ok: false,
      command: ["ocm", ...args],
      status: result.status,
      stdout: result.stdout.slice(-8000),
      stderr: result.stderr.slice(-8000)
    }, null, 2));
    process.exit(1);
  }
  return result;
}
