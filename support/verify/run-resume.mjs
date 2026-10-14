import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortable, CallError } from "./background.mjs";
import { entrypoint, nonempty, object, payload } from "./script.mjs";
import { spawnOwnedProcess } from "../../src/commands.mjs";
import { ocmInvocation } from "../../src/ocm/transport.mjs";
import { resolveGatewayEndpoint } from "../gateway-endpoint.mjs";

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
    const parts = /\/(?:chat|dashboard)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!parts) throw new CallError("session URL must contain an agent session path");
    const decode = (s) => s === "~dot" ? "." : s === "~dotdot" ? ".." : decodeURIComponent(s.startsWith("~~") ? s.slice(1) : s);
    let agent, rest;
    try { agent = decode(parts[1]); rest = parts[2] === undefined ? [] : parts[2].split("/").map(decode); }
    catch { throw new CallError("invalid session URL encoding"); }
    const exact = rest[0] === "~key";
    if (exact) rest.shift();
    let key;
    if (!rest.length) {
      const found = await ctx.rpc("sessions.resolve", { key: "main", agentId: agent });
      key = found?.key;
    } else {
      const short = !exact && rest.length === 1 ? /^(?:.*-)?([0-9a-f]{8,32})$/i.exec(rest[0]) : null;
      if (short) {
        const found = await ctx.rpc("sessions.resolve", { shortId: short[1], agentId: agent });
        key = found?.key;
      } else key = `agent:${agent}:${rest.join(":")}`;
    }
    if (!nonempty(key)) throw new CallError("session URL did not resolve to a session", 1);
    handoff = { version: 1, sessionKey: key, gatewayUrl: resolveGatewayEndpoint(ctx.runtime(), null, { protocol: "ws" }).url };
    const expected = new URL(resolveGatewayEndpoint(ctx.runtime(), null, { protocol: "http" }).url);
    if (url.origin !== expected.origin) throw new CallError("session URL belongs to another Gateway");
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
    const result = { resolved: output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").match(/agent ([^\s()]+)(?: \([^)]*\))? - session ([^\r\n]+)/)?.slice(1, 3) ?? null, output, createdIds: [] };
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
