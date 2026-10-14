import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkCatalogueCommands, loadCatalogue, resolveCatalogueEntry } from "../catalogue.mjs";
import { quoteShell } from "../commands.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const id = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const key = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const keyValue = /^[a-zA-Z0-9._:/@-]+$/;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function loadDefinition(path, options = {}) {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  const definition = JSON.parse(bytes);
  const catalogue = options.catalogue ?? (await loadCatalogue("openclaw")).catalogue;
  const traits = validateDefinition(definition, catalogue);
  return { definition, traits, path: absolute, sha256: sha256(bytes) };
}

export function validateDefinition(definition, catalogue) {
  if (!object(definition) || definition.schema !== "kova.verify.persona.v1" || !id.test(definition.id ?? "") || !text(definition.title) || !text(definition.objective)) throw new Error("invalid persona definition");
  if (!object(definition.runtime) || !/^npm:\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(definition.runtime.selector ?? "") || !text(definition.runtime.policy)) throw new Error("persona runtime must pin an exact npm version and describe its policy");
  if (!Array.isArray(definition.credentials) || definition.credentials.length) throw new Error("persona builds currently require an empty credentials list; use the local mock provider and conformance channel");
  if (!Array.isArray(definition.traits) || !definition.traits.length) throw new Error("persona traits must be a nonempty array");
  const byId = new Map();
  const commands = [];
  for (const trait of definition.traits) {
    if (!object(trait) || !id.test(trait.id ?? "") || byId.has(trait.id)) throw new Error("persona trait ids must be unique lower-case hyphenated names");
    if (!text(trait.content) || !object(trait.keys) || Object.entries(trait.keys).some(([name, description]) => !key.test(name) || !text(description))) throw new Error(`trait ${trait.id}: invalid content or keys`);
    if (!Array.isArray(trait.needs) || trait.needs.some((name) => !id.test(name)) || new Set(trait.needs).size !== trait.needs.length || !Array.isArray(trait.builder) || !trait.builder.length || !text(trait.check)) throw new Error(`trait ${trait.id}: invalid needs, builder or check`);
    byId.set(trait.id, trait);
    for (const command of [...trait.builder, trait.check]) commands.push({ command, source: definition.id, at: trait.id });
  }
  const findings = checkCatalogueCommands(catalogue, commands);
  if (findings.length) throw new Error(`persona commands: ${findings.map((f) => `${f.at}: ${f.message}`).join("; ")}`);
  for (const trait of definition.traits) {
    if (resolveCatalogueEntry(catalogue, trait.check)?.side !== "read") throw new Error(`trait ${trait.id}: check must use a read command`);
    for (const name of trait.needs) if (!byId.has(name)) throw new Error(`trait ${trait.id}: missing dependency ${name}`);
    for (const command of [...trait.builder, trait.check]) {
      for (const [, dependency, name] of command.matchAll(/\{persona:([^:}]+):([^}]+)\}/g)) {
        if (!trait.needs.includes(dependency) || !Object.hasOwn(byId.get(dependency)?.keys ?? {}, name)) throw new Error(`trait ${trait.id}: unresolved dependency key ${dependency}:${name}`);
      }
    }
  }
  const ordered = [], active = new Set(), visited = new Set();
  function visit(trait) {
    if (active.has(trait.id)) throw new Error(`trait ${trait.id}: dependency cycle`);
    if (visited.has(trait.id)) return;
    active.add(trait.id);
    for (const name of trait.needs) visit(byId.get(name));
    active.delete(trait.id);
    visited.add(trait.id);
    ordered.push(trait);
  }
  definition.traits.forEach(visit);
  return ordered;
}

export function resolveCommand(command, context) {
  return command.replace(/\{(env|kovaRoot|run|persona:([^:}]+):([^}]+))\}/g, (_, name, trait, key) => {
    if (trait) {
      const value = context.traits[trait]?.keys?.[key];
      if (typeof value !== "string" || !keyValue.test(value)) throw new Error(`unresolved persona key ${trait}:${key}`);
      return value;
    }
    return quoteShell(context[name]);
  });
}

export function readKeys(trait, stdout) {
  let values;
  try { values = JSON.parse(stdout); } catch { throw new Error(`trait ${trait.id}: check must print one JSON object`); }
  if (!object(values) || Object.keys(values).length !== Object.keys(trait.keys).length || Object.keys(trait.keys).some((key) => typeof values[key] !== "string" || !keyValue.test(values[key]))) throw new Error(`trait ${trait.id}: check keys must match the definition and contain only letters, digits and . _ - : / @`);
  return values;
}
