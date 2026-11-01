import { constants, createReadStream } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as extractTar } from "tar-stream";

const pointerPart = (value) => String(value).replaceAll("~", "~0").replaceAll("/", "~1");

export function createdIds(output, pointers) {
  const result = [];
  const visit = (value, parts, offset, pointer) => {
    if (offset === parts.length) {
      if (typeof value === "string" && value) result.push({ pointer, value });
      return;
    }
    const key = parts[offset];
    if (key === "*") {
      if (Array.isArray(value)) for (const [index, child] of value.entries()) visit(child, parts, offset + 1, `${pointer}/${index}`);
    } else if (value !== null && typeof value === "object" && Object.hasOwn(value, key)) {
      visit(value[key], parts, offset + 1, `${pointer}/${pointerPart(key)}`);
    }
  };
  for (const pointer of pointers) {
    if (typeof pointer !== "string" || pointer !== "" && !/^\/(?:[^~]|~[01])*$/.test(pointer)) throw new Error("invalid created-id JSON pointer");
    visit(output, pointer === "" ? [] : pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")), 0, "");
  }
  return result;
}

function membership(candidates) {
  const found = new Set();
  const ids = new Set(candidates);
  if ([...ids].some((id) => typeof id !== "string" || !id)) throw new Error("persona ID candidates must be nonempty strings");
  const complete = () => found.size === ids.size;
  const matcher = (encode) => {
    const root = { children: new Map(), ids: [] }, words = new Set();
    for (const id of ids) {
      const word = encode(id);
      if (word === null) continue;
      words.add(word);
      let node = root;
      for (let index = 0; index < word.length; index++) {
        const character = word[index];
        if (!node.children.has(character)) node.children.set(character, { children: new Map(), ids: [] });
        node = node.children.get(character);
      }
      node.ids.push(id);
    }
    const ordered = [...words].sort((a, b) => b.length - a.length);
    const alternatives = ordered.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const pattern = ordered.length ? new RegExp(`(?=(${alternatives}))`, "g") : null;
    return { width: ordered[0]?.length ?? 0, scan(text) {
      if (!pattern || complete()) return;
      pattern.lastIndex = 0;
      let match;
      while (!complete() && (match = pattern.exec(text))) {
        // Lookahead preserves overlaps; walking the match also includes every
        // candidate that is a prefix of the longest matching alternative.
        let node = root;
        for (let index = 0; index < match[1].length; index++) {
          node = node.children.get(match[1][index]);
          for (const id of node.ids) found.add(id);
        }
        pattern.lastIndex = match.index + 1;
      }
    } };
  };
  const text = matcher((id) => id), bytes = matcher((id) => {
    const encoded = Buffer.from(id);
    return encoded.toString("utf8") === id ? encoded.toString("latin1") : null;
  });
  const value = (input) => {
    if (complete()) return;
    if (typeof input === "string") text.scan(input);
    else if (Array.isArray(input)) { for (const child of input) value(child); }
    else if (input !== null && typeof input === "object") {
      for (const [key, child] of Object.entries(input)) { text.scan(key); value(child); }
    }
  };
  return { found, complete, text: text.scan, value, stream() {
    let overlap = "";
    return (chunk) => {
      if (complete()) return;
      const input = overlap + chunk.toString("latin1");
      bytes.scan(input);
      overlap = bytes.width > 1 ? input.slice(-(bytes.width - 1)) : "";
    };
  } };
}

async function safeDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw new Error(`persona recording must be a directory, not a symbolic link: ${path}`);
}

function entryName(header, seen) {
  const name = header.name.replace(/\/$/, "");
  if (name.includes("\\") || name.includes("\0") || name.split("/").some((part) => !part || part === "." || part === "..") || name !== "meta/env.json" && name !== "root" && !name.startsWith("root/")) throw new Error("persona export contains an unsafe entry path");
  if (seen.has(name)) throw new Error("persona export contains a duplicate entry path");
  if (!["file", "directory", "link", "symlink"].includes(header.type) || !Number.isSafeInteger(header.size) || header.size < 0 || header.type !== "file" && header.size !== 0) throw new Error("persona export contains an unsupported entry");
  if (name === "root" && header.type !== "directory") throw new Error("persona export root must be a directory");
  seen.add(name);
  return name;
}

async function scanFile(stream, name, scan, standard, scratch, signal) {
  const raw = scan.stream();
  const extension = /\.(jsonl|json5?)(?:\.(?:bak|reset|deleted|pre-update)(?:\.[^/]+)?)?$/i.exec(name)?.[1].toLowerCase();
  let format = extension === "jsonl" ? "jsonl" : extension ? "auto" : undefined;
  let decided = Boolean(format), decode = decided, prefix = Buffer.alloc(0);
  let directory, file, path;
  const write = async (chunk) => {
    signal?.throwIfAborted();
    if (!file) {
      directory = await mkdtemp(join(scratch, "file-"));
      path = join(directory, "contents");
      file = await open(path, "wx", 0o600);
    }
    await file.writeFile(chunk);
    signal?.throwIfAborted();
  };
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      raw(chunk);
      if (scan.complete()) continue;
      let remaining = chunk;
      if (!decided) {
        const take = Math.min(16 - prefix.length, chunk.length);
        prefix = Buffer.concat([prefix, chunk.subarray(0, take)]);
        remaining = chunk.subarray(take);
        if (prefix.length < 16) continue;
        decided = true;
        const sqlite = prefix.equals(Buffer.from("SQLite format 3\0"));
        const beginning = new TextDecoder().decode(prefix, { stream: true }).trimStart();
        decode = sqlite || !beginning || ["{", "[", "\"", "'", "/"].includes(beginning[0]);
        if (decode && !sqlite) format = "auto";
        if (decode) await write(prefix);
      }
      if (decode) await write(remaining);
    }
    if (!decided && prefix.length && !scan.complete()) {
      const beginning = new TextDecoder().decode(prefix).trimStart();
      if (!beginning || ["{", "[", "\"", "'", "/"].includes(beginning[0])) { format = "auto"; await write(prefix); }
    }
    if (file) { await file.close(); file = null; }
    signal?.throwIfAborted();
    if (path && !scan.complete()) {
      // Keep this import out of checkpoint recording, which also uses createdIds.
      const { stateFile } = await import("./rows.mjs");
      const logical = name.replace(/^root\/\.openclaw\//, "");
      try {
        for await (const decoded of stateFile(path, logical, standard, format)) {
          signal?.throwIfAborted();
          for (const text of decoded.sourceStrings ?? []) scan.text(text);
          if (decoded.kind === "sqlite") {
            scan.text(decoded.table);
            for await (const row of decoded.rows()) for (const [column, cell] of Object.entries(row.values)) {
              scan.text(column);
              // BLOB fingerprints are comparison metadata, not source strings.
              if (typeof cell.raw === "string") { scan.text(cell.raw); scan.value(cell.value); }
              for (const text of cell.sourceStrings ?? []) scan.text(text);
            }
          } else if (decoded.kind === "jsonl") {
            for await (const entry of decoded.records) {
              scan.value(entry.value);
              for (const text of entry.sourceStrings ?? []) scan.text(text);
              if (scan.complete()) break;
            }
          } else if (!["binary", "sqlite-file"].includes(decoded.kind)) scan.value(decoded.value);
          if (scan.complete()) break;
        }
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        throw new Error("cannot decode persona export state; check the source database and compressed-column declarations", { cause: error });
      }
    }
  } finally {
    try { if (file) await file.close(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}

async function scanExport(path, expectedHash, scan, standard, scratch, signal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let pending = Promise.resolve();
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("persona export must be an unaliased regular file");
    const hash = createHash("sha256"), seen = new Set();
    const extractor = extractTar();
    let metadataSeen = false, length = 0, lastEntryEnd = 0, tail = Buffer.alloc(0);
    extractor.on("entry", (header, stream, next) => {
      stream.on("error", () => {});
      pending = (async () => {
        const name = entryName(header, seen);
        lastEntryEnd = header.byteOffset + Math.ceil(header.size / 512) * 512;
        scan.text(header.name);
        if (typeof header.linkname === "string") scan.text(header.linkname);
        if (name === "meta/env.json") {
          if (header.type !== "file" || header.size > 1024 * 1024) throw new Error("invalid persona export metadata");
          const chunks = [], raw = scan.stream();
          for await (const chunk of stream) { chunks.push(chunk); raw(chunk); }
          let metadata;
          try { metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
          catch { throw new Error("persona export metadata is not valid JSON"); }
          if (metadata?.kind !== "ocm-env-archive" || metadata.formatVersion !== 1 || metadata.includeState !== true || typeof metadata.exportedAt !== "string" || !metadata.env) throw new Error("persona export must contain state-inclusive environment metadata");
          scan.value(metadata);
          metadataSeen = true;
        } else if (header.type === "file" && !scan.complete()) {
          await scanFile(stream, name, scan, standard, scratch, signal);
        } else {
          for await (const chunk of stream) { /* Consume every entry so hashes and archive validation remain complete. */ }
        }
      })();
      pending.then(() => next(), (error) => next(error));
    });
    await pipeline(createReadStream(path, { fd: file.fd, autoClose: false }), new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        length += chunk.length;
        tail = chunk.length >= 1024 ? Buffer.from(chunk.subarray(-1024)) : Buffer.concat([tail, chunk]).subarray(-1024);
        callback(null, chunk);
      }
    }), extractor, { signal });
    await pending;
    if (hash.digest("hex") !== expectedHash) throw new Error("persona export SHA256 differs from run.json");
    if (!metadataSeen || !seen.has("root")) throw new Error("persona export is missing metadata or its root directory");
    if (length % 512 || length < lastEntryEnd + 1024 || tail.length !== 1024 || tail.some((byte) => byte !== 0)) throw new Error("persona export is truncated or missing its tar terminator");
    const after = await file.stat();
    if (after.nlink !== 1 || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("persona export changed while reading");
  } finally {
    await pending.catch(() => {});
    await file.close();
  }
}

export async function personaExistingIds(directory, sources, candidates, standard, { signal } = {}) {
  signal?.throwIfAborted();
  directory = resolve(directory);
  if (!Array.isArray(sources) || !sources.length) throw new Error("recorded run has no complete persona exports; record it again");
  const paths = new Set();
  for (const source of sources) {
    if (!source || typeof source.path !== "string" || !/^\.persona\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.ocm-env\.tar$/.test(source.path) || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256) || paths.has(source.path)) throw new Error("invalid or duplicate run.json persona export reference");
    paths.add(source.path);
  }
  await safeDirectory(directory);
  await safeDirectory(join(directory, ".persona"));
  const scan = membership(candidates);
  const scratch = await mkdtemp(join(tmpdir(), "kova-persona-ids-"));
  try {
    for (const source of sources) {
      signal?.throwIfAborted();
      try { await scanExport(join(directory, source.path), source.sha256, scan, standard, scratch, signal); }
      catch (error) { throw new Error(`cannot read complete persona export ${source.path}: ${error.message}`, { cause: error }); }
    }
    signal?.throwIfAborted();
    return scan.found;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
