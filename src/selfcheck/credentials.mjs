import { link, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { runNodeProcess } from "./external-cli.mjs";
import { assertEqual } from "./harness.mjs";

export async function credentialStoreSelfCheck(tmp) {
  const home = join(tmp, "credentials-home");
  const command = `KOVA_HOME=${quoteShell(home)} node bin/kova.mjs setup --non-interactive --auth env-only --provider openai --env-var OPENAI_API_KEY --json`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const data = JSON.parse(result.stdout);
    assertEqual(data.schemaVersion, "kova.setup.v1", "setup schema");
    assertEqual(data.auth?.method, "env-only", "setup auth method");
    const liveEnv = join(home, "credentials", "live.env");
    const metadata = await stat(liveEnv);
    const mode = metadata.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`live.env permissions expected 0600, got ${mode.toString(8)}`);
    }
    return {
      id: "credential-store",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "credential-store",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function credentialStoreLegacyFallbackMigrationCheck(tmp) {
  const home = join(tmp, "legacy-fallback-credentials-home");
  const credentials = join(home, "credentials");
  const providersPath = join(credentials, "providers.json");
  const scriptPath = join(home, "load-store.mjs");
  const legacyProviders = {
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "mock",
        envVars: ["OPENAI_API_KEY"],
        fallbackPolicy: "mock",
        configuredAt: null
      }
    }
  };
  await mkdir(credentials, { recursive: true });
  await writeFile(providersPath, `${JSON.stringify(legacyProviders, null, 2)}\n`, "utf8");
  await writeFile(join(credentials, "live.env"), "", { encoding: "utf8", mode: 0o600 });
  await writeFile(
    scriptPath,
    `import { loadCredentialStore } from ${JSON.stringify(new URL("../auth.mjs", import.meta.url).href)};\n` +
      "console.log(JSON.stringify(await loadCredentialStore()));\n",
    "utf8"
  );

  const command = `KOVA_HOME=${quoteShell(home)} node ${quoteShell(scriptPath)}`;
  const result = await runCommand(command, { timeoutMs: 30000, maxOutputChars: 1000000 });
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
    }
    const loaded = JSON.parse(result.stdout);
    const persisted = JSON.parse(await readFile(providersPath, "utf8"));
    assertEqual(
      Object.hasOwn(loaded.providers.providers.openai, "fallbackPolicy"),
      false,
      "legacy fallback policy removed from loaded credentials"
    );
    assertEqual(
      Object.hasOwn(persisted.providers.openai, "fallbackPolicy"),
      false,
      "legacy fallback policy removed from persisted credentials"
    );
    return {
      id: "credential-store-legacy-fallback-migration",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "credential-store-legacy-fallback-migration",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function credentialStoreConcurrentWritersCheck(tmp) {
  const home = join(tmp, "concurrent-credentials-home");
  const credentials = join(home, "credentials");
  const staleLock = join(credentials, ".store.lock");
  const staleOwnerId = "00000000-0000-4000-8000-000000000000";
  const staleOwner = join(credentials, `.store.lock.owner-2147483647-${staleOwnerId}.json`);
  await mkdir(credentials, { recursive: true });
  await writeFile(staleOwner, `${JSON.stringify({
    pid: 2147483647,
    token: staleOwnerId,
    processStart: null,
    createdAt: new Date(0).toISOString()
  })}\n`, "utf8");
  await link(staleOwner, staleLock);
  const commands = Array.from({ length: 12 }, (_, index) => {
    const anthropic = index % 2 === 1;
    return [
      "setup",
      "auth",
      "--provider", anthropic ? "anthropic" : "openai",
      "--method", "api-key",
      "--env-var", anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
      "--value", anthropic ? "anth-value" : "open-value",
      "--json"
    ];
  });
  const startedAt = Date.now();
  try {
    const results = await Promise.all(commands.map((args) => runNodeProcess(args, {
      ...process.env,
      KOVA_HOME: home
    })));
    const failed = results.filter((result) => result.status !== 0);
    if (failed.length > 0) {
      throw new Error(failed.map((result) => result.stderr || `exit ${result.status}`).join("\n"));
    }

    const providers = JSON.parse(await readFile(join(credentials, "providers.json"), "utf8"));
    const liveEnv = await readFile(join(credentials, "live.env"), "utf8");
    assertEqual(providers.providers?.openai?.method, "api-key", "concurrent OpenAI provider");
    assertEqual(providers.providers?.anthropic?.method, "api-key", "concurrent Anthropic provider");
    assertEqual(liveEnv.includes("OPENAI_API_KEY=open-value"), true, "concurrent OpenAI key");
    assertEqual(liveEnv.includes("ANTHROPIC_API_KEY=anth-value"), true, "concurrent Anthropic key");
    const leftovers = (await readdir(credentials)).filter((name) =>
      name.startsWith(".store.") ||
      name.endsWith(".tmp")
    );
    assertEqual(leftovers.length, 0, "credential transaction cleanup");
    return {
      id: "credential-store-concurrent-writers",
      status: "PASS",
      command: "12 concurrent kova setup auth writers",
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      id: "credential-store-concurrent-writers",
      status: "FAIL",
      command: "12 concurrent kova setup auth writers",
      durationMs: Date.now() - startedAt,
      message: error.message
    };
  }
}

export async function credentialStoreInterruptedTransactionCheck(tmp) {
  const root = join(tmp, "credential-transaction-recovery");
  const scriptPath = join(root, "load-store.mjs");
  const previousProviders = {
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "mock",
        envVars: ["OPENAI_API_KEY"],
        configuredAt: null
      }
    }
  };
  const nextProviders = {
    schemaVersion: "kova.credentials.providers.v1",
    defaultProvider: "openai",
    providers: {
      openai: {
        id: "openai",
        method: "api-key",
        envVars: ["OPENAI_API_KEY"],
        externalCli: null,
        configuredAt: "2026-07-11T00:00:00.000Z"
      }
    }
  };
  const previous = {
    providersText: `${JSON.stringify(previousProviders, null, 2)}\n`,
    liveEnvText: "OPENAI_API_KEY=placeholder\n"
  };
  const next = {
    providersText: `${JSON.stringify(nextProviders, null, 2)}\n`,
    liveEnvText: "OPENAI_API_KEY=example\n"
  };
  const journal = `${JSON.stringify({
    schemaVersion: "kova.credentials.transaction.v1",
    id: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-11T00:00:00.000Z",
    previous,
    next
  })}\n`;
  await mkdir(root, { recursive: true });
  await writeFile(
    scriptPath,
    `import { loadCredentialStore } from ${JSON.stringify(new URL("../auth.mjs", import.meta.url).href)};\n` +
      `console.log(JSON.stringify(await loadCredentialStore()));\n`,
    "utf8"
  );

  const cases = [
    {
      id: "partial-live-env",
      providersText: previous.providersText,
      liveEnvText: next.liveEnvText,
      expected: previous
    },
    {
      id: "partial-providers",
      providersText: next.providersText,
      liveEnvText: previous.liveEnvText,
      expected: previous
    },
    {
      id: "complete-before-journal-removal",
      providersText: next.providersText,
      liveEnvText: next.liveEnvText,
      expected: next
    }
  ];
  const startedAt = Date.now();
  try {
    for (const testCase of cases) {
      const home = join(root, testCase.id);
      const credentials = join(home, "credentials");
      await mkdir(credentials, { recursive: true });
      await writeFile(join(credentials, "providers.json"), testCase.providersText, "utf8");
      await writeFile(join(credentials, "live.env"), testCase.liveEnvText, {
        encoding: "utf8",
        mode: 0o600
      });
      await writeFile(join(credentials, ".store.transaction.json"), journal, {
        encoding: "utf8",
        mode: 0o600
      });

      const result = await runCommand(
        `KOVA_HOME=${quoteShell(home)} node ${quoteShell(scriptPath)}`,
        { timeoutMs: 30000, maxOutputChars: 1000000 }
      );
      if (result.status !== 0) {
        throw new Error(`${testCase.id}: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      const loaded = JSON.parse(result.stdout);
      assertEqual(
        JSON.stringify(loaded.providers),
        JSON.stringify(JSON.parse(testCase.expected.providersText)),
        `${testCase.id} loaded providers`
      );
      assertEqual(
        loaded.liveEnv.OPENAI_API_KEY,
        testCase.expected.liveEnvText.includes("placeholder") ? "placeholder" : "example",
        `${testCase.id} loaded live env`
      );
      assertEqual(
        await readFile(join(credentials, "providers.json"), "utf8"),
        testCase.expected.providersText,
        `${testCase.id} recovered providers`
      );
      assertEqual(
        await readFile(join(credentials, "live.env"), "utf8"),
        testCase.expected.liveEnvText,
        `${testCase.id} recovered live env`
      );
      const leftovers = (await readdir(credentials)).filter((name) =>
        name.startsWith(".store.") || name.endsWith(".tmp")
      );
      assertEqual(leftovers.length, 0, `${testCase.id} transaction cleanup`);
    }
    return {
      id: "credential-store-interrupted-transaction",
      status: "PASS",
      command: "recover partial and complete credential transaction journals",
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      id: "credential-store-interrupted-transaction",
      status: "FAIL",
      command: "recover partial and complete credential transaction journals",
      durationMs: Date.now() - startedAt,
      message: error.message
    };
  }
}
