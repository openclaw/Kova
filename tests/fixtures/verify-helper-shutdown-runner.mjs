import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCatalogueCommand } from "../../src/catalogue.mjs";
import { runCommand } from "../../src/commands.mjs";
import { runVerification } from "../../src/verify/run.mjs";

const directory = process.argv[2];
const fixture = JSON.parse(await readFile(join(directory, "fixture.json"), "utf8"));
const events = join(directory, "events.jsonl");
const record = (value) => appendFileSync(events, `${JSON.stringify({ ...value, at: Date.now() })}\n`);
const bindings = new Map();

process.on("SIGTERM", () => record({ type: "outer-signal", signal: "SIGTERM" }));

const result = await runVerification({ ...fixture.options, execute: true }, {
  root: fixture.root,
  home: join(directory, "artifacts"),
  async execute(command, options) {
    const tokens = parseCatalogueCommand(command, { standard: true }).tokens;
    record({ type: "dispatch", tokens, finishOnShutdown: options.finishOnShutdown, signalOnShutdown: options.signalOnShutdown });
    if (tokens[1]?.endsWith("/support/verify/cron-runtime-smoke.mjs")) {
      const env = tokens[tokens.indexOf("--env") + 1];
      const result = await runCommand(command, options);
      await writeFile(join(directory, "copies", env, "command-result.json"), JSON.stringify(result));
      record({ type: "adapter-finished", env });
      return result;
    }
    if (tokens[0] === "ocm" && tokens[1] === "start") bindings.set(tokens[2], tokens[tokens.indexOf("--runtime") + 1]);
    const shown = tokens[0] === "ocm" && tokens[1] === "env" && tokens[2] === "show"
      ? { name: tokens[3], defaultRuntime: bindings.get(tokens[3]) } : null;
    return {
      command, status: 0, signal: null, timedOut: false, durationMs: 0, stderr: "",
      stdout: shown ? JSON.stringify(shown) : command === "ocm --version" ? "0.3.3\n"
        : command === "ocm runtime list --json" ? "[]" : '{"ok":true}'
    };
  },
  cloneFactory({ name, directory: output }) {
    const env = `kova-helpers-shutdown-${name}`, root = join(directory, "copies", env);
    return {
      directory: output,
      handles: new Set(),
      context: () => ({ env, run: output, kovaRoot: fixture.commandRoot, roots: [], traits: {} }),
      async prepare() {
        await mkdir(join(root, "state"), { recursive: true });
        await mkdir(output, { recursive: true });
        await writeFile(join(root, "config.json"), "{}");
        await writeFile(join(root, "jobs.json"), JSON.stringify([fixture.borrowed]));
        await writeFile(join(root, "output.json"), JSON.stringify(output));
        return { name: env, root, stateDir: join(root, "state") };
      },
      async cleanup() {
        const read = (file) => {
          try { return JSON.parse(readFileSync(file, "utf8")); }
          catch (error) { if (error.code === "ENOENT") return null; throw error; }
        };
        record({
          type: "clone-cleanup", env,
          jobs: read(join(root, "jobs.json")),
          helper: read(join(output, "cron", "cron-runtime-smoke.json")),
          command: read(join(root, "command-result.json"))
        });
        await rm(join(root, "state"), { recursive: true, force: true });
      }
    };
  }
});
record({ type: "run-finished", path: result.path, cleanupErrors: result.cleanupErrors });
