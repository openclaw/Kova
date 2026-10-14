#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runEntry } from "./common.mjs";
import { repoRoot } from "../../src/paths.mjs";
import { scriptForMode } from "../channel-workflow-provider-script.mjs";

await runEntry({}, async ({ workspace }) => {
  const directory = join(workspace, "kova-persona");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const script = scriptForMode({ channelWorkflowCases: [], marker: "KOVA_AGENT_OK", mode: "normal" }, repoRoot);
  script.kovaPersona = { version: 1 };
  const path = join(directory, "mock-script.json");
  await writeFile(path, `${JSON.stringify(script, null, 2)}\n`, { mode: 0o600 });
  return { path };
});
