#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

const [mode, stateId] = process.argv.slice(2);
const openclawHome = process.env.OPENCLAW_HOME;

if (!openclawHome || !mode || !stateId) {
  console.error("usage: dirty-plugin-state.mjs <prepare|verify> <state-id>");
  process.exit(2);
}

const supported = new Set([
  "dirty-plugin-local-edits",
  "dirty-plugin-stale-deps",
  "dirty-plugin-manifest-drift",
  "dirty-plugin-disabled-broken",
  "dirty-plugin-symlink-dev",
  "dirty-plugin-partial-install",
  "update-recovery-plugin-user"
]);

if (!supported.has(stateId)) {
  console.error(`unsupported dirty plugin state: ${stateId}`);
  process.exit(2);
}

if (mode === "prepare") {
  prepareState(stateId);
} else if (mode === "verify") {
  verifyState(stateId);
} else {
  console.error(`unsupported mode: ${mode}`);
  process.exit(2);
}

function prepareState(id) {
  if (id === "dirty-plugin-local-edits") {
    prepareLocalEdits();
  } else if (id === "dirty-plugin-stale-deps") {
    prepareStaleDeps();
  } else if (id === "dirty-plugin-manifest-drift") {
    prepareManifestDrift();
  } else if (id === "dirty-plugin-disabled-broken") {
    prepareDisabledBroken();
  } else if (id === "dirty-plugin-symlink-dev") {
    prepareSymlinkDev();
  } else if (id === "dirty-plugin-partial-install") {
    preparePartialInstall();
  } else if (id === "update-recovery-plugin-user") {
    prepareLocalEdits();
    prepareStaleDeps();
    prepareManifestDrift();
    prepareDisabledBroken();
    prepareSymlinkDev();
    preparePartialInstall();
    writeJson(join(openclawHome, "config", "kova-update-recovery-source.json"), {
      schemaVersion: "kova.fixture.updateRecovery.v1",
      source: "stable-channel",
      dirtyPlugins: [
        "kova-dirty-local-edits",
        "kova-dirty-stale-deps",
        "kova-dirty-manifest-drift",
        "kova-dirty-disabled-broken",
        "kova-dirty-symlink-dev",
        "kova-dirty-partial-install"
      ]
    });
  }
  writeStateMarker(id, "prepared");
  console.log(JSON.stringify(stateSummary(id), null, 2));
}

function verifyState(id) {
  const marker = readStateMarker(id);
  if (!marker || marker.status !== "prepared") {
    if (id === "update-recovery-plugin-user") {
      return verifyPreparedState(id, { aggregateMarkerMissing: true });
    }
    console.error(`dirty plugin marker missing for ${id}`);
    process.exit(1);
  }

  return verifyPreparedState(id, { aggregateMarkerMissing: false });
}

function verifyPreparedState(id, options) {
  const failures = [];
  if (id === "dirty-plugin-local-edits" || id === "update-recovery-plugin-user") {
    const result = verifyLocalEdits();
    if (!result.ok) {
      failures.push(result.reason);
    }
  }
  if (id === "dirty-plugin-stale-deps" || id === "update-recovery-plugin-user") {
    const result = verifyMarkerPlugin("kova-dirty-stale-deps");
    if (!result.ok) {
      failures.push(result.reason);
    }
  }
  if (id === "dirty-plugin-manifest-drift" || id === "update-recovery-plugin-user") {
    const result = verifyMarkerPlugin("kova-dirty-manifest-drift");
    if (!result.ok) {
      failures.push(result.reason);
    }
  }
  if (id === "dirty-plugin-disabled-broken" || id === "update-recovery-plugin-user") {
    const result = verifyDisabledBroken();
    if (!result.ok) {
      failures.push(result.reason);
    }
  }
  if (id === "dirty-plugin-symlink-dev" || id === "update-recovery-plugin-user") {
    const result = verifySymlinkDev();
    if (!result.ok) {
      failures.push(result.reason);
    }
  }
  if (id === "dirty-plugin-partial-install" || id === "update-recovery-plugin-user") {
    const result = verifyPartialInstall();
    if (!result.ok) {
      failures.push(result.reason);
    }
  }

  const summary = {
    ...stateSummary(id),
    aggregateMarkerMissing: options.aggregateMarkerMissing === true,
    ok: failures.length === 0,
    failures
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) {
    process.exit(1);
  }
}

function prepareLocalEdits() {
  const root = join(openclawHome, "plugins", "kova-dirty-local-edits");
  mkdirSync(root, { recursive: true });
  writePluginManifest(root, {
    id: "kova-dirty-local-edits",
    name: "Kova Dirty Local Edits",
    version: "0.0.0",
    contracts: { tools: ["kova_local_echo"] }
  });
  writePluginPackage(root, {
    name: "@kova/dirty-local-edits",
    version: "0.0.0",
    entrypoint: "./index.js"
  });
  writeFileSync(
    join(root, "index.js"),
    [
      'import { definePluginEntry } from "openclaw/plugin-sdk";',
      "",
      "export default definePluginEntry({",
      "  register(api) {",
      "    api.registerTool({ name: 'kova_local_echo', inputSchema: { type: 'object' }, run: () => ({ ok: true }) });",
      "  }",
      "});",
      ""
    ].join("\n")
  );
  writeFileSync(join(root, "USER_LOCAL_EDIT.md"), "Kova dirty plugin local edit. OpenClaw must preserve this file.\n");
  upsertInstallRecord({
    id: "kova-dirty-local-edits",
    source: "external",
    enabled: true,
    version: "0.0.0",
    path: "plugins/kova-dirty-local-edits",
    dirty: true
  });
  writeMarker(root, "dirty-plugin-local-edits", ["openclaw.plugin.json", "package.json", "index.js", "USER_LOCAL_EDIT.md"]);
}

function prepareStaleDeps() {
  const root = join(openclawHome, "plugins", "kova-dirty-stale-deps");
  mkdirSync(join(root, "node_modules", ".stale-runtime"), { recursive: true });
  writePluginManifest(root, {
    id: "kova-dirty-stale-deps",
    name: "Kova Dirty Stale Deps",
    version: "1.0.0",
    contracts: { tools: ["kova_stale_dep_probe"] }
  });
  writePluginPackage(root, {
    name: "@kova/dirty-stale-deps",
    version: "1.0.0",
    entrypoint: "./index.js",
    dependencies: { "kova-missing-runtime-dependency": "0.0.0" }
  });
  writeFileSync(
    join(root, "index.js"),
    [
      'import { definePluginEntry } from "openclaw/plugin-sdk";',
      "",
      "export default definePluginEntry({",
      "  register(api) {",
      "    api.registerTool({ name: 'kova_stale_dep_probe', inputSchema: { type: 'object' }, run: () => ({ ok: true }) });",
      "  }",
      "});",
      ""
    ].join("\n")
  );
  writeFileSync(join(root, "node_modules", ".stale-runtime", "README.md"), "Kova stale dependency marker.\n");
  writeMarker(root, "dirty-plugin-stale-deps", ["openclaw.plugin.json", "package.json", "index.js", "node_modules/.stale-runtime/README.md"]);
  upsertInstallRecord(pluginRecord("kova-dirty-stale-deps", "plugins/kova-dirty-stale-deps", { dirty: true, staleDeps: true }));
}

function prepareManifestDrift() {
  const root = join(openclawHome, "plugins", "kova-dirty-manifest-drift");
  mkdirSync(root, { recursive: true });
  writePluginManifest(root, {
    id: "kova-dirty-manifest-drift-renamed",
    name: "Kova Dirty Manifest Drift",
    version: "9.9.9",
    contracts: {
      tools: ["kova_manifest_drift"],
      unsupportedContractForKova: ["evidence"]
    },
    unknownTopLevelForKova: true
  });
  writePluginPackage(root, {
    name: "@kova/dirty-manifest-drift",
    version: "1.0.0",
    entrypoint: "./missing-entrypoint.js"
  });
  writeFileSync(join(root, "index.js"), "export default { register() {} };\n");
  writeMarker(root, "dirty-plugin-manifest-drift", ["openclaw.plugin.json", "package.json", "index.js"]);
  upsertInstallRecord(pluginRecord("kova-dirty-manifest-drift", "plugins/kova-dirty-manifest-drift", { dirty: true, manifestDrift: true }));
}

function prepareDisabledBroken() {
  const root = join(openclawHome, "plugins", "kova-dirty-disabled-broken");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "openclaw.plugin.json"), "{ this is intentionally invalid json for a disabled plugin\n");
  writePluginPackage(root, {
    name: "@kova/dirty-disabled-broken",
    version: "1.0.0",
    entrypoint: "./index.js"
  });
  writeFileSync(join(root, "index.js"), "throw new Error('kova disabled broken plugin should not load');\n");
  writeMarker(root, "dirty-plugin-disabled-broken", ["openclaw.plugin.json", "package.json", "index.js"]);
  upsertInstallRecord(pluginRecord("kova-dirty-disabled-broken", "plugins/kova-dirty-disabled-broken", {
    dirty: true,
    broken: true,
    enabled: false
  }));
}

function prepareSymlinkDev() {
  const target = join(openclawHome, ".openclaw", "kova", "dev-plugin-targets", "kova-dirty-symlink-dev");
  const link = join(openclawHome, "plugins", "kova-dirty-symlink-dev");
  rmSync(link, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  writePluginManifest(target, {
    id: "kova-dirty-symlink-dev",
    name: "Kova Dirty Symlink Dev",
    version: "0.0.0-dev",
    contracts: { tools: ["kova_symlink_dev"] }
  });
  writePluginPackage(target, {
    name: "@kova/dirty-symlink-dev",
    version: "0.0.0-dev",
    entrypoint: "./index.js"
  });
  writeFileSync(join(target, "index.js"), "export default { register() {} };\n");
  writeFileSync(join(target, "USER_LOCAL_EDIT.md"), "Kova symlink target local edit. OpenClaw must preserve this target.\n");
  symlinkSync(target, link, "dir");
  writeMarker(target, "dirty-plugin-symlink-dev", ["openclaw.plugin.json", "package.json", "index.js", "USER_LOCAL_EDIT.md"]);
  upsertInstallRecord(pluginRecord("kova-dirty-symlink-dev", "plugins/kova-dirty-symlink-dev", {
    dirty: true,
    symlink: true
  }));
}

function preparePartialInstall() {
  const root = join(openclawHome, "plugins", "kova-dirty-partial-install");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(dirname(root), { recursive: true });
  upsertInstallRecord({
    id: "kova-dirty-partial-install",
    source: "external",
    enabled: true,
    version: "0.0.0",
    path: "plugins/kova-dirty-partial-install",
    dirty: true,
    partial: true
  });
  writeStateMarker("dirty-plugin-partial-install", "prepared", {
    missingPluginRoot: root
  });
}

function verifyLocalEdits() {
  const markerPath = join(openclawHome, "plugins", "kova-dirty-local-edits", "kova-dirty-plugin-marker.json");
  if (!existsSync(markerPath)) {
    return { ok: false, reason: "local edit marker missing" };
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const actual = checksumFiles(join(openclawHome, "plugins", "kova-dirty-local-edits"), marker.files);
  return marker.checksum === actual
    ? { ok: true }
    : { ok: false, reason: `local edit checksum changed from ${marker.checksum} to ${actual}` };
}

function verifyMarkerPlugin(pluginId) {
  const root = join(openclawHome, "plugins", pluginId);
  const markerPath = join(root, "kova-dirty-plugin-marker.json");
  if (!existsSync(markerPath)) {
    return { ok: false, reason: `${pluginId} marker missing` };
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const actual = checksumFiles(root, marker.files);
  return marker.checksum === actual
    ? { ok: true }
    : { ok: false, reason: `${pluginId} checksum changed from ${marker.checksum} to ${actual}` };
}

function verifyDisabledBroken() {
  const result = verifyMarkerPlugin("kova-dirty-disabled-broken");
  if (!result.ok) {
    return result;
  }
  const records = readUniqueInstallRecords();
  const record = records.find((plugin) => plugin.id === "kova-dirty-disabled-broken");
  return record && record.enabled === false
    ? { ok: true }
    : { ok: false, reason: "disabled broken plugin was unexpectedly enabled or removed" };
}

function verifySymlinkDev() {
  const link = join(openclawHome, "plugins", "kova-dirty-symlink-dev");
  if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) {
    return { ok: false, reason: "symlink dev plugin path is no longer a symlink" };
  }
  const target = readlinkSync(link);
  const root = target.startsWith("/") ? target : join(dirname(link), target);
  const markerPath = join(root, "kova-dirty-plugin-marker.json");
  if (!existsSync(markerPath)) {
    return { ok: false, reason: "symlink dev target marker missing" };
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const actual = checksumFiles(root, marker.files);
  return marker.checksum === actual
    ? { ok: true }
    : { ok: false, reason: `symlink dev target checksum changed from ${marker.checksum} to ${actual}` };
}

function verifyPartialInstall() {
  const root = join(openclawHome, "plugins", "kova-dirty-partial-install");
  if (existsSync(root)) {
    return { ok: false, reason: "partial install root was unexpectedly recreated" };
  }
  const records = readInstallRecords();
  return records.some((plugin) => plugin.id === "kova-dirty-partial-install")
    ? { ok: true }
    : { ok: false, reason: "partial install record missing" };
}

function upsertInstallRecord(plugin) {
  for (const rel of ["plugins", ".openclaw/plugins"]) {
    const dir = join(openclawHome, rel);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "installs.json");
    const index = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : { schemaVersion: "kova.fixture.plugins.v1", plugins: [] };
    const plugins = Array.isArray(index.plugins) ? index.plugins : [];
    const next = plugins.filter((item) => item.id !== plugin.id);
    next.push(plugin);
    writeJson(path, { ...index, plugins: next });
  }
}

function readInstallRecords() {
  const records = [];
  for (const rel of ["plugins/installs.json", ".openclaw/plugins/installs.json"]) {
    const path = join(openclawHome, rel);
    if (!existsSync(path)) {
      continue;
    }
    const index = JSON.parse(readFileSync(path, "utf8"));
    records.push(...(Array.isArray(index.plugins) ? index.plugins : []));
  }
  return records;
}

function readUniqueInstallRecords() {
  const byId = new Map();
  for (const record of readInstallRecords()) {
    byId.set(record.id, record);
  }
  return [...byId.values()];
}

function writeStateMarker(id, status, extra = {}) {
  writeJson(join(openclawHome, ".openclaw", "kova", "dirty-plugin-state.json"), {
    schemaVersion: "kova.fixture.dirtyPluginState.v1",
    id,
    status,
    ...extra
  });
}

function readStateMarker(id) {
  const path = join(openclawHome, ".openclaw", "kova", "dirty-plugin-state.json");
  if (!existsSync(path)) {
    return null;
  }
  const marker = JSON.parse(readFileSync(path, "utf8"));
  return marker.id === id ? marker : null;
}

function stateSummary(id) {
  return {
    schemaVersion: "kova.dirtyPluginState.v1",
    state: id,
    openclawHome,
    pluginRecords: readUniqueInstallRecords().filter((plugin) => String(plugin.id ?? "").startsWith("kova-dirty-"))
  };
}

function checksumFiles(root, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    hash.update(file);
    hash.update("\0");
    hash.update(existsSync(path) ? readFileSync(path) : "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writePluginManifest(root, manifest) {
  writeJson(join(root, "openclaw.plugin.json"), manifest);
}

function writePluginPackage(root, { name, version, entrypoint, dependencies = undefined }) {
  writeJson(join(root, "package.json"), {
    name,
    version,
    type: "module",
    main: entrypoint,
    openclaw: {
      entrypoint,
      compat: {
        pluginApi: "^0.1.0"
      }
    },
    ...(dependencies ? { dependencies } : {})
  });
}

function pluginRecord(id, path, extra = {}) {
  return {
    id,
    source: "external",
    enabled: extra.enabled ?? true,
    version: "0.0.0",
    path,
    ...extra
  };
}

function writeMarker(root, state, files) {
  writeJson(join(root, "kova-dirty-plugin-marker.json"), {
    schemaVersion: "kova.fixture.dirtyPlugin.v1",
    state,
    files,
    checksum: checksumFiles(root, files)
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
