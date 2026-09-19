import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_DASHBOARD_TEMPLATES, applyDashboardTemplate, dashboardAsTemplate,
  describeDashboardTemplate, templateKind, unfilledWidgets,
} from "./dashboardTemplates.js";
import type { DashboardDefinition, DashboardWidget } from "./types.js";

const cx = BUILT_IN_DASHBOARD_TEMPLATES.find((t) => t.id === "builtin:cx_overview")!;

const W = (id: string, type: DashboardWidget["type"], analysisId?: string): DashboardWidget =>
  ({ id, type, analysisId, x: 0, y: 0, w: 3, h: 2 });

test("the platform ships dashboard templates, and they are laid out on the canvas", () => {
  assert.ok(BUILT_IN_DASHBOARD_TEMPLATES.length >= 3);
  for (const t of BUILT_IN_DASHBOARD_TEMPLATES) {
    assert.equal(t.kind, "dashboard");
    assert.ok(t.builtIn);
    assert.ok(t.widgets.length >= 5, `${t.name} should be a whole dashboard`);
    // laid out, not piled at the origin — the canvas is the point
    assert.ok(t.widgets.some((w) => w.x > 0), `${t.name} should use more than one column`);
    assert.ok(t.widgets.some((w) => w.y > 0), `${t.name} should use more than one row`);
    for (const w of t.widgets) {
      assert.ok(w.x >= 0 && w.x + w.w <= 12, `${t.name}/${w.id} fits the 12-column grid`);
      assert.ok(w.w >= 1 && w.h >= 1);
      assert.ok(!w.analysisId, `${t.name}/${w.id} must not reference a study — a template is a shape`);
    }
  }
});

test("no built-in template hides one of its own widgets under another", () => {
  for (const t of BUILT_IN_DASHBOARD_TEMPLATES) {
    const ws = t.widgets;
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i], b = ws[j];
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!hit, `${t.name}: ${a.id} overlaps ${b.id}`);
      }
    }
  }
});

test("applying a template to an empty dashboard gives its shape, with fresh ids", () => {
  const def = applyDashboardTemplate(cx);
  assert.equal(def.widgets.length, cx.widgets.length);
  assert.ok(def.hero, "the built-in carries a hero");
  assert.equal(def.bands?.length, 1);
  for (const w of def.widgets) assert.ok(!cx.widgets.some((t) => t.id === w.id), "ids are regenerated");
});

test("applying a template twice gives different ids each time", () => {
  const a = applyDashboardTemplate(cx), b = applyDashboardTemplate(cx);
  const shared = a.widgets.filter((w) => b.widgets.some((x) => x.id === w.id));
  assert.equal(shared.length, 0, "two dashboards from one template must not share widget ids");
});

test("a widget that already has an analysis is never thrown away", () => {
  const existing: Partial<DashboardDefinition> = {
    title: "My CX dashboard",
    widgets: [W("old1", "kpi", "a1"), W("old2", "chart", "a2"), W("old3", "table", "a3")],
  };
  const def = applyDashboardTemplate(cx, existing);
  const carried = def.widgets.map((w) => w.analysisId).filter(Boolean);
  assert.ok(carried.includes("a1"), "the KPI survived");
  assert.ok(carried.includes("a2"), "the chart survived");
  assert.ok(carried.includes("a3"), "the table survived");
});

test("carried work takes the template's position and title, keeping its own analysis", () => {
  const existing: Partial<DashboardDefinition> = { widgets: [W("old1", "kpi", "a1")] };
  const def = applyDashboardTemplate(cx, existing);
  const filled = def.widgets.find((w) => w.analysisId === "a1")!;
  const slot = cx.widgets.find((t) => t.type === "kpi")!;
  assert.deepEqual([filled.x, filled.y, filled.w, filled.h], [slot.x, slot.y, slot.w, slot.h], "it moves into the template's slot");
  assert.equal(filled.title, slot.title, "and takes the house title");
  assert.equal(filled.analysisId, "a1", "but keeps its own analysis");
});

test("work the template has no room for is appended, not dropped", () => {
  // five KPIs into a template with three KPI slots
  const many = [1, 2, 3, 4, 5].map((i) => W(`old${i}`, "kpi", `a${i}`));
  const def = applyDashboardTemplate(cx, { widgets: many });
  const carried = def.widgets.map((w) => w.analysisId).filter(Boolean);
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) assert.ok(carried.includes(id), `${id} should still be on the dashboard`);
});

test("applying a template never leaves two widgets on the same cell", () => {
  const many = [1, 2, 3, 4, 5, 6].map((i) => W(`old${i}`, "kpi", `a${i}`));
  const def = applyDashboardTemplate(cx, { widgets: many });
  for (let i = 0; i < def.widgets.length; i++) {
    for (let j = i + 1; j < def.widgets.length; j++) {
      const a = def.widgets[i], b = def.widgets[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!hit, `${a.id} overlaps ${b.id} after the overflow was appended`);
    }
  }
});

test("the author's own hero photograph outlives the template", () => {
  const existing: Partial<DashboardDefinition> = {
    widgets: [],
    hero: { imageUrl: "hotel.jpg", title: "My own title" },
  };
  const def = applyDashboardTemplate(cx, existing);
  assert.equal(def.hero?.imageUrl, "hotel.jpg", "the uploaded photograph is the author's, not the template's to discard");
  assert.equal(def.hero?.title, cx.hero!.title, "the wording comes from the template");
});

test("a dashboard's own title survives being re-templated", () => {
  const def = applyDashboardTemplate(cx, { title: "Acme CX", widgets: [] });
  assert.equal(def.title, "Acme CX");
  assert.equal(applyDashboardTemplate(cx).title, cx.name, "a new one is named after the template");
});

test("saving a dashboard as a template strips every reference to the study", () => {
  const def: Partial<DashboardDefinition> = {
    title: "Acme CX",
    widgets: [W("w1", "kpi", "a1"), W("w2", "chart", "a2")],
    hero: { title: "Acme", imageUrl: "x.jpg" },
    bands: [{ id: "b1", fromRow: 0, toRow: 2, imageUrl: "y.jpg" }],
  };
  const t = dashboardAsTemplate("Acme house style", def);
  assert.equal(t.kind, "dashboard");
  assert.equal(t.widgets.length, 2);
  for (const w of t.widgets) assert.equal(w.analysisId, undefined, "a template is a shape, not a study");
  assert.equal(t.hero?.title, "Acme", "the branding is part of the shape");
  assert.equal(t.bands?.length, 1);
});

test("a stored template with no kind is a report, so the old gallery still works", () => {
  assert.equal(templateKind({}), "report");
  assert.equal(templateKind({ kind: "report" }), "report");
  assert.equal(templateKind({ kind: "dashboard" }), "dashboard");
});

test("a dashboard knows which of its widgets are still waiting for an analysis", () => {
  const def = applyDashboardTemplate(cx);
  const unfilled = unfilledWidgets(def.widgets);
  assert.ok(unfilled.length > 0, "a freshly applied template is unfinished by definition");
  // a photo or a steps panel needs no analysis, so it is not "unfilled"
  assert.ok(!unfilled.some((w) => w.type === "photo" || w.type === "steps" || w.type === "text"));
  assert.equal(unfilledWidgets([W("x", "kpi", "a1")]).length, 0);
});

test("a template describes itself in one line", () => {
  const d = describeDashboardTemplate(cx);
  assert.match(d, /^9 widgets — /);
  assert.match(d, /kpis/);
  assert.match(d, /hero banner/);
  assert.match(d, /1 band/);
});
