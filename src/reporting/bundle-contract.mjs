import { posix } from "node:path";
import { caseFold } from "unicode-case-folding";

export const MAX_BUNDLE_COMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_CHECKSUM_BYTES = 8 * 1024;
export const MAX_BUNDLE_UNPACKED_BYTES = 512 * 1024 * 1024;
export const MAX_BUNDLE_DECLARED_BYTES = 512 * 1024 * 1024;
export const MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024;
export const MAX_BUNDLE_PHYSICAL_HEADERS = 10_000;
export const MAX_BUNDLE_ENTRIES = 10_000;
export const MAX_BUNDLE_NAME_BYTES = 4 * 1024;
export const MAX_BUNDLE_PATH_DEPTH = 64;
export const MAX_BUNDLE_ANCESTORS = 100_000;

export function normalizeArchiveMember(name, type) {
  if (
    !name ||
    !["file", "directory"].includes(type) ||
    name.startsWith("/") ||
    /[<>:"\\|?*]/.test(name) ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
  ) {
    return null;
  }
  const hasTrailingSlash = name.endsWith("/");
  if (hasTrailingSlash && type !== "directory") {
    return null;
  }
  const canonicalName = hasTrailingSlash ? name.slice(0, -1) : name;
  const normalized = posix.normalize(canonicalName);
  const segments = canonicalName.split("/");
  if (
    normalized !== canonicalName ||
    segments.length === 0 ||
    segments.length > MAX_BUNDLE_PATH_DEPTH ||
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith("-") ||
      /[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(segment)
    )
  ) {
    return null;
  }
  const portableSegments = segments.map((segment) =>
    caseFold(segment.normalize("NFC")).normalize("NFC"));
  return {
    path: normalized,
    portablePath: portableSegments.join("/"),
    portableSegments
  };
}
