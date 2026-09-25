import { processRolesDir } from "../paths.mjs";
import { assertNoShapeErrors, loadJsonRegistry, requireArray, requireKebabId, requireString } from "./validate.mjs";

export async function loadProcessRoles(selectedId) {
  return loadJsonRegistry({
    dir: processRolesDir,
    kind: "process role",
    selectedId,
    validate: validateProcessRoleShape
  });
}

export function validateProcessRoleShape(role, sourceName = "process-role") {
  const errors = [];
  requireKebabId(role, "id", errors);
  requireString(role, "title", errors);
  requireString(role, "description", errors);
  requireArray(role, "commandPatterns", errors);
  requireArray(role, "processPatterns", errors);

  for (const key of ["commandPatterns", "processPatterns"]) {
    if (!Array.isArray(role[key])) {
      continue;
    }
    for (const [index, pattern] of role[key].entries()) {
      if (typeof pattern !== "string") {
        errors.push(`${key}[${index}] must be a string`);
      }
    }
  }

  if (role.commandScopedProcessPatterns !== undefined) {
    requireArray(role, "commandScopedProcessPatterns", errors);
    if (Array.isArray(role.commandScopedProcessPatterns)) {
      for (const [index, scope] of role.commandScopedProcessPatterns.entries()) {
        for (const key of ["invocationPatterns", "commandPatterns", "processPatterns"]) {
          if (!Array.isArray(scope?.[key]) || scope[key].length === 0 ||
              scope[key].some((pattern) => typeof pattern !== "string" || !pattern.length)) {
            errors.push(`commandScopedProcessPatterns[${index}].${key} must be a nonempty string array`);
          }
        }
      }
    }
  }

  assertNoShapeErrors(errors, sourceName);
}
