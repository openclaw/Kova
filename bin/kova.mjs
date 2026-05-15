#!/usr/bin/env node
import { main } from "../src/main.mjs";
import { renderError } from "../src/reporting/render-error.mjs";

main(process.argv.slice(2)).catch((error) => {
  const flags = collectErrorFlags(process.argv.slice(2));
  if (flags.plain || flags.json || !process.stderr.isTTY) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kova: ${message}`);
  } else {
    console.error(renderError(error, flags, process.env, process.stderr));
  }
  process.exitCode = 1;
});

function collectErrorFlags(argv) {
  const flags = {};
  for (const t of argv) {
    if (t === "--plain") flags.plain = true;
    else if (t === "--json") flags.json = true;
    else if (t === "--no-color") flags.no_color = true;
  }
  return flags;
}

