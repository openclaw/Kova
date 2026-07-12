import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MUTABLE_IMAGE_CACHE_CONTROL } from "../src/lib/http.ts";
import {
  chronologicalDeltas,
  headlineMetric,
} from "../src/lib/matrix-core.ts";
import { cardSvg, releaseCard, svgToPng } from "../src/lib/og-card.ts";
import { fmtMs } from "../src/lib/release-format.ts";

test("matrix deltas compare only adjacent chronological releases", () => {
  assert.deepEqual(
    chronologicalDeltas([100, 110, null, 130, 143]),
    [null, 10, null, null, 10],
  );
});

test("headline breach follows its matching scenario status", () => {
  assert.deepEqual(
    headlineMetric({
      headline: [{ metric: "agent.turn.s", scenarioId: "turn", value: 1.2 }],
      scenarios: [{ id: "turn", state: "fail" }],
    }, ["agent.turn.s"]),
    { value: 1.2, breach: true },
  );
});

test("duration rounding carries seconds into the next minute", () => {
  assert.equal(fmtMs(119_499), "1m 59s");
  assert.equal(fmtMs(119_500), "2m 00s");
  assert.equal(fmtMs(119_501), "2m 00s");
  assert.equal(fmtMs(60_499), "1m 00s");
});

test("OG card uppercases raw text before XML escaping", () => {
  const svg = cardSvg({
    eyebrow: `a & <b> "c" 'd'`,
    headline: "test",
    fact: `ready & <set> "now" 'yes'`,
  });
  assert.match(svg, />A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;</);
  assert.match(svg, />READY &amp; &lt;SET&gt; &quot;NOW&quot; &apos;YES&apos;</);
  assert.doesNotMatch(svg, /&AMP;|&LT;|&GT;/);
  assert.ok(svgToPng(svg).byteLength > 0);
});

test("only all-pass releases get a clean OG verdict", () => {
  const cardFor = (states: Array<"pass" | "fail" | "block">) => releaseCard({
    ver: "2026.7.1",
    releaseDate: new Date("2026-07-11"),
    date: "Jul 11, 2026",
    sha: "abc1234",
    passed: states.every((state) => state === "pass"),
    scenarios: states.map((state, index) => ({
      id: `provision-${index}`,
      value: null,
      unit: "ms",
      threshold: 1000,
      state,
      spark: null,
    })),
  });

  const blocked = cardFor(["block"]);
  assert.deepEqual(blocked.hero, {
    label: "verdict",
    value: "blocked",
    tone: "warn",
  });
  assert.deepEqual(cardFor(["pass", "block"]).hero, blocked.hero);
  assert.deepEqual(cardFor(["pass"]).hero, {
    label: "verdict",
    value: "clean",
    tone: "pass",
  });
  assert.deepEqual(cardFor(["fail"]).hero, {
    label: "verdict",
    value: "regressions",
    tone: "fail",
  });
  assert.match(cardSvg(blocked), /fill="#f59e0b"[^>]*>blocked</);
});

test("mutable OG assets require cache revalidation", async () => {
  assert.equal(
    MUTABLE_IMAGE_CACHE_CONTROL,
    "public, max-age=0, must-revalidate",
  );
  const headers = await readFile(
    new URL("../public/_headers", import.meta.url),
    "utf8",
  );
  assert.match(
    headers,
    /\/og\/\*\s+Cache-Control: public, max-age=0, must-revalidate/,
  );
});
