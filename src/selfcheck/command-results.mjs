import { countProviderTimeoutMentions, isExpectedKovaMockProviderFailureLine } from "../collectors/logs.mjs";
import {
  attachCommandResultInterpretation,
  commandFailureRecordStatus,
  interpretCommandResult,
  isNoLogsOutput,
  isOptionalNoLogsResult,
  normalizeOptionalCommandResult
} from "../command-results.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import {
  commandResultFailed,
  commandResultFailureReason,
  commandResultPassed,
  phaseResultStatus
} from "../measurement-contract.mjs";
import { buildReportSummary } from "../reporting/report.mjs";
import { classifyCommandFailure } from "../runner.mjs";
import { assertEqual } from "./harness.mjs";

export function commandResultContractCheck() {
  try {
    assertEqual(commandResultPassed({ exitCode: 0 }), true, "exitCode zero passes");
    assertEqual(commandResultFailed({ exitCode: 2 }), true, "nonzero exitCode fails");
    assertEqual(
      commandResultFailed({ evidenceStatus: "failed", status: 0 }),
      true,
      "failed evidence overrides zero command status"
    );
    assertEqual(
      commandResultFailureReason({
        evidenceStatus: "failed",
        evidenceReason: "snapshot payload was incomplete",
        status: 0
      }),
      "command evidence failed: snapshot payload was incomplete",
      "failed evidence reason overrides zero command exit"
    );
    assertEqual(
      commandResultPassed({ evidenceStatus: "missing", status: 0 }),
      false,
      "missing evidence does not pass"
    );
    assertEqual(
      commandResultFailed({ evidenceStatus: "missing", status: 0 }),
      false,
      "missing evidence is incomplete rather than failed"
    );
    assertEqual(phaseResultStatus([{ exitCode: 0 }]), "success", "phase accepts exitCode result");
    return {
      id: "command-result-contract",
      status: "PASS",
      command: "evaluate shared command result classification",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "command-result-contract",
      status: "FAIL",
      command: "evaluate shared command result classification",
      durationMs: 0,
      message: error.message
    };
  }
}

export function expectedMockProviderFailureTimeoutLogCheck() {
  try {
    const timeoutSignals = [
      "provider request timed out after 60s",
      "upstream provider timeout",
      "model timeout after 30000ms",
      "provider timeouts exceeded the retry budget",
      "for provider openai timed out waiting for a model response"
    ].join("\n");
    const transportDiagnostics = [
      "[provider-transport-fetch] start provider=openai model=gpt-5.5 timeoutMs=undefined",
      "[model-fetch] start provider=openai model=gpt-5.5 timeoutMs=120000"
    ].join("\n");
    assertEqual(countProviderTimeoutMentions(timeoutSignals), 5, "provider timeout outcome signals");
    assertEqual(countProviderTimeoutMentions(transportDiagnostics), 0, "provider timeout transport metadata");
    assertEqual(
      isExpectedKovaMockProviderFailureLine("embedded run failover decision reason=timeout rawError=503 mock provider channel workflow failure"),
      true,
      "expected Kova mock provider failure line is classified"
    );
    assertEqual(
      countProviderTimeoutMentions("model fallback reason=timeout; mock provider channel workflow failure"),
      0,
      "expected mock provider failure timeout is excluded"
    );

    const transportMetadataRecord = {
      scenario: "provider-timeout-metadata-self-check",
      status: "PASS",
      phases: [{
        id: "logs",
        results: [{
          command: "ocm logs kova-self-check --tail 200 --raw",
          status: 0,
          stdout: transportDiagnostics,
          stderr: "",
          durationMs: 10
        }]
      }]
    };
    evaluateRecord(transportMetadataRecord, { thresholds: {} });
    assertEqual(
      transportMetadataRecord.violations?.some((violation) => violation.metric === "providerTimeoutMentions") ?? false,
      false,
      "transport timeout metadata does not create provider timeout violations"
    );

    const expectedFailureRecord = {
      scenario: "channel-telegram-capability-conformance",
      status: "PASS",
      phases: [{
        id: "logs",
        results: [{
          command: "ocm logs kova-self-check --tail 200 --raw",
          status: 0,
          stdout: "model fallback decision reason=timeout detail=503 mock provider channel workflow failure",
          stderr: "",
          durationMs: 10
        }]
      }]
    };
    evaluateRecord(expectedFailureRecord, { thresholds: {} });
    assertEqual(
      expectedFailureRecord.violations?.some((violation) => violation.metric === "providerTimeoutMentions") ?? false,
      false,
      "expected Kova mock provider failure logs do not create global provider timeout violations"
    );

    const realTimeoutRecord = {
      scenario: "provider-timeout-self-check",
      status: "PASS",
      phases: [{
        id: "logs",
        results: [{
          command: "ocm logs kova-self-check --tail 200 --raw",
          status: 0,
          stdout: "provider timeout while calling upstream model",
          stderr: "",
          durationMs: 10
        }]
      }]
    };
    evaluateRecord(realTimeoutRecord, { thresholds: {} });
    assertEqual(
      realTimeoutRecord.violations?.some((violation) => violation.metric === "providerTimeoutMentions") ?? false,
      true,
      "real provider timeout logs still create provider timeout violations"
    );

    return {
      id: "expected-mock-provider-failure-timeout-logs",
      status: "PASS",
      command: "evaluate expected mock provider failure timeout log filtering",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "expected-mock-provider-failure-timeout-logs",
      status: "FAIL",
      command: "evaluate expected mock provider failure timeout log filtering",
      durationMs: 0,
      message: error.message
    };
  }
}

export function optionalNoLogsCommandCheck() {
  try {
    const result = {
      command: "ocm logs 'kova-empty-logs' --tail 250 --raw",
      status: 1,
      stdout: "",
      stderr: "ocm: no logs exist for env \"kova-empty-logs\" across stdout or stderr\n"
    };
    assertEqual(isNoLogsOutput(result.stderr), true, "exact missing logs stderr is detected");
    assertEqual(isOptionalNoLogsResult(result), true, "empty stdout and exact stderr are optional");
    normalizeOptionalCommandResult(result);
    assertEqual(result.status, 0, "missing logs are normalized to optional success");
    assertEqual(result.originalStatus, 1, "original log command status retained");
    assertEqual(result.optional, true, "optional marker set");
    for (const candidate of [
      {
        command: "ocm logs 'kova-empty-logs' --tail 250 --raw",
        status: 1,
        stdout: "unexpected output",
        stderr: "ocm: no logs exist for env \"kova-empty-logs\" across stdout or stderr\n"
      },
      {
        command: "ocm logs 'kova-empty-logs' --tail 250 --raw",
        status: 1,
        stdout: "",
        stderr: "warning\nocm: no logs exist for env \"kova-empty-logs\" across stdout or stderr\n"
      },
      {
        command: "ocm logs 'kova-empty-logs' --tail 250 --raw",
        status: 1,
        stdout: "",
        stderr: "ocm: no logs exist for env \"kova-empty-logs\" across stdout or stderr\nextra"
      },
      {
        command: "ocm logs 'kova-empty-logs' --tail 250 --raw",
        status: 124,
        timedOut: true,
        stdout: "",
        stderr: "ocm: no logs exist for env \"kova-empty-logs\" across stdout or stderr\n"
      },
      {
        command: "ocm logs 'kova-empty-logs' --tail 250 --raw",
        status: 1,
        signal: "SIGTERM",
        stdout: "",
        stderr: "ocm: no logs exist for env \"kova-empty-logs\" across stdout or stderr\n"
      }
    ]) {
      const originalStatus = candidate.status;
      normalizeOptionalCommandResult(candidate);
      assertEqual(candidate.status, originalStatus, "non-exact missing logs output retains its failure status");
      assertEqual(candidate.optional, undefined, "non-exact missing logs output is not optional");
    }
    return {
      id: "optional-no-logs-command",
      status: "PASS",
      command: "evaluate optional empty log collection",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "optional-no-logs-command",
      status: "FAIL",
      command: "evaluate optional empty log collection",
      durationMs: 0,
      message: error.message
    };
  }
}

export function commandResultInterpretationCheck() {
  try {
    const blocked = {
      command: "node support/example.mjs",
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        failureDomain: "kova-harness",
        recordStatus: "BLOCKED",
        error: "fixture setup failed"
      }),
      stderr: ""
    };
    const interpreted = attachCommandResultInterpretation(blocked);
    assertEqual(interpreted.interpretation.schemaVersion, "kova.commandResultInterpretation.v1", "interpretation schema");
    assertEqual(interpreted.interpretation.structured, true, "structured helper result detected");
    assertEqual(interpreted.interpretation.failureDomain, "kova-harness", "failure domain preserved");
    assertEqual(commandFailureRecordStatus(interpreted), "BLOCKED", "structured record status honored");
    assertEqual(classifyCommandFailure(interpreted), "BLOCKED", "runner honors structured lifecycle status");
    const summary = buildReportSummary({
      schemaVersion: "kova.report.v1",
      mode: "execution",
      target: "runtime:stable",
      records: [{
        scenario: "structured-helper-failure",
        surface: "structured-helper-failure",
        title: "Structured Helper Failure",
        status: "BLOCKED",
        phases: [{ id: "run", results: [interpreted] }],
        measurements: {}
      }],
      summary: { statuses: { BLOCKED: 1 } }
    });
    assertEqual(summary.scenarios?.[0]?.failureDomain, "kova-harness", "summary failure domain");
    assertEqual(summary.scenarios?.[0]?.failureReason, "kova-harness: fixture setup failed", "summary failure reason uses structured evidence");

    const unstructured = interpretCommandResult({
      command: "node support/example.mjs",
      status: 1,
      stdout: "plain failure",
      stderr: ""
    });
    assertEqual(unstructured.structured, false, "plain stdout is not structured evidence");
    assertEqual(unstructured.recordStatus, null, "plain stdout does not override default classification");

    return {
      id: "command-result-interpretation",
      status: "PASS",
      command: "evaluate structured helper failure interpretation",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "command-result-interpretation",
      status: "FAIL",
      command: "evaluate structured helper failure interpretation",
      durationMs: 0,
      message: error.message
    };
  }
}
