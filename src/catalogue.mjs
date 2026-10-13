import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./paths.mjs";

const entryFields = ["id", "kind", "wraps", "command", "flags", "prints", "creates", "side", "background", "status"];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const flagPattern = /^--[a-z][a-z0-9-]*$|^-[a-zA-Z]$/;
const pointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/;

// Parse the restricted shell form without expanding or executing anything.
export function parseCatalogueCommand(command, { form = false, standard = false } = {}) {
  const tokens = [];
  const findings = [];
  if (!text(command)) return { tokens, findings: [{ code: "command", message: "command must be a nonempty string" }] };
  let quote = null;
  let value = "";
  let started = false;
  const finish = () => {
    if (started) tokens.push(value);
    value = "";
    started = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== "'" && /[$`;|&<>\r\n]/.test(char)) {
      const slot = form && char === "<" ? command.slice(index).match(/^<[^<>\r\n]+>/)?.[0] : null;
      if (slot) {
        value += slot;
        started = true;
        index += slot.length - 1;
        continue;
      }
      findings.push({ code: "shell", message: `shell metacharacter ${JSON.stringify(char)} outside single quotes`, offset: index });
    }
    if (char === "{") {
      const match = command.slice(index).match(/^\{([^{}]+)\}/);
      if (match && !/^\s*["']/.test(match[1])) {
        const name = match[1];
        const persona = /^persona:[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+$/.test(name);
        const fixed = ["env", "kovaRoot", "run"].includes(name) || (name === "target" && standard);
        if (!persona && !fixed) findings.push({ code: "placeholder", message: `unsupported placeholder ${match[0]}`, offset: index });
        else if (fixed && quote) findings.push({ code: "placeholder", message: `${match[0]} must appear outside quotes`, offset: index });
      }
    }
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next === undefined) findings.push({ code: "syntax", message: "unfinished escape", offset: index });
      else if (/[$`;|&<>\r\n{]/.test(next)) {
        // Still examine protected characters on the next iteration.
        value += char;
      } else if (!quote || /["\\]/.test(next)) {
        value += next;
        index += 1;
      } else value += char;
      started = true;
    } else if (char === quote) {
      quote = null;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      started = true;
    } else if (!quote && /\s/.test(char)) {
      finish();
    } else {
      value += char;
      started = true;
    }
  }
  finish();
  if (quote) findings.push({ code: "syntax", message: "unterminated quote" });
  return { tokens, findings };
}

function headWords(tokens) {
  const forwarded = tokens[0] === "ocm" && tokens[1] === "@{env}" && tokens[2] === "--";
  const words = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokens[index];
    if ((word.startsWith("-") && !(forwarded && index === 2)) || word.includes("<") || /^\{(?:env|run|target|persona:.*)\}$/.test(word)) break;
    words.push(word);
  }
  return words;
}

function gatewayMethod(tokens) {
  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "--method") values.push(tokens[index + 1]);
    else if (tokens[index].startsWith("--method=")) values.push(tokens[index].slice(9));
  }
  return values.length === 1 && /^[a-zA-Z][a-zA-Z0-9.]*$/.test(values[0]) ? values[0] : null;
}

export function catalogueCommandHead(command, { kind } = {}) {
  const { tokens } = parseCatalogueCommand(command, { form: true, standard: true });
  const head = headWords(tokens).join(" ");
  return kind === "gateway" ? `${head} --method ${gatewayMethod(tokens) ?? "<missing>"}` : head;
}

export function validateCatalogue(catalogue) {
  const findings = [];
  const add = (at, message, code = "catalogue") => findings.push({ code, at, message });
  if (!isObject(catalogue) || catalogue.schema !== "kova.verify.catalogue.v1" || !text(catalogue.product) || !idPattern.test(catalogue.product ?? "") || !text(catalogue.revision) || !Array.isArray(catalogue.entries)) {
    add("", "expected a kova.verify.catalogue.v1 object with product, revision and entries");
    return findings;
  }
  for (const key of Object.keys(catalogue)) if (!["schema", "product", "revision", "entries"].includes(key)) add(`/${key}`, "unknown catalogue field");
  const ids = new Map();
  const heads = new Map();
  const operations = new Map();
  for (const [index, entry] of catalogue.entries.entries()) {
    const at = `/entries/${index}`;
    if (!isObject(entry)) { add(at, "entry must be an object"); continue; }
    for (const field of entryFields) if (!Object.hasOwn(entry, field)) add(`${at}/${field}`, "required field is missing");
    for (const field of Object.keys(entry)) if (!entryFields.includes(field)) add(`${at}/${field}`, "unknown entry field");
    if (!text(entry.id) || !idPattern.test(entry.id)) add(`${at}/id`, "expected a kebab-case id");
    if (!["product", "gateway", "script", "ocm"].includes(entry.kind)) add(`${at}/kind`, "invalid kind");
    if (!text(entry.wraps)) add(`${at}/wraps`, "expected the operation this entry performs");
    if (!["read", "write", "destructive"].includes(entry.side)) add(`${at}/side`, "invalid side");
    if (!["existing", "toWrite"].includes(entry.status)) add(`${at}/status`, "invalid status");
    if (typeof entry.background !== "boolean") add(`${at}/background`, "expected a boolean");
    for (const field of ["prints", "creates"]) {
      if (!Array.isArray(entry[field]) || !entry[field].every((value) => field === "creates" ? typeof value === "string" : text(value)) || new Set(entry[field]).size !== entry[field].length) add(`${at}/${field}`, "expected distinct strings");
    }
    if (Array.isArray(entry.creates)) for (const pointer of entry.creates) if (typeof pointer !== "string" || !pointerPattern.test(pointer)) add(`${at}/creates`, `invalid JSON pointer: ${JSON.stringify(pointer)}`);
    if (!isObject(entry.flags) || !Object.entries(entry.flags).every(([flag, meaning]) => flagPattern.test(flag) && text(meaning))) add(`${at}/flags`, "expected flag names and nonempty meanings");
    const parsed = parseCatalogueCommand(entry.command, { form: true, standard: true });
    for (const finding of parsed.findings) add(`${at}/command`, finding.message);
    if (entry.kind === "gateway" && (!gatewayMethod(parsed.tokens) || gatewayMethod(parsed.tokens) !== entry.wraps)) add(`${at}/command`, "Gateway command must name exactly its wraps method");
    if (entry.kind === "product" && parsed.tokens.slice(0, 3).join(" ") !== "ocm @{env} --") add(`${at}/command`, "product command must begin with ocm @{env} --");
    if (entry.kind === "script" && (parsed.tokens[0] !== "node" || !parsed.tokens[1]?.startsWith("{kovaRoot}/support/"))) add(`${at}/command`, "script command must name a Kova support script");
    const head = catalogueCommandHead(entry.command, entry);
    if (!head) add(`${at}/command`, "command has no fixed head");
    for (const [map, key, label] of [[ids, entry.id, "id"], [heads, head, "command head"], [operations, entry.wraps?.trim(), "operation"]]) {
      if (map.has(key)) add(at, `duplicate ${label} with ${map.get(key)}: ${key}`, "duplicate");
      else map.set(key, entry.id);
    }
    for (const flag of commandFlags(parsed.tokens)) if (isObject(entry.flags) && !Object.hasOwn(entry.flags, flag)) add(`${at}/flags`, `command form uses unlisted flag ${flag}`);
  }
  return findings;
}

export async function loadCatalogue(product, { root = repoRoot } = {}) {
  if (!text(product) || !idPattern.test(product)) throw new Error("--product must be a kebab-case name");
  const catalogue = JSON.parse(await readFile(join(root, "catalogue", `${product}.json`), "utf8"));
  const findings = validateCatalogue(catalogue);
  if (catalogue.product !== product) findings.push({ code: "catalogue", at: "/product", message: "product does not match the requested catalogue" });
  return { catalogue, findings };
}

function commandFlags(tokens) {
  return tokens.filter((token) => token.startsWith("-") && token !== "--" && !/^-[0-9]/.test(token)).map((token) => token.split("=", 1)[0]);
}

function catalogueResolver(catalogue) {
  const forms = catalogue.entries.map((entry) => {
    const form = parseCatalogueCommand(entry.command, { form: true, standard: true }).tokens;
    const head = headWords(form);
    return { entry, head, positional: /<|^\{/.test(form[head.length] ?? ""), method: gatewayMethod(form) };
  });
  return (tokens) => {
    const words = headWords(tokens);
    const candidates = forms.filter(({ entry, head, positional, method }) => {
      if (head.length === 0 || !head.every((word, index) => tokens[index] === word)) return false;
      if (words.length > head.length && !positional) return false;
      return entry.kind !== "gateway" || gatewayMethod(tokens) === method;
    });
    const longest = Math.max(0, ...candidates.map(({ head }) => head.length));
    const matches = candidates.filter(({ head }) => head.length === longest);
    return matches.length === 1 ? matches[0].entry : null;
  };
}

export function resolveCatalogueEntry(catalogue, command) {
  return catalogueResolver(catalogue)(parseCatalogueCommand(command).tokens);
}

// Shared with callers that already have phase commands, including standard phases.
export function checkCatalogueCommands(catalogue, commands) {
  const findings = validateCatalogue(catalogue);
  if (findings.length) return findings;
  const resolve = catalogueResolver(catalogue);
  for (const item of commands) {
    const { command, source, at, standard = false } = item;
    const add = (finding) => findings.push({ source, at, command, ...finding });
    const parsed = parseCatalogueCommand(command, { standard });
    parsed.findings.forEach(add);
    if (!text(command)) continue;
    const entry = resolve(parsed.tokens);
    if (!entry) { add({ code: "unlisted-command", message: "command has no unique catalogue entry" }); continue; }
    for (const flag of commandFlags(parsed.tokens)) {
      if (!Object.hasOwn(entry.flags, flag)) add({ code: "unlisted-flag", entryId: entry.id, flag, message: `unlisted flag ${flag}` });
    }
    if (entry.status === "toWrite") add({ code: "toWrite", entryId: entry.id, message: "entry is not implemented" });
  }
  return findings;
}

async function jsonFiles(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`input must not be a symbolic link: ${path}`);
  if (info.isFile()) {
    if (!path.endsWith(".json")) throw new Error(`input must be JSON: ${path}`);
    return [path];
  }
  if (!info.isDirectory()) throw new Error(`input is not a file or directory: ${path}`);
  const files = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`input must not be a symbolic link: ${join(path, entry.name)}`);
    if (entry.isDirectory() || entry.name.endsWith(".json")) files.push(...await jsonFiles(join(path, entry.name)));
  }
  return files;
}

export async function checkCatalogueInputs(catalogue, { templates, personas }) {
  const findings = [];
  const commands = [];
  const files = [];
  for (const [kind, path] of [["template", templates], ["persona", personas]]) {
    let inputs;
    try {
      inputs = await jsonFiles(path);
      if (!inputs.length) throw new Error(`no JSON files in ${path}`);
    } catch (error) {
      findings.push({ code: "input", source: path, at: "", message: error.message });
      continue;
    }
    for (const source of inputs) {
      files.push(source);
      try {
        const data = JSON.parse(await readFile(source, "utf8"));
        if (data?.schema !== `kova.verify.${kind}.v1`) throw new Error(`expected kova.verify.${kind}.v1`);
        const add = (command, at) => commands.push({ command, source, at });
        const rows = kind === "template" ? data.phases : data.traits;
        if (!Array.isArray(rows)) throw new Error(`expected ${kind === "template" ? "phases" : "traits"} array`);
        for (const [index, row] of rows.entries()) {
          const key = kind === "template" ? "commands" : "builder";
          const at = `/${kind === "template" ? "phases" : "traits"}/${index}`;
          if (!isObject(row) || !Array.isArray(row[key])) {
            findings.push({ code: "input", source, at, message: `expected ${key} array` });
          } else row[key].forEach((command, commandIndex) => add(command, `${at}/${key}/${commandIndex}`));
          if (kind === "persona" && isObject(row)) add(row.check, `${at}/check`);
        }
      } catch (error) {
        findings.push({ code: "input", source, at: "", message: error.message });
      }
    }
  }
  findings.push(...checkCatalogueCommands(catalogue, commands));
  return { schema: "kova.verify.catalogue-check.v1", product: catalogue.product, revision: catalogue.revision, ok: findings.length === 0, files, commandCount: commands.length, findings };
}
