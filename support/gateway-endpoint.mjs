export function resolveGatewayEndpoint(envInfo, config, options = {}) {
  const protocol = options.protocol ?? "ws";
  const frontage = resolveNetworkFrontageEndpoint(protocol);
  if (frontage) {
    return frontage;
  }

  const port = Number(envInfo?.gatewayPort ?? config?.gateway?.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("gateway port missing from OCM env metadata and OpenClaw config");
  }
  return {
    source: "ocm-env-metadata",
    host: "127.0.0.1",
    port,
    url: `${protocol}://127.0.0.1:${port}`
  };
}

function resolveNetworkFrontageEndpoint(protocol) {
  if (process.env.KOVA_NETWORK_FRONTAGE_ENABLED !== "1") {
    return null;
  }
  const host = process.env.KOVA_NETWORK_FRONTAGE_HOST;
  const port = Number(process.env.KOVA_NETWORK_FRONTAGE_PORT);
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("KOVA_NETWORK_FRONTAGE_HOST is required when KOVA_NETWORK_FRONTAGE_ENABLED=1");
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("KOVA_NETWORK_FRONTAGE_PORT must be a positive integer when KOVA_NETWORK_FRONTAGE_ENABLED=1");
  }
  return {
    source: "network-frontage",
    host,
    port,
    url: `${protocol}://${host}:${port}`
  };
}
