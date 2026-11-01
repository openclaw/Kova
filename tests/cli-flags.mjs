import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAllowedArgs, parseCompactArgs, parseControlFileArgs, requiredSupportArg } from "../support/cli-args.mjs";
import { parseArgs as parseTelegramArgs } from "../support/channels/telegram/args.mjs";
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


test("allowlisted support options reject unknown flags before reading their value", () => {
  assert.deepEqual(parseAllowedArgs(["--env", "first", "--env", "last"], ["env"]), { env: "last" });
  assert.throws(() => parseAllowedArgs(["--unknown"], ["env"]), { message: "unexpected argument: --unknown" });
  assert.throws(() => parseAllowedArgs(["--env", ""], ["env"]), { message: "--env requires a value" });
  assert.throws(() => requiredSupportArg({}, "env"), { message: "--env is required" });
});

test("compact support options normalize hyphens and reject flag-like values", () => {
  assert.deepEqual(parseCompactArgs(["--env-var", "first", "--envvar", "last"]), { envvar: "last" });
  assert.throws(() => parseCompactArgs(["--model", "--next"]), { message: "--model requires a value" });
  assert.throws(() => parseCompactArgs(["positional"]), { message: "unexpected argument: positional" });
});

test("control-file options preserve permissive values before required-key checks", () => {
  assert.deepEqual(parseControlFileArgs(["--script", "--flag", "--optional", ""], ["script"]), { script: "--flag", optional: "" });
  assert.throws(() => parseControlFileArgs(["--script"], ["script"]), { message: "invalid argument: --script" });
  assert.throws(() => parseControlFileArgs(["--script", ""], ["script"]), { message: "--script is required" });
});

test("Telegram support options retain their positional error and nonempty values", () => {
  assert.deepEqual(parseTelegramArgs(["--port-file", "fixture"]), { "port-file": "fixture" });
  assert.throws(() => parseTelegramArgs(["positional"]), { message: "unexpected argument 'positional'" });
  assert.throws(() => parseTelegramArgs(["--port", ""]), { message: "--port requires a value" });
});
