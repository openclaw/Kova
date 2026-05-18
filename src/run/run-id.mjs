import { randomBytes } from "node:crypto";

export function createRunId(now = new Date()) {
  const stamp = [
    String(now.getUTCFullYear()).slice(-2),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate())
  ].join("") + "-" + [
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds())
  ].join("");
  return `kova-${stamp}-${randomBytes(3).toString("hex")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
