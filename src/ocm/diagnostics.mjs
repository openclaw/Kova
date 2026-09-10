import { artifactExportArgs } from "./transport.mjs";

export function relativeOcmArtifactPath(path, root) {
  if (typeof path !== "string") throw new Error("invalid OCM artifact path");
  const relative = path.startsWith("./") ? path.slice(2) :
    root && path.startsWith(`${root.replace(/\/+$/, "")}/`) ? path.slice(root.replace(/\/+$/, "").length + 1) : path;
  artifactExportArgs("validation", relative, 0);
  return relative;
}
