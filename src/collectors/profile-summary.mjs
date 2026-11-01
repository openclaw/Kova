import { readFile } from "node:fs/promises";

export async function summarizeProfiles(paths, options, {
  summarize,
  totalField,
  addTotal = (total, value) => total + value,
  merge,
  render
}) {
  const profiles = [];
  const limit = Math.max(1, Number(options.limit ?? 10));
  const functions = new Map();
  let total = 0;
  for (const path of paths.slice(0, Math.max(1, Number(options.maxProfiles ?? 20)))) {
    try {
      const complete = summarize(JSON.parse(await readFile(path, "utf8")), { limit: Number.MAX_SAFE_INTEGER });
      total = addTotal(total, complete[totalField]);
      merge(functions, complete.topFunctions);
      profiles.push({ path, ...complete, topFunctions: complete.topFunctions.slice(0, limit) });
    } catch (error) {
      profiles.push({ path, error: error.message, [totalField]: null, topFunctions: [] });
    }
  }
  return {
    profileCount: profiles.length,
    parseErrorCount: profiles.filter((profile) => profile.error).length,
    topFunctions: render(functions, total, limit),
    profiles
  };
}
