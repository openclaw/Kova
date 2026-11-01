#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ownedOpenClawPaths } from "./openclaw-scope.mjs";

const { stateDir } = ownedOpenClawPaths();
const names = process.argv.slice(2);
if (!names.length) {
  throw new Error("live auth requires at least one credential environment variable");
}
const lines = names.map((name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !process.env[name]) {
    throw new Error("live auth requires available credentials in the selected environment variables");
  }
  return `${name}=${JSON.stringify(process.env[name])}`;
});

fs.mkdirSync(stateDir, { recursive: true });
const envPath = path.join(stateDir, ".env");
const envFile = fs.openSync(envPath, "a", 0o600);
try {
  fs.fchmodSync(envFile, 0o600);
  // The last dotenv assignment replaces cloned keys without rewriting other settings.
  fs.writeFileSync(envFile, `\n${lines.join("\n")}\n`, "utf8");
} finally {
  fs.closeSync(envFile);
}
console.log(envPath);
