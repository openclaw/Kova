// Flags that never accept a value. Listed explicitly so the parser
// doesn't greedily consume the next positional argument (e.g. so
// `kova report --full <path>` still leaves <path> as a positional).
// Use snake_case to match the post-replaceAll key form below.
const BOOLEAN_FLAGS = new Set([
  "full", "json", "plain", "fixer", "help",
  "execute", "ci", "non_interactive", "gate", "fail_fast", "allow_exhaustive",
  "keep_env", "retain_on_failure", "profile_on_failure",
  "deep_profile", "node_profile", "heap_snapshot",
  "ascii", "no_color", "no_progress", "reviewed_good", "version",
  "dry_run", "no_augment",
]);

export function parseFlags(argv) {
  const flags = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      flags._.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue === undefined || inlineValue === "true") {
        flags[key] = true;
      } else if (inlineValue === "false") {
        flags[key] = false;
      } else {
        throw new Error(`--${rawKey} must be true or false`);
      }
      continue;
    }

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return flags;
}

export function collectErrorFlags(argv) {
  const flags = {};
  for (const token of argv) {
    if (token === "--") {
      break;
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (!["json", "plain", "no_color"].includes(key)) {
      continue;
    }
    flags[key] = inlineValue === undefined || inlineValue === "true";
  }
  return flags;
}

export function printHelp() {
  console.log(`Kova - OpenClaw runtime validation lab

Usage:
  kova version [--json]
  kova --version
  kova setup [--ci|--non-interactive] [--auth <mock|api-key|env-only|external-cli|oauth|skip>] [--provider <id>] [--env-var <name>] [--value <secret>] [--json]
  kova setup auth [--provider <id>] [--method <mock|api-key|env-only|external-cli|oauth|skip>] [--env-var <name>] [--value <secret>] [--json]
  kova self-check [--json]
  kova plan [--scenario <id>] [--json|--plain]
  kova inventory plan [--openclaw-bin <path>] [--openclaw-repo <path>] [--subcommands <a,b>] [--require-modeled <capability[,capability]>] [--script-scope <product|all|none>] [--max-subcommands <n>] [--max-warnings <n>] [--timeout-ms <n>] [--json|--plain]
  kova inventory repeated-work [--json|--plain]
  kova run --target <selector> [--from <selector>] [--source-env <env>] [--scenario <id>] [--state <id>] [--auth <mock|live|skip>] [--model <id>] [--repeat <n>] [--baseline [path]] [--save-baseline [path] --reviewed-good] [--regression-thresholds <json>] [--network-frontage <port|loopback|loopback-frontage>] [--worker-id <n>] [--report-dir <path>] [--health-samples <n>] [--readiness-interval-ms <n>] [--resource-sample-interval-ms <n>] [--deep-profile] [--node-profile] [--heap-snapshot] [--profile-on-failure] [--execute] [--keep-env] [--retain-on-failure] [--json]
  kova matrix plan --profile <id> --target <selector> [--from <selector>] [--include <filter>] [--exclude <filter>] [--parallel <n>] [--json|--plain]
  kova matrix run --profile <id> --target <selector> [--from <selector>] [--source-env <env>] [--include <filter>] [--exclude <filter>] [--auth <mock|live|skip>] [--model <id>] [--parallel <n>] [--repeat <n>] [--baseline [path]] [--save-baseline [path] --reviewed-good] [--regression-thresholds <json>] [--network-frontage <port|loopback|loopback-frontage>] [--worker-id <n>] [--fail-fast] [--gate] [--report-dir <path>] [--health-samples <n>] [--readiness-interval-ms <n>] [--resource-sample-interval-ms <n>] [--deep-profile] [--node-profile] [--heap-snapshot] [--profile-on-failure] [--execute] [--allow-exhaustive] [--keep-env] [--retain-on-failure] [--json]
  kova reports [--limit <n>] [--json|--plain]
  kova report <runId|report.json> [--json|--plain]
  kova report list [--limit <n>] [--json|--plain]
  kova report summarize <runId|report.json> [--json|--plain]
  kova report paste <runId|report.json>
  kova report compare <baseline-runId|baseline.json> <current-runId|current.json> [--thresholds <json>] [--fixer] [--json|--plain]
  kova report bundle <runId|report.json> [--output-dir <path>] [--json|--plain]
  kova publish <input.json|runId> [--ver <version>] [--release-date <date>] [--sha <sha>] [--report-dir <path>] [--out-dir <path>] [--no-augment] [--dry-run] [--json]
  kova cleanup envs [--execute] [--json]
  kova cleanup artifacts [--older-than-days <n>] [--execute] [--json]

Selectors:
  npm:<version>              Published OpenClaw release
  release:<name>             Published release track such as stable or beta
  runtime:<name>             Existing OCM runtime name
  local-build:<repo-path>    OpenClaw checkout to build as a release-shaped runtime

Matrix filters:
  scenario:<id>, state:<id>, tag:<tag>, or a bare scenario/state/tag value

Notes:
  Kova uses OCM to create isolated OpenClaw envs and runtimes.
  Kova reports on OpenClaw behavior, not OCM behavior.
  run is dry-run/report-only unless --execute is passed.
  inventory is planner-only and reports discovered OpenClaw capabilities that are not mapped to Kova surfaces.
  inventory plan also compares Kova's channel capability catalog to OpenClaw source when --openclaw-repo is provided.
  inventory repeated-work reports duplicated scenario commands and minimum collector pressure.
  inventory package-script discovery defaults to --script-scope product; use all or none to widen or disable it.
  Executed exhaustive matrix runs require --allow-exhaustive.
  cleanup artifacts is dry-run by default and only targets Kova-owned run artifact dirs.
  Human-facing plan and report commands render dashboards by default; use --plain for compact text.
  Report commands accept either full JSON paths or run IDs from kova reports.
  --repeat records independent samples and computes aggregate performance stats.
  --auth defaults to mock so every disposable env has deliberate model auth unless a scenario opts out.
  --model pins the live-auth model id and is rejected unless --auth live is selected.
  setup provider/auth choices accept prompt numbers in the interactive menu or canonical names such as openai, anthropic, env-only, api-key.
  external-cli setup derives Codex for OpenAI and Claude CLI for Anthropic, then verifies the CLI and auth evidence.
  --baseline compares executed aggregates against a Kova baseline store; without a path it uses the default store.
  --save-baseline writes only reviewed, passing, stable execution aggregates into the selected baseline store.
  --deep-profile enables Node CPU/heap/trace profiling, OpenClaw timeline envs,
  heap snapshots, diagnostic reports, and denser resource sampling.
  setup includes auth. Use --non-interactive or --ci for scripts and agents.

Rendering:
  --width <n|full|auto>  Soft-cap output width (default 80; use full to fill terminal). KOVA_WIDTH overrides.
  --align <left|center>  Horizontal alignment when content is narrower than the terminal (default left). KOVA_ALIGN overrides.
  --color <auto|always|never>  Color control. NO_COLOR / FORCE_COLOR also respected.
  --ascii                Force ASCII glyphs instead of Unicode.
`);
}

export function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function resolveFromCwd(path) {
  if (path.startsWith("/")) {
    return path;
  }
  return `${process.cwd()}/${path}`;
}
