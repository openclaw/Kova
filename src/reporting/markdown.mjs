export function markdownSafeValue(value) {
  if (typeof value === "string") {
    return markdownInline(value, "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => markdownSafeValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, markdownSafeValue(item)])
    );
  }
  return value;
}

export function markdownInline(value, fallback = "unknown") {
  const text = normalizeInline(value, fallback);
  return escapeHtml(text)
    .replace(/([\\`*_[\]~|])/g, "\\$1")
    .replace(/^(#{1,6})(?=\s|$)/, "\\$1")
    .replace(/^([+-])(?=\s)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2")
    .replace(/^(-{3,})(?=\s|$)/, "\\$1");
}

export function markdownCodeSpan(value, fallback = "unknown") {
  const text = normalizeInline(value, fallback);
  const longestRun = longestBacktickRun(text);
  const delimiter = "`".repeat(Math.max(1, longestRun + 1));
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${text}${padding}${delimiter}`;
}

export function markdownTableCodeSpan(value, fallback = "unknown") {
  return markdownCodeSpan(value, fallback).replace(/(\\*)\|/g, (_match, backslashes) =>
    `${backslashes}${backslashes}\\|`
  );
}

export function markdownFence(value, language = "text") {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines = text.split("\n").slice(0, 30);
  const longestRun = longestBacktickRun(lines.join("\n"));
  const delimiter = "`".repeat(Math.max(3, longestRun + 1));
  return [delimiter + language, ...lines, delimiter].join("\n");
}

function normalizeInline(value, fallback) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || String(fallback);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function longestBacktickRun(value) {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}
