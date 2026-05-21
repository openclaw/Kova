import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { channelWorkflowScript } from "../channel-workflow-provider-script.mjs";

export async function resetProviderScriptForCase({
  repoRoot,
  artifactDir,
  workflowCase,
  fixtureReplacements = {}
}) {
  const port = await readProviderPort({ artifactDir });
  const script = channelWorkflowScript([workflowCase.id], repoRoot, { replacements: fixtureReplacements });
  const response = await fetch(`http://127.0.0.1:${port}/admin/script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...script,
      id: `kova-channel-workflow:${workflowCase.id}`
    })
  });
  if (!response.ok) {
    throw new Error(`mock provider script reset failed for ${workflowCase.id}: ${response.status} ${await response.text()}`);
  }
}

export async function countProviderRequests({ artifactDir }) {
  const path = join(artifactDir, "mock-openai", "requests.jsonl");
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function readProviderPort({ artifactDir }) {
  const path = join(artifactDir, "mock-openai", "port");
  let raw;
  try {
    raw = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`mock provider port file is missing: ${path}`);
    }
    throw error;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid mock provider port file ${path}: ${raw}`);
  }
  return port;
}
