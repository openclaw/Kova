import assert from "node:assert/strict";
import { test } from "node:test";
import { collectErrorFlags, parseFlags } from "../src/cli.mjs";

test("inline option values preserve every character after the first equals sign", () => {
  for (const value of ["", "fixture==", "a=b=c", "a=\nb=c"]) {
    assert.deepEqual(parseFlags([`--report-dir=${value}`]), { _: [], report_dir: value });
  }
});

test("boolean options reject trailing equals content", () => {
  for (const value of ["true=ignored", "false=ignored", "true="]) {
    assert.throws(() => parseFlags([`--execute=${value}`]), /--execute must be true or false/);
  }
});

test("error output flags require the complete inline value to be true", () => {
  assert.equal(collectErrorFlags(["--json=true=ignored"]).json, false);
  assert.equal(collectErrorFlags(["--json=true"]).json, true);
  assert.equal(collectErrorFlags(["--json"]).json, true);
  assert.equal(collectErrorFlags(["--", "--json"]).json, undefined);
});
