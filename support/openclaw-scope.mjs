import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const markerName = ".kova-openclaw-scope.json";

// Resolve existing ancestors too: a symlink below a marked root is not ownership.
function canonical(target, depth = 0) {
  if (depth > 40) refuse(target, "symlink loop");
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) {
        return canonical(path.resolve(parent, fs.readlinkSync(absolute)), depth + 1);
      }
    } catch (linkError) {
      if (linkError.code !== "ENOENT") throw linkError;
    }
    return path.join(canonical(parent, depth + 1), path.basename(absolute));
  }
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function refuse(target, reason) {
  throw new Error(`refusing to write OpenClaw target ${target}: ${reason}; run Kova with isolated scopes`);
}

function assertNotProduction(target, env) {
  if (["OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND", "OPENCLAW_SYSTEMD_UNIT"].some((name) => env[name] !== undefined)) {
    refuse(target, "production service identity is present");
  }
  const home = env.HOME || homedir();
  if (within(canonical(path.join(home, ".openclaw")), target)) {
    refuse(target, "default user OpenClaw state is not a lab scope");
  }
  const serviceDirs = [
    "/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system", "/run/systemd/system",
    "/etc/systemd/user", "/usr/lib/systemd/user",
    path.join(home, ".config/systemd/user"),
    path.join(home, "Library/LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"
  ];
  for (const dir of serviceDirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (error) {
      if (["ENOENT", "EACCES"].includes(error.code)) continue;
      throw error;
    }
    const serviceFiles = entries.filter((name) => /\.(service|conf|plist)$/.test(name));
    for (const dropin of entries.filter((name) => name.endsWith(".service.d"))) {
      for (const name of fs.readdirSync(path.join(dir, dropin))) {
        if (name.endsWith(".conf")) serviceFiles.push(path.join(dropin, name));
      }
    }
    for (const entry of serviceFiles) {
      let source;
      try { source = fs.readFileSync(path.join(dir, entry), "utf8"); } catch (error) {
        if (["ENOENT", "EACCES", "EISDIR"].includes(error.code)) continue;
        throw error;
      }
      // Covers systemd Environment/ExecStart and launchd EnvironmentVariables.
      for (const match of source.matchAll(/OPENCLAW_(CONFIG_PATH|STATE_DIR|HOME)(?:<\/key>\s*<string>([^<]+)<\/string>|=(?:"([^"]+)"|'([^']+)'|([^\n"'<>;]+)))/g)) {
        const raw = (match[2] ?? match[3] ?? match[4] ?? match[5]).split(/\s+(?=[A-Z_][A-Z0-9_]*=)/)[0].trim();
        const value = raw.replaceAll("%h", home).replaceAll("${HOME}", home).replaceAll("$HOME", home).replace(/^~\//, `${home}/`);
        if (!path.isAbsolute(value)) continue;
        const configured = canonical(value);
        const protectedPath = match[1] === "HOME" ? path.join(configured, ".openclaw")
          : match[1] === "CONFIG_PATH" ? path.dirname(configured) : configured;
        if (within(protectedPath, target)) refuse(target, `configured by service ${entry}`);
      }
    }
  }
}

export function markOpenClawScope(root, ownerId, env = process.env, kind = "ocm") {
  const resolved = canonical(root);
  assertNotProduction(resolved, env);
  if (!ownerId || resolved === path.parse(resolved).root || resolved === canonical(homedir())) {
    refuse(root, "invalid scope owner or root");
  }
  fs.mkdirSync(resolved, { recursive: true });
  const marker = { schemaVersion: "kova.openclawScope.v1", root: resolved, ownerId, kind };
  const markerPath = path.join(resolved, markerName);
  let flag = "wx";
  if (fs.existsSync(markerPath)) {
    if (fs.lstatSync(markerPath).isSymbolicLink()) refuse(root, "scope marker is a symlink");
    const existing = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (existing.schemaVersion !== marker.schemaVersion) refuse(root, "invalid scope marker");
    if (existing.root === resolved) {
      if (existing.ownerId === ownerId) return;
      refuse(root, "scope belongs to another Kova run");
    }
    // An OCM clone copies the source marker; only provisioning claims the clone.
    flag = "w";
  }
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { flag, mode: 0o600 });
}

export function assertOwnedOpenClawWrite(target, env = process.env) {
  const resolved = canonical(target);
  assertNotProduction(resolved, env);
  try {
    if (fs.statSync(resolved).nlink > 1) refuse(target, "target has multiple hard links");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let root = path.dirname(resolved);
  while (true) {
    const markerPath = path.join(root, markerName);
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (fs.lstatSync(markerPath).isSymbolicLink() || marker.schemaVersion !== "kova.openclawScope.v1" ||
          marker.root !== root || !marker.ownerId || !["ocm", "self-check"].includes(marker.kind)) refuse(target, "invalid Kova scope marker");
      if ((marker.kind === "ocm" || env.KOVA_OPENCLAW_SCOPE_OWNER) && marker.ownerId !== env.KOVA_OPENCLAW_SCOPE_OWNER) {
        refuse(target, "scope belongs to another Kova run");
      }
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (error.message.startsWith("refusing to write OpenClaw target")) throw error;
        refuse(target, "unreadable or invalid Kova scope marker");
      }
    }
    const parent = path.dirname(root);
    if (parent === root) refuse(target, "no Kova-owned scope marker");
    root = parent;
  }
}

export function ownedOpenClawPaths(env = process.env) {
  const stateDir = env.OPENCLAW_STATE_DIR || (env.OPENCLAW_HOME && path.join(env.OPENCLAW_HOME, ".openclaw"));
  if (!stateDir) refuse("<unresolved>", "OPENCLAW_HOME or OPENCLAW_STATE_DIR is required");
  const configPath = env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
  // Validate both destinations before the first mkdir or write.
  assertOwnedOpenClawWrite(configPath, env);
  assertOwnedOpenClawWrite(path.join(stateDir, ".env"), env);
  return { stateDir, configPath };
}
