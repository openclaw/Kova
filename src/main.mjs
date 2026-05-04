import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { bundleReport } from "./reporting/artifacts.mjs";
import { authReportSummary, resolveRunAuthContext } from "./auth.mjs";
import { runCleanupCommand } from "./cleanup.mjs";
import { runCommand } from "./commands.mjs";
import { runMatrixPlan } from "./commands/matrix-plan.mjs";
import { runMatrixRun } from "./commands/matrix-run.mjs";
import {
  cleanupTargetRuntimeIfNeeded,
  loadRegressionThresholds,
  positiveIntegerFlag,
  profileIntegerFlag,
  summarizePerformanceReceipt,
  validateBaselineExecutionFlags
} from "./commands/run-support.mjs";
import { compareReports, renderCompareFixerSummary, renderCompareSummary } from "./reporting/compare.mjs";
import { parseFlags, printHelp, required, resolveFromCwd } from "./cli.mjs";
import { profileSummary } from "./matrix/profile.mjs";
import { buildCoverage } from "./matrix/coverage.mjs";
import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  resolveBaselinePath,
  reviewBaselineUpdate,
  saveBaselineStore,
  updateBaselineStore
} from "./performance/baselines.mjs";
import { buildPerformanceSummary } from "./performance/stats.mjs";
import { platformInfo } from "./platform.mjs";
import { artifactsDir, repoRoot, reportsDir } from "./paths.mjs";
import { loadRegistryContext } from "./registries/context.mjs";
import { loadScenarios, validateScenarioRun } from "./registries/scenarios.mjs";
import { loadState } from "./registries/states.mjs";
import { renderMarkdownReport, renderPasteSummary, renderReportSummary, summarizeRecords } from "./reporting/report.mjs";
import { buildDryRunRecord, createRunId, executeScenario } from "./runner.mjs";
import { runSelfCheck } from "./selfcheck.mjs";
import { runSetup } from "./setup.mjs";
import { resolveTarget } from "./targets.mjs";
import { ocmEnvDestroy, ocmEnvListJson } from "./ocm/commands.mjs";

const reportSchemaVersion = "kova.report.v1";

export async function main(argv) {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);

  if (command === "help" || flags.help) {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version") {
    await versionCommand(flags);
    return;
  }

  if (command === "setup") {
    await runSetup(flags);
    return;
  }

  if (command === "self-check") {
    await runSelfCheck(flags);
    return;
  }

  if (command === "plan") {
    await plan(flags);
    return;
  }

  if (command === "matrix") {
    await matrixCommand(flags);
    return;
  }

  if (command === "run") {
    await run(flags);
    return;
  }

  if (command === "report") {
    await reportCommand(flags);
    return;
  }

  if (command === "cleanup") {
    await cleanupCommand(flags);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

async function versionCommand(flags = {}) {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.version.v1",
      name: packageJson.name,
      version: packageJson.version
    }, null, 2));
    return;
  }

  console.log(packageJson.version);
}

function filterRegistry(items, selectedId, kind) {
  if (!selectedId) {
    return items;
  }
  const filtered = items.filter((item) => item.id === selectedId);
  if (filtered.length === 0) {
    throw new Error(`no ${kind} found for ${selectedId}`);
  }
  return filtered;
}

async function plan(flags) {
  const registry = await loadRegistryContext();
  const scenarios = filterRegistry(registry.scenarios, flags.scenario, "scenario");
  const states = filterRegistry(registry.states, flags.state, "state");
  const profiles = flags.profile ? filterRegistry(registry.profiles, flags.profile, "profile") : registry.profiles;
  const platform = platformInfo();
  const coverage = buildCoverage({ ...registry, platform });

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.plan.v1",
      generatedAt: new Date().toISOString(),
      platform,
      surfaces: registry.surfaces,
      processRoles: registry.processRoles,
      metrics: registry.metrics,
      scenarios,
      states,
      profiles: profiles.map(profileSummary),
      coverage
    }, null, 2));
    return;
  }

  for (const scenario of scenarios) {
    console.log(`${scenario.id}: ${scenario.title}`);
    console.log(`  Surface: ${scenario.surface}`);
    console.log(`  Objective: ${scenario.objective}`);
    console.log(`  Tags: ${scenario.tags.join(", ")}`);
    console.log("  Phases:");
    for (const phase of scenario.phases) {
      console.log(`    - ${phase.id}: ${phase.title}`);
    }
    console.log("");
  }
}

async function matrixCommand(flags) {
  const [subcommand = "plan"] = flags._;

  if (subcommand === "plan") {
    await runMatrixPlan(flags);
    return;
  }

  if (subcommand === "run") {
    await runMatrixRun(flags);
    return;
  }

  throw new Error(`unknown matrix command: ${subcommand}`);
}

async function reportCommand(flags) {
  const [subcommand, firstPath, secondPath] = flags._;

  if (subcommand === "summarize") {
    const report = await readReport(required(firstPath, "report path"));
    if (flags.json) {
      console.log(JSON.stringify({
        schemaVersion: "kova.report.summary.v1",
        generatedAt: new Date().toISOString(),
        summary: renderReportSummary(report, { structured: true })
      }, null, 2));
      return;
    }

    console.log(renderReportSummary(report));
    return;
  }

  if (subcommand === "paste") {
    const report = await readReport(required(firstPath, "report path"));
    console.log(renderPasteSummary(report));
    return;
  }

  if (subcommand === "compare") {
    await compareReportsCommand(required(firstPath, "baseline report path"), required(secondPath, "current report path"), flags);
    return;
  }

  if (subcommand === "bundle") {
    const receipt = await bundleReport(required(firstPath, "report path"), {
      outputDir: flags.output_dir
    });

    if (flags.json) {
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }

    console.log(`Bundle: ${relative(process.cwd(), receipt.outputPath)}`);
    console.log(`SHA256: ${relative(process.cwd(), receipt.checksumPath)}`);
    return;
  }

  throw new Error(`unknown report command: ${subcommand ?? ""}`);
}

async function compareReportsCommand(baselinePath, currentPath, flags) {
  const baseline = await readReport(baselinePath);
  const current = await readReport(currentPath);
  const thresholds = flags.thresholds ? await readReport(flags.thresholds) : null;
  const comparison = compareReports(baseline, current, { thresholds });

  if (flags.json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  console.log(flags.fixer ? renderCompareFixerSummary(comparison) : renderCompareSummary(comparison));
  if (!comparison.ok) {
    throw new Error("comparison found regressions");
  }
}

async function readReport(path) {
  return JSON.parse(await readFile(resolveFromCwd(path), "utf8"));
}

async function cleanupCommand(flags) {
  const [subcommand] = flags._;
  if (subcommand === "envs") {
    await cleanupEnvs(flags);
    return;
  }
  if (subcommand === "artifacts") {
    await cleanupArtifacts(flags);
    return;
  }

  throw new Error(`unknown cleanup command: ${subcommand ?? ""}`);
}

async function cleanupEnvs(flags) {
  const envList = await runCommand(ocmEnvListJson(), { timeoutMs: 30000 });
  if (envList.status !== 0) {
    throw new Error(`failed to list OCM envs: ${envList.stderr.trim() || envList.stdout.trim()}`);
  }

  const summaries = JSON.parse(envList.stdout);
  if (!Array.isArray(summaries)) {
    throw new Error("ocm env list --json returned unexpected data");
  }

  const envs = summaries
    .map((summary) => summary.name)
    .filter((name) => /^kova-[a-z0-9-]+$/.test(name));
  const results = [];

  if (flags.execute) {
    for (const env of envs) {
      results.push(await runCleanupCommand(ocmEnvDestroy(env), { timeoutMs: 120000 }));
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.cleanup.envs.v1",
      generatedAt: new Date().toISOString(),
      execute: flags.execute === true,
      envs,
      results: results.map((result) => ({
        command: result.command,
        status: result.status,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        attempts: result.attempts ?? []
      }))
    }, null, 2));
    return;
  }

  if (envs.length === 0) {
    console.log("No stale Kova envs found.");
    return;
  }

  if (!flags.execute) {
    console.log("Stale Kova envs:");
    for (const env of envs) {
      console.log(`- ${env}`);
    }
    console.log("Run with --execute to destroy them.");
    return;
  }

  for (const result of results) {
    console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.command}`);
  }
}

async function cleanupArtifacts(flags) {
  const olderThanDays = positiveIntegerFlag(flags, "older_than_days", 7);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates = [];

  let entries = [];
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^kova-\d{4}-\d{2}-\d{2}t/i.test(entry.name)) {
      continue;
    }
    const path = join(artifactsDir, entry.name);
    const info = await stat(path);
    if (info.mtimeMs > cutoffMs) {
      continue;
    }
    candidates.push({
      name: entry.name,
      path,
      mtime: info.mtime.toISOString(),
      ageDays: Math.max(0, Math.floor((Date.now() - info.mtimeMs) / (24 * 60 * 60 * 1000)))
    });
  }

  const results = [];
  if (flags.execute === true) {
    for (const candidate of candidates) {
      const started = Date.now();
      try {
        await rm(candidate.path, { recursive: true, force: true });
        results.push({
          path: candidate.path,
          status: 0,
          durationMs: Date.now() - started,
          error: null
        });
      } catch (error) {
        results.push({
          path: candidate.path,
          status: 1,
          durationMs: Date.now() - started,
          error: error.message
        });
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.cleanup.artifacts.v1",
      generatedAt: new Date().toISOString(),
      execute: flags.execute === true,
      artifactsDir,
      olderThanDays,
      candidates,
      results
    }, null, 2));
    return;
  }

  if (candidates.length === 0) {
    console.log(`No Kova run artifact dirs older than ${olderThanDays} day(s) found.`);
    return;
  }

  if (flags.execute !== true) {
    console.log(`Kova run artifact dirs older than ${olderThanDays} day(s):`);
    for (const candidate of candidates) {
      console.log(`- ${candidate.path}`);
    }
    console.log("Run with --execute to remove them.");
    return;
  }

  for (const result of results) {
    console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.path}`);
  }
}

async function run(flags) {
  const registry = await loadRegistryContext();
  const target = required(flags.target, "--target");
  if (flags.execute === true && !flags.scenario) {
    throw new Error("--execute requires --scenario so real runs stay deliberate");
  }
  validateBaselineExecutionFlags(flags);

  const targetPlan = resolveTarget(target, "target");
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const state = await loadState(flags.state ?? "fresh");
  const scenarios = await loadScenarios(flags.scenario);
  for (const scenario of scenarios) {
    validateScenarioRun(scenario, flags, { targetPlan, fromPlan });
  }

  const reportRoot = flags.report_dir ? resolveFromCwd(flags.report_dir) : reportsDir;
  const runId = createRunId();
  const reportPath = join(reportRoot, `${runId}.md`);
  const jsonPath = join(reportRoot, `${runId}.json`);
  const repeat = positiveIntegerFlag(flags, "repeat", 1);
  const auth = await resolveRunAuthContext(flags);
  const regressionThresholds = await loadRegressionThresholds(flags);
  const baselinePath = resolveBaselinePath(flags.baseline);
  const saveBaselinePath = resolveBaselinePath(flags.save_baseline);
  const baselineStore = baselinePath ? await loadBaselineStore(baselinePath) : null;
  const context = {
    target,
    targetPlan,
    from: flags.from,
    fromPlan,
    state,
    sourceEnv: flags.source_env,
    runId,
    execute: flags.execute === true,
    keepEnv: flags.keep_env === true,
    retainOnFailure: flags.retain_on_failure === true,
    timeoutMs: resolveRunTimeout(scenarios, flags),
    healthSamples: profileIntegerFlag(flags, "health_samples", flags.deep_profile === true ? 10 : 3),
    healthIntervalMs: positiveIntegerFlag(flags, "health_interval_ms", 250),
    readinessIntervalMs: profileIntegerFlag(flags, "readiness_interval_ms", flags.deep_profile === true ? 100 : 250),
    heapSnapshot: flags.heap_snapshot === true || flags.deep_profile === true,
    diagnosticReport: flags.deep_profile === true,
    nodeProfile: flags.node_profile === true || flags.deep_profile === true,
    deepProfile: flags.deep_profile === true,
    profileOnFailure: flags.profile_on_failure === true,
    resourceSampleIntervalMs: profileIntegerFlag(flags, "resource_sample_interval_ms", flags.deep_profile === true ? 250 : 1000),
    processRoles: registry.processRoles,
    surfacesById: Object.fromEntries(registry.surfaces.map((surface) => [surface.id, surface])),
    targetSetup: { completed: false },
    auth
  };
  const records = [];

  for (const scenario of scenarios) {
    for (let index = 1; index <= repeat; index += 1) {
      const iterationContext = {
        ...context,
        repeat: {
          index,
          total: repeat
        }
      };
      if (iterationContext.execute) {
        records.push(await executeScenario(scenario, iterationContext));
      } else {
        records.push(buildDryRunRecord(scenario, iterationContext));
      }
    }
  }
  const targetCleanup = await cleanupTargetRuntimeIfNeeded(targetPlan, records, {
    execute: context.execute,
    timeoutMs: context.timeoutMs
  });
  const performance = buildPerformanceSummary(records, { repeat, regressionThresholds });

  await mkdir(reportRoot, { recursive: true });
  const report = {
    schemaVersion: reportSchemaVersion,
    generatedAt: new Date().toISOString(),
    runId,
    mode: context.execute ? "execution" : "dry-run",
    target,
    from: flags.from ?? null,
    state: {
      id: state.id,
      title: state.title,
      objective: state.objective
    },
    platform: platformInfo(),
    targetCleanup,
    auth: authReportSummary(auth),
    controls: {
      repeat,
      baseline: baselinePath,
      saveBaseline: saveBaselinePath,
      auth: auth.requestedMode
    },
    performance,
    baseline: null,
    summary: summarizeRecords(records),
    records
  };
  const baselineComparison = comparePerformanceToBaseline(report, baselineStore, { targetPlan, regressionThresholds });
  if (baselineComparison) {
    report.baseline = {
      path: baselinePath,
      comparison: baselineComparison
    };
  }
  if (saveBaselinePath) {
    const existingStore = await loadBaselineStore(saveBaselinePath);
    const review = reviewBaselineUpdate(report, { reviewedGood: flags.reviewed_good === true });
    const updatedStore = updateBaselineStore(existingStore, report, { targetPlan, reviewedGood: flags.reviewed_good === true });
    report.baseline = {
      ...(report.baseline ?? {}),
      review,
      saved: await saveBaselineStore(saveBaselinePath, updatedStore)
    };
  }
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mode = context.execute ? "execution" : "dry-run";
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.run.receipt.v1",
      generatedAt: new Date().toISOString(),
      mode,
      runId,
      reportPath,
      jsonPath,
      performance: summarizePerformanceReceipt(report.performance, report.baseline),
      summary: report.summary
    }, null, 2));
    return;
  }

  console.log(`Kova ${mode} report written: ${relative(process.cwd(), reportPath)}`);
  console.log(`Kova ${mode} data written: ${relative(process.cwd(), jsonPath)}`);
}

function resolveRunTimeout(scenarios, flags) {
  if (flags.timeout_ms !== undefined) {
    return positiveIntegerFlag(flags, "timeout_ms", 120000);
  }
  const scenarioTimeouts = scenarios
    .map((scenario) => scenario.timeoutMs)
    .filter((timeout) => typeof timeout === "number");
  return scenarioTimeouts.length === 0 ? 120000 : Math.max(...scenarioTimeouts);
}
