import { AsyncLocalStorage } from "node:async_hooks";

const commandEnvStorage = new AsyncLocalStorage();
const serviceIdentityVariables = new Set([
  "OCM_ACTIVE_ENV", "OCM_ACTIVE_ENV_ROOT", "INVOCATION_ID", "JOURNAL_STREAM",
  "NOTIFY_SOCKET", "SYSTEMD_EXEC_PID", "WATCHDOG_PID", "WATCHDOG_USEC",
  "LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES"
]);

export function scopedCommandEnvironment() {
  return commandEnvStorage.getStore() ?? {};
}

export function runWithCommandEnv(env, callback) {
  return commandEnvStorage.run(
    {
      ...(commandEnvStorage.getStore() ?? {}),
      ...(env ?? {})
    },
    callback
  );
}

// Ambient product paths and service identity must never cross into the lab.
// Only explicit Kova scopes may reintroduce OpenClaw variables.
export function commandEnvironment(overrides = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith("OPENCLAW_") && !name.startsWith("CLAWDBOT_") &&
    !name.startsWith("MOLTBOT_") && !serviceIdentityVariables.has(name)
  ));
  return { ...inherited, ...(commandEnvStorage.getStore() ?? {}), ...overrides };
}
