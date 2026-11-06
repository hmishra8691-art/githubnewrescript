import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMasterDemoSurvey } from "./masterDemo.js";
import { productionTest, startingCounts } from "./productionTest.js";

/* IM3 — a production-like test: live counts, simulated fullness, live gates, nothing written */
const def = buildMasterDemoSurvey("prodtest");

test("starting counts: live, then a simulated fill on top, by quota or cell name", () => {
  const { counts, unknown } = startingCounts(def, { quota_gender: { qg_male: 10 } }, [{ quota: "Gender 50/50", cell: "Female 50%", share: 1 }, { quota: "Male 25-34", share: 0.5 }, { quota: "Nope", share: 1 }]);
  assert.equal(counts.quota_gender.qg_male, 10, "a live count is kept");
  assert.equal(counts.quota_gender.qg_female, 150, "full = 50 % of 300");
  assert.equal(counts.quota_gender_age.qga_m_2534, 23);
  assert.deepEqual(unknown, ["Nope"]);
});

test("a cell full before the test: respondents in it end quota-full, the report says so, nothing else is touched", () => {
  const live = { quota_gender: { qg_female: 3 } };
  const frozen = JSON.stringify(live);
  const r = productionTest(def, { count: 60, liveCounts: live, fill: [{ quota: "Gender 50/50", cell: "Female 50%", share: 1 }], now: Date.parse("2026-11-06T00:00:00Z") });
  assert.equal(r.simulated, true);
  assert.equal(JSON.stringify(live), frozen, "the live counts passed in are never mutated");
  const female = r.quotas.find((c) => c.cellId === "qg_female")!;
  assert.equal(female.filledAt, 0); assert.equal(female.start, 150);
  assert.ok((r.outcomes.quota_full ?? 0) > 0, JSON.stringify(r.outcomes));
  assert.ok(r.lines[0].startsWith("Simulated — nothing was written"));
  assert.ok(r.lines.some((l) => /Female 50% is full before the test starts/.test(l)), r.lines.join("\n"));
  assert.notEqual(r.verdict, "ready");
});

test("the live gates: a closed window, a password with none set, links that do not exist", () => {
  const d = buildMasterDemoSurvey("gates");
  d.deployment.activeUntil = "2026-01-01T00:00:00Z";
  d.deployment.access = { ...d.deployment.access, mode: "unique_links" };
  const r = productionTest(d, { count: 20, links: 0, now: Date.parse("2026-11-06T00:00:00Z") });
  assert.equal(r.verdict, "blocked");
  assert.ok(r.gates.some((g) => g.id === "window" && !g.ok));
  assert.ok(r.gates.some((g) => g.id === "links" && !g.ok));
});

test("an open study with room: the length, the outcomes, and a verdict", () => {
  const r = productionTest(def, { count: 40, now: Date.parse("2026-11-06T00:00:00Z") });
  assert.ok(r.respondents >= 30);
  assert.ok(r.loiMinutes.median > 0);
  assert.ok(["ready", "needs_attention"].includes(r.verdict));
  assert.ok(r.lines.some((l) => /lower bound, not an incidence forecast/.test(l)));
});
