import { lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { artifactsDir } from "../paths.mjs";
import { createCatalogueResolver, validateCatalogue } from "../catalogue.mjs";
import { canonicalJSON, sha256 } from "./plan.mjs";
import { checkpointRows, readBytes, readJSON, recordedDirectory } from "./rows.mjs";
import { readDeclaredIds, normalizeDeclaredIds } from "./normalize.mjs";
import { personaExistingIds } from "./ids.mjs";
import { compareItems, noiseFloor, verdictFor } from "./classify.mjs";

const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
const qualified = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

async function inputs(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) throw new Error("recorded run must be a directory, not a symbolic link");
  const run = await readJSON(join(directory, "run.json"));
  const bytes = await readBytes(join(directory, "plan.json"));
  const plan = JSON.parse(bytes);
  if (run.schema !== "kova.verify.run.v1" || plan.schema !== "kova.verify.plan.v1" || sha256(bytes) !== run.plan?.sha256) throw new Error("recorded plan is missing, invalid, or has changed");
  if (!Array.isArray(plan.phases) || !plan.phases.length || new Set(plan.phases.map((phase) => phase.id)).size !== plan.phases.length || plan.phases.some((phase) => !qualified.test(phase.id) || !Array.isArray(phase.commands) || !phase.commands.length || !Array.isArray(phase.checkpoint) || phase.checkpoint.some((signal) => typeof signal !== "string" || !/^(responses|timing|logs|doctor|screen|state:.+)$/.test(signal)))) throw new Error("recorded plan has invalid phases");
  if (sha256(canonicalJSON(plan.phases)) !== plan.phasesSha256) throw new Error("recorded phase hash does not match");
  for (const side of ["baseline", "change"]) if (!/^[a-f0-9]{40}$/.test(plan.change?.[side]) || run.targets?.[side]?.commit !== plan.change[side]) throw new Error(`recorded ${side} target does not match the plan`);
  if (!object(plan.intent) || typeof plan.intent.goal !== "string" || typeof plan.intent.protected !== "string" || !Array.isArray(plan.intent.expects) || !object(plan.persona) || ![plan.persona.id, plan.persona.version, plan.change.repo].every((value) => typeof value === "string" && value)) throw new Error("invalid recorded intent or persona");
  const predictions = new Set();
  for (const expected of plan.intent.expects) {
    if (!object(expected) || !qualified.test(expected.phase) || !["checkpoint", "commands", "responses", "logs", "timing", "state", "doctor", "screen"].includes(expected.signal) || typeof expected.at !== "string" || !Object.hasOwn(expected, "change")) throw new Error("invalid recorded expected difference");
    if (plan.phases.find((phase) => phase.id === expected.phase)?.from === "intent:protected") throw new Error("cannot expect a difference from a protected phase");
    const key = canonicalJSON([expected.phase, expected.signal, expected.at]);
    if (predictions.has(key)) throw new Error("duplicate expected difference");
    predictions.add(key);
  }
  for (const field of ["withheld", "unmapped", "ignored"]) if (!Array.isArray(plan[field])) throw new Error(`recorded plan has no ${field} list`);
  const validPhases = (value) => Array.isArray(value) && value.every((id) => plan.phases.some((phase) => phase.id === id));
  if (run.incomplete !== undefined && !validPhases(run.incomplete)) throw new Error("invalid incomplete phase list");
  for (const name of names) {
    const copy = run.clones?.[name];
    if (!object(copy) || typeof copy.started !== "boolean" || !object(copy.phases) || copy.incomplete !== undefined && !validPhases(copy.incomplete)) throw new Error(`invalid recorded copy: ${name}`);
  }
  const standard = await readJSON(join(directory, "standard.json"));
  const catalogue = await readJSON(join(directory, "catalogue.json"));
  if (standard.schema !== "kova.verify.standard.v1" || !Array.isArray(standard.stateIds) || !Array.isArray(standard.compressed)) throw new Error("invalid recorded normalization declarations");
  for (const declaration of [...standard.stateIds, ...standard.compressed]) {
    if (!object(declaration) || !["path", "table", "column"].every((key) => typeof declaration[key] === "string" && declaration[key]) || standard.stateIds.includes(declaration) && (typeof declaration.recordKey !== "string" || declaration.order !== undefined && typeof declaration.order !== "string")) throw new Error("invalid recorded state declaration");
  }
  const errors = validateCatalogue(catalogue);
  if (errors.length) throw new Error(`invalid recorded catalogue: ${errors[0].message}`);
  return { run, plan, standard, catalogue };
}

export async function compareRecordedRun(directory) {
  const { run, plan, standard, catalogue } = await inputs(directory);
  const identities = {};
  for (const name of names) {
    await recordedDirectory(join(directory, name));
    await recordedDirectory(join(directory, name, "checkpoints"));
    for (const source of new Set(plan.phases.map((phase) => phase.id.split("/")[0]))) await recordedDirectory(join(directory, name, "checkpoints", source));
    if (run.clones[name].started) {
      const initial = await lstat(join(directory, name, "initial-state"));
      if (!initial.isDirectory()) throw new Error(`${name}: missing initial state`);
    }
    identities[name] = await readDeclaredIds(join(directory, name), plan.phases, standard, catalogue);
  }
  const existing = Object.values(identities).some((value) => value.recorded)
    ? await personaExistingIds(directory, run.personaExports, new Set(Object.values(identities).flatMap((value) => [...value.allIds])), standard)
    : new Set();
  const normalize = Object.fromEntries(names.map((name) => [name, normalizeDeclaredIds(identities[name], existing)]));
  const rows = [], undeclared = new Set(), incomplete = new Set(run.incomplete ?? []);
  const notStarted = names.filter((name) => !run.clones[name].started);
  // Per-copy incomplete lists are recorded when a command exits 2, even if
  // capturing that checkpoint subsequently fails. The run-wide list also
  // includes missing checkpoints and cannot make that distinction.
  let noiseExcluded = 0, exitTwo = names.some((name) => run.clones[name].incomplete?.length > 0);
  const resolveEntry = createCatalogueResolver(catalogue);
  for (const phase of plan.phases) {
    const copies = {};
    const commandCount = phase.commands.length * (["standard/use-target", "standard/start-gateway", "standard/stop-gateway"].includes(phase.id) ? run.personaExports?.length ?? 1 : 1);
    const commandEntries = phase.commands.map((command) => resolveEntry(command, { standard: phase.from === "standard" }).id);
    for (const name of names) {
      copies[name] = await checkpointRows(join(directory, name, "checkpoints", phase.id), phase, standard, normalize[name], commandCount, commandEntries);
      if (copies[name].exitTwo) { exitTwo = true; incomplete.add(phase.id); }
      if (run.clones[name].incomplete?.includes(phase.id) || run.clones[name].captureErrors?.[phase.id]) incomplete.add(phase.id);
    }
    if (!copies["noise-1"].recorded || !copies["noise-2"].recorded || !copies.baseline.recorded && (!copies["change-1"].recorded || !copies["change-2"].recorded)) incomplete.add(phase.id);
    const noise = noiseFloor(copies["noise-1"].items, copies["noise-2"].items);
    for (const pattern of noise.patterns) undeclared.add(`${phase.id}/${pattern.signal}/${[...pattern.prefix, "*"].join("/")}`);
    const compared = compareItems({ phase: phase.id, baseline: copies.baseline.items, changes: [copies["change-1"].items, copies["change-2"].items], noise, expects: plan.intent.expects });
    rows.push(...compared.rows);
    noiseExcluded += compared.noiseExcluded;
  }
  const issues = rows.filter((row) => row.class === "not-caused").map((row) => ({
    phase: row.phase, signal: row.signal, at: row.at,
    summary: `${row.signal === "commands" ? `Command ${row.at.split("/")[0]} exited ${JSON.stringify(row.baseline)}` : row.signal === "timing" ? `Command ${row.at} reached its bound` : row.at}, recorded on both sides`
  }));
  const result = {
    schema: "kova.verify.v1", change: plan.change, persona: { id: plan.persona.id, version: plan.persona.version },
    verdict: verdictFor({ rows, exitTwo, notStarted, incomplete: [...incomplete], undeclared: [...undeclared] }), rows, issues,
    intent: { goal: plan.intent.goal, protected: plan.intent.protected }, notStarted, incomplete: [...incomplete].sort(),
    withheld: plan.withheld, unmapped: plan.unmapped, ignored: plan.ignored, undeclared: [...undeclared].sort(), noiseExcluded, run: run.id
  };
  return result;
}

const singleLine = (value) => String(value).replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
export function renderIssues(verdict) {
  const lines = ["# Shared failures", ""];
  if (!verdict.issues.length) lines.push("No shared failures.");
  for (const row of verdict.rows.filter((row) => row.class === "not-caused")) {
    lines.push(`- ${singleLine(row.phase)} — ${singleLine(row.signal)}: ${singleLine(row.at)}; baseline ${singleLine(JSON.stringify(row.baseline))}; ${singleLine(row.clones.join(", "))} ${singleLine(JSON.stringify(row.change))}.`);
  }
  return `${lines.join("\n")}\n`;
}

async function save(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function compareVerification({ run }, { home = artifactsDir } = {}) {
  if (typeof run !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(run)) throw new Error("--run requires a recorded run id");
  const directory = join(home, "verify", run);
  const result = await compareRecordedRun(directory);
  if (result.run !== run) throw new Error("recorded run id does not match its directory");
  await save(join(directory, "issues.md"), renderIssues(result));
  await save(join(directory, "verdict.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
