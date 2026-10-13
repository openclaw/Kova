import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "../paths.mjs";
import { loadCatalogue } from "../catalogue.mjs";
import { selectPhases } from "./select.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const id = (value) => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const strings = (value) => Array.isArray(value) && value.every(text);
const fail = (where, message) => { throw new Error(`${where}: ${message}`); };
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fields(value, allowed, where) {
  if (!object(value)) fail(where, "expected an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `unknown field ${key}`);
}

function validatePhase(phase, where, { standard = false, intent = false } = {}) {
  fields(phase, ["id", "intent", "commands", "checkpoint", "timeoutMs", "browser", "slow", ...(standard ? [] : ["kind", "paths", "requires"]), ...(intent ? ["from"] : [])], where);
  if (!id(phase.id)) fail(where, "id must be kebab-case");
  if (!strings(phase.commands) || !phase.commands.length) fail(where, "commands must be a nonempty string array");
  if (!Array.isArray(phase.checkpoint) || !phase.checkpoint.every((signal) => typeof signal === "string" && (/^(responses|logs|timing|doctor|screen)$/.test(signal) || /^state:[^/\\].*/.test(signal) && !signal.slice(6).split(/[\\/]/).includes("..")))) fail(where, "invalid checkpoint");
  if (!Number.isSafeInteger(phase.timeoutMs) || phase.timeoutMs < 1) fail(where, "timeoutMs must be a positive integer");
  if (phase.slow !== undefined && typeof phase.slow !== "boolean") fail(where, "slow must be boolean");
  if (phase.browser !== undefined && typeof phase.browser !== "boolean") fail(where, "browser must be boolean");
  if (!standard) {
    if (!text(phase.intent) || !["setup", "operation", "event"].includes(phase.kind) || !strings(phase.paths) || !strings(phase.requires)) fail(where, "expected intent, kind, paths and requires");
    if (phase.kind === "setup" && phase.slow) fail(where, "setup cannot be slow");
    if (phase.timeoutMs > 300000 && !phase.slow) fail(where, "phase over 300000 ms must be slow");
  }
  if (intent && !["intent:goal", "intent:protected"].includes(phase.from)) fail(where, "from must be intent:goal or intent:protected");
}

export function validateTemplate(template, where = "template") {
  fields(template, ["schema", "id", "title", "objective", "paths", "requires", "support", "phases"], where);
  if (template.schema !== "kova.verify.template.v1" || !id(template.id) || ["standard", "intent"].includes(template.id) || !text(template.title) || !text(template.objective) || !strings(template.paths) || !strings(template.requires) || !Array.isArray(template.phases)) fail(where, "invalid template form");
  fields(template.support, ["existing", "toWrite"], `${where}/support`);
  if (!strings(template.support.existing) || !strings(template.support.toWrite)) fail(where, "invalid support lists");
  const ids = new Set();
  template.phases.forEach((phase, index) => {
    validatePhase(phase, `${where}/phases/${index}`);
    if (ids.has(phase.id)) fail(where, `duplicate phase ${phase.id}`);
    ids.add(phase.id);
  });
  return template;
}

export async function loadTemplates(directory) {
  const templates = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.isDirectory()) templates.push(validateTemplate(await json(join(directory, entry.name, "template.json")), `template:${entry.name}`));
    else if (entry.name.endsWith(".json")) templates.push(validateTemplate(await json(join(directory, entry.name)), entry.name));
    else if (entry.isSymbolicLink()) fail(directory, `template must not be a symbolic link: ${entry.name}`);
  }
  if (new Set(templates.map((template) => template.id)).size !== templates.length) fail(directory, "duplicate template id");
  return templates;
}

export async function loadPlanInputs(root = repoRoot) {
  const standard = await json(join(root, "verify/standard.json"));
  fields(standard, ["schema", "ignore", "compressed", "stateIds", "before", "after"], "standard");
  if (standard.schema !== "kova.verify.standard.v1" || !object(standard.ignore) || !Object.values(standard.ignore).every(strings) || !Array.isArray(standard.compressed) || !Array.isArray(standard.stateIds)) fail("standard", "invalid standard form");
  for (const group of ["before", "after"]) {
    if (!Array.isArray(standard[group])) fail("standard", `expected ${group} phases`);
    standard[group].forEach((phase, i) => validatePhase(phase, `standard/${group}/${i}`, { standard: true }));
  }
  const areas = [];
  for (const entry of (await readdir(join(root, "verify/areas"), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) fail("areas", `expected a JSON file: ${entry.name}`);
    const area = await json(join(root, "verify/areas", entry.name));
    if (area.schema !== "kova.verify.area.v1" || !id(area.id) || !strings(area.paths) || area.bound?.includes && !strings(area.bound.includes)) fail(entry.name, "invalid area form");
    areas.push(area);
  }
  const { catalogue, findings } = await loadCatalogue("openclaw", { root });
  if (findings.length) fail("catalogue", findings.map((finding) => finding.message).join("; "));
  return { standard, templates: await loadTemplates(join(root, "verify/templates")), areas, catalogue };
}

function git(repo, args, { trim = true } = {}) {
  const output = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return trim ? output.trim() : output;
}

function revision(repo, value) {
  if (!text(value) || value.startsWith("-")) fail("revision", "expected a commit reference");
  const sha = git(repo, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("revision", "expected a 40-character commit");
  return sha;
}

export async function buildPlan(options, { root = repoRoot } = {}) {
  const repo = resolve(options.repo);
  const baseline = revision(repo, options.baseline), change = revision(repo, options.change);
  const paths = git(repo, ["diff", "--name-only", "--no-renames", "-z", baseline, change, "--"], { trim: false }).split("\0").filter(Boolean).sort();
  const origin = git(repo, ["remote", "get-url", "origin"]);
  const repository = origin.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
  if (!repository) fail("repository", "origin must identify a GitHub repository without credentials");
  const lines = (await readFile(options.intent, "utf8")).split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 2 || !/^Goal:\s*\S/.test(lines[0]) || !/^Protected:\s*\S/.test(lines[1])) fail("intent", "expected Goal and Protected lines, in that order");
  const manifestPath = resolve(options.persona), manifestBytes = await readFile(manifestPath);
  const persona = JSON.parse(manifestBytes);
  if (persona?.schema !== "kova.verify.persona-manifest.v1" || !id(persona.persona) || !text(persona.version) || !object(persona.traits)) fail("persona", "invalid persona manifest");
  for (const [trait, value] of Object.entries(persona.traits)) {
    if (!id(trait) || !object(value) || !object(value.keys)) fail("persona", `invalid trait ${trait}`);
    for (const [key, data] of Object.entries(value.keys)) if (!/^[a-zA-Z0-9_.-]+$/.test(key) || typeof data !== "string" || !/^[a-zA-Z0-9._:/@-]+$/.test(data)) fail("persona", `unsafe key ${trait}:${key}`);
  }
  const extraPhases = options.extraPhases ? await json(options.extraPhases) : { phases: [], expects: [] };
  fields(extraPhases, ["phases", "expects"], "extra phases");
  if (!Array.isArray(extraPhases.phases) || extraPhases.expects !== undefined && !Array.isArray(extraPhases.expects)) fail("extra phases", "expected phases and expects arrays");
  extraPhases.phases.forEach((phase, i) => validatePhase(phase, `intent/${i}`, { intent: true }));
  const inputs = await loadPlanInputs(root);
  const knownPhases = new Map([
    ...inputs.templates.flatMap((template) => template.phases.map((phase) => [`${template.id}/${phase.id}`, phase])),
    ...[...inputs.standard.before, ...inputs.standard.after].map((phase) => [`standard/${phase.id}`, phase]),
    ...extraPhases.phases.map((phase) => [`intent/${phase.id}`, phase]),
  ]);
  const expects = extraPhases.expects ?? [];
  for (const [i, expected] of expects.entries()) {
    fields(expected, ["phase", "signal", "at", "change"], `expects/${i}`);
    if (!knownPhases.has(expected.phase) || !["checkpoint", "commands", "responses", "logs", "timing", "state", "doctor", "screen"].includes(expected.signal) || typeof expected.at !== "string" || !Object.hasOwn(expected, "change")) fail(`expects/${i}`, "invalid expected difference");
    if (knownPhases.get(expected.phase).from === "intent:protected") fail(`expects/${i}`, "cannot expect a difference from a protected phase");
  }
  const selected = selectPhases({ paths, ...inputs, extraPhases, persona });
  return {
    schema: "kova.verify.plan.v1",
    change: { repo: repository, baseline, change, paths },
    intent: { goal: lines[0].slice(5).trim(), protected: lines[1].slice(10).trim(), expects },
    persona: { id: persona.persona, version: persona.version, manifest: manifestPath, sha256: sha256(manifestBytes) },
    phases: selected.phases, phasesSha256: sha256(canonicalJSON(selected.phases)),
    withheld: selected.withheld, unmapped: selected.unmapped, ignored: selected.ignored,
    ...(options.extraPhases ? { extraPhases: { file: options.extraPhases } } : {}),
  };
}

export async function writePlan(plan, file) {
  const destination = resolve(file);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    created = true;
    await rename(temporary, destination);
  } finally {
    if (created) await rm(temporary, { force: true });
  }
}
