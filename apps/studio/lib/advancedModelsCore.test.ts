import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisDefinition } from "@rescript/analytics";
import { FakeDb as FakeDbBase } from "../../../scripts/lib/fakeSupabase.mjs";
import { advancedStatus, completesSince, isAdvancedDefinition, rerunTargets, type AdvancedPlanItem } from "./advancedModelsCore.ts";

/*
 * THE ADVANCED MODELS OF A PLAN, LIVE (2026-10-22) — over the in-memory Supabase: which items count as advanced,
 * the completes since a result was computed (by environment), fresh / stale / never run / running, the plan's
 * threshold policy, and what a re-run redoes. A stale result is only flagged; nothing here replaces it.
 */
class FakeDb extends FakeDbBase { as(): SupabaseClient { return this as unknown as SupabaseClient; } }
const SID = "11111111-1111-4111-8111-111111111111";
const ds = { environment: "LIVE" as const, dataset: "all" as const };
const def = (kind: AnalysisDefinition["kind"], planned: string, options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: planned, kind, dataset: ds, variables: ["X"], options: { planned, ...options } });
const item = (d: AnalysisDefinition): AdvancedPlanItem => ({ planned: String(d.options!.planned), title: d.name, definition: d, analysisId: null });

function db(responses: { completed_at: string; is_test?: boolean; status?: string }[], jobs: Record<string, unknown>[] = []): FakeDb {
  const f = new FakeDb();
  const t = f.tables as Record<string, unknown[]>;
  t.responses = responses.map((r, i) => ({ id: `r${i}`, survey_id: SID, deleted_at: null, status: r.status ?? "complete", is_test: r.is_test ?? false, completed_at: r.completed_at }));
  t.analytics_model_jobs = jobs.map((j) => ({ survey_id: SID, ...j }));
  return f;
}

test("which definitions are advanced: HB, latent class, SEM, a bootstrapped mediation, ω, Gabor–Granger — not their plain cousins", () => {
  for (const d of [def("hb", "a"), def("lca", "b"), def("sem", "c"), def("regression", "d", { bootstrap: 5000 }), def("reliability", "e", { omega: true }), def("pricing", "f", { method: "gabor_granger" })]) assert.ok(isAdvancedDefinition(d), d.kind);
  for (const d of [def("regression", "g"), def("reliability", "h"), def("pricing", "i"), def("crosstab", "j")]) assert.ok(!isAdvancedDefinition(d), d.kind);
});

test("completes since a moment, by environment: live excludes test completes, partials never count", async () => {
  const f = db([{ completed_at: "2026-10-20T10:00:00Z" }, { completed_at: "2026-10-21T10:00:00Z" }, { completed_at: "2026-10-21T11:00:00Z", is_test: true }, { completed_at: "2026-10-21T12:00:00Z", status: "partial" }]);
  assert.equal(await completesSince(f.as(), SID, "LIVE", "2026-10-21T00:00:00Z"), 1);
  assert.equal(await completesSince(f.as(), SID, "TEST", "2026-10-21T00:00:00Z"), 1);
  assert.equal(await completesSince(f.as(), SID, "ALL", "2026-10-21T00:00:00Z"), 2);
});

test("each advanced item's state: HB from its finished job, the others from the latest run; stale with the count, threshold policy, running job progress", async () => {
  const hb = def("hb", "t_hb"), lca = def("lca", "t_lca"), sem = def("sem", "t_sem"), md = def("hb", "t_md"), om = def("reliability", "t_om", { omega: true });
  const f = db(
    [{ completed_at: "2026-10-20T08:00:00Z" }, { completed_at: "2026-10-21T09:00:00Z" }, { completed_at: "2026-10-21T10:00:00Z" }, { completed_at: "2026-10-21T11:00:00Z" }],
    [
      { id: "j1", status: "done", progress: { done: 10000, total: 10000 }, finished_at: "2026-10-21T09:30:00Z", created_at: "2026-10-21T09:00:00Z", definition: hb },
      { id: "j2", status: "running", progress: { done: 2500, total: 10000 }, finished_at: null, created_at: "2026-10-21T10:30:00Z", definition: md },
    ],
  );
  const run = { computedAt: "2026-10-20T09:00:00Z", n: 1, items: [{ definition: lca }, { definition: sem, error: { code: "not_computable", message: "did not converge" } }, { definition: om }] };
  const out = await advancedStatus(f.as(), SID, { items: [hb, lca, sem, md, om].map(item), run, environment: "LIVE", policy: { mode: "threshold", newResponses: 3 } });
  const by = Object.fromEntries(out.map((s) => [s.planned, s]));
  assert.equal(by.t_hb.staleness.state, "stale"); assert.equal(by.t_hb.staleness.newResponses, 2, "HB's clock is its finished job, not the run");
  assert.equal(by.t_hb.staleness.autoRerun, false, "2 new completes < the threshold of 3");
  assert.equal(by.t_hb.job?.pct, 100);
  assert.equal(by.t_lca.staleness.state, "stale"); assert.equal(by.t_lca.staleness.newResponses, 3);
  assert.equal(by.t_lca.staleness.autoRerun, true, "the threshold is reached");
  assert.match(by.t_lca.staleness.message, /3 new completes since this was computed on 1 — the result shown is the earlier one/);
  assert.equal(by.t_sem.staleness.state, "never_run", "a failed model in the run is not a result");
  assert.equal(by.t_md.staleness.state, "running"); assert.equal(by.t_md.job?.pct, 25);
  assert.equal(by.t_om.staleness.state, "stale");

  /* what a re-run redoes: by hand, everything stale or never run (HB as jobs, not the running one); the cron only what the threshold asks for */
  assert.deepEqual(rerunTargets(out), { hb: ["t_hb"], runPlan: true });
  assert.deepEqual(rerunTargets(out, { onlyAuto: true }), { hb: [], runPlan: true });
  const fresh = await advancedStatus(f.as(), SID, { items: [item(lca)], run: { ...run, computedAt: "2026-10-22T00:00:00Z" }, environment: "LIVE" });
  assert.equal(fresh[0].staleness.state, "fresh");
  assert.deepEqual(rerunTargets(fresh), { hb: [], runPlan: false }, "nothing to redo when everything is up to date");
});

test("no plan items, no jobs table rows, no run: nothing breaks", async () => {
  const f = db([]);
  assert.deepEqual(await advancedStatus(f.as(), SID, { items: [], run: null, environment: "LIVE" }), []);
  const out = await advancedStatus(f.as(), SID, { items: [item(def("hb", "t1")), item(def("sem", "t2"))], run: null, environment: "LIVE" });
  assert.deepEqual(out.map((s) => s.staleness.state), ["never_run", "never_run"]);
  assert.deepEqual(rerunTargets(out), { hb: ["t1"], runPlan: true });
});
