import { buildPersona, readManifest, verifyPersona } from "../persona/lifecycle.mjs";

export async function runPersonaCommand(flags) {
  const [action, ...extra] = flags._;
  const allowed = action === "build" ? ["definition", "out", "execute"] : ["persona"];
  if (!["build", "verify", "show"].includes(action) || extra.length) throw new Error("usage: kova persona <build|verify|show>");
  for (const name of Object.keys(flags)) if (!["_", "json", "plain", "ascii", "no_progress", "color", "width", "align", ...allowed].includes(name)) throw new Error(`unknown persona option: --${name.replaceAll("_", "-")}`);
  for (const name of allowed.filter((name) => name !== "execute")) if (typeof flags[name] !== "string" || !flags[name].trim()) throw new Error(`--${name} requires a path`);
  const result = action === "build" ? await buildPersona(flags.definition, flags.out, { executeBuild: flags.execute === true })
    : action === "verify" ? await verifyPersona(flags.persona) : await readManifest(flags.persona);
  if (flags.json || action === "show") console.log(JSON.stringify(result, null, 2));
  else if (action === "build" && !flags.execute) {
    console.log(`DRY-RUN: build ${result.persona} on ${result.runtime} into ${result.out}`);
    for (const trait of result.traits) console.log(`${trait.id}\n  build: ${trait.builder.join("\n  build: ")}\n  check: ${trait.check}`);
  } else console.log(`PASS: ${result.persona} ${result.version}${result.env ? ` (${result.env.name})` : ""}`);
}
