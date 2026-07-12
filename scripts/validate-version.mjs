#!/usr/bin/env node

const [version] = process.argv.slice(2);

if (!isValidSemver(version)) {
  console.error("error: version must be valid SemVer, such as 1.2.3 or 1.0.0-beta.1");
  process.exit(1);
}

function isValidSemver(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) {
    return false;
  }
  const prerelease = match[4];
  if (prerelease && !prerelease.split(".").every((identifier) =>
    identifier.length > 0 && (!/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0"))
  )) {
    return false;
  }
  const build = match[5];
  return !build || build.split(".").every((identifier) => identifier.length > 0);
}
