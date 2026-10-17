import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const revision = "7e80556f503d26ddde64e274bfb50cbbec7830f5";
const aliases = {
  connect: "ConnectParamsSchema",
  "sessions.subscribe": "SessionsListParamsSchema",
  "sessions.github.options": "SessionGitHubOptionsParamsSchema",
  "sessions.github.status": "SessionGitHubStatusParamsSchema",
  "session.members.add": "SessionMemberAddParamsSchema",
  "session.members.remove": "SessionMemberRemoveParamsSchema",
  "session.members.listEvidence": "SessionMembersListParamsSchema",
  "sessions.storage.status": "SessionsStorageParamsSchema",
  "sessions.storage.run": "SessionsStorageParamsSchema"
};

export async function loadGatewaySchemaAssertions() {
  const checkout = process.env.KOVA_OPENCLAW_CHECKOUT;
  let unavailable = checkout ? undefined : "Set KOVA_OPENCLAW_CHECKOUT to validate resolved Gateway fixtures against pinned OpenClaw schemas";
  if (checkout) {
    try { await access(checkout); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      unavailable = "Pinned OpenClaw checkout is absent; resolved Gateway schema coverage was not run";
    }
  }
  let schemas, Compile;
  if (!unavailable) {
    assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), revision);
    const packagePath = join(resolve(checkout), "package.json");
    const { createJiti } = createRequire(packagePath)("jiti");
    const jiti = createJiti(packagePath, {
      fsCache: false,
      alias: { "@openclaw/normalization-core": join(resolve(checkout), "packages/normalization-core/src") }
    });
    schemas = await jiti.import(join(resolve(checkout), "packages/gateway-protocol/src/schema-modules.ts"));
    ({ Compile } = await jiti.import("typebox/schema"));
  }
  const validators = new Map(), methods = new Set();
  let checked = 0, handlerChecked = 0;
  let fixtureFailure;
  return {
    check(method, params) {
      if (unavailable) return params;
      try {
        // These handlers have no ParamsSchema. Restrict their fixtures to the
        // accepted request forms inspected in health.ts, attach.ts and sessions-read-by-key.ts.
        if (method === "health") {
          assert.deepEqual(params, {}, "health fixture uses the empty request");
          handlerChecked++;
        } else if (method === "sessions.get") {
          assert.ok(typeof (params.key ?? params.sessionKey) === "string" && (params.key ?? params.sessionKey).trim());
          assert.ok(params.limit === undefined || Number.isInteger(params.limit) && params.limit > 0);
          assert.ok(params.agentId === undefined || typeof params.agentId === "string" && params.agentId.trim());
          assert.ok(Object.keys(params).every((key) => ["key", "sessionKey", "agentId", "limit"].includes(key)));
          handlerChecked++;
        } else if (method === "attach.grant") {
          assert.ok(params.sessionKey === undefined || typeof params.sessionKey === "string" && params.sessionKey.trim());
          assert.ok(params.agentId === undefined || typeof params.agentId === "string" && params.agentId.trim());
          assert.ok(params.ttlMs === undefined || Number.isFinite(params.ttlMs) && params.ttlMs > 0);
          assert.ok(Object.keys(params).every((key) => ["sessionKey", "agentId", "ttlMs"].includes(key)));
          handlerChecked++;
        } else if (["kova.channelProbe.inject", "kova.channelProbe.normalizeCommand"].includes(method)) {
          // Plugin parameters have no core ParamsSchema. Validate the pinned
          // request envelope; channel-probe-routing.mjs exercises their owner.
          const validator = Compile(schemas.RequestFrameSchema);
          assert.ok(validator.Check({ type: "req", id: "fixture", method, params }));
          handlerChecked++;
        } else {
          const name = aliases[method] ?? `${method.split(".").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}ParamsSchema`;
          assert.ok(schemas[name], `${method}: missing pinned ${name}`);
          if (!validators.has(name)) validators.set(name, Compile(schemas[name]));
          const validator = validators.get(name);
          assert.ok(validator.Check(params), `${method}: ${JSON.stringify(validator.Errors(params))}`);
          checked++;
        }
        methods.add(method);
        return params;
      } catch (error) {
        // Expected-refusal assertions must not consume a fixture schema error.
        fixtureFailure ??= error;
        throw error;
      }
    },
    report(t) {
      if (unavailable) return t.skip(unavailable);
      if (fixtureFailure) throw fixtureFailure;
      assert.ok(checked > 0, "resolved Gateway fixtures must reach pinned schema checks");
      t.diagnostic(`${checked} resolved request checks against ${revision}; ${handlerChecked} checks against handlers without ParamsSchema; ${methods.size} methods covered`);
    }
  };
}
