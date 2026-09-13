import { measurementScopeForPhase, tagCommandResult } from "../measurement-contract.mjs";
import {
  ocmAt,
  ocmEnvDestroy,
  ocmEnvDestroyPreviewJson,
  ocmEnvExec,
  ocmEnvExecShell,
  ocmLogs,
  ocmRuntimeBuildLocal,
  ocmRuntimeRemoveJson,
  ocmServiceStatusJson,
  ocmTargetSelector
} from "../ocm/commands.mjs";
import { isMissingOcmResource } from "../ocm/missing-resource.mjs";
import { envNameFor, maxOcmEnvNameLength } from "../run/env-name.mjs";
import { classifyRetentionProtection, runGuardedTeardownStages } from "../run/teardown.mjs";
import { resolveTarget } from "../targets.mjs";
import { assertEqual } from "./harness.mjs";

export function ocmCommandBuildersCheck() {
  try {
    assertEqual(ocmTargetSelector({ kind: "npm", value: "2026.4.27" }), "--version '2026.4.27'", "npm selector");
    assertEqual(ocmTargetSelector({ kind: "release", value: "beta" }), "--channel 'beta'", "release selector");
    assertEqual(ocmTargetSelector({ kind: "runtime", value: "stable" }), "--runtime 'stable'", "runtime selector");
    assertEqual(
      ocmTargetSelector({ kind: "local-build", value: "/tmp/openclaw", runtimeName: "kova-local-test" }),
      "--runtime 'kova-local-test'",
      "local-build selector"
    );
    assertEqual(ocmServiceStatusJson("Team Env"), "ocm service status 'Team Env' --json", "quoted service status");
    assertEqual(ocmLogs("Team Env", { tail: 25, raw: true }), "ocm logs 'Team Env' --tail '25' --raw", "quoted logs");
    assertEqual(ocmEnvDestroy("Team Env"), "ocm env destroy 'Team Env' --yes", "quoted env destroy");
    assertEqual(ocmEnvDestroyPreviewJson("Team Env"), "ocm env destroy 'Team Env' --json", "quoted env destroy preview");
    assertEqual(
      ocmEnvDestroy("Team Env", { json: true, stateRevision: "v1:r1" }),
      "ocm env destroy 'Team Env' --json --yes --if-state-token 'v1:r1'",
      "quoted guarded env destroy"
    );
    assertEqual(ocmAt("Team Env", ["status"]), "ocm @'Team Env' -- 'status'", "quoted at command");
    assertEqual(
      ocmEnvExec("Team Env", ["node", "support/script.mjs", "--name", "O'Hara"]),
      "ocm env exec 'Team Env' -- 'node' 'support/script.mjs' '--name' 'O'\\''Hara'",
      "quoted env exec args"
    );
    assertEqual(
      ocmEnvExecShell("Team Env", "printf '%s\\n' ok"),
      "ocm env exec 'Team Env' -- 'sh' '-lc' 'printf '\\''%s\\n'\\'' ok'",
      "quoted env exec shell"
    );
    assertEqual(
      ocmRuntimeBuildLocal("kova-local-test", "/tmp/Open Claw"),
      "ocm runtime build-local 'kova-local-test' --repo '/tmp/Open Claw' --force",
      "quoted local runtime build"
    );
    assertEqual(ocmRuntimeRemoveJson("kova-local-test"), "ocm runtime remove 'kova-local-test' --json", "quoted runtime remove");
    return {
      id: "ocm-command-builders",
      status: "PASS",
      command: "validate centralized OCM command builders",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "ocm-command-builders",
      status: "FAIL",
      command: "validate centralized OCM command builders",
      durationMs: 0,
      message: error.message
    };
  }
}

export function localBuildRuntimeNameCheck() {
  try {
    const first = resolveTarget("local-build:/tmp/openclaw", "target");
    const second = resolveTarget("local-build:/tmp/openclaw", "target");
    assertEqual(/^kova-local-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{8}$/.test(first.runtimeName), true, "local-build runtime name shape");
    assertEqual(first.runtimeName === second.runtimeName, false, "local-build runtime names are collision resistant");
    return {
      id: "local-build-runtime-name",
      status: "PASS",
      command: "resolve two local-build targets",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "local-build-runtime-name",
      status: "FAIL",
      command: "resolve two local-build targets",
      durationMs: 0,
      message: error.message
    };
  }
}

export function ocmMissingResourceCheck() {
  try {
    const result = (stderr, status = 1) => ({ status, stdout: "", stderr });
    assertEqual(
      isMissingOcmResource(result('ocm: runtime "kova-local-test" does not exist'), "runtime", "kova-local-test"),
      true,
      "exact missing runtime"
    );
    assertEqual(
      isMissingOcmResource(result('ocm: environment "kova-test" does not exist'), "environment", "kova-test"),
      true,
      "exact missing environment"
    );
    assertEqual(
      isMissingOcmResource(result("OpenClaw release version was not found"), "runtime", "kova-local-test"),
      false,
      "unrelated not-found error"
    );
    assertEqual(
      isMissingOcmResource(result('ocm: runtime "different" does not exist'), "runtime", "kova-local-test"),
      false,
      "different missing runtime"
    );
    assertEqual(
      classifyRetentionProtection(
        result('ocm: environment "kova-test" does not exist'),
        "kova-test"
      ),
      "already-absent",
      "missing retained env preserves the original scenario failure"
    );
    assertEqual(
      classifyRetentionProtection(result("", 0), "kova-test"),
      "protected",
      "successful retained env protection"
    );
    assertEqual(
      classifyRetentionProtection(result("permission denied"), "kova-test"),
      "failed",
      "unexpected retained env protection failure"
    );
    return {
      id: "ocm-missing-resource-classification",
      status: "PASS",
      command: "classify exact OCM missing-resource errors",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "ocm-missing-resource-classification",
      status: "FAIL",
      command: "classify exact OCM missing-resource errors",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function guardedTeardownStagesCheck() {
  const attempted = [];
  const observed = [];
  const result = await runGuardedTeardownStages([
    {
      id: "first",
      run() {
        attempted.push("first");
        throw new Error("first failed");
      }
    },
    {
      id: "second",
      run() {
        attempted.push("second");
        return "ok";
      }
    },
    {
      id: "third",
      run() {
        attempted.push("third");
        throw new Error("third failed");
      }
    }
  ], {
    onError(error) {
      observed.push(error.stage);
    }
  });
  try {
    assertEqual(attempted.join(","), "first,second,third", "all teardown stages attempted");
    assertEqual(result.errors.map((error) => error.stage).join(","), "first,third", "teardown errors aggregated");
    assertEqual(observed.join(","), "first,third", "teardown errors observed as they occur");
    return {
      id: "guarded-teardown-stages",
      status: "PASS",
      command: "execute synthetic teardown stages",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "guarded-teardown-stages",
      status: "FAIL",
      command: "execute synthetic teardown stages",
      durationMs: 0,
      message: error.message
    };
  }
}

export function measurementPhaseOwnershipCheck() {
  try {
    const forgedHarness = tagCommandResult(
      { command: "ocm @kova -- status", measurementScope: "harness" },
      { id: "agent-turn", measurementScope: "product" }
    );
    const forgedProduct = tagCommandResult(
      { command: "npm install", measurementScope: "product" },
      { id: "auth-setup", measurementScope: "harness" }
    );
    assertEqual(forgedHarness.measurementScope, "product", "product phase overrides forged harness result scope");
    assertEqual(forgedProduct.measurementScope, "harness", "harness phase overrides forged product result scope");
    assertEqual(
      measurementScopeForPhase({
        id: "env-create",
        commands: ["ocm start kova-test --no-service"]
      }),
      "harness",
      "no-service environment creation is harness-owned"
    );
    return {
      id: "measurement-phase-ownership",
      status: "PASS",
      command: "validate phase-owned command measurement scope",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "measurement-phase-ownership",
      status: "FAIL",
      command: "validate phase-owned command measurement scope",
      durationMs: 0,
      message: error.message
    };
  }
}

export function envNameLengthCheck() {
  try {
    const name = envNameFor(
      "channel-model-turn-baseline",
      "mock-openai-provider",
      "kova-260521-001757-f3cb72"
    );
    assertEqual(name.startsWith("kova-channel-model-turn"), true, "env name keeps readable scenario prefix");
    if (name.length > maxOcmEnvNameLength()) {
      throw new Error(`env name length ${name.length} exceeds ${maxOcmEnvNameLength()}: ${name}`);
    }
    assertEqual(/^kova-[a-z0-9][a-z0-9-]*$/.test(name), true, "env name remains OCM safe");
    const repeatName = envNameFor(
      "channel-model-turn-baseline",
      "mock-openai-provider",
      "kova-260521-001757-f3cb72",
      { index: 2, total: 3 }
    );
    if (repeatName === name) {
      throw new Error("repeat env name must be distinct");
    }
    return {
      id: "env-name-length",
      status: "PASS",
      command: "validate generated OCM env names stay bounded",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "env-name-length",
      status: "FAIL",
      command: "validate generated OCM env names stay bounded",
      durationMs: 0,
      message: error.message
    };
  }
}
