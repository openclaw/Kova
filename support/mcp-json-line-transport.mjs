export function createJsonLineTransport(processHandle, recordMessage) {
  let nextId = 1;
  let stdout = "";
  const pending = new Map();
  let spawnError;
  let spawned = false;

  processHandle.stderrText = "";

  processHandle.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = stdout.slice(0, newline).replace(/\r$/, "");
      stdout = stdout.slice(newline + 1);
      if (line.trim().length === 0) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      recordMessage?.("in", message);
      const waiter = pending.get(message.id);
      if (!waiter) {
        continue;
      }
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  processHandle.stderr.on("data", (chunk) => {
    processHandle.stderrText += chunk.toString("utf8");
  });
  processHandle.stdin.on("error", (error) => {
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  processHandle.on("spawn", () => {
    spawned = true;
  });
  processHandle.on("error", (error) => {
    spawnError = error;
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });
  processHandle.on("exit", (status, signal) => {
    const error = new Error(`MCP bridge exited before reply (status=${status ?? "null"}, signal=${signal ?? "none"})`);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  return {
    async waitForSpawn() {
      const deadline = Date.now() + 5000;
      while (!spawned) {
        if (spawnError) {
          throw spawnError;
        }
        if (Date.now() >= deadline) {
          throw new Error("MCP bridge process did not spawn");
        }
        await sleep(25);
      }
    },
    request(method, params, requestTimeoutMs) {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: "2.0", id, method, params };
      recordMessage?.("out", payload);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });
        processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    },
    notify(method, params) {
      const payload = { jsonrpc: "2.0", method, params };
      recordMessage?.("out", payload);
      processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
    }
  };
}

export function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ status: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
