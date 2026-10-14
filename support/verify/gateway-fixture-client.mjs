import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicJson, CallError, readOperation } from "./background.mjs";

export const gatewayFixtureCleanupMs = 150000;

async function optionalRecord(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function requestGatewayFixture(options, { signal } = {}) {
  const operation = await readOperation(options["gateway-handle"]);
  if (operation.entry !== "foreground-gateway-start" || operation.method !== "gateway.start" || operation.env !== options.env || !operation.handle) throw new CallError("fixture requires the selected environment's foreground Gateway handle");
  if (await optionalRecord(join(operation.directory, "result.json"))) throw new CallError("Gateway operation has already ended");
  const id = randomUUID();
  const path = join(operation.directory, "fixture-request.json");
  const resultPath = join(operation.directory, `fixture-result-${id}.json`);
  let complete = false;
  let cancelled = false;
  let cancellation;
  let deadline = Math.min(Date.parse(operation.expiresAt), Date.now() + options.timeoutMs + gatewayFixtureCleanupMs);
  signal?.throwIfAborted();
  try { await atomicJson(path, { id, options, expiresAt: Date.now() + options.timeoutMs }, { exclusive: true }); }
  catch (error) { if (error.code === "EEXIST") throw new CallError("another fixture request is pending"); throw error; }
  try {
    while (true) {
      const result = await optionalRecord(resultPath);
      if (result) {
        complete = true;
        if (cancelled) throw cancellation;
        return result;
      }
      if (signal?.aborted && !cancelled) {
        cancelled = true;
        cancellation = signal.reason ?? new CallError("fixture request interrupted", 1);
        deadline = Math.min(deadline, Date.now() + gatewayFixtureCleanupMs);
        await atomicJson(join(operation.directory, `fixture-cancel-${id}.json`), { cancelled: true });
      }
      if (await optionalRecord(join(operation.directory, "result.json"))) throw new CallError("Gateway ended before the fixture result", 1);
      // The worker owns rollback and restart after the request deadline.
      if (Date.now() >= deadline) throw new CallError("fixture preparation cleanup timeout", 3);
      await sleep(50);
    }
  } finally {
    if (!complete) await atomicJson(join(operation.directory, `fixture-cancel-${id}.json`), { cancelled: true });
    else if (!cancelled) await unlink(resultPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
