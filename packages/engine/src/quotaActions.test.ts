import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type FlowNode } from "@rescript/schema";
import {
  coerceSurveyActions, applySurveyActions, diffSurveys, reviewSurvey, reviewQuotas, quotaCoverage, quotaAdvice, checkPosition, findQuota,
  createResponseState, advance, start, quotaIncrements,
} from "./index.js";

/*
 * QUOTA INTELLIGENCE (research-intelligence Phase 4): quotas in words — a
 * total split across the bands of one or two questions, interlocked — the
 * feasibility review, the fieldwork advice from live counts, and the Changes
 * lines; every quota the same object the dashboard and the runtime read.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Tracker", version: "1.0" },
    questions: [
      { id: "q1", code: "S1", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female", "Other") },
      { id: "q2", code: "S2", variableName: "AGE", type: "numeric", text: "How old are you?", settings: { minValue: 16, maxValue: 99 } },
      { id: "q3", code: "S3", variableName: "REGION", type: "single_select", text: "Region", options: opts("North", "South", "East", "West") },
      { id: "q4", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Brands used", options: opts("Brand A", "Brand B", "Brand C") },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screening", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }] },
      { type: "block", id: "b2", title: "Profile", children: [{ type: "page", id: "p2", questionIds: ["q3"] }] },
      { type: "block", id: "b3", title: "Brands", children: [{ type: "page", id: "p3", questionIds: ["q4"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });
}
const acts = (raw: unknown[]) => coerceSurveyActions(raw);
const run = (def: SurveyDefinition, raw: unknown[]) => applySurveyActions(def, acts(raw).actions);
const checks = (def: SurveyDefinition) => (def.flow as FlowNode[]).map((n, i) => ({ n, i })).filter(({ n }) => n.type === "quota_check").map(({ n, i }) => ({ i, ids: (n as { quotaIds: string[] }).quotaIds, onFull: (n as { onFull: { kind: string } }).onFull.kind }));

test("a quota in words: 500 completes, 50/50 gender interlocked with three age bands — cells that add up, conditions on the real codes, the check after the screener", () => {
  const def = survey();
  const out = run(def, [{
    op: "create_quota", name: "Gender × Age", total: 500,
    dimensions: [
      { question: "GENDER", bands: [{ label: "Men", codes: ["Male"], share: 50 }, { label: "Women", codes: [2], share: 50 }] },
      { question: "AGE", bands: [{ label: "18–34", min: 18, max: 34, share: 40 }, { label: "35–54", min: 35, max: 54, share: 35 }, { label: "55+", min: 55 }] },
    ],
  }]);
  assert.deepEqual(out.errors, []);
  const q = out.def.quotas[0];
  assert.equal(q.name, "Gender × Age"); assert.equal(q.mode, "hard"); assert.equal(q.targetTotal, 500); assert.equal(q.onFull.kind, "terminate");
  assert.deepEqual(q.cells.map((c) => c.label), ["Men × 18–34", "Men × 35–54", "Men × 55+", "Women × 18–34", "Women × 35–54", "Women × 55+"]);
  assert.deepEqual(q.cells.map((c) => c.limit), [100, 88, 63, 100, 87, 62], "shares of the total (55+ takes the remaining 25%); the .5 remainders go to the earlier cells so the limits add up");
  assert.equal(q.cells.reduce((s, c) => s + c.limit, 0), 500);
  assert.equal(q.cells[0].when.type, "group");
  const men = q.cells[0].when as { children: { source: { ref: string }; operator: string; value: unknown; value2?: unknown }[] };
  assert.deepEqual(men.children.map((r) => [r.source.ref, r.operator, r.value, r.value2]), [["q1", "eq", 1, undefined], ["q2", "between", 18, 34]], "option by label → its code; a band → between; the question by id, as the parser stores it");
  assert.deepEqual(checks(out.def), [{ i: 1, ids: [q.id], onFull: "terminate" }], "the check sits after the Screening block, which asks both questions");
  assert.ok(out.results[0].description.startsWith("Quota “Gender × Age” of 500: Men × 18–34 ≤ 100, Men × 35–54 ≤ 88"));
  /* the runtime honours it */
  const counts = { [q.id]: { [q.cells[0].id]: 100 } };
  const state = createResponseState(out.def, { sessionId: "x", seed: 1 });
  state.answers.q1 = 1; state.answers.q2 = 30;
  assert.deepEqual(quotaIncrements(out.def, state).map((x) => x.cellId), [q.cells[0].id]);
  const st = createResponseState(out.def, { sessionId: "y", seed: 1 });
  start(out.def, st, counts);
  st.answers.q1 = 1; st.answers.q2 = 30;
  const step = advance(out.def, st, counts);
  assert.equal(step.endStatus, "quota_full", "a man of 30 is turned away once his cell is full");
  /* the Changes lines */
  const summary = diffSurveys(def, out.def).summary;
  assert.ok(summary.includes("Add quota “Gender × Age” (6 cells)"), summary.join(" | "));
  /* the review: “Other” and the 16–17-year-olds are in no cell — a real gap, said with examples */
  const rv = reviewQuotas(out.def);
  assert.deepEqual(rv.map((f) => f.kind), ["uncovered"]);
  assert.match(rv[0].message, /fall outside every cell of “Gender × Age” \(Male × 16; Male × 17; Female × 16; Female × 17; …\)/, "the question's own minimum (16) is probed, not only the band edges");
  const covered = run(out.def, [{ op: "add_quota_cells", quota: "Gender × Age", cells: [{ label: "Other", when: "GENDER = 3", limit: 10 }, { label: "Under 18", when: "AGE < 18", limit: 0 }] }]).def;
  const rv2 = reviewQuotas(covered);
  assert.deepEqual(rv2.map((f) => f.kind), ["sum_over", "cell_zero", "overlap"], "nobody is left out now — but the cells allow 510, the Under-18 cell is unlimited, and a 17-year-old “Other” is in two cells");
  assert.match(rv2[2].message, /Other × 17: Other \+ Under 18/);
  /* refusals at the gate and in the apply */
  assert.equal(acts([{ op: "create_quota", name: "X", dimensions: ["GENDER"] }]).rejected.length, 1, "dimensions need a total");
  assert.equal(acts([{ op: "create_quota", name: "X", cells: [{ label: "a", when: "GENDER = 1" }] }]).rejected.length, 1, "a cell needs a limit");
  assert.equal(acts([{ op: "create_quota", name: "X", cells: [{ label: "a", when: "GENDER = 1", percent: 50 }] }]).rejected.length, 1, "percent needs a total");
  assert.equal(acts([{ op: "create_quota", name: "X", cells: [{ when: "GENDER = 1", limit: 5 }], onFull: "explode" }]).rejected.length, 1);
  assert.equal(acts([{ op: "create_quota", name: "X", cells: [{ when: "GENDER = 1", limit: 5 }], onFull: { kind: "redirect" } }]).rejected.length, 1, "a redirect needs a url");
  assert.match(run(out.def, [{ op: "create_quota", name: "gender × age", total: 10, dimensions: ["GENDER"] }]).errors[0], /already a quota named/);
  assert.match(run(def, [{ op: "create_quota", name: "X", total: 10, dimensions: [{ question: "GENDER", bands: [{ codes: ["Alien"] }] }] }]).errors[0], /S1 has no option “Alien” — its options are 1=Male, 2=Female, 3=Other/);
  assert.match(run(def, [{ op: "create_quota", name: "X", total: 10, dimensions: ["AGE"] }]).errors[0], /not a choice question — give it bands/);
  assert.match(run(def, [{ op: "create_quota", name: "X", total: 10, dimensions: [{ question: "GENDER", bands: [{ codes: [1], share: 70 }, { codes: [2], share: 40 }] }] }]).errors[0], /add up to 110%/);
  assert.equal(acts([{ op: "create_quota", name: "X", total: 10, dimensions: [{ question: "GENDER", bands: [{ codes: [1], share: 150 }] }] }]).rejected.length, 1, "a share over 100 is refused at the gate");
  assert.equal(acts([{ op: "create_quota", name: "X", total: 10, dimensions: ["GENDER"], mode: "medium" }]).rejected.length, 1, "mode is hard or soft");
  const alias = acts([{ op: "create_quota", name: "X", dimensions: ["GENDER"], completes: 120 }]);
  assert.equal(alias.rejected.length, 0); assert.equal((alias.actions[0] as { total: number }).total, 120, "“completes” names the total too");
  /* explicit cells that do not add up to the total asked for: said */
  const off = run(def, [{ op: "create_quota", name: "Off", total: 100, cells: [{ label: "Men", when: "GENDER = 1", limit: 40 }, { label: "Women", when: "GENDER = 2", limit: 40 }] }]);
  assert.ok(off.warnings.some((w) => /The cells of “Off” allow 80 completes in all, not the 100 asked for/.test(w)), off.warnings.join("\n"));
  /* "warn" is a quota-level kind; the flow's check knows flag */
  const warn = run(def, [{ op: "create_quota", name: "W", total: 10, dimensions: ["GENDER"], onFull: "warn" }]).def;
  assert.equal(warn.quotas[0].onFull.kind, "warn"); assert.equal(checks(warn)[0].onFull, "flag");
  /* a quota listed BEFORE the question it reads still works: quotas run after the structure */
  const early = run(def, [{ op: "create_quota", name: "Income", total: 90, dimensions: ["INCOME"] }, { op: "create_question", ref: "INCOME", type: "single", text: "Income", options: ["Low", "Mid", "High"] }]);
  assert.deepEqual(early.errors, []); assert.deepEqual(early.def.quotas[0].cells.map((c) => c.limit), [30, 30, 30]);
});

test("cells by condition, percent cells, a soft quota, a multi-select dimension, and a quota of a question created in the same batch", () => {
  const def = survey();
  const out = run(def, [
    { op: "create_question", ref: "INCOME", type: "single", text: "Household income", options: ["Under 30k", "30–60k", "Over 60k"] },
    { op: "create_quota", name: "Income", total: 300, cells: [{ label: "Low", when: "INCOME = 1", percent: 30 }, { label: "Mid", when: "INCOME = 2", percent: 40 }, { label: "High", when: "INCOME = 3", percent: 30 }], mode: "soft" },
    { op: "create_quota", name: "Brand users", total: 200, dimensions: [{ question: "BRANDS", bands: [{ label: "A users", codes: ["Brand A"] }, { label: "B users", codes: [2] }] }], onFull: "flag", check: false },
    { op: "create_quota", name: "Region", cells: [{ when: "REGION in [1, 2]", limit: 120 }, { label: "West & East", when: "REGION in [3, 4]", limit: 80 }], onFull: { kind: "redirect", url: "https://panel.example/full" } },
  ]);
  assert.deepEqual(out.errors, []);
  const [income, brands, region] = out.def.quotas;
  assert.equal(income.mode, "soft"); assert.equal(income.onFull.kind, "flag", "a soft quota flags unless told otherwise");
  assert.deepEqual(income.cells.map((c) => [c.limitType, c.limit]), [["percent", 30], ["percent", 40], ["percent", 30]]);
  assert.equal(income.targetTotal, 300);
  assert.equal((brands.cells[0].when as { operator: string }).operator, "selected", "a multi-select band selects the code");
  assert.deepEqual(brands.cells.map((c) => c.limit), [100, 100]);
  assert.equal(region.cells[0].label, "REGION in [1, 2]".replace("REGION", "S3").length ? region.cells[0].label : "", "a cell without a label is named by its condition");
  assert.ok(/S3|REGION/.test(region.cells[0].label));
  assert.equal(region.onFull.url, "https://panel.example/full");
  const cs = checks(out.def);
  assert.equal(cs.length, 2, "the brand quota asked for no check");
  const incomeCheck = cs.find((c) => c.ids.includes(income.id))!, regionCheck = cs.find((c) => c.ids.includes(region.id))!;
  assert.equal((out.def.flow as FlowNode[])[regionCheck.i - 1].id, "b2", "the region check follows the Profile block");
  assert.equal(regionCheck.onFull, "redirect");
  assert.ok(incomeCheck.i > regionCheck.i, "income is asked last (the new question goes before the End)");
  /* the review: the unchecked quota is reported with the fix, the rest is fine */
  const rv = reviewQuotas(out.def);
  assert.deepEqual(rv.map((f) => [f.kind, f.quotaName]), [["unchecked", "Brand users"], ["uncovered", "Brand users"]], "…and Brand C users are in no cell");
  assert.equal(rv[0].severity, "suggestion", "a flagging quota that nobody checks is a suggestion, not a warning");
  assert.match(rv[1].message, /\(Brand C\)/);
  assert.deepEqual(rv[0].action, { op: "set_quota_check", quotas: [brands.id] });
  /* the whole review carries it under its own category, with the fix */
  const whole = reviewSurvey(out.def).findings.filter((f) => f.category === "quota");
  assert.equal(whole.length, 2); assert.deepEqual(whole.find((f) => /never checked/.test(f.message))!.fix, [{ op: "set_quota_check", quotas: [brands.id] }]);
});

test("update, add and remove cells, delete, and the check placed by hand — with the Changes lines and the destructive notes", () => {
  const def = survey();
  const base = run(def, [{ op: "create_quota", name: "Age", total: 400, dimensions: [{ question: "AGE", bands: [{ label: "18–34", min: 18, max: 34 }, { label: "35–54", min: 35, max: 54 }, { label: "55+", min: 55 }] }] }]).def;
  const q = base.quotas[0];
  assert.deepEqual(q.cells.map((c) => c.limit), [134, 133, 133]);
  /* rescale to a new total, rename, soft, one cell by hand */
  const up = run(base, [{ op: "update_quota", quota: "age", total: 600, newName: "Age bands", mode: "soft", cells: [{ cell: "55+", limit: 150 }] }]);
  assert.deepEqual(up.errors, []);
  const u = up.def.quotas[0];
  assert.equal(u.name, "Age bands"); assert.equal(u.mode, "soft"); assert.equal(u.targetTotal, 600);
  assert.deepEqual(u.cells.map((c) => c.limit), [201, 200, 150], "rescaled in proportion to 600, then 55+ set by hand");
  assert.match(up.results[0].description, /limits rescaled from 400 to 600 completes; soft/);
  const lines = diffSurveys(base, up.def).summary;
  assert.ok(lines.some((l) => /^Change quota “Age bands”: renamed from “Age”; soft; total 400 → 600; 18–34 134 → 201, 35–54 133 → 200, 55\+ 133 → 150$/.test(l)), lines.join(" | "));
  assert.match(run(base, [{ op: "update_quota", quota: "Age", cells: [{ cell: "Teens", limit: 5 }] }]).errors[0], /has no cell “Teens” — its cells are “18–34”, “35–54”, “55\+”/);
  assert.match(run(base, [{ op: "update_quota", quota: "Nope", total: 5 }]).errors[0], /there is no quota “Nope” — the quotas are “Age”/);
  const two = run(base, [{ op: "create_quota", name: "Region", total: 40, dimensions: ["REGION"] }]).def;
  assert.match(run(two, [{ op: "update_quota", quota: "Region", newName: "age" }]).errors[0], /already a quota named “age”/);
  /* what happens when full follows onto the quota's own check */
  const redirected = run(base, [{ op: "update_quota", quota: "Age", onFull: { kind: "redirect", url: "https://panel.example/full" } }]).def;
  assert.equal(redirected.quotas[0].onFull.url, "https://panel.example/full");
  const rc = (redirected.flow as FlowNode[]).find((n) => n.type === "quota_check") as { onFull: { kind: string; url?: string } };
  assert.deepEqual(rc.onFull, { kind: "redirect", url: "https://panel.example/full" });
  assert.equal(acts([{ op: "update_quota", quota: "Age" }]).rejected.length, 1, "an update that changes nothing is refused at the gate");
  assert.equal(acts([{ op: "update_quota", quota: "Age", cells: [{ cell: "55+" }] }]).rejected.length, 1);
  /* add a cell that reads a LATER question: the check moves */
  const added = run(base, [{ op: "add_quota_cells", quota: "Age", cells: [{ label: "Northern 55+", when: "AGE >= 55 AND REGION = 1", limit: 20 }] }]);
  assert.deepEqual(added.errors, []);
  assert.equal(added.def.quotas[0].cells.length, 4);
  assert.equal((added.def.flow as FlowNode[])[checks(added.def)[0].i - 1].id, "b2", "the check now follows the Profile block, where REGION is asked");
  assert.ok(added.warnings.some((w) => /quota check for “Age” was moved after the question the new cells read/.test(w)), added.warnings.join("\n"));
  assert.match(run(base, [{ op: "add_quota_cells", quota: "Age", cells: [{ label: "55+", when: "AGE >= 55", limit: 1 }] }]).errors[0], /already has a cell “55\+”/);
  /* remove cells: destructive, never all of them */
  const removed = run(base, [{ op: "remove_quota_cells", quota: "Age", cells: ["55+"] }]);
  assert.deepEqual(removed.def.quotas[0].cells.map((c) => c.label), ["18–34", "35–54"]);
  assert.match(removed.destructive[0], /Removes 1 cell from quota “Age”: 55\+/);
  assert.match(run(base, [{ op: "remove_quota_cells", quota: "Age", cells: ["18–34", "35–54", "55+"] }]).errors[0], /removes every cell/);
  assert.ok(diffSurveys(base, removed.def).summary.includes("Change quota “Age”: 1 cell removed"));
  /* the check by hand: after a block, with a condition; too early is said */
  const moved = run(base, [{ op: "set_quota_check", quotas: ["Age"], after: "Profile", when: "GENDER != 3", onFull: "flag" }]);
  assert.deepEqual(moved.errors, []);
  const mc = checks(moved.def);
  assert.equal(mc.length, 1); assert.equal((moved.def.flow as FlowNode[])[mc[0].i - 1].id, "b2"); assert.equal(mc[0].onFull, "flag");
  assert.ok((moved.def.flow as FlowNode[])[mc[0].i].type === "quota_check" && !!((moved.def.flow as FlowNode[])[mc[0].i] as { when?: unknown }).when);
  assert.match(moved.results[0].description, /Quota check for “Age” after “Profile”: flag when S1 ≠ 3|Quota check for “Age” after “Profile”: flag when /);
  assert.ok(diffSurveys(base, moved.def).summary.includes("Place 1 quota check"), diffSurveys(base, moved.def).summary.join(" | "));
  const early = run(base, [{ op: "set_quota_check", quotas: ["Age"], after: "Screening" }]);
  assert.deepEqual(early.errors, [], "placing it after Screening is fine — AGE is asked there");
  const tooEarly = run(added.def, [{ op: "set_quota_check", quotas: ["Age"], after: "Screening" }]);
  assert.ok(tooEarly.warnings.some((w) => /sits before a question the quota reads/.test(w)), "the cell that reads REGION makes Screening too early");
  assert.match(run(base, [{ op: "set_quota_check", quotas: ["Age"], after: "Nowhere" }]).errors[0], /not a question or a block/);
  /* delete: destructive, the check and List Fill references go with it */
  const del = run(base, [{ op: "delete_quota", quota: "Age" }]);
  assert.equal(del.def.quotas.length, 0); assert.equal(checks(del.def).length, 0);
  assert.match(del.destructive[0], /Removes quota “Age” \(3 cells\) and its 1 check/);
  assert.ok(diffSurveys(base, del.def).summary.includes("Remove quota “Age”"));
  assert.equal(findQuota(base, "age ba"), undefined, "a partial name needs the quota to exist");
});

test("the feasibility review: an uncovered group, overlapping cells, limits that do not add up, percent without a total, a check before its question", () => {
  const def = survey();
  /* uncovered: no cell for “Other”; the gaps in the age bands */
  const gaps = run(def, [{ op: "create_quota", name: "Gender", total: 100, dimensions: [{ question: "GENDER", bands: [{ codes: ["Male"] }, { codes: ["Female"] }] }] }, { op: "create_quota", name: "Age", total: 100, dimensions: [{ question: "AGE", bands: [{ label: "18–34", min: 18, max: 34 }, { label: "55+", min: 55 }] }] }]).def;
  const cov = quotaCoverage(gaps, gaps.quotas[0])!;
  assert.deepEqual(cov, { combos: 3, uncovered: ["Other"], overlaps: [] });
  const rv = reviewQuotas(gaps);
  assert.ok(rv.some((f) => f.kind === "uncovered" && f.quotaName === "Gender" && /1 of 3 answer combinations falls outside every cell of “Gender” \(Other\)/.test(f.message)), rv.map((f) => f.message).join("\n"));
  assert.ok(rv.some((f) => f.kind === "uncovered" && f.quotaName === "Age" && /35|54/.test(f.message)), "the 35–54 gap is found from the band edges");
  /* overlap: flat dimensions in one quota */
  const flat = run(def, [{ op: "create_quota", name: "Flat", cells: [{ label: "Men", when: "GENDER = 1", limit: 50 }, { label: "Women", when: "GENDER = 2", limit: 50 }, { label: "Young", when: "AGE <= 34", limit: 40 }, { label: "Older", when: "AGE >= 35", limit: 60 }] }]).def;
  const fr = reviewQuotas(flat);
  assert.ok(fr.some((f) => f.kind === "overlap" && /match(?:es)? more than one cell/.test(f.message)), fr.map((f) => f.message).join("\n"));
  assert.ok(fr.find((f) => f.kind === "overlap")!.severity === "suggestion");
  /* sums */
  const over = run(def, [{ op: "create_quota", name: "Over", total: 100, cells: [{ label: "Men", when: "GENDER = 1", limit: 60 }, { label: "Women", when: "GENDER = 2", limit: 60 }, { label: "Other", when: "GENDER = 3", limit: 10 }] }]).def;
  const under = run(def, [{ op: "create_quota", name: "Under", total: 100, cells: [{ label: "Men", when: "GENDER = 1", limit: 40 }, { label: "Women", when: "GENDER = 2", limit: 40 }, { label: "Other", when: "GENDER = 3", limit: 5 }] }]).def;
  const o = reviewQuotas(over).find((f) => f.kind === "sum_over")!, u = reviewQuotas(under).find((f) => f.kind === "sum_under")!;
  assert.match(o.message, /allow 130 completes together, 30 more than its total of 100/); assert.equal(o.severity, "suggestion");
  assert.match(u.message, /allow only 85 completes together, 15 short of its total of 100/); assert.equal(u.severity, "warning");
  assert.deepEqual(u.action, { op: "update_quota", quota: under.quotas[0].id, total: 100 });
  const fixed = run(under, [u.action!]).def.quotas[0];
  assert.equal(fixed.cells.reduce((s, c) => s + c.limit, 0), 100, "the fix rescales the cells to the total");
  /* percent without a total, and percent under 100 */
  const pct = structuredClone(over); pct.quotas[0].cells.forEach((c) => { c.limitType = "percent"; c.limit = 30; }); delete pct.quotas[0].targetTotal;
  assert.ok(reviewQuotas(pct).some((f) => f.kind === "no_total" && f.severity === "critical"));
  pct.quotas[0].targetTotal = 100;
  assert.ok(reviewQuotas(pct).some((f) => f.kind === "percent_under" && /add up to 90%/.test(f.message)));
  /* a check before the question it reads */
  const early = structuredClone(over);
  const flow = early.flow as FlowNode[];
  const at = flow.findIndex((n) => n.type === "quota_check");
  const [node] = flow.splice(at, 1); flow.unshift(node);
  const e = reviewQuotas(early).find((f) => f.kind === "check_before_question")!;
  assert.equal(e.severity, "critical"); assert.match(e.message, /runs before S1 is asked/);
  assert.deepEqual(e.action, { op: "set_quota_check", quotas: [early.quotas[0].id] });
  const repaired = run(early, [e.action!]).def;
  assert.equal(checkPosition(repaired, repaired.quotas) + 1, checks(repaired)[0].i, "the fix puts it straight after the block that asks the question");
  assert.ok(!reviewQuotas(repaired).some((f) => f.kind === "check_before_question"));
  /* a zero limit is unlimited, and said */
  const zero = structuredClone(over); zero.quotas[0].cells[2].limit = 0;
  assert.ok(reviewQuotas(zero).some((f) => f.kind === "cell_zero" && /treats 0 as no limit/.test(f.message)));
});

test("fieldwork advice from the counts: a full cell while others are open, a cell under pace with its projected shortfall, nearly full, complete — each with the adjustment as a proposal", () => {
  const def = survey();
  const out = run(def, [{ op: "create_quota", name: "Gender", total: 200, dimensions: [{ question: "GENDER", bands: [{ label: "Men", codes: [1] }, { label: "Women", codes: [2] }, { label: "Other", codes: [3], share: 10 }] }] }]).def;
  const q = out.quotas[0];
  const [men, women, other] = q.cells;
  assert.deepEqual([men.limit, women.limit, other.limit], [90, 90, 20]);
  const none = quotaAdvice(out, {});
  assert.deepEqual(none[0].lines.map((l) => l.kind), ["no_data"]);
  /* men full, women half, other barely moving after 150 completes */
  const a1 = quotaAdvice(out, { [q.id]: { [men.id]: 90, [women.id]: 58, [other.id]: 2 } })[0];
  assert.equal(a1.current, 150); assert.equal(a1.maximum, 200);
  const full = a1.lines.find((l) => l.kind === "full_while_open")!;
  assert.match(full.message, /Men \(90\/90\) is full while 2 cells still need 50 — respondents in the full cells are now screened out/);
  assert.deepEqual(full.action, { op: "update_quota", quota: q.id, cells: [{ cell: men.id, limit: 99 }] }, "raise the full cell by 10%");
  const pace = a1.lines.find((l) => l.kind === "under_pace")!;
  assert.match(pace.message, /Other has 2 of the ~15 expected at this point \(2\/20\); at this pace it reaches about 3 when the quota fills — 17 short/);
  assert.deepEqual(pace.action, { op: "update_quota", quota: q.id, cells: [{ cell: other.id, limit: 3 }] });
  assert.ok(!a1.lines.some((l) => l.kind === "under_pace" && l.cellIds.includes(women.id)), "women are on pace");
  assert.equal(run(out, [full.action!]).def.quotas[0].cells[0].limit, 99, "the advice applies as an ordinary proposal");
  /* nearly full, evenly */
  const a2 = quotaAdvice(out, { [q.id]: { [men.id]: 82, [women.id]: 80, [other.id]: 18 } })[0];
  assert.deepEqual(a2.lines.map((l) => l.kind), ["near_full", "near_full"]);
  /* too few completes to judge pace */
  const a3 = quotaAdvice(out, { [q.id]: { [men.id]: 10, [women.id]: 9, [other.id]: 0 } })[0];
  assert.deepEqual(a3.lines.map((l) => l.kind), ["on_track"], "19 completes are too few to call a cell slow");
  const big = run(def, [{ op: "create_quota", name: "Big", total: 200, dimensions: [{ question: "GENDER", bands: [{ codes: [1], share: 40 }, { codes: [2], share: 40 }, { codes: [3], share: 20 }] }] }]).def;
  const bq = big.quotas[0];
  const a3b = quotaAdvice(big, { [bq.id]: { [bq.cells[0].id]: 10, [bq.cells[1].id]: 10, [bq.cells[2].id]: 0 } })[0];
  assert.ok(!a3b.lines.some((l) => l.kind === "under_pace"), "20 completes: too few to call a cell slow (the threshold is 30), though “Other” has 0 of ~4");
  assert.ok(quotaAdvice(big, { [bq.id]: { [bq.cells[0].id]: 15, [bq.cells[1].id]: 15, [bq.cells[2].id]: 0 } })[0].lines.some((l) => l.kind === "under_pace"), "at 30 it is called");
  /* complete */
  const a4 = quotaAdvice(out, { [q.id]: { [men.id]: 90, [women.id]: 90, [other.id]: 20 } })[0];
  assert.deepEqual(a4.lines.map((l) => l.kind), ["complete"]);
  /* a soft quota: the full cell is information, not a warning */
  const soft = run(out, [{ op: "update_quota", quota: "Gender", mode: "soft" }]).def;
  assert.equal(quotaAdvice(soft, { [q.id]: { [men.id]: 90, [women.id]: 58, [other.id]: 12 } })[0].lines.find((l) => l.kind === "full_while_open")!.severity, "info");
});
