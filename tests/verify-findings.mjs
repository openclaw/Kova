import assert from "node:assert/strict";
import { test } from "node:test";
import { createAddressPattern, createFindings } from "../src/verify/findings.mjs";
import { renderIssues } from "../src/verify/compare.mjs";
import { verdictChunks } from "../src/verify/verdict-output.mjs";

const pointerPart = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const stateAt = (key, index = 0) => `agents/main/agent/openclaw-agent.sqlite:session_entry_snapshots/${pointerPart(JSON.stringify([key, "systemPromptReport"]))}/value_json/skills/entries/${index}/blockChars`;
const row = (values = {}) => ({
  phase: "sessions/read",
  signal: "state",
  at: stateAt("original-session", 0),
  baseline: 360,
  change: 358,
  clones: ["change-1", "change-2"],
  class: "break",
  explainedBy: null,
  ...values
});

test("findings group declared record keys and array positions across phases without changing rows", () => {
  const first = row();
  const rows = [
    first,
    row({ at: stateAt("created-session", 12), baseline: 348, change: 346, clones: ["change-2"] }),
    row({ phase: "sessions/later", at: stateAt("created-session", 3), change: { absent: true } })
  ];
  const before = structuredClone(rows);
  const findings = createFindings({ identities: new Set(["original-session", "created-session"]) });
  for (const value of rows) findings.add(value);
  const result = findings.finish();
  assert.deepEqual(rows, before);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    signal: "state",
    class: "break",
    attribution: "unattributed",
    pattern: stateAt("<id>", 0).replace("/entries/0/", "/entries/*/"),
    count: 3,
    phases: [{ phase: "sessions/later", count: 1 }, { phase: "sessions/read", count: 2 }],
    representative: { phase: first.phase, at: first.at, baseline: 360, change: 358, clones: ["change-1", "change-2"] }
  });
  assert.notEqual(result[0].representative.clones, first.clones);
  assert.deepEqual(findings.finish(), result);
});

test("attribution annotates findings without inferring causes from classes or changing rows", () => {
  const classes = ["break", "flaky", "not-caused", "fixed", "intended"];
  const rows = classes.map(category => row({ class: category }));
  const grouped = createFindings();
  for (const value of rows) grouped.add(value);
  const report = { verdict: "breaks", findings: grouped.finish(), rows, issues: [] };
  const before = structuredClone(report);
  assert.ok(report.findings.every(finding => finding.attribution === "unattributed"));
  const unreviewed = renderIssues(report);
  for (const category of classes) assert.ok(unreviewed.includes(`| ${category} | unattributed |`));
  assert.match(unreviewed, /comparison alone does not establish that the change caused them/);

  // An investigator annotates the specific finding after establishing its cause.
  report.findings[0].attribution = "product";
  const saved = JSON.parse([...verdictChunks(report)].join(""));
  const markdown = renderIssues(saved);
  assert.match(markdown, /\| break \| product \| state \|/);
  assert.equal(saved.findings.filter(finding => finding.attribution === "unattributed").length, 4);
  saved.findings[0].attribution = "unattributed";
  assert.deepEqual(saved, before);
});

test("findings separate signals and classes and count rows rather than clone appearances", () => {
  const findings = createFindings();
  for (const value of [
    row({ signal: "responses", at: "0/items/1", clones: ["change-1"] }),
    row({ signal: "responses", at: "2/items/9" }),
    row({ signal: "responses", at: "0/items/1", class: "flaky" }),
    row({ signal: "state", at: "0/items/1" }),
    row({ signal: "responses", at: "0/other/1" })
  ]) findings.add(value);
  assert.deepEqual(findings.finish().map(({ signal, class: category, pattern, count }) => [signal, category, pattern, count]), [
    ["responses", "break", "*/items/*", 2],
    ["responses", "flaky", "*/items/*", 1],
    ["state", "break", "*/items/*", 1],
    ["responses", "break", "*/other/*", 1]
  ]);
  assert.deepEqual(createFindings().finish(), []);
});

test("address patterns replace complete nested tokens and quoted identities before digit patterns", () => {
  const inner = "<id:sessions/create/0/id>";
  const outer = `<id:agents/main/state.sqlite#${JSON.stringify(inner)}/session_id/1>`;
  const quoted = 'session-"quoted"/old';
  const pattern = createAddressPattern(new Set([inner, outer, quoted]));
  assert.equal(pattern(stateAt(outer, 42)), stateAt("<id>", 0).replace("/entries/0/", "/entries/*/"));
  assert.equal(pattern(stateAt(quoted, 7)), pattern(stateAt(outer, 42)));
  assert.equal(pattern(`events/${pointerPart(JSON.stringify([outer, 12]))}/value`), 'events/["<id>",*]/value');
  assert.equal(pattern(`events/${pointerPart(JSON.stringify({ rowid: 9, key: quoted }))}/value`), 'events/{"key":"<id>","rowid":*}/value');
  assert.equal(pattern(`events/${pointerPart(`prefix ${outer} suffix`)}`), "events/prefix <id> suffix");
  assert.equal(pattern(`INFO prefix ${outer} suffix`), "INFO prefix <id> suffix");
  assert.equal(pattern(stateAt("unknown-session", 7)).includes("unknown-session"), true);
});

test("address patterns preserve pointer escapes, static fields, and numeric key types", () => {
  const pattern = createAddressPattern(["abc", "abc-def", "a.b", "quote\"key"]);
  assert.equal(pattern("a~1b/10/c~0d2"), "a~1b/*/c~0d*");
  assert.notEqual(pattern("a~1b/10"), pattern("a~0b/10"));
  assert.equal(pattern('rows/["abc-def","systemPromptReport",12]/value'), 'rows/["<id>","systemPromptReport",*]/value');
  assert.notEqual(pattern('rows/[12]/value'), pattern('rows/["12"]/value'));
  assert.equal(pattern("prefix abc-def suffix/a.b"), "prefix <id> suffix/<id>");
  assert.equal(pattern("alphabetabc/alphabetabc-def/axb"), "alphabetabc/alphabetabc-def/axb");
  assert.equal(pattern("not-json[12/field2"), "not-json[*/field*");
  const numericIds = createAddressPattern(["1", "0"]);
  assert.equal(numericIds("a~1b/1"), "a~1b/<id>");
  assert.equal(numericIds("a~0b/0"), "a~0b/<id>");
  assert.notEqual(numericIds("a~1b"), numericIds("a~0b"));
});
