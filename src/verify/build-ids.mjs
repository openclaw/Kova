import { canonicalJSON } from "./plan.mjs";
import { VerifiedValue } from "./measurements.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const assetPath = /^(\/assets\/[A-Za-z0-9_.-]+)-[A-Za-z0-9_-]{8}(\.(?:js|css))$/;
const absent = Object.freeze({ absent: true });
const finiteJSON = (value) => value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)
  || Array.isArray(value) && value.every(finiteJSON) || object(value) && Object.values(value).every(finiteJSON);

function observationKey(value, normalize) {
  const visit = (value) => {
    if (typeof value === "string") return normalize(value);
    if (Array.isArray(value)) return value.map(visit);
    if (!object(value)) return value;
    const entries = Object.entries(value).map(([key, child]) => [normalize(key), visit(child)]);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("normalization produced duplicate JSON keys");
    return Object.fromEntries(entries);
  };
  return canonicalJSON(visit(value));
}

export function validateBuildIds(declarations) {
  if (declarations === undefined) return [];
  if (!Array.isArray(declarations) || declarations.length > 1 || declarations.some((declaration) =>
    !object(declaration) || Object.keys(declaration).length !== 3 || Object.keys(declaration).some((key) => !["kind", "command", "at"].includes(key)) ||
    declaration.kind !== "asset-fingerprint" || declaration.command !== "control-ui" || declaration.at !== "/requests/*/endpoint")) {
    throw new Error("invalid buildIds declaration");
  }
  return declarations;
}

function declaredAsset(request) {
  if (!object(request) || request.transport !== "http" || request.origin !== "gateway" ||
      typeof request.method !== "string" || !request.method || typeof request.resourceType !== "string" || !request.resourceType ||
      typeof request.status !== "string" || !request.status || !object(request.params) || typeof request.endpoint !== "string" ||
      !finiteJSON(request)) return null;
  const match = assetPath.exec(request.endpoint);
  // The whole path must match, including any trailing line terminator.
  return match?.[0] === request.endpoint ? `${match[1]}-<build-id>${match[2]}` : null;
}

// Only the declared browser producer owns this projection. Other requests keep
// their order and multiplicity; product IDs remain for ordinary normalization.
export function projectBuildIdResponses(value, entry, declarations, audit = () => {}, normalize = (value) => value) {
  const rules = validateBuildIds(declarations);
  if (!rules.length || entry?.id !== "control-ui" || !object(value) || !Array.isArray(value.requests)) return value;
  const assets = new Map(), other = [];
  for (const [index, request] of value.requests.entries()) {
    const endpoint = declaredAsset(request);
    if (!endpoint) { other.push(request); continue; }
    const at = `/requests/${index}`;
    const observation = { ...request, endpoint };
    audit("declaredIds", "declared Control UI asset build fingerprint", request.endpoint, endpoint, `${at}/endpoint`);
    if (Object.hasOwn(request, "elapsedMs") && Number.isFinite(request.elapsedMs)) {
      delete observation.elapsedMs;
      audit("measurements", "Control UI asset request elapsed time", request.elapsedMs, absent, `${at}/elapsedMs`);
    }
    if (!assets.has(endpoint)) assets.set(endpoint, new Map());
    const variants = assets.get(endpoint), key = observationKey(observation, normalize);
    if (!variants.has(key)) variants.set(key, { observation, paths: new Map() });
    const paths = variants.get(key).paths;
    if (!paths.has(request.endpoint)) paths.set(request.endpoint, []);
    paths.get(request.endpoint).push(index);
  }
  const projectedAssets = Object.fromEntries([...assets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([endpoint, variants]) => [
    endpoint,
    [...variants].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, { observation, paths }]) => {
      // Different built chunks can share one logical name. Retain the largest
      // same-URL multiplicity, and every distinct outcome or parameter variant.
      const ordered = [...paths].sort(([a, left], [b, right]) => right.length - left.length || (a < b ? -1 : a > b ? 1 : 0));
      const count = ordered[0][1].length;
      for (const [, indices] of ordered.slice(1)) for (const index of indices) {
        audit("derived", "equivalent asset observation from a distinct build fingerprint", value.requests[index], absent, `/requests/${index}`);
      }
      return { observation, count };
    })
  ]));
  audit("derived", "Control UI request positions and length derived from build assets", { type: "array", length: value.requests.length }, { type: "object", keys: ["assets", "other"] }, "/requests");
  // Brand the generated container so a malformed recorded object cannot
  // impersonate this projection. Keep ordinary requests directly traversable
  // by response measurement normalization; asset children still compare fully.
  return { ...value, requests: { assets: new VerifiedValue(projectedAssets), other } };
}
