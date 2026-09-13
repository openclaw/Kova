import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { withFileLock } from "../file-lock.mjs";
import {
  bundleReport,
  pathIsAtOrBelow,
  planBundlePublication,
  publishBundlePair,
  retainGateArtifacts,
  retainedArtifactTreeDigest
} from "../reporting/artifacts.mjs";
import { MAX_BUNDLE_DECLARED_BYTES, MAX_BUNDLE_ENTRIES } from "../reporting/bundle-contract.mjs";
import { renderBundleReceipt } from "../reporting/render-bundle.mjs";
import { renderCleanupArtifacts, renderCleanupEnvs } from "../reporting/render-cleanup.mjs";
import { buildReportOutputPaths, reportTransactionLockPath, writeReportOutputs } from "../run/report-output.mjs";
import { createRunId } from "../run/run-id.mjs";
import { readUstarEntries } from "./archive-fixtures.mjs";
import { syntheticPublicationReport } from "./fixtures.mjs";
import { assertEqual, fileExists } from "./harness.mjs";

export async function reportPublicationCheck(tmp) {
  const publicationRoot = join(tmp, "report-publication");
  const globalFixturePaths = [];
  try {
    const report = syntheticPublicationReport();
    await mkdir(publicationRoot, { recursive: true });
    let reportTransactionSequence = 0;
    const nextReportTransaction = () => {
      reportTransactionSequence += 1;
      return `00000000-0000-4000-8000-${String(reportTransactionSequence).padStart(12, "0")}`;
    };
    const writeTransactionMarker = async (outputPaths) => {
      const previousFiles = await Promise.all(Object.values(outputPaths).map(async (path) => ({
        name: basename(path),
        sha256: createHash("sha256").update(await readFile(path)).digest("hex")
      })));
      const transaction = nextReportTransaction();
      await writeFile(
        join(publicationRoot, `.${basename(outputPaths.json)}.kova-transaction`),
        `${JSON.stringify({
          schemaVersion: "kova.reportTransaction.v3",
          transaction,
          canonical: basename(outputPaths.json),
          previousFiles,
          files: previousFiles
        })}\n`
      );
      return transaction;
    };
    const failedPaths = buildReportOutputPaths(publicationRoot, "kova-260712-000000-aabbcc");
    const invalidSummaryPath = join(publicationRoot, "s".repeat(250));
    let partialWriteRejected = false;
    try {
      await writeReportOutputs(publicationRoot, {
        ...report,
        runId: "kova-260712-000000-aabbcc",
        outputPaths: {
          ...failedPaths,
          summary: invalidSummaryPath
        }
      });
    } catch {
      partialWriteRejected = true;
    }
    assertEqual(partialWriteRejected, true, "report staging failure rejected");
    assertEqual(await fileExists(failedPaths.markdown), false, "failed report did not publish Markdown");
    assertEqual(await fileExists(failedPaths.json), false, "failed report did not publish canonical JSON");
    assertEqual(
      (await readdir(publicationRoot)).some((entry) => entry.endsWith(".tmp") || entry.endsWith(".bak")),
      false,
      "failed report staging removed transaction files"
    );

    const mixedPaths = buildReportOutputPaths(publicationRoot, "kova-260712-000000-mixed");
    const oldCanonical = `${JSON.stringify({ runId: "old-generation" })}\n`;
    const missingSummaryPath = join(publicationRoot, "missing-stage-parent", "summary.json");
    await writeFile(
      join(publicationRoot, `.${basename(mixedPaths.json)}.kova-transaction`),
      `${JSON.stringify({
        schemaVersion: "kova.reportTransaction.v3",
        transaction: nextReportTransaction(),
        canonical: basename(mixedPaths.json),
        previousFiles: [{
          name: basename(mixedPaths.json),
          sha256: createHash("sha256").update(oldCanonical).digest("hex")
        }],
        files: [mixedPaths.markdown, missingSummaryPath, mixedPaths.json].map((path) => ({
          name: basename(path),
          sha256: "0".repeat(64)
        }))
      })}\n`
    );
    await writeFile(
      join(publicationRoot, `.${basename(mixedPaths.json)}.kova-backup`),
      oldCanonical
    );
    await writeFile(mixedPaths.markdown, "new generation\n");
    let mixedRecoveryRejected = false;
    try {
      await writeReportOutputs(publicationRoot, {
        ...report,
        runId: "kova-260712-000000-mixed",
        outputPaths: {
          ...mixedPaths,
          summary: missingSummaryPath
        }
      });
    } catch {
      mixedRecoveryRejected = true;
    }
    assertEqual(mixedRecoveryRejected, true, "post-recovery staging failure rejected");
    assertEqual(
      await fileExists(mixedPaths.markdown),
      false,
      "recovery removes unbacked files from an interrupted generation"
    );
    assertEqual(
      await readFile(mixedPaths.json, "utf8"),
      oldCanonical,
      "recovery restores the prior canonical report"
    );

    const midBackupPaths = buildReportOutputPaths(publicationRoot, "kova-260712-000000-mid-backup");
    const oldMarkdown = "old generation\n";
    const midBackupSummaryPath = join(
      publicationRoot,
      "missing-mid-backup-parent",
      "summary.json"
    );
    await writeFile(
      join(publicationRoot, `.${basename(midBackupPaths.json)}.kova-transaction`),
      `${JSON.stringify({
        schemaVersion: "kova.reportTransaction.v3",
        transaction: nextReportTransaction(),
        canonical: basename(midBackupPaths.json),
        previousFiles: [
          {
            name: basename(midBackupPaths.json),
            sha256: createHash("sha256").update(oldCanonical).digest("hex")
          },
          {
            name: basename(midBackupPaths.markdown),
            sha256: createHash("sha256").update(oldMarkdown).digest("hex")
          }
        ],
        files: [midBackupPaths.markdown, midBackupSummaryPath, midBackupPaths.json].map((path) => ({
          name: basename(path),
          sha256: "0".repeat(64)
        }))
      })}\n`
    );
    await writeFile(
      join(publicationRoot, `.${basename(midBackupPaths.json)}.kova-backup`),
      oldCanonical
    );
    await writeFile(midBackupPaths.markdown, oldMarkdown);
    let midBackupRecoveryRejected = false;
    try {
      await writeReportOutputs(publicationRoot, {
        ...report,
        runId: "kova-260712-000000-mid-backup",
        outputPaths: {
          ...midBackupPaths,
          summary: midBackupSummaryPath
        }
      });
    } catch {
      midBackupRecoveryRejected = true;
    }
    assertEqual(midBackupRecoveryRejected, true, "mid-backup staging failure rejected");
    assertEqual(
      await readFile(midBackupPaths.markdown, "utf8"),
      oldMarkdown,
      "recovery preserves an untouched prior companion"
    );
    assertEqual(
      await readFile(midBackupPaths.json, "utf8"),
      oldCanonical,
      "mid-backup recovery restores the prior canonical report"
    );

    const publishedRunId = createRunId();
    const outputPaths = buildReportOutputPaths(publicationRoot, publishedRunId);
    const publishedReport = {
      ...report,
      runId: publishedRunId,
      outputPaths
    };
    await writeReportOutputs(publicationRoot, publishedReport);
    assertEqual(await fileExists(outputPaths.markdown), true, "report Markdown published");
    assertEqual(await fileExists(outputPaths.summary), true, "report summary published");
    assertEqual(
      JSON.parse(await readFile(outputPaths.json, "utf8")).runId,
      publishedReport.runId,
      "canonical report JSON published"
    );
    const committedJson = await readFile(outputPaths.json);
    const committedMarkdown = await readFile(outputPaths.markdown);
    const longArtifactName = `${"l".repeat(120)}.json`;
    const unicodeArtifactName = "sigma-\u03c3.json";
    const optionArtifactName = "-option.json";
    const deepArtifactSegments = Array.from({ length: 64 }, (_, index) => `d${index}`);
    const deepArtifactPath = join(...deepArtifactSegments, "deep.json");
    const publishedArtifactsDir = join(tmp, "published-artifacts");
    const publishedArtifactRoot = join(publishedArtifactsDir, publishedReport.runId);
    await mkdir(publishedArtifactRoot, { recursive: true });
    await writeFile(join(publishedArtifactRoot, longArtifactName), "long artifact\n");
    await writeFile(join(publishedArtifactRoot, unicodeArtifactName), "unicode artifact\n");
    await writeFile(join(publishedArtifactRoot, optionArtifactName), "option artifact\n");
    await mkdir(join(publishedArtifactRoot, ...deepArtifactSegments), { recursive: true });
    await writeFile(join(publishedArtifactRoot, deepArtifactPath), "deep artifact\n");
    const caseCollisionRoot = join(publishedArtifactRoot, "case-collision");
    await mkdir(caseCollisionRoot);
    await writeFile(join(caseCollisionRoot, "Case.json"), "upper\n");
    await writeFile(join(caseCollisionRoot, "case.json"), "lower\n");
    const caseCollisionNames = await readdir(caseCollisionRoot);
    let releaseTransientWriter;
    let markTransientWriterReady;
    const transientWriterRelease = new Promise((resolve) => {
      releaseTransientWriter = resolve;
    });
    const transientWriterReady = new Promise((resolve) => {
      markTransientWriterReady = resolve;
    });
    const transientWriter = withFileLock(
      reportTransactionLockPath(outputPaths.json),
      async () => {
        await writeFile(
          outputPaths.json,
          `${JSON.stringify({ ...publishedReport, runId: "transient-generation" })}\n`
        );
        await writeFile(outputPaths.markdown, "# transient generation\n");
        markTransientWriterReady();
        await transientWriterRelease;
        await writeFile(outputPaths.json, committedJson);
        await writeFile(outputPaths.markdown, committedMarkdown);
      }
    );
    await transientWriterReady;
    let snapshotSettled = false;
    const serializedBundlePromise = bundleReport(outputPaths.json, {
      outputDir: join(publicationRoot, "serialized-snapshot-bundles"),
      artifactsDir: publishedArtifactsDir
    }).finally(() => {
      snapshotSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEqual(
      snapshotSettled,
      false,
      "report snapshot waits for the writer transaction"
    );
    releaseTransientWriter();
    await transientWriter;
    const serializedBundle = await serializedBundlePromise;
    assertEqual(
      serializedBundle.runId,
      publishedReport.runId,
      "report snapshot excludes a rolled-back transient generation"
    );
    const serializedEntries = readUstarEntries(await readFile(serializedBundle.outputPath));
    assertEqual(
      serializedEntries.some((entry) => ["g", "x", "L", "K", "N"].includes(entry.type)),
      false,
      "generated bundle does not require tar extension headers"
    );
    const serializedIndexEntry = serializedEntries.find(
      (entry) => entry.name === `${publishedReport.runId}-bundle/artifact-index.json`
    );
    const serializedIndex = JSON.parse(serializedIndexEntry.content.toString("utf8"));
    for (const originalPath of [
      `artifacts/${longArtifactName}`,
      `artifacts/${unicodeArtifactName}`,
      `artifacts/${optionArtifactName}`,
      `artifacts/${deepArtifactPath.split("\\").join("/")}`
    ]) {
      const indexed = serializedIndex.entries.find((entry) => entry.path === originalPath);
      assertEqual(Boolean(indexed), true, `artifact index preserves ${originalPath}`);
      assertEqual(
        indexed.archivePath.startsWith("mapped/"),
        true,
        `artifact index maps non-USTAR path ${originalPath}`
      );
      assertEqual(
        serializedEntries.some(
          (entry) => entry.name === `${serializedIndex.bundleRoot}/${indexed.archivePath}`
        ),
        true,
        `generated bundle contains mapped artifact ${originalPath}`
      );
    }
    if (caseCollisionNames.length === 2) {
      const caseCollisionEntries = serializedIndex.entries.filter(
        (entry) => entry.path.startsWith("artifacts/case-collision/")
      );
      assertEqual(caseCollisionEntries.length, 2, "case-distinct artifacts are indexed");
      assertEqual(
        new Set(caseCollisionEntries.map((entry) => entry.archivePath)).size,
        2,
        "case-folding archive collision is disambiguated"
      );
      assertEqual(
        caseCollisionEntries.some((entry) => entry.archivePath.startsWith("mapped/")),
        true,
        "case-folding archive collision uses a mapped path"
      );
    }
    const overlappingBundle = await bundleReport(outputPaths.json, {
      outputDir: join(publishedArtifactRoot, "bundle-output"),
      artifactsDir: publishedArtifactsDir
    });
    assertEqual(
      await fileExists(overlappingBundle.outputPath),
      true,
      "bundle staging remains outside an overlapping artifact source tree"
    );
    const overlappingEntries = readUstarEntries(
      await readFile(overlappingBundle.outputPath)
    );
    const overlappingIndexEntry = overlappingEntries.find(
      (entry) => entry.name === `${publishedReport.runId}-bundle/artifact-index.json`
    );
    const overlappingIndex = JSON.parse(
      overlappingIndexEntry.content.toString("utf8")
    );
    assertEqual(
      overlappingIndex.entries.some(
        (entry) => entry.path.startsWith("artifacts/bundle-output/")
      ),
      false,
      "overlapping bundle output is excluded from the artifact snapshot"
    );
    let artifactRootOutputRejected = false;
    try {
      await bundleReport(outputPaths.json, {
        outputDir: publishedArtifactRoot,
        artifactsDir: publishedArtifactsDir
      });
    } catch (error) {
      artifactRootOutputRejected =
        /cannot replace the run artifact root/.test(error.message);
    }
    assertEqual(
      artifactRootOutputRejected,
      true,
      "bundle output cannot replace the run artifact root"
    );
    assertEqual(
      pathIsAtOrBelow(
        "D:\\kova\\bundles",
        "C:\\kova\\artifacts",
        win32
      ),
      false,
      "cross-volume bundle output is outside the artifact source tree"
    );
    if (process.platform !== "win32") {
      const artifactRootAlias = join(tmp, "published-artifact-root-alias");
      await symlink(publishedArtifactRoot, artifactRootAlias);
      const aliasedOutputName = "aliased-bundle-output";
      const aliasedBundle = await bundleReport(outputPaths.json, {
        outputDir: join(artifactRootAlias, aliasedOutputName),
        artifactsDir: publishedArtifactsDir
      });
      const aliasedEntries = readUstarEntries(await readFile(aliasedBundle.outputPath));
      const aliasedIndexEntry = aliasedEntries.find(
        (entry) => entry.name === `${publishedReport.runId}-bundle/artifact-index.json`
      );
      const aliasedIndex = JSON.parse(aliasedIndexEntry.content.toString("utf8"));
      assertEqual(
        aliasedIndex.entries.some(
          (entry) => entry.path.startsWith(`artifacts/${aliasedOutputName}/`)
        ),
        false,
        "symlink-aliased bundle output is excluded from the artifact snapshot"
      );
      let aliasedArtifactRootRejected = false;
      try {
        await bundleReport(outputPaths.json, {
          outputDir: artifactRootAlias,
          artifactsDir: publishedArtifactsDir
        });
      } catch (error) {
        aliasedArtifactRootRejected =
          /cannot replace the run artifact root/.test(error.message);
      }
      assertEqual(
        aliasedArtifactRootRejected,
        true,
        "symlink-aliased artifact root cannot be used as bundle output"
      );
    }
    const syntheticEntry = (path, bytes = 0) => ({
      path,
      bytes,
      sha256: "0".repeat(64)
    });
    const mandatoryEntryCount = MAX_BUNDLE_ENTRIES - 2;
    const mandatoryEntries = Array.from(
      { length: mandatoryEntryCount },
      (_, index) => syntheticEntry(
        `artifacts/mandatory/file-${String(index).padStart(5, "0")}.txt`
      )
    );
    const rawTraceEntries = [
      syntheticEntry("artifacts/scenario-run/node-profiles/node-trace-100.json"),
      syntheticEntry("artifacts/node-profiles/node-trace-200.log")
    ];
    const similarlyNamedEntries = [
      syntheticEntry("artifacts/node-profiles/node-trace-summary.txt"),
      syntheticEntry("artifacts/other/node-trace-300.json")
    ];
    const plannedOmissions = planBundlePublication(
      [...mandatoryEntries, ...rawTraceEntries, ...similarlyNamedEntries],
      `${publishedReport.runId}-bundle`
    ).omissions;
    assertEqual(plannedOmissions.length, 2, "bundle planning omits the full raw trace class");
    assertEqual(
      plannedOmissions.every(
        (entry) => entry.reason === "raw-node-trace-excluded-for-publication-limit"
      ),
      true,
      "bundle planning records the publication-limit reason"
    );
    assertEqual(
      planBundlePublication(
        [...rawTraceEntries, ...similarlyNamedEntries],
        `${publishedReport.runId}-bundle`
      ).omissions.length,
      0,
      "bundle planning retains raw traces while the bundle fits"
    );
    let mandatoryOverflowRejected = false;
    try {
      planBundlePublication(
        [
          ...Array.from(
            { length: MAX_BUNDLE_ENTRIES + 1 },
            (_, index) => syntheticEntry(
              `artifacts/mandatory-overflow/file-${String(index).padStart(5, "0")}.txt`
            )
          ),
          ...rawTraceEntries
        ],
        `${publishedReport.runId}-bundle`
      );
    } catch (error) {
      mandatoryOverflowRejected = /publication size limit/.test(error.message);
    }
    assertEqual(
      mandatoryOverflowRejected,
      true,
      "bundle planning fails closed when mandatory artifacts remain over limit"
    );

    const omissionRunId = createRunId();
    const omissionOutputPaths = buildReportOutputPaths(publicationRoot, omissionRunId);
    await writeReportOutputs(publicationRoot, {
      ...report,
      runId: omissionRunId,
      outputPaths: omissionOutputPaths
    });
    const omissionArtifactsDir = join(tmp, "publication-omission-artifacts");
    const omissionArtifactRoot = join(omissionArtifactsDir, omissionRunId);
    const omissionProfileRoot = join(omissionArtifactRoot, "node-profiles");
    await mkdir(omissionProfileRoot, { recursive: true });
    await mkdir(join(omissionArtifactRoot, "other"), { recursive: true });
    const rawTraceJsonPath = join(omissionProfileRoot, "node-trace-100.json");
    const rawTraceLogPath = join(omissionProfileRoot, "node-trace-200.log");
    await writeFile(rawTraceJsonPath, "");
    await truncate(rawTraceJsonPath, MAX_BUNDLE_DECLARED_BYTES);
    await writeFile(rawTraceLogPath, "raw trace log\n");
    await writeFile(join(omissionProfileRoot, "CPU.100.cpuprofile"), "cpu profile\n");
    await writeFile(join(omissionProfileRoot, "Heap.100.heapprofile"), "heap profile\n");
    await writeFile(join(omissionProfileRoot, "node-trace-summary.txt"), "summary\n");
    await writeFile(
      join(omissionArtifactRoot, "other", "node-trace-300.json"),
      "unrelated trace\n"
    );
    const omissionBundle = await bundleReport(omissionOutputPaths.json, {
      outputDir: join(publicationRoot, "omission-bundles"),
      artifactsDir: omissionArtifactsDir
    });
    assertEqual(
      (await stat(rawTraceJsonPath)).size,
      MAX_BUNDLE_DECLARED_BYTES,
      "bundle omission leaves the source trace untouched"
    );
    assertEqual(
      await fileExists(rawTraceLogPath),
      true,
      "bundle omission leaves every source trace untouched"
    );
    assertEqual(
      omissionBundle.publicationOmissions?.fileCount,
      2,
      "bundle receipt summarizes omitted raw traces"
    );
    assertEqual(
      omissionBundle.publicationOmissions?.totalBytes,
      MAX_BUNDLE_DECLARED_BYTES + Buffer.byteLength("raw trace log\n"),
      "bundle receipt summarizes omitted trace bytes"
    );
    const omissionArchiveEntries = readUstarEntries(
      await readFile(omissionBundle.outputPath)
    );
    const omissionIndex = JSON.parse(
      omissionArchiveEntries.find(
        (entry) => entry.name === `${omissionRunId}-bundle/artifact-index.json`
      ).content.toString("utf8")
    );
    const omissionManifest = JSON.parse(
      omissionArchiveEntries.find(
        (entry) => entry.name === `${omissionRunId}-bundle/manifest.json`
      ).content.toString("utf8")
    );
    assertEqual(
      omissionIndex.publicationOmissions?.fileCount,
      2,
      "artifact index summarizes omitted raw traces"
    );
    assertEqual(
      omissionIndex.publicationOmissions?.entries.every(
        (entry) =>
          typeof entry.path === "string" &&
          typeof entry.bytes === "number" &&
          /^[a-f0-9]{64}$/.test(entry.sha256) &&
          entry.reason === "raw-node-trace-excluded-for-publication-limit"
      ),
      true,
      "artifact index records every omission with integrity metadata"
    );
    assertEqual(
      omissionManifest.publicationOmissions?.fileCount,
      2,
      "bundle manifest summarizes omitted raw traces"
    );
    for (const retainedPath of [
      "artifacts/node-profiles/CPU.100.cpuprofile",
      "artifacts/node-profiles/Heap.100.heapprofile",
      "artifacts/node-profiles/node-trace-summary.txt",
      "artifacts/other/node-trace-300.json"
    ]) {
      assertEqual(
        omissionIndex.entries.some((entry) => entry.path === retainedPath),
        true,
        `publication keeps ${retainedPath}`
      );
    }
    assertEqual(
      omissionIndex.entries.some(
        (entry) =>
          /^artifacts\/(?:[^/]+\/)*node-profiles\/node-trace-[^/]+\.(?:json|log)$/.test(
            entry.path
          )
      ),
      false,
      "publication omits no arbitrary raw trace subset"
    );
    const renderedOmissionReceipt = renderBundleReceipt(
      omissionBundle,
      { color: "never" },
      process.env,
      process.stdout
    );
    assertEqual(
      renderedOmissionReceipt.includes("omitted") &&
        renderedOmissionReceipt.includes("2 files"),
      true,
      "rendered bundle receipt summarizes publication omissions"
    );

    const markerlessBackupPath = join(
      publicationRoot,
      `.${basename(outputPaths.json)}.kova-backup`
    );
    await writeFile(markerlessBackupPath, oldCanonical);
    let markerlessBackupRejected = false;
    try {
      await writeReportOutputs(publicationRoot, publishedReport);
    } catch (error) {
      markerlessBackupRejected = /report backup is missing transaction marker/.test(error.message);
    }
    assertEqual(markerlessBackupRejected, true, "markerless report backup rejected");
    assertEqual(
      JSON.parse(await readFile(outputPaths.json, "utf8")).runId,
      publishedReport.runId,
      "markerless backup does not replace the committed report"
    );
    assertEqual(
      await readFile(markerlessBackupPath, "utf8"),
      oldCanonical,
      "markerless backup is preserved for operator inspection"
    );
    await rm(markerlessBackupPath);
    const staleReportTransaction = await writeTransactionMarker(outputPaths);
    await writeFile(markerlessBackupPath, "operator replacement\n");
    let staleReportMarkerRejected = false;
    try {
      await writeReportOutputs(publicationRoot, publishedReport);
    } catch (error) {
      staleReportMarkerRejected = /report backup does not match transaction marker/.test(error.message);
    }
    assertEqual(staleReportMarkerRejected, true, "stale report backup marker fails closed");
    assertEqual(
      await readFile(
        join(`${markerlessBackupPath}.claim-${staleReportTransaction}`, "backup"),
        "utf8"
      ),
      "operator replacement\n",
      "stale report backup marker preserves unrelated claimed data"
    );
    await rm(`${markerlessBackupPath}.claim-${staleReportTransaction}`, { recursive: true });
    await rm(join(publicationRoot, `.${basename(outputPaths.json)}.kova-transaction`));
    const conflictingReportTransaction = await writeTransactionMarker(outputPaths);
    const conflictingReportClaimContainer =
      `${markerlessBackupPath}.claim-${conflictingReportTransaction}`;
    const conflictingReportClaim = join(conflictingReportClaimContainer, "backup");
    await mkdir(conflictingReportClaimContainer);
    await rename(outputPaths.json, conflictingReportClaim);
    await writeFile(markerlessBackupPath, "later operator replacement\n");
    let conflictingReportBackupRejected = false;
    try {
      await writeReportOutputs(publicationRoot, publishedReport);
    } catch (error) {
      conflictingReportBackupRejected = /conflicting replacement/.test(error.message);
    }
    assertEqual(
      conflictingReportBackupRejected,
      true,
      "claimed report backup rejects a fixed-path replacement"
    );
    assertEqual(
      JSON.parse(await readFile(conflictingReportClaim, "utf8")).runId,
      publishedReport.runId,
      "claimed report backup remains intact after replacement"
    );
    assertEqual(
      await readFile(markerlessBackupPath, "utf8"),
      "later operator replacement\n",
      "fixed-path report replacement remains intact"
    );
    await rm(markerlessBackupPath);
    await rename(conflictingReportClaim, outputPaths.json);
    await rm(conflictingReportClaimContainer, { recursive: true });
    await rm(join(publicationRoot, `.${basename(outputPaths.json)}.kova-transaction`));
    const malformedReportTransaction = await writeTransactionMarker(outputPaths);
    const malformedReportClaimContainer =
      `${markerlessBackupPath}.claim-${malformedReportTransaction}`;
    await rename(outputPaths.json, markerlessBackupPath);
    await mkdir(malformedReportClaimContainer);
    await writeFile(join(malformedReportClaimContainer, "foreign.txt"), "preserve me\n");
    let malformedReportClaimRejected = false;
    try {
      await writeReportOutputs(publicationRoot, publishedReport);
    } catch (error) {
      malformedReportClaimRejected = /report backup claim is invalid/.test(error.message);
    }
    assertEqual(malformedReportClaimRejected, true, "malformed report claim fails closed");
    assertEqual(
      await readFile(join(malformedReportClaimContainer, "foreign.txt"), "utf8"),
      "preserve me\n",
      "malformed report claim preserves foreign data"
    );
    await rm(malformedReportClaimContainer, { recursive: true });
    await rename(markerlessBackupPath, outputPaths.json);
    await rm(join(publicationRoot, `.${basename(outputPaths.json)}.kova-transaction`));
    const emptyReportClaimTransaction = await writeTransactionMarker(outputPaths);
    const emptyReportClaimContainer =
      `${markerlessBackupPath}.claim-${emptyReportClaimTransaction}`;
    await mkdir(emptyReportClaimContainer);
    await writeReportOutputs(publicationRoot, publishedReport);
    assertEqual(
      await fileExists(emptyReportClaimContainer),
      false,
      "empty post-cleanup report claim is finalized"
    );
    const restoredReportTransaction = nextReportTransaction();
    const restoredPreviousFiles = await Promise.all(
      Object.values(outputPaths).map(async (path) => ({
        name: basename(path),
        sha256: createHash("sha256").update(await readFile(path)).digest("hex")
      }))
    );
    await writeFile(
      join(publicationRoot, `.${basename(outputPaths.json)}.kova-transaction`),
      `${JSON.stringify({
        schemaVersion: "kova.reportTransaction.v3",
        transaction: restoredReportTransaction,
        canonical: basename(outputPaths.json),
        previousFiles: restoredPreviousFiles,
        files: restoredPreviousFiles.map((entry) => ({
          ...entry,
          sha256: "0".repeat(64)
        }))
      })}\n`
    );
    const emptyPostRestoreReportClaim =
      `${markerlessBackupPath}.claim-${restoredReportTransaction}`;
    await mkdir(emptyPostRestoreReportClaim);
    await writeReportOutputs(publicationRoot, publishedReport);
    assertEqual(
      await fileExists(emptyPostRestoreReportClaim),
      false,
      "empty post-restore report claim is finalized from prior hashes"
    );
    const transactionTempPath = join(
      publicationRoot,
      `.${basename(outputPaths.json)}.kova-transaction.tmp`
    );
    await writeFile(transactionTempPath, "{\n");
    await writeReportOutputs(publicationRoot, publishedReport);
    assertEqual(
      await fileExists(transactionTempPath),
      false,
      "retry removes a torn staged transaction marker"
    );
    const claimedReportTransaction = await writeTransactionMarker(outputPaths);
    for (const path of Object.values(outputPaths)) {
      await rename(path, join(publicationRoot, `.${basename(path)}.kova-backup`));
    }
    const claimedMarkdownContainer = join(
      publicationRoot,
      `.${basename(outputPaths.markdown)}.kova-backup.claim-${claimedReportTransaction}`
    );
    const claimedMarkdownBackup = join(claimedMarkdownContainer, "backup");
    await mkdir(claimedMarkdownContainer);
    await rename(
      join(publicationRoot, `.${basename(outputPaths.markdown)}.kova-backup`),
      claimedMarkdownBackup
    );
    const claimedSummaryContainer = join(
      publicationRoot,
      `.${basename(outputPaths.summary)}.kova-backup.claim-${claimedReportTransaction}`
    );
    await mkdir(claimedSummaryContainer);
    await writeReportOutputs(publicationRoot, publishedReport);
    assertEqual(await fileExists(outputPaths.markdown), true, "interrupted report swap recovered");
    assertEqual(
      (await readdir(publicationRoot)).some((entry) => entry.endsWith(".kova-backup")),
      false,
      "recovered report backups removed"
    );
    assertEqual(
      await fileExists(claimedMarkdownBackup),
      false,
      "recovered claimed report backup removed"
    );
    assertEqual(
      await fileExists(claimedSummaryContainer),
      false,
      "empty report claim container resumes backup move"
    );
    await writeTransactionMarker(outputPaths);
    await rename(
      outputPaths.json,
      join(publicationRoot, `.${basename(outputPaths.json)}.kova-backup`)
    );
    await writeReportOutputs(publicationRoot, publishedReport);
    assertEqual(
      (await readFile(outputPaths.markdown, "utf8")).length > 0,
      true,
      "partial report backup recovery preserves untouched files"
    );

    const collisionRoot = join(publicationRoot, "collisions");
    await mkdir(collisionRoot, { recursive: true });
    const collisionReports = [];
    for (const [index, runId] of ["a/b", "a b"].entries()) {
      const path = join(collisionRoot, `collision-${index}.json`);
      await writeFile(path, `${JSON.stringify({ ...report, runId }, null, 2)}\n`);
      await writeFile(path.replace(/\.json$/, ".md"), `report ${index}\n`);
      collisionReports.push(path);
    }
    const bundleRoot = join(publicationRoot, "bundles");
    const firstBundle = await bundleReport(collisionReports[0], { outputDir: bundleRoot });
    const secondBundle = await bundleReport(collisionReports[1], { outputDir: bundleRoot });
    assertEqual(firstBundle.outputPath === secondBundle.outputPath, false, "colliding run IDs use distinct bundle paths");
    assertEqual(await fileExists(firstBundle.checksumPath), true, "first bundle checksum published");
    assertEqual(await fileExists(secondBundle.checksumPath), true, "second bundle checksum published");
    let mismatchedRunBundleRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], secondBundle, {
        outputDir: join(publicationRoot, "mismatched-run-retained")
      });
    } catch (error) {
      mismatchedRunBundleRejected = /bundle run ID does not match report/.test(error.message);
    }
    assertEqual(mismatchedRunBundleRejected, true, "retention rejects a bundle from another run");
    const firstLogicalBundleName = basename(firstBundle.outputPath)
      .replace(/-[a-f0-9]{64}\.tar\.gz$/, "");
    const orphanChecksumPath = join(
      bundleRoot,
      `${firstLogicalBundleName}-${"0".repeat(64)}.tar.gz.sha256`
    );
    const operatorChecksumPath = join(
      bundleRoot,
      `${firstLogicalBundleName}-operator-copy.tar.gz.sha256`
    );
    await writeFile(orphanChecksumPath, "orphan\n");
    await writeFile(operatorChecksumPath, "operator copy\n");
    const activeArchive = Buffer.from("active bundle publication\n");
    const activeDigest = createHash("sha256").update(activeArchive).digest("hex");
    const activeArchivePath = join(
      bundleRoot,
      `${firstLogicalBundleName}-${activeDigest}.tar.gz`
    );
    const activeChecksumPath = `${activeArchivePath}.sha256`;
    await writeFile(
      activeChecksumPath,
      `${activeDigest}  ${basename(activeArchivePath)}\n`
    );
    let releaseActivePublication;
    let markActivePublicationReady;
    const activePublicationRelease = new Promise((resolve) => {
      releaseActivePublication = resolve;
    });
    const activePublicationReady = new Promise((resolve) => {
      markActivePublicationReady = resolve;
    });
    const activePublication = withFileLock(`${activeArchivePath}.lock`, async () => {
      markActivePublicationReady();
      await activePublicationRelease;
      await writeFile(activeArchivePath, activeArchive);
    });
    await activePublicationReady;
    const staleBundleTransaction = randomUUID();
    const staleBundleStage = `${firstBundle.outputPath}.${staleBundleTransaction}.tmp`;
    const staleBundleBuildTransaction = randomUUID();
    const staleBundleBuild = join(
      tmpdir(),
      `kova-artifact-bundle-${staleBundleBuildTransaction}.tmp`
    );
    const unownedBundleBuild = join(
      tmpdir(),
      `kova-artifact-bundle-${randomUUID()}.tmp`
    );
    const malformedBundleBuildTransaction = randomUUID();
    const malformedBundleBuild = join(
      tmpdir(),
      `kova-artifact-bundle-${malformedBundleBuildTransaction}.tmp`
    );
    const markerOnlyBundleBuildTransaction = randomUUID();
    const markerOnlyBundleBuild = join(
      tmpdir(),
      `kova-artifact-bundle-${markerOnlyBundleBuildTransaction}.tmp`
    );
    globalFixturePaths.push(
      staleBundleBuild,
      `${staleBundleBuild}.owner`,
      unownedBundleBuild,
      malformedBundleBuild,
      `${malformedBundleBuild}.owner`,
      `${markerOnlyBundleBuild}.owner`
    );
    await writeFile(staleBundleStage, "stale staged archive\n");
    await writeFile(`${staleBundleStage}.owner`, `${JSON.stringify({
      schemaVersion: "kova.bundlePairStage.v1",
      transaction: staleBundleTransaction,
      outputPath: firstBundle.outputPath,
      checksumPath: firstBundle.checksumPath
    })}\n`);
    await mkdir(staleBundleBuild);
    await writeFile(join(staleBundleBuild, "stale.bin"), "stale bundle build\n");
    await writeFile(`${staleBundleBuild}.owner`, `${JSON.stringify({
      schemaVersion: "kova.bundleBuildStage.v1",
      transaction: staleBundleBuildTransaction,
      outputRoot: bundleRoot,
      bundleName: firstLogicalBundleName
    })}\n`);
    await mkdir(unownedBundleBuild);
    await writeFile(join(unownedBundleBuild, "operator.bin"), "preserve me\n");
    await mkdir(malformedBundleBuild);
    await writeFile(join(malformedBundleBuild, "operator.bin"), "preserve malformed owner\n");
    await writeFile(`${malformedBundleBuild}.owner`, `${JSON.stringify({
      schemaVersion: "kova.bundleBuildStage.v1",
      transaction: malformedBundleBuildTransaction,
      outputRoot: {},
      bundleName: firstLogicalBundleName
    })}\n`);
    await writeFile(`${markerOnlyBundleBuild}.owner`, `${JSON.stringify({
      schemaVersion: "kova.bundleBuildStage.v1",
      transaction: markerOnlyBundleBuildTransaction,
      outputRoot: bundleRoot,
      bundleName: firstLogicalBundleName
    })}\n`);
    let symlinkOwnedBundleBuild = null;
    let symlinkOwnedBundleMarker = null;
    let symlinkOwnedBundleTarget = null;
    if (process.platform !== "win32") {
      const transaction = randomUUID();
      symlinkOwnedBundleBuild = join(
        tmpdir(),
        `kova-artifact-bundle-${transaction}.tmp`
      );
      symlinkOwnedBundleMarker = `${symlinkOwnedBundleBuild}.owner`;
      symlinkOwnedBundleTarget = join(tmp, "operator-stage-owner.json");
      globalFixturePaths.push(
        symlinkOwnedBundleBuild,
        symlinkOwnedBundleMarker
      );
      await mkdir(symlinkOwnedBundleBuild);
      await writeFile(
        join(symlinkOwnedBundleBuild, "operator.bin"),
        "preserve symlink-owned stage\n"
      );
      await writeFile(symlinkOwnedBundleTarget, `${JSON.stringify({
        schemaVersion: "kova.bundleBuildStage.v1",
        transaction,
        outputRoot: bundleRoot,
        bundleName: firstLogicalBundleName
      })}\n`);
      await symlink(symlinkOwnedBundleTarget, symlinkOwnedBundleMarker);
    }
    let cleanupSettled = false;
    const cleanupBundlePromise = bundleReport(
      collisionReports[0],
      { outputDir: bundleRoot }
    ).finally(() => {
      cleanupSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEqual(
      cleanupSettled,
      false,
      "orphan cleanup waits for an active bundle-pair publication"
    );
    releaseActivePublication();
    await activePublication;
    await cleanupBundlePromise;
    assertEqual(await fileExists(orphanChecksumPath), false, "logical bundle retry removes orphan checksum");
    assertEqual(
      await fileExists(activeArchivePath) && await fileExists(activeChecksumPath),
      true,
      "orphan cleanup preserves an active bundle-pair publication"
    );
    assertEqual(
      await fileExists(staleBundleStage),
      false,
      "logical bundle retry removes a crashed staged archive"
    );
    assertEqual(
      await fileExists(staleBundleBuild),
      false,
      "logical bundle retry removes a crashed build directory"
    );
    assertEqual(
      await fileExists(`${markerOnlyBundleBuild}.owner`),
      false,
      "logical bundle retry removes a marker created before its staging directory"
    );
    assertEqual(
      await readFile(join(unownedBundleBuild, "operator.bin"), "utf8"),
      "preserve me\n",
      "logical bundle retry preserves an unowned matching directory"
    );
    assertEqual(
      await readFile(join(malformedBundleBuild, "operator.bin"), "utf8"),
      "preserve malformed owner\n",
      "logical bundle retry ignores malformed owner marker fields"
    );
    if (symlinkOwnedBundleBuild) {
      assertEqual(
        await readFile(join(symlinkOwnedBundleBuild, "operator.bin"), "utf8"),
        "preserve symlink-owned stage\n",
        "logical bundle retry ignores a symlinked owner marker"
      );
      assertEqual(
        (await lstat(symlinkOwnedBundleMarker)).isSymbolicLink(),
        true,
        "symlinked owner marker is preserved"
      );
      await rm(symlinkOwnedBundleBuild, { recursive: true });
      await rm(symlinkOwnedBundleMarker);
      await rm(symlinkOwnedBundleTarget);
    }
    await rm(unownedBundleBuild, { recursive: true });
    await rm(malformedBundleBuild, { recursive: true });
    await rm(`${malformedBundleBuild}.owner`);
    assertEqual(
      await fileExists(operatorChecksumPath),
      true,
      "logical bundle retry preserves operator-named checksum"
    );
    const firstArchive = await readFile(firstBundle.outputPath);
    const firstChecksum = await readFile(firstBundle.checksumPath, "utf8");
    const sameNameArchiveDir = join(publicationRoot, "same-name-archive");
    const sameNameChecksumDir = join(publicationRoot, "same-name-checksum");
    const sameNameArchivePath = join(sameNameArchiveDir, "bundle.tar.gz");
    const sameNameChecksumPath = join(sameNameChecksumDir, "BUNDLE.TAR.GZ");
    await mkdir(sameNameArchiveDir);
    await mkdir(sameNameChecksumDir);
    await writeFile(sameNameArchivePath, firstArchive);
    await writeFile(
      sameNameChecksumPath,
      `${createHash("sha256").update(firstArchive).digest("hex")}  bundle.tar.gz\n`
    );
    let sameNameBundleRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], {
        runId: "a/b",
        outputPath: sameNameArchivePath,
        checksumPath: sameNameChecksumPath
      }, {
        outputDir: join(publicationRoot, "same-name-retained")
      });
    } catch (error) {
      sameNameBundleRejected = /must use distinct filenames/.test(error.message);
    }
    assertEqual(sameNameBundleRejected, true, "retention rejects colliding bundle filenames");
    const reservedArchivePath = join(sameNameArchiveDir, "report.json");
    const reservedChecksumPath = join(sameNameChecksumDir, "report.json.sha256");
    await writeFile(reservedArchivePath, firstArchive);
    await writeFile(
      reservedChecksumPath,
      `${createHash("sha256").update(firstArchive).digest("hex")}  report.json\n`
    );
    let reservedBundleNameRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], {
        runId: "a/b",
        outputPath: reservedArchivePath,
        checksumPath: reservedChecksumPath
      }, {
        outputDir: join(publicationRoot, "reserved-name-retained")
      });
    } catch (error) {
      reservedBundleNameRejected = /conflict with reserved retained artifacts/.test(error.message);
    }
    assertEqual(reservedBundleNameRejected, true, "retention rejects reserved bundle filenames");
    const unicodeArchivePath = join(sameNameArchiveDir, "σ-bundle.tar.gz");
    const unicodeChecksumPath = join(sameNameChecksumDir, "ς-bundle.tar.gz.sha256");
    await writeFile(unicodeArchivePath, firstArchive);
    await writeFile(unicodeChecksumPath, firstChecksum);
    let unicodeBundleNameRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], {
        runId: "a/b",
        outputPath: unicodeArchivePath,
        checksumPath: unicodeChecksumPath
      }, {
        outputDir: join(publicationRoot, "unicode-name-retained")
      });
    } catch (error) {
      unicodeBundleNameRejected = /must use portable filenames/.test(error.message);
    }
    assertEqual(unicodeBundleNameRejected, true, "retention rejects non-portable bundle filenames");
    for (const [name, archiveName, checksumName] of [
      ["trailing-period", "bundle.tar.gz", "BUNDLE.TAR.GZ."],
      ["device-stem-con", "CON.tar.gz", "con.tar.gz.sha256"],
      ["device-stem-nul", "NUL.bundle", "nul.bundle.sha256"],
      ["device-stem-com1", "COM1.archive", "com1.archive.sha256"]
    ]) {
      let portableBundleNameRejected = false;
      try {
        await retainGateArtifacts(collisionReports[0], {
          runId: "a/b",
          outputPath: join(sameNameArchiveDir, archiveName),
          checksumPath: join(sameNameChecksumDir, checksumName)
        }, {
          outputDir: join(publicationRoot, `${name}-retained`)
        });
      } catch (error) {
        portableBundleNameRejected = /must use portable filenames/.test(error.message);
      }
      assertEqual(portableBundleNameRejected, true, `retention rejects ${name} bundle filenames`);
    }
    if (process.platform !== "win32") {
      await chmod(firstBundle.outputPath, 0o400);
      await chmod(firstBundle.checksumPath, 0o400);
      try {
        const readOnlyRetained = await retainGateArtifacts(collisionReports[0], firstBundle, {
          outputDir: join(publicationRoot, "read-only-retained")
        });
        assertEqual(
          await fileExists(readOnlyRetained.bundlePath),
          true,
          "retention copies a read-only bundle"
        );
        assertEqual(
          await fileExists(readOnlyRetained.checksumPath),
          true,
          "retention copies a read-only checksum"
        );
      } finally {
        await chmod(firstBundle.outputPath, 0o600);
        await chmod(firstBundle.checksumPath, 0o600);
      }
    }
    await rm(firstBundle.checksumPath);
    await mkdir(firstBundle.checksumPath);
    let invalidChecksumRejected = false;
    try {
      await publishBundlePair({
        archive: firstArchive,
        outputPath: firstBundle.outputPath,
        checksumPath: firstBundle.checksumPath,
        checksum: firstChecksum
      });
    } catch (error) {
      invalidChecksumRejected = /not a regular file/.test(error.message);
    }
    assertEqual(invalidChecksumRejected, true, "bundle publication rejects invalid existing checksum");
    await rm(firstBundle.checksumPath, { recursive: true });
    await writeFile(firstBundle.checksumPath, firstChecksum);
    await Promise.all([
      publishBundlePair({
        archive: firstArchive,
        outputPath: firstBundle.outputPath,
        checksumPath: firstBundle.checksumPath,
        checksum: firstChecksum
      }),
      publishBundlePair({
        archive: firstArchive,
        outputPath: firstBundle.outputPath,
        checksumPath: firstBundle.checksumPath,
        checksum: firstChecksum
      })
    ]);
    assertEqual(
      await readFile(firstBundle.checksumPath, "utf8"),
      firstChecksum,
      "concurrent identical bundle publication preserves checksum"
    );
    const recoverableBundlePath = join(bundleRoot, "recoverable-bundle.tar.gz");
    const recoverableChecksumPath = `${recoverableBundlePath}.sha256`;
    const recoverableChecksum = `${createHash("sha256").update(firstArchive).digest("hex")}  recoverable-bundle.tar.gz\n`;
    await writeFile(recoverableChecksumPath, recoverableChecksum);
    await publishBundlePair({
      archive: firstArchive,
      outputPath: recoverableBundlePath,
      checksumPath: recoverableChecksumPath,
      checksum: recoverableChecksum
    });
    assertEqual(await fileExists(recoverableBundlePath), true, "checksum-only bundle state recovered");
    let incompleteBundleRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], {
        outputPath: firstBundle.outputPath
      }, {
        outputDir: join(publicationRoot, "incomplete-bundle-retained")
      });
    } catch (error) {
      incompleteBundleRejected = /requires both archive and checksum/.test(error.message);
    }
    assertEqual(incompleteBundleRejected, true, "retention rejects incomplete bundle pair");
    const mismatchedChecksumPath = join(publicationRoot, "mismatched.sha256");
    const mismatchedChecksumPrefix = firstChecksum[0] === "0" ? "1" : "0";
    await writeFile(mismatchedChecksumPath, `${mismatchedChecksumPrefix}${firstChecksum.slice(1)}`);
    let mismatchedBundleRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], {
        runId: "a/b",
        outputPath: firstBundle.outputPath,
        checksumPath: mismatchedChecksumPath
      }, {
        outputDir: join(publicationRoot, "mismatched-bundle-retained")
      });
    } catch (error) {
      mismatchedBundleRejected = /checksum does not match archive/.test(error.message);
    }
    assertEqual(mismatchedBundleRejected, true, "retention rejects mismatched bundle pair");

    const symlinkReportPath = join(collisionRoot, "symlink-report.json");
    const symlinkMarkdownPath = join(collisionRoot, "symlink-report.md");
    const symlinkMarkdownTarget = join(collisionRoot, "symlink-target.md");
    await writeFile(symlinkReportPath, `${JSON.stringify({ ...report, runId: "symlink-report" }, null, 2)}\n`);
    await writeFile(symlinkMarkdownTarget, "linked report\n");
    let symlinkSupported = true;
    try {
      await symlink(symlinkMarkdownTarget, symlinkMarkdownPath);
    } catch (error) {
      if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
        symlinkSupported = false;
      } else {
        throw error;
      }
    }
    if (symlinkSupported) {
      let symlinkMarkdownRejected = false;
      try {
        await bundleReport(symlinkReportPath, { outputDir: bundleRoot });
      } catch (error) {
        symlinkMarkdownRejected = /not a regular file/.test(error.message);
      }
      assertEqual(symlinkMarkdownRejected, true, "bundle rejects symlinked Markdown");
      const symlinkBundlePath = join(collisionRoot, "linked-bundle.tar.gz");
      const symlinkBundleChecksumPath = `${symlinkBundlePath}.sha256`;
      await symlink(firstBundle.outputPath, symlinkBundlePath);
      await writeFile(
        symlinkBundleChecksumPath,
        `${createHash("sha256").update(firstArchive).digest("hex")}  ${basename(symlinkBundlePath)}\n`
      );
      let symlinkBundleRejected = false;
      try {
        await retainGateArtifacts(collisionReports[0], {
          runId: "a/b",
          outputPath: symlinkBundlePath,
          checksumPath: symlinkBundleChecksumPath
        }, {
          outputDir: join(publicationRoot, "symlink-bundle-retained")
        });
      } catch (error) {
        symlinkBundleRejected = /not a regular file/.test(error.message);
      }
      assertEqual(symlinkBundleRejected, true, "retention rejects a symlinked bundle");
    }

    const emptyRetainedRoot = join(publicationRoot, "empty-retained");
    const emptyRetainedBackup = join(publicationRoot, ".empty-retained.bak");
    const staleRetainedTransaction = "30000000-0000-4000-8000-000000000002";
    const staleRetainedStage = join(
      publicationRoot,
      `.empty-retained.${staleRetainedTransaction}.tmp`
    );
    const unownedRetainedStage = join(
      publicationRoot,
      ".empty-retained.30000000-0000-4000-8000-000000000005.tmp"
    );
    const markerOnlyRetainedTransaction = "30000000-0000-4000-8000-000000000006";
    const markerOnlyRetainedStage = join(
      publicationRoot,
      `.empty-retained.${markerOnlyRetainedTransaction}.tmp`
    );
    await mkdir(staleRetainedStage);
    await writeFile(join(staleRetainedStage, "stale.bin"), "stale retained stage\n");
    await writeFile(`${staleRetainedStage}.owner`, `${JSON.stringify({
      schemaVersion: "kova.retainedArtifactStage.v1",
      transaction: staleRetainedTransaction,
      outputRoot: emptyRetainedRoot
    })}\n`);
    await mkdir(unownedRetainedStage);
    await writeFile(join(unownedRetainedStage, "operator.bin"), "preserve me\n");
    await writeFile(`${markerOnlyRetainedStage}.owner`, `${JSON.stringify({
      schemaVersion: "kova.retainedArtifactStage.v1",
      transaction: markerOnlyRetainedTransaction,
      outputRoot: emptyRetainedRoot
    })}\n`);
    const emptyRetainedClaimId = "10000000-0000-4000-8000-000000000001";
    await mkdir(emptyRetainedBackup);
    await writeFile(`${emptyRetainedBackup}.owner`, `${JSON.stringify({
      schemaVersion: "kova.retainedArtifactBackup.v3",
      outputRoot: emptyRetainedRoot,
      treeSha256: await retainedArtifactTreeDigest(emptyRetainedBackup),
      claimId: emptyRetainedClaimId,
      phase: "pending"
    })}\n`);
    const emptyRetainedClaimContainer =
      `${emptyRetainedBackup}.claim-${emptyRetainedClaimId}`;
    await mkdir(emptyRetainedClaimContainer);
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: emptyRetainedRoot
    });
    assertEqual(await fileExists(emptyRetainedRoot), true, "empty retained tree backup recovered");
    assertEqual(await fileExists(emptyRetainedBackup), false, "empty retained tree backup removed");
    assertEqual(
      await fileExists(staleRetainedStage),
      false,
      "retention retry removes a crashed staging directory"
    );
    assertEqual(
      await fileExists(`${markerOnlyRetainedStage}.owner`),
      false,
      "retention retry removes a marker created before its staging directory"
    );
    assertEqual(
      await readFile(join(unownedRetainedStage, "operator.bin"), "utf8"),
      "preserve me\n",
      "retention retry preserves an unowned matching directory"
    );
    await rm(unownedRetainedStage, { recursive: true });

    const restoredEmptyRoot = join(publicationRoot, "restored-empty-retained");
    const restoredEmptyBackup = join(publicationRoot, ".restored-empty-retained.bak");
    const restoredEmptyClaimId = "10000000-0000-4000-8000-000000000002";
    await mkdir(restoredEmptyRoot);
    await writeFile(`${restoredEmptyBackup}.owner`, `${JSON.stringify({
      schemaVersion: "kova.retainedArtifactBackup.v3",
      outputRoot: restoredEmptyRoot,
      treeSha256: await retainedArtifactTreeDigest(restoredEmptyRoot),
      claimId: restoredEmptyClaimId,
      phase: "pending"
    })}\n`);
    await mkdir(`${restoredEmptyBackup}.claim-${restoredEmptyClaimId}`);
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: restoredEmptyRoot
    });
    assertEqual(
      await fileExists(`${restoredEmptyBackup}.claim-${restoredEmptyClaimId}`),
      false,
      "empty restored retained tree finalizes its claim"
    );
    const restoredIncompleteRoot = join(publicationRoot, "restored-incomplete-retained");
    const restoredIncompleteBackup = join(
      publicationRoot,
      ".restored-incomplete-retained.bak"
    );
    const restoredIncompleteClaimId = "10000000-0000-4000-8000-000000000003";
    await mkdir(restoredIncompleteRoot);
    await writeFile(
      join(restoredIncompleteRoot, "retained-artifacts.json"),
      `${JSON.stringify({
        schemaVersion: "kova.releaseGate.retainedArtifacts.v1",
        outputDir: restoredIncompleteRoot,
        reportPath: join(restoredIncompleteRoot, "report.md"),
        jsonPath: join(restoredIncompleteRoot, "report.json"),
        pasteSummaryPath: join(restoredIncompleteRoot, "paste-summary.txt"),
        bundlePath: null,
        checksumPath: null
      })}\n`
    );
    await writeFile(`${restoredIncompleteBackup}.owner`, `${JSON.stringify({
      schemaVersion: "kova.retainedArtifactBackup.v3",
      outputRoot: restoredIncompleteRoot,
      treeSha256: await retainedArtifactTreeDigest(restoredIncompleteRoot),
      claimId: restoredIncompleteClaimId,
      phase: "pending"
    })}\n`);
    await mkdir(`${restoredIncompleteBackup}.claim-${restoredIncompleteClaimId}`);
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: restoredIncompleteRoot
    });
    assertEqual(
      await fileExists(`${restoredIncompleteBackup}.claim-${restoredIncompleteClaimId}`),
      false,
      "incomplete restored retained tree finalizes its claim"
    );

    const retainedRoot = join(publicationRoot, "retained");
    const retained = await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: retainedRoot
    });
    const retainedBeforeFailure = await readFile(retained.jsonPath, "utf8");
    const invalidBundle = join(publicationRoot, "invalid-bundle");
    await mkdir(invalidBundle);
    let retainedReplacementRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], {
        runId: "a/b",
        outputPath: invalidBundle,
        checksumPath: firstBundle.checksumPath
      }, {
        outputDir: retainedRoot
      });
    } catch {
      retainedReplacementRejected = true;
    }
    assertEqual(retainedReplacementRejected, true, "invalid retained replacement rejected");
    assertEqual(
      await readFile(retained.jsonPath, "utf8"),
      retainedBeforeFailure,
      "failed retained replacement preserves prior tree"
    );
    const unmanagedPath = join(retainedRoot, "operator-note.txt");
    await writeFile(unmanagedPath, "preserve me\n");
    let unmanagedRetentionRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], firstBundle, {
        outputDir: retainedRoot
      });
    } catch (error) {
      unmanagedRetentionRejected = /contains unmanaged files/.test(error.message);
    }
    assertEqual(unmanagedRetentionRejected, true, "retention rejects trees with unmanaged files");
    assertEqual(
      await readFile(unmanagedPath, "utf8"),
      "preserve me\n",
      "retention preserves unrelated destination data"
    );
    await rm(unmanagedPath);
    const retainedBackup = join(publicationRoot, ".retained.bak");
    await mkdir(retainedBackup);
    await writeFile(join(retainedBackup, "operator-backup.txt"), "preserve me\n");
    let unverifiedBackupRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], firstBundle, {
        outputDir: retainedRoot
      });
    } catch (error) {
      unverifiedBackupRejected = /backup is not Kova-managed/.test(error.message);
    }
    assertEqual(unverifiedBackupRejected, true, "retention rejects an unverified backup directory");
    assertEqual(
      await readFile(join(retainedBackup, "operator-backup.txt"), "utf8"),
      "preserve me\n",
      "retention preserves an unverified backup directory"
    );
    await rm(retainedBackup, { recursive: true });
    const retainedBackupMarker = `${retainedBackup}.owner`;
    let retainedClaimSequence = 0;
    const writeRetainedBackupMarker = async (phase = "pending") => {
      retainedClaimSequence += 1;
      const claimId = `20000000-0000-4000-8000-${String(retainedClaimSequence).padStart(12, "0")}`;
      const treeSha256 = await retainedArtifactTreeDigest(retainedRoot);
      await writeFile(retainedBackupMarker, `${JSON.stringify({
        schemaVersion: "kova.retainedArtifactBackup.v3",
        outputRoot: retainedRoot,
        treeSha256,
        claimId,
        phase
      })}\n`);
      return claimId;
    };
    const malformedRetainedClaimId = await writeRetainedBackupMarker();
    await rename(retainedRoot, retainedBackup);
    const malformedRetainedClaimContainer =
      `${retainedBackup}.claim-${malformedRetainedClaimId}`;
    await mkdir(malformedRetainedClaimContainer);
    await writeFile(join(malformedRetainedClaimContainer, "foreign.txt"), "preserve me\n");
    let malformedRetainedClaimRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], firstBundle, {
        outputDir: retainedRoot
      });
    } catch (error) {
      malformedRetainedClaimRejected = /retained artifact backup claim is invalid/.test(
        error.message
      );
    }
    assertEqual(malformedRetainedClaimRejected, true, "malformed retained claim fails closed");
    assertEqual(
      await readFile(join(malformedRetainedClaimContainer, "foreign.txt"), "utf8"),
      "preserve me\n",
      "malformed retained claim preserves foreign data"
    );
    await rm(malformedRetainedClaimContainer, { recursive: true });
    await rename(retainedBackup, retainedRoot);
    await rm(retainedBackupMarker);
    const emptyPostRestoreClaimId = await writeRetainedBackupMarker();
    await rename(retainedRoot, retainedBackup);
    const emptyPostRestoreContainer =
      `${retainedBackup}.claim-${emptyPostRestoreClaimId}`;
    const emptyPostRestoreTree = join(emptyPostRestoreContainer, "tree");
    await mkdir(emptyPostRestoreContainer);
    await rename(retainedBackup, emptyPostRestoreTree);
    await rename(emptyPostRestoreTree, retainedRoot);
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: retainedRoot
    });
    assertEqual(
      await fileExists(emptyPostRestoreContainer),
      false,
      "empty post-restore retained claim is finalized"
    );
    const missingCurrentSnapshot = join(publicationRoot, "missing-current-snapshot");
    await cp(retainedRoot, missingCurrentSnapshot, { recursive: true });
    const missingCurrentClaimId = await writeRetainedBackupMarker("cleanup");
    await rename(retainedRoot, retainedBackup);
    const missingCurrentContainer =
      `${retainedBackup}.claim-${missingCurrentClaimId}`;
    const missingCurrentTree = join(missingCurrentContainer, "tree");
    await mkdir(missingCurrentContainer);
    await rename(retainedBackup, missingCurrentTree);
    await rm(join(missingCurrentTree, "report.md"));
    let missingCurrentCleanupRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], firstBundle, {
        outputDir: retainedRoot
      });
    } catch (error) {
      missingCurrentCleanupRejected = /cleanup is missing current tree/.test(error.message);
    }
    assertEqual(
      missingCurrentCleanupRejected,
      true,
      "partial retained cleanup without a current tree fails closed"
    );
    assertEqual(
      await fileExists(missingCurrentTree),
      true,
      "failed partial cleanup preserves the remaining claimed tree"
    );
    await rm(missingCurrentContainer, { recursive: true });
    await cp(missingCurrentSnapshot, retainedRoot, { recursive: true });
    await rm(missingCurrentSnapshot, { recursive: true });
    await rm(retainedBackupMarker);
    const partialCleanupClaimId = await writeRetainedBackupMarker("cleanup");
    await rename(retainedRoot, retainedBackup);
    const partialCleanupContainer =
      `${retainedBackup}.claim-${partialCleanupClaimId}`;
    const partialCleanupTree = join(partialCleanupContainer, "tree");
    await mkdir(partialCleanupContainer);
    await rename(retainedBackup, partialCleanupTree);
    await cp(partialCleanupTree, retainedRoot, { recursive: true });
    await rm(join(partialCleanupTree, "report.md"));
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: retainedRoot
    });
    assertEqual(
      await fileExists(partialCleanupContainer),
      false,
      "partially deleted retained cleanup claim is finalized"
    );
    await writeRetainedBackupMarker();
    await rename(retainedRoot, retainedBackup);
    await mkdir(retainedRoot);
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: retainedRoot
    });
    assertEqual(await fileExists(retained.jsonPath), true, "empty retained tree recovered from backup");
    const claimedRetainedToken = await writeRetainedBackupMarker();
    await rename(retainedRoot, retainedBackup);
    const claimedRetainedContainer = `${retainedBackup}.claim-${claimedRetainedToken}`;
    const claimedRetainedBackup = join(claimedRetainedContainer, "tree");
    await mkdir(claimedRetainedContainer);
    await rename(retainedBackup, claimedRetainedBackup);
    await mkdir(retainedRoot);
    await writeFile(
      join(retainedRoot, "retained-artifacts.json"),
      `${JSON.stringify(retained, null, 2)}\n`
    );
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: retainedRoot
    });
    assertEqual(await fileExists(retained.jsonPath), true, "incomplete retained tree recovered from backup");
    assertEqual(await fileExists(retainedBackup), false, "recovered retained tree backup removed");
    assertEqual(
      await fileExists(claimedRetainedBackup),
      false,
      "recovered claimed retained tree backup removed"
    );

    const conflictingRetainedToken = await writeRetainedBackupMarker();
    await rename(retainedRoot, retainedBackup);
    const conflictingRetainedContainer = `${retainedBackup}.claim-${conflictingRetainedToken}`;
    const conflictingRetainedClaim = join(conflictingRetainedContainer, "tree");
    await mkdir(conflictingRetainedContainer);
    await rename(retainedBackup, conflictingRetainedClaim);
    await mkdir(retainedBackup);
    const unrelatedBackupPath = join(retainedBackup, "operator-backup.txt");
    await writeFile(unrelatedBackupPath, "preserve me\n");
    let staleRetainedMarkerRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], firstBundle, {
        outputDir: retainedRoot
      });
    } catch (error) {
      staleRetainedMarkerRejected = /conflicting replacement/.test(error.message);
    }
    assertEqual(staleRetainedMarkerRejected, true, "claimed retained backup replacement fails closed");
    assertEqual(
      await readFile(unrelatedBackupPath, "utf8"),
      "preserve me\n",
      "claimed retained backup preserves fixed-path replacement data"
    );
    assertEqual(
      await fileExists(join(conflictingRetainedClaim, "retained-artifacts.json")),
      true,
      "claimed retained backup remains intact after replacement"
    );
    await rm(retainedBackup, { recursive: true });
    await rename(conflictingRetainedClaim, retainedRoot);
    await rm(conflictingRetainedContainer, { recursive: true });
    await rm(retainedBackupMarker);
    await retainGateArtifacts(collisionReports[0], firstBundle, {
      outputDir: retainedRoot
    });

    await rm(collisionReports[0].replace(/\.json$/, ".md"));
    let missingMarkdownRejected = false;
    try {
      await bundleReport(collisionReports[0], { outputDir: bundleRoot });
    } catch (error) {
      missingMarkdownRejected = /report Markdown is missing/.test(error.message);
    }
    assertEqual(missingMarkdownRejected, true, "bundle rejects missing Markdown");
    missingMarkdownRejected = false;
    try {
      await retainGateArtifacts(collisionReports[0], firstBundle, {
        outputDir: retainedRoot
      });
    } catch (error) {
      missingMarkdownRejected = /report Markdown is missing/.test(error.message);
    }
    assertEqual(missingMarkdownRejected, true, "retention rejects missing Markdown");

    return {
      id: "report-publication-integrity",
      status: "PASS",
      command: "stage and retain synthetic report artifacts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "report-publication-integrity",
      status: "FAIL",
      command: "stage and retain synthetic report artifacts",
      durationMs: 0,
      message: error.message
    };
  } finally {
    for (const path of globalFixturePaths) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

export function cleanupPublicationReceiptCheck() {
  try {
    const missingEnvResult = renderCleanupEnvs({
      envs: ["kova-stale"],
      results: [],
      execute: true
    }, { color: "never" });
    assertEqual(missingEnvResult.includes("INCOMPLETE"), true, "missing env cleanup result is incomplete");
    assertEqual(missingEnvResult.includes("Done."), false, "missing env cleanup result omits success footer");

    const failedEnvResult = renderCleanupEnvs({
      envs: ["kova-stale"],
      results: [{ command: "ocm env destroy 'kova-stale'", status: 1 }],
      execute: true
    }, { color: "never" });
    assertEqual(failedEnvResult.includes("PARTIAL"), true, "failed env cleanup is partial");
    assertEqual(failedEnvResult.includes("Done."), false, "failed env cleanup omits success footer");

    const missingArtifactResult = renderCleanupArtifacts({
      candidates: [{ name: "kova-old", path: "/tmp/kova-old", ageDays: 8 }],
      results: [],
      execute: true,
      artifactsDir: "/tmp",
      olderThanDays: 7
    }, { color: "never" });
    assertEqual(missingArtifactResult.includes("INCOMPLETE"), true, "missing artifact cleanup result is incomplete");
    assertEqual(missingArtifactResult.includes("Done."), false, "missing artifact cleanup result omits success footer");

    return {
      id: "cleanup-publication-receipts",
      status: "PASS",
      command: "render incomplete cleanup receipts",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "cleanup-publication-receipts",
      status: "FAIL",
      command: "render incomplete cleanup receipts",
      durationMs: 0,
      message: error.message
    };
  }
}
