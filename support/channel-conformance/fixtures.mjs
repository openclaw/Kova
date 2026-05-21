import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

export async function prepareWorkflowFixtures(workflowCase) {
  const paths = mediaFixturePaths(workflowCase);
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fixtureContent(path));
  }
  return {
    paths,
    async cleanup() {
      await Promise.all(paths.map((path) =>
        unlink(path).catch((error) => {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        })
      ));
    }
  };
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
