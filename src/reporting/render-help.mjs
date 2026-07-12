// TTY help renderer for `kova help` / `kova <cmd> --help`.

import {
  makeUi, ruleSection, renderKovaHeader, repeat, withMargin,
} from "../ui/index.mjs";

const COMMANDS = [
  {
    id: "version", title: "kova version",
    blurb: "Print Kova version and runtime info.",
    usage: ["kova version [--json]", "kova --version"],
    flags: [["--json", "machine-readable"]],
    examples: ["kova version"],
  },
  {
    id: "setup", title: "kova setup",
    blurb: "Verify prerequisites, configure auth, and prepare directories.",
    usage: [
      "kova setup [--ci|--non-interactive] [--auth <method>] [--provider <id>] [--json|--plain]",
      "kova setup auth [--provider <id>] [--method <method>] [--env-var <name>] [--value <secret>] [--json|--plain]",
    ],
    flags: [
      ["--ci", "non-interactive defaults for CI"],
      ["--non-interactive", "use flag values, no prompts"],
      ["--auth <method>", "mock|api-key|env-only|external-cli|oauth|skip"],
      ["--provider <id>", "openai|anthropic|custom-openai"],
      ["--env-var <name>", "env var holding the API key"],
      ["--value <secret>", "secret to write into the credential store"],
      ["--json|--plain", "machine output / plain text"],
    ],
    examples: [
      "kova setup --ci",
      "kova setup --non-interactive --provider openai --auth api-key --env-var OPENAI_API_KEY",
      "kova setup auth --provider anthropic --method external-cli",
    ],
  },
  {
    id: "self-check", title: "kova self-check",
    blurb: "Run the full Kova suite (dry-runs, parsers, gates, evaluators).",
    usage: ["kova self-check [--json|--plain]"],
    flags: [["--json|--plain", "machine output / plain text"]],
    examples: ["kova self-check", "kova self-check --json | jq '.checks[] | select(.status==\"FAIL\")'"],
  },
  {
    id: "plan", title: "kova plan",
    blurb: "Show OpenClaw surfaces, scenarios, states, and metrics.",
    usage: ["kova plan [--scenario <id>] [--json|--plain]"],
    flags: [
      ["--scenario <id>", "narrow to a single scenario"],
      ["--json|--plain", "machine output / plain text"],
    ],
    examples: ["kova plan", "kova plan --scenario fresh-install", "kova plan --json"],
  },
  {
    id: "inventory", title: "kova inventory",
    blurb: "Discover OpenClaw coverage gaps and repeated Kova run work.",
    usage: [
      "kova inventory plan [--openclaw-bin <path>] [--openclaw-repo <path>] [--script-scope <product|all|none>] [--json|--plain]",
      "kova inventory repeated-work [--json|--plain]",
    ],
    flags: [
      ["--openclaw-bin <path>", "binary to inspect"],
      ["--openclaw-repo <path>", "checkout to scan for package scripts"],
      ["--subcommands <a,b>", "explicit subcommand list"],
      ["--require-modeled <c[,c]>", "fail if any of these capabilities are missing"],
      ["--script-scope <s>", "product|all|none (default product)"],
      ["--max-subcommands <n>", "cap discovered subcommands"],
      ["--max-warnings <n>", "fail if more than n warnings"],
      ["--timeout-ms <n>", "discovery timeout"],
    ],
    examples: [
      "kova inventory plan",
      "kova inventory plan --openclaw-bin ./bin/openclaw --json",
      "kova inventory repeated-work --json",
    ],
  },
  {
    id: "run", title: "kova run",
    blurb: "Run one OpenClaw scenario. Dry-run unless --execute.",
    usage: [
      "kova run --target <selector> [--scenario <id>] [--state <id>] [--auth <method>] [--model <id>] [--repeat <n>] [--network-frontage <mode>] [--worker-id <n>] [--execute] [--json|--plain]",
    ],
    flags: [
      ["--target <selector>", "npm:<v> | release:<n> | runtime:<n> | local-build:<path>"],
      ["--from <selector>", "starting target for upgrade scenarios"],
      ["--scenario <id>", "scenario id (default: fresh-install)"],
      ["--state <id>", "state id"],
      ["--auth <method>", "mock|live|skip (default mock)"],
      ["--model <id>", "live-auth model id override"],
      ["--repeat <n>", "independent samples"],
      ["--execute", "actually provision and run; otherwise dry-run"],
      ["--baseline [path]", "compare against baseline store"],
      ["--save-baseline [path]", "write reviewed-good aggregates"],
      ["--reviewed-good", "mark this run as a baseline candidate"],
      ["--network-frontage <mode>", "port|loopback; loopback adds a per-env frontage proxy"],
      ["--worker-id <n>", "worker identity used for loopback frontage allocation"],
      ["--deep-profile", "Node CPU/heap/trace + diagnostic report"],
      ["--node-profile", "Node CPU profile only"],
      ["--heap-snapshot", "heap snapshot only"],
      ["--profile-on-failure", "profile only on failed records"],
      ["--keep-env", "do not destroy env after run"],
      ["--retain-on-failure", "keep env when status != PASS"],
      ["--json|--plain", "machine output / plain text"],
    ],
    examples: [
      "kova run --target runtime:stable --scenario fresh-install",
      "kova run --target runtime:stable --scenario fresh-install --execute",
      "kova run --target runtime:stable --scenario gateway-session --execute --deep-profile --json",
    ],
  },
  {
    id: "matrix", title: "kova matrix",
    blurb: "Profile-driven multi-scenario plan / run with optional gate.",
    usage: [
      "kova matrix plan --profile <id> --target <selector> [--include <f>] [--exclude <f>] [--json|--plain]",
      "kova matrix run --profile <id> --target <selector> [--auth <method>] [--model <id>] [--parallel <n>] [--network-frontage <mode>] [--worker-id <n>] [--gate] [--execute] [--json|--plain]",
    ],
    flags: [
      ["--profile <id>", "smoke|release|release-upgrade|… (see kova plan)"],
      ["--target <selector>", "see kova run --target"],
      ["--include/--exclude <f>", "scenario:<id>, state:<id>, tag:<t>, or bare value"],
      ["--parallel <n>", "concurrent scenarios (default 1)"],
      ["--repeat <n>", "samples per scenario"],
      ["--auth <method>", "mock|live|skip (default mock)"],
      ["--model <id>", "live-auth model id override"],
      ["--fail-fast", "abort on first failure"],
      ["--gate", "evaluate matrix against the profile gate policy"],
      ["--network-frontage <mode>", "port|loopback; loopback cannot combine with --parallel > 1"],
      ["--worker-id <n>", "worker identity used for loopback frontage allocation"],
      ["--allow-exhaustive", "required for executed exhaustive matrices"],
      ["--execute", "actually run; otherwise dry-run"],
      ["--baseline / --save-baseline", "see kova run"],
      ["--json|--plain", "machine output / plain text"],
    ],
    examples: [
      "kova matrix plan --profile smoke --target runtime:stable",
      "kova matrix run --profile smoke --target runtime:stable --execute",
      "kova matrix run --profile release --target release:beta --gate --execute --json",
    ],
  },
  {
    id: "reports", title: "kova reports",
    blurb: "List recent stored reports and their run IDs.",
    usage: ["kova reports [--limit <n>] [--json|--plain]"],
    flags: [
      ["--limit <n>", "number of reports to show (default 20)"],
      ["--json|--plain", "machine output / text"],
    ],
    examples: [
      "kova reports",
      "kova reports --limit 5",
      "kova reports --json",
    ],
  },
  {
    id: "report", title: "kova report",
    blurb: "Render a Kova report dashboard, summary, paste, compare, or bundle.",
    usage: [
      "kova report <runId|report.json> [--json|--plain]",
      "kova report list [--limit <n>] [--json|--plain]",
      "kova report summarize <runId|report.json> [--json|--plain]",
      "kova report paste <runId|report.json>",
      "kova report compare <baseline-runId|baseline.json> <current-runId|current.json> [--thresholds <json>] [--fixer] [--json|--plain]",
      "kova report bundle <runId|report.json> [--output-dir <path>] [--json|--plain]",
    ],
    flags: [
      ["--limit <n>", "report list length"],
      ["--thresholds <json>", "regression thresholds for compare"],
      ["--fixer", "compare emits fixer-friendly notes"],
      ["--output-dir <path>", "destination for `bundle`"],
      ["--json|--plain", "machine output / plain text"],
    ],
    examples: [
      "kova reports",
      "kova report kova-260518-205259-a7f3c2",
      "kova report summarize kova-260518-205259-a7f3c2",
      "kova report compare kova-260518-200157-b91d0a kova-260518-205259-a7f3c2 --json",
      "kova report bundle kova-260518-205259-a7f3c2",
    ],
  },
  {
    id: "publish", title: "kova publish",
    blurb: "Validate a web-payload release and write it into web/src/content/releases/.",
    usage: [
      "kova publish <input.json|runId> [--ver <version>] [--release-date <date>] [--sha <sha>] [--report-dir <path>] [--out-dir <path>] [--no-augment] [--dry-run] [--json]",
    ],
    flags: [
      ["--ver <version>", "public release version when input is an internal report"],
      ["--release-date <date>", "public release date (defaults to report generated date)"],
      ["--sha <sha>", "public source/runtime identifier (defaults from report target when possible)"],
      ["--report-dir <path>", "resolve bare run ids from a custom report directory"],
      ["--out-dir <path>", "target directory (default web/src/content/releases)"],
      ["--no-augment",     "skip computing deltas + comparison vs prior release"],
      ["--dry-run",        "validate + render receipt without writing"],
      ["--json",           "machine-readable receipt"],
    ],
    examples: [
      "kova publish kova-260518-094832-smoke --ver 2026.5.18 --dry-run",
      "kova publish web/src/content/releases/2026.5.16-beta.json --dry-run",
      "kova publish ./payload.json",
      "kova publish ./payload.json --no-augment --json",
    ],
  },
  {
    id: "cleanup", title: "kova cleanup",
    blurb: "Remove stale Kova-owned envs and run artifact dirs.",
    usage: [
      "kova cleanup envs [--older-than-days <n>] [--execute] [--force] [--json|--plain]",
      "kova cleanup artifacts [--older-than-days <n>] [--execute] [--json|--plain]",
    ],
    flags: [
      ["--execute", "actually destroy/remove (default dry-run)"],
      ["--older-than-days <n>", "minimum env/artifact age (defaults: envs 1, artifacts 7)"],
      ["--force", "envs only: override age, retained, active, and unknown-state safeguards"],
      ["--json|--plain", "machine output / plain text"],
    ],
    examples: [
      "kova cleanup envs",
      "kova cleanup envs --execute",
      "kova cleanup artifacts --older-than-days 14 --execute",
    ],
  },
];

const SELECTORS = [
  ["npm:<version>",            "Published OpenClaw release"],
  ["release:<name>",           "Published release track such as stable or beta"],
  ["runtime:<name>",           "Existing OCM runtime name"],
  ["local-build:<repo-path>",  "Build a release-shaped runtime from a checkout"],
];

const NOTES = [
  "Kova uses OCM to create isolated OpenClaw envs and runtimes.",
  "Reports describe OpenClaw behavior, not OCM behavior.",
  "run/matrix run are dry-run unless --execute is passed.",
  "--repeat records independent samples and computes aggregate performance stats.",
  "--auth defaults to mock so every disposable env has deliberate model auth.",
  "--model pins the model id for live-auth runs.",
  "--deep-profile enables Node CPU/heap/trace + diagnostic report + denser sampling.",
  "Human-facing commands render dashboards by default; --plain renders compact text.",
  "Report commands accept either full JSON paths or run IDs from kova reports.",
];

export function renderHelp(commandId, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const cmd = commandId ? COMMANDS.find((c) => c.id === commandId) : null;
  return withMargin(cmd ? renderCommandHelp(cmd, ui) : renderTopLevelHelp(ui), ui.leftPad);
}

function renderTopLevelHelp(ui) {
  const { c, g } = ui;
  const out = [];
  out.push(renderKovaHeader({
    surface: "help",
    verdict: null,
    headline: "OpenClaw runtime validation lab",
    meta: "kova help <command>  for details",
    ui,
  }));
  out.push("");
  out.push(ruleSection("commands", ui.width, ui));

  const namePad = Math.max(...COMMANDS.map((c) => c.title.length)) + 2;
  for (const cmd of COMMANDS) {
    out.push(`  ${c.head(g.diamond)} ${c.bold(padRight(cmd.title, namePad))} ${c.dim(cmd.blurb)}`);
  }

  out.push("");
  out.push(ruleSection("selectors", ui.width, ui));
  const selPad = Math.max(...SELECTORS.map((s) => s[0].length)) + 2;
  for (const [name, blurb] of SELECTORS) {
    out.push(`  ${c.head(g.arrow)} ${c.bold(padRight(name, selPad))} ${c.dim(blurb)}`);
  }

  out.push("");
  out.push(ruleSection("notes", ui.width, ui));
  for (const note of NOTES) {
    out.push(`  ${c.dim(g.bullet)} ${c.dim(note)}`);
  }

  out.push("");
  out.push(ruleSection("next", ui.width, ui));
  out.push(`  ${c.head(g.arrow)} ${c.dim("kova setup --ci")}`);
  out.push(`  ${c.head(g.arrow)} ${c.dim("kova self-check")}`);
  out.push(`  ${c.head(g.arrow)} ${c.dim("kova plan")}`);
  out.push(`  ${c.head(g.arrow)} ${c.dim("kova matrix run --profile smoke --target runtime:stable --execute")}`);
  return out.join("\n");
}

function renderCommandHelp(cmd, ui) {
  const { c, g } = ui;
  const out = [];
  out.push(renderKovaHeader({
    surface: `help ${cmd.id}`,
    verdict: null,
    headline: cmd.blurb,
    meta: "",
    ui,
  }));
  out.push("");
  out.push(ruleSection("usage", ui.width, ui));
  for (const u of cmd.usage) {
    out.push(`  ${c.head(g.arrow)} ${c.bold(u)}`);
  }
  if (cmd.flags?.length) {
    out.push("");
    out.push(ruleSection("flags", ui.width, ui));
    const pad = Math.max(...cmd.flags.map((f) => f[0].length)) + 2;
    for (const [name, blurb] of cmd.flags) {
      out.push(`  ${c.bold(padRight(name, pad))} ${c.dim(blurb)}`);
    }
  }
  if (cmd.examples?.length) {
    out.push("");
    out.push(ruleSection("examples", ui.width, ui));
    for (const ex of cmd.examples) {
      out.push(`  ${c.head(g.diamond)} ${c.dim(ex)}`);
    }
  }
  return out.join("\n");
}

export function listCommandIds() {
  return COMMANDS.map((c) => c.id);
}

function padRight(s, n) {
  return s.length >= n ? s : s + repeat(" ", n - s.length);
}
