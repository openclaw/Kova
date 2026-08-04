#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const expectedCount = parseExpectedCount(process.argv.slice(2));
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();

if (!stateDir) {
  console.error("OPENCLAW_STATE_DIR is required");
  process.exit(2);
}

const pluginRoot = join(stateDir, "fixture-plugins");
const legacyIndexPath = join(stateDir, "plugins", "installs.json");
const installRecords = {};

rmSync(pluginRoot, { recursive: true, force: true });
mkdirSync(pluginRoot, { recursive: true });

for (let index = 0; index < expectedCount; index += 1) {
  const id = `kova-plugin-${index}`;
  const pluginDir = join(pluginRoot, id);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: `@kova/${id}`,
        version: "0.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] }
      },
      null,
      2
    )
  );
  writeFileSync(
    join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {}
        }
      },
      null,
      2
    )
  );
  writeFileSync(
    join(pluginDir, "index.js"),
    `export default { id: ${JSON.stringify(id)}, register() {} };\n`
  );
  installRecords[id] = {
    source: "path",
    sourcePath: pluginDir,
    installPath: pluginDir,
    version: "0.0.0"
  };
}

mkdirSync(join(stateDir, "plugins"), { recursive: true });
writeFileSync(legacyIndexPath, JSON.stringify({ installRecords }, null, 2));

console.log(
  JSON.stringify(
    {
      schemaVersion: "kova.manyPluginPressure.prepare.v1",
      expectedCount,
      legacyIndexPath,
      pluginRoot
    },
    null,
    2
  )
);

function parseExpectedCount(args) {
  let count = 80;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--expected-count") {
      count = Number.parseInt(args[index + 1], 10);
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!Number.isInteger(count) || count <= 0 || count > 500) {
    throw new Error("--expected-count must be an integer between 1 and 500");
  }
  return count;
}
