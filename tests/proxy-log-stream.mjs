import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import * as frontage from "../src/network-frontage.mjs";

export async function runProxyLogStreamChecks(parentDir) {
  const unwritableLogPath = join(parentDir, "proxy.log");
  await mkdir(unwritableLogPath);

  const uncaughtWithoutHandler = await captureUncaughtException(() => {
    createWriteStream(unwritableLogPath, { flags: "a" });
  });
  assert.equal(uncaughtWithoutHandler?.code, "EISDIR");
  assert.match(uncaughtWithoutHandler.message, /illegal operation on a directory/);

  assert.equal(typeof frontage.attachProxyLogStream, "function", "attachProxyLogStream is exported");

  const uncaught = [];
  const onUncaught = (error) => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const log = createWriteStream(unwritableLogPath, { flags: "a" });
    const stderr = new PassThrough();
    frontage.attachProxyLogStream(log, stderr);
    await waitMs(80);
    assert.equal(log.listenerCount("error") >= 1, true, "log error handler attached");
    assert.equal(stderr.listenerCount("error") >= 1, true, "stderr error handler attached");
    assert.equal(uncaught.length, 0, "unwritable proxy log does not crash the parent");
    assert.equal(logged.some((line) => line.includes("network frontage proxy log stream error")), true, "log stream error is reported");
    assert.equal(stderr.isPaused(), false, "stderr keeps flowing after log error");
    assert.notEqual(stderr.readableFlowing, false, "stderr remains flowing after log error");
    const postReadyChunk = Buffer.alloc(8 * 1024, 0x78);
    for (let i = 0; i < 16; i += 1) {
      stderr.write(postReadyChunk);
    }
    assert.equal(stderr.isPaused(), false, "post-ready stderr writes do not pause the source");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stderr did not finish after log error")), 200);
      stderr.once("finish", () => {
        clearTimeout(timer);
        resolve();
      });
      stderr.end();
    });

    const writableLogPath = join(parentDir, "writable-proxy.log");
    await writeFile(writableLogPath, "", "utf8");
    const writableLog = createWriteStream(writableLogPath, { flags: "a" });
    const brokenStderr = new PassThrough();
    frontage.attachProxyLogStream(writableLog, brokenStderr);
    brokenStderr.destroy(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await waitMs(80);
    assert.equal(uncaught.length, 0, "stderr pipe error does not crash the parent");
    try {
      log.destroy();
    } catch {
      // already failed open
    }
    try {
      writableLog.destroy();
    } catch {
      // ignore
    }
  } finally {
    console.error = originalError;
    process.off("uncaughtException", onUncaught);
  }

  const source = await readFile(new URL("../src/network-frontage.mjs", import.meta.url), "utf8");
  assert.match(source, /attachProxyLogStream\(log,\s*child\.stderr\)/, "startProxy attaches log stream error handlers");
}

function captureUncaughtException(start) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off("uncaughtException", onUncaught);
      reject(new Error("expected uncaughtException from unwritable write stream"));
    }, 500);
    const onUncaught = (error) => {
      clearTimeout(timer);
      process.off("uncaughtException", onUncaught);
      resolve(error);
    };
    process.on("uncaughtException", onUncaught);
    start();
  });
}

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const root = await mkdtemp(join(tmpdir(), "kova-proxy-log-stream-"));
  try {
    await runProxyLogStreamChecks(root);
    console.log("PASS proxy log stream errors");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
