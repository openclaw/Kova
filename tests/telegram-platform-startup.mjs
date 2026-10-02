import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTelegramPlatform } from "../support/channels/telegram/platform.mjs";

export async function runTelegramPlatformStartupChecks(parentDir) {
  for (const healthHang of [false, true]) {
    const caseDir = join(parentDir, healthHang ? "health-hang" : "missing-port");
    await mkdir(caseDir);
    await verifyStartupFailure(caseDir, healthHang);
  }
}

async function verifyStartupFailure(parentDir, healthHang) {
  const repoRoot = join(parentDir, "repo");
  const shimPath = join(repoRoot, "support", "channels", "telegram", "platform-shim.mjs");
  await mkdir(join(repoRoot, "support", "channels", "telegram"), { recursive: true });
  await writeFile(shimPath, `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
const dir = process.argv[process.argv.indexOf("--dir") + 1];
writeFileSync(join(dir, "shim.pid"), String(process.pid));
process.on("SIGTERM", () => {});
${healthHang ? `const server = createServer(() => {});
server.listen(0, "127.0.0.1", () => writeFileSync(join(dir, "port"), String(server.address().port)));` : "setInterval(() => {}, 1000);"}
`, "utf8");
  const artifactDir = join(parentDir, "artifacts");
  await mkdir(artifactDir);
  try {
    await assert.rejects(
      startTelegramPlatform({ repoRoot, artifactDir, timeoutMs: 1000 }),
      /timed out waiting for/
    );
    const pid = Number(await readFile(join(artifactDir, "telegram-platform", "shim.pid"), "utf8"));
    const deadline = Date.now() + 1000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, `telegram shim ${pid} kept running after startup failed`);
  } finally {
    const pid = Number(await readFile(join(artifactDir, "telegram-platform", "shim.pid"), "utf8").catch(() => "0"));
    if (pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = await mkdtemp(join(tmpdir(), "kova-telegram-startup-"));
  try {
    await runTelegramPlatformStartupChecks(root);
    console.log("PASS telegram shim exits when startup fails");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
