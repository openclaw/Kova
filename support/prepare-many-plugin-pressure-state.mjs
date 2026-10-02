#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { expectedCount, inspectIndex } = parseArgs(process.argv.slice(2));
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();

if (!stateDir) {
  console.error("OPENCLAW_STATE_DIR is required");
  process.exit(2);
}

const pluginRoot = join(stateDir, "fixture-plugins");
if (inspectIndex !== undefined) {
  const pluginId = `kova-plugin-${inspectIndex}`;
  const pluginDir = join(pluginRoot, pluginId);
  const manifest = JSON.parse(readFileSync(join(pluginDir, "openclaw.plugin.json"), "utf8"));
  if (manifest.id !== pluginId) throw new Error(`fixture plugin id does not match ${pluginId}`);
  console.log(JSON.stringify({ pluginId, pluginDir }));
  process.exit(0);
}

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
}

console.log(
  JSON.stringify(
    {
      schemaVersion: "kova.manyPluginPressure.prepare.v1",
      expectedCount,
      pluginRoot
    },
    null,
    2
  )
);

function parseArgs(args) {
  let count = 80;
  let inspectIndex;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--expected-count") {
      count = Number.parseInt(args[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === "--inspect-index") {
      inspectIndex = Number(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!Number.isInteger(count) || count <= 0 || count > 500) {
    throw new Error("--expected-count must be an integer between 1 and 500");
  }
  if (inspectIndex !== undefined && (!Number.isInteger(inspectIndex) || inspectIndex < 0 || inspectIndex >= count)) {
    throw new Error("--inspect-index must identify a prepared plugin");
  }
  return { expectedCount: count, inspectIndex };
}
