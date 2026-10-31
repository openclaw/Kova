import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../paths.mjs";
import { assertEqual, inlineCheck } from "./harness.mjs";

// Stand-in for the plugin-sdk subpaths the probe imports, as OpenClaw exports them
// since openclaw/openclaw#162333 retired channel-message. Importing any other
// subpath fails with ERR_PACKAGE_PATH_NOT_EXPORTED, the error OpenClaw's plugin
// loader reports. This keeps the probe on that import list; it does not follow
// later changes to OpenClaw's exports, which the channel scenario run covers.
const openClawPluginSdk = {
  "./plugin-sdk/core": `
    export function definePluginEntry(entry) { return entry; }
  `,
  "./plugin-sdk/routing": `
    export function resolveThreadSessionKeys({ baseSessionKey, threadId }) {
      return { sessionKey: baseSessionKey + ":thread:" + threadId };
    }
  `,
  "./plugin-sdk/channel-outbound": `
    export function defineChannelMessageAdapter(adapter) { return adapter; }
    export function createMessageReceiveContext(params) { return { ...params, ackState: "pending" }; }
  `
};

export async function channelProbePluginLoadCheck(tmp) {
  return inlineCheck("channel-probe-plugin-load", async () => {
    const root = join(tmp, "channel-probe-plugin-load");
    const packageRoot = join(root, "node_modules", "openclaw");
    await mkdir(packageRoot, { recursive: true });
    const exports = {};
    for (const [subpath, source] of Object.entries(openClawPluginSdk)) {
      const file = `${subpath.slice(2)}.js`;
      await mkdir(join(packageRoot, "plugin-sdk"), { recursive: true });
      await writeFile(join(packageRoot, file), source);
      exports[subpath] = `./${file}`;
    }
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw", type: "module", exports }));
    const pluginDir = join(root, "kova-channel-probe");
    await cp(join(repoRoot, "support", "plugins", "kova-channel-probe"), pluginDir, { recursive: true });

    const { default: entry } = await import(pathToFileURL(join(pluginDir, "index.js")).href);
    const channels = [];
    const gatewayMethods = [];
    entry.register({
      registerChannel: (channel) => channels.push(channel),
      registerGatewayMethod: (name) => gatewayMethods.push(name)
    });
    assertEqual(entry.id, "kova-channel-probe", "probe plugin entry id");
    assertEqual(channels.map((channel) => channel.id).join(","), "kova-channel-probe", "probe channel registered");
    assertEqual(channels[0]?.message?.id, "kova-channel-probe", "probe channel message adapter");
    assertEqual(
      gatewayMethods.join(","),
      "kova.channelProbe.status,kova.channelProbe.reset,kova.channelProbe.inject,kova.channelProbe.observations",
      "probe gateway methods registered"
    );
  });
}
