// Pretty error formatter for the top-level CLI catch.

import {
  makeUi, ruleSection, renderKovaHeader, repeat, withMargin,
} from "../ui/index.mjs";
import { listCommandIds } from "./render-help.mjs";

// Maps a substring in the error message to a user-facing hint and one or more
// suggested commands. First matching rule wins. Keep substrings stable — the
// self-check matches against the original error wording, not the hint.
const HINT_RULES = [
  {
    match: "kova setup requires --non-interactive or --ci",
    hint: "stdin is not a TTY; pass a non-interactive mode.",
    suggestions: [
      "kova setup --ci",
      "kova setup --non-interactive --provider openai --auth mock",
    ],
  },
  {
    match: "--auth live requires configured live credentials",
    hint: "configure a live credential before running with --auth live.",
    suggestions: [
      "kova setup --non-interactive --provider openai --auth api-key --env-var OPENAI_API_KEY",
      "kova setup --non-interactive --provider openai --auth external-cli",
    ],
  },
  {
    match: "external-cli auth is only supported for provider openai or anthropic",
    hint: "external-cli auth derives Codex (openai) or Claude (anthropic).",
    suggestions: [
      "kova setup --non-interactive --provider openai --auth external-cli",
      "kova setup --non-interactive --provider anthropic --auth external-cli",
    ],
  },
  {
    match: "external-cli", // generic external-cli not usable
    hint: "the external CLI for this provider is missing or unauthenticated.",
    suggestions: [
      "codex login",
      "claude /login",
      "kova setup --non-interactive --provider openai --auth api-key",
    ],
  },
  {
    match: "is required",
    hint: "missing required flag.",
    suggestions: ["kova help <command>"],
  },
  {
    match: "unknown command",
    hint: "see the command list:",
    suggestions: ["kova help"],
  },
  {
    match: "unknown cleanup command",
    hint: "cleanup expects a subcommand.",
    suggestions: ["kova cleanup envs", "kova cleanup artifacts --older-than-days 7"],
  },
  {
    match: "self-check failed",
    hint: "inspect the failures panel above. Re-run with --json for full detail.",
    suggestions: ["kova self-check --json | jq '.checks[] | select(.status==\"FAIL\")'"],
  },
];

export function renderError(error, flags = {}, env = process.env, stream = process.stderr) {
  const ui = makeUi(flags, env, stream);
  const message = error instanceof Error ? error.message : String(error);
  const rule = HINT_RULES.find((r) => message.includes(r.match));
  const sections = [];

  sections.push(renderKovaHeader({
    surface: "error",
    verdict: "FAIL",
    headline: truncateMessage(message),
    meta: "",
    ui,
  }));
  sections.push("");
  sections.push(ruleSection("message", ui.width, ui));
  sections.push(`  ${ui.c.err(ui.g.cross)} ${ui.c.bold(message)}`);

  // Suggest commands by similarity for unknown commands ("unknown command: foo").
  const unknownCmd = /unknown command:\s*(\S+)/.exec(message);
  if (unknownCmd) {
    const guess = nearestCommand(unknownCmd[1]);
    if (guess) {
      sections.push("");
      sections.push(ruleSection("did you mean", ui.width, ui));
      sections.push(`  ${ui.c.head(ui.g.arrow)} ${ui.c.bold(`kova ${guess}`)}`);
    }
  }

  if (rule) {
    sections.push("");
    sections.push(ruleSection("hint", ui.width, ui));
    sections.push(`  ${ui.c.warn(ui.g.warn)} ${ui.c.dim(rule.hint)}`);
    if (rule.suggestions?.length) {
      sections.push("");
      sections.push(ruleSection("try", ui.width, ui));
      for (const s of rule.suggestions) {
        sections.push(`  ${ui.c.head(ui.g.arrow)} ${ui.c.dim(s)}`);
      }
    }
  }
  return withMargin(sections.join("\n"), ui.leftPad, ui.width);
}

function nearestCommand(input) {
  const candidates = listCommandIds().concat(["help"]);
  let best = null;
  let bestDist = Infinity;
  for (const cmd of candidates) {
    const d = lev(input, cmd);
    if (d < bestDist) { best = cmd; bestDist = d; }
  }
  return bestDist <= Math.max(1, Math.floor(input.length / 2)) ? best : null;
}

function truncateMessage(msg) {
  const oneLine = String(msg).split("\n")[0];
  return oneLine.length > 90 ? oneLine.slice(0, 89) + "…" : oneLine;
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}
