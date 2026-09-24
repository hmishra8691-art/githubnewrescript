import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { buildDependencyIndex, objectStatus } from "@rescript/engine";
import {
  buildGridRows, decorateGridRows, applyGridQuery, typesIn, visibleRange, EMPTY_FILTER, GRID_COLUMNS, ROW_HEIGHT,
} from "./model.ts";

/**
 * THE GRID MODEL: rows are derived, never stored, and say the truth about
 * the survey they came from.
 */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?", settings: { minValue: 18, maxValue: 99 }, required: true,
        skipLogic: [{ id: "sk", when: cond.rule("q1", "lt", 18), target: { kind: "terminate", status: "screened" } }] },
      { id: "q2", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "<p>Which <b>brands</b>?</p>",
        options: [{ code: "A", label: "Apple" }, { code: "B", label: "Bosch" }, { code: "C", label: "Candy" }] },
      { id: "q3", code: "Q3", variableName: "WHY", type: "text", text: "Why {{Q2}}?", displayLogic: cond.rule("q2", "selected", "A") },
      { id: "q4", code: "Q4", variableName: "GRID", type: "matrix_single", text: "Rate",
        rows: [{ code: "r1", label: "R1" }, { code: "r2", label: "R2" }], options: [{ code: "1", label: "Bad" }, { code: "2", label: "Good" }, { code: "3", label: "Great" }] },
      { id: "q9", code: "Q9", variableName: "LOST", type: "text", text: "On no page" },
    ],
    flow: [
      { type: "page", id: "p1", title: "Screener", questionIds: ["q1"] },
      { type: "block", id: "b2", title: "Brands", children: [
        { type: "page", id: "p2", questionIds: ["q2", "q3"] },
        { type: "page", id: "p3", questionIds: ["q4"] },
      ] },
      { type: "end", id: "e", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

test("one row per question, in flow order, with placement", () => {
  const rows = buildGridRows(survey());
  assert.deepEqual(rows.map((r) => r.code), ["Q1", "Q2", "Q3", "Q4", "Q9"]);
  assert.equal(rows[0].blockTitle, "Screener");
  assert.equal(rows[1].blockTitle, "Brands");
  assert.equal(rows[3].pageId, "p3");
  assert.equal(rows[3].indexInPage, 0);
  assert.equal(rows[4].unplaced, true, "a question on no page is flagged, not hidden");
  assert.equal(rows[4].blockTitle, "—");
});

test("text is stripped of markup, and only plain text is marked cell-editable", () => {
  const rows = buildGridRows(survey());
  assert.equal(rows[1].text, "Which brands?");
  assert.equal(rows[1].plainText, false, "markup means edit in the Studio, not in a cell");
  assert.equal(rows[2].plainText, false, "a pipe token is structure too");
  assert.equal(rows[0].plainText, true);
});

test("options summarise as a list, a grid, or a range", () => {
  const rows = buildGridRows(survey());
  assert.equal(rows[1].options, "Apple · Bosch · Candy");
  assert.equal(rows[1].optionCount, 3);
  assert.equal(rows[3].options, "2 rows × 3 columns");
  assert.equal(rows[0].options, "18–99");
});

test("display, skip and validation columns read as sentences", () => {
  const rows = buildGridRows(survey());
  assert.match(rows[2].display, /Q2/, rows[2].display);
  assert.equal(rows[1].display, "");
  assert.match(rows[0].skip, /→ end \(screened\) when/);
  assert.match(rows[0].validation, /required/);
});

test("decoration adds status and dependency counts, and keeps row identity when nothing changed", () => {
  const def = survey();
  const rows = buildGridRows(def);
  const decorated = decorateGridRows(rows, objectStatus(def), buildDependencyIndex(def));
  const q3 = decorated.find((r) => r.code === "Q3")!;
  assert.ok(q3.dependsOn >= 1, "Q3 reads Q2 (display logic and a pipe)");
  const q2 = decorated.find((r) => r.code === "Q2")!;
  assert.ok(q2.usedBy >= 1, "Q2 is read by Q3");
  const again = decorateGridRows(decorated, objectStatus(def), buildDependencyIndex(def));
  for (let i = 0; i < again.length; i++) assert.equal(again[i], decorated[i], "unchanged rows keep identity so React skips them");
});

test("a lint problem shows on its row", () => {
  const def = survey();
  def.questions[2] = { ...def.questions[2], displayLogic: cond.rule("q_missing", "eq", 1) } as never;
  const rows = decorateGridRows(buildGridRows(def), objectStatus(def), buildDependencyIndex(def));
  const q3 = rows.find((r) => r.code === "Q3")!;
  assert.notEqual(q3.status, "ok");
  assert.ok(q3.issueCount >= 1);
  assert.equal(rows.find((r) => r.code === "Q1")!.status, "ok");
});

test("search matches code, variable, text, type, options and logic", () => {
  const rows = buildGridRows(survey());
  const find = (s: string) => applyGridQuery(rows, { ...EMPTY_FILTER, search: s }, null).map((r) => r.code);
  assert.deepEqual(find("bosch"), ["Q2"]);
  assert.deepEqual(find("WHY"), ["Q3"], "variable name");
  assert.deepEqual(find("age"), ["Q1", "Q9"], "case-insensitive, and 'page' contains it — search is a substring, not a word");
  assert.deepEqual(find("brands"), ["Q2", "Q3", "Q4"], "matches the text of Q2 and the block title of Q2–Q4");
  assert.deepEqual(find("numeric"), ["Q1"], "type label");
  assert.deepEqual(find("zzz"), []);
});

test("filters: with logic, with issues, by type, by block", () => {
  const def = survey();
  def.questions[2] = { ...def.questions[2], displayLogic: cond.rule("q_missing", "eq", 1) } as never;
  const rows = decorateGridRows(buildGridRows(def), objectStatus(def), buildDependencyIndex(def));
  const codes = (f: Partial<typeof EMPTY_FILTER>) => applyGridQuery(rows, { ...EMPTY_FILTER, ...f }, null).map((r) => r.code);
  assert.deepEqual(codes({ withLogic: true }), ["Q1", "Q3"]);
  assert.deepEqual(codes({ withIssues: true }), ["Q3", "Q9"], "Q9 sits on no page, which the lint rightly flags");
  assert.deepEqual(codes({ types: ["text"] }), ["Q3", "Q9"]);
  assert.deepEqual(codes({ block: "b2" }), ["Q2", "Q3", "Q4"]);
});

test("sort by ID is flow order, not alphabetical; sort is stable; desc reverses", () => {
  const def = survey();
  // give the survey a Q10 so alphabetical would put it before Q2
  def.questions.push({ id: "q10", code: "Q10", variableName: "TEN", type: "text", text: "Ten" } as never);
  (def.flow[0] as { questionIds: string[] }).questionIds.push("q10");
  const rows = buildGridRows(def);
  assert.deepEqual(rows.map((r) => r.code).slice(0, 2), ["Q1", "Q10"], "flow order after normalisation");
  const asc = applyGridQuery(rows, EMPTY_FILTER, { column: "code", dir: "asc" }).map((r) => r.code);
  assert.deepEqual(asc, rows.map((r) => r.code));
  const desc = applyGridQuery(rows, EMPTY_FILTER, { column: "code", dir: "desc" }).map((r) => r.code);
  assert.deepEqual(desc, [...asc].reverse());
  const byType = applyGridQuery(rows, EMPTY_FILTER, { column: "type", dir: "asc" }).map((r) => r.code);
  // three text questions tie on type; they keep flow order among themselves
  const texts = byType.filter((c) => ["Q3", "Q9", "Q10"].includes(c));
  assert.deepEqual(texts, ["Q10", "Q3", "Q9"]);
});

test("typesIn counts the types present, most common first", () => {
  const t = typesIn(buildGridRows(survey()));
  assert.equal(t[0].type, "text");
  assert.equal(t[0].count, 2);
  assert.equal(t.length, 4);
});

test("columns: two frozen, one grows, ids unique, defaults sensible", () => {
  const ids = GRID_COLUMNS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(GRID_COLUMNS.filter((c) => c.frozen).map((c) => c.id), ["status", "code"]);
  assert.deepEqual(GRID_COLUMNS.filter((c) => c.grow).map((c) => c.id), ["text"]);
  assert.ok(GRID_COLUMNS.filter((c) => c.defaultVisible).length >= 8);
});

test("visibleRange windows correctly at the edges and in the middle", () => {
  const h = ROW_HEIGHT.normal;
  const top = visibleRange(0, 720, h, 600, 8);
  assert.equal(top.start, 0);
  assert.equal(top.end, Math.ceil(720 / h) + 1 + 8);
  assert.equal(top.totalHeight, 600 * h);
  const mid = visibleRange(300 * h, 720, h, 600, 8);
  assert.equal(mid.start, 292);
  assert.equal(mid.offsetTop, 292 * h);
  assert.ok(mid.end - mid.start < 50, "only a screenful plus overscan is rendered");
  const bottom = visibleRange(10_000 * h, 720, h, 600, 8);
  assert.equal(bottom.end, 600, "never past the last row");
  assert.ok(bottom.start <= 600);
  const empty = visibleRange(0, 720, h, 0);
  assert.equal(empty.end, 0);
});
