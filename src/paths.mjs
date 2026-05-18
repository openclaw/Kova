import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const scenariosDir = join(repoRoot, "scenarios");
export const statesDir = join(repoRoot, "states");
export const profilesDir = join(repoRoot, "profiles");
export const surfacesDir = join(repoRoot, "surfaces");
export const processRolesDir = join(repoRoot, "process-roles");
export const metricsDir = join(repoRoot, "metrics");
export const kovaHome = resolveKovaHome();
export const credentialsDir = join(kovaHome, "credentials");
export const providersPath = join(credentialsDir, "providers.json");
export const liveEnvPath = join(credentialsDir, "live.env");
export const reportsDir = join(kovaHome, "reports");
export const artifactsDir = join(kovaHome, "artifacts");
export const baselinesDir = join(kovaHome, "baselines");

function resolveKovaHome() {
  if (process.env.KOVA_HOME) {
    return process.env.KOVA_HOME;
  }

  return join(homedir(), ".kova");
}

// Render an absolute path in the most readable form for the current
// shell context:
//
//   - inside cwd      → `relative` form (e.g. `reports/foo.json`)
//   - under $HOME     → `~/...` form    (e.g. `~/.kova/reports/foo.json`)
//   - otherwise       → absolute path unchanged
//
// This avoids the `../../../../../.kova/...` walks that `path.relative`
// produces when artifacts live in `~/.kova` but the user is running
// from a deep project directory. Falsy input passes through as `null`.
export function displayPath(p, { cwd = process.cwd(), home = homedir() } = {}) {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  if (home && (abs === home || abs.startsWith(home + sep))) {
    return abs === home ? "~" : "~" + sep + abs.slice(home.length + 1);
  }
  return abs;
}
