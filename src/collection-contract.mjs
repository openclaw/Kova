export const COLLECTION_INTENTS = ["full", "post-ready-health", "service-only", "skip-env"];

export function normalizeCollectionIntent(intent) {
  return COLLECTION_INTENTS.includes(intent) ? intent : "full";
}

export function validateCollectionIntent(intent, prefix, errors) {
  if (intent !== undefined && !COLLECTION_INTENTS.includes(intent)) {
    errors.push(`${prefix}.collectionIntent must be one of ${COLLECTION_INTENTS.join(", ")}`);
  }
}
