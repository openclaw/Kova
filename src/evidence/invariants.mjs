import {
  buildAgentCliLocalTurnEvidenceInvariants,
  buildAgentGatewayRpcTurnEvidenceInvariants
} from "./agent-turns.mjs";
import { buildGatewaySessionEvidenceInvariants } from "./gateway-session.mjs";
import { buildOfficialPluginInstallEvidenceInvariants } from "./official-plugin-install.mjs";
import { buildReleaseRuntimeStartupEvidenceInvariants } from "./release-runtime-startup.mjs";
import {
  buildUpgradeLogDerivedInvariants,
  buildUpgradeStateSnapshotInvariants
} from "./upgrade-existing-user.mjs";

export function attachEvidenceInvariants(record, scenario) {
  const invariants = [];
  if (scenario.surface === "upgrade-existing-user") {
    invariants.push(...buildUpgradeStateSnapshotInvariants(record));
    invariants.push(...buildUpgradeLogDerivedInvariants(record));
  }
  if (scenario.surface === "gateway-session-send-turn") {
    invariants.push(...buildGatewaySessionEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "agent-cli-local-turn") {
    invariants.push(...buildAgentCliLocalTurnEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "agent-gateway-rpc-turn") {
    invariants.push(...buildAgentGatewayRpcTurnEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "release-runtime-startup") {
    invariants.push(...buildReleaseRuntimeStartupEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "official-plugin-install") {
    invariants.push(...buildOfficialPluginInstallEvidenceInvariants(record, scenario));
  }
  if (invariants.length > 0) {
    record.evidenceInvariants = invariants;
  }
  return record;
}

export { buildReleaseRuntimeStartupEvidenceInvariants } from "./release-runtime-startup.mjs";

export { buildOfficialPluginInstallEvidenceInvariants } from "./official-plugin-install.mjs";

export {
  buildAgentCliLocalTurnEvidenceInvariants,
  buildAgentGatewayRpcTurnEvidenceInvariants
} from "./agent-turns.mjs";

export { buildGatewaySessionEvidenceInvariants } from "./gateway-session.mjs";

export {
  buildUpgradeLogDerivedInvariants,
  buildUpgradeStateSnapshotInvariants
} from "./upgrade-existing-user.mjs";
