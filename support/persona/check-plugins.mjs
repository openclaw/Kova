#!/usr/bin/env node
import { runEntry, productJson } from "./common.mjs";
import { access } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

await runEntry({}, async ({ args, env }) => {
  const result = await productJson(args.env, ["plugins", "list", "--json"]);
  const plugins = result.plugins;
  if (!plugins?.some((plugin) => plugin.id === "memory-core" && plugin.status === "loaded" && plugin.origin === "bundled")) throw new Error("bundled memory plugin is not loaded");
  if (!plugins.some((plugin) => plugin.id === "kova-channel-probe" && plugin.status === "loaded")) throw new Error("external conformance plugin is not loaded");
  const { install: receipt } = await productJson(args.env, ["plugins", "inspect", "kova-channel-probe", "--json"]);
  if (!receipt?.installPath) throw new Error("external plugin install record is absent");
  const installed = relative(env.root, receipt.installPath);
  if (isAbsolute(installed) || installed === ".." || installed.startsWith("../")) throw new Error("external plugin install record points outside this environment");
  await access(join(receipt.installPath, "openclaw.plugin.json"));
  return { externalPluginId: "kova-channel-probe" };
});
