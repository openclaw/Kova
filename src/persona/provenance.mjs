import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { quoteShell } from "../commands.mjs";
import { ocmInvocation, resolveOcmTransport } from "../ocm/transport.mjs";

const executeFile = promisify(execFile);

export async function captureOcmProvenance(call) {
  // Resolve inside the executor: its scoped environment can select a different
  // transport or PATH from the parent process.
  const script = `import { inspectOcmProvenance } from ${JSON.stringify(import.meta.url)}; process.stdout.write(JSON.stringify(await inspectOcmProvenance(process.argv[1])));`;
  const result = await call(`${quoteShell(process.execPath)} --input-type=module -e ${quoteShell(script)} "$(command -v ocm)"`, "inspect persona OCM");
  const record = JSON.parse(result.stdout);
  if (typeof record.binary !== "string" || !record.binary.startsWith("/") ||
      typeof record.version !== "string" || !record.version.trim() ||
      !/^[a-f0-9]{64}$/.test(record.sha256 ?? "") ||
      (record.commit !== undefined && !/^[a-f0-9]{7,40}$/i.test(record.commit))) {
    throw new Error("invalid persona OCM provenance");
  }
  return record;
}

export async function inspectOcmProvenance(selected) {
  const config = resolveOcmTransport();
  const source = `(${probeBinary.toString()})(${JSON.stringify(config?.binary ?? selected)}).then(record => process.stdout.write(JSON.stringify(record))).catch(error => { console.error(error.message); process.exitCode = 1; });`;
  // The probe must read the file as the same principal that executes OCM.
  // Reuse the transport's prefix, environment and working directory; never
  // inspect the runner's PATH shim or require access to a target-private path.
  const invocation = config
    ? ocmInvocation(["node", "--input-type=module", "-e", source], {
      ...process.env,
      KOVA_OCM_TRANSPORT_JSON: JSON.stringify({ ...config, binary: "/usr/bin/env" }),
    })
    : { file: "/usr/bin/env", args: ["node", "--input-type=module", "-e", source], env: process.env };
  try {
    const result = await executeFile(invocation.file, invocation.args, { env: invocation.env, timeout: 30000, killSignal: "SIGKILL", maxBuffer: 16384 });
    return JSON.parse(result.stdout);
  } catch (error) {
    // execFile's message includes argv, including the transport environment.
    // Keep those values out of the build's diagnostic output.
    throw new Error(`OCM provenance inspection failed: ${error.stderr?.trim() || error.code || error.signal || "invalid response"}`);
  }
}

// Serialized into the target process, so this function uses only Node builtins.
async function probeBinary(selected) {
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { constants } = await import("node:fs");
  const { access, open, readFile, realpath, stat } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { dirname, join, resolve } = await import("node:path");
  if (!selected) throw new Error("OCM executable was not found");
  let binary = await realpath(selected);
  const launcher = binary;
  if (!(await stat(binary)).isFile()) throw new Error("OCM executable must be a regular file");
  let handle = await open(binary, "r");
  try {
    const magic = Buffer.alloc(2);
    await handle.read(magic, 0, 2, 0);
    if (magic.toString() === "#!") {
      // The supported npm launcher execs the platform package's native OCM.
      // Hash that file, not JavaScript which is shared across OCM versions.
      const packageRoot = dirname(dirname(binary));
      let manifest;
      try { manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")); }
      catch { throw new Error("OCM provenance requires the native executable or the @openclaw/ocm launcher"); }
      const platform = `${process.platform}-${process.arch}`;
      const target = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" }[platform];
      if (manifest.name !== "@openclaw/ocm" || !target || manifest.bin?.ocm !== "bin/ocm.cjs" || binary !== resolve(packageRoot, manifest.bin.ocm)) {
        throw new Error("OCM provenance requires the native executable or the @openclaw/ocm launcher");
      }
      const dependency = createRequire(binary).resolve(`@openclaw/ocm-${platform}/package.json`);
      binary = await realpath(join(dirname(dependency), "vendor", target, "bin", "ocm"));
      if (!(await stat(binary)).isFile()) throw new Error("OCM executable must be a regular file");
      await handle.close();
      handle = await open(binary, "r");
      await handle.read(magic, 0, 2, 0);
      if (magic.toString() === "#!") throw new Error("OCM platform executable must not be a script");
    }
    await access(binary, constants.X_OK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("OCM executable must be a regular file");
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({ start: 0, autoClose: false })) hash.update(bytes);
    const versionOptions = { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 8192 };
    const version = execFileSync(launcher, ["--version"], versionOptions).trim();
    if (!version) throw new Error("OCM returned an empty version");
    if (launcher !== binary && execFileSync(binary, ["--version"], versionOptions).trim() !== version) {
      throw new Error("OCM launcher and native executable report different versions");
    }
    const after = await stat(binary, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key] !== after[key])) {
      throw new Error("OCM executable changed while recording provenance");
    }
    const commit = version.match(/\b(?:commit|revision|git(?:[- ](?:commit|sha))?)\s*[:=]?\s*([a-f0-9]{7,40})\b/i)?.[1]
      ?? version.match(/\(([a-f0-9]{7,40})(?:\s[^)]*)?\)/i)?.[1];
    return { binary, version, sha256: hash.digest("hex"), ...(commit ? { commit } : {}) };
  } finally {
    await handle.close();
  }
}
