import { CallError } from "./background.mjs";
import { requestGatewayLifecycle, withGatewayLifecycleRequest } from "./gateway-fixture-client.mjs";
import { disposableEnv, finishHelper, runHelper } from "./helper.mjs";
import { entrypoint } from "./script.mjs";

async function repair(env, context) {
  const result = await runHelper("run-doctor-repair", ["--env", env], context);
  const { status, doctorFixSucceeded, doctorUnrepairedFindingCount, stdoutSnippet, stderrSnippet } = result.value;
  return finishHelper(result, { repairs: {
    status: status ?? null, succeeded: doctorFixSucceeded ?? false,
    unrepairedFindingCount: doctorUnrepairedFindingCount ?? null,
    stdout: stdoutSnippet ?? "", stderr: stderrSnippet ?? ""
  } }, context);
}

export async function runPausedDoctor(request, context, dependencies = {}) {
  let output = { repairs: null, error: null };
  try {
    await withGatewayLifecycleRequest(request, context, async (controls) => {
      disposableEnv(request.options);
      await repair(request.options.env, { ...controls, helper: dependencies.doctorHelper, record(value) { Object.assign(output, value); } });
      controls.remaining();
    });
    return { output, exitCode: 0 };
  } catch (error) {
    output.error = error.message;
    return { output, exitCode: error.exitCode ?? (error.name === "TimeoutError" ? 3 : 1) };
  }
}

export const definition = {
  id: "doctor-repair", url: import.meta.url,
  cancellationExitCode: 3,
  flags: ["env", "gateway-handle", "timeout"],
  empty: () => ({ repairs: null }),
  validate: disposableEnv,
  async run(o, ctx) {
    if (!o["gateway-handle"]) return await repair(o.env, ctx);
    let result;
    try {
      result = await (ctx.requestLifecycle ?? requestGatewayLifecycle)({ env: o.env, "gateway-handle": o["gateway-handle"], operation: "doctor-repair", timeoutMs: ctx.remaining() }, { signal: ctx.signal });
    } catch (error) { ctx.record({ repairs: error.operationResult?.output?.repairs ?? null }); throw error; }
    ctx.record({ repairs: result.output?.repairs ?? null });
    if (result.exitCode !== 0 || result.output?.error !== null) throw new CallError(result.output?.error ?? "offline Doctor failed", result.exitCode || 1);
    if (result.output.repairs?.gateway?.stopped !== true || result.output.repairs?.gateway?.ready !== true) throw new Error("Doctor did not restore its foreground Gateway");
    ctx.remaining();
    return { repairs: result.output.repairs };
  }
};
await entrypoint(definition);
