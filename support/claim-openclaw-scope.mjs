import { markOpenClawScope } from "./openclaw-scope.mjs";

const [envName, ownerId] = process.argv.slice(2);
const root = process.env.OPENCLAW_HOME;
if (!envName?.startsWith("kova-") || !ownerId || !root || process.env.OCM_ACTIVE_ENV !== envName) {
  throw new Error(`refusing to mark OpenClaw target ${root ?? "<unresolved>"}: expected the newly provisioned Kova OCM env; run Kova with isolated scopes`);
}
markOpenClawScope(root, ownerId);
