import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const resourcesHref = new URL("../src/collectors/resources.mjs", import.meta.url).href;

export async function runResourceSamplerTimeoutChecks(parentDir) {
  for (const probe of ["ps", "gateway", ...(process.platform === "linux" ? ["getconf"] : [])]) {
    const root = join(parentDir, probe);
    await mkdir(root);
    const pidPath = join(root, "pids");
    const shim = join(root, probe);
    await writeFile(shim, `#!${process.execPath}
import { appendFileSync } from "node:fs";
process.on("SIGTERM", () => {});
appendFileSync(${JSON.stringify(pidPath)}, process.pid + "\\n");
setInterval(() => {}, 1000);
`);
    await chmod(shim, 0o755);
    const script = join(root, "probe.mjs");
    await writeFile(script, `import { startResourceSampler } from ${JSON.stringify(resourcesHref)};
delete process.env.KOVA_OCM_TRANSPORT_JSON;
const sampler = startResourceSampler(process.pid, ${probe === "gateway" ? `{
  envName: "timeout-fixture",
  commandEnv: { SHELL: ${JSON.stringify(shim)} },
  processLister: () => ({ ok: true, processes: [] })
}` : "{}"});
const result = await sampler.stop();
console.log(JSON.stringify(result));
`);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"], timeout: 20000, killSignal: "SIGKILL"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(result.signal, null, `${probe} blocked the sampler until its outer watchdog killed it`);
      assert.equal(result.code, 0, stderr);
      const summary = JSON.parse(stdout);
      if (probe === "ps") assert.ok(summary.errors.length > 0, "failed census must remain an error");
      const pids = (await readFile(pidPath, "utf8")).trim().split("\n").map(Number);
      assert.ok(pids.length > 0, `${probe} must execute the unresponsive probe`);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      const pids = (await readFile(pidPath, "utf8").catch(() => "")).trim().split("\n").map(Number);
      for (const pid of pids.filter((pid) => pid > 0)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = await mkdtemp(join(tmpdir(), "kova-sampler-timeout-"));
  try {
    await runResourceSamplerTimeoutChecks(root);
    console.log("PASS resource sampler terminates probes that ignore SIGTERM");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
