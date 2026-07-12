// Terminal capability detection + UI option resolution.
// Pure stdlib. Honors NO_COLOR, FORCE_COLOR, CI, --color, --ascii, locale, TTY.

import { resolveWidth } from "./width.mjs";

const DEFAULT_WIDTH = 100;

export function detectCapabilities(env = process.env, stream = process.stdout) {
  const isTTY = Boolean(stream && stream.isTTY);
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const forceColor = parseForceColor(env.FORCE_COLOR);
  const isCI = isCiEnv(env);
  const locale = (env.LC_ALL || env.LC_CTYPE || env.LANG || "").toLowerCase();
  const isUtf8 = locale.includes("utf-8") || locale.includes("utf8") || process.platform === "darwin";
  const colorDepthHint = forceColor !== null ? forceColor : (isTTY && !noColor ? 1 : 0);
  const streamWidth = stream && Number.isFinite(stream.columns) && stream.columns > 0
    ? Math.floor(stream.columns)
    : null;
  const envWidth = positiveInteger(env.COLUMNS);
  const width = streamWidth ?? envWidth ?? DEFAULT_WIDTH;

  return { isTTY, noColor, forceColor, isCI, isUtf8, colorDepthHint, width };
}

function parseForceColor(raw) {
  if (raw === undefined || raw === "") return null;
  if (raw === "false" || raw === "0") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 1;
}

function isCiEnv(env) {
  if (env.CI && env.CI !== "false" && env.CI !== "0") return true;
  return Boolean(env.GITHUB_ACTIONS || env.GITLAB_CI || env.CIRCLECI || env.BUILDKITE || env.TEAMCITY_VERSION);
}

function positiveInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

// Resolve UI options from CLI flags + environment.
// flags.color: "auto" | "always" | "never" | true
// flags.ascii: boolean
// flags.width: number | "full" | "auto" | "off" (cap; "full" disables the cap)
// flags.align: "left" | "center"
// env.KOVA_WIDTH / env.KOVA_ALIGN mirror the flags.
export function resolveUiOptions(flags = {}, env = process.env, stream = process.stdout) {
  const caps = detectCapabilities(env, stream);

  const colorChoice = normalizeColorFlag(flags.color);
  let color;
  if (colorChoice === "never") color = false;
  else if (colorChoice === "always") color = true;
  else color = !caps.noColor && (caps.forceColor !== null ? caps.forceColor > 0 : caps.isTTY);

  const asciiFlag = flags.ascii === true || flags.ascii === "true";
  const ascii = asciiFlag || !caps.isUtf8;

  const { width, leftPad, capped, align } = resolveWidth(caps.width, flags, env);

  return {
    color,
    ascii,
    width,
    leftPad,
    align,
    capped,
    terminalWidth: caps.width,
    isTTY: caps.isTTY,
    isCI: caps.isCI,
    stream,
  };
}

function normalizeColorFlag(value) {
  if (value === undefined || value === true) return "auto";
  if (typeof value !== "string") return "auto";
  const v = value.toLowerCase();
  if (v === "always" || v === "force") return "always";
  if (v === "never" || v === "off" || v === "false" || v === "0") return "never";
  return "auto";
}
