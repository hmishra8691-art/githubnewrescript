import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THEME, runAnalysis, type ReportDefinition } from "@rescript/analytics";
import { synthDataset, D } from "../../../packages/analytics/dist/analyses/fixture.js";
import { publishReportWith, type PublishDeps } from "./reportPublishCore.ts";

/* the one publish (Studio button and republishing schedules): refusal of a partial report unless forced, numbering, the pointer */
type Row = Record<string, unknown>;
function db(tables: Record<string, Row[]>) {
  const from = (t: string) => {
    const rows = (tables[t] ??= []);
    const f: ((r: Row) => boolean)[] = [];
    let op: "select" | Row | { patch: Row } = "select", sort: string | null = null, cap = Infinity;
    const run = () => {
      if (op !== "select" && !("patch" in op)) { rows.push({ ...op }); return [op]; }
      let hit = rows.filter((r) => f.every((x) => x(r)));
      if (op !== "select") { for (const r of hit) Object.assign(r, (op as { patch: Row }).patch); return hit; }
      if (sort) hit = [...hit].sort((a, b) => Number(b[sort!]) - Number(a[sort!]));
      return hit.slice(0, cap);
    };
    const q = {
      select: () => q, eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q), in: (c: string, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q), order: (c: string) => ((sort = c), q), limit: (n: number) => ((cap = n), q),
      insert: (r: Row) => ((op = r), q), update: (p: Row) => ((op = { patch: p }), q),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(res),
    };
    return q;
  };
  return { from } as never;
}

const ds = synthDataset();
const result = runAnalysis(D("descriptive", ["REGION"]), ds);
const report: ReportDefinition = { title: "T", mode: "live", blocks: [
  { id: "c", type: "chart", title: "Region", analysisId: "a1", chart: { type: "bar_vertical", options: {} } },
  { id: "d", type: "chart", title: "Missing", analysisId: "a2", chart: { type: "bar_vertical", options: {} } },
] };
const setup = () => {
  const tables: Record<string, Row[]> = { analytics_reports: [{ id: "rep", survey_id: "sv", name: "Tracker", mode: "live", definition: report, theme_id: null, deleted_at: null, published_version: null }], analytics_report_versions: [] };
  const deps: PublishDeps = { compute: async () => ({ a1: result }), theme: async () => DEFAULT_THEME, source: { version: 2, revision: 5 } };
  return { tables, d: db(tables), deps };
};

test("a partial report is refused with canForce; forced, it is version 1 and the report points at it; the next is 2", async () => {
  const t = setup();
  const refused = await publishReportWith(t.d, t.deps, { surveyId: "sv", reportId: "rep", userId: "u1" });
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.status === 409 && refused.canForce && /^Not published\./.test(refused.error));
  assert.equal(t.tables.analytics_report_versions.length, 0);
  const one = await publishReportWith(t.d, t.deps, { surveyId: "sv", reportId: "rep", userId: "u1", force: true, note: "first" });
  assert.ok(one.ok && one.version === 1);
  assert.equal(t.tables.analytics_reports[0].published_version, 1);
  assert.equal(t.tables.analytics_reports[0].updated_by, "u1");
  assert.equal(t.tables.analytics_report_versions[0].published_by, "u1");
  assert.equal(t.tables.analytics_report_versions[0].note, "first");
  const two = await publishReportWith(t.d, t.deps, { surveyId: "sv", reportId: "rep", userId: null, force: true });
  assert.ok(two.ok && two.version === 2);
  assert.equal(t.tables.analytics_reports[0].published_version, 2);
});

test("another project's report, or a deleted one, is unknown", async () => {
  const t = setup();
  const other = await publishReportWith(t.d, t.deps, { surveyId: "other", reportId: "rep", userId: "u1", force: true });
  assert.ok(!other.ok && other.status === 404);
  t.tables.analytics_reports[0].deleted_at = "2026-11-01";
  const gone = await publishReportWith(t.d, t.deps, { surveyId: "sv", reportId: "rep", userId: "u1", force: true });
  assert.ok(!gone.ok && gone.status === 404);
});
