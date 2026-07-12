export function isMissingOcmResource(result, kind, name) {
  const expected = `${kind} "${name}" does not exist`;
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`
    .split(/\r?\n/)
    .some((line) => line.trim() === expected || line.trim() === `ocm: ${expected}`);
}
