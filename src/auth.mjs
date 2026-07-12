import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { credentialsDir, liveEnvPath, providersPath, repoRoot } from "./paths.mjs";
import { quoteShell } from "./commands.mjs";
import { ocmAt, ocmEnvExec } from "./ocm/commands.mjs";
import {
  externalCliVerificationSummary,
  resolveExternalCliName,
  verifyExternalCliAuth
} from "./external-cli-auth.mjs";

export const authModes = ["mock", "live", "skip"];
export const credentialMethods = ["mock", "api-key", "env-only", "external-cli", "oauth", "skip"];
export const authOverrideModes = ["default", "mock", "live", "skip", "missing", "broken", "none"];

const defaultProviderId = "openai";
const mockApiKey = "kova-mock-key";
const mockProviderModes = new Set([
  "normal",
  "slow",
  "timeout",
  "malformed",
  "protocol-failure",
  "streaming-stall",
  "disconnect-then-recover",
  "error-then-recover",
  "concurrent-pressure",
  "exec-tool-safety",
  "exec-tool-failure-only"
]);
const credentialStoreLockPath = join(credentialsDir, ".store.lock");
const credentialStoreTransactionPath = join(credentialsDir, ".store.transaction.json");
const credentialStoreLockTimeoutMs = 20000;
const credentialStoreLockOwnerPrefix = ".store.lock.owner-";
const credentialStoreLockReaperPrefix = ".store.lock.reaping-";

export async function ensureCredentialStore() {
  return withCredentialStoreLock(async () => {
    await ensureCredentialStoreUnlocked();
    return credentialStoreSummary(await loadCredentialStoreUnlocked());
  });
}

export async function configureCredentialProvider(options = {}) {
  return withCredentialStoreLock(async () => {
    await ensureCredentialStoreUnlocked();
    const providerId = options.provider ?? defaultProviderId;
    const method = options.method ?? "mock";
    if (!credentialMethods.includes(method)) {
      throw new Error(`unsupported auth method '${method}'; expected one of ${credentialMethods.join(", ")}`);
    }

    const metadata = await readProvidersMetadata();
    const liveEnv = await loadLiveEnv();
    const previousMetadata = structuredClone(metadata);
    const previousLiveEnv = { ...liveEnv };
    const envVar = options.envVar ?? defaultEnvVarForProvider(providerId);
    const externalCli = method === "external-cli"
      ? resolveExternalCliName(providerId, options.externalCli)
      : null;
    metadata.defaultProvider = providerId;
    metadata.providers = {
      ...(metadata.providers ?? {}),
      [providerId]: {
        id: providerId,
        method,
        envVars: method === "api-key" || method === "env-only" ? [envVar] : [],
        externalCli,
        configuredAt: new Date().toISOString()
      }
    };

    if (method === "api-key") {
      const value = options.value ?? process.env[envVar];
      if (!value) {
        throw new Error(`api-key setup requires --value <secret> or ${envVar} in the host environment`);
      }
      liveEnv[envVar] = value;
    }

    await writeCredentialStoreTransaction({
      metadata,
      liveEnv,
      previousMetadata,
      previousLiveEnv
    });
    return credentialStoreSummary({ providers: metadata, liveEnv });
  });
}

export async function resolveRunAuthContext(flags = {}) {
  const requestedMode = flags.auth ? String(flags.auth) : "mock";
  const explicitMode = flags.auth !== undefined;
  if (!authModes.includes(requestedMode)) {
    throw new Error(`--auth must be one of ${authModes.join(", ")}`);
  }
  const modelId = normalizeModelId(flags.model);
  if (modelId && requestedMode !== "live") {
    throw new Error("--model requires --auth live");
  }

  const store = await loadCredentialStore();
  const live = await verifyLiveCredentialStatus(liveCredentialStatus(store));
  if (requestedMode === "live" && !live.available && flags.source_env) {
    if (modelId) {
      throw new Error("--model cannot override auth inherited through --source-env");
    }
    const inheritedLive = {
      available: true,
      providerId: null,
      method: "source-env",
      externalCli: null,
      envVars: [],
      reason: `inherited from cloned source env ${flags.source_env}`,
      verification: {
        checked: false,
        status: "inherited-source-env",
        reason: "Kova will clone the source env and preserve its OpenClaw auth/config state"
      }
    };
    return {
      schemaVersion: "kova.auth.context.v1",
      requestedMode,
      explicitMode,
      modelId,
      credentialStore: credentialStoreSummary(store),
      liveEnv: store.liveEnv,
      live: inheritedLive,
      redactionValues: secretValues(store.liveEnv)
    };
  }
  if (requestedMode === "live" && !live.available) {
    throw new Error(`--auth live requires configured live credentials: ${live.reason}`);
  }

  return {
    schemaVersion: "kova.auth.context.v1",
    requestedMode,
    explicitMode,
    modelId,
    credentialStore: credentialStoreSummary(store),
    liveEnv: store.liveEnv,
    live,
    redactionValues: secretValues(store.liveEnv)
  };
}

export function scenarioAuthPolicy(context, scenario, state) {
  const override = normalizeAuthOverride(state?.auth?.mode ?? scenario?.auth?.mode ?? "default");
  if (["skip", "missing", "broken", "none"].includes(override)) {
    return {
      schemaVersion: "kova.auth.policy.v1",
      mode: override,
      providerId: null,
      source: `override:${override}`,
      setup: false,
      commandEnv: {},
      redactionValues: context.auth?.redactionValues ?? [],
      summary: authDisplay({ mode: override, providerId: null, source: `override:${override}`, setup: false })
    };
  }

  const requestedMode = context.auth?.explicitMode === true || override === "default"
    ? context.auth?.requestedMode ?? "mock"
    : override;
  if (requestedMode === "skip") {
    return {
      schemaVersion: "kova.auth.policy.v1",
      mode: "skip",
      providerId: null,
      source: "run-auth-skip",
      setup: false,
      commandEnv: {},
      redactionValues: context.auth?.redactionValues ?? [],
      summary: authDisplay({ mode: "skip", providerId: null, source: "run-auth-skip", setup: false })
    };
  }
  if (requestedMode === "live") {
    const live = context.auth?.live;
    if (!live?.available) {
      throw new Error(`live auth requested but credentials are unavailable: ${live?.reason ?? "not configured"}`);
    }
    const providerId = live.providerId;
    const modelId = context.auth?.modelId ?? null;
    const env = live.envVars.reduce((values, envVar) => {
      if (context.auth.liveEnv[envVar]) {
        values[envVar] = context.auth.liveEnv[envVar];
      } else if (process.env[envVar]) {
        values[envVar] = process.env[envVar];
      }
      return values;
    }, {});
    return {
      schemaVersion: "kova.auth.policy.v1",
      mode: "live",
      providerId,
      modelId,
      source: live.method,
      externalCli: live.externalCli ?? null,
      setup: live.method !== "source-env",
      setupKind: live.method === "source-env" ? "source-env-inherited" : liveAuthSetupKind(live),
      commandEnv: env,
      redactionValues: [...(context.auth?.redactionValues ?? []), ...secretValues(env)],
      summary: authDisplay({
        mode: "live",
        providerId,
        modelId,
        source: live.method,
        externalCli: live.externalCli ?? null,
        setup: live.method !== "source-env",
        setupKind: live.method === "source-env" ? "source-env-inherited" : liveAuthSetupKind(live),
        envVars: live.envVars
      })
    };
  }

  return {
    schemaVersion: "kova.auth.policy.v1",
    mode: "mock",
    providerId: defaultProviderId,
    source: "default-mock",
    mockProvider: mockProviderPolicy(scenario, state),
    setup: true,
    commandEnv: {
      OPENAI_API_KEY: mockApiKey
    },
    redactionValues: [...(context.auth?.redactionValues ?? []), mockApiKey],
    summary: authDisplay({
      mode: "mock",
      providerId: defaultProviderId,
      source: "default-mock",
      setup: true,
      envVars: ["OPENAI_API_KEY"],
      mockProvider: mockProviderPolicy(scenario, state)
    })
  };
}

export function buildAuthPreparePhase(authPolicy, artifactDir) {
  if (authPolicy.mode !== "mock") {
    return null;
  }
  const dir = mockDir(artifactDir);
  return {
    id: "auth-prepare",
    measurementScope: "harness",
    title: "Auth Prepare",
    intent: "Start Kova's deterministic mock provider for the disposable OpenClaw env.",
    collectionIntent: "skip-env",
    commands: [startMockProviderCommand(dir, authPolicy.mockProvider)],
    evidence: ["mock provider port", "mock provider request log", "mock provider behavior mode", "mock provider health"]
  };
}

export function buildAuthSetupPhase(authPolicy, envName, artifactDir) {
  if (!authPolicy.setup) {
    return null;
  }
  if (authPolicy.mode === "mock") {
    const dir = mockDir(artifactDir);
    return {
      id: "auth-setup",
      measurementScope: "harness",
      title: "Auth Setup",
      intent: "Configure the disposable OpenClaw env with Kova's mock provider auth.",
      collectionIntent: "service-only",
      commands: [configureMockAuthCommand(envName, dir, authPolicy.mockProvider)],
      evidence: ["OpenClaw config points to mock provider", "default agent model is openai/gpt-5.5"]
    };
  }
  return {
    id: "auth-setup",
    measurementScope: "harness",
    title: "Auth Setup",
    intent: liveAuthSetupIntent(authPolicy),
    collectionIntent: "service-only",
    commands: configureLiveAuthCommands(authPolicy, envName),
    evidence: liveAuthSetupEvidence(authPolicy)
  };
}

export function buildAuthCleanupPhase(authPolicy, artifactDir) {
  if (authPolicy.mode !== "mock") {
    return null;
  }
  const dir = mockDir(artifactDir);
  return {
    id: "auth-cleanup",
    measurementScope: "cleanup",
    title: "Auth Cleanup",
    intent: "Stop Kova's deterministic mock provider.",
    collectionIntent: "skip-env",
    commands: [mockProviderCleanupCommand(dir)],
    evidence: ["mock provider stopped"]
  };
}

export function authDisplay(policy) {
  return {
    schemaVersion: "kova.auth.summary.v1",
    mode: policy.mode,
    providerId: policy.providerId ?? null,
    modelId: policy.modelId ?? null,
    source: policy.source,
    externalCli: policy.externalCli ?? null,
    setup: policy.setup === true,
    setupKind: policy.setupKind ?? null,
    deterministic: policy.mode === "mock",
    environmentDependent: policy.mode === "live",
    envVars: policy.envVars ?? [],
    mockProvider: policy.mockProvider ? mockProviderDisplay(policy.mockProvider) : null,
    secretValues: "redacted"
  };
}

export function authReportSummary(authContext) {
  return {
    schemaVersion: "kova.auth.report.v1",
    requestedMode: authContext.requestedMode,
    modelId: authContext.modelId ?? null,
    credentialStore: authContext.credentialStore,
    live: {
      available: authContext.live.available,
      providerId: authContext.live.providerId,
      method: authContext.live.method,
      externalCli: authContext.live.externalCli ?? null,
      verification: authContext.live.verification ?? null,
      envVars: authContext.live.envVars,
      reason: authContext.live.reason,
      environmentDependent: authContext.requestedMode === "live"
    }
  };
}

export async function loadCredentialStore() {
  return withCredentialStoreLock(async () => {
    await ensureCredentialStoreUnlocked();
    return loadCredentialStoreUnlocked();
  });
}

async function loadCredentialStoreUnlocked() {
  const providers = await readProvidersMetadata();
  const liveEnv = await loadLiveEnv();
  return {
    schemaVersion: "kova.credentials.store.v1",
    providers,
    liveEnv
  };
}

function defaultProvidersMetadata() {
  return {
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: defaultProviderId,
    providers: {
      [defaultProviderId]: {
        id: defaultProviderId,
        method: "mock",
        envVars: ["OPENAI_API_KEY"],
        configuredAt: null
      }
    }
  };
}

async function readProvidersMetadata() {
  try {
    const text = await readFile(providersPath, "utf8");
    const metadata = JSON.parse(text);
    validateProvidersMetadata(metadata);
    return metadata;
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaultProvidersMetadata();
    }
    throw error;
  }
}

function validateProvidersMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("providers.json must contain an object");
  }
  if (metadata.schemaVersion !== "kova.credentials.providers.v1") {
    throw new Error("providers.json schemaVersion must be kova.credentials.providers.v1");
  }
  if (!metadata.providers || typeof metadata.providers !== "object" || Array.isArray(metadata.providers)) {
    throw new Error("providers.json providers must be an object");
  }
  if (!metadata.defaultProvider || !metadata.providers[metadata.defaultProvider]) {
    throw new Error("providers.json defaultProvider must reference a configured provider");
  }
  for (const [id, provider] of Object.entries(metadata.providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error(`providers.${id} must be an object`);
    }
    if (provider.id !== id) {
      throw new Error(`providers.${id}.id must match provider key`);
    }
    if (!credentialMethods.includes(provider.method)) {
      throw new Error(`providers.${id}.method must be one of ${credentialMethods.join(", ")}`);
    }
    if (provider.fallbackPolicy !== undefined) {
      throw new Error(`providers.${id}.fallbackPolicy is not supported`);
    }
    if (provider.envVars !== undefined && !Array.isArray(provider.envVars)) {
      throw new Error(`providers.${id}.envVars must be an array`);
    }
    if (provider.method === "external-cli") {
      resolveExternalCliName(id, provider.externalCli);
    } else if (provider.externalCli !== undefined && provider.externalCli !== null) {
      throw new Error(`providers.${id}.externalCli is only valid for method external-cli`);
    }
  }
}

async function loadLiveEnv() {
  try {
    return parseEnvFile(await readFile(liveEnvPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeProvidersMetadata(metadata) {
  validateProvidersMetadata(metadata);
  await atomicWriteFile(providersPath, `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
}

async function writeCredentialStoreTransaction({
  metadata,
  liveEnv,
  previousMetadata,
  previousLiveEnv
}) {
  validateProvidersMetadata(metadata);
  const transaction = {
    schemaVersion: "kova.credentials.transaction.v1",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    previous: credentialStoreState(previousMetadata, previousLiveEnv),
    next: credentialStoreState(metadata, liveEnv)
  };
  let journalPublished = false;
  try {
    await atomicWriteFile(
      credentialStoreTransactionPath,
      `${JSON.stringify(transaction)}\n`,
      0o600
    );
    journalPublished = true;
    await syncDirectory(credentialsDir);
    await commitCredentialStoreState(transaction.next);
    await removeCredentialStoreTransaction();
  } catch (error) {
    if (!journalPublished) {
      throw error;
    }
    let outcome;
    try {
      outcome = await recoverCredentialStoreTransaction();
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "credential transaction failed and recovery also failed"
      );
    }
    if (outcome === "committed") {
      return;
    }
    throw error;
  }
}

async function ensureCredentialStoreUnlocked() {
  await mkdir(credentialsDir, { recursive: true });
  await recoverCredentialStoreTransaction();
  await removeAbandonedCredentialStoreTemps();
  if (!(await pathExists(liveEnvPath))) {
    await atomicWriteFile(liveEnvPath, "", 0o600);
  } else {
    await chmod(liveEnvPath, 0o600);
  }
  if (!(await pathExists(providersPath))) {
    await writeProvidersMetadata(defaultProvidersMetadata());
  }
}

function credentialStoreState(metadata, liveEnv) {
  validateProvidersMetadata(metadata);
  return {
    providersText: `${JSON.stringify(metadata, null, 2)}\n`,
    liveEnvText: serializeLiveEnv(liveEnv)
  };
}

async function commitCredentialStoreState(state) {
  validateCredentialStoreState(state);
  let stagedLiveEnv;
  let stagedProviders;
  try {
    stagedLiveEnv = await stageFile(liveEnvPath, state.liveEnvText, 0o600);
    stagedProviders = await stageFile(providersPath, state.providersText, 0o600);
    await commitStagedFile(stagedLiveEnv);
    await commitStagedFile(stagedProviders);
    await syncDirectory(credentialsDir);
  } finally {
    const stagedFiles = [stagedLiveEnv, stagedProviders].filter(Boolean);
    await Promise.all(stagedFiles.map((staged) => discardStagedFile(staged)));
  }
}

async function recoverCredentialStoreTransaction() {
  let transaction;
  try {
    transaction = parseCredentialStoreTransaction(
      await readFile(credentialStoreTransactionPath, "utf8")
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return "none";
    }
    throw error;
  }

  const [providersText, liveEnvText] = await Promise.all([
    readFileIfExists(providersPath),
    readFileIfExists(liveEnvPath)
  ]);
  const nextCommitted = providersText === transaction.next.providersText &&
    liveEnvText === transaction.next.liveEnvText;
  if (nextCommitted) {
    await syncDirectory(credentialsDir);
  } else {
    await commitCredentialStoreState(transaction.previous);
  }
  await removeCredentialStoreTransaction();
  return nextCommitted ? "committed" : "rolled-back";
}

function parseCredentialStoreTransaction(contents) {
  const transaction = JSON.parse(contents);
  if (transaction?.schemaVersion !== "kova.credentials.transaction.v1" ||
      typeof transaction.id !== "string" ||
      typeof transaction.createdAt !== "string") {
    throw new Error("invalid credential transaction journal");
  }
  validateCredentialStoreState(transaction.previous);
  validateCredentialStoreState(transaction.next);
  return transaction;
}

function validateCredentialStoreState(state) {
  if (!state || typeof state !== "object" ||
      typeof state.providersText !== "string" ||
      typeof state.liveEnvText !== "string") {
    throw new Error("invalid credential transaction state");
  }
  validateProvidersMetadata(JSON.parse(state.providersText));
  parseEnvFile(state.liveEnvText);
}

async function removeCredentialStoreTransaction() {
  await unlink(credentialStoreTransactionPath);
  await syncDirectory(credentialsDir);
}

async function removeAbandonedCredentialStoreTemps() {
  const entries = await readdir(credentialsDir);
  const prefixes = [
    `${basename(credentialStoreTransactionPath)}.`,
    `${basename(providersPath)}.`,
    `${basename(liveEnvPath)}.`
  ];
  await Promise.all(entries
    .filter((entry) => entry.endsWith(".tmp") && prefixes.some((prefix) => entry.startsWith(prefix)))
    .map((entry) => unlink(join(credentialsDir, entry)).catch(() => {})));
}

async function readFileIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" ||
        !["EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function atomicWriteFile(path, contents, mode) {
  const staged = await stageFile(path, contents, mode);
  try {
    await commitStagedFile(staged);
  } finally {
    await discardStagedFile(staged);
  }
}

async function stageFile(path, contents, mode) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    return { path, temporaryPath, committed: false };
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function commitStagedFile(staged) {
  await rename(staged.temporaryPath, staged.path);
  staged.committed = true;
}

async function discardStagedFile(staged) {
  if (!staged.committed) {
    await unlink(staged.temporaryPath).catch(() => {});
  }
}

async function acquireCredentialStoreLock() {
  const token = randomUUID();
  const processStart = await processStartIdentity(process.pid);
  const ownerPath = credentialStoreLockOwnerPath(process.pid, token);
  let handle;
  try {
    handle = await open(ownerPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      token,
      processStart,
      createdAt: new Date().toISOString()
    })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(ownerPath, credentialStoreLockPath);
    return { token, ownerPath };
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(ownerPath).catch(() => {});
    throw error;
  }
}

async function withCredentialStoreLock(callback) {
  await mkdir(credentialsDir, { recursive: true });
  const startedAt = Date.now();
  let lockHandle;
  while (!lockHandle) {
    try {
      lockHandle = await acquireCredentialStoreLock();
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleCredentialStoreLock()) {
        continue;
      }
      if (Date.now() - startedAt >= credentialStoreLockTimeoutMs) {
        throw new Error(`timed out waiting for credential store lock ${credentialStoreLockPath}`);
      }
      await delay(25);
    }
  }

  try {
    return await callback();
  } finally {
    await releaseCredentialStoreLock(lockHandle);
  }
}

async function removeStaleCredentialStoreLock() {
  let owner;
  try {
    owner = parseCredentialStoreLockOwner(await readFile(credentialStoreLockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    return false;
  }

  if (!(await credentialStoreLockOwnerIsStale(owner))) {
    return false;
  }

  const reaperPath = await claimStaleCredentialStoreLock(owner);
  if (!reaperPath) {
    return false;
  }

  try {
    const currentOwner = parseCredentialStoreLockOwner(await readFile(credentialStoreLockPath, "utf8"));
    if (currentOwner.token !== owner.token) {
      return false;
    }
    await unlink(credentialStoreLockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }
    throw error;
  } finally {
    await unlink(reaperPath).catch(() => {});
  }
}

async function releaseCredentialStoreLock(lock) {
  try {
    const owner = parseCredentialStoreLockOwner(await readFile(credentialStoreLockPath, "utf8"));
    if (owner.token !== lock.token) {
      throw new Error("credential store lock ownership was lost");
    }
    await unlink(credentialStoreLockPath);
    await unlink(lock.ownerPath);
    return;
  } catch (error) {
    throw new Error(`credential store lock ownership was lost: ${error.message}`, { cause: error });
  }
}

async function claimStaleCredentialStoreLock(owner) {
  const ownerPath = credentialStoreLockOwnerPath(owner.pid, owner.token);
  const reaperPath = await createCredentialStoreReaperPath(owner.token);
  try {
    await rename(ownerPath, reaperPath);
    return reaperPath;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const prefix = `${credentialStoreLockReaperPrefix}${owner.token}-`;
  const entries = await readdir(credentialsDir);
  for (const name of entries.filter((entry) => entry.startsWith(prefix))) {
    if (await credentialStoreReaperIsActive(name, prefix)) {
      return null;
    }
    try {
      await rename(join(credentialsDir, name), reaperPath);
      return reaperPath;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

async function createCredentialStoreReaperPath(ownerToken) {
  const processStart = await processStartIdentity(process.pid);
  return join(
    credentialsDir,
    `${credentialStoreLockReaperPrefix}${ownerToken}-${process.pid}-${hashProcessStart(processStart)}-${randomUUID()}`
  );
}

async function credentialStoreLockOwnerIsStale(owner) {
  if (!(await processIsRunning(owner.pid))) {
    return true;
  }
  if (!owner.processStart) {
    return false;
  }
  const currentStart = await processStartIdentity(owner.pid);
  return currentStart !== null && currentStart !== owner.processStart;
}

async function credentialStoreReaperIsActive(name, prefix) {
  const match = name.slice(prefix.length).match(/^(\d+)-(unknown|[0-9a-f]{16})-/);
  if (!match) {
    return true;
  }
  const pid = Number(match[1]);
  const expectedStartHash = match[2];
  if (!Number.isSafeInteger(pid) || pid <= 0 || !(await processIsRunning(pid))) {
    return false;
  }
  if (expectedStartHash === "unknown") {
    return true;
  }
  const currentStart = await processStartIdentity(pid);
  return currentStart === null || hashProcessStart(currentStart) === expectedStartHash;
}

function parseCredentialStoreLockOwner(contents) {
  const owner = JSON.parse(contents);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.token !== "string" || !/^[0-9a-f-]{36}$/i.test(owner.token) ||
      !(owner.processStart === null || typeof owner.processStart === "string")) {
    throw new Error("invalid credential store lock owner");
  }
  return owner;
}

async function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") {
      return false;
    }
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    // kill(pid, 0) reports zombies as present, but they can never release a
    // held lock. Check the Linux process state before treating the owner as live.
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = statLine.lastIndexOf(")");
    const state = statLine.slice(commandEnd + 1).trim().split(/\s+/, 1)[0];
    return commandEnd <= 0 || state !== "Z";
  } catch {
    return true;
  }
}

function credentialStoreLockOwnerPath(pid, token) {
  return join(credentialsDir, `${credentialStoreLockOwnerPrefix}${pid}-${token}.json`);
}

function hashProcessStart(processStart) {
  return processStart
    ? createHash("sha256").update(processStart).digest("hex").slice(0, 16)
    : "unknown";
}

async function processStartIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const [bootId, statLine] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8")
      ]);
      const commandEnd = statLine.lastIndexOf(")");
      const fields = statLine.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      return commandEnd > 0 && startTicks
        ? `linux:${bootId.trim()}:${startTicks}`
        : null;
    } catch {
      return null;
    }
  }
  const command = process.platform === "win32"
    ? {
        binary: windowsPowerShellPath(),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
        ]
      }
    : {
        binary: "/bin/ps",
        args: ["-o", "lstart=", "-p", String(pid)]
      };
  return new Promise((resolve) => {
    execFile(command.binary, command.args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 2000
    }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot must be an absolute path");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeLiveEnv(values) {
  const text = Object.entries(values)
    .map(([key, value]) => `${key}=${escapeEnvValue(value)}`)
    .join("\n");
  return text ? `${text}\n` : "";
}

function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      throw new Error(`invalid live.env line: ${rawLine}`);
    }
    const key = line.slice(0, index).trim();
    const value = unquoteEnvValue(line.slice(index + 1).trim());
    values[key] = value;
  }
  return values;
}

function escapeEnvValue(value) {
  const string = String(value);
  if (/^[A-Za-z0-9_./:@+-]*$/.test(string)) {
    return string;
  }
  return JSON.stringify(string);
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function liveCredentialStatus(store) {
  const providers = store.providers.providers ?? {};
  const defaultId = store.providers.defaultProvider ?? defaultProviderId;
  const candidates = [providers[defaultId], ...Object.values(providers).filter((provider) => provider?.id !== defaultId)].filter(Boolean);
  for (const provider of candidates) {
    if (!provider || provider.method === "mock" || provider.method === "skip") {
      continue;
    }
    const envVars = provider.envVars ?? [];
    if (provider.method === "api-key" || provider.method === "env-only") {
      const missing = envVars.filter((envVar) => !store.liveEnv[envVar] && !process.env[envVar]);
      if (missing.length > 0) {
        return {
          available: false,
          providerId: provider.id,
          method: provider.method,
          envVars,
          reason: `missing env var(s): ${missing.join(", ")}`
        };
      }
    }
    return {
      available: true,
      providerId: provider.id,
      method: provider.method,
      externalCli: provider.externalCli ?? null,
      envVars,
      reason: "configured"
    };
  }
  return {
    available: false,
    providerId: defaultId,
    method: providers[defaultId]?.method ?? "mock",
    externalCli: providers[defaultId]?.externalCli ?? null,
    envVars: providers[defaultId]?.envVars ?? [],
    reason: "no live provider configured"
  };
}

async function verifyLiveCredentialStatus(status) {
  if (status.method !== "external-cli") {
    return status;
  }
  if (!status.externalCli) {
    return {
      ...status,
      available: false,
      reason: "external-cli provider has no externalCli value"
    };
  }
  const verification = await verifyExternalCliAuth(status.externalCli);
  return {
    ...status,
    available: verification.verified,
    reason: verification.verified ? "configured" : `external-cli ${status.externalCli} is not usable: ${verification.reason}`,
    verification: externalCliVerificationSummary(verification)
  };
}

function credentialStoreSummary(store) {
  const providers = store.providers.providers ?? {};
  return {
    schemaVersion: "kova.credentials.summary.v1",
    home: credentialsDir,
    providersPath,
    liveEnvPath,
    defaultProvider: store.providers.defaultProvider ?? defaultProviderId,
    providers: Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, {
      id,
      method: provider.method,
      envVars: provider.envVars ?? [],
      externalCli: provider.externalCli ?? null,
      configured: provider.method !== "mock" && provider.method !== "skip"
    }]))
  };
}

function secretValues(values) {
  return Object.values(values ?? {}).filter((value) => typeof value === "string" && value.length > 0);
}

function normalizeAuthOverride(value) {
  const mode = value ?? "default";
  if (!authOverrideModes.includes(mode)) {
    throw new Error(`auth.mode must be one of ${authOverrideModes.join(", ")}`);
  }
  return mode;
}

function mockDir(artifactDir) {
  return join(artifactDir, "mock-openai");
}

function startMockProviderCommand(dir, mockProvider = {}) {
  const portFile = join(dir, "port");
  const requestLog = join(dir, "requests.jsonl");
  const serverLog = join(dir, "server.log");
  const pidFile = join(dir, "pid");
  const scriptPath = join(dir, "script.json");
  const mode = mockProvider.mode ?? "normal";
  const scriptArgs = [
    "--output", scriptPath,
    "--marker", "KOVA_AGENT_OK",
    "--mode", mode
  ];
  if (Array.isArray(mockProvider.channelWorkflowCases) && mockProvider.channelWorkflowCases.length > 0) {
    scriptArgs.push("--channel-workflow-cases", mockProvider.channelWorkflowCases.join(","));
  }
  for (const [key, flag] of [
    ["delayMs", "--delay-ms"],
    ["stallMs", "--stall-ms"],
    ["errorStatus", "--error-status"]
  ]) {
    if (mockProvider[key] !== undefined) {
      scriptArgs.push(flag, String(mockProvider[key]));
    }
  }
  const scriptArgText = scriptArgs.map(quoteShell).join(" ");
  const writePort = [
    "node",
    "-e",
    quoteShell("const fs=require('fs'); const [logPath, portPath] = process.argv.slice(1); const line=fs.readFileSync(logPath,'utf8').split(/\\r?\\n/).find(Boolean); if (!line) process.exit(1); const startup=JSON.parse(line); if (!startup.port) process.exit(1); fs.writeFileSync(portPath, String(startup.port));"),
    quoteShell(serverLog),
    quoteShell(portFile)
  ].join(" ");
  const cleanup = mockProviderCleanupCommand(dir);
  return [
    `mkdir -p ${quoteShell(dir)}`,
    `${cleanup} || exit $?`,
    `node ${quoteShell(join(repoRoot, "support/write-mock-ai-provider-script.mjs"))} ${scriptArgText}`,
    mockAiProviderServeCommand({ scriptPath, requestLog, serverLog, pidFile }),
    `for i in $(seq 1 100); do ${writePort} >/dev/null 2>&1 && test -s ${quoteShell(portFile)} && node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$(cat ${quoteShell(portFile)})" && exit 0; sleep 0.1; done`,
    cleanup,
    `cat ${quoteShell(serverLog)} >&2`,
    "exit 1"
  ].join("; ");
}

export function mockAiProviderServeCommand({ scriptPath, requestLog, serverLog, pidFile }) {
  const bin = quoteShell(join(repoRoot, "node_modules/.bin/mock-ai-provider"));
  const args = `serve --providers openai --script ${quoteShell(scriptPath)} --port 0 --request-log ${quoteShell(requestLog)}`;
  const output = `>${quoteShell(serverLog)} 2>&1 & echo $! >${quoteShell(pidFile)}`;
  return `test -x ${bin} || { echo "Kova requires the local npm package mock-ai-provider; run npm install in the Kova repo" >&2; exit 127; }; ${bin} ${args} ${output}`;
}

export function mockProviderCleanupCommand(dir) {
  const values = {
    pidFile: join(dir, "pid"),
    executablePath: join(repoRoot, "node_modules/.bin/mock-ai-provider"),
    scriptPath: join(dir, "script.json"),
    requestLog: join(dir, "requests.jsonl")
  };
  return [
    "node",
    quoteShell(join(repoRoot, "support/stop-mock-ai-provider.mjs")),
    "--pid-file", quoteShell(values.pidFile),
    "--executable", quoteShell(values.executablePath),
    "--script", quoteShell(values.scriptPath),
    "--request-log", quoteShell(values.requestLog)
  ].join(" ");
}

function mockProviderPolicy(scenario, state) {
  const raw = {
    ...(state?.mockProvider ?? {}),
    ...(scenario?.mockProvider ?? {})
  };
  const mode = raw.mode ?? "normal";
  if (!mockProviderModes.has(mode)) {
    throw new Error(`mockProvider.mode must be one of ${[...mockProviderModes].join(", ")}`);
  }
  const policy = { mode };
  for (const key of ["delayMs", "stallMs", "errorStatus", "concurrency"]) {
    if (raw[key] !== undefined) {
      const value = Number(raw[key]);
      const valid = key === "concurrency"
        ? Number.isInteger(value) && value > 0
        : Number.isInteger(value) && value >= 0;
      if (!valid) {
        throw new Error(`mockProvider.${key} must be a ${key === "concurrency" ? "positive" : "non-negative"} integer`);
      }
      policy[key] = value;
    }
  }
  if (raw.channelWorkflowCases !== undefined) {
    policy.channelWorkflowCases = raw.channelWorkflowCases === true
      ? collectChannelWorkflowCaseOrder(scenario)
      : [];
  }
  if (raw.gatewayHttpEndpoints !== undefined) {
    const endpoints = Array.isArray(raw.gatewayHttpEndpoints) ? raw.gatewayHttpEndpoints : [];
    const normalized = endpoints.map((value) => String(value).trim()).filter(Boolean);
    const supported = new Set(["chatCompletions", "responses"]);
    const unsupported = normalized.filter((value) => !supported.has(value));
    if (unsupported.length > 0) {
      throw new Error(`mockProvider.gatewayHttpEndpoints contains unsupported endpoint(s): ${unsupported.join(", ")}`);
    }
    policy.gatewayHttpEndpoints = [...new Set(normalized)];
  }
  return policy;
}

function collectChannelWorkflowCaseOrder(scenario) {
  const cases = [];
  for (const phase of scenario?.phases ?? []) {
    for (const command of phase.commands ?? []) {
      if (typeof command !== "string" || !command.includes("run-channel-")) {
        continue;
      }
      const match = command.match(/\s--case\s+([^\s]+)/);
      if (!match) {
        continue;
      }
      cases.push(...match[1].split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return cases;
}

function mockProviderDisplay(policy) {
  return {
    mode: policy.mode,
    delayMs: policy.delayMs ?? null,
    stallMs: policy.stallMs ?? null,
    errorStatus: policy.errorStatus ?? null,
    concurrency: policy.concurrency ?? null
  };
}

function configureMockAuthCommand(envName, dir, mockProvider = {}) {
  const args = [
    "node",
    join(repoRoot, "support/configure-openclaw-mock-auth.mjs"),
    "--port-file",
    join(dir, "port")
  ];
  for (const endpoint of mockProvider.gatewayHttpEndpoints ?? []) {
    args.push("--gateway-http-endpoint", endpoint);
  }
  return ocmEnvExec(envName, args);
}

function configureLiveAuthCommands(authPolicy, envName) {
  const commands = authPolicy.setupKind === "openclaw-onboard"
    ? [configureLiveAuthViaOpenClawOnboardCommand(authPolicy, envName)]
    : [configureLiveAuthConfigPatchCommand(authPolicy, envName)];
  if (authPolicy.setupKind === "openclaw-onboard" && authPolicy.modelId) {
    commands.push(configureLiveAuthConfigPatchCommand(authPolicy, envName));
  }
  return commands;
}

function configureLiveAuthConfigPatchCommand(authPolicy, envName) {
  const envVar = authPolicy.summary.envVars?.[0] ?? defaultEnvVarForProvider(authPolicy.providerId);
  const args = [
    "node",
    join(repoRoot, "support/configure-openclaw-live-auth.mjs"),
    "--provider",
    authPolicy.providerId,
    "--env-var",
    envVar
  ];
  if (authPolicy.source === "external-cli" && authPolicy.externalCli) {
    args.push("--auth-method", "external-cli", "--external-cli", authPolicy.externalCli);
  }
  if (authPolicy.modelId) {
    args.push("--model", authPolicy.modelId);
  }
  return ocmEnvExec(envName, args);
}

function configureLiveAuthViaOpenClawOnboardCommand(authPolicy, envName) {
  const onboard = liveOnboardConfig(authPolicy);
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode", "local",
    "--auth-choice", onboard.authChoice,
    "--skip-health",
    "--skip-ui",
    "--skip-search",
    "--skip-skills",
    "--skip-channels",
    "--skip-bootstrap",
    "--no-install-daemon",
    "--json"
  ];
  if (onboard.secretInputMode) {
    args.push("--secret-input-mode", onboard.secretInputMode);
  }
  return ocmAt(envName, args);
}

function liveAuthSetupKind(live) {
  if (live.method === "api-key" || live.method === "env-only") {
    if (live.providerId === "openai" || live.providerId === "anthropic") {
      return "openclaw-onboard";
    }
  }
  if (live.method === "external-cli" && live.providerId === "anthropic") {
    return "openclaw-onboard";
  }
  return "fixture-config-patch";
}

function liveAuthSetupIntent(authPolicy) {
  if (authPolicy.setupKind === "openclaw-onboard") {
    return "Configure the disposable OpenClaw env through OpenClaw's own non-interactive onboarding/auth path using env-backed SecretRefs where applicable.";
  }
  return "Patch the disposable OpenClaw env with fixture live auth config; this proves runtime behavior, not OpenClaw onboarding/auth UX.";
}

function liveAuthSetupEvidence(authPolicy) {
  const modelEvidence = authPolicy.modelId ? [`requested model ${authPolicy.modelId} selected`] : [];
  if (authPolicy.setupKind === "openclaw-onboard") {
    return ["OpenClaw onboard command completed", "OpenClaw config references live auth env vars or selected external CLI", ...modelEvidence, "live auth is environment-dependent"];
  }
  return ["fixture auth config applied", "OpenClaw config references live auth env vars or selected external CLI", ...modelEvidence, "live auth is environment-dependent"];
}

function liveOnboardConfig(authPolicy) {
  if (authPolicy.source === "external-cli" && authPolicy.providerId === "anthropic") {
    return {
      authChoice: "anthropic-cli",
      secretInputMode: null
    };
  }
  if (authPolicy.providerId === "openai") {
    return {
      authChoice: "openai-api-key",
      secretInputMode: "ref"
    };
  }
  if (authPolicy.providerId === "anthropic") {
    return {
      authChoice: "apiKey",
      secretInputMode: "ref"
    };
  }
  throw new Error(`provider ${authPolicy.providerId} does not have a supported OpenClaw non-interactive live auth setup path`);
}

function defaultEnvVarForProvider(providerId) {
  if (providerId === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  return "OPENAI_API_KEY";
}

function normalizeModelId(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("--model requires a non-empty model id");
  }
  return value.trim();
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
