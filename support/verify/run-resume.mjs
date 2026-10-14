import { stripVTControlCharacters } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortable, CallError } from "./background.mjs";
import { entrypoint, nonempty, object, payload } from "./script.mjs";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { ocmInvocation } from "../../src/ocm/transport.mjs";
import { resolveGatewayEndpoint } from "../gateway-endpoint.mjs";

function resolvedUrlKey(result) {
  if (result?.ok === true && nonempty(result.key)) return result.key;
  if (result?.ok === false && (result.candidates === undefined || Array.isArray(result.candidates))) {
    if (result.candidates?.length) throw new CallError("session URL is ambiguous", 1);
    return null;
  }
  throw new CallError("session URL resolution returned an invalid result", 1);
}

async function resolveUrlReference(ctx, agentId, key, slug) {
  return resolvedUrlKey(await ctx.rpc("sessions.resolve", {
    reference: { key, ...(slug ? { slug } : {}) }, agentId,
    includeGlobal: true, includeUnknown: true, allowMissing: true
  }));
}

export async function resumeArguments(o, ctx) {
  const selected = [o.query !== undefined, Boolean(o["handoff-from"]), Boolean(o["url-from"])].filter(Boolean).length;
  if (selected !== 1) throw new CallError("provide exactly one of --query, --handoff-from or --url-from");
  if (o.query !== undefined) return ["resume", "--", o.query];
  const source = payload(await ctx.read(o["handoff-from"] ?? o["url-from"]));
  let handoff;
  if (o["handoff-from"]) {
    const value = source.handoff;
    if (typeof value === "string") {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new CallError("handoff must be base64url JSON");
      try { handoff = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new CallError("invalid handoff JSON"); }
    } else handoff = object(value, "handoff");
  } else {
    let url;
    try { url = new URL(source.url); } catch { throw new CallError("--url-from requires a url"); }
    if (url.username || url.password || url.search || url.hash) throw new CallError("session URL must not contain credentials, a query or a fragment");
    const parts = /\/(?:chat|dashboard)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname.replace(/\/+$/, ""));
    if (!parts) throw new CallError("session URL must contain an agent session path");
    const decode = (s) => s === "~dot" ? "." : s === "~dotdot" ? ".." : decodeURIComponent(s.startsWith("~~") ? s.slice(1) : s);
    const rawRest = parts[2] === undefined ? [] : parts[2].split("/");
    const exact = rawRest[0] === "~key";
    if (exact && rawRest.length === 1) throw new CallError("exact session URL requires a key");
    let agent, rest;
    try { agent = decode(parts[1]); rest = rawRest.slice(exact ? 1 : 0).map(decode); }
    catch { throw new CallError("invalid session URL encoding"); }
    if (!agent || rest.some((segment) => !segment)) throw new CallError("session URL has an empty path segment");
    agent = agent.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent)) agent = agent.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "main";
    const expected = new URL(resolveGatewayEndpoint(ctx.runtime(), null, { protocol: "http" }).url);
    if (url.origin !== expected.origin) throw new CallError("session URL belongs to another Gateway");
    let key;
    if (!rest.length) {
      key = resolvedUrlKey(await ctx.rpc("sessions.resolve", { key: "main", agentId: agent }));
    } else {
      key = `agent:${agent}:${rest.join(":")}`;
      if (!exact && rest.length === 1 && !["main", "global", "boot", "sessions"].includes(rest[0].toLowerCase())) {
        const defaults = await ctx.rpc("agents.list", {});
        if (!nonempty(defaults?.mainKey)) throw new CallError("Gateway did not return a configured main session key", 1);
        if (rest[0].toLowerCase() !== defaults.mainKey.trim().toLowerCase()) {
          const shortId = /^(?:.*-)?([0-9a-f]{8,32})$/iu.exec(rest[0])?.[1].toLowerCase();
          if (shortId) {
            const slugHint = rest[0].slice(0, rest[0].length - shortId.length).replace(/-+$/u, "");
            const found = resolvedUrlKey(await ctx.rpc("sessions.resolve", {
              shortId, ...(slugHint ? { slugHint } : {}), agentId: agent, allowMissing: true
            }));
            key = found ?? await resolveUrlReference(ctx, agent, key);
          } else key = await resolveUrlReference(ctx, agent, key, rest[0]);
        }
      }
    }
    if (!nonempty(key)) throw new CallError("session URL did not resolve to a session", 1);
    handoff = { version: 1, sessionKey: key, gatewayUrl: resolveGatewayEndpoint(ctx.runtime(), null, { protocol: "ws" }).url };
  }
  object(handoff, "handoff");
  if (handoff.version !== 1 || !/^agent:[^:]+:.+$/.test(handoff.sessionKey ?? "") || Object.keys(handoff).some((key) => !["version", "sessionKey", "gatewayUrl"].includes(key))) throw new CallError("invalid handoff shape");
  let gateway;
  try { gateway = new URL(handoff.gatewayUrl); } catch { throw new CallError("invalid handoff Gateway URL"); }
  const expected = new URL(resolveGatewayEndpoint(ctx.runtime(), null, { protocol: "ws" }).url);
  if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.href !== expected.href) throw new CallError("handoff must target this environment's Gateway");
  return ["resume", "--handoff", Buffer.from(JSON.stringify(handoff)).toString("base64url")];
}

const program = `set timeout [lindex $argv 0]
set closing 0
spawn -noecho {*}[lrange $argv 1 end]
expect {
  -re {gateway connected} { if {!$closing} {set closing 1; send -- "/exit\\r"}; exp_continue }
  eof { set result [wait]; exit [lindex $result 3] }
  timeout { exit 124 }
}`;

export async function resumePty(args, ctx) {
  const invocation = ocmInvocation(args);
  const directory = await mkdtemp(join(tmpdir(), "kova-resume-"));
  let owned;

  let output = "";
  const capture = (bytes) => { output = (output + bytes.toString()).slice(-1024 * 1024); ctx.record?.({ output }); };
  try {
    const script = join(directory, "resume.exp");
    await writeFile(script, program, { mode: 0o600, flag: "wx" });
    owned = spawnOwnedProcess("expect", [script, String(Math.max(1, Math.ceil(ctx.remaining() / 1000))), invocation.file, ...invocation.args], { env: { ...invocation.env, TERM: "xterm-256color" } });
    owned.child.stdout.on("data", capture);
    owned.child.stderr.on("data", capture);
    const ended = await abortable(owned.closed, ctx.signal);
    if (ended.error) throw ended.error;
    const result = { resolved: stripVTControlCharacters(output).match(/agent ([^\s()]+)(?: \([^)]*\))? - session ([^\r\n]+)/)?.slice(1, 3).map((value) => value.trim()) ?? null, output, createdIds: [] };
    if (ended.status === 124) throw new CallError("resume terminal timeout", 3);
    if (ended.status !== 0) throw Object.assign(new CallError(`openclaw resume exited ${ended.status ?? ended.signal}`, 1), { output: result });
    return result;
  } finally { await owned?.stop(); await rm(directory, { recursive: true, force: true }); }
}
export const definition = {
  id: "run-resume", url: import.meta.url,
  flags: ["env", "query", "handoff-from", "url-from", "timeout"], empty: () => ({ resolved: null, output: "", elapsedMs: 0, createdIds: [] }),
  validate(o) { if (o.query !== undefined && !nonempty(o.query)) throw new CallError("--query cannot be empty"); },
  async run(o, ctx) { return await (ctx.pty ?? resumePty)([`@${o.env}`, "--", ...await resumeArguments(o, ctx)], ctx); }
};
await entrypoint(definition);
