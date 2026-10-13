import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalogueCommandHead, checkCatalogueCommands, checkCatalogueInputs, loadCatalogue, parseCatalogueCommand, resolveCatalogueEntry, validateCatalogue } from "../src/catalogue.mjs";

const flag = (description, value = "required") => ({ description, value });
const entry = (overrides = {}) => ({
  id: "status", kind: "product", wraps: "status", command: "ocm @{env} -- status --json",
  flags: { "--json": flag("print JSON", "none") }, prints: [], creates: [], side: "read", background: false, status: "existing", ...overrides,
});
const catalogue = (...entries) => ({ schema: "kova.verify.catalogue.v1", product: "example", revision: "example-revision", entries });
const script = entry({ id: "send", kind: "script", wraps: "send message", command: "node {kovaRoot}/support/send.mjs --env {env} --text '<text>'", flags: { "--env": flag("environment"), "--text": flag("message"), "--timeout": flag("milliseconds") } });
const gateway = (method) => entry({ id: method.replaceAll(".", "-"), kind: "gateway", wraps: method, command: `node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method ${method} --params '<json>'`, flags: { "--env": flag("environment"), "--method": flag("method"), "--params": flag("JSON") }, status: "toWrite" });
const check = (c, command, options = {}) => checkCatalogueCommands(c, [{ source: "example.json", at: "/phases/0/commands/0", command, ...options }]);

test("catalogue loader enforces the entry form, duplicates and creates pointers", async () => {
  assert.deepEqual(validateCatalogue(catalogue(entry())), []);
  for (const flags of [null, { "--json": "print JSON" }, { "--json": { description: "JSON", value: "boolean" } }, { "--json": { description: "JSON", value: "none", extra: true } }]) {
    assert.ok(validateCatalogue(catalogue(entry({ flags }))).some((f) => f.at.endsWith("/flags")));
  }
  assert.ok(validateCatalogue({ ...catalogue(entry()), product: 123 }).length > 0);
  const invalid = catalogue(entry({ creates: ["sessionId", "/bad~escape"] }), entry({ id: "other", surplus: true }));
  const findings = validateCatalogue(invalid);
  assert.ok(findings.some((finding) => finding.at.endsWith("/creates")));
  assert.ok(findings.some((finding) => finding.message === "unknown entry field"));
  assert.ok(findings.some((finding) => finding.message.includes("duplicate command head")));
  assert.ok(findings.some((finding) => finding.message.includes("duplicate operation")));
  assert.ok(checkCatalogueCommands(invalid, []).some((finding) => finding.code === "duplicate"));
  assert.deepEqual(validateCatalogue(catalogue(entry({ creates: ["", "/results/*/key", "/a~1b/~0id"] }))), []);
  await assert.rejects(loadCatalogue("../openclaw"), /kebab-case/);
  const loaded = await loadCatalogue("openclaw");
  assert.deepEqual(loaded.findings, []);
  assert.ok(loaded.catalogue.entries.every((value) => Array.isArray(value.creates)));
});

test("heads keep the OCM separator and distinguish Gateway methods", () => {
  assert.equal(catalogueCommandHead(entry().command), "ocm @{env} -- status");
  assert.equal(catalogueCommandHead("ocm service restart {env} --json"), "ocm service restart");
  assert.equal(catalogueCommandHead(script.command), "node {kovaRoot}/support/send.mjs");
  assert.equal(catalogueCommandHead(gateway("sessions.get").command, { kind: "gateway" }), "node {kovaRoot}/support/verify/gateway-call.mjs --method sessions.get");
  const c = catalogue(gateway("sessions.get"), gateway("sessions.delete"));
  assert.equal(resolveCatalogueEntry(c, "node {kovaRoot}/support/verify/gateway-call.mjs --params '{}' --method=sessions.get --env {env}")?.wraps, "sessions.get");
  assert.equal(resolveCatalogueEntry(c, "node {kovaRoot}/support/verify/gateway-call.mjs --method sessions.unknown"), null);
  assert.equal(resolveCatalogueEntry(c, "node {kovaRoot}/support/verify/gateway-call.mjs --method sessions.get --method sessions.delete"), null);
  assert.ok(validateCatalogue(catalogue(gateway("<name>"))).length > 0);
});

test("a parent command does not admit an unlisted subcommand", () => {
  const sessions = entry({ command: "ocm @{env} -- sessions --json", wraps: "sessions" });
  const c = catalogue(sessions, entry({ id: "config-get", wraps: "config get", command: "ocm @{env} -- config get <path> --json" }));
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- sessions invented --json"), null);
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- config get gateway.port --json")?.id, "config-get");
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- config show --json"), null);
  const ocm = catalogue(entry({ kind: "ocm", command: "ocm env show {env} --json" }));
  assert.ok(resolveCatalogueEntry(ocm, "ocm env show {env}-second --json"));
});

test("command checks report every planted defect and pending implementation", () => {
  const c = catalogue(entry(), entry({ id: "config-get", wraps: "config get", command: "ocm @{env} -- config get <path> --json" }), { ...script, status: "toWrite" });
  const commands = ["ocm @{env} -- absent --json", "ocm @{env} -- status --invented=value", "ocm @{env} -- config get {secret} --json", "node {kovaRoot}/support/send.mjs --env {env} --text ok"];
  const findings = checkCatalogueCommands(c, commands.map((command, index) => ({ command, source: "planted.json", at: `/${index}` })));
  assert.deepEqual(findings.map((finding) => finding.code), ["unlisted-command", "unlisted-flag", "placeholder", "toWrite"]);
  assert.equal(findings[1].flag, "--invented");
  assert.equal(findings[3].entryId, "send");
  assert.equal(findings[2].at, "/2");
  assert.deepEqual(check(c, "node {kovaRoot}/support/send.mjs --env {env} --unknown value").map((finding) => finding.code), ["unlisted-command", "unlisted-flag", "toWrite"]);
  assert.ok(check(c, "ocm @{env} -- status '-x'").some((finding) => finding.code === "unlisted-flag"));
});

test("explicit flag arity separates operands from options and subcommands", async () => {
  const { catalogue: c } = await loadCatalogue("openclaw");
  assert.deepEqual(check(c, "ocm @{env} -- cron add --name demo --at +1m --system-event '--maintenance' --json"), []);
  assert.deepEqual(check(c, "ocm @{env} -- sessions --agent cleanup --json"), []);
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- sessions --json cleanup")?.id, "sessions-cleanup");
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- sessions --json invented"), null);
  for (const command of ["ocm @{env} -- sessions cleanup --agent demo --json", "ocm @{env} -- sessions --agent demo cleanup --json"]) {
    assert.equal(resolveCatalogueEntry(c, command)?.id, "sessions-cleanup");
    assert.ok(check(c, command).some((finding) => finding.code === "unlisted-flag" && finding.flag === "--agent"));
  }
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- sessions --agent cleanup invented --json"), null);
  assert.ok(check(c, "ocm @{env} -- sessions --agent").some((f) => f.code === "argument"));
  assert.ok(check(c, "ocm @{env} -- sessions --json=true").some((f) => f.code === "argument"));
  assert.deepEqual(check(c, "ocm @{env} -- sessions archive one two --json"), []);
  assert.deepEqual(check(c, "ocm @{env} -- sessions import --all --json"), []);
  assert.deepEqual(check(c, "ocm @{env} -- attach --session demo --print-config"), []);
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- sessions compact one two --json"), null);
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- sessions archive --json"), null);
  assert.deepEqual(check(c, "ocm @{persona:upgrade-env:env} -- status --json"), []);
  assert.equal(resolveCatalogueEntry(c, "ocm @{persona:upgrade-env:root} -- status --json"), null);
  assert.deepEqual(check(c, "ocm env exec {env} -- node script.mjs --child-option"), []);
  assert.ok(check(c, "ocm @{env} -- cron add --name demo --at +1m --system-event '--maintenance' --unknown").some((finding) => finding.code === "unlisted-flag" && finding.flag === "--unknown"));
});

test("optional operands and positionals preserve complete command identity", () => {
  const c = catalogue(entry({ command: "ocm @{env} -- status [<path>]", flags: { "--format": flag("format", "optional"), "--json": flag("JSON", "none") } }));
  for (const command of ["ocm @{env} -- status", "ocm @{env} -- status --format", "ocm @{env} -- status --format --json", "ocm @{env} -- status --format=json path", "ocm @{env} -- status --format json path"]) assert.deepEqual(check(c, command), [], command);
  assert.equal(resolveCatalogueEntry(c, "ocm @{env} -- status --format=json one two"), null);
  const g = catalogue(gateway("sessions.get"));
  assert.equal(resolveCatalogueEntry(g, "node {kovaRoot}/support/verify/gateway-call.mjs --params --method sessions.get"), null);
});

test("restricted shell syntax permits literal single-quoted content only", () => {
  const c = catalogue(script);
  assert.deepEqual(check(c, "node {kovaRoot}/support/send.mjs --env {env} --text '$HOME `id`; a|b & x<y>z\nnext'"), []);
  for (const unsafe of ["$HOME", "$(id)", "`id`", ";", "|", "&", "<", ">", "\n", "\r", '"$HOME"', "\\$HOME", "\\;"]) {
    assert.ok(check(c, `node {kovaRoot}/support/send.mjs --env {env} --text ${unsafe}`).some((finding) => finding.code === "shell"), JSON.stringify(unsafe));
  }
  assert.ok(parseCatalogueCommand("node 'unfinished").findings.some((finding) => finding.code === "syntax"));
  assert.ok(parseCatalogueCommand("node unfinished\\").findings.some((finding) => finding.code === "syntax"));
  const commentBypass = "ocm @{env} -- status --json # '\nprintf KOVA_CATALOGUE_BYPASS\n# '";
  assert.ok(check(catalogue(entry()), commentBypass).some((finding) => finding.code === "shell"));
  assert.deepEqual(check(catalogue(entry()), "ocm @{env} -- status --json # ignored ' quote"), []);
  assert.deepEqual(check(c, "node {kovaRoot}/support/send.mjs --env {env} --text 'a#b'"), []);

});

test("placeholder placement respects quoting, JSON and standard phase scope", () => {
  const c = catalogue(script);
  const command = "node {kovaRoot}/support/send.mjs --env {env} --text '{\"key\":\"{persona:session:key}\",\"empty\":{}}'";
  assert.deepEqual(check(c, command), []);
  for (const value of ["'{env}'", '"{run}"', "'{kovaRoot}'", "{persona:missing}", "{target}", "{unexpected}"]) {
    assert.ok(check(c, `node {kovaRoot}/support/send.mjs --env {env} --text ${value}`).some((finding) => finding.code === "placeholder"), value);
  }
  assert.deepEqual(check(c, "node {kovaRoot}/support/send.mjs --env {env} --text {target}", { standard: true }), []);
  assert.ok(check(c, "node {kovaRoot}/support/send.mjs --env {env} --text '{target}'", { standard: true }).some((finding) => finding.code === "placeholder"));
});

async function inputs(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-catalogue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const templates = join(root, "templates");
  const personas = join(root, "personas");
  await mkdir(join(templates, "nested"), { recursive: true });
  await mkdir(personas);
  const template = join(templates, "nested", "template.json");
  const persona = join(personas, "example.json");
  await writeFile(template, JSON.stringify({ schema: "kova.verify.template.v1", phases: [{ commands: ["ocm @{env} -- status --json"] }] }));
  await writeFile(persona, JSON.stringify({ schema: "kova.verify.persona.v1", traits: [{ builder: ["ocm @{env} -- status --json"], check: "ocm @{env} -- status --json" }] }));
  return { root, templates, personas, template, persona };
}

test("recursive inputs inspect every phase, builder and check without executing commands", async (t) => {
  const paths = await inputs(t);
  const result = await checkCatalogueInputs(catalogue(entry()), paths);
  assert.equal(result.ok, true);
  assert.equal(result.commandCount, 3);
  const marker = join(paths.root, "must-not-execute");
  await writeFile(paths.persona, JSON.stringify({ schema: "kova.verify.persona.v1", traits: [{ builder: [`touch ${marker}`], check: "ocm @{env} -- status --bad" }] }));
  const failed = await checkCatalogueInputs(catalogue(entry()), paths);
  assert.deepEqual(failed.findings.map((finding) => finding.code), ["unlisted-command", "unlisted-flag"]);
  assert.ok(failed.findings[1].at.endsWith("/check"));
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("unreadable, malformed, empty and linked inputs cannot pass silently", async (t) => {
  const paths = await inputs(t);
  await writeFile(paths.template, "{");
  await writeFile(paths.persona, JSON.stringify({ schema: "kova.verify.persona.v1", traits: [{ builder: null, check: 12 }] }));
  const result = await checkCatalogueInputs(catalogue(entry()), paths);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((finding) => finding.code), ["input", "input", "command"]);
  await symlink(paths.template, join(paths.personas, "linked.json"));
  assert.equal((await checkCatalogueInputs(catalogue(entry()), paths)).ok, false);
  await writeFile(paths.template, JSON.stringify({ schema: "kova.verify.template.v1", phases: [{ commands: ["ocm @{env} -- unknown --json"] }] }));
  await writeFile(paths.persona, JSON.stringify({ schema: "kova.verify.persona.v1", traits: [{ builder: ["ocm @{env} -- status --bad"], check: "ocm @{env} -- status --json {unsupported}" }] }));
  const siblings = await checkCatalogueInputs(catalogue(entry()), paths);
  assert.equal(siblings.commandCount, 3);
  assert.deepEqual(new Set(siblings.findings.map((finding) => finding.code)), new Set(["input", "unlisted-command", "unlisted-flag", "placeholder"]));
  assert.ok(siblings.files.includes(paths.template));
  assert.ok(siblings.files.includes(paths.persona));

  await rm(paths.templates, { recursive: true });
  await mkdir(paths.templates);
  const empty = await checkCatalogueInputs(catalogue(entry()), { ...paths, personas: join(paths.root, "missing") });
  assert.equal(empty.findings.length, 2);
});

test("real CLI lists the bundled catalogue and exits nonzero on planted findings", async (t) => {
  const paths = await inputs(t);
  const cli = fileURLToPath(new URL("../bin/kova.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, "catalogue", ...args], { encoding: "utf8" });
  const list = run("list", "--product", "openclaw", "--json");
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).schema, "kova.verify.catalogue.v1");
  const args = ["check", "--product", "openclaw", "--templates", paths.templates, "--personas", paths.personas, "--json"];
  const pass = run(...args);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).commandCount, 3);
  await writeFile(paths.template, JSON.stringify({ schema: "kova.verify.template.v1", phases: [{ commands: ["ocm @{env} -- nonexistent --json", "ocm @{env} -- status --unlisted", "ocm @{env} -- config get {bad} --json"] }] }));
  const fail = run(...args);
  assert.equal(fail.status, 1, fail.stderr);
  assert.deepEqual(JSON.parse(fail.stdout).findings.map((finding) => finding.code), ["unlisted-command", "unlisted-flag", "placeholder"]);
  const plain = run(...args.slice(0, -1));
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /^FAIL: 5 commands, 3 findings/);
  for (const invalid of [["list", "--product", "../openclaw"], ["check", "--product", "openclaw"], ["list", "extra", "--product", "openclaw"], ["list", "--product", "openclaw", "--unknown"]]) assert.equal(run(...invalid).status, 1);
});
