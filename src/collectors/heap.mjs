import { readFile } from "node:fs/promises";

export async function summarizeHeapProfiles(paths, options = {}) {
  const summaries = [];
  const limit = Math.max(1, Number(options.limit ?? 10));
  const aggregateFunctions = new Map();
  let aggregateTotalSelfSizeBytes = 0;

  for (const path of paths.slice(0, Math.max(1, Number(options.maxProfiles ?? 20)))) {
    try {
      const profile = JSON.parse(await readFile(path, "utf8"));
      const complete = summarizeHeapProfile(profile, { limit: Number.MAX_SAFE_INTEGER });
      aggregateTotalSelfSizeBytes += complete.totalSelfSizeBytes;
      mergeAggregateFunctions(aggregateFunctions, complete.topFunctions);
      summaries.push({
        path,
        ...complete,
        topFunctions: complete.topFunctions.slice(0, limit)
      });
    } catch (error) {
      summaries.push({
        path,
        error: error.message,
        totalSelfSizeBytes: null,
        topFunctions: []
      });
    }
  }

  return {
    profileCount: summaries.length,
    parseErrorCount: summaries.filter((summary) => summary.error).length,
    topFunctions: renderAggregateFunctions(
      aggregateFunctions,
      aggregateTotalSelfSizeBytes,
      limit
    ),
    profiles: summaries
  };
}

export function summarizeHeapProfile(profile, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 10));
  const functions = [];
  walkHeapNode(profile?.head, functions);
  const totalSelfSizeBytes = functions.reduce((total, item) => total + item.selfSizeBytes, 0);
  return {
    totalSelfSizeBytes,
    topFunctions: functions
      .filter((item) => item.selfSizeBytes > 0)
      .toSorted((left, right) => right.selfSizeBytes - left.selfSizeBytes)
      .slice(0, limit)
      .map((item) => ({
        ...item,
        selfSizeMb: roundMb(item.selfSizeBytes),
        selfPercent: totalSelfSizeBytes > 0 ? roundPercent((item.selfSizeBytes / totalSelfSizeBytes) * 100) : null
      }))
  };
}

function walkHeapNode(node, output) {
  if (!node || typeof node !== "object") {
    return;
  }
  const callFrame = node.callFrame ?? {};
  output.push({
    functionName: callFrame.functionName || "(anonymous)",
    url: callFrame.url || "",
    lineNumber: typeof callFrame.lineNumber === "number" ? callFrame.lineNumber : null,
    columnNumber: typeof callFrame.columnNumber === "number" ? callFrame.columnNumber : null,
    selfSizeBytes: Number(node.selfSize) || 0
  });
  for (const child of node.children ?? []) {
    walkHeapNode(child, output);
  }
}

function mergeAggregateFunctions(merged, items) {
  const profileKeys = new Set();
  for (const item of items) {
    const key = `${item.functionName}\n${item.url}\n${item.lineNumber ?? ""}\n${item.columnNumber ?? ""}`;
    const existing = merged.get(key) ?? {
      functionName: item.functionName,
      url: item.url,
      lineNumber: item.lineNumber,
      columnNumber: item.columnNumber,
      selfSizeBytes: 0,
      profileCount: 0
    };
    existing.selfSizeBytes += item.selfSizeBytes ?? 0;
    if (!profileKeys.has(key)) {
      existing.profileCount += 1;
      profileKeys.add(key);
    }
    merged.set(key, existing);
    // Keep one compact exact aggregate per identity; the full sorted profile
    // list is discarded as soon as this merge completes.
  }
}

function renderAggregateFunctions(merged, totalSelfSizeBytes, limit) {
  return [...merged.values()]
    .toSorted((left, right) => right.selfSizeBytes - left.selfSizeBytes)
    .slice(0, limit)
    .map((item) => ({
      ...item,
      selfSizeMb: roundMb(item.selfSizeBytes),
      selfPercent: totalSelfSizeBytes > 0 ? roundPercent((item.selfSizeBytes / totalSelfSizeBytes) * 100) : null
    }));
}

function roundMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}
