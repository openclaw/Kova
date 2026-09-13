import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";

export async function rollingUpgradeResolverCheck(tmp, scope) {
  const dir = await mkdtemp(join(tmp, "rolling-upgrade-"));
  const timeFile = join(dir, "time.json");
  await writeFile(timeFile, `${JSON.stringify({
    time: {
      created: "2026-04-01T00:00:00.000Z",
      "2026.4.15": "2026-04-15T00:00:00.000Z",
      "2026.5.1": "2026-05-01T00:00:00.000Z",
      "2026.5.14": "2026-05-14T12:00:00.000Z",
      "2026.5.20": "2026-05-20T00:00:00.000Z",
      modified: "2026-05-21T00:00:00.000Z"
    }
  })}\n`, "utf8");
  const ocmPath = join(dir, "ocm");
  await writeFile(ocmPath, `#!/bin/sh\nprintf '{"ok":true,"args":['\nfirst=1\nfor arg in "$@"; do\n  if [ "$first" = 0 ]; then printf ','; fi\n  first=0\n  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$arg"\ndone\nprintf ']}\\n'\n`, "utf8");
  await chmod(ocmPath, 0o755);

  const day = await runCommand(
    `node support/resolve-openclaw-release-age.mjs --time-file ${quoteShell(timeFile)} --age day --now 2026-05-21T12:00:00.000Z`,
    { timeoutMs: 30000 }
  );
  if (day.status !== 0 || day.stdout.trim() !== "2026.5.20") {
    return {
      id: "rolling-upgrade-resolver",
      status: "FAIL",
      command: "node support/resolve-openclaw-release-age.mjs --age day",
      durationMs: day.durationMs,
      message: `day resolver expected 2026.5.20, got ${JSON.stringify(day.stdout.trim() || day.stderr.trim())}`
    };
  }
  const result = await runCommand(
    `node support/run-openclaw-release-age-upgrade.mjs --env ${quoteShell(scope.envName)} --age month --now 2026-05-21T12:00:00.000Z --time-file ${quoteShell(timeFile)} --json`,
    {
      shell: "/bin/sh",
      timeoutMs: 30000,
      maxOutputChars: 1000000,
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`
      }
    }
  );
  let upgrade = null;
  try {
    upgrade = JSON.parse(result.stdout);
  } catch {
    upgrade = null;
  }
  const args = upgrade?.ocm?.json?.args ?? [];
  const versionFlagIndex = args.indexOf("--version");
  if (result.status !== 0 || upgrade?.version !== "2026.4.15" || args[versionFlagIndex + 1] !== "2026.4.15") {
    return {
      id: "rolling-upgrade-resolver",
      status: "FAIL",
      command: result.command,
      durationMs: result.durationMs,
      message: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    };
  }
  return {
    id: "rolling-upgrade-resolver",
    status: "PASS",
    command: "resolve day/week/month source versions and run fake ocm upgrade",
    durationMs: day.durationMs + result.durationMs
  };
}
