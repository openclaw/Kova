import { lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { artifactsDir } from "../paths.mjs";
import { createCatalogueResolver, parseCatalogueCommand, validateCatalogue } from "../catalogue.mjs";
import { canonicalJSON, sha256, validateRuntimeStateIds } from "./plan.mjs";
import { checkpointDamage, checkpointRows, createLogCorrelationNormalizer, readBytes, readJSON, parseRecordedJSON, recordedDirectory, stateFile } from "./rows.mjs";
import { readDeclaredIds, normalizeDeclaredIds } from "./normalize.mjs";
import { personaExistingIds } from "./ids.mjs";
import { compareItems, noiseFloor, verdictFor } from "./classify.mjs";
import { validateBuildIds } from "./build-ids.mjs";
import { createFindings } from "./findings.mjs";
import { verdictChunks } from "./verdict-output.mjs";

const names = ["baseline", "change-1", "change-2", "noise-1", "noise-2"];
const qualified = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

async function inputs(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) throw new Error("recorded run must be a directory, not a symbolic link");
  const run = await readJSON(join(directory, "run.json"));
  const bytes = await readBytes(join(directory, "plan.json"));
  const plan = parseRecordedJSON(bytes);
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
  validateBuildIds(standard.buildIds);
  for (const declaration of [...standard.stateIds, ...standard.compressed]) {
    if (!object(declaration) || !["path", "table", "column"].every((key) => typeof declaration[key] === "string" && declaration[key]) || standard.stateIds.includes(declaration) && (typeof declaration.recordKey !== "string" || declaration.order !== undefined && typeof declaration.order !== "string")) throw new Error("invalid recorded state declaration");
  }
  validateRuntimeStateIds(standard.stateIds);
  const errors = validateCatalogue(catalogue);
  if (errors.length) throw new Error(`invalid recorded catalogue: ${errors[0].message}`);
  return { run, plan, standard, catalogue };
}

async function targetRuntime(directory, run, plan, name, damagedPhases) {
  const side = name.startsWith("change") ? "change" : "baseline";
  if (run.targets[side].runtime !== undefined) {
    if (typeof run.targets[side].runtime !== "string" || !run.targets[side].runtime) throw new Error("invalid recorded target runtime");
    return run.targets[side].runtime;
  }
  // Cached copies retain their original resolved binding command. No new
  // baseline runtime is built or named in the later run's target metadata.
  if (!run.clones[name].cached) return null;
  if (damagedPhases.has("standard/use-target")) return null;
  const phase = plan.phases.find((phase) => phase.id === "standard/use-target");
  if (!phase) throw new Error("cached copy lacks its target binding phase");
  const planned = parseCatalogueCommand(phase.commands[0], { standard: true }).tokens;
  const commands = await readJSON(join(directory, name, "checkpoints", phase.id, "commands.json"));
  const resolved = parseCatalogueCommand(commands[0]?.command, { standard: true }).tokens;
  const at = resolved.indexOf("--runtime");
  if (planned[planned.indexOf("--runtime") + 1] !== "{target}" || resolved[0] !== "ocm" || resolved[1] !== "start" || at < 0 || !resolved[at + 1]) throw new Error("invalid cached target binding command");
  return resolved[at + 1];
}

async function copyBindings(directory, run, plan, name) {
  const environment = run.clones[name].env;
  if (environment === undefined) return (value) => value;
  const validEnvironment = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
  if (!validEnvironment(environment)) throw new Error("invalid recorded environment binding");
  const bindings = new Map([[environment, "<env:0>"]]);
  for (const phase of plan.phases.filter((phase) => ["standard/use-target", "standard/start-gateway"].includes(phase.id))) {
    const checkpoint = join(directory, name, "checkpoints", phase.id);
    if (!await recordedDirectory(checkpoint)) continue;
    let commands;
    try { commands = await readJSON(join(checkpoint, "commands.json")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const [index, command] of commands.entries()) {
      const bindingIndex = Math.floor(index / phase.commands.length);
      const planned = parseCatalogueCommand(phase.commands[index % phase.commands.length], { standard: true }).tokens;
      const tokens = parseCatalogueCommand(command.command, { standard: true }).tokens;
      if (phase.id === "standard/use-target" && planned[0] === "ocm" && planned[1] === "start" && planned[2] === "{env}" && validEnvironment(tokens[2])) {
        if (!index && tokens[2] !== environment) throw new Error("recorded environment does not match its target binding");
        bindings.set(tokens[2], `<env:${bindingIndex}>`);
      }
      if (phase.id === "standard/start-gateway" && planned[planned.indexOf("--handle") + 1] === "{run}/gateway.json") {
        const handle = tokens[tokens.indexOf("--handle") + 1];
        if (typeof handle === "string" && /^(?:\/|[a-z]:[\\/]).*[\\/]gateway\.json$/i.test(handle)) bindings.set(handle.slice(0, -"/gateway.json".length), `<run:${bindingIndex}>`);
      }
    }
  }
  const pattern = new RegExp(`(?<![a-zA-Z0-9_.-])(?:${[...bindings.keys()].sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-zA-Z0-9_.-])`, "g");
  return (value) => value.replace(pattern, (binding) => bindings.get(binding));
}

async function observationBindings(directory, standard) {
  // Initial state records the clone's allocated endpoints before the target
  // phases. Only those exact bindings may normalize later runtime metadata.
  try {
    for await (const file of stateFile(join(directory, "initial-state", "openclaw.json"), "openclaw.json", standard)) {
      if (file.kind !== "json" || !object(file.value)) continue;
      const gatewayPort = file.value.gateway?.port;
      const providers = file.value.models?.providers;
      return {
        gatewayPort: Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort <= 65535 ? gatewayPort : undefined,
        providerBaseUrls: object(providers) ? Object.fromEntries(Object.entries(providers).filter(([, value]) => typeof value?.baseUrl === "string").map(([name, value]) => [name, value.baseUrl])) : {}
      };
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return {};
}

export async function compareRecordedRun(directory, { signal, noiseItems = [], writeNoise } = {}) {
  signal?.throwIfAborted();
  const { run, plan, standard, catalogue } = await inputs(directory);
  const damaged = [];
  const identities = {};
  for (const name of names) {
    signal?.throwIfAborted();
    await recordedDirectory(join(directory, name));
    await recordedDirectory(join(directory, name, "checkpoints"));
    for (const source of new Set(plan.phases.map((phase) => phase.id.split("/")[0]))) await recordedDirectory(join(directory, name, "checkpoints", source));
    if (run.clones[name].started) {
      const initial = await lstat(join(directory, name, "initial-state"));
      if (!initial.isDirectory()) throw new Error(`${name}: missing initial state`);
    }
    for (const phase of plan.phases) {
      const damage = await checkpointDamage(join(directory, name, "checkpoints", phase.id), phase, { signal });
      damaged.push(...damage.map((item) => ({ copy: name, phase: phase.id, ...item })));
    }
  }
  const damagedPhases = new Set(damaged.map((item) => item.phase));
  const readablePlan = { ...plan, phases: plan.phases.filter((phase) => !damagedPhases.has(phase.id)) };
  for (const name of names) {
    signal?.throwIfAborted();
    identities[name] = await readDeclaredIds(join(directory, name), readablePlan.phases, standard, catalogue);
  }
  const existing = Object.values(identities).some((value) => value.recorded)
    ? await personaExistingIds(directory, run.personaExports, new Set(Object.values(identities).flatMap((value) => [...value.allIds])), standard, { signal })
    : new Set();
  signal?.throwIfAborted();
  const normalize = {}, findingIds = new Set(), undeclared = new Set();
  for (const name of names) {
    const ids = normalizeDeclaredIds(identities[name], existing);
    for (const address of ids.undeclared) undeclared.add(`${name}/${address}`);
    for (const id of ids.findingIds()) findingIds.add(id);
    delete identities[name];
    const runtime = await targetRuntime(directory, run, readablePlan, name, damagedPhases);
    const bindings = await copyBindings(directory, run, readablePlan, name);
    const text = (value, report, identify = ids.text) => {
      const identified = identify(value);
      if (identified !== value) report?.("declaredIds", "declared generated identity", value, identified);
      const bound = bindings(runtime ? identified.replaceAll(runtime, "<runtime:target>") : identified);
      if (bound !== identified) report?.("pathRoots", "recorded environment, runtime or run location", identified, bound);
      return bound;
    };
    normalize[name] = { ...ids, text, logText: (value, report) => text(value, report, ids.logText), correlations: createLogCorrelationNormalizer(), findingId: (id) => findingIds.add(id), observationBindings: await observationBindings(join(directory, name), standard) };
  }
  const rows = [], incomplete = new Set(run.incomplete ?? []);
  const notStarted = names.filter((name) => !run.clones[name].started);
  const notExercised = [];
  // Per-copy incomplete lists are recorded when a command exits 2, even if
  // capturing that checkpoint subsequently fails. The run-wide list also
  // includes missing checkpoints and cannot make that distinction.
  let noiseExcluded = 0, exitTwo = names.some((name) => run.clones[name].incomplete?.length > 0);
  const dropped = [];
  const resolveEntry = createCatalogueResolver(catalogue);
  for (const phase of plan.phases) {
    signal?.throwIfAborted();
    const copies = {}, sharedItems = new Map();
    const counts = { phase: phase.id, declaredIds: 0, pathRoots: 0, noiseClones: 0, measurements: 0, logLevel: 0, derived: 0 };
    if (damagedPhases.has(phase.id)) {
      for (const copy of notStarted) notExercised.push({ copy, phase: phase.id, command: null, exit: null, reason: "copy did not start" });
      dropped.push(counts); continue;
    }
    const seen = new Map();
    const audit = (copy, item) => {
      const record = { phase: phase.id, copy, ...item };
      const serialized = canonicalJSON(record), key = sha256(serialized);
      const bucket = seen.get(key);
      if (bucket?.some((previous) => canonicalJSON(previous) === serialized)) return;
      if (bucket) bucket.push(record);
      else seen.set(key, [record]);
      counts[item.category]++;
      noiseItems.push(record);
    };
    const commandCount = phase.commands.length * (["standard/use-target", "standard/start-gateway", "standard/stop-gateway"].includes(phase.id) ? run.personaExports?.length ?? 1 : 1);
    const commandEntries = phase.commands.map((command) => resolveEntry(command, { standard: phase.from === "standard" }));
    for (const name of names) {
      signal?.throwIfAborted();
      copies[name] = await checkpointRows(join(directory, name, "checkpoints", phase.id), phase, standard, normalize[name], commandCount, commandEntries, (item) => audit(name, item), sharedItems);
      if (copies[name].exitTwo) { exitTwo = true; incomplete.add(phase.id); }
      if (run.clones[name].incomplete?.includes(phase.id) || run.clones[name].captureErrors?.[phase.id]) incomplete.add(phase.id);
      const failures = run.clones[name].started ? copies[name].notExercised : copies[name].commandFailures;
      if (failures.length) {
        for (const command of failures) notExercised.push({ copy: name, phase: phase.id, ...command });
      } else if (run.clones[name].incomplete?.includes(phase.id)) {
        notExercised.push({ copy: name, phase: phase.id, command: null, exit: 2, reason: "command exited 2; command recording unavailable" });
      } else if (!run.clones[name].started) {
        notExercised.push({ copy: name, phase: phase.id, command: null, exit: null, reason: "copy did not start" });
      } else if (!copies[name].recorded) {
        notExercised.push({ copy: name, phase: phase.id, command: null, exit: null, reason: run.clones[name].captureErrors?.[phase.id] ?? "checkpoint not recorded" });
      }
      // Records include the copy name, so no later copy can duplicate them.
      seen.clear();
      if (writeNoise) { await writeNoise(noiseItems); noiseItems.length = 0; }
    }
    sharedItems.clear();
    if (!copies["noise-1"].recorded || !copies["noise-2"].recorded || !copies.baseline.recorded && (!copies["change-1"].recorded || !copies["change-2"].recorded)) incomplete.add(phase.id);
    const noise = noiseFloor(copies["noise-1"].items, copies["noise-2"].items);
    for (const pattern of noise.patterns) undeclared.add(`${phase.id}/${pattern.signal}/${[...pattern.prefix, "*"].join("/")}`);
    const compared = compareItems({ phase: phase.id, baseline: copies.baseline.items, changes: [copies["change-1"].items, copies["change-2"].items], noise, expects: plan.intent.expects });
    for (const row of compared.rows) rows.push(row);
    noiseExcluded += compared.noiseExcluded;
    counts.noiseClones = compared.excluded.length;
    for (const item of compared.excluded) noiseItems.push(item);
    if (writeNoise) { await writeNoise(noiseItems); noiseItems.length = 0; }
    dropped.push(counts);
  }
  for (const phase of incomplete) if (!notExercised.some(item => item.phase === phase)) {
    notExercised.push({ copy: null, phase, command: null, exit: null, reason: "phase marked incomplete; copy and command evidence unavailable" });
  }
  const issues = rows.filter((row) => row.class === "not-caused").map((row) => ({
    phase: row.phase, signal: row.signal, at: row.at,
    summary: `${row.signal === "commands" ? `Command ${row.at.split("/")[0]} exited ${JSON.stringify(row.baseline)}` : row.signal === "timing" ? `Command ${row.at} reached its bound` : row.at}, recorded on both sides`
  }));
  const grouped = createFindings({ identities: findingIds });
  for (const row of rows) grouped.add(row);
  const result = {
    schema: "kova.verify.v1", change: plan.change, persona: { id: plan.persona.id, version: plan.persona.version },
    verdict: verdictFor({ rows, exitTwo, damaged, notStarted, incomplete: [...incomplete], undeclared: [...undeclared] }), findings: grouped.finish(), rows, issues,
    intent: { goal: plan.intent.goal, protected: plan.intent.protected }, notStarted, incomplete: [...incomplete].sort(), notExercised, damaged,
    withheld: plan.withheld, unmapped: plan.unmapped, ignored: plan.ignored, undeclared: [...undeclared].sort(), noiseExcluded, dropped, run: run.id
  };
  signal?.throwIfAborted();
  return result;
}

const singleLine = (value) => String(value).replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
export function renderIssues(verdict) {
  const lines = ["# Findings", ""];
  const findings = verdict.findings ?? [];
  if (findings.length) {
    lines.push("Counts refer to classified rows, grouped across phases. Values are representative; the complete values and phase counts remain in verdict.json.", "",
      "| Class | Signal | Address pattern | Rows | Phases | Representative baseline | Representative change |",
      "| --- | --- | --- | ---: | ---: | --- | --- |");
    const rank = ["break", "flaky", "not-caused", "fixed", "intended"];
    const preview = (value) => { const text = JSON.stringify(value) ?? "undefined"; return singleLine(text.length > 180 ? `${text.slice(0, 177)}…` : text); };
    for (const finding of [...findings].sort((a, b) => rank.indexOf(a.class) - rank.indexOf(b.class) || b.count - a.count)) {
      lines.push(`| ${finding.class} | ${singleLine(finding.signal)} | ${singleLine(finding.pattern)} | ${finding.count} | ${finding.phases.length} | ${preview(finding.representative.baseline)} | ${preview(finding.representative.change)} |`);
    }
  } else lines.push("No findings.");
  lines.push("", "# Shared failures", "");
  if (!verdict.issues.length) lines.push("No shared failures.");
  for (const row of verdict.rows.filter((row) => row.class === "not-caused")) {
    lines.push(`- ${singleLine(row.phase)} — ${singleLine(row.signal)}: ${singleLine(row.at)}; baseline ${singleLine(JSON.stringify(row.baseline))}; ${singleLine(row.clones.join(", "))} ${singleLine(JSON.stringify(row.change))}.`);
  }
  return `${lines.join("\n")}\n`;
}

async function save(path, chunks, signal) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      for await (const chunk of typeof chunks === "string" ? [chunks] : chunks) {
        signal?.throwIfAborted();
        await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function compareVerification({ run }, { home = artifactsDir, signal } = {}) {
  if (typeof run !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(run)) throw new Error("--run requires a recorded run id");
  const directory = join(home, "verify", run);
  const temporary = join(directory, `noise.json.${randomUUID()}.tmp`);
  let file, result, count = 0;
  try {
    signal?.throwIfAborted();
    if (!(await lstat(directory)).isDirectory()) throw new Error("recorded run must be a directory, not a symbolic link");
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`{\n  "schema": "kova.verify.noise.v1",\n  "run": ${JSON.stringify(run)},\n  "items": [`);
    const writeNoise = async (items) => {
      let chunk = "";
      for (const item of items) {
        signal?.throwIfAborted();
        chunk += `${count++ ? "," : ""}\n${JSON.stringify(item, null, 2).replace(/^/gm, "    ")}`;
        if (chunk.length >= 64 * 1024) { await file.writeFile(chunk); chunk = ""; }
      }
      if (chunk) await file.writeFile(chunk);
    };
    result = await compareRecordedRun(directory, { signal, writeNoise });
    signal?.throwIfAborted();
    if (result.run !== run) throw new Error("recorded run id does not match its directory");
    await file.writeFile(`${count ? "\n  " : ""}]\n}\n`);
    await file.close(); file = null;
    signal?.throwIfAborted();
    await rename(temporary, join(directory, "noise.json"));
  } finally {
    try { if (file) await file.close(); }
    finally { await rm(temporary, { force: true }); }
  }
  signal?.throwIfAborted();
  await save(join(directory, "issues.md"), renderIssues(result), signal);
  signal?.throwIfAborted();
  await save(join(directory, "verdict.json"), verdictChunks(result), signal);
  signal?.throwIfAborted();
  return result;
}
