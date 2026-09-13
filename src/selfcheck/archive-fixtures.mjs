import { gunzipSync, gzipSync } from "node:zlib";

export function buildTarGzipFixture(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content);
    const header = Buffer.alloc(512);
    if (entry.pseudoTerminator) {
      header.write("000400\0 ", 148, 8, "ascii");
      blocks.push(header);
      continue;
    }
    if (Buffer.byteLength(entry.name) > 100) {
      throw new Error(`tar fixture path is too long: ${entry.name}`);
    }
    header.write(entry.name, 0, 100, "utf8");
    if (entry.rawNameField) {
      header.fill(0, 0, 100);
      entry.rawNameField.copy(header, 0);
    }
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.declaredSize ?? content.length);
    if (entry.rawSizeField) {
      header.fill(0, 124, 136);
      entry.rawSizeField.copy(header, 124);
    }
    writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.linkName) {
      header.write(entry.linkName, 157, 100, "utf8");
    }
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write("kova", 265, 4, "ascii");
    header.write("kova", 297, 4, "ascii");
    if (entry.rawPrefixField) {
      entry.rawPrefixField.copy(header, 345);
    }
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, content);
    const remainder = content.length % 512;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function readUstarEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const sizeText = readTarString(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const contentStart = offset + 512;
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(header[156] || 0x30),
      content: tar.subarray(contentStart, contentStart + size)
    });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(buffer, offset, length) {
  const value = buffer.subarray(offset, offset + length);
  const terminator = value.indexOf(0);
  return value.subarray(0, terminator === -1 ? value.length : terminator).toString("utf8");
}

function writeTarOctal(buffer, offset, length, value) {
  buffer.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii"
  );
}

export function buildPaxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return `${length}${body}`;
}
