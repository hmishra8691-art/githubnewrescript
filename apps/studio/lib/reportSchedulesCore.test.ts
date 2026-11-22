import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THEME, runAnalysis, type AnalysisResult, type ReportDefinition } from "@rescript/analytics";
import { synthDataset, D } from "../../../packages/analytics/dist/analyses/fixture.js";
import { runScheduleWith, type RunDeps } from "./reportSchedulesCore.ts";
import { publishReportWith } from "./reportPublishCore.ts";

/*
 * R5 + R6 — ONE SCHEDULE RUN, END TO END, against an in-memory database: re-compute, compare with the last run, render
 * and store the file, email the change summary; an alert that emails once when the figure crosses.
 */
type Row = Record<string, unknown>;
function memoryDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const from = (t: string) => {
    const rows = (tables[t] ??= []);
    let filters: ((r: Row) => boolean)[] = [];
    let op: { kind: "select" } | { kind: "insert"; row: Row } | { kind: "update"; patch: Row } = { kind: "select" };
    let sort: { c: string; asc: boolean } | null = null, cap = Infinity;
    const q = {
      select() { return q; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return q; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return q; },
      order(c: string, o?: { ascending?: boolean }) { sort = { c, asc: o?.ascending !== false }; return q; },
      limit(n: number) { cap = n; return q; },
      insert(row: Row) { op = { kind: "insert", row }; return q; },
      update(patch: Row) { op = { kind: "update", patch }; return q; },
      run() {
        if (op.kind === "insert") { const r = { id: `id-${++seq}`, ...op.row }; rows.push(r); return [r]; }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (sort) { const { c, asc } = sort; hit = [...hit].sort((a, b) => (Number(a[c]) - Number(b[c])) * (asc ? 1 : -1)); }
        if (op.kind === "select") hit = hit.slice(0, cap);
        if (op.kind === "update") for (const r of hit) Object.assign(r, op.patch);
        return hit;
      },
      maybeSingle() { const d = q.run(); return Promise.resolve({ data: d[0] ?? null, error: null }); },
      single() { const d = q.run(); return Promise.resolve({ data: d[0] ?? null, error: d[0] ? null : { message: "no row" } }); },
      then(res: (v: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: q.run(), error: null }).then(res); },
    };
    filters = [];
    return q;
  };
  return { from } as never;
}

const ds = synthDataset();
const ANALYSIS = "a1";
const report: ReportDefinition = { title: "Tracker", mode: "live", blocks: [{ id: "c", type: "chart", title: "Region", analysisId: ANALYSIS, chart: { type: "bar_vertical", options: {} } }] };

function setup(kind: "report" | "alert", recipients = ["client@example.com"]) {
  const tables: Record<string, Row[]> = {
    analytics_reports: [{ id: "rep", survey_id: "sv", name: "Weekly tracker", mode: "live", definition: report, theme_id: null, deleted_at: null, published_version: 1 }],
    analytics_report_versions: [{ id: "v1", report_id: "rep", survey_id: "sv", version: 1, snapshot: {} }],
    surveys: [{ id: "sv", title: "Brand study", customer_id: null }],
    report_runs: [],
    report_schedules: [],
  };
  const schedule: Row = { id: "sch", survey_id: "sv", report_id: "rep", share_id: null, name: "Monday update", kind, cadence: "weekly", hour_utc: 7, weekday: 1, day_of_month: null, format: kind === "report" ? "docx" : null, recipients, alert: kind === "alert" ? { analysisId: ANALYSIS, metric: "North", op: "above", threshold: 40 } : null, enabled: true, next_run_at: "2026-11-23T07:00:00Z", last_digest: null };
  tables.report_schedules.push(schedule);
  const stored: { path: string; bytes: number; type: string }[] = [];
  const mails: { to: string; subject: string; text: string; kind: string }[] = [];
  let data: AnalysisResult = runAnalysis(D("descriptive", ["REGION"]), ds);
  const deps: RunDeps = {
    compute: async () => ({ [ANALYSIS]: data }),
    theme: async () => DEFAULT_THEME,
    store: { name: "memory", put: async (_b, path, bytes, o) => { stored.push({ path, bytes: bytes.length, type: o.contentType }); } },
    mailConfigured: true,
    send: async (m) => { mails.push(m); return { sent: true }; },
  };
  return { db: memoryDb(tables), tables, schedule, deps, stored, mails, setData: (r: AnalysisResult) => { data = r; } };
}

/** the same result with one category's share moved, as if new responses came in */
function moved(r: AnalysisResult, category: string, by: number): AnalysisResult {
  const i = r.chart.categories!.indexOf(category);
  return { ...r, base: { ...r.base, n: r.base.n + 60 }, chart: { ...r.chart, series: r.chart.series!.map((s, k) => (k === 0 ? { ...s, values: s.values.map((v, j) => (j === i && typeof v === "number" ? v + by : v)) } : s)) } };
}

test("a report run: re-computed, rendered as Word, stored, recipients told; the second run says what moved", async () => {
  const t = setup("report");
  const first = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: "https://studio.example.com" });
  assert.equal(first.status, "ok", first.error);
  assert.match(first.headline!, /First run/);
  assert.equal(t.stored.length, 1);
  assert.match(t.stored[0].path, /^schedules\/sv\/sch\/.+\.docx$/);
  assert.match(t.stored[0].type, /wordprocessingml/);
  assert.equal(t.mails.length, 1);
  assert.match(t.mails[0].text, /sign in to download/);
  assert.match(t.mails[0].text, /https:\/\/studio\.example\.com\/api\/surveys\/sv\/report-schedules\?file=/);
  assert.ok(!/base64|PK\u0003\u0004/.test(t.mails[0].text), "no file in the email");
  assert.ok(t.schedule.last_digest, "the digest is kept for the next run");
  assert.equal(t.schedule.next_run_at, new Date(t.schedule.next_run_at as string).toISOString(), "moved to its next time");
  assert.equal(t.tables.report_runs[0].delivered, 1);

  const base = runAnalysis(D("descriptive", ["REGION"]), ds);
  const north = base.chart.categories!.find((c) => /north/i.test(c))!;
  t.setData(moved(base, north, 8));
  const second = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "manual", studioUrl: "https://studio.example.com" });
  assert.match(second.headline!, new RegExp(`1 figure moved since .*“${north}” up 8\\.0 points`));
  assert.match(t.mails[1].text, /What changed:/);
  assert.equal(t.tables.report_runs.length, 2);
  assert.equal(t.tables.report_runs[1].trigger, "manual");
});

test("an alert emails once when the figure crosses, not on the next run while it stays over", async () => {
  const t = setup("alert");
  const base = runAnalysis(D("descriptive", ["REGION"]), ds);
  const north = base.chart.categories!.find((c) => /north/i.test(c))!;
  (t.schedule.alert as Row).metric = north;
  const start = base.chart.series![0].values[base.chart.categories!.indexOf(north)] as number;
  (t.schedule.alert as Row).threshold = start + 4;
  const r1 = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(r1.alertFired, false);
  t.setData(moved(base, north, 6));
  const r2 = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(r2.alertFired, true);
  assert.equal(t.mails.length, 1);
  assert.equal(t.mails[0].kind, "metric_alert");
  assert.match(t.mails[0].subject, /^Alert: /);
  const r3 = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(r3.alertFired, false);
  assert.equal(t.mails.length, 1, "not told again while it stays over");
});

test("a deleted report disables its schedule; a failing computation is recorded and the schedule moves on", async () => {
  const t = setup("report");
  t.tables.analytics_reports[0].deleted_at = "2026-11-20T00:00:00Z";
  const r = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(r.status, "skipped");
  assert.equal(t.schedule.enabled, false);
  const f = setup("report");
  f.deps.compute = async () => { throw new Error("the dataset could not be read"); };
  const out = await runScheduleWith(f.db, f.deps, f.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(out.status, "failed");
  assert.equal(f.tables.report_runs[0].error, "the dataset could not be read");
  assert.ok(f.schedule.last_run_at);
});

test("republish on refresh: each run publishes a new version that unpinned share links follow; a blank run is not published", async () => {
  const t = setup("report");
  t.schedule.republish = true;
  /* a two-chart report, so a run can come back partial (one chart without data) and still render */
  t.tables.analytics_reports[0].definition = { ...report, blocks: [...report.blocks, { id: "c2", type: "chart", title: "Region again", analysisId: "a2", chart: { type: "bar_vertical", options: {} } }] };
  const full = t.deps.compute;
  let compute: RunDeps["compute"] = async (d) => { const r = await full(d); return { ...r, a2: r[ANALYSIS] }; };
  t.deps.compute = (d) => compute(d);
  t.deps.publish = async (reportId, results, note) => {
    const out = await publishReportWith(t.db, { compute: (d) => compute(d), theme: async () => DEFAULT_THEME, source: { version: 3, revision: 7 } }, { surveyId: "sv", reportId, userId: null, note, snapshot: results });
    return out.ok ? { ok: true, version: out.version, withheld: out.withheld } : { ok: false, error: out.error };
  };
  const r1 = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(r1.status, "ok", r1.error);
  assert.deepEqual(r1.published, { version: 2, withheld: 0 });
  assert.match(r1.headline!, /Published as version 2; share links that follow the latest version now show it\./);
  assert.equal(t.tables.analytics_reports[0].published_version, 2, "the report now points at the new version");
  const v2 = t.tables.analytics_report_versions.find((v) => v.version === 2)!;
  assert.equal(v2.published_by, null);
  assert.match(String(v2.note), /Republished by the schedule “Monday update” \(scheduled run\)/);
  assert.ok((v2.snapshot as Record<string, unknown>)[ANALYSIS], "the fresh results are frozen into the version");
  assert.equal((v2.dataset as Row).surveyVersion, 3);
  assert.equal(t.tables.report_runs[0].headline, r1.headline);
  assert.deepEqual((t.tables.report_runs[0].changes as Row).published, { version: 2, withheld: 0 });
  assert.match(t.mails[0].text, /Published as version 2/);

  const r2 = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "manual", studioUrl: null });
  assert.deepEqual(r2.published, { version: 3, withheld: 0 });
  assert.equal(t.tables.analytics_reports[0].published_version, 3);

  /* one chart comes back without data: the run still renders and mails, but the last good version stays published */
  compute = full;
  const r3 = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(r3.status, "ok", r3.error);
  assert.ok(r3.published && "notPublished" in r3.published);
  assert.match(r3.headline!, /Not republished: .* Share links still show the last published version\./);
  assert.equal(t.tables.analytics_reports[0].published_version, 3);
  assert.equal(t.tables.analytics_report_versions.length, 3);

  /* nothing at all comes back: the file cannot be rendered, the run fails, and nothing is published */
  compute = async () => ({});
  const r4 = await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(r4.status, "failed");
  assert.equal(t.tables.analytics_reports[0].published_version, 3);
  assert.equal(t.tables.analytics_report_versions.length, 3);
});

test("without republish (or on an alert) a run never writes a version", async () => {
  const t = setup("report");
  let calls = 0;
  t.deps.publish = async () => { calls++; return { ok: true, version: 9, withheld: [] }; };
  await runScheduleWith(t.db, t.deps, t.schedule, { trigger: "schedule", studioUrl: null });
  const a = setup("alert");
  a.schedule.republish = true;
  a.deps.publish = t.deps.publish;
  await runScheduleWith(a.db, a.deps, a.schedule, { trigger: "schedule", studioUrl: null });
  assert.equal(calls, 0);
  assert.equal(t.tables.analytics_report_versions.length, 1);
});
