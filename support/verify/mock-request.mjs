const MAX_MARKER_BYTES = 64 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validHold = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 300000;

export function mockInstructionText(text) {
  if (typeof text !== "string") return "";
  const opening = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\r?$/gm;
  let result = "", offset = 0, match;
  while ((match = opening.exec(text))) {
    result += `${text.slice(offset, match.index)}[external content omitted]`;
    const closing = new RegExp(`^<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${match[1]}">>>\\r?$`, "gm");
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(text);
    if (!end) return result;
    offset = end.index + end[0].length;
    opening.lastIndex = offset;
  }
  return result + text.slice(offset);
}

function markerObject(text, marker) {
  const offset = text.indexOf(`${marker} `);
  if (offset < 0) return null;
  const tail = text.slice(offset + marker.length + 1).trimStart();
  if (!tail.startsWith("{")) throw new Error(`${marker} requires a JSON object`);
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < tail.length && index < MAX_MARKER_BYTES; index++) {
    const char = tail[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 32) throw new Error(`${marker} JSON nesting exceeds 32`);
    } else if ((char === "}" || char === "]") && --depth === 0) {
      const encoded = tail.slice(0, index + 1);
      if (Buffer.byteLength(encoded) > MAX_MARKER_BYTES) throw new Error(`${marker} JSON exceeds 65536 bytes`);
      return { value: JSON.parse(encoded), remainder: tail.slice(index + 1) };
    }
  }
  throw new Error(`${marker} requires complete JSON within 65536 bytes`);
}

export function verificationRequest(text, { includeExternalContent = false } = {}) {
  if (typeof text !== "string") return { hold: null, tool: null };
  if (!includeExternalContent) text = mockInstructionText(text);
  const marker = /KOVA_(?:VERIFY_HOLD|TOOL_CALL) /.exec(text)?.[0].trimEnd();
  const marked = marker ? markerObject(text, marker) : null;
  if (marked && /KOVA_(?:VERIFY_HOLD|TOOL_CALL) /.test(marked.remainder)) throw new Error("one verification marker is allowed per message");
  const hold = marker === "KOVA_VERIFY_HOLD" ? marked.value : null;
  const tool = marker === "KOVA_TOOL_CALL" ? marked.value : null;
  if (hold && (!validHold(hold.holdMs) || typeof hold.progressCards !== "boolean" || Object.keys(hold).some((key) => !["holdMs", "progressCards"].includes(key)))) throw new Error("KOVA_VERIFY_HOLD requires holdMs between 1 and 300000 and boolean progressCards");
  if (tool && (typeof tool.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) || !object(tool.arguments) || Object.keys(tool).some((key) => !["name", "arguments"].includes(key)))) throw new Error("KOVA_TOOL_CALL requires a tool name and arguments object");
  return { hold, tool };
}
