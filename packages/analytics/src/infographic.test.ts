import { test } from "node:test";
import assert from "node:assert/strict";
import { infographicDashboard, inTen, pictogramSvg, iconFor } from "./infographic.js";
import type { Finding } from "./findings.js";

/* IM9 — an infographic from the findings that hold */
const f = (id: string, headline: string, significant: boolean, strength: Finding["strength"] = "moderate"): Finding => ({ id, kind: "difference" as never, strength, significant, headline, evidence: {} as never, variables: ["SAT"], hypotheses: [], analysis: { name: id, kind: "crosstab", hash: id, id: `an-${id}` } });

test("only findings that hold; a share becomes a pictogram, anything else a KPI tile", () => {
  const r = infographicDashboard([f("a", "72% of doctors prefer telemedicine for follow-ups", true), f("b", "Satisfaction differs by region (p = .01)", true), f("c", "No difference by age", false, "none")], { title: "Telemedicine — at a glance" });
  assert.equal(r.used, 2); assert.equal(r.skipped, 1);
  const types = r.dashboard.widgets.map((w) => w.type);
  assert.deepEqual(types, ["text", "icon_panel", "kpi"]);
  assert.match(r.dashboard.widgets[1].title!, /^7 in 10 — /);
  assert.equal(r.dashboard.widgets[1].icon, "person");
  assert.ok(r.dashboard.widgets.slice(1).every((w) => w.analysisId?.startsWith("an-")));
});

test("n in 10, honestly at the ends; the pictogram is accessible SVG", () => {
  assert.equal(inTen(3), "fewer than 1 in 10"); assert.equal(inTen(97), "nearly all"); assert.equal(inTen(68), "7 in 10");
  const svg = pictogramSvg(68, { label: "doctors use telemedicine" });
  assert.match(svg, /^<svg /); assert.match(svg, /aria-label="7 in 10 doctors use telemedicine"/);
  assert.equal((svg.match(/fill="#2563eb"/g) ?? []).length, 7);
  assert.equal(iconFor("brand awareness"), "building");
});
