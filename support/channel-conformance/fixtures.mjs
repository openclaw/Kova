import { mkdir, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

export async function prepareWorkflowFixtures(workflowCase, { envName }) {
  const paths = mediaFixturePaths(workflowCase);
  const writtenPaths = [];
  const replacements = {};
  for (const path of paths) {
    const writePath = fixtureWritePath(path, envName);
    await mkdir(dirname(writePath), { recursive: true });
    await writeFile(writePath, fixtureContent(path));
    writtenPaths.push(writePath);
    replacements[path] = writePath;
  }
  return {
    paths: writtenPaths,
    replacements,
    async cleanup() {
      await Promise.all(writtenPaths.map((path) =>
        unlink(path).catch((error) => {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        })
      ));
    }
  };
}

function fixtureWritePath(path, envName) {
  if (isAbsolute(path)) {
    return path;
  }
  const env = ocmEnvMetadata(envName);
  return join(env.root, ".openclaw", "workspace", path);
}

function ocmEnvMetadata(envName) {
  const result = spawnSync("ocm", ["env", "show", envName, "--json"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`ocm env show ${envName} failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed.root !== "string" || parsed.root.length === 0) {
    throw new Error(`ocm env show ${envName} did not include root`);
  }
  return parsed;
}

function mediaFixturePaths(workflowCase) {
  const fixtures = objectOrEmpty(workflowCase?.fixtures);
  const paths = [];
  if (typeof fixtures.mediaPath === "string" && fixtures.mediaPath.length > 0) {
    paths.push(fixtures.mediaPath);
  }
  if (Array.isArray(fixtures.mediaPaths)) {
    for (const path of fixtures.mediaPaths) {
      if (typeof path === "string" && path.length > 0 && !paths.includes(path)) {
        paths.push(path);
      }
    }
  }
  return paths;
}

function fixtureContent(path) {
  if (path.endsWith(".txt")) {
    return "Kova channel conformance attachment fixture\n";
  }
  return PNG_1X1;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
