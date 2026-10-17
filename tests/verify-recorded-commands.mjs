import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCatalogueCommand } from "../src/catalogue.mjs";
import { quoteShell } from "../src/commands.mjs";
import { readDeclaredIds } from "../src/verify/normalize.mjs";

const tool = "node {kovaRoot}/support/verify/agent-tool-turn.mjs";
const planned = `${tool} --env {env} --session-key agent:main:verify-parent --tool sessions_spawn --args '{}' --timeout 60000`;
const frozen = (args) => ["node", "/retained source/support/verify/agent-tool-turn.mjs", "--env", "copy", "--tool", "sessions_spawn", "--timeout", "60000", "--session-key", "agent:main:verify-parent", "--args", JSON.stringify(args)].map(quoteShell).join(" ");

async function recording(t, source = planned) {
  const directory = await mkdtemp(join(tmpdir(), "kova-recorded-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const phase = { id: "sessions/spawn", from: "template:sessions", commands: [source], checkpoint: [] };
  const checkpoint = join(directory, "checkpoints", phase.id);
  await mkdir(checkpoint, { recursive: true });
  const catalogue = JSON.parse(await readFile(new URL("../catalogue/openclaw.json", import.meta.url)));
  return async (command) => {
    await writeFile(join(checkpoint, "commands.json"), JSON.stringify([{ command, exit: 0, stderr: "", stdout: null, timedOut: false, durationMs: 100, createdIds: [] }]));
    return readDeclaredIds(directory, [phase], { stateIds: [], compressed: [] }, catalogue);
  };
}

test("recorded tool arguments preserve nested JSON and literal placeholder text", async (t) => {
  const read = await recording(t);
  for (const args of [
    { task: 'KOVA_VERIFY_HOLD {"holdMs":240000,"progressCards":false}', runTimeoutSeconds: 280 },
    { task: 'KOVA_VERIFY_HOLD {"holdMs":240000,"progressCards":false}', runTimeoutSeconds: 280, visible: true },
    { task: 'KOVA_VERIFY_HOLD {"holdMs":240000,"progressCards":false}', runtime: "subagent", runTimeoutSeconds: 280 },
    { task: "Keep {env}, {run}, {unknown}, an apostrophe ' and $(literal); | data" }
  ]) {
    const command = frozen(args);
    assert.ok(parseCatalogueCommand(command, { standard: true }).findings.some(({ code }) => code === "placeholder"));
    const parsed = parseCatalogueCommand(command, { standard: true, resolved: true });
    assert.deepEqual(parsed.findings, []);
    assert.deepEqual(JSON.parse(parsed.tokens.at(-1)), args);
    assert.equal((await read(command)).recorded, 1);
  }
});

test("recorded commands still reject shell syntax and changed catalogue operations", async (t) => {
  const read = await recording(t);
  const command = frozen({ task: 'KOVA_VERIFY_HOLD {"holdMs":240000}' });
  for (const malformed of [
    `${command}; echo unexpected`,
    `${command} | echo unexpected`,
    `${command} --out $(echo unexpected)`,
    `${command} --out {first,second}`,
    `${command} --out 'unfinished`,
    `${command}\0`
  ]) await assert.rejects(read(malformed), /invalid recorded command syntax/, malformed);
  await assert.rejects(read(command.replace("/support/verify/agent-tool-turn.mjs", "/support/verify/chat-history-read.mjs")), /recorded command does not match/);

  const gateway = "node {kovaRoot}/support/verify/gateway-call.mjs --env {env} --method sessions.list --params '{}'";
  const readGateway = await recording(t, gateway);
  const resolved = "node /retained/support/verify/gateway-call.mjs --env copy --method sessions.describe --params '{\"key\":\"{literal}\"}'";
  await assert.rejects(readGateway(resolved), /recorded command does not match/);
});
