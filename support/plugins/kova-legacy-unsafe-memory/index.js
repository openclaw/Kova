import { Buffer, constants as bufferConstants } from "node:buffer";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "kova-legacy-unsafe-memory",
  name: "Kova Legacy Unsafe Memory",
  description: "Compatibility fixture for legacy plugins that relied on unsafe buffer behavior.",
  register() {
    const results = runLegacyMemoryProbes();
    const tolerated = results.filter((result) => result.outcome === "tolerated");
    const blocked = results.filter((result) => result.outcome === "blocked");
    const summary = results.map((result) => `${result.id}=${result.outcome}:${result.errorName ?? "none"}`).join(";");

    if (tolerated.length > 0) {
      throw new Error(`KOVA_LEGACY_UNSAFE_MEMORY_PLUGIN_TOLERATED ${summary}`);
    }

    throw new Error(`KOVA_LEGACY_UNSAFE_MEMORY_PLUGIN_REJECTED blocked=${blocked.length}/${results.length} ${summary}`);
  }
});

function runLegacyMemoryProbes() {
  return [
    probe("zero-byte-buffer-read", () => Buffer.alloc(0).readUInt8(0)),
    probe("under-allocated-dataview-read", () => new DataView(new ArrayBuffer(1)).getUint32(0)),
    probe("fixed-buffer-over-boundary-write", () => Buffer.alloc(2).writeUInt32LE(0xfeedface, 0)),
    probe("oversized-buffer-request", () => Buffer.allocUnsafe(bufferConstants.MAX_LENGTH + 1))
  ];
}

function probe(id, fn) {
  try {
    fn();
    return { id, outcome: "tolerated" };
  } catch (error) {
    return {
      id,
      outcome: "blocked",
      errorName: error?.name ?? "Error"
    };
  }
}
