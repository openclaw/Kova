import { resolveBaselinePath } from "../performance/baselines.mjs";
import { parseFilterList } from "./expand.mjs";

export function matrixControlSummary(flags) {
  const requestedParallel = positiveIntegerFlag(flags, "parallel", 1);
  const repeat = positiveIntegerFlag(flags, "repeat", 1);
  const failFast = flags.fail_fast === true;
  const parallel = failFast ? 1 : requestedParallel;
  return {
    include: parseFilterList(flags.include),
    exclude: parseFilterList(flags.exclude),
    failFast,
    continueOnFailure: !failFast,
    requestedParallel,
    parallel,
    parallelAdjusted: parallel !== requestedParallel,
    repeat,
    baseline: flags.baseline ? resolveBaselinePath(flags.baseline) : null,
    saveBaseline: flags.save_baseline ? resolveBaselinePath(flags.save_baseline) : null,
    gate: flags.gate === true,
    reviewedGood: flags.reviewed_good === true,
    bundle: true
  };
}

function positiveIntegerFlag(flags, key, defaultValue) {
  if (flags[key] === undefined) {
    return defaultValue;
  }
  if (flags[key] === true) {
    throw new Error(`--${key.replaceAll("_", "-")} requires a positive integer value`);
  }
  const value = Number(flags[key]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${key.replaceAll("_", "-")} must be a positive integer, got ${JSON.stringify(flags[key])}`);
  }
  return value;
}
