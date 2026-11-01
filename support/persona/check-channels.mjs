#!/usr/bin/env node
import { runEntry, EntryError } from "./common.mjs";
import { openDirectGatewayRpcClient, waitForGatewayMethodOk } from "../openclaw-runtime.mjs";

await runEntry({ timeout: { type: "string" } }, async ({ args, env }) => {
  const handle = await openDirectGatewayRpcClient({ ...env, envName: args.env }).catch((error) => {
    if (/^gateway direct RPC connect timeout after \d+ms$/.test(error.message)) throw new EntryError(error.message, 3);
    throw error;
  });
  try {
    const timeoutMs = Number(args.timeout ?? 30000);
    const status = await waitForGatewayMethodOk(handle.client, "kova.channelProbe.status", { timeoutMs, requestTimeoutMs: Math.min(timeoutMs, 5000) }).catch((error) => { throw new EntryError(error.message, 3); });
    if (status.channelId !== "kova-channel-probe" || !status.accountId) throw new Error("conformance channel account is absent");
    return { dmChannel: status.channelId, groupChannel: status.channelId };
  } finally { handle.client.close(); }
});
