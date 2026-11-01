#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EntryError, runEntry } from "./common.mjs";
import { channelContent, injectChannelMessage, waitForDmScope } from "./channel-content.mjs";
import { linkedPeer } from "./environment-content.mjs";
import { collectionRequests, readCollectionRows } from "./session-collections.mjs";
import { withSessionClient } from "./session-content.mjs";
import { readStoredSession, requireSessionContentRuntime } from "./session-store-read.mjs";

export const staleDmPeers = Object.freeze([1, 2, 3].map((index) => Object.freeze({
  index,
  peer: `dm:kova-probe-user-persona-stale-${index}`,
  identityId: `kova-persona-stale-dm-${index}`,
  key: `agent:main:kova-channel-probe:direct:kova-persona-stale-dm-${index}`,
  marker: `KOVA_STALE_DM_NOTE_${index}`,
})));

function peerAt(index) {
  if (!Number.isInteger(index) || index < 1 || index > staleDmPeers.length) throw new EntryError("--peer-index must be 1, 2 or 3", 2);
  return staleDmPeers[index - 1];
}

async function requireIsolatedConfig(rpc, state) {
  const snapshot = await rpc(collectionRequests.config());
  if (typeof snapshot?.path !== "string" || await realpath(dirname(snapshot.path)) !== await realpath(state)) throw new Error("DM fixture belongs to a different environment");
  const session = snapshot.config?.session;
  if (session?.dmScope !== "per-channel-peer" || !session.identityLinks?.["persona-peer"]?.includes(`${channelContent.channel}:${linkedPeer}`)) throw new Error("DM fixture requires the existing isolated scope and linked peer");
  for (const peer of staleDmPeers) {
    // The cleanup selector accepts one peer component. Link the probe's native
    // dm: address through the product's identity resolver before inbound routing.
    const candidates = [peer.peer, `${channelContent.channel}:${peer.peer}`];
    const owners = Object.entries(session.identityLinks).filter(([, ids]) => Array.isArray(ids) && ids.some((id) => typeof id === "string" && candidates.includes(id.trim().toLowerCase())));
    if (owners.length !== 1 || owners[0][0] !== peer.identityId) throw new Error(`DM fixture identity link is absent or ambiguous for peer ${peer.index}`);
  }
}

function messageText(event) {
  const content = event?.message?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : "";
}

async function readCompletedPeer({ state, peer, rows, readSession }) {
  const entry = rows.get(peer.key);
  const origin = entry?.delivery?.kind === "external" ? entry.delivery.origin : undefined;
  if (!entry?.sessionId || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 1 || entry.archivedAt !== undefined || (entry.status !== undefined && entry.status !== "done") || origin?.provider !== channelContent.channel || origin.chatType !== "direct" || origin.to !== peer.peer) throw new Error(`saved peer ${peer.index} is not an active external direct-message row`);
  const stored = await readSession(state, peer.key, { maxEvents: 200, maxBytes: 4 * 1024 * 1024 });
  if (stored.key !== peer.key || stored.sessionId !== entry.sessionId) throw new Error(`saved peer ${peer.index} changed generation during its check`);
  const messages = stored.events.filter(({ event }) => event.type === "message").map(({ event }) => event);
  const notes = messages.flatMap((event, index) => event.message?.role === "user" && messageText(event).includes(peer.marker) ? [index] : []);
  if (notes.length !== 1) throw new Error(`saved peer ${peer.index} has no unique synthetic notebook input`);
  const following = messages.slice(notes[0] + 1);
  if (following.some((event) => event.message?.role === "user") || !following.some((event) => event.message?.role === "assistant" && messageText(event).includes("KOVA_AGENT_OK") && !event.message.errorMessage && !["error", "aborted"].includes(event.message.stopReason))) throw new Error(`saved peer ${peer.index} has no completed synthetic notebook reply`);
  return { key: stored.key, sessionId: stored.sessionId };
}

/** Creates one real channel turn; configuration and other peers are separate operations. */
export async function createStaleDmPeer({ rpc, state, peerIndex, readRows = readCollectionRows, readSession = readStoredSession }) {
  const peer = peerAt(peerIndex);
  await requireIsolatedConfig(rpc, state);
  const status = await waitForDmScope(rpc, "isolated");
  if (status.dmScope !== "per-channel-peer") throw new Error("conformance channel has not loaded per-channel-peer routing");
  if ((await readRows(state, "main")).has(peer.key)) throw new Error(`DM fixture peer ${peer.index} already exists`);
  const key = await injectChannelMessage(rpc, { peer: peer.peer, message: `${peer.marker}: Keep this peer's synthetic notebook separate. Reply with KOVA_AGENT_OK.` });
  if (key !== peer.key) throw new Error("channel input did not create its isolated cleanup candidate");
  return readCompletedPeer({ state, peer, rows: await readRows(state, "main"), readSession });
}

/** Scope stays isolated in the persona; cleanup switches only its disposable run clone to main. */
export async function checkStaleDmPeers({ rpc, state, readRows = readCollectionRows, readSession = readStoredSession }) {
  await requireIsolatedConfig(rpc, state);
  const rows = await readRows(state, "main");
  const sessionIds = new Set();
  for (const peer of staleDmPeers) {
    const result = await readCompletedPeer({ state, peer, rows, readSession });
    if (sessionIds.has(result.sessionId)) throw new Error("isolated DM peers share a transcript generation");
    sessionIds.add(result.sessionId);
  }
  return {};
}

async function main() {
  const argv = process.argv.slice(2), operation = argv.shift();
  await runEntry({ "peer-index": { type: "string", pattern: /^[123]$/ } }, ({ args, env, state }) => withSessionClient(env, (rpc) => operation === "create"
    ? createStaleDmPeer({ rpc, state, peerIndex: Number(args["peer-index"]) })
    : checkStaleDmPeers({ rpc, state })), argv, (args) => {
    requireSessionContentRuntime();
    if (!["create", "check"].includes(operation)) throw new EntryError("expected create or check", 2);
    if ((operation === "create") !== (args["peer-index"] !== undefined)) throw new EntryError("--peer-index is required only for create", 2);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
