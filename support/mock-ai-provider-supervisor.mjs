#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { access, rename, rm, writeFile } from "node:fs/promises";
import { createMockAiProviderServer } from "mock-ai-provider/dist/server/create-server.js";
import { listen } from "mock-ai-provider/dist/server/listen.js";
import {
  mockProviderOwnerRecord,
  mockProviderStopFile,
  removeMockProviderOwnerFile
} from "../src/process-safety.mjs";

const options = parseArgs(process.argv.slice(2));
const owner = mockProviderOwnerRecord(process.pid, randomUUID());

try {
  await supervise(options, owner);
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}

async function supervise({ scriptPath, requestLog, serverLog, pidFile }, owner) {
  const stopFile = mockProviderStopFile(pidFile, owner);
  const startupLog = `${serverLog}.startup.${owner.pid}.${owner.token}`;
  await rm(stopFile, { force: true });
  await rm(startupLog, { force: true });

  let server = null;
  let interval = null;
  let stopping = null;
  const stopServer = async () => {
    if (!server) {
      return;
    }
    if (!stopping) {
      stopping = closeServer(server);
    }
    await stopping;
  };
  const handleSignal = () => void stopServer();

  try {
    server = await createMockAiProviderServer({
      providers: ["openai"],
      scriptPath,
      requestLogPath: requestLog,
      openAiAuth: { strict: false }
    });
    const serverClosed = new Promise((resolve) => {
      server.once("close", resolve);
    });
    const { port } = await listen(server, { port: 0, host: "127.0.0.1" });
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    await writeFile(startupLog, `${JSON.stringify({
      ok: true,
      owner,
      providers: ["openai"],
      host: "127.0.0.1",
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      script: {
        source: "file",
        path: scriptPath
      },
      models: {
        source: "default"
      },
      requestLog,
      auth: {
        strict: false,
        apiKeyConfigured: false
      }
    })}\n`, "utf8");
    await writeFile(pidFile, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(startupLog, serverLog);

    // Cleanup requests never signal a persisted PID; this process owns the
    // server handle and closes its active connections before exiting.
    interval = setInterval(() => {
      void access(stopFile)
        .then(stopServer)
        .catch((error) => {
          if (error.code !== "ENOENT") {
            void stopServer();
          }
        });
    }, 50);
    interval.unref();
    await serverClosed;
  } catch (error) {
    await stopServer();
    throw error;
  } finally {
    clearInterval(interval);
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await removeControlFile(startupLog);
    await cleanupControlFiles(pidFile, owner);
  }
}

async function closeServer(server) {
  const closed = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  const forceTimer = setTimeout(() => {
    server.closeAllConnections();
  }, 3000);
  forceTimer.unref();
  try {
    await closed;
  } finally {
    clearTimeout(forceTimer);
  }
}

async function cleanupControlFiles(pidFile, owner) {
  await removeControlFile(mockProviderStopFile(pidFile, owner));
  await removeMockProviderOwnerFile(pidFile, `${JSON.stringify(owner)}\n`);
}

async function removeControlFile(path) {
  try {
    await rm(path, { force: true });
  } catch (error) {
    if (error.code !== "EISDIR") {
      throw error;
    }
  }
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${flag ?? ""}`);
    }
    values[flag.slice(2)] = value;
  }
  for (const key of ["script", "request-log", "server-log", "pid-file"]) {
    if (!values[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return {
    scriptPath: values.script,
    requestLog: values["request-log"],
    serverLog: values["server-log"],
    pidFile: values["pid-file"]
  };
}
