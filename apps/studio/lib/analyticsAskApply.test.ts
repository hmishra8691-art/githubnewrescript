import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, runAnalysis, variableMetadata, surveyKnownNames, type AnalysisDefinition, type AskContext, type AskOp, type ReportDefinition } from "@rescript/analytics";
import { applyOps, undoRecords } from "./analyticsAskApply.ts";
// the analytics fixture is test support inside the package, not part of its public surface
// @ts-ignore
import { def, synthRows } from "../../../packages/analytics/dist/analyses/fixture.js";

/* a small in-memory stand-in for the database client: the chain the apply code uses, with real filter semantics */
type Row = Record<string, any>;
function memoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  let n = 0;
  class Q {
    mode: "select" | "insert" | "update" = "select"; payload: any; filters: ((r: Row) => boolean)[] = []; single_ = false; maybe = false;
    table: string;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    insert(row: Row) { this.mode = "insert"; this.payload = row; return this; }
    update(p: Row) { this.mode = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    single() { this.single_ = true; return this; }
    maybeSingle() { this.maybe = true; return this; }
    run() {
      const t = (tables[this.table] ??= []);
      let rows: Row[];
      if (this.mode === "insert") { const row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, deleted_at: null, ...this.payload }; t.push(row); rows = [row]; }
      else { rows = t.filter((r) => this.filters.every((f) => f(r))); if (this.mode === "update") for (const r of rows) Object.assign(r, this.payload); }
      if (this.single_) return rows.length ? { data: { ...rows[0] }, error: null } : { data: null, error: { message: "no rows" } };
      if (this.maybe) return { data: rows[0] ? { ...rows[0] } : null, error: null };
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    then(ok?: (v: any) => unknown, no?: (e: any) => unknown) { return Promise.resolve(this.run()).then(ok, no); }
  }
  return { tables, from: (t: string) => new Q(t) } as unknown as { tables: Record<string, Row[]>; from: (t: string) => any };
}

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, synthRows(), { spec });
const vars = variableMetadata(def);
const SURVEY = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const A = (n: number) => `a000000${n}-0000-4000-8000-000000000000`;
const analysisRow = (i: number, name: string, definition: Partial<AnalysisDefinition>, survey = SURVEY): Row => ({ id: A(i), survey_id: survey, name, deleted_at: null, version: 1, definition: { name, dataset: spec, ...definition } });
const R1 = "bbbbbbbb-0000-4000-8000-000000000001";

const contextFor = (db: ReturnType<typeof memoryDb>) => async (needResults: boolean): Promise<AskContext> => {
  const analyses = db.tables.analytics_analyses.filter((r) => r.survey_id === SURVEY && !r.deleted_at).map((r) => ({ id: r.id, name: r.name, definition: { ...r.definition, id: r.id, name: r.name } as AnalysisDefinition }));
  const reports = (db.tables.analytics_reports ?? []).filter((r) => r.survey_id === SURVEY && !r.deleted_at).map((r) => ({ id: r.id, name: r.name, definition: r.definition as ReportDefinition }));
  const results = needResults ? Object.fromEntries(analyses.map((a) => [a.id, runAnalysis(a.definition, ds)])) : {};
  return { variables: vars, known: surveyKnownNames(def as never, vars), analyses, reports, results, dataset: spec };
};
/* undo records travel through the browser as JSON; a test that shares objects with the stored row would hide edits made in between */
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const crosstab = (name: string, rows: string[], columns: string[]): AskOp => ({ op: "add_crosstab", name, rows, columns });
const apply = (db: ReturnType<typeof memoryDb>, ops: AskOp[], request = "r") => applyOps(db as never, SURVEY, "1.0", "u1", ops, spec, request, contextFor(db));

const seed = () => memoryDb({
  analytics_analyses: [analysisRow(1, "Satisfaction", { kind: "descriptive", variables: ["SAT"] }), analysisRow(2, "Satisfaction (2)", { kind: "descriptive", variables: ["SAT"] }), analysisRow(3, "Brands considered", { kind: "descriptive", variables: ["CONSIDER"] }), analysisRow(9, "Elsewhere", { kind: "descriptive", variables: ["SAT"] }, OTHER)],
  analytics_analysis_versions: [], analytics_charts: [],
  analytics_reports: [{ id: R1, survey_id: SURVEY, name: "Report", deleted_at: null, definition: { title: "Report", mode: "live", blocks: [{ id: "c1", type: "chart", title: "Brands", analysisId: A(3), chart: { type: "pie", options: {} } }] } }],
});

test("creating: the analysis, its first version and where it came from are saved; the same item twice in one batch lands once", async () => {
  const db = seed();
  const out = await apply(db, [crosstab("Satisfaction by gender", ["SAT"], ["GENDER"]), crosstab("Satisfaction by gender again", ["SAT"], ["GENDER"])], "crosstab of satisfaction by gender");
  assert.deepEqual(out.map((o) => o.status), ["done", "blocked"]);
  assert.match(out[1].message, /already have “Satisfaction by gender”/);
  const row = db.tables.analytics_analyses.find((r) => r.name === "Satisfaction by gender")!;
  assert.equal(row.kind, "crosstab"); assert.equal(row.survey_id, SURVEY); assert.equal(row.created_by, "u1");
  assert.equal(row.definition.options.requested, "crosstab of satisfaction by gender");
  assert.deepEqual(row.definition.rows, ["SAT"]);
  assert.equal(db.tables.analytics_analysis_versions.length, 1);
  assert.equal(db.tables.analytics_analysis_versions[0].analysis_id, row.id);
  assert.equal(db.tables.analytics_analyses.length, 5, "exactly one analysis was added");
  assert.deepEqual(out[0].undo, { kind: "created_analysis", id: row.id });
});

test("a blocked item does not stop the ones after it, and an unknown variable is never saved", async () => {
  const db = seed();
  const out = await apply(db, [crosstab("Bad", ["NOPE"], ["GENDER"]), crosstab("Good", ["SAT"], ["REGION"])]);
  assert.deepEqual(out.map((o) => o.status), ["blocked", "done"]);
  assert.match(out[0].message, /NOPE/);
  assert.equal(db.tables.analytics_analyses.filter((r) => r.name === "Bad").length, 0);
});

test("removing is a soft delete with its charts; undo brings both back, and only the charts it took", async () => {
  const db = seed();
  db.tables.analytics_charts.push({ id: "ch1", survey_id: SURVEY, analysis_id: A(2), deleted_at: null }, { id: "ch2", survey_id: SURVEY, analysis_id: A(2), deleted_at: "2026-01-01" });
  const out = await apply(db, [{ op: "remove_analysis", name: "Satisfaction (2)", analysisId: A(2), keptId: A(1) }]);
  assert.equal(out[0].status, "done");
  assert.ok(db.tables.analytics_analyses.find((r) => r.id === A(2))!.deleted_at);
  assert.ok(db.tables.analytics_charts.find((r) => r.id === "ch1")!.deleted_at);
  const u = await undoRecords(db as never, SURVEY, "u1", [out[0].undo!]);
  assert.equal(u[0].status, "undone");
  assert.equal(db.tables.analytics_analyses.find((r) => r.id === A(2))!.deleted_at, null);
  assert.equal(db.tables.analytics_charts.find((r) => r.id === "ch1")!.deleted_at, null);
  assert.equal(db.tables.analytics_charts.find((r) => r.id === "ch2")!.deleted_at, "2026-01-01", "a chart that was already gone stays gone");
});

test("an analysis a report uses is not removed; another survey's analysis cannot be reached", async () => {
  const db = seed();
  const used = await apply(db, [{ op: "remove_analysis", name: "Brands", analysisId: A(3) }]);
  assert.equal(used[0].status, "blocked"); assert.match(used[0].message, /used by “Report”/);
  assert.equal(db.tables.analytics_analyses.find((r) => r.id === A(3))!.deleted_at, null);
  const foreign = await apply(db, [{ op: "remove_analysis", name: "x", analysisId: A(9) }]);
  assert.equal(foreign[0].status, "blocked");
  assert.equal(db.tables.analytics_analyses.find((r) => r.id === A(9))!.deleted_at, null, "the other survey's analysis is untouched");
  await undoRecords(db as never, SURVEY, "u1", [{ kind: "created_analysis", id: A(9) }]);
  assert.equal(db.tables.analytics_analyses.find((r) => r.id === A(9))!.deleted_at, null, "undo is scoped to this survey too");
});

test("a chart change is saved on the report block and undone; a chart edited since is left alone", async () => {
  const db = seed();
  const op: AskOp = { op: "set_chart", name: "Brands", reportId: R1, blockId: "c1", analysisId: A(3), chart: "bar_horizontal", from: "pie" };
  const out = wire(await apply(db, [op]));
  assert.equal(out[0].status, "done");
  const block = () => (db.tables.analytics_reports[0].definition.blocks as any[]).find((b) => b.id === "c1");
  assert.equal(block().chart.type, "bar_horizontal");
  const u = await undoRecords(db as never, SURVEY, "u1", [out[0].undo!]);
  assert.equal(u[0].status, "undone"); assert.equal(block().chart.type, "pie");
  const again = wire(await apply(db, [op]));
  block().chart.type = "lollipop"; // someone changed it after the request did
  const skipped = await undoRecords(db as never, SURVEY, "u1", [again[0].undo!]);
  assert.equal(skipped[0].status, "skipped"); assert.match(skipped[0].message, /changed again/);
  assert.equal(block().chart.type, "lollipop");
});

test("a chart the result cannot be drawn as is blocked and the report is unchanged; a report is never created from here", async () => {
  const db = seed();
  const before = JSON.stringify(db.tables.analytics_reports[0].definition);
  const out = await apply(db, [{ op: "set_chart", name: "x", reportId: R1, blockId: "c1", analysisId: A(3), chart: "heatmap" }, { op: "build_report", name: "R", story: false, brief: { objective: "x", audience: "client", tone: "plain", keyQuestions: [] } }]);
  assert.deepEqual(out.map((o) => o.status), ["blocked", "blocked"]);
  assert.match(out[1].message, /report builder/);
  assert.equal(JSON.stringify(db.tables.analytics_reports[0].definition), before);
  assert.equal(db.tables.analytics_reports.length, 1);
});
