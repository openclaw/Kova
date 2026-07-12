/**
 * `kova publish` — write a web-payload-shaped release JSON into the
 * Astro content collection at `web/src/content/releases/<ver>.json`.
 *
 * Pipeline:
 *   1. Resolve input to a path (file path or run-id under ~/.kova).
 *   2. Read + classify (web-payload | internal-report | unknown).
 *   3. Augment with deltas vs the chronologically-previous release
 *      already in the target directory (unless --no-augment).
 *   4. Validate against the shared `web-payload-contract.mjs` schema.
 *   5. Atomic write: temp file in target dir, then rename.
 *   6. Print receipt (markdown to stdout; --json for machines).
 *
 * `--dry-run` performs all steps except the rename, so callers can
 * inspect the projected JSON without touching the site tree.
 *
 * `kova.report.v1` inputs are projected into the public web payload shape
 * before augmentation. Bare run ids resolve through the normal Kova report
 * store, so CI can run `kova publish <runId> --ver <version>` after a run.
 */

import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, isAbsolute, resolve, basename, dirname, posix, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract as extractTar } from "tar-stream";

import {
  parseRelease,
  safeParseRelease,
  WEB_PAYLOAD_SCHEMA_VERSION,
} from "../web-payload-contract.mjs";
import { repoRoot, displayPath } from "../paths.mjs";
import { artifactRunIdSegment } from "../reporting/artifact-names.mjs";
import {
  MAX_BUNDLE_ANCESTORS,
  MAX_BUNDLE_CHECKSUM_BYTES,
  MAX_BUNDLE_COMPRESSED_BYTES,
  MAX_BUNDLE_DECLARED_BYTES,
  MAX_BUNDLE_ENTRIES,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_NAME_BYTES,
  MAX_BUNDLE_PHYSICAL_HEADERS,
  MAX_BUNDLE_UNPACKED_BYTES,
  normalizeArchiveMember
} from "../reporting/bundle-contract.mjs";
import { resolveReportReference } from "../reporting/report-store.mjs";
import { projectInternalReport } from "../web-publish/from-internal-report.mjs";
import {
  augmentWithDeltas,
  classifyInput,
  findImmediatePrior,
  loadPriorReleases,
} from "../web-publish/projector.mjs";

const DEFAULT_OUT_DIR = join(repoRoot, "web", "src", "content", "releases");
const TAR_EXTENSION_TYPES = new Set([0x4b, 0x4c, 0x4e, 0x67, 0x78]);
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const READ_ONLY_NONBLOCK =
  fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

export async function runPublishCommand(flags) {
  const [inputArg] = flags._;
  if (!inputArg) {
    throw new Error("kova publish: input required — pass a path or a run id");
  }

  const outDir = flags.out_dir
    ? (isAbsolute(flags.out_dir) ? flags.out_dir : resolve(process.cwd(), flags.out_dir))
    : DEFAULT_OUT_DIR;

  const inputPath = await resolveInputPath(inputArg, flags);
  const inputJson = JSON.parse(await readFile(inputPath, "utf8"));
  const kind = classifyInput(inputJson);

  if (kind === "unknown") {
    throw new Error(
      `kova publish: input ${displayPath(inputPath)} does not look like a release payload — ` +
      `expected top-level "ver" and "releaseDate", or schemaVersion "kova.report.v1"`
    );
  }

  const projected = kind === "internal-report"
    ? projectInternalReport(inputJson, {
      ver: flags.ver,
      releaseDate: flags.release_date,
      sha: flags.sha,
    })
    : inputJson;
  const bundleProjection = kind === "internal-report"
    ? await projectReportBundles(projected, inputJson, { inputPath, outDir })
    : { payload: projected, bundles: [] };

  // Augment with deltas/comparison against the prior release in the target dir.
  const priors = await loadPriorReleases(outDir);
  const prior = flags.no_augment
    ? null
    : findImmediatePrior(priors, bundleProjection.payload.ver, bundleProjection.payload.releaseDate);
  const augmented = flags.no_augment
    ? bundleProjection.payload
    : augmentWithDeltas(bundleProjection.payload, prior);

  // Validate against the shared contract before going anywhere near disk.
  const validation = safeParseRelease(augmented);
  if (!validation.ok) {
    const detail = validation.errors
      .map((i) => `  ${i.path}: ${i.message}`)
      .join("\n");
    throw new Error(
      `kova publish: payload failed ${WEB_PAYLOAD_SCHEMA_VERSION} validation:\n${detail}`
    );
  }
  // Re-parse to get coerced types (Date) for the receipt.
  const parsed = parseRelease(augmented, displayPath(inputPath));

  const destPath = join(outDir, `${augmented.ver}.json`);
  const replacing = priors.some((r) => r.id === augmented.ver);

  if (!flags.dry_run) {
    await mkdir(outDir, { recursive: true });
    await copyProjectedBundles(bundleProjection.bundles);
    await atomicWriteJson(destPath, augmented);
  }

  const receipt = {
    schemaVersion: WEB_PAYLOAD_SCHEMA_VERSION,
    ver: augmented.ver,
    releaseDate: augmented.releaseDate,
    sha: augmented.sha,
    passed: augmented.passed,
    input: { path: displayPath(inputPath), kind },
    destination: { path: displayPath(destPath), replacing },
    dryRun: Boolean(flags.dry_run),
    augmented: !flags.no_augment,
    priorVer: prior?.data?.ver ?? null,
    scenarioCount: Array.isArray(parsed.scenarios) ? parsed.scenarios.length : 0,
    runCount: Array.isArray(parsed.runs) ? parsed.runs.length : (parsed.runCount ?? 0),
    coldReadyDeltaPct: parsed.coldReadyDeltaPct ?? null,
    comparisonRows: parsed.comparison?.rows?.length ?? 0,
    headlineCount: Array.isArray(parsed.headline) ? parsed.headline.length : 0,
  };

  if (flags.json) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.log(renderReceipt(receipt));
}

/**
 * Resolve `arg` to an absolute path. Accepts:
 *   - a JSON file path (absolute or relative)
 *   - a kova run-id stored under reportsDir / ~/.kova
 */
async function resolveInputPath(arg, flags = {}) {
  if (looksLikePath(arg)) {
    return isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  }
  if (flags.report_dir) {
    return resolveReportReferenceInDir(arg, resolve(process.cwd(), flags.report_dir));
  }
  return resolveReportReference(arg);
}

function looksLikePath(s) {
  return s.includes("/") || s.endsWith(".json");
}

/**
 * Atomic JSON write: write to a temp file in the same directory, then
 * rename over the destination. Same-directory rename is atomic on every
 * POSIX filesystem we care about, so readers (Astro dev server, CI
 * builds) never observe a partial file.
 */
async function atomicWriteJson(destPath, data) {
  const dir = dirname(destPath);
  const tmp = join(dir, `.${basename(destPath)}.${randomBytes(6).toString("hex")}.tmp`);
  const body = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmp, body, { encoding: "utf8" });
  await rename(tmp, destPath);
}

async function resolveReportReferenceInDir(reference, reportDir) {
  const direct = join(reportDir, `${reference}.json`);
  if (await pathExists(direct)) return direct;

  const entries = await readdir(reportDir);
  const matches = entries
    .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".summary.json"))
    .filter((entry) => {
      const id = basename(entry, ".json");
      return id === reference || id.startsWith(`${reference}-`);
    })
    .map((entry) => join(reportDir, entry));

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`report reference '${reference}' matched multiple reports in ${displayPath(reportDir)}: ${matches.map((item) => basename(item, ".json")).join(", ")}`);
  }
  throw new Error(`report '${reference}' was not found in ${displayPath(reportDir)}`);
}

async function projectReportBundles(payload, report, { inputPath, outDir }) {
  const source = await findReportBundlePath(report, inputPath);
  if (!source) return { payload, bundles: [] };

  const publicBundlesDir = resolvePublicBundlesDir(outDir);
  const name = basename(source.path);
  const href = `/bundles/${name}`;
  const bundle = { name, bytes: source.archive.length, href };
  const next = structuredClone(payload);

  if (Array.isArray(next.runs) && next.runs.length > 0) {
    next.runs[0] = { ...next.runs[0], bundle };
  }

  return {
    payload: next,
    bundles: [{
      archive: source.archive,
      dest: join(publicBundlesDir, name),
    }],
  };
}

async function findReportBundlePath(report, inputPath) {
  const runId = typeof report.runId === "string" ? report.runId : null;
  const explicit = [...new Set([
    report.bundle?.path,
    report.bundle?.outputPath,
    report.outputPaths?.bundle,
    report.outputPaths?.bundlePath,
    report.bundlePath,
  ]
    .filter((item) => typeof item === "string" && item.length > 0)
    .map((candidate) => (
      isAbsolute(candidate) ? candidate : resolve(dirname(inputPath), candidate)
    )))];
  const invalidExplicit = [];
  let verifiedExplicit = null;

  for (const path of explicit) {
    if (!await pathExists(path)) {
      invalidExplicit.push(path);
      continue;
    }
    const archive = await readVerifiedBundle(path, runId);
    if (!archive) {
      invalidExplicit.push(path);
      continue;
    }
    if (verifiedExplicit && !archive.equals(verifiedExplicit.archive)) {
      invalidExplicit.push(path);
      continue;
    }
    verifiedExplicit ??= { path, archive };
  }
  if (invalidExplicit.length > 0) {
    throw new Error(
      "kova publish: explicitly referenced report bundle failed integrity verification: " +
      invalidExplicit.map((path) => displayPath(path)).join(", ")
    );
  }
  if (verifiedExplicit) {
    return verifiedExplicit;
  }

  const inputDir = dirname(inputPath);
  const inputBase = basename(inputPath, ".json");
  const contentAddressed = await findContentAddressedBundlePath(inputDir, [
    typeof runId === "string"
      ? safeBundlePrefix(artifactRunIdSegment(runId))
      : null,
    safeBundlePrefix(inputBase),
    safeBundlePrefix(inputBase.replace(/-[^-]+$/, "")),
  ].filter(Boolean), runId);
  if (contentAddressed) {
    return contentAddressed;
  }

  const inferred = [
    runId ? join(inputDir, `${runId}-bundle.tar.gz`) : null,
    join(inputDir, `${inputBase}-bundle.tar.gz`),
    join(inputDir, `${inputBase.replace(/-[^-]+$/, "")}-bundle.tar.gz`),
  ].filter(Boolean);

  for (const candidate of inferred) {
    if (await pathExists(candidate)) {
      const archive = await readVerifiedBundle(candidate, runId);
      if (archive) {
        return { path: candidate, archive };
      }
    }
  }
  return null;
}

function safeBundlePrefix(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return null;
  }
  return `${value}-bundle-`;
}

async function findContentAddressedBundlePath(inputDir, prefixes, runId) {
  const entries = await readdir(inputDir, { withFileTypes: true });
  for (const prefix of new Set(prefixes)) {
    let best = null;
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !entry.name.endsWith(".tar.gz")
      ) {
        continue;
      }
      const digest = entry.name.slice(prefix.length, -".tar.gz".length);
      if (!/^[a-f0-9]{64}$/.test(digest)) continue;

      const path = join(inputDir, entry.name);
      const archive = await readVerifiedBundle(path, runId);
      if (!archive) {
        continue;
      }
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      const candidate = { path, archive, mtimeMs: info.mtimeMs };
      if (
        !best ||
        candidate.mtimeMs > best.mtimeMs ||
        (
          candidate.mtimeMs === best.mtimeMs &&
          candidate.path.localeCompare(best.path) < 0
        )
      ) {
        best = candidate;
      }
    }
    if (best) {
      return best;
    }
  }
  return null;
}

async function readVerifiedBundle(path, runId, archive = null) {
  if (!runId) {
    return null;
  }
  const expectedManifest =
    `${artifactRunIdSegment(runId)}-bundle/manifest.json`;
  try {
    const verifiedArchive = archive ?? (
      await readBoundedFile(
        path,
        MAX_BUNDLE_COMPRESSED_BYTES,
        "report bundle compressed archive"
      )
    ).content;
    if (!await contentAddressMatches(path, verifiedArchive)) {
      return null;
    }
    const manifest = await readBundleManifest(verifiedArchive, expectedManifest);
    return JSON.parse(manifest).runId === runId
      ? verifiedArchive
      : null;
  } catch {
    return null;
  }
}

async function contentAddressMatches(path, archive) {
  const match = basename(path).match(/-bundle-([a-f0-9]{64})[.]tar[.]gz$/);
  if (!match) {
    return true;
  }
  const digest = match[1];
  if (createHash("sha256").update(archive).digest("hex") !== digest) {
    return false;
  }
  const checksum = (
    await readBoundedFile(
      `${path}.sha256`,
      MAX_BUNDLE_CHECKSUM_BYTES,
      "report bundle checksum",
      "utf8"
    )
  ).content;
  return checksum === `${digest}  ${basename(path)}\n`;
}

async function readBundleManifest(archive, expectedManifest) {
  if (archive.length > MAX_BUNDLE_COMPRESSED_BYTES) {
    throw new Error("report bundle compressed archive exceeds the size limit");
  }
  const extractor = extractTar();
  const destinations = new Map();
  const requiredDirectories = new Set();
  const expectedRoot = posix.dirname(expectedManifest);
  let entryCount = 0;
  let declaredBytes = 0;
  let manifest = null;

  extractor.on("entry", (header, stream, next) => {
    // Rejecting an entry destroys its tar-stream source too; consume that
    // paired error so the extractor's error remains the single failure path.
    stream.on("error", () => {});
    entryCount += 1;
    const normalized = normalizeArchiveMember(header.name, header.type);
    declaredBytes += header.size;
    if (
      entryCount > MAX_BUNDLE_ENTRIES ||
      Buffer.byteLength(header.name) > MAX_BUNDLE_NAME_BYTES ||
      declaredBytes > MAX_BUNDLE_DECLARED_BYTES ||
      !normalized ||
      (
        normalized.path !== expectedRoot &&
        !normalized.path.startsWith(`${expectedRoot}/`)
      ) ||
      !["file", "directory"].includes(header.type) ||
      header.linkname ||
      (header.type === "directory" && header.size !== 0) ||
      archiveDestinationConflicts(
        destinations,
        requiredDirectories,
        normalized,
        header.type
      )
    ) {
      stream.resume();
      next(new Error("report bundle contains an unsafe archive entry"));
      return;
    }
    if (
      !recordArchiveDestination(
        destinations,
        requiredDirectories,
        normalized,
        header.type
      )
    ) {
      stream.resume();
      next(new Error("report bundle archive topology exceeds the size limit"));
      return;
    }
    if (normalized.path !== expectedManifest) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    if (header.type !== "file" || manifest !== null) {
      stream.resume();
      next(new Error("report bundle manifest must be one regular file"));
      return;
    }
    if (header.size > MAX_BUNDLE_MANIFEST_BYTES) {
      stream.resume();
      next(new Error("report bundle manifest exceeds the size limit"));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BUNDLE_MANIFEST_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (oversized) {
        next(new Error("report bundle manifest exceeds the size limit"));
        return;
      }
      try {
        manifest = STRICT_UTF8_DECODER.decode(Buffer.concat(chunks));
        next();
      } catch (error) {
        next(error);
      }
    });
  });

  await new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const guard = createTarGuard();
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      gunzip.destroy();
      guard.destroy();
      extractor.destroy(error);
      reject(error);
    };
    gunzip.on("error", fail);
    guard.on("error", fail);
    extractor.on("error", fail);
    extractor.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    gunzip.pipe(guard).pipe(extractor);
    gunzip.end(archive);
  });
  if (manifest === null) {
    throw new Error("report bundle manifest is missing");
  }
  return manifest;
}

function archiveDestinationConflicts(
  destinations,
  requiredDirectories,
  member,
  type
) {
  const { portablePath, portableSegments } = member;
  if (destinations.has(portablePath)) {
    return true;
  }
  let ancestor = portableSegments[0];
  for (let index = 1; index < portableSegments.length; index += 1) {
    if (destinations.has(ancestor) && destinations.get(ancestor) !== "directory") {
      return true;
    }
    ancestor += `/${portableSegments[index]}`;
  }
  return type !== "directory" && requiredDirectories.has(portablePath);
}

function recordArchiveDestination(
  destinations,
  requiredDirectories,
  member,
  type
) {
  const { portablePath, portableSegments } = member;
  const newAncestors = [];
  let ancestor = portableSegments[0];
  for (let index = 1; index < portableSegments.length; index += 1) {
    if (!requiredDirectories.has(ancestor)) {
      newAncestors.push(ancestor);
    }
    ancestor += `/${portableSegments[index]}`;
  }
  if (
    requiredDirectories.size + newAncestors.length >
    MAX_BUNDLE_ANCESTORS
  ) {
    return false;
  }
  destinations.set(portablePath, type);
  for (const requiredDirectory of newAncestors) {
    requiredDirectories.add(requiredDirectory);
  }
  return true;
}

function createTarGuard() {
  let buffered = Buffer.alloc(0);
  let remaining = 0;
  let total = 0;
  let physicalHeaders = 0;
  let declaredBytes = 0;
  let terminated = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_BUNDLE_UNPACKED_BYTES) {
        callback(new Error("report bundle expanded archive exceeds the size limit"));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      try {
        while (buffered.length > 0) {
          if (remaining > 0) {
            const consumed = Math.min(remaining, buffered.length);
            buffered = buffered.subarray(consumed);
            remaining -= consumed;
            continue;
          }
          if (buffered.length < 512) {
            break;
          }
          const header = buffered.subarray(0, 512);
          buffered = buffered.subarray(512);
          if (header.every((byte) => byte === 0)) {
            terminated = true;
            continue;
          }
          if (terminated) {
            throw new Error("report bundle tar archive has data after its terminator");
          }
          physicalHeaders += 1;
          if (physicalHeaders > MAX_BUNDLE_PHYSICAL_HEADERS) {
            throw new Error("report bundle tar archive has too many headers");
          }
          if (TAR_EXTENSION_TYPES.has(header[156])) {
            throw new Error("report bundle tar extension headers are unsupported");
          }
          validateTarHeader(header);
          const size = decodeTarSize(header.subarray(124, 136));
          declaredBytes += size;
          if (declaredBytes > MAX_BUNDLE_DECLARED_BYTES) {
            throw new Error("report bundle declared content exceeds the size limit");
          }
          remaining = Math.ceil(size / 512) * 512;
        }
      } catch (error) {
        callback(error);
        return;
      }
      this.push(chunk);
      callback();
    },
    flush(callback) {
      if (!terminated || remaining !== 0 || buffered.some((byte) => byte !== 0)) {
        callback(new Error("report bundle tar archive is incomplete"));
        return;
      }
      callback();
    }
  });
}

function decodeTarSize(field) {
  if (field[0] & 0x80) {
    if (field[0] !== 0x80) {
      throw new Error("report bundle tar entry has an invalid binary size");
    }
    let value = 0n;
    for (const byte of field.subarray(1)) {
      value = value * 256n + BigInt(byte);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("report bundle tar entry size is too large");
    }
    return Number(value);
  }
  return decodeTarOctal(field, "report bundle tar entry size");
}

function validateTarHeader(header) {
  const onlyChecksumIsNonzero =
    header.subarray(0, 148).every((byte) => byte === 0) &&
    header.subarray(156).every((byte) => byte === 0);
  if (onlyChecksumIsNonzero) {
    throw new Error("report bundle tar archive has a malformed terminator");
  }
  let actual = 8 * 0x20;
  for (const byte of header.subarray(0, 148)) {
    actual += byte;
  }
  for (const byte of header.subarray(156)) {
    actual += byte;
  }
  const expected = decodeTarOctal(
    header.subarray(148, 156),
    "report bundle tar header checksum"
  );
  if (actual !== expected) {
    throw new Error("report bundle tar header checksum is invalid");
  }
  validateTarPathEncoding(header);
}

function decodeTarOctal(field, label) {
  let start = 0;
  while (start < field.length && field[start] === 0x20) {
    start += 1;
  }
  if (
    field.subarray(start).every((byte) => byte === 0 || byte === 0x20)
  ) {
    return 0;
  }
  let end = start;
  while (end < field.length && field[end] >= 0x30 && field[end] <= 0x37) {
    end += 1;
  }
  if (
    end === start ||
    !field.subarray(end).every((byte) => byte === 0 || byte === 0x20)
  ) {
    throw new Error(`${label} is invalid`);
  }
  const octal = field.subarray(start, end).toString("ascii");
  const value = Number.parseInt(octal, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateTarPathEncoding(header) {
  const name = decodeTarStringField(
    header.subarray(0, 100),
    "report bundle tar entry name"
  );
  const prefix = decodeTarStringField(
    header.subarray(345, 500),
    "report bundle tar entry prefix"
  );
  STRICT_UTF8_DECODER.decode(Buffer.from(prefix ? `${prefix}/${name}` : name));
}

function decodeTarStringField(field, label) {
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  if (
    nul !== -1 &&
    field.subarray(nul).some((byte) => byte !== 0)
  ) {
    throw new Error(`${label} has data after its terminator`);
  }
  try {
    return STRICT_UTF8_DECODER.decode(field.subarray(0, end));
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function readBoundedFile(path, maxBytes, label, encoding = null) {
  const handle = await open(path, READ_ONLY_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error(`${label} exceeds the size limit`);
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds the size limit`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    return { content: encoding ? bytes.toString(encoding) : bytes, info };
  } finally {
    await handle.close();
  }
}

function resolvePublicBundlesDir(outDir) {
  const abs = resolve(outDir);
  const marker = `${sep}src${sep}content${sep}releases`;
  if (abs.endsWith(marker)) {
    return join(abs.slice(0, -marker.length), "public", "bundles");
  }
  return join(repoRoot, "web", "public", "bundles");
}

async function copyProjectedBundles(bundles) {
  for (const bundle of bundles) {
    await mkdir(dirname(bundle.dest), { recursive: true });
    const tmp = join(
      dirname(bundle.dest),
      `.${basename(bundle.dest)}.${randomBytes(6).toString("hex")}.tmp`
    );
    try {
      await writeFile(tmp, bundle.archive);
      await rename(tmp, bundle.dest);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function renderReceipt(r) {
  const head = `# kova publish · ${r.ver}`;
  const mode = r.dryRun ? "_dry-run — no files written_" : "_written_";
  const lines = [
    head,
    "",
    mode,
    "",
    `- contract: \`${r.schemaVersion}\``,
    `- input: \`${r.input.path}\` (${r.input.kind})`,
    `- destination: \`${r.destination.path}\`${r.destination.replacing ? " · replacing existing" : ""}`,
    `- sha: \`${r.sha}\` · passed: ${r.passed ? "yes" : "no"}`,
    `- scenarios: ${r.scenarioCount} · runs: ${r.runCount} · headline rows: ${r.headlineCount}`,
    r.augmented
      ? `- augmented vs prior: \`${r.priorVer ?? "—"}\` · comparison rows: ${r.comparisonRows} · cold-ready Δ: ${formatDelta(r.coldReadyDeltaPct)}`
      : `- augmentation: skipped (--no-augment)`,
  ];
  return lines.join("\n");
}

function formatDelta(n) {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}
