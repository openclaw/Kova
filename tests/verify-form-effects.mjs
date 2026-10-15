import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCatalogueResolver, loadCatalogue } from "../src/catalogue.mjs";
import { readPersona } from "../src/verify/clones.mjs";
import { selectPhases } from "../src/verify/select.mjs";

const call = (method, params = {}) => `node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method ${method} --params '${JSON.stringify(params)}'`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("declared profile options resolve as destructive without changing ordinary Gateway entries", async () => {
  const { catalogue } = await loadCatalogue("openclaw");
  const resolve = createCatalogueResolver(catalogue), before = JSON.stringify(catalogue);
  for (const method of ["sessions.list", "sessions.setInvolvement", "session.suggestions.add"]) {
    const ordinary = call(method), base = catalogue.entries.find((entry) => entry.kind === "gateway" && entry.wraps === method);
    assert.equal(resolve(ordinary), base);
    for (const profile of ["--persona-profile owner", "--persona-profile=member"]) {
      const resolved = resolve(`${ordinary} ${profile} --gateway-handle {run}/gateway.json`);
      assert.equal(resolved.id, base.id);
      assert.equal(resolved.side, "destructive");
      assert.notEqual(resolved, base, "profile classification must not mutate the shared entry");
    }
    assert.equal(resolve(ordinary), base);
  }
  assert.equal(resolve(call("sessions.list")).side, "read");
  assert.equal(resolve(call("sessions.list", { search: "--persona-profile owner --persona-profile=member" })).side, "read");
  assert.equal(resolve("node {kovaRoot}/support/verify/gateway-lifecycle.mjs pause --env {env} --gateway-handle {run}/gateway.json --timeout 30000").side, "destructive");
  assert.equal(JSON.stringify(catalogue), before);
});

test("persona read checks admit ordinary lists and reject profiled Gateway transactions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-form-effects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { catalogue } = await loadCatalogue("openclaw");
  const archive = Buffer.from("synthetic export bytes\n"), archivePath = join(root, "state.tar");
  await writeFile(archivePath, archive);
  const manifestPath = join(root, "manifest.json"), definitionPath = join(root, "definition.json");
  const runtime = { selector: "npm:2026.9.9" };
  const read = async (check) => {
    const definition = Buffer.from(JSON.stringify({ schema: "kova.verify.persona.v1", id: "list-check", runtime, credentials: [], traits: [{ id: "sessions", keys: {}, builder: [], check }] }));
    const manifest = Buffer.from(JSON.stringify({
      schema: "kova.verify.persona-manifest.v1", persona: "list-check", runtime,
      env: { includeState: true, export: "state.tar", sha256: sha256(archive) },
      definition: { path: "definition.json", sha256: sha256(definition) },
      traits: { sessions: { keys: {} } }
    }));
    await writeFile(definitionPath, definition);
    await writeFile(manifestPath, manifest);
    return readPersona(manifestPath, sha256(manifest), catalogue);
  };
  const ordinary = call("sessions.list", { agentId: "main", limit: 200 });
  assert.equal((await read(ordinary)).archive, archivePath);
  for (const profile of ["--persona-profile owner", "--persona-profile=member"]) {
    await assert.rejects(read(`${ordinary} ${profile} --gateway-handle {run}/gateway.json`), /requires an available read-only check/);
  }
  assert.equal((await read(ordinary)).archive, archivePath);
});

test("phase selection orders a trait reader before a profiled list transaction", async () => {
  const { catalogue } = await loadCatalogue("openclaw");
  const ordinary = call("sessions.list", { search: "{persona:history:key}" });
  const phase = (command) => ({ id: "observe", kind: "operation", intent: "Observe the saved session", paths: ["src/gateway/**"], requires: ["history"], commands: [command], checkpoint: ["responses"], timeoutMs: 60000 });
  const result = selectPhases({
    paths: ["src/gateway/handlers.ts"],
    standard: {
      ignore: {},
      before: [{ id: "start", commands: ["node {kovaRoot}/support/verify/gateway-lifecycle.mjs start --env {env} --handle {run}/gateway.json --timeout 120000"], checkpoint: ["responses"], timeoutMs: 120000 }],
      after: [{ id: "stop", commands: ["node {kovaRoot}/support/verify/gateway-lifecycle.mjs stop --wait {run}/gateway.json --timeout 30000"], checkpoint: ["responses"], timeoutMs: 30000 }]
    },
    areas: [], catalogue,
    persona: { traits: { history: { keys: { key: "agent:main:history" } } } },
    templates: [
      { id: "a-profile", phases: [phase(`${ordinary} --persona-profile=owner --gateway-handle {run}/gateway.json`)] },
      { id: "z-reader", phases: [phase(ordinary)] }
    ]
  });
  assert.deepEqual(result.withheld, []);
  assert.deepEqual(result.phases.map((item) => item.id), ["standard/start", "z-reader/observe", "a-profile/observe", "standard/stop"]);
});
