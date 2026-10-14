import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { readTransportedGatewayConfig } from "../openclaw-runtime.mjs";
import { resolveGatewayEndpoint } from "../gateway-endpoint.mjs";
import { CallError } from "./background.mjs";
import { entrypoint, nonempty, sessionKey } from "./script.mjs";

export function redactShare(value, token) {
  return value.replaceAll(token, "[redacted]").replaceAll(encodeURIComponent(token), "[redacted]");
}
async function document(url, signal) {
  const response = await fetch(url, { signal, redirect: "manual", headers: { accept: "text/html" } });
  let length = 0;
  const chunks = [];
  for await (const bytes of response.body ?? []) {
    length += bytes.length;
    if (length > 4 * 1024 * 1024) throw new Error("public document exceeds 4 MiB");
    chunks.push(bytes);
  }
  return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
}
export const definition = {
  id: "public-thread-read", url: import.meta.url,
  flags: ["env", "session-key"], empty: () => ({ status: null, document: null, preview: null }),
  async run(o, ctx) {
    const key = await sessionKey(o, ctx);
    const sharing = await ctx.rpc("session.members.listEvidence", { sessionKey: key });
    const token = sharing?.publicShare?.token;
    if (!nonempty(token)) return { status: null, document: null, preview: null };
    try {
      const runtime = ctx.runtime();
      const config = ctx.config ?? readTransportedGatewayConfig(runtime, runtime.configPath, JSON5.parse) ?? JSON5.parse(await readFile(runtime.configPath, { encoding: "utf8", signal: ctx.signal }));
      const endpoint = resolveGatewayEndpoint(runtime, config, { protocol: "http" });
      const configuredBase = String(config.gateway?.controlUi?.basePath ?? "").trim().replace(/^\/+|\/+$/g, "");
      const base = configuredBase ? `/${configuredBase}` : "";
      const root = `${endpoint.url.replace(/\/$/, "")}${base}`;
      const read = ctx.fetchDocument ?? document;
      const page = await read(`${root}/share/session?token=${encodeURIComponent(token)}`, ctx.signal);
      const parts = /^agent:([^:]+):(.+)$/.exec(key);
      if (!parts) throw new CallError("public preview requires a canonical agent session key");
      const encode = (value) => value === "." ? "~dot" : value === ".." ? "~dotdot" : encodeURIComponent(value).replaceAll(".", "%2E").replace(/^~/, "~~");
      const rest = parts[2].split(":");
      const previewPath = `${root}/share/chat/${encode(parts[1])}/${rest.length === 1 ? "~key/" : ""}${rest.map(encode).join("/")}`;
      const preview = await read(previewPath, ctx.signal);
      return { status: page.status, document: redactShare(page.body, token), preview: { status: preview.status, document: redactShare(preview.body, token) } };
    } catch (error) { throw new CallError(redactShare(String(error?.message ?? error), token), error?.exitCode ?? 1); }
  }
};
await entrypoint(definition);
