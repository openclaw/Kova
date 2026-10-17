const chunkSize = 64 * 1024;

function* fragments(value, indent = "") {
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value) ?? "null";
    return;
  }
  const nestedIndent = `${indent}  `;
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      yield `${index ? "," : ""}\n${nestedIndent}`;
      yield* fragments(value[index], nestedIndent);
    }
    if (value.length) yield `\n${indent}`;
    yield "]";
    return;
  }
  yield "{";
  let populated = false;
  for (const key of Object.keys(value)) {
    const item = value[key];
    const kind = typeof item;
    if (kind === "undefined" || kind === "function" || kind === "symbol") continue;
    yield `${populated ? "," : ""}\n${nestedIndent}`;
    yield JSON.stringify(key);
    yield ": ";
    yield* fragments(item, nestedIndent);
    populated = true;
  }
  if (populated) yield `\n${indent}`;
  yield "}";
}

// Verdicts contain plain objects, arrays and scalar JSON values, with optional
// undefined fields. Keep their existing pretty JSON without one aggregate string.
export function* verdictChunks(value) {
  let buffered = "";
  for (const part of fragments(value)) {
    let offset = 0;
    while (offset < part.length) {
      let end = Math.min(part.length, offset + chunkSize - buffered.length);
      // Each chunk is encoded separately by its sink; keep surrogate pairs intact.
      const last = part.charCodeAt(end - 1);
      if (end < part.length && last >= 0xd800 && last <= 0xdbff) end--;
      buffered += part.slice(offset, end);
      offset = end;
      if (buffered.length === chunkSize || offset < part.length) {
        yield buffered;
        buffered = "";
      }
    }
  }
  yield `${buffered}\n`;
}
