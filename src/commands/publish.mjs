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

import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, isAbsolute, resolve, basename, dirname, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import {
  parseRelease,
  safeParseRelease,
  WEB_PAYLOAD_SCHEMA_VERSION,
} from "../web-payload-contract.mjs";
import { repoRoot, displayPath } from "../paths.mjs";
import { resolveReportReference } from "../reporting/report-store.mjs";
import { projectInternalReport } from "../web-publish/from-internal-report.mjs";
import {
  augmentWithDeltas,
  classifyInput,
  findImmediatePrior,
  loadPriorReleases,
} from "../web-publish/projector.mjs";

const DEFAULT_OUT_DIR = join(repoRoot, "web", "src", "content", "releases");

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

  const bundleStat = await stat(source);
  const publicBundlesDir = resolvePublicBundlesDir(outDir);
  const name = basename(source);
  const href = `/bundles/${name}`;
  const bundle = { name, bytes: bundleStat.size, href };
  const next = structuredClone(payload);

  if (Array.isArray(next.runs) && next.runs.length > 0) {
    next.runs[0] = { ...next.runs[0], bundle };
  }

  return {
    payload: next,
    bundles: [{
      source,
      dest: join(publicBundlesDir, name),
    }],
  };
}

async function findReportBundlePath(report, inputPath) {
  const explicit = [
    report.bundle?.path,
    report.bundle?.outputPath,
    report.outputPaths?.bundle,
    report.outputPaths?.bundlePath,
    report.bundlePath,
  ].filter((item) => typeof item === "string" && item.length > 0);

  for (const candidate of explicit) {
    const resolved = isAbsolute(candidate) ? candidate : resolve(dirname(inputPath), candidate);
    if (await pathExists(resolved)) return resolved;
  }

  const inputDir = dirname(inputPath);
  const inputBase = basename(inputPath, ".json");
  const runId = report.runId;
  const inferred = [
    runId ? join(inputDir, `${runId}-bundle.tar.gz`) : null,
    join(inputDir, `${inputBase}-bundle.tar.gz`),
    join(inputDir, `${inputBase.replace(/-[^-]+$/, "")}-bundle.tar.gz`),
  ].filter(Boolean);

  for (const candidate of inferred) {
    if (await pathExists(candidate)) return candidate;
  }
  return findContentAddressedBundlePath(inputDir, [
    safeBundlePrefix(runId),
    safeBundlePrefix(inputBase),
    safeBundlePrefix(inputBase.replace(/-[^-]+$/, "")),
  ].filter(Boolean));
}

function safeBundlePrefix(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return null;
  }
  return `${value}-bundle-`;
}

async function findContentAddressedBundlePath(inputDir, prefixes) {
  const candidates = [];
  for (const entry of await readdir(inputDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const prefix = prefixes.find((item) => entry.name.startsWith(item));
    if (!prefix || !entry.name.endsWith(".tar.gz")) continue;
    const digest = entry.name.slice(prefix.length, -".tar.gz".length);
    if (!/^[a-f0-9]{64}$/.test(digest)) continue;

    const path = join(inputDir, entry.name);
    const checksumPath = `${path}.sha256`;
    if (!await pathExists(checksumPath)) continue;
    const [archive, checksum, info] = await Promise.all([
      readFile(path),
      readFile(checksumPath, "utf8"),
      stat(path),
    ]);
    const actualDigest = createHash("sha256").update(archive).digest("hex");
    if (
      actualDigest !== digest ||
      checksum !== `${digest}  ${entry.name}\n`
    ) {
      continue;
    }
    candidates.push({ path, mtimeMs: info.mtimeMs });
  }
  candidates.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return candidates[0]?.path ?? null;
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
    await copyFile(bundle.source, bundle.dest);
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
