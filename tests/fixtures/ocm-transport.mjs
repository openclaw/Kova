import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const envName = args[0]?.startsWith("@") ? args[0].slice(1) :
  args[0] === "start" ? args[1] :
  args[1] === "artifact" ? args[3] : args[2];
const root = join(process.env.HOME, "envs", envName ?? "unused");
appendFileSync(process.env.KOVA_TEST_LOG, JSON.stringify({ args, envName, cwd: process.cwd() }) + "\n");
if (process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH) {
  appendFileSync(process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH, JSON.stringify({
    type: "span.end", name: "gateway.ready", durationMs: 5, pid: 4321, timestamp: new Date().toISOString()
  }) + "\n");
}

if (args[0] === "env" && args[1] === "artifact") {
  const path = args[args.indexOf("--path") + 1];
  if (path === "oversize") {
    process.stdout.write(Buffer.alloc(4096));
  } else if (path === "partial-error") {
    process.stdout.write("partial");
    process.exitCode = 9;
  } else {
    const source = join(root, path);
    if (process.env.KOVA_TEST_SHUTDOWN === "export-failed" && path.endsWith("exit.cpuprofile")) {
      console.error("fixture final export failed");
      process.exit(9);
    }
    const before = statSync(source, { bigint: true });
    if (process.env.KOVA_TEST_APPEND_DURING_EXPORT === "1" && path.endsWith("timeline.jsonl") &&
        !existsSync(join(root, ".stopped"))) {
      const stage = readdirSync(join(root, ".kova-diagnostics"))[0];
      const original = join(root, ".kova-diagnostics", stage, "timeline.jsonl");
      appendFileSync(original, '{"type":"mark","name":"producer-appended"}\n');
    }
    process.stdout.write(readFileSync(source));
    const after = statSync(source, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      console.error("artifact changed during export");
      process.exitCode = 1;
    }
  }
} else if (args[0] === "env" && args[1] === "exec") {
  const child = spawnSync(args[4], args.slice(5), {
    cwd: root,
    env: { ...process.env, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: join(root, ".openclaw") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  if (child.error) console.error(child.error.message);
  process.exitCode = child.status ?? 1;
} else if (args[0] === "start") {
  mkdirSync(join(root, ".openclaw"), { recursive: true });
  console.log(JSON.stringify({ envName, defaultRuntime: "fixture" }));
} else if (args[0] === "service") {
  const mode = process.env.KOVA_TEST_SHUTDOWN ?? "immediate";
  const requested = join(root, ".stop-requested");
  if (args[1] === "stop") {
    writeFileSync(requested, "0");
    if (mode === "stop-failed") process.exit(7);
  }
  let running = false;
  if (existsSync(requested) && !["immediate", "export-failed"].includes(mode)) {
    const count = Number(readFileSync(requested, "utf8"));
    if (args[1] === "status") {
      if (mode === "malformed") { console.log("{"); process.exit(0); }
      if (mode === "status-failed") process.exit(8);
      writeFileSync(requested, String(count + 1));
    }
    running = args[1] === "stop" || mode === "never" || count < 2;
    if (mode === "wrong-env") running = false;
  }
  if (existsSync(requested) && !running && existsSync(join(root, ".kova-diagnostics"))) {
    writeFileSync(join(root, ".stopped"), "");
    for (const dir of readdirSync(join(root, ".kova-diagnostics"))) {
      writeFileSync(join(root, ".kova-diagnostics", dir, "node-profiles", "exit.cpuprofile"),
        JSON.stringify({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1, testMarker: "exit-flush" }));
    }
  }
  console.log(JSON.stringify({
    envName: mode === "wrong-env" && existsSync(requested) ? "other-environment" : envName,
    gatewayState: running ? "stopping" : "stopped", running, desiredRunning: false, childPid: null, gatewayPort: null
  }));
} else if (args[0] === "env" && args[1] === "destroy") {
  rmSync(root, { recursive: true, force: true });
  console.log("{}");
} else if (args[0] === "env" && args[1] === "status") {
  console.log(JSON.stringify({ root: process.env.KOVA_TEST_ROOT ?? "/candidate-private/not-readable", gatewayPort: Number(process.env.KOVA_TEST_PORT ?? 45678) }));
} else if (args[0] === "env" && args[1] === "resolve") {
  console.log(JSON.stringify({ binaryPath: process.env.KOVA_TEST_BINARY ?? "/candidate-private/not-readable/openclaw.mjs" }));
} else if (args[0]?.startsWith("@")) {
  if (args.includes("--version")) {
    console.log("OpenClaw 2026.7.33");
  } else if (args[2] === "plugins") {
    const ids = Array.from({ length: 80 }, (_, i) => `kova-plugin-${i}`);
    console.log(JSON.stringify({
      registry: { installRecords: Object.fromEntries(ids.map((id) => [id, {}])), plugins: ids.map((pluginId) => ({ pluginId })) },
      plugins: ids.map((id) => ({ id }))
    }));
  } else if (args[2] === "agent") {
    console.log(JSON.stringify({ finalAssistantVisibleText: "KOVA_AGENT_OK" }));
  } else console.log("{}");
} else if (args[0] === "--version") {
  process.stdout.write("transport-ocm");
} else {
  console.log("{}");
}
