import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const envName = args[0]?.startsWith("@") ? args[0].slice(1) :
  args[0] === "start" ? args[1] :
  args[1] === "artifact" ? args[3] : args[2];
const root = join(process.env.HOME, "envs", envName ?? "unused");
appendFileSync(process.env.KOVA_TEST_LOG, JSON.stringify({ args, envName, cwd: process.cwd() }) + "\n");

if (args[0] === "env" && args[1] === "artifact") {
  const path = args[args.indexOf("--path") + 1];
  if (path === "oversize") {
    process.stdout.write(Buffer.alloc(4096));
  } else if (path === "partial-error") {
    process.stdout.write("partial");
    process.exitCode = 9;
  } else {
    process.stdout.write(readFileSync(join(root, path)));
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
  console.log(JSON.stringify({ gatewayState: "stopped", running: false, desiredRunning: false, childPid: null, gatewayPort: null }));
} else if (args[0] === "env" && args[1] === "status") {
  console.log(JSON.stringify({ root: process.env.KOVA_TEST_ROOT ?? "/candidate-private/not-readable", gatewayPort: Number(process.env.KOVA_TEST_PORT ?? 45678) }));
} else if (args[0] === "env" && args[1] === "resolve") {
  console.log(JSON.stringify({ binaryPath: process.env.KOVA_TEST_BINARY ?? "/candidate-private/not-readable/openclaw.mjs" }));
} else if (args[0]?.startsWith("@") && args.includes("--version")) {
  console.log("OpenClaw 2026.7.33");
} else if (args[0]?.startsWith("@") && args[2] === "plugins") {
  const ids = Array.from({ length: 80 }, (_, i) => `kova-plugin-${i}`);
  console.log(JSON.stringify({
    registry: { installRecords: Object.fromEntries(ids.map((id) => [id, {}])), plugins: ids.map((pluginId) => ({ pluginId })) },
    plugins: ids.map((id) => ({ id }))
  }));
} else if (args[0] === "--version") {
  process.stdout.write("transport-ocm");
} else {
  console.log("{}");
}
