import { createHash } from "node:crypto";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";
import { deflateSync } from "node:zlib";
import { mediaFingerprint } from "./media-fingerprint.mjs";

export async function prepareWorkflowFixtures(workflowCase, { envName, envRoot, signal }) {
  const paths = mediaFixturePaths(workflowCase);
  const writtenPaths = [];
  const sourceProofs = [];
  const replacements = {};
  const cleanup = async () => {
    await Promise.all(writtenPaths.map((path) =>
      unlink(path).catch((error) => { if (error?.code !== "ENOENT") throw error; })
    ));
  };
  try {
    for (const path of paths) {
      signal?.throwIfAborted();
      const writePath = fixtureWritePath(path, envName, envRoot);
      const content = fixtureContent(path);
      await mkdir(dirname(writePath), { recursive: true });
      signal?.throwIfAborted();
      if (signal) {
        const file = await open(writePath, "wx");
        writtenPaths.push(writePath);
        try { await file.writeFile(content); }
        finally { await file.close(); }
      } else {
        await writeFile(writePath, content);
        writtenPaths.push(writePath);
      }
      signal?.throwIfAborted();
      replacements[path] = writePath;
      sourceProofs.push({
        source: path,
        path: writePath,
        name: basename(writePath),
        sha256: sha256(content),
        fingerprint: mediaFingerprint(content)
      });
    }
  } catch (error) {
    if (signal) {
      try { await cleanup(); }
      catch (cleanupError) { error.cleanupError = cleanupError.message; }
    }
    throw error;
  }
  return {
    paths: writtenPaths,
    replacements,
    sourceProofs,
    cleanup
  };
}

function fixtureWritePath(path, envName, envRoot) {
  if (isAbsolute(path)) {
    return path;
  }
  const root = envRoot ?? ocmEnvMetadata(envName).root;
  return join(root, ".openclaw", "workspace", path);
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
  return pngFixture(path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pngFixture(path) {
  const hash = createHash("sha256").update(path).digest();
  const rgba = Buffer.from([hash[0], hash[1], hash[2], 255]);
  const scanline = Buffer.concat([Buffer.from([0]), rgba]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", Buffer.from([
      0, 0, 0, 1,
      0, 0, 0, 1,
      8,
      6,
      0,
      0,
      0
    ])),
    pngChunk("IDAT", deflateSync(scanline)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
