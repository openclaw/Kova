/**
 * OG images can change when release data or card rendering is corrected.
 * Require caches to revalidate the stable URL instead of pinning stale bytes.
 */
export const MUTABLE_IMAGE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
