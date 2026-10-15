import { disposableEnv, finishHelper, runHelper } from "./helper.mjs";
import { entrypoint } from "./script.mjs";

export const definition = {
  id: "doctor-repair", url: import.meta.url,
  flags: ["env", "timeout"],
  empty: () => ({ repairs: null }),
  validate: disposableEnv,
  async run(o, ctx) {
    const result = await runHelper("run-doctor-repair", ["--env", o.env], ctx);
    const { status, doctorFixSucceeded, doctorUnrepairedFindingCount, stdoutSnippet, stderrSnippet } = result.value;
    return finishHelper(result, { repairs: {
      status: status ?? null, succeeded: doctorFixSucceeded ?? false,
      unrepairedFindingCount: doctorUnrepairedFindingCount ?? null,
      stdout: stdoutSnippet ?? "", stderr: stderrSnippet ?? ""
    } }, ctx);
  }
};
await entrypoint(definition);
