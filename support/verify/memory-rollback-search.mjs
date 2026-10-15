import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { ocmInvocation, resolveOcmTransport } from "../../src/ocm/transport.mjs";
import { conditionMain } from "./condition.mjs";

const metadataKey = "memory_index_meta_v1";

function databasePath(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.dbPath === "string") return value.dbPath;
  for (const child of Object.values(value)) {
    const path = databasePath(child);
    if (path) return path;
  }
  return null;
}

function provenance(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM memory_index_meta WHERE key = ?").get(metadataKey);
    if (!row) throw new Error("memory index metadata is absent");
    return JSON.parse(row.value).provenanceVersion;
  } finally { db.close(); }
}

async function productCommand(ctx, args, commands) {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(120000, ctx.remaining()))]);
  const invocation = ocmInvocation([`@${ctx.options.env}`, "--", ...args]);
  const process = spawnOwnedProcess(invocation.file, invocation.args, { env: invocation.env });
  const started = Date.now();
  let stdout = "", bytes = 0, overflow = false;
  process.child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= 1024 * 1024) stdout += chunk;
    else overflow = true;
  });
  process.child.stderr.resume();
  let interrupted;
  const interruption = new Promise((_, reject) => { interrupted = () => reject(signal.reason); });
  signal.addEventListener("abort", interrupted, { once: true });
  try {
    signal.throwIfAborted();
    const result = await Promise.race([process.closed, interruption]);
    signal.throwIfAborted();
    const observation = { command: args.join(" "), exitCode: result.status ?? null, signal: result.signal ?? null, elapsedMs: Date.now() - started };
    commands.push(observation);
    if (result.error || result.status !== 0 || result.signal || overflow) throw new Error(`memory ${args[1]} preparation failed`);
    return stdout;
  } finally {
    signal.removeEventListener("abort", interrupted);
    await process.stop();
  }
}

async function snapshotDatabase(ctx, path, directory) {
  const snapshots = [];
  for (const suffix of ["", "-wal", "-shm", ".reindex-lock.sqlite", ".reindex-lock.sqlite-wal", ".reindex-lock.sqlite-shm"]) {
    const source = await ctx.ownedPath(`${path}${suffix}`, { optional: true });
    const saved = join(directory, `database-${snapshots.length}`);
    try {
      const info = await stat(source);
      if (!info.isFile()) throw new Error("memory database member is not a regular file");
      await copyFile(source, saved, constants.COPYFILE_EXCL);
      snapshots.push({ source, saved });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      snapshots.push({ source, saved: null });
    }
  }
  return snapshots;
}

export async function memoryRollbackSearch(ctx, dependencies = {}) {
  const { options, runtime } = ctx;
  if (resolveOcmTransport()) throw new Error("memory rollback requires filesystem access under the selected environment owner");
  const agent = options.agent ?? "main";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agent)) throw new Error("invalid --agent");
  let requestGatewayLifecycle = dependencies.requestGatewayLifecycle;
  try { requestGatewayLifecycle ??= (await import("./gateway-fixture-client.mjs")).requestGatewayLifecycle; }
  catch { throw new Error("memory rollback requires the foreground Gateway lifecycle helper"); }
  const command = dependencies.productCommand ?? productCommand;
  const configPath = await ctx.ownedPath(runtime.configPath);
  const original = await readFile(configPath);
  const configMode = (await stat(configPath)).mode;
  const config = JSON5.parse(original.toString("utf8"));
  const entry = config.agents?.entries?.[agent];
  if (!entry && agent !== "main") throw new Error("memory agent is not configured");
  const workspace = await ctx.ownedPath(entry?.workspace ?? config.agents?.defaults?.workspace, { directory: true });
  const memoryDirectory = await ctx.ownedPath(join(workspace, "memory"), { optional: true, directory: true });
  const temporary = await mkdtemp(join(await ctx.ownedPath(runtime.root, { directory: true }), ".kova-memory-"));
  const fixture = join(memoryDirectory, `${temporary.split(/[\\/]/).at(-1)}.md`);
  const report = { agentId: agent, commands: [], embeddingRequests: [], createdIds: [], conditionEstablished: false, provenance: null, startup: null, search: null, searchEmbeddingRequests: null, searchDocumentInputs: null, searchQueryInputs: null, rebuiltDuringSearch: null, costWarning: null, restored: false };
  let server, client, snapshots = [], paused = false, ownerTouched = false, fixtureWritten = false, directoryCreated = false, configurationChanged = false;
  const lifecycle = async (operation, cleanup = false) => {
    ownerTouched = true;
    paused = undefined;
    const result = await requestGatewayLifecycle({ env: options.env, "gateway-handle": options["gateway-handle"], operation, timeoutMs: cleanup ? 120000 : Math.min(120000, ctx.remaining()) }, cleanup ? {} : { signal: ctx.signal });
    const observation = { operation, exitCode: result.exitCode, elapsedMs: result.output?.elapsedMs ?? null, error: result.output?.error ?? null };
    if (!cleanup) report.commands.push(observation);
    if (result.exitCode !== 0 || result.output?.error || result.output?.result?.[operation === "pause" ? "paused" : "ready"] !== true) throw new Error(`foreground Gateway ${operation} failed`);
    paused = operation === "pause";
  };
  ctx.cleanup(async () => {
    client?.close();
    try {
      if (ownerTouched && paused !== true) await lifecycle("pause", true);
      if (configurationChanged || snapshots.length) {
        const errors = [];
        const restore = async (operation) => { try { await operation(); } catch (error) { errors.push(error); } };
        for (const snapshot of snapshots) {
          await restore(async () => {
            await ctx.ownedPath(snapshot.source, { optional: true });
            if (snapshot.saved) await copyFile(snapshot.saved, snapshot.source);
            else await rm(snapshot.source, { force: true });
          });
        }
        if (fixtureWritten) await restore(() => rm(fixture));
        if (directoryCreated) {
          const { rmdir } = await import("node:fs/promises");
          await restore(() => rmdir(memoryDirectory));
        }
        if (configurationChanged) await restore(async () => {
          await ctx.ownedPath(configPath);
          await writeFile(configPath, original, { mode: configMode });
        });
        if (errors.length) throw new AggregateError(errors, "memory fixture restoration was incomplete; Gateway remains paused");
      }
      if (paused) await lifecycle("resume", true);
      await rm(temporary, { recursive: true });
      report.restored = true;
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  });
  try {
    await lifecycle("pause");
    const initialStatus = JSON.parse(await command(ctx, ["memory", "status", "--agent", agent, "--json"], report.commands));
    const path = await ctx.ownedPath(databasePath(initialStatus), { optional: true });
    snapshots = await snapshotDatabase(ctx, path, temporary);
    let phase = "index";
    server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/embeddings") { response.writeHead(404).end(); return; }
        let body = "";
        for await (const chunk of request) {
          if (Buffer.byteLength(body) + chunk.length > 8 * 1024 * 1024) { response.writeHead(413).end(); return; }
          body += chunk;
        }
        const parsed = JSON.parse(body);
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        if (!inputs.length || !inputs.every((input) => typeof input === "string")) { response.writeHead(400).end(); return; }
        if (report.embeddingRequests.length >= 1024) { response.writeHead(429).end(); return; }
        report.embeddingRequests.push({ phase, inputType: parsed.input_type ?? null, count: inputs.length, containsFixture: inputs.some((input) => input.includes("Alpha KOVA_MEMORY_ROLLBACK")) });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", model: parsed.model, data: inputs.map((_, index) => ({ object: "embedding", index, embedding: [1, 0, 0, 0] })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
      })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const search = { enabled: true, provider: "openai", model: "text-embedding-3-small", fallback: "none", remote: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "kova-local-fixture", batch: { enabled: false } }, sources: ["memory"], rememberAcrossConversations: false, store: { vector: { enabled: false } }, cache: { enabled: false }, query: { minScore: 0 }, documentInputType: "document", queryInputType: "query" };
    config.memory = { ...config.memory, search };
    if (entry?.memory?.search) entry.memory.search = search;
    try { await mkdir(memoryDirectory); directoryCreated = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await writeFile(fixture, "Alpha KOVA_MEMORY_ROLLBACK retained notebook.\n", { flag: "wx", mode: 0o600 });
    fixtureWritten = true;
    configurationChanged = true;
    await ctx.ownedPath(configPath);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: configMode });
    await command(ctx, ["memory", "index", "--agent", agent, "--force"], report.commands);
    const initialVersion = provenance(path);
    if (!Number.isSafeInteger(initialVersion) || initialVersion < 1 || initialVersion === Number.MAX_SAFE_INTEGER) throw new Error("memory index provenance version cannot be advanced");
    const newerVersion = initialVersion + 1;
    const db = new DatabaseSync(path);
    try { db.prepare("UPDATE memory_index_meta SET value = json_set(value, '$.provenanceVersion', ?) WHERE key = ?").run(newerVersion, metadataKey); }
    finally { db.close(); }
    if (provenance(path) !== newerVersion) throw new Error("newer memory index provenance was not retained");
    report.provenance = { initialVersion, newerVersion, afterSearchVersion: null };
    phase = "startup";
    try { await lifecycle("resume"); }
    catch (error) { report.startup = { status: "error", error: error.message }; return report; }
    report.startup = { status: "completed" };
    client = await ctx.connect();
    phase = "search";
    const observed = await ctx.observe(client, "memory.search", { agentId: agent, query: "KOVA_MEMORY_ROLLBACK", minScore: 0 }, { timeoutMs: 60000 });
    phase = "after-search";
    const result = observed.result;
    report.search = { status: observed.status, elapsedMs: observed.elapsedMs, error: observed.error ?? null, stale: result?.stale ?? false, warning: result?.warning ?? null, action: result?.action ?? null, resultCount: Array.isArray(result?.results) ? result.results.length : null, fixtureFound: result?.results?.some((row) => row.path?.endsWith(fixture.split(/[\\/]/).at(-1))) ?? false };
    try { report.provenance.afterSearchVersion = provenance(path); }
    catch (error) { report.provenance.afterSearchError = error.message; }
    report.conditionEstablished = true;
    report.searchEmbeddingRequests = report.embeddingRequests.filter((request) => request.phase === "search").length;
    report.searchDocumentInputs = report.embeddingRequests.filter((request) => request.phase === "search" && request.inputType === "document").reduce((sum, request) => sum + request.count, 0);
    report.searchQueryInputs = report.embeddingRequests.filter((request) => request.phase === "search" && request.inputType === "query").reduce((sum, request) => sum + request.count, 0);
    report.rebuiltDuringSearch = report.provenance.afterSearchVersion === null ? null : report.provenance.afterSearchVersion !== newerVersion;
    report.costWarning = /cost|embedding provider/i.test(`${report.search.warning ?? ""} ${report.search.action ?? ""}`);
    return report;
  } catch (error) {
    error.output = report;
    throw error;
  }
}

await conditionMain(import.meta.url, { id: "memory-rollback-search", flags: ["agent", "gateway-handle"], required: ["gateway-handle"], cleanupMs: 260000, timeoutMs: 600000 }, memoryRollbackSearch);
