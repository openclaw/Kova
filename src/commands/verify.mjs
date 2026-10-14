import { runVerification } from "../verify/run.mjs";
import { buildPlan, writePlan } from "../verify/plan.mjs";

export async function runVerifyCommand(flags) {
  const [action, ...extra] = flags._;
  if (action === "run" && !extra.length) {
    const required = ["plan", "target_baseline", "target_change"];
    for (const name of Object.keys(flags)) if (!["_", ...required, "execute", "json", "plain", "ascii", "no_progress", "color", "width", "align"].includes(name)) throw new Error(`unknown verify run option: --${name.replaceAll("_", "-")}`);
    for (const name of required) if (typeof flags[name] !== "string" || !flags[name].trim()) throw new Error(`--${name.replaceAll("_", "-")} requires a value`);
    const result = await runVerification({ plan: flags.plan, targetBaseline: flags.target_baseline, targetChange: flags.target_change, execute: flags.execute === true });
    if (flags.json || !flags.execute) console.log(JSON.stringify(result, null, 2));
    else console.log(`Wrote ${result.path}: ${result.notStarted.length} clones not started, ${result.incomplete.length} incomplete phases.`);
    if (result.cleanupErrors?.length) process.exitCode = 1;
    return;
  }
  if (action !== "plan" || extra.length) throw new Error("usage: kova verify plan --repo <checkout> --baseline <sha> --change <sha> --intent <file> --persona <manifest> [--extra-phases <file>] --out <file>");
  const required = ["repo", "baseline", "change", "intent", "persona", "out"];
  for (const name of Object.keys(flags)) if (!["_", ...required, "extra_phases", "json", "plain", "ascii", "no_progress", "color", "width", "align"].includes(name)) throw new Error(`unknown verify plan option: --${name.replaceAll("_", "-")}`);
  for (const name of [...required, ...(flags.extra_phases === undefined ? [] : ["extra_phases"])]) if (typeof flags[name] !== "string" || !flags[name].trim()) throw new Error(`--${name.replaceAll("_", "-")} requires a value`);
  const plan = await buildPlan({ ...flags, extraPhases: flags.extra_phases });
  await writePlan(plan, flags.out);
  if (flags.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(`Wrote ${flags.out}: ${plan.phases.length} phases, ${plan.withheld.length} withheld, ${plan.unmapped.length} unmapped, ${plan.ignored.length} ignored.`);
}
