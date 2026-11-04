import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const envName = args[0]?.startsWith("@") ? args[0].slice(1) :
  args[0] === "start" ? args[1] :
  args[1] === "artifact" ? args[3] : args[2];
const root = join(process.env.HOME, "envs", envName ?? "unused");
appendFileSync(process.env.KOVA_TEST_LOG, JSON.stringify({ args, envName, cwd: process.cwd() }) + "\n");
if (process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH) {
  const timeline = process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
  const terminal = process.env.KOVA_TEST_TERMINAL_TIMELINE;
  if (terminal && !existsSync(timeline)) {
    appendFileSync(timeline, JSON.stringify({
      type: "span.start", name: "gateway.ready", spanId: "terminal-ready", pid: 4321,
      timestamp: "2026-11-01T00:00:00.000Z"
    }) + "\n");
    if (terminal === "rotated") appendFileSync(timeline, JSON.stringify({
      type: "provider.request", name: "before-stop-attribution", pid: 4321,
      durationMs: 123, timestamp: "2026-11-01T00:00:00.500Z"
    }) + "\n");
  } else if (!terminal) appendFileSync(timeline, JSON.stringify({
    type: "span.end", name: "gateway.ready", durationMs: 5, pid: 4321, timestamp: new Date().toISOString()
  }) + "\n");
}

if (args[0] === "service" && args[1] === "status" && process.env.KOVA_TEST_FRONTAGE_PORT) {
  console.log(JSON.stringify({ running: true, gatewayState: "running", gatewayPort: Number(process.env.KOVA_TEST_FRONTAGE_PORT) }));
} else if (args[0] === "env" && args[1] === "protect") {
  assert.deepEqual(args.slice(3), ["on", "--json"]);
  process.exitCode = Number(process.env.KOVA_TEST_PROTECT_STATUS ?? 0);
  console.log("{}");
} else if (args[0] === "env" && args[1] === "artifact") {
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
    env: { ...process.env, OCM_ACTIVE_ENV: envName, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: join(root, ".openclaw") },
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
    const firstStop = !existsSync(join(root, ".stopped"));
    writeFileSync(join(root, ".stopped"), "");
    for (const dir of readdirSync(join(root, ".kova-diagnostics"))) {
      const terminal = process.env.KOVA_TEST_TERMINAL_TIMELINE;
      const timeline = join(root, ".kova-diagnostics", dir, "timeline.jsonl");
      if (firstStop && terminal === "missing") {
        rmSync(timeline, { force: true });
      } else if (firstStop && terminal && terminal !== "open") {
        const end = JSON.stringify({
          type: "span.end", name: "gateway.ready", spanId: "terminal-ready", pid: 4321,
          durationMs: 1000, timestamp: "2026-11-01T00:00:01.000Z"
        }) + "\n";
        if (terminal === "rotated") writeFileSync(timeline, end);
        else appendFileSync(timeline, end);
      }
      writeFileSync(join(root, ".kova-diagnostics", dir, "node-profiles", "exit.cpuprofile"),
        JSON.stringify({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1, testMarker: "exit-flush" }));
    }
  }
  console.log(JSON.stringify({
    envName: mode === "wrong-env" && existsSync(requested) ? "other-environment" : envName,
    gatewayState: !existsSync(requested) && process.env.KOVA_TEST_TERMINAL_TIMELINE
      ? "disabled" : running ? "stopping" : "stopped",
    running, desiredRunning: false, childPid: null, gatewayPort: null
  }));
} else if (args[0] === "env" && args[1] === "destroy") {
  if (process.env.KOVA_TEST_TERMINAL_TIMELINE === "cleanup-failed") process.exit(9);
  rmSync(root, { recursive: true, force: true });
  console.log("{}");
} else if (args[0] === "env" && args[1] === "status") {
  console.log(JSON.stringify({ root: process.env.KOVA_TEST_ROOT ?? "/candidate-private/not-readable", gatewayPort: Number(process.env.KOVA_TEST_PORT ?? 45678) }));
} else if (args[0] === "env" && args[1] === "show") {
  console.log(JSON.stringify({ configPath: join(root, ".openclaw", "openclaw.json"), gatewayPort: Number(process.env.KOVA_TEST_PORT ?? 45678) }));
} else if (args[0] === "env" && args[1] === "resolve") {
  console.log(JSON.stringify({ binaryPath: process.env.KOVA_TEST_BINARY ?? "/candidate-private/not-readable/openclaw.mjs" }));
} else if (args[0]?.startsWith("@")) {
  if (args[2] === "mcp") {
    const tokenFile = args[args.indexOf("--token-file") + 1];
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(args.includes("--token"), false);
    appendFileSync(process.env.KOVA_TEST_LOG, JSON.stringify({ gatewayToken: readFileSync(tokenFile, "utf8"), tokenFile }) + "\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture-mcp" } } :
        message.method === "tools/list" ? { tools: [{ name: "conversations_list" }] } :
        { isError: message.params?.name !== "conversations_list", content: [{ type: "text", text: "fixture result" }] };
      console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  } else if (args.includes("--version")) {
    if (process.env.KOVA_TEST_TERMINAL_TIMELINE === "execution-failed") process.exit(6);
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
