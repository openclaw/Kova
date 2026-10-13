import { loadCatalogue, checkCatalogueInputs } from "../catalogue.mjs";

export async function runCatalogueCommand(flags) {
  const [action, ...extra] = flags._;
  if (!["list", "check"].includes(action) || extra.length) throw new Error("usage: kova catalogue <list|check> --product <name>");
  for (const key of Object.keys(flags)) {
    if (!["_", "product", "json", "plain", ...(action === "check" ? ["templates", "personas"] : [])].includes(key)) throw new Error(`unknown catalogue option: --${key.replaceAll("_", "-")}`);
  }
  const { catalogue, findings } = await loadCatalogue(flags.product);
  if (findings.length) throw new Error(`invalid catalogue: ${findings.map((finding) => `${finding.at}: ${finding.message}`).join("; ")}`);
  if (action === "list") {
    if (flags.json) console.log(JSON.stringify(catalogue, null, 2));
    else for (const entry of catalogue.entries) console.log(`${entry.id} [${entry.kind}, ${entry.side}, ${entry.status}] ${entry.command}`);
    return;
  }
  for (const key of ["templates", "personas"]) if (typeof flags[key] !== "string" || !flags[key].trim()) throw new Error(`--${key} requires a file or directory`);
  const result = await checkCatalogueInputs(catalogue, flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.ok ? "PASS" : "FAIL"}: ${result.commandCount} commands, ${result.findings.length} findings`);
    for (const finding of result.findings) console.log(`${finding.source}${finding.at}: ${finding.code}: ${finding.message}`);
  }
  if (!result.ok) process.exitCode = 1;
}
