#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { context, product } from "./common.mjs";
import { repoRoot } from "../../src/paths.mjs";
import { scriptForMode } from "../channel-workflow-provider-script.mjs";

const { args, state, workspace } = context();
switch (args.trait) {
  case "agents-three-configured":
    for (const name of ["research", "idle"]) {
      await product(args.env, ["agents", "add", name, "--workspace", join(state, `workspace-${name}`), "--non-interactive", "--json"]);
    }
    break;
  case "mock-provider-scripted": {
    const directory = join(workspace, "kova-persona");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = scriptForMode({ channelWorkflowCases: [], marker: "KOVA_AGENT_OK", mode: "normal" }, repoRoot);
    await writeFile(join(directory, "mock-script.json"), `${JSON.stringify(script, null, 2)}\n`);
    break;
  }
  case "channels-test-accounts": {
    await product(args.env, ["plugins", "install", join(repoRoot, "support/plugins/kova-channel-probe"), "--force", "--accept-capabilities"]);
    break;
  }
  case "plugins-bundled-and-external":
    await product(args.env, ["plugins", "enable", "memory-core"]);
    break;
  case "config-hand-edited":
    await product(args.env, ["config", "set", "logging.redactPatterns", '["KOVA_PRIVATE_[A-Z]+"]', "--strict-json"]);
    await product(args.env, ["config", "set", "session.dmScope", "per-channel-peer"]);
    await product(args.env, ["agents", "set-identity", "--agent", "research", "--name", "Research Notebook"]);
    break;
  default: throw new Error(`unknown foundation trait: ${args.trait}`);
}
console.log(JSON.stringify({ built: args.trait }));
