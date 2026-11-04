import { positiveIntegerFlag } from "../run/options.mjs";
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
