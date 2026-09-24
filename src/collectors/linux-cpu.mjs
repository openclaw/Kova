import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let ticksPerSecond;
function clockTicksPerSecond() {
  if (ticksPerSecond === undefined) {
    const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2000 });
    ticksPerSecond = result.status === 0 ? Number(result.stdout.trim()) : NaN;
  }
  if (!Number.isSafeInteger(ticksPerSecond) || ticksPerSecond <= 0) {
    throw new Error("Linux CPU accounting requires CLK_TCK");
  }
  return ticksPerSecond;
}

export function readLinuxCpuCounters(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm can contain spaces and parentheses; fields after its last ')' are fixed.
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  const values = [fields[11], fields[12], fields[13], fields[14], fields[19]].map(Number);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid Linux CPU counters for process ${pid}`);
  }
  return { cpuTicks: values[0] + values[1], childCpuTicks: values[2] + values[3], startTicks: values[4], ppid: Number(fields[1]) };
}

export class LinuxCpuSnapshotChangedError extends Error {}

export function readLinuxCpuSnapshot(processes, previouslyTrackedPids = new Set()) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const visited = new Set();
  const visiting = new Set();
  const counters = [];
  const visit = (entry) => {
    if (visited.has(entry.pid)) return;
    if (visiting.has(entry.pid)) throw new LinuxCpuSnapshotChangedError("Process ancestry changed during CPU collection");
    visiting.add(entry.pid);
    const parent = byPid.get(entry.ppid);
    if (parent) visit(parent);
    visiting.delete(entry.pid);
    visited.add(entry.pid);
    try {
      const values = readLinuxCpuCounters(entry.pid);
      if (values.ppid !== entry.ppid) throw new LinuxCpuSnapshotChangedError("Process parent changed during CPU collection");
      counters.push({ ...entry, ...values });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      // Parent counters precede every live child counter. A child disappearing
      // after the process census invalidates this scan: its parent's earlier
      // wait counter cannot establish that child's terminal CPU transfer.
      if (entry.roles?.length || previouslyTrackedPids.has(entry.pid)) {
        throw Object.assign(new LinuxCpuSnapshotChangedError("Product process exited during CPU collection"), { process: entry });
      }
    }
  };
  // The census needs product processes and their wait-owner ancestry, not
  // unrelated host workloads that happen to share an ancestor such as init.
  for (const entry of processes) {
    if (entry.roles?.length || previouslyTrackedPids.has(entry.pid)) visit(entry);
  }
  return counters;
}

export function readLinuxCpuClock() {
  const hz = clockTicksPerSecond();
  const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  if (!Number.isFinite(uptime) || uptime < 0) throw new Error("Invalid Linux CPU clock");
  return { hz, ticks: uptime * hz, monotonicMs: performance.now() };
}

const identity = (process) => `${process.pid}:${process.startTicks}`;

export function createLinuxCpuAccountant({ accountingRootPid } = {}) {
  let previous = new Map();
  let previousClock;
  // A process can be born after collection starts but remain undiscovered
  // until a later role lookup. Lifetime counters bound the latest interval's
  // CPU, but cannot reconstruct the earlier unsampled intervals.
  let initialClock;
  let reapDebt = new Map();
  let missingWaitOwner = false;
  let missingIntervalBaseline = false;
  return {
    trackedProcessIds() {
      return new Set([...previous.values()].map((entry) => entry.pid));
    },
    hasObservedRoles(process) {
      return [...previous.values()].some((entry) => entry.pid === process.pid &&
        process.roles.every((role) => entry.roles.includes(role)));
    },
    coverageComplete() {
      return !missingIntervalBaseline && !missingWaitOwner && ![...reapDebt.values()].some((debt) => (debt.observedTicks ?? debt.ticks) > 0 && debt.processes.some((entry) => entry.roles?.length));
    },
    lowerBoundSample(processes, clock) {
      const state = { previous, previousClock, initialClock, reapDebt, missingWaitOwner, missingIntervalBaseline };
      let measured;
      let observed;
      let observedMissingIntervalBaseline;
      let observedMissingWaitOwner;
      try {
        measured = this.sample(processes, clock);
        observed = previous;
        observedMissingIntervalBaseline = missingIntervalBaseline;
        observedMissingWaitOwner = missingWaitOwner;
      } finally {
        ({ previous, previousClock, initialClock, reapDebt, missingWaitOwner, missingIntervalBaseline } = state);
      }
      missingIntervalBaseline ||= observedMissingIntervalBaseline;
      missingWaitOwner ||= observedMissingWaitOwner;
      if (previousClock) {
        // Keep terminal discoveries and role changes even if they disappear
        // before settlement, but retain the original interval's counter debt.
        previous = new Map(previous);
        for (const [key, process] of observed) {
          const existingExternalOwner = process.startTicks < Math.floor(previousClock.ticks) - 1 &&
            process.startTicks < Math.floor(initialClock.ticks) - 1;
          const baseline = previous.get(key) ?? (existingExternalOwner ? process : null);
          previous.set(key, { ...process,
            cpuTicks: baseline?.cpuTicks ?? 0,
            childCpuTicks: baseline?.childCpuTicks ?? 0,
            ...(!baseline || baseline.observedCpuTicks !== undefined
              ? { observedCpuTicks: Math.max(process.cpuTicks + process.childCpuTicks, baseline?.observedCpuTicks ?? 0) }
              : {}) });
        }
      }
      return measured.map((process) => ({
        ...process,
        ownCpuPercentUpper: process.ownCpuPercentLower,
        reapedCpuPercent: process.reapedCpuPercentLower,
        reapedCpuPercentUpper: process.reapedCpuPercentLower,
        reapedRoles: process.reapedLowerBoundRoles,
        cpuPercent: (process.roles.length ? process.ownCpuPercentLower : 0) + process.reapedCpuPercentLower,
        cpuLowerBoundOnly: true
      }));
    },
    sample(processes, clock) {
      initialClock ??= clock;
      const nextDebt = new Map([...reapDebt].map(([key, debt]) => [key, { ...debt, processes: [...debt.processes] }]));
      let nextMissingWaitOwner = missingWaitOwner;
      let nextMissingIntervalBaseline = missingIntervalBaseline;
      processes = processes.map((entry) => {
        // CPU history survives title changes and reaping; RSS belongs only to
        // the roles assigned by this census.
        const currentRoles = entry.roles ?? [];
        const roles = [...new Set([...(previous.get(identity(entry))?.roles ?? []), ...(entry.roles ?? [])])];
        return { ...entry, currentRoles, roles, role: roles.join(",") };
      });
      const current = new Map(processes.map((process) => [identity(process), process]));
      const inheritedIncompleteHistory = new Set();
      const previousByPid = new Map([...previous.values()].map((process) => [process.pid, process]));
      const intervalTicks = previousClock === undefined ? null :
        (clock.monotonicMs - (previousClock.finishedMs ?? previousClock.monotonicMs)) * clock.hz / 1000;
      if (intervalTicks !== null && (!(intervalTicks > 0) || clock.hz !== previousClock.hz)) {
        throw new Error("Linux CPU sample clock did not advance");
      }
      const outerIntervalTicks = previousClock === undefined ? null :
        ((clock.finishedMs ?? clock.monotonicMs) - previousClock.monotonicMs) * clock.hz / 1000;
      // Once a child is reaped, Linux transfers its complete CPU lifetime to its
      // wait owner. Subtract the part already observed, including nested waits.
      for (const [key, process] of previous) {
        if (current.has(key)) continue;
        const heldDebt = nextDebt.get(key);
        if ((heldDebt?.observedTicks ?? heldDebt?.ticks) > 0 && heldDebt.processes.some((entry) => entry.roles?.length)) nextMissingWaitOwner = true;
        let ancestor = previousByPid.get(process.ppid);
        const seen = new Set([key]);
        let foundWaitOwner = false;
        while (ancestor && !seen.has(identity(ancestor))) {
          const ancestorKey = identity(ancestor);
          seen.add(ancestorKey);
          if (current.has(ancestorKey)) {
            const debt = nextDebt.get(ancestorKey) ?? { ticks: 0, processes: [] };
            // Terminal-only discoveries have no charged baseline, but their
            // observed CPU must still arrive at a wait owner before qualifying.
            debt.observedTicks = (debt.observedTicks ?? debt.ticks) +
              (process.observedCpuTicks ?? process.cpuTicks + process.childCpuTicks);
            debt.ticks += process.cpuTicks + process.childCpuTicks;
            debt.processes.push(process);
            nextDebt.set(ancestorKey, debt);
            if (process.cpuHistoryComplete === false) inheritedIncompleteHistory.add(ancestorKey);
            foundWaitOwner = true;
            break;
          }
          ancestor = previousByPid.get(ancestor.ppid);
        }
        if (!foundWaitOwner && process.roles?.length) nextMissingWaitOwner = true;
      }
      const measured = [];
      for (const process of processes) {
        const key = identity(process);
        const before = previous.get(key);
        let ownCpuPercent = null;
        let reapedCpuPercent = null;
        let ownCpuPercentLower = null;
        let ownCpuPercentUpper = null;
        let reapedCpuPercentUpper = null;
        let reapedCpuPercentLower = 0;
        let reapedLowerBoundRoles = [];
        let reapedRoles = [];
        let reapedProcesses = [];
        let cpuIntervalComplete = true;
        if (intervalTicks !== null) {
          const newlyObservedExistingOwner = !before && process.startTicks < Math.floor(previousClock.ticks) - 1;
          const bornDuringSampling = !before && process.startTicks >= Math.floor(initialClock.ticks) - 1;
          const lateSessionProcess = newlyObservedExistingOwner && bornDuringSampling;
          cpuIntervalComplete = !newlyObservedExistingOwner;
          if (newlyObservedExistingOwner && process.roles.length && !bornDuringSampling) {
            throw new Error(`Missing CPU baseline for process ${process.pid}`);
          }
          // A new product process can introduce an existing external wait owner.
          // Its historical host work is not product CPU; establish its baseline
          // before the child can be reaped in a later parent-first census.
          const baseline = before ?? (newlyObservedExistingOwner && !lateSessionProcess ? process : null);
          const ownTicks = process.cpuTicks - (baseline?.cpuTicks ?? 0);
          const waitedTicks = process.childCpuTicks - (baseline?.childCpuTicks ?? 0);
          if (ownTicks < 0 || waitedTicks < 0) throw new Error(`Regressed CPU counters for process ${process.pid}`);
          const debt = nextDebt.get(key) ?? { ticks: 0, processes: [] };
          const newlyReapedTicks = Math.max(0, waitedTicks - debt.ticks);
          // The dedicated command wait owner reaps only product descendants.
          // Other owners may reap unrelated work, and specific product roles
          // remain ambiguous. Bound both the wait delta and subtracted debt.
          if (process.pid === accountingRootPid && cpuIntervalComplete && process.roles.includes("command-tree")) {
            reapedCpuPercentLower = Math.max(0, newlyReapedTicks - 2 - 4 * debt.processes.length) / outerIntervalTicks * 100;
            reapedLowerBoundRoles = ["command-tree"];
          }
          reapedRoles = [...new Set([...(process.roles ?? []), ...debt.processes.flatMap((entry) => entry.roles ?? [])])];
          reapedProcesses = debt.processes.filter((entry) => entry.roles?.length).map(({ pid, startTicks, roles, command }) => ({ pid, startTicks, roles, command }));
          if ((debt.observedTicks ?? debt.ticks) > waitedTicks) nextDebt.set(key, { ...debt,
            ticks: Math.max(0, debt.ticks - waitedTicks),
            observedTicks: (debt.observedTicks ?? debt.ticks) - waitedTicks });
          else nextDebt.delete(key);
          // The accounting wrapper is harness work. Its waited-child counters
          // still contain product work, including children missed by polling.
          ownCpuPercent = (process.pid === accountingRootPid ? 0 : ownTicks) / intervalTicks * 100;
          reapedCpuPercent = newlyReapedTicks / intervalTicks * 100;
          // /proc independently floors utime/stime to USER_HZ ticks. A delta
          // can differ by two ticks; scan endpoints also bound its duration.
          // Reaped debt is a floored lifetime, so subtracting it remains an upper bound.
          const ownUpperTicks = process.pid === accountingRootPid ? 0 : ownTicks + 2;
          const ownLowerTicks = process.pid === accountingRootPid || !cpuIntervalComplete ? 0 :
            Math.max(0, ownTicks - (before ? 2 : 0));
          ownCpuPercentLower = ownLowerTicks / outerIntervalTicks * 100;
          ownCpuPercentUpper = ownUpperTicks / intervalTicks * 100;
          reapedCpuPercentUpper = (newlyReapedTicks + 2) / intervalTicks * 100;
        }
        const cpuHistoryComplete = before?.cpuHistoryComplete !== false &&
          !inheritedIncompleteHistory.has(key) && cpuIntervalComplete;
        current.set(key, { ...process, cpuHistoryComplete });
        if (!cpuHistoryComplete && process.roles.length) nextMissingIntervalBaseline = true;
        measured.push({ ...process, ownCpuPercent, reapedCpuPercent, ownCpuPercentLower, ownCpuPercentUpper, reapedCpuPercentUpper, reapedCpuPercentLower, reapedLowerBoundRoles, reapedRoles, reapedProcesses, cpuIntervalComplete, cpuHistoryComplete,
          cpuPercent: ownCpuPercentUpper === null ? null :
            (process.roles.length ? ownCpuPercentUpper : 0) + (reapedRoles.length ? reapedCpuPercentUpper : 0) });
      }
      for (const key of nextDebt.keys()) if (!current.has(key)) nextDebt.delete(key);
      reapDebt = nextDebt;
      missingWaitOwner = nextMissingWaitOwner;
      missingIntervalBaseline = nextMissingIntervalBaseline;
      previous = current;
      previousClock = clock;
      return measured;
    }
  };
}
