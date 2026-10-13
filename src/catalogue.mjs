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
  let comment = false;
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
      const slot = !comment && form && char === "<" ? command.slice(index).match(/^<[^<>\r\n]+>/)?.[0] : null;
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
    if (comment) {
      if (char === "\n" || char === "\r") comment = false;
      continue;
    }
    if (!quote && char === "#" && !started) {
      comment = true;
      continue;
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

const environmentPattern = /^@\{(?:env|persona:[a-zA-Z0-9_.-]+:env)\}$/;
const isFlag = (word) => word?.startsWith("-") && word !== "-" && !/^-[0-9]/.test(word);
const isSlot = (word) => /<|^\[?\{(?:env|run|target|persona:.*)\}/.test(word);
const canonicalWords = (tokens) => tokens.map((word, index) => index === 1 && tokens[0] === "ocm" && tokens[2] === "--" && environmentPattern.test(word) ? "@{env}" : word);

function headWords(tokens) {
  const forwarded = tokens[0] === "ocm" && environmentPattern.test(tokens[1]) && tokens[2] === "--";
  const words = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokens[index];
    if ((word.startsWith("-") && !(forwarded && index === 2)) || isSlot(word)) break;
    words.push(word);
  }
  return words;
}

function argumentOffset(tokens) {
  if (tokens[0] === "ocm" && environmentPattern.test(tokens[1]) && tokens[2] === "--") return 3;
  return tokens[0] === "node" ? 2 : 1;
}

// One pass owns option operands, the end-of-options separator and positionals.
function commandArguments(tokens, flags, allowedFlags = flags) {
  const offset = argumentOffset(tokens);
  const words = canonicalWords(tokens.slice(0, offset));
  const options = [];
  const findings = [];
  let ended = false;
  for (let index = offset; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!ended && token === "--") { ended = true; continue; }
    if (ended || !isFlag(token)) { words.push(token); continue; }
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    const info = Object.hasOwn(flags, flag) ? flags[flag] : null;
    let value = equal < 0 ? undefined : token.slice(equal + 1);
    if (!Object.hasOwn(allowedFlags, flag)) findings.push({ code: "unlisted-flag", flag, message: `unlisted flag ${flag}` });
    if (info?.value === "none" && equal >= 0) findings.push({ code: "argument", flag, message: `${flag} does not take a value` });
    else if (equal < 0 && (info?.value === "required" || (info?.value === "optional" && tokens[index + 1] !== undefined && !isFlag(tokens[index + 1])))) {
      value = tokens[++index];
      if (value === undefined) findings.push({ code: "argument", flag, message: `${flag} requires a value` });
    }
    options.push({ flag, value });
  }
  return { words, options, findings };
}

function gatewayMethod(options) {
  const values = options.filter(({ flag }) => flag === "--method").map(({ value }) => value);
  return values.length === 1 && /^[a-zA-Z][a-zA-Z0-9.]*$/.test(values[0]) ? values[0] : null;
}

export function catalogueCommandHead(command, { kind, flags = {} } = {}) {
  const { tokens } = parseCatalogueCommand(command, { form: true, standard: true });
  const head = headWords(canonicalWords(tokens)).join(" ");
  const args = commandArguments(tokens, { ...(isObject(flags) ? flags : {}), "--method": { value: "required" } });
  return kind === "gateway" ? `${head} --method ${gatewayMethod(args.options) ?? "<missing>"}` : head;
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
    const validFlags = isObject(entry.flags) && Object.entries(entry.flags).every(([flag, info]) => flagPattern.test(flag) && isObject(info) && Object.keys(info).length === 2 && text(info.description) && ["none", "required", "optional"].includes(info.value));
    if (!validFlags) add(`${at}/flags`, "expected flag objects with description and value: none, required or optional");
    const parsed = parseCatalogueCommand(entry.command, { form: true, standard: true });
    for (const finding of parsed.findings) add(`${at}/command`, finding.message);
    const args = commandArguments(parsed.tokens, validFlags ? entry.flags : {});
    if (entry.kind === "gateway" && (!gatewayMethod(args.options) || gatewayMethod(args.options) !== entry.wraps)) add(`${at}/command`, "Gateway command must name exactly its wraps method");
    if (entry.kind === "product" && canonicalWords(parsed.tokens).slice(0, 3).join(" ") !== "ocm @{env} --") add(`${at}/command`, "product command must begin with ocm @{env} -- or ocm @{persona:<trait>:env} --");
    if (entry.kind === "script" && (parsed.tokens[0] !== "node" || !parsed.tokens[1]?.startsWith("{kovaRoot}/support/"))) add(`${at}/command`, "script command must name a Kova support script");
    const head = catalogueCommandHead(entry.command, entry);
    if (!head) add(`${at}/command`, "command has no fixed head");
    for (const [map, key, label] of [[ids, entry.id, "id"], [heads, head, "command head"], [operations, typeof entry.wraps === "string" ? entry.wraps.trim() : entry.wraps, "operation"]]) {
      if (map.has(key)) add(at, `duplicate ${label} with ${map.get(key)}: ${key}`, "duplicate");
      else map.set(key, entry.id);
    }
    if (validFlags) {
      for (const finding of args.findings) add(`${at}/command`, finding.message);
      const slots = args.words.slice(headWords(args.words).length);
      for (const [slotIndex, slot] of slots.entries()) {
        if (!isSlot(slot)) add(`${at}/command`, "positionals after the command head must be value slots");
        if (slot.includes("...") && slotIndex !== slots.length - 1) add(`${at}/command`, "a variadic positional must be last");
        if (!slot.startsWith("[") && slots.slice(0, slotIndex).some((prior) => prior.startsWith("["))) add(`${at}/command`, "required positionals must precede optional positionals");
      }
    }
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

function catalogueResolver(catalogue) {
  const forms = catalogue.entries.map((entry) => {
    const form = parseCatalogueCommand(entry.command, { form: true, standard: true }).tokens;
    const args = commandArguments(form, entry.flags);
    const head = headWords(args.words);
    const slots = args.words.slice(head.length);
    const min = slots.filter((slot) => !slot.startsWith("[")).length;
    const max = slots.some((slot) => slot.includes("...")) ? Infinity : slots.length;
    return { entry, head, min, max, method: gatewayMethod(args.options) };
  });
  for (const form of forms) {
    // Parent option arity still matters when a child does not allow that flag.
    const parents = forms.filter(({ head }) => head.length < form.head.length && head.every((word, index) => form.head[index] === word)).sort((a, b) => a.head.length - b.head.length);
    form.parsingFlags = Object.assign({}, ...parents.map(({ entry }) => entry.flags), form.entry.flags);
  }
  return (tokens) => {
    const candidates = [];
    for (const { entry, head, min, max, method, parsingFlags } of forms) {
      const args = commandArguments(tokens, parsingFlags, entry.flags);
      if (!head.length || !head.every((word, index) => args.words[index] === word)) continue;
      if (entry.kind === "gateway" && gatewayMethod(args.options) !== method) continue;
      candidates.push({ entry, head, min, max, args });
    }
    const longest = Math.max(0, ...candidates.map(({ head }) => head.length));
    const matches = candidates.filter(({ head }) => head.length === longest);
    if (matches.length !== 1) return null;
    const match = matches[0];
    const count = match.args.words.length - match.head.length;
    return { ...match, validPositionals: count >= match.min && count <= match.max };
  };
}

export function resolveCatalogueEntry(catalogue, command) {
  const match = catalogueResolver(catalogue)(parseCatalogueCommand(command).tokens);
  return match?.validPositionals ? match.entry : null;
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
    const match = resolve(parsed.tokens);
    if (!match) { add({ code: "unlisted-command", message: "command has no unique catalogue entry" }); continue; }
    const { entry, args } = match;
    if (!match.validPositionals) add({ code: "unlisted-command", entryId: entry.id, message: "arguments do not match the catalogue command form" });
    for (const finding of args.findings) add({ entryId: entry.id, ...finding });
    if (entry.status === "toWrite") add({ code: "toWrite", entryId: entry.id, message: "entry is not implemented" });
  }
  return findings;
}

async function jsonFiles(path, findings) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`input must not be a symbolic link: ${path}`);
    if (info.isFile()) {
      if (!path.endsWith(".json")) throw new Error(`input must be JSON: ${path}`);
      return [path];
    }
    if (!info.isDirectory()) throw new Error(`input is not a file or directory: ${path}`);
    const files = [];
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.isDirectory() || entry.name.endsWith(".json")) files.push(...await jsonFiles(join(path, entry.name), findings));
    }
    return files;
  } catch (error) {
    findings.push({ code: "input", source: path, at: "", message: error.message });
    return [];
  }
}

export async function checkCatalogueInputs(catalogue, { templates, personas }) {
  const findings = [];
  const commands = [];
  const files = [];
  for (const [kind, path] of [["template", templates], ["persona", personas]]) {
    const priorFindings = findings.length;
    const inputs = await jsonFiles(path, findings);
    if (!inputs.length && findings.length === priorFindings) findings.push({ code: "input", source: path, at: "", message: `no JSON files in ${path}` });
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
