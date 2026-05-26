import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function parseStateId(argv) {
  const index = argv.indexOf("--state");
  if (index === -1 || !argv[index + 1]) {
    throw new Error("--state <id> is required");
  }
  return argv[index + 1];
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const fixtures = {
  "legacy-channel-config-doctor-2026-5-7": {
    title: "Legacy Channel Config Doctor Fixture",
    boundary: "May 2026 channel and plugin-owned channel config repairs",
    detects: [
      "Doctor leaves removed core BlueBubbles config in the core schema",
      "Doctor fails to surface missing external channel plugin repairs",
      "post-repair status/plugins list regresses channel config loading"
    ],
    breakingChangeEvidence: [
      "OpenClaw PR #78612 removed the core BlueBubbles schema",
      "OpenClaw PR #78876 surfaced missing external plugin repairs for channels",
      "OpenClaw commit b7c461af7b fixed stale Feishu channel state"
    ],
    files: {
      ".openclaw/openclaw.json": {
        schemaVersion: "openclaw.config.legacy.channel.v1",
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://127.0.0.1:12345",
            passwordEnv: "KOVA_BLUEBUBBLES_PASSWORD"
          },
          feishu: {
            enabled: true,
            appId: "cli_legacy",
            appSecretEnv: "KOVA_FEISHU_APP_SECRET",
            configWrites: true,
            legacyWebhookPath: "/openclaw/feishu"
          },
          telegram: {
            enabled: true,
            tokenEnv: "KOVA_TELEGRAM_TOKEN",
            reasoningDefault: "concise"
          }
        },
        plugins: {
          externalChannels: ["bluebubbles", "feishu"]
        }
      },
      "config/channel-legacy.json": {
        schemaVersion: "kova.fixture.legacy-channel-config.v1",
        channelConfigBoundary: "pr-78612-pr-78876-feishu-stale-state"
      }
    }
  },
  "legacy-core-config-doctor-2026-4-24": {
    title: "Legacy Core Config Doctor Fixture",
    boundary: "2026.4.24 plugin architecture and doctor config preservation boundary",
    detects: [
      "Doctor drops unrelated user config while repairing stale keys",
      "gateway/runtime keys from older config shapes still affect post-upgrade status",
      "doctor --non-interactive reports repairable validation errors after --fix"
    ],
    breakingChangeEvidence: [
      "OpenClaw PR #78896 fixed preserving user config fields in doctor --fix",
      "OpenClaw PR #79203 fixed duplicate gateway runtime warnings",
      "Kova existing upgrade-from-2026-4-24 coverage marks the plugin-architecture release as an upgrade boundary"
    ],
    files: {
      ".openclaw/openclaw.json": {
        schemaVersion: "openclaw.config.legacy.core.2026-4-24",
        gateway_port: 21120,
        gateway: {
          port: 21120,
          runtime: "node",
          runtimePath: "./dist/gateway.js"
        },
        runtime: {
          default: "pi",
          pi: {
            enabled: true,
            command: "openclaw-pi"
          }
        },
        models: {
          defaultProvider: "openai",
          defaultModel: "gpt-4.1"
        },
        plugins: {
          runtimeDeps: "legacy",
          bundled: true
        },
        userPreservedField: {
          shouldSurviveDoctorFix: true
        }
      },
      "config/kova-source-release.json": {
        schemaVersion: "kova.fixture.source-release.v1",
        release: "2026.4.24",
        surface: "doctor-repair-upgrade",
        risk: "plugin-architecture-config-migration"
      }
    }
  },
  "legacy-plugin-config-doctor-2026-5-22": {
    title: "Legacy Plugin Config Doctor Fixture",
    boundary: "May 2026 bundled plugin loading and install-index repair boundary",
    detects: [
      "Doctor injects bundled plugin directories into plugins.load.paths again",
      "plugin index repair leaves plugins list or gateway startup broken",
      "gateway logs contain plugin load failures after repair"
    ],
    breakingChangeEvidence: [
      "OpenClaw issue #85334 reported doctor --fix injecting bundled plugin paths",
      "OpenClaw PR #85358 prevented bundled plugin load paths from being injected into config",
      "OpenClaw PR #85170 fixed plugin id derivation for -plugin suffixes"
    ],
    files: {
      ".openclaw/openclaw.json": {
        schemaVersion: "openclaw.config.legacy.plugin.2026-5-22",
        plugins: {
          load: {
            paths: [
              "./plugins",
              "./node_modules/@openclaw/plugins",
              "/Applications/OpenClaw.app/Contents/Resources/app/plugins"
            ]
          },
          entries: {
            codexPlugin: {
              enabled: true,
              package: "@openclaw/codex-plugin"
            },
            browser: {
              enabled: true,
              bundledPath: "./plugins/browser"
            }
          }
        }
      },
      "plugins/installs.json": {
        schemaVersion: "openclaw.plugins.installs.legacy.v1",
        plugins: [
          "codex-plugin",
          "browser"
        ]
      },
      "config/plugin-legacy.json": {
        schemaVersion: "kova.fixture.legacy-plugin-config.v1",
        pluginBoundary: "issue-85334-pr-85358-pr-85170"
      }
    }
  },
  "legacy-provider-config-doctor-2026-5-7": {
    title: "Legacy Provider Config Doctor Fixture",
    boundary: "May 2026 provider and model normalization boundary",
    detects: [
      "Doctor rewrites agentRuntime-specific OpenAI Codex model refs incorrectly",
      "provider alias catalog rows disappear after repair",
      "models list cannot resolve configured provider/model aliases"
    ],
    breakingChangeEvidence: [
      "OpenClaw PR #78967 preserved agentRuntime-specific model expressions during doctor normalization",
      "OpenClaw PR #78971 fixed doctor model-ref warnings for openai-codex to openai rewrites",
      "OpenClaw commits 00c87fd756 and 7be4f12d0b fixed provider aliases and release live provider catalog entries"
    ],
    files: {
      ".openclaw/openclaw.json": {
        schemaVersion: "openclaw.config.legacy.provider.2026-5-7",
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth"
            }
          }
        },
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5"
            },
            agentRuntime: {
              id: "codex",
              fallback: "automatic"
            }
          }
        },
        models: {
          providers: {
            "openai-codex": {
              compatibleProvider: "openai",
              responsesApi: true,
              store: false
            }
          },
          aliases: {
            "gpt-5-codex": "openai-codex/gpt-5"
          }
        }
      },
      "config/provider-legacy.json": {
        schemaVersion: "kova.fixture.legacy-provider-config.v1",
        providerBoundary: "pr-78967-pr-78971-provider-alias-catalog"
      }
    }
  },
  "legacy-runtime-pin-doctor-2026-5-8": {
    title: "Legacy Runtime Pin Doctor Fixture",
    boundary: "May 2026 Pi to Codex runtime routing boundary",
    detects: [
      "Doctor leaves stale pi runtime pins that break default agent routing",
      "Codex migration plugin requirements are not surfaced before agent use",
      "post-repair status still points at removed runtime paths"
    ],
    breakingChangeEvidence: [
      "OpenClaw PR #79238 kept OpenAI Codex migrations on automatic runtime routing",
      "OpenClaw PR #85312 clarified Codex migration plugin requirements",
      "OpenClaw commits 1451b33323 and 614179b4f4 preserved shipped pi aliases and removed stale pi runtime paths"
    ],
    files: {
      ".openclaw/openclaw.json": {
        schemaVersion: "openclaw.config.legacy.runtime-pin.2026-5-8",
        agents: {
          defaults: {
            agentRuntime: {
              id: "pi",
              command: "/usr/local/bin/openclaw-pi",
              fallback: "none"
            },
            model: {
              primary: "openai-codex/gpt-5"
            }
          }
        },
        runtimes: {
          pi: {
            enabled: true,
            path: "/usr/local/lib/openclaw/pi-runtime/index.js"
          }
        },
        plugins: {
          entries: {
            codex: {
              enabled: false
            }
          }
        }
      },
      "config/runtime-pin-legacy.json": {
        schemaVersion: "kova.fixture.legacy-runtime-pin.v1",
        runtimeBoundary: "pr-79238-pr-85312-stale-pi-path"
      }
    }
  }
};

const stateId = parseStateId(process.argv);
const fixture = fixtures[stateId];

if (!fixture) {
  const known = Object.keys(fixtures).sort().join(", ");
  throw new Error(`unknown doctor upgrade state '${stateId}'. Known states: ${known}`);
}

const home = process.env.OPENCLAW_HOME;
if (!home) {
  throw new Error("OPENCLAW_HOME is required");
}

for (const [relPath, value] of Object.entries(fixture.files)) {
  await writeJson(join(home, relPath), value);
}

await writeJson(join(home, "config", "kova-doctor-upgrade-evidence.json"), {
  schemaVersion: "kova.fixture.doctor-upgrade-evidence.v1",
  state: stateId,
  title: fixture.title,
  boundary: fixture.boundary,
  detects: fixture.detects,
  breakingChangeEvidence: fixture.breakingChangeEvidence
});
