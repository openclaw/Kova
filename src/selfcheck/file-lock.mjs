import { open, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyExecutionDomain,
  currentExecutionDomainIdentity,
  normalizeMachineIdentity,
  withFileLock
} from "../file-lock.mjs";
import { assertEqual, fileExists, sleep } from "./harness.mjs";

export async function fileLockRecoveryCheck(tmp) {
  try {
    assertEqual(normalizeMachineIdentity("uninitialized"), "", "placeholder machine ID rejected");
    assertEqual(normalizeMachineIdentity("0".repeat(32)), "", "zero machine ID rejected");
    assertEqual(normalizeMachineIdentity("f".repeat(32)), "", "all-F machine ID rejected");
    assertEqual(
      normalizeMachineIdentity("A".repeat(32)),
      "a".repeat(32),
      "valid machine UUID normalized"
    );
    assertEqual(
      classifyExecutionDomain(
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: "boot-a",
          pidNamespace: "pid:[1]"
        },
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: "boot-b",
          pidNamespace: "pid:[1]"
        }
      ),
      "rebooted",
      "proven machine reboot is reclaimable"
    );
    assertEqual(
      classifyExecutionDomain(
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: "boot-a",
          pidNamespace: "pid:[1]"
        },
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: "boot-b",
          pidNamespace: "pid:[2]"
        }
      ),
      "foreign",
      "foreign PID namespace defeats reboot reclamation"
    );
    assertEqual(
      classifyExecutionDomain(
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: "boot-a",
          pidNamespace: null
        },
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: "boot-b",
          pidNamespace: null
        }
      ),
      "unknown",
      "missing PID namespace identity defeats reboot reclamation"
    );
    assertEqual(
      classifyExecutionDomain(
        {
          host: "host-a",
          hardwareMachine: null,
          installationMachine: "install-a",
          boot: "boot-a",
          pidNamespace: null
        },
        {
          host: "host-a",
          hardwareMachine: null,
          installationMachine: "install-a",
          boot: "boot-b",
          pidNamespace: null
        }
      ),
      "unknown",
      "clonable installation identity cannot prove a reboot"
    );
    assertEqual(
      classifyExecutionDomain(
        {
          host: "host-a",
          hardwareMachine: null,
          installationMachine: "install-a",
          boot: "boot-a",
          pidNamespace: "pid:[1]"
        },
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: null,
          boot: "boot-a",
          pidNamespace: "pid:[1]"
        }
      ),
      "local",
      "same-boot identity-source transition remains local"
    );
    assertEqual(
      classifyExecutionDomain(
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: null,
          boot: "boot-a",
          pidNamespace: null
        },
        {
          host: "host-b",
          hardwareMachine: "machine-a",
          installationMachine: null,
          boot: "boot-b",
          pidNamespace: null
        }
      ),
      "foreign",
      "conflicting hosts defeat a cloned machine identity"
    );
    assertEqual(
      classifyExecutionDomain(
        { hardwareMachine: null, installationMachine: null, boot: "boot-a", pidNamespace: null },
        { hardwareMachine: null, installationMachine: null, boot: "boot-a", pidNamespace: "pid:[1]" }
      ),
      "unknown",
      "missing PID namespace identity fails closed"
    );
    assertEqual(
      classifyExecutionDomain(
        { hardwareMachine: "machine-a", boot: "boot-a", pidNamespace: "pid:[1]" },
        { hardwareMachine: "machine-b", boot: "boot-a", pidNamespace: "pid:[1]" }
      ),
      "foreign",
      "different machine identities remain foreign"
    );
    assertEqual(
      classifyExecutionDomain(
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: {},
          pidNamespace: null
        },
        {
          host: "host-a",
          hardwareMachine: "machine-a",
          installationMachine: "install-a",
          boot: "boot-a",
          pidNamespace: null
        }
      ),
      "unknown",
      "malformed execution-domain fields fail closed"
    );
    for (const field of ["host", "pidNamespace"]) {
      assertEqual(
        classifyExecutionDomain(
          {
            host: "host-a",
            hardwareMachine: "machine-a",
            installationMachine: "install-a",
            boot: "boot-a",
            pidNamespace: null,
            [field]: {}
          },
          {
            host: "host-a",
            hardwareMachine: "machine-a",
            installationMachine: "install-a",
            boot: "boot-a",
            pidNamespace: null
          }
        ),
        "unknown",
        `malformed ${field} fails closed`
      );
    }
    assertEqual(
      classifyExecutionDomain(null, currentExecutionDomainIdentity()),
      "unknown",
      "missing owner execution domain fails closed"
    );
    assertEqual(
      classifyExecutionDomain(currentExecutionDomainIdentity(), null),
      "unknown",
      "missing current execution domain fails closed"
    );
    const localExecutionDomain = currentExecutionDomainIdentity();
    assertEqual(Boolean(localExecutionDomain), true, "current execution domain is available");
    const unsupportedLink = (code) => async () => {
      const error = new Error(`simulated ${code}`);
      error.code = code;
      throw error;
    };
    for (const code of ["ENOTSUP", "EPERM"]) {
      const fallbackLock = join(tmp, `fallback-${code.toLowerCase()}.lock`);
      let callbackRuns = 0;
      await withFileLock(
        fallbackLock,
        async () => {
          callbackRuns += 1;
        },
        { linkFile: unsupportedLink(code) }
      );
      assertEqual(callbackRuns, 1, `${code} hard-link fallback acquires the lock`);
      assertEqual(await fileExists(fallbackLock), false, `${code} fallback releases the lock`);
    }
    const fallbackContentionLock = join(tmp, "fallback-contention.lock");
    let fallbackActive = 0;
    let fallbackMaximum = 0;
    await Promise.all([0, 1].map(() => withFileLock(
      fallbackContentionLock,
      async () => {
        fallbackActive += 1;
        fallbackMaximum = Math.max(fallbackMaximum, fallbackActive);
        await new Promise((resolve) => setTimeout(resolve, 20));
        fallbackActive -= 1;
      },
      {
        linkFile: unsupportedLink("ENOTSUP"),
        retryMs: 2,
        timeoutMs: 1_000
      }
    )));
    assertEqual(fallbackMaximum, 1, "hard-link fallback serializes contenders");

    const closeRetryLock = join(tmp, "fallback-close-retry.lock");
    let fallbackCloseAttempts = 0;
    let fallbackCloseCallbackRuns = 0;
    await withFileLock(
      closeRetryLock,
      async () => {
        fallbackCloseCallbackRuns += 1;
      },
      {
        linkFile: unsupportedLink("ENOTSUP"),
        openFallbackFile: async (...args) => {
          const handle = await open(...args);
          return {
            writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
            chmod: (...chmodArgs) => handle.chmod(...chmodArgs),
            sync: (...syncArgs) => handle.sync(...syncArgs),
            close: async () => {
              fallbackCloseAttempts += 1;
              if (fallbackCloseAttempts === 1) {
                const error = new Error("simulated close failure");
                error.code = "EIO";
                throw error;
              }
              return handle.close();
            }
          };
        }
      }
    );
    assertEqual(
      fallbackCloseCallbackRuns,
      1,
      "durable fallback lock proceeds after an initial close failure"
    );
    assertEqual(fallbackCloseAttempts, 2, "fallback lock retries close during release");
    assertEqual(
      await fileExists(closeRetryLock),
      false,
      "fallback lock releases only after the retained handle closes"
    );

    const tornFallbackLock = join(tmp, "fallback-write-failure.lock");
    let fallbackWriteRejected = false;
    try {
      await withFileLock(
        tornFallbackLock,
        async () => {},
        {
          linkFile: unsupportedLink("ENOTSUP"),
          openFallbackFile: async (...args) => {
            const handle = await open(...args);
            return {
              writeFile: async () => {
                await handle.writeFile("{", "utf8");
                const error = new Error("simulated metadata write failure");
                error.code = "EIO";
                throw error;
              },
              chmod: (...chmodArgs) => handle.chmod(...chmodArgs),
              sync: (...syncArgs) => handle.sync(...syncArgs),
              close: (...closeArgs) => handle.close(...closeArgs)
            };
          }
        }
      );
    } catch (error) {
      fallbackWriteRejected = error?.code === "EIO";
    }
    assertEqual(fallbackWriteRejected, true, "fallback metadata write failure is reported");
    let tornSuccessorProtected = false;
    try {
      await withFileLock(tornFallbackLock, async () => {}, {
        linkFile: unsupportedLink("ENOTSUP"),
        retryMs: 2,
        staleMs: 1,
        timeoutMs: 25
      });
    } catch (error) {
      tornSuccessorProtected = /timed out waiting for Kova file lock/.test(error.message);
    }
    assertEqual(
      tornSuccessorProtected,
      true,
      "successor cannot replace a torn fallback lock"
    );
    assertEqual(
      await readFile(tornFallbackLock, "utf8"),
      "{",
      "failed fallback publication remains fail-closed"
    );
    await rm(tornFallbackLock);

    const malformedLock = join(tmp, "malformed-publication.lock");
    await writeFile(malformedLock, "{\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(malformedLock, old, old);
    let malformedProtected = false;
    let malformedTimeoutMessage = "";
    try {
      await withFileLock(malformedLock, async () => {}, {
        linkFile: unsupportedLink("ENOTSUP"),
        staleMs: 1,
        timeoutMs: 25,
        retryMs: 2
      });
    } catch (error) {
      malformedTimeoutMessage = error.message;
      malformedProtected = /timed out waiting for Kova file lock/.test(error.message);
    }
    assertEqual(malformedProtected, true, "malformed lock without domain identity is preserved");
    assertEqual(
      /owner metadata invalid; ageMs=\d+, fingerprint=[a-f0-9]{64}/.test(
        malformedTimeoutMessage
      ),
      true,
      "malformed lock timeout pins the observed lock generation"
    );
    assertEqual(
      await readFile(malformedLock, "utf8"),
      "{\n",
      "torn hard-link fallback remains fail-closed for manual recovery"
    );
    await rm(malformedLock);

    const incompleteLock = join(tmp, "incomplete-publication.lock");
    await writeFile(incompleteLock, `${JSON.stringify({ pid: process.pid })}\n`);
    await utimes(incompleteLock, old, old);
    let incompleteProtected = false;
    try {
      await withFileLock(incompleteLock, async () => {}, {
        staleMs: 1,
        timeoutMs: 25,
        retryMs: 2
      });
    } catch (error) {
      incompleteProtected = /timed out waiting for Kova file lock/.test(error.message);
    }
    assertEqual(incompleteProtected, true, "incomplete lock without domain identity is preserved");
    await rm(incompleteLock);

    const legacyCandidateLock = join(tmp, "legacy-candidate-publication.lock");
    const legacyCandidatePath = `${legacyCandidateLock}.reclaim-${"a".repeat(64)}.candidate-12345678-1234-4123-8123-123456789abc`;
    await writeFile(legacyCandidatePath, "{\n");
    await utimes(legacyCandidatePath, old, old);
    await withFileLock(legacyCandidateLock, async () => {}, {
      staleMs: 1,
      timeoutMs: 25,
      retryMs: 2
    });
    assertEqual(
      await fileExists(legacyCandidatePath),
      false,
      "stale torn legacy reclaim candidate is removed"
    );

    const foreignDomainLock = join(tmp, "foreign-domain-publication.lock");
    await writeFile(foreignDomainLock, `${JSON.stringify({
      pid: 2_147_483_647,
      executionDomainIdentity: "other-host"
    })}\n`);
    let foreignDomainProtected = false;
    try {
      await withFileLock(foreignDomainLock, async () => {}, {
        staleMs: 1,
        timeoutMs: 25,
        retryMs: 2
      });
    } catch (error) {
      foreignDomainProtected = /timed out waiting for Kova file lock/.test(error.message);
    }
    assertEqual(foreignDomainProtected, true, "foreign execution-domain lock is not reclaimed locally");
    await rm(foreignDomainLock);

    const foreignHostLock = join(
      tmp,
      `foreign-host-${"p".repeat(180)}.lock`
    );
    const hostileHost =
      `kova-foreign-host.invalid\n\u001b[31m\u009b\u2028\u202e${"x".repeat(300)}`;
    await writeFile(foreignHostLock, `${JSON.stringify({
      pid: 2_147_483_647,
      executionDomainIdentity: {
        host: hostileHost,
        boot: "foreign-boot",
        pidNamespace: null
      }
    })}\n`);
    let foreignHostProtected = false;
    let foreignHostTimeoutMessage = "";
    try {
      await withFileLock(foreignHostLock, async () => {}, {
        staleMs: 1,
        timeoutMs: 25,
        retryMs: 2
      });
    } catch (error) {
      foreignHostTimeoutMessage = error.message;
      foreignHostProtected = /timed out waiting for Kova file lock/.test(error.message);
    }
    assertEqual(foreignHostProtected, true, "foreign-host lock is not reclaimed locally");
    assertEqual(
      foreignHostTimeoutMessage.includes(
        'host="kova-foreign-host.invalid\\u000a\\u001b[31m\\u009b\\u2028\\u202e'
      ),
      true,
      "foreign-host timeout identifies the escaped lock owner"
    );
    assertEqual(
      foreignHostTimeoutMessage.includes("\n") ||
        foreignHostTimeoutMessage.includes("\u001b") ||
        foreignHostTimeoutMessage.includes("\u009b") ||
        foreignHostTimeoutMessage.includes("\u2028") ||
        foreignHostTimeoutMessage.includes("\u202e") ||
        foreignHostTimeoutMessage.includes("x".repeat(200)),
      false,
      "foreign-host timeout bounds and escapes untrusted owner metadata"
    );
    assertEqual(
      foreignHostTimeoutMessage.includes(JSON.stringify(foreignHostLock)),
      true,
      "foreign-host timeout preserves the complete escaped lock path"
    );
    assertEqual(
      foreignHostTimeoutMessage.includes(
        "quiescing all Kova writers"
      ) &&
        foreignHostTimeoutMessage.includes(
          "confirm its owner and fingerprint still match this timeout"
        ),
      true,
      "foreign-host timeout gives scoped manual recovery guidance"
    );
    assertEqual(
      /fingerprint=[a-f0-9]{64}/.test(foreignHostTimeoutMessage),
      true,
      "foreign-host timeout pins the observed lock generation"
    );
    await rm(foreignHostLock);

    const sameHostForeignMachineLock = join(tmp, "same-host-foreign-machine.lock");
    await writeFile(sameHostForeignMachineLock, `${JSON.stringify({
      pid: 2_147_483_647,
      executionDomainIdentity: {
        host: "shared-hostname",
        hardwareMachine: "foreign-machine",
        installationMachine: "foreign-installation",
        boot: "foreign-boot",
        pidNamespace: null
      }
    })}\n`);
    let sameHostForeignMachineProtected = false;
    try {
      await withFileLock(sameHostForeignMachineLock, async () => {}, {
        staleMs: 1,
        timeoutMs: 25,
        retryMs: 2
      });
    } catch (error) {
      sameHostForeignMachineProtected = /timed out waiting for Kova file lock/.test(error.message);
    }
    assertEqual(
      sameHostForeignMachineProtected,
      true,
      "same-hostname foreign-machine lock is not reclaimed locally"
    );
    await rm(sameHostForeignMachineLock);

    const reusedPidLock = join(tmp, "reused-pid-publication.lock");
    await writeFile(reusedPidLock, `${JSON.stringify({
      token: "x",
      pid: process.pid,
      processIdentity: "ps:reused-process",
      executionDomainIdentity: localExecutionDomain,
      createdAt: new Date(Date.now() - 60_000).toISOString()
    })}\n`);
    await utimes(reusedPidLock, old, old);
    let reusedPidAcquired = false;
    await withFileLock(reusedPidLock, async () => {
      reusedPidAcquired = true;
    }, {
      staleMs: 1_000,
      timeoutMs: 2_000,
      retryMs: 5
    });
    assertEqual(reusedPidAcquired, true, "stale lock is reclaimed after PID reuse");

    const racedLock = join(tmp, "raced-publication.lock");
    await writeFile(racedLock, `${JSON.stringify({
      token: "y",
      pid: 2_147_483_647,
      executionDomainIdentity: localExecutionDomain,
      createdAt: new Date().toISOString()
    })}\n`);
    let active = 0;
    let maxActive = 0;
    await Promise.all([0, 1].map(() => withFileLock(racedLock, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
    }, {
      staleMs: 60_000,
      timeoutMs: 2_000,
      retryMs: 5
    })));
    assertEqual(maxActive, 1, "stale-lock contenders remain serialized");
    assertEqual(await fileExists(racedLock), false, "owned lock removed after serialized callbacks");

    const liveLock = join(tmp, "live-publication.lock");
    active = 0;
    maxActive = 0;
    await Promise.all([0, 1].map(() => withFileLock(liveLock, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active -= 1;
    }, {
      staleMs: 5,
      timeoutMs: 2_000,
      retryMs: 2
    })));
    assertEqual(maxActive, 1, "live lock is not reclaimed after its stale threshold");

    return {
      id: "file-lock-recovery",
      status: "PASS",
      command: "validate and reclaim publication locks",
      durationMs: 0
    };
  } catch (error) {
    return {
      id: "file-lock-recovery",
      status: "FAIL",
      command: "validate and reclaim publication locks",
      durationMs: 0,
      message: error.message
    };
  }
}
