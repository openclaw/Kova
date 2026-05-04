import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../paths.mjs";

export async function runVersionCommand(flags = {}) {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.version.v1",
      name: packageJson.name,
      version: packageJson.version
    }, null, 2));
    return;
  }

  console.log(packageJson.version);
}
