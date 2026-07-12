import { buildDryRunRecord, buildSkippedRecord, executeScenario } from "../runner.mjs";
import { isNonPassingExecutionStatus } from "../statuses.mjs";
import { positiveIntegerValue } from "./options.mjs";

export async function runScenarioRepeats({ scenario, context, repeat, progress, skipReason = null }) {
  const total = positiveIntegerValue(repeat, "repeat");
  const records = [];
  for (let index = 1; index <= total; index += 1) {
    const iterationContext = {
      ...context,
      repeat: {
        index,
        total
      }
    };
    const iteration = iterationContext.repeat;

    if (skipReason) {
      const record = buildSkippedRecord(scenario, iterationContext, skipReason);
      progress?.scenarioEnd?.({
        scenarioId: scenario.id,
        stateId: context.state?.id,
        iteration,
        status: record.status,
        skipReason
      });
      records.push(record);
      continue;
    }

    progress?.scenarioStart?.({
      scenarioId: scenario.id,
      stateId: context.state?.id,
      iteration
    });
    iterationContext.onPhase = (title) => progress?.phase?.({ title });
    const record = iterationContext.execute
      ? await executeScenario(scenario, iterationContext)
      : buildDryRunRecord(scenario, iterationContext);
    progress?.scenarioEnd?.({
      scenarioId: scenario.id,
      stateId: context.state?.id,
      iteration,
      status: record.status,
      skipReason: record.skipReason
    });
    records.push(record);
  }
  return records;
}

export async function runEntries({ entries, runEntry, execute, controls }) {
  if (execute !== true) {
    return (await Promise.all(entries.map((entry) => runEntry(entry)))).flat();
  }
  if ((controls?.parallel ?? 1) <= 1) {
    const records = [];
    for (const entry of entries) {
      const entryRecords = await runEntry(entry);
      records.push(...entryRecords);
      if (controls?.failFast && entryRecords.some((record) => isNonPassingExecutionStatus(record.status))) {
        break;
      }
    }
    return records;
  }

  const records = new Array(entries.length);
  let nextIndex = 0;
  let rejected = false;
  let firstError;
  async function worker() {
    while (!rejected && nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        records[index] = await runEntry(entries[index]);
      } catch (error) {
        if (!rejected) {
          rejected = true;
          firstError = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: controls.parallel }, () => worker()));
  if (rejected) {
    throw firstError;
  }
  return records.filter(Boolean).flat();
}
