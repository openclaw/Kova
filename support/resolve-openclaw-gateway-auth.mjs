#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const [packageRoot, target] = process.argv.slice(2);
  if (target !== "auth" && target !== "remote") throw new Error("invalid Gateway auth target");
  const configPath = process.env.OPENCLAW_CONFIG_PATH ||
    join(process.env.OPENCLAW_STATE_DIR || join(process.env.OPENCLAW_HOME, ".openclaw"), "openclaw.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const require = createRequire(join(packageRoot, "package.json"));
  const { resolveConfiguredSecretInputString } = await import(pathToFileURL(
    require.resolve("openclaw/plugin-sdk/secret-input-runtime")
  ).href);
  const resolved = await resolveConfiguredSecretInputString({
    config,
    env: process.env,
    value: config.gateway?.[target]?.token,
    path: `gateway.${target}.token`
  });
  if (!resolved.value) throw new Error("unresolved Gateway auth token");
  // A private pipe to the direct client; this helper is never a recorded phase.
  process.stdout.write(resolved.value);
} catch {
  console.error("could not resolve configured Gateway authentication");
  process.exitCode = 1;
}
