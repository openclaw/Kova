#!/usr/bin/env node

import net from "node:net";

const args = parseArgs(process.argv.slice(2));
const listenHost = required(args["listen-host"], "--listen-host");
const listenPort = positivePort(args["listen-port"], "--listen-port");
const targetHost = required(args["target-host"], "--target-host");
const targetPort = positivePort(args["target-port"], "--target-port");

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: targetPort });
  upstream.on("error", (error) => {
    log("target-error", { message: error.message });
    client.destroy(error);
  });
  client.on("error", (error) => {
    log("client-error", { message: error.message });
    upstream.destroy(error);
  });
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (error) => {
  log("bind-error", { message: error.message });
  process.exitCode = 1;
});

server.listen({ host: listenHost, port: listenPort }, () => {
  log("listening", { listenHost, listenPort, targetHost, targetPort, pid: process.pid });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`unexpected argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function required(value, label) {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function positivePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} must be a valid TCP port`);
  }
  return port;
}

function log(event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ event, ...fields, at: new Date().toISOString() })}\n`);
}
