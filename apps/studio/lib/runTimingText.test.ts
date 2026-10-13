import test from "node:test";
import assert from "node:assert/strict";
import { fmtMs, timingLine } from "../components/analytics/runTimingText.ts";

test("durations read as ms, seconds, minutes", () => {
  assert.equal(fmtMs(12.4), "12 ms"); assert.equal(fmtMs(1500), "1.5 s"); assert.equal(fmtMs(42000), "42 s"); assert.equal(fmtMs(125000), "2 min 5 s"); assert.equal(fmtMs(-1), "—");
});
test("the line names the total and the slowest analyses, and is null without timings", () => {
  const l = timingLine({ totalMs: 2400, measured: 8, slowest: [{ name: "Age by region", ms: 1800 }, { name: "NPS", ms: 0.4 }] }, 10);
  assert.equal(l, "2.4 s of compute across 8 of 10 analyses; slowest: Age by region 1.8 s");
  assert.equal(timingLine({ totalMs: 0, measured: 0, slowest: [] }, 10), null);
  assert.equal(timingLine(null, 10), null);
});
