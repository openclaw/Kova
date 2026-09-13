import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { scriptForMode as buildMockProviderScriptForMode } from "../../support/channel-workflow-provider-script.mjs";
import {
  buildAuthCleanupPhase,
  buildAuthPreparePhase,
  mockAiProviderServeCommand,
  mockProviderCleanupCommand,
  mockProviderPortCommand
} from "../auth.mjs";
import { copyCollectorArtifacts } from "../collectors/artifacts.mjs";
import { triggerDiagnosticReport, triggerHeapSnapshot } from "../collectors/diagnostics.mjs";
import { parseProviderRequestLog } from "../collectors/provider.mjs";
import { quoteShell, runCommand } from "../commands.mjs";
import { repoRoot } from "../paths.mjs";
import {
  isOwnedLegacyMockProviderCommand,
  isOwnedMockProviderSupervisorCommand,
  mockProviderOwnerRecord,
  mockProviderStopFile,
  mockProviderSupervisorArgs,
  positiveProcessId,
  resolveOwnedMockProviderPid,
  stopOwnedMockProvider
} from "../process-safety.mjs";
import { runAuthCommand } from "../run/command-executor.mjs";
import { assertSafeScenarioCommand } from "../safety.mjs";
import { assertEqual, assertPathMissing, sleep } from "./harness.mjs";

export async function mockProviderBehaviorCheck(tmp) {
  const dir = join(tmp, "mock-provider-behavior");
  await mkdir(dir, { recursive: true });
  const scriptPath = join(dir, "script.json");
  const requestLogPath = join(dir, "requests.jsonl");
  const serverLogPath = join(dir, "server.log");
  const portPath = join(dir, "port");
  const pidPath = join(dir, "pid");
  const writePort = mockProviderPortCommand({
    serverLog: serverLogPath,
    pidFile: pidPath,
    portFile: portPath
  });
  const command = [
    `node support/write-mock-ai-provider-script.mjs --output ${quoteShell(scriptPath)} --mode error-then-recover --error-status 503`,
    mockAiProviderServeCommand({ scriptPath, requestLog: requestLogPath, serverLog: serverLogPath, pidFile: pidPath }),
    `trap ${quoteShell(`${mockProviderCleanupCommand(dir)} >/dev/null 2>&1 || true`)} EXIT`,
    `for i in $(seq 1 100); do ${writePort} >/dev/null 2>&1 && test -s ${quoteShell(portPath)} && node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$(cat ${quoteShell(portPath)})" && break; sleep 0.1; done`,
    `test -s ${quoteShell(portPath)} || { cat ${quoteShell(serverLogPath)} >&2; exit 1; }`,
    `port=$(cat ${quoteShell(portPath)})`,
    "node -e 'const port=process.argv[1]; const body=JSON.stringify({model:\"gpt-5.5\",stream:false}); const send=()=>fetch(`http://127.0.0.1:${port}/v1/responses`,{method:\"POST\",headers:{\"content-type\":\"application/json\"},body}).then(async r=>({status:r.status,text:await r.text()})); const first=await send(); const second=await send(); console.log(JSON.stringify({first:first.status,second:second.status}));' \"$port\""
  ].join("; ");
  const result = await runCommand(command, { timeoutMs: 30000 });
  try {
    if (result.status !== 0) {
      const detail = result.timedOut ? `timed out after ${result.durationMs}ms` : (result.stderr || result.stdout);
      throw new Error(`mock provider behavior command failed: ${detail}`);
    }
    const response = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assertEqual(response.first, 503, "first transient provider status");
    assertEqual(response.second, 200, "second recovered provider status");
    const evidence = parseProviderRequestLog(await readFile(requestLogPath, "utf8"));
    const responseRequests = evidence.requests.filter((request) => request.route === "/v1/responses");
    assertEqual(responseRequests.length, 2, "behavior request count");
    assertEqual(responseRequests[0]?.mode, "error-then-recover", "first request behavior");
    assertEqual(responseRequests[0]?.errorClass, "provider-error", "first request error class");
    assertEqual(responseRequests[1]?.status, 200, "second recovered request status");
    assertEqual(responseRequests[1]?.errorClass, null, "second request error class");
    return {
      id: "mock-provider-behavior",
      status: "PASS",
      command,
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      id: "mock-provider-behavior",
      status: "FAIL",
      command,
      durationMs: result.durationMs,
      message: error.message
    };
  }
}

export async function mockProviderProcessSafetyCheck(tmp) {
  const dir = join(tmp, "mock-provider-process-safety");
  await mkdir(dir, { recursive: true });
  const supervisorPath = join(repoRoot, "support/mock-ai-provider-supervisor.mjs");
  const legacyExecutablePath = join(repoRoot, "node_modules/.bin/mock-ai-provider");
  const scriptPath = join(dir, "script.json");
  const requestLog = join(dir, "requests.jsonl");
  const serverLog = join(dir, "server.log");
  const pidFile = join(dir, "pid");
  const stopOptions = {
    pidFile,
    supervisorPath,
    legacyExecutablePath,
    scriptPath,
    requestLog,
    serverLog
  };
  const expectedCommand = ["node", ...mockProviderSupervisorArgs(stopOptions)].join(" ");
  const expectedLegacyCommand = [
    "node",
    legacyExecutablePath,
    "serve",
    "--providers", "openai",
    "--script", scriptPath,
    "--port", "0",
    "--request-log", requestLog
  ].join(" ");
  const ownerGeneration = "00000000-0000-4000-8000-000000000001";
  const replacementGeneration = "00000000-0000-4000-8000-000000000002";
  const ownerText = (pid, generation = ownerGeneration) => `${JSON.stringify(mockProviderOwnerRecord(pid, generation))}\n`;

  try {
    assertEqual(positiveProcessId("12345\n"), 12345, "canonical decimal pid");
    for (const invalidPid of ["", "0", "-1", "+1", "01", "1e2", "0x10", "1.0", "123x", "9007199254740992"]) {
      let rejected = false;
      try {
        positiveProcessId(invalidPid);
      } catch (error) {
        rejected = error.message.includes("must be a positive integer");
      }
      assertEqual(rejected, true, `non-canonical pid ${JSON.stringify(invalidPid)} rejected`);
    }
    assertEqual(
      isOwnedMockProviderSupervisorCommand(expectedCommand, stopOptions),
      true,
      "exact mock provider supervisor identity"
    );
    assertEqual(
      isOwnedMockProviderSupervisorCommand(expectedCommand, {
        ...stopOptions,
        scriptPath: join(dir, "other", "script.json")
      }),
      false,
      "same-basename supervisor script is not accepted"
    );
    assertEqual(
      isOwnedMockProviderSupervisorCommand(
        `node unrelated.mjs ${expectedCommand}`,
        stopOptions
      ),
      false,
      "expected supervisor arguments do not authenticate an unrelated process"
    );
    assertEqual(
      isOwnedMockProviderSupervisorCommand(
        `untrusted-node ${mockProviderSupervisorArgs(stopOptions).join(" ")}`,
        stopOptions
      ),
      false,
      "node-like executable name does not authenticate a supervisor"
    );
    assertEqual(
      isOwnedMockProviderSupervisorCommand(
        `${expectedCommand} --script ${join(dir, "other", "script.json")}`,
        stopOptions
      ),
      false,
      "trailing supervisor arguments do not authenticate a different invocation"
    );
    assertEqual(
      isOwnedLegacyMockProviderCommand(expectedLegacyCommand, stopOptions),
      true,
      "exact legacy mock provider identity"
    );
    assertEqual(
      isOwnedLegacyMockProviderCommand(
        `${expectedLegacyCommand} --script ${join(dir, "other", "script.json")}`,
        stopOptions
      ),
      false,
      "trailing legacy arguments do not authenticate a different invocation"
    );

    await writeFile(pidFile, ownerText(12345), "utf8");
    assertEqual(
      await resolveOwnedMockProviderPid({
        ...stopOptions,
        inspectProcess: async () => expectedCommand
      }),
      12345,
      "resource sampler resolves the validated mock provider owner"
    );
    assertEqual(
      await resolveOwnedMockProviderPid({
        ...stopOptions,
        inspectProcess: async () => "node unrelated.mjs"
      }),
      null,
      "resource sampler rejects a recycled mock provider PID"
    );
    await rm(pidFile, { force: true });

    await writeFile(pidFile, "12345\n", "utf8");
    let legacyInspections = 0;
    let legacySignal = null;
    const legacyStop = await stopOwnedMockProvider({
      ...stopOptions,
      inspectProcess: async () => {
        legacyInspections += 1;
        return legacyInspections === 1 ? expectedLegacyCommand : null;
      },
      signalProcess: (pid, signal) => {
        legacySignal = { pid, signal };
      },
      wait: async () => {}
    });
    assertEqual(legacyStop.status, "legacy-stopped", "legacy provider is stopped after exact identity match");
    assertEqual(JSON.stringify(legacySignal), JSON.stringify({ pid: 12345, signal: "SIGTERM" }), "legacy provider signal");
    await assertPathMissing(pidFile, "stopped legacy provider pid file removed");

    await writeFile(pidFile, "12345\n", "utf8");
    let legacyMismatchRejected = false;
    try {
      await stopOwnedMockProvider({
        ...stopOptions,
        inspectProcess: async () => "node unrelated.mjs"
      });
    } catch (error) {
      legacyMismatchRejected = error.message.includes("does not match the expected command");
    }
    assertEqual(legacyMismatchRejected, true, "legacy provider identity mismatch aborts cleanup");
    await access(pidFile);
    await rm(pidFile, { force: true });

    const failedPidFile = join(dir, "pid-directory");
    const failedScriptPath = join(dir, "failed-start-script.json");
    const failedRequestLog = join(dir, "failed-start-requests.jsonl");
    const failedServerLog = join(dir, "failed-start-server.log");
    await mkdir(failedPidFile);
    const writeFailedScript = await runCommand(
      `node support/write-mock-ai-provider-script.mjs --output ${quoteShell(failedScriptPath)} --mode normal`,
      { timeoutMs: 10000 }
    );
    assertEqual(writeFailedScript.status, 0, "partial-startup fixture script created");
    const failedSupervisor = await runCommand(
      mockAiProviderServeCommand({
        scriptPath: failedScriptPath,
        requestLog: failedRequestLog,
        serverLog: failedServerLog,
        pidFile: failedPidFile
      }),
      { timeoutMs: 10000 }
    );
    assertEqual(failedSupervisor.status === 0, false, "supervisor reports pid publication failure");
    await sleep(200);
    const failedProcessList = await runCommand("ps -ww -axo command=", { timeoutMs: 10000 });
    assertEqual(
      failedProcessList.stdout.includes(failedScriptPath),
      false,
      "pid publication failure stops the owned provider"
    );

    for (const invalidPid of [0, -1]) {
      await writeFile(pidFile, `${JSON.stringify({
        schemaVersion: "kova.mock-provider-owner.v1",
        pid: invalidPid,
        token: ownerGeneration
      })}\n`, "utf8");
      let inspected = false;
      let stopRequested = false;
      const result = await stopOwnedMockProvider({
        ...stopOptions,
        inspectProcess: async () => {
          inspected = true;
          return expectedCommand;
        },
        requestStop: async () => {
          stopRequested = true;
        }
      });
      assertEqual(result.status, "invalid-pid", `${invalidPid} pid status`);
      assertEqual(inspected, false, `${invalidPid} pid is not inspected`);
      assertEqual(stopRequested, false, `${invalidPid} pid does not request shutdown`);
      await assertPathMissing(pidFile, `${invalidPid} pid file removed`);
    }

    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });
    try {
      await writeFile(pidFile, ownerText(unrelated.pid), "utf8");
      const recycled = await stopOwnedMockProvider({
        ...stopOptions
      });
      assertEqual(recycled.status, "identity-mismatch", "recycled pid identity status");
      process.kill(unrelated.pid, 0);
      await assertPathMissing(pidFile, "recycled pid file removed");
    } finally {
      unrelated.kill("SIGTERM");
    }

    const absent = await stopOwnedMockProvider({
      ...stopOptions
    });
    assertEqual(absent.status, "already-absent", "mock cleanup is idempotent");

    await writeFile(pidFile, ownerText(12345), "utf8");
    let delayedInspections = 0;
    const delayedStop = await stopOwnedMockProvider({
      ...stopOptions,
      inspectProcess: async () => {
        delayedInspections += 1;
        return delayedInspections < 3 ? expectedCommand : null;
      },
      requestStop: async () => {},
      wait: async () => {}
    });
    assertEqual(delayedStop.status, "stopped", "mock cleanup confirms delayed process exit");
    assertEqual(delayedInspections, 3, "mock cleanup polls until process exit");
    await assertPathMissing(pidFile, "confirmed stop removes pid file");

    const inspectedOwner = mockProviderOwnerRecord(12345, ownerGeneration);
    const replacementOwner = mockProviderOwnerRecord(12346, replacementGeneration);
    const replacementOwnerText = `${JSON.stringify(replacementOwner)}\n`;
    await writeFile(pidFile, `${JSON.stringify(inspectedOwner)}\n`, "utf8");
    let abaInspections = 0;
    let requestedStopFile = null;
    const replaced = await stopOwnedMockProvider({
      ...stopOptions,
      inspectProcess: async () => {
        abaInspections += 1;
        return abaInspections === 1 ? expectedCommand : null;
      },
      requestStop: async (stopFile) => {
        requestedStopFile = stopFile;
        await writeFile(pidFile, replacementOwnerText, "utf8");
      }
    });
    assertEqual(replaced.status, "stopped", "replaced supervisor cleanup confirms inspected exit");
    assertEqual(
      requestedStopFile,
      mockProviderStopFile(pidFile, inspectedOwner),
      "stop request is bound to inspected owner generation"
    );
    assertEqual(
      await readFile(pidFile, "utf8"),
      replacementOwnerText,
      "cleanup retains replacement owner generation"
    );
    await rm(pidFile, { force: true });

    const portFile = join(dir, "port");
    const writePort = mockProviderPortCommand({ serverLog, pidFile, portFile });
    await writeFile(pidFile, `${JSON.stringify(inspectedOwner)}\n`, "utf8");
    await writeFile(serverLog, `${JSON.stringify({ owner: replacementOwner, port: 31337 })}\n`, "utf8");
    const stalePort = await runCommand(writePort, { timeoutMs: 10000 });
    assertEqual(stalePort.status === 0, false, "stale server metadata is rejected");
    await assertPathMissing(portFile, "stale server metadata does not publish a port");
    await writeFile(serverLog, `${JSON.stringify({ owner: inspectedOwner, port: 31338 })}\n`, "utf8");
    const currentPort = await runCommand(writePort, { timeoutMs: 10000 });
    assertEqual(currentPort.status, 0, "matching server metadata publishes a port");
    assertEqual(await readFile(portFile, "utf8"), "31338", "matching server metadata port");
    await rm(pidFile, { force: true });
    await rm(portFile, { force: true });

    await writeFile(pidFile, ownerText(12345), "utf8");
    let stopTimedOut = false;
    try {
      await stopOwnedMockProvider({
        ...stopOptions,
        inspectProcess: async () => expectedCommand,
        requestStop: async () => {},
        stopTimeoutMs: 0
      });
    } catch (error) {
      stopTimedOut = error.message === "mock provider supervisor 12345 did not stop within 0ms";
    }
    assertEqual(stopTimedOut, true, "mock cleanup reports stop timeout");
    await access(pidFile);
    await rm(pidFile, { force: true });

    for (const failure of ["inspect", "request"]) {
      await writeFile(pidFile, ownerText(12345), "utf8");
      let rejected = false;
      try {
        await stopOwnedMockProvider({
          ...stopOptions,
          inspectProcess: async () => {
            if (failure === "inspect") {
              throw new Error("process inspection failed");
            }
            return expectedCommand;
          },
          requestStop: async () => {
            throw new Error("stop request failed");
          }
        });
      } catch (error) {
        rejected = error.message === (failure === "inspect" ? "process inspection failed" : "stop request failed");
      }
      assertEqual(rejected, true, `${failure} failure is propagated`);
      await access(pidFile);
      await rm(pidFile, { force: true });
    }

    const cleanupPhase = buildAuthCleanupPhase({ mode: "mock" }, dir);
    const cleanupCommand = cleanupPhase.commands[0];
    assertEqual(cleanupCommand.includes("stop-mock-ai-provider.mjs"), true, "auth cleanup uses guarded helper");
    assertEqual(cleanupCommand.includes(supervisorPath), true, "auth cleanup pins supervisor path");
    assertEqual(cleanupCommand.includes(legacyExecutablePath), true, "auth cleanup pins legacy executable path");
    assertEqual(cleanupCommand.includes(join(dir, "mock-openai", "script.json")), true, "auth cleanup pins script path");
    assertEqual(cleanupCommand.includes(join(dir, "mock-openai", "requests.jsonl")), true, "auth cleanup pins request log");
    assertEqual(cleanupCommand.includes(join(dir, "mock-openai", "server.log")), true, "auth cleanup pins server log");

    const lifecycleDir = join(tmp, "mock-provider-auth-lifecycle");
    const authPolicy = {
      mode: "mock",
      mockProvider: { mode: "normal" },
      commandEnv: {},
      redactionValues: []
    };
    const lifecycleContext = { timeoutMs: 15000, resourceSampling: false };
    const lifecyclePrepare = buildAuthPreparePhase(authPolicy, lifecycleDir);
    const lifecycleCleanup = buildAuthCleanupPhase(authPolicy, lifecycleDir);
    let scenarioBoundaryRejected = false;
    try {
      assertSafeScenarioCommand(lifecyclePrepare.commands[0], {}, "kova-safe-test", lifecycleDir);
    } catch (error) {
      scenarioBoundaryRejected = /^refusing /.test(error.message);
    }
    assertEqual(scenarioBoundaryRejected, true, "generated auth lifecycle stays outside registry command policy");
    const lifecycleStart = await runAuthCommand(
      lifecyclePrepare.commands[0],
      lifecycleContext,
      "kova-safe-test",
      lifecycleDir,
      lifecyclePrepare,
      0,
      authPolicy
    );
    const lifecycleStop = await runAuthCommand(
      lifecycleCleanup.commands[0],
      lifecycleContext,
      "kova-safe-test",
      lifecycleDir,
      lifecycleCleanup,
      0,
      authPolicy
    );
    assertEqual(lifecycleStart.status, 0, "generated auth prepare command runs through the auth executor");
    assertEqual(lifecycleStop.status, 0, "generated auth cleanup command runs through the auth executor");

    const prepareDir = join(tmp, "mock-provider-startup-failure");
    const preparePhase = buildAuthPreparePhase(
      { mode: "mock", mockProvider: { mode: "normal" } },
      prepareDir
    );
    const prepareCommand = preparePhase.commands[0]
      .replace("seq 1 100", "seq 1 2")
      .replace('+"/health"', '+"/not-ready"');
    assertEqual(
      prepareCommand.split("stop-mock-ai-provider.mjs").length - 1,
      2,
      "startup command cleans stale and unhealthy providers"
    );
    assertEqual(
      prepareCommand.includes("stop-mock-ai-provider.mjs") && prepareCommand.includes(" || exit $?; "),
      true,
      "stale provider cleanup failure aborts startup"
    );
    assertEqual(
      prepareCommand.includes('kill "$supervisor_pid"'),
      true,
      "provider startup bounds supervisor pid publication"
    );
    const failedStartup = await runCommand(prepareCommand, { timeoutMs: 10000 });
    assertEqual(failedStartup.status === 0, false, "unhealthy mock provider startup fails");
    await assertPathMissing(join(prepareDir, "mock-openai", "pid"), "unhealthy startup pid file removed");
    await sleep(200);
    const processList = await runCommand("ps -ww -axo command=", { timeoutMs: 10000 });
    assertEqual(
      processList.stdout.includes(join(prepareDir, "mock-openai", "script.json")),
      false,
      "unhealthy mock provider process stopped"
    );

    return {
      id: "mock-provider-process-safety",
      status: "PASS",
      command: "exercise guarded mock provider cleanup",
      durationMs: failedStartup.durationMs
    };
  } catch (error) {
    return {
      id: "mock-provider-process-safety",
      status: "FAIL",
      command: "exercise guarded mock provider cleanup",
      durationMs: 0,
      message: error.message
    };
  }
}

export async function diagnosticArtifactIdentityCheck(tmp) {
  try {
    const first = join(tmp, "diagnostics-a", "report.json");
    const second = join(tmp, "diagnostics-b", "report.json");
    const retainedDir = join(tmp, "diagnostics-retained");
    await mkdir(join(tmp, "diagnostics-a"), { recursive: true });
    await mkdir(join(tmp, "diagnostics-b"), { recursive: true });
    await writeFile(first, "first");
    await writeFile(second, "second");
    const firstCopy = await copyCollectorArtifacts([first], retainedDir);
    const repeatedCopy = await copyCollectorArtifacts([first], retainedDir);
    const secondCopy = await copyCollectorArtifacts([second], retainedDir);
    const firstName = basename(firstCopy.artifacts[0]);
    const secondName = basename(secondCopy.artifacts[0]);
    assertEqual(firstName, basename(repeatedCopy.artifacts[0]), "diagnostic artifact name is stable");
    assertEqual(firstName === secondName, false, "same-basename diagnostics remain distinct");
    assertEqual(firstName.startsWith("report-"), true, "diagnostic artifact keeps source basename");
    assertEqual(firstName.endsWith(".json"), true, "diagnostic artifact keeps source extension");

    for (const invalidPid of [0, -1, "1e3", "+123", "123.0", "1; kill -9 1"]) {
      for (const trigger of [triggerHeapSnapshot, triggerDiagnosticReport]) {
        const result = await trigger("kova-invalid-pid", invalidPid, 1000, null);
        assertEqual(result.commandStatus, 1, `${trigger.name} rejects pid ${invalidPid}`);
        assertEqual(
          result.error.includes("must be a positive integer"),
          true,
          `${trigger.name} explains invalid pid ${invalidPid}`
        );
      }
    }

    return {
      id: "diagnostic-process-and-artifact-safety",
      status: "PASS",
      command: "validate diagnostic PID and artifact identity",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "diagnostic-process-and-artifact-safety",
      status: "FAIL",
      command: "validate diagnostic PID and artifact identity",
      durationMs: 0,
      message: error.message
    };
  }
}

export function mockProviderScriptModesCheck() {
  try {
    const scripts = new Map([
      ["protocol-failure", buildMockProviderScriptForMode({ mode: "protocol-failure", marker: "KOVA_AGENT_OK", channelWorkflowCases: [] }, repoRoot)],
      ["disconnect-then-recover", buildMockProviderScriptForMode({ mode: "disconnect-then-recover", marker: "KOVA_AGENT_OK", channelWorkflowCases: [] }, repoRoot)],
      ["exec-tool-safety", buildMockProviderScriptForMode({ mode: "exec-tool-safety", marker: "KOVA_AGENT_OK", channelWorkflowCases: [] }, repoRoot)],
      ["exec-tool-failure-only", buildMockProviderScriptForMode({ mode: "exec-tool-failure-only", marker: "KOVA_AGENT_OK", channelWorkflowCases: [] }, repoRoot)]
    ]);

    const protocolStep = scripts.get("protocol-failure")?.steps?.[0];
    assertEqual(protocolStep?.respond?.type, "malformed", "protocol failure response type");
    assertEqual(protocolStep?.respond?.status, 200, "protocol failure stays valid HTTP");
    JSON.parse(protocolStep?.respond?.body ?? "");

    const disconnectSteps = scripts.get("disconnect-then-recover")?.steps ?? [];
    assertEqual(disconnectSteps.length, 2, "disconnect recovery step count");
    assertEqual(disconnectSteps[0]?.respond?.type, "error", "disconnect first step errors");
    assertEqual(disconnectSteps[1]?.respond?.type, "final-text", "disconnect second step recovers");

    const execSteps = scripts.get("exec-tool-safety")?.steps ?? [];
    assertEqual(execSteps.length, 8, "exec safety step count");
    assertEqual(execSteps[0]?.respond?.type, "tool-calls", "exec safety safe tool call");
    assertEqual(execSteps[0]?.respond?.toolCalls?.[0]?.name, "exec", "exec safety safe tool name");
    assertEqual(execSteps[0]?.respond?.toolCalls?.[0]?.arguments?.includes("\"command\""), true, "exec safety uses command argument");
    assertEqual(execSteps[1]?.respond?.text, "KOVA_EXEC_SAFE_REQUEST_DONE", "exec safety safe final");
    assertEqual(execSteps[2]?.respond?.toolCalls?.[0]?.arguments?.includes("KOVA_EXEC_DANGEROUS_PATH"), true, "exec safety dangerous path template");
    assertEqual(execSteps[3]?.respond?.text, "KOVA_EXEC_BLOCKED_REQUEST_DONE", "exec safety blocked final");
    assertEqual(execSteps[4]?.respond?.toolCalls?.[0]?.arguments?.includes("seq 1 20000"), true, "exec safety large output command");
    assertEqual(execSteps[5]?.respond?.text, "KOVA_EXEC_LARGE_OUTPUT_DONE", "exec safety large output final");
    assertEqual(execSteps[6]?.respond?.toolCalls?.[0]?.arguments?.includes("sleep 30"), true, "exec safety timeout command");
    assertEqual(execSteps[6]?.respond?.toolCalls?.[0]?.arguments?.includes("\"timeout\":1"), true, "exec safety timeout argument");
    assertEqual(execSteps[7]?.respond?.text, "KOVA_EXEC_TIMEOUT_DONE", "exec safety timeout final");

    const execFailureOnlySteps = scripts.get("exec-tool-failure-only")?.steps ?? [];
    assertEqual(execFailureOnlySteps.length, 6, "exec failure-only step count");
    assertEqual(execFailureOnlySteps[0]?.respond?.type, "tool-calls", "exec failure-only dangerous tool call");
    assertEqual(execFailureOnlySteps[0]?.respond?.toolCalls?.[0]?.name, "exec", "exec failure-only tool name");
    assertEqual(execFailureOnlySteps[0]?.respond?.toolCalls?.[0]?.arguments?.includes("\"command\""), true, "exec failure-only uses command argument");
    assertEqual(execFailureOnlySteps[0]?.respond?.toolCalls?.[0]?.arguments?.includes("KOVA_EXEC_DANGEROUS_PATH"), true, "exec failure-only dangerous path template");
    assertEqual(execFailureOnlySteps[1]?.match?.requestIndex, 1, "exec failure-only final follows first tool result");
    assertEqual(execFailureOnlySteps[1]?.respond?.text, "KOVA_EXEC_BLOCKED_REQUEST_DONE", "exec failure-only blocked final");
    assertEqual(execFailureOnlySteps[2]?.respond?.toolCalls?.[0]?.arguments?.includes("seq 1 20000"), true, "exec failure-only large output command");
    assertEqual(execFailureOnlySteps[3]?.respond?.text, "KOVA_EXEC_LARGE_OUTPUT_DONE", "exec failure-only large output final");
    assertEqual(execFailureOnlySteps[4]?.respond?.toolCalls?.[0]?.arguments?.includes("sleep 30"), true, "exec failure-only timeout command");
    assertEqual(execFailureOnlySteps[5]?.respond?.text, "KOVA_EXEC_TIMEOUT_DONE", "exec failure-only timeout final");

    return {
      id: "mock-provider-script-modes",
      status: "PASS",
      command: "inline self-check",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "mock-provider-script-modes",
      status: "FAIL",
      command: "inline self-check",
      durationMs: 0,
      message: error.message
    };
  }
}
