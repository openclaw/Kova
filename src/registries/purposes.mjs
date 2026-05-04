export const knownPurposes = [
  "diagnostic",
  "performance",
  "plugin",
  "provider",
  "regression",
  "release",
  "soak",
  "upgrade"
];

export function validatePurposes(values, key, errors, options = {}) {
  if (values === undefined && options.optional) {
    return;
  }
  if (!Array.isArray(values)) {
    errors.push(`${key} must be an array`);
    return;
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${key}[${index}] must be a non-empty string`);
      continue;
    }
    if (!knownPurposes.includes(value)) {
      errors.push(`${key}[${index}] references unknown purpose '${value}'`);
    }
  }
}

export function validatePurpose(value, key, errors, options = {}) {
  if (value === undefined && options.optional) {
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${key} must be a non-empty string`);
    return;
  }
  if (!knownPurposes.includes(value)) {
    errors.push(`${key} references unknown purpose '${value}'`);
  }
}
