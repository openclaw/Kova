import { buildPersona, readManifest, verifyPersona } from "../persona/lifecycle.mjs";

export async function runPersonaCommand(flags) {
  const [action, ...extra] = flags._;
  const required = action === "build" ? ["definition", "out"] : ["persona"];
  const allowed = [...required, ...(action === "build" ? ["execute"] : []), ...(action === "show" ? [] : ["env_prefix"])];
  if (!["build", "verify", "show"].includes(action) || extra.length) throw new Error("usage: kova persona <build|verify|show>");
  for (const name of Object.keys(flags)) if (!["_", "json", "plain", "ascii", "no_progress", "color", "width", "align", ...allowed].includes(name)) throw new Error(`unknown persona option: --${name.replaceAll("_", "-")}`);
  for (const name of required) if (typeof flags[name] !== "string" || !flags[name].trim()) throw new Error(`--${name} requires a path`);
  if (flags.env_prefix !== undefined && (typeof flags.env_prefix !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(flags.env_prefix))) throw new Error("--env-prefix requires a short lower-case name");
  const options = { envPrefix: flags.env_prefix };
  const result = action === "build" ? await buildPersona(flags.definition, flags.out, { ...options, executeBuild: flags.execute === true })
    : action === "verify" ? await verifyPersona(flags.persona, options) : await readManifest(flags.persona);
  if (flags.json || action === "show") console.log(JSON.stringify(result, null, 2));
  else if (action === "build" && !flags.execute) {
    console.log(`DRY-RUN: build ${result.persona} on ${result.runtime} into ${result.out}`);
    for (const trait of result.traits) console.log(`${trait.id}\n  build: ${trait.builder.join("\n  build: ")}\n  check: ${trait.check}`);
  } else console.log(`PASS: ${result.persona} ${result.version}${result.env ? ` (${result.env.name})` : ""}`);
  if (!flags.json && action !== "show") {
    for (const [id, withheld] of Object.entries(result.withheldTraits ?? {})) console.log(`WITHHELD ${id}: ${withheld.reason}`);
  }
}
