import { buildPlan, writePlan } from "../verify/plan.mjs";

export async function runVerifyCommand(flags) {
  const [action, ...extra] = flags._;
  if (action !== "plan" || extra.length) throw new Error("usage: kova verify plan --repo <checkout> --baseline <sha> --change <sha> --intent <file> --persona <manifest> [--extra-phases <file>] --out <file>");
  const required = ["repo", "baseline", "change", "intent", "persona", "out"];
  for (const name of Object.keys(flags)) if (!["_", ...required, "extra_phases", "json", "plain", "ascii", "no_progress", "color", "width", "align"].includes(name)) throw new Error(`unknown verify plan option: --${name.replaceAll("_", "-")}`);
  for (const name of [...required, ...(flags.extra_phases === undefined ? [] : ["extra_phases"])]) if (typeof flags[name] !== "string" || !flags[name].trim()) throw new Error(`--${name.replaceAll("_", "-")} requires a value`);
  const plan = await buildPlan({ ...flags, extraPhases: flags.extra_phases });
  await writePlan(plan, flags.out);
  if (flags.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(`Wrote ${flags.out}: ${plan.phases.length} phases, ${plan.withheld.length} withheld, ${plan.unmapped.length} unmapped, ${plan.ignored.length} ignored.`);
}
