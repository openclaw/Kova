import { readFile } from "node:fs/promises";

// Original supported contracts from 6b2cf00. The product catalogue also declares
// later forms of these entries; those declarations remain pending.
export const originalScriptEntries = JSON.parse(await readFile(new URL("../fixtures/verify/original-script-entries.json", import.meta.url), "utf8"));

// Established helper outputs from b249535 remain supported separately from the
// enlarged pending declarations. This changes test inputs, never the registry.
export const originalHelperEntries = JSON.parse(await readFile(new URL("../fixtures/verify/original-helper-entries.json", import.meta.url), "utf8"));

export function originalScriptCatalogue(catalogue, entries = originalScriptEntries) {
  const originals = new Map(entries.map((entry) => [entry.id, entry]));
  return { ...catalogue, entries: catalogue.entries.map((entry) => structuredClone(originals.get(entry.id) ?? entry)) };
}
