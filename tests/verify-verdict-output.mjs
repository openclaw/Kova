import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verdictChunks } from "../src/verify/verdict-output.mjs";

test("verdict output preserves pretty JSON values, ordering and omissions", () => {
  const sparse = new Array(4);
  sparse[1] = undefined;
  sparse[3] = { omitted: undefined, kept: null };
  const values = [
    null, true, false, 0, -0, 1.25, NaN, Infinity, -Infinity, "", [], {},
    { omitted: undefined },
    { "10": "ten", "2": "two", last: true, nested: [[], {}, [null, undefined]], sparse },
    { 'escaped"\\\nkey': "\t\r\b\f\u0000\\\"é漢😀\ud800\udc00\ud800x\udc00", missing: undefined },
    { ignored: () => {}, symbol: Symbol("ignored"), array: [undefined, () => {}, Symbol("ignored"), NaN, Infinity, -0] },
  ];
  for (const value of values) {
    const actual = Buffer.concat([...verdictChunks(value)].map((chunk) => Buffer.from(chunk)));
    assert.deepEqual(actual, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  }
});

test("verdict chunks preserve UTF-8 when a surrogate pair crosses the size boundary", () => {
  const values = ["x".repeat(65534) + "😀end", { ["x".repeat(65530) + "😀"]: "é漢" }];
  for (const value of values) {
    const chunks = [...verdictChunks(value)];
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 64 * 1024));
    assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  }
});

test("verdict output streams repeated values in bounded chunks before reaching the end", () => {
  const item = "x".repeat(8192), count = 257;
  const values = Array(count).fill(item);
  let reachedEnd = false;
  Object.defineProperty(values, count - 1, { get() { reachedEnd = true; return item; } });
  const output = verdictChunks(values);
  const first = output.next();
  assert.equal(first.done, false);
  assert.equal(reachedEnd, false);

  const actual = createHash("sha256"), expected = createHash("sha256");
  let chunks = 0, bytes = 0;
  const consume = (chunk) => {
    assert.ok(chunk.length > 0 && chunk.length <= 64 * 1024);
    actual.update(chunk);
    bytes += Buffer.byteLength(chunk);
    chunks++;
  };
  consume(first.value);
  for (const chunk of output) consume(chunk);
  expected.update("[");
  for (let index = 0; index < count; index++) expected.update(`${index ? "," : ""}\n  ${JSON.stringify(item)}`);
  expected.update("\n]\n");
  assert.equal(reachedEnd, true);
  assert.ok(chunks > 1);
  assert.ok(bytes > 2 * 1024 * 1024);
  assert.equal(actual.digest("hex"), expected.digest("hex"));
});
