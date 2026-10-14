#!/usr/bin/env node
import { access } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { context, productJson, mockScript, findMockEntry } from "./common.mjs";
import { openDirectGatewayRpcClient, prepareOpenClawRuntimeFromOcmEnv, waitForGatewayMethodOk } from "../openclaw-runtime.mjs";

const { args, env, workspace } = context();
let keys;
switch (args.trait) {
  case "agents-three-configured": {
    const agents = await productJson(args.env, ["agents", "list", "--json"]);
    const selected = ["main", "research", "idle"].map((name) => agents.find((agent) => agent.id === name));
    if (selected.some((agent) => !agent) || new Set(selected.map((agent) => agent.workspace)).size !== 3 || new Set(selected.map((agent) => agent.agentDir)).size !== 3) throw new Error("three agents with separate workspaces and stores are required");
    for (const agent of selected) for (const path of [agent.workspace, agent.agentDir]) {
      const local = relative(env.root, path);
      if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("agent content points outside this environment");
    }
    for (const agent of selected) await access(agent.workspace);
    keys = { mainAgentId: "main", secondAgentId: "research", thirdAgentId: "idle" };
    break;
  }
  case "mock-provider-scripted": {
    findMockEntry(await mockScript(workspace), "KOVA_AGENT_OK");
    const models = await productJson(args.env, ["models", "list", "--json"]);
    if (!models.models?.some((model) => model.key === "openai/gpt-5.5")) throw new Error("scripted mock model is absent");
    const configured = await productJson(args.env, ["config", "get", "agents.defaults.model.primary", "--json"]);
    if (configured !== "openai/gpt-5.5") throw new Error("agents do not default to the mock model");
    const agents = await productJson(args.env, ["config", "get", "agents.entries", "--json"]);
    for (const agent of Object.values(agents)) {
      const override = typeof agent.model === "string" ? agent.model : agent.model?.primary;
      if (override && override !== configured) throw new Error("an agent overrides the mock model");
    }
    keys = { modelId: configured };
    break;
  }
  case "channels-test-accounts": {
    const handle = await openDirectGatewayRpcClient(prepareOpenClawRuntimeFromOcmEnv(args.env));
    try {
      const status = await waitForGatewayMethodOk(handle.client, "kova.channelProbe.status", { timeoutMs: 30000 });
      if (status.channelId !== "kova-channel-probe" || !status.accountId) throw new Error("conformance channel account is absent");
      keys = { dmChannel: status.channelId, groupChannel: status.channelId };
    } finally { handle.client.close(); }
    break;
  }
  case "plugins-bundled-and-external": {
    const result = await productJson(args.env, ["plugins", "list", "--json"]);
    const plugins = result.plugins;
    if (!plugins?.some((plugin) => plugin.id === "memory-core" && plugin.status === "loaded" && plugin.origin === "bundled")) throw new Error("bundled memory plugin is not loaded");
    if (!plugins.some((plugin) => plugin.id === "kova-channel-probe" && plugin.status === "loaded")) throw new Error("external conformance plugin is not loaded");
    const { install: receipt } = await productJson(args.env, ["plugins", "inspect", "kova-channel-probe", "--json"]);
    if (!receipt?.installPath) throw new Error("external plugin install record is absent");
    const installed = relative(env.root, receipt.installPath);
    if (isAbsolute(installed) || installed === ".." || installed.startsWith("../")) throw new Error("external plugin install record points outside this environment");
    await access(join(receipt.installPath, "openclaw.plugin.json"));
    keys = { externalPluginId: "kova-channel-probe" };
    break;
  }
  case "config-hand-edited": {
    const patterns = await productJson(args.env, ["config", "get", "logging.redactPatterns", "--json"]);
    const scope = await productJson(args.env, ["config", "get", "session.dmScope", "--json"]);
    const name = await productJson(args.env, ["config", "get", "agents.entries.research.identity.name", "--json"]);
    if (!patterns.includes("KOVA_PRIVATE_[A-Z]+") || scope !== "per-channel-peer" || name !== "Research Notebook") throw new Error("custom config values are absent");
    keys = {};
    break;
  }
  default: throw new Error(`unknown foundation trait: ${args.trait}`);
}
console.log(JSON.stringify(keys));
