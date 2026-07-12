#!/usr/bin/env node
import { main } from "../src/main.mjs";
import { collectErrorFlags } from "../src/cli.mjs";
import { renderError } from "../src/reporting/render-error.mjs";

main(process.argv.slice(2)).catch((error) => {
  const flags = collectErrorFlags(process.argv.slice(2));
  const message = error instanceof Error ? error.message : String(error);
  if (flags.json === true) {
    console.error(JSON.stringify({
      schemaVersion: "kova.error.v1",
      ok: false,
      error: {
        message
      }
    }));
  } else if (flags.plain || !process.stderr.isTTY) {
    console.error(`kova: ${message}`);
  } else {
    console.error(renderError(error, flags, process.env, process.stderr));
  }
  process.exitCode = 1;
});
