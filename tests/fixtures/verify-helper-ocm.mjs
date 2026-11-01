#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const envName = "kova-helpers-subprocess";
const root = process.env.KOVA_HELPER_ROOT;
appendFileSync(process.env.KOVA_HELPER_COMMANDS, JSON.stringify(args) + "\n");
let result;
if (args[0] === "env") {
  assert.equal(args[2], envName);
  if (args[1] === "resolve") result = { binaryPath: join(root, "runtime", "openclaw.mjs") };
  else {
    assert.ok(["show", "status"].includes(args[1]));
    result = { root, gatewayPort: 18789, configPath: join(root, ".openclaw", "openclaw.json") };
  }
} else {
  assert.deepEqual(args.slice(0, 3), [`@${envName}`, "--", "cron"]);
  switch (args[3]) {
    case "status":
      result = { enabled: true };
      break;
    case "add": {
      const frames = readFileSync(process.env.KOVA_HELPER_REQUESTS, "utf8");
      if (!frames.includes('"method":"device.pair.approve"')) {
        process.stderr.write("scope upgrade pending approval requestId: 11111111-1111-4111-8111-111111111111\n");
        process.exit(1);
      }
      result = { id: "fixture-job" };
      break;
    }
    case "run":
    case "runs":
      result = { runId: "fixture-run", status: "ok", cronId: "fixture-job" };
      break;
    case "rm":
      result = { removed: true };
      break;
    default:
      throw new Error(`unexpected fixture command: ${args.join(" ")}`);
  }
}
process.stdout.write(JSON.stringify(result) + "\n");
