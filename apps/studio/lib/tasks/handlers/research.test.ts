import { test } from "node:test";
import assert from "node:assert/strict";
import { __research, analysisPlanner, runDigest, setResearchBackend, type ResearchBackend, type ResearchRunLite } from "./research.ts";

/**
 * THE ANALYSIS AGENT'S STEPS, against a stand-in for the data services. What is proved: no backend means a paused
 * task that says why (never invented data); an empty plan or no responses pause for the researcher; the apply step
 * reports the engine's own summary; the verify step reads only findings that hold after correction.
 */
/* the analytics package's synthetic study: a questionnaire the derived framework has analyses for */
const { def } = await import("../../../../../packages/analytics/dist/analyses/fixture.js") as unknown as { def: never };

const ctx = (kind: string, input: Record<string, unknown> = {}) => ({ taskId: "t", planVersion: 1, surveyId: "s1", attempt: 0, step: { id: kind, kind, title: kind, dependsOn: [], input, status: "running" }, deps: {}, draft: def, summary: {} as never, ai: (async () => ({ ok: false })) as never, deadlineMs: Date.now() + 1e4, signal: new AbortController().signal }) as never;

const finding = (id: string, significant: boolean, adjusted?: boolean) => ({ id, kind: "difference", strength: "moderate", significant, headline: `Finding ${id}`, evidence: { n: 200, p: significant ? 0.01 : 0.4, ...(adjusted === undefined ? {} : { adjusted: { method: "holm", p: adjusted ? 0.02 : 0.09, significant: adjusted, family: "f" } }) }, variables: [], hypotheses: ["H1"], analysis: { name: "Sat by gender", kind: "crosstab", hash: "h" } });
const run: ResearchRunLite = {
  computedAt: "2026-11-07T10:00:00Z", environment: "LIVE", n: 240,
  findings: [finding("a", true, true), finding("b", true, false), finding("c", false)] as never,
  verdicts: [{ label: "H1", text: "Women are more satisfied", verdict: "supported", reason: "one finding holds", findings: [finding("a", true, true), finding("b", true, false)], analyses: 1 },
    { label: "H2", text: "Age drives NPS", verdict: "untested", reason: "no analysis", findings: [], analyses: 0 }] as never,
  items: [{ definition: { name: "Sat by gender", kind: "crosstab" }, result: {}, findings: [] }, { definition: { name: "Broken", kind: "crosstab" } }],
};

const fake = (over: Partial<ResearchBackend> = {}): ResearchBackend => ({
  definition: async () => ({ def }),
  applyPlan: async () => ({ ok: true, status: 200, summary: { status: "applied", n: 240, message: "2 analyses run", counts: { created: 2, run: 2, failed: 0 }, items: [{ id: "x", title: "Sat by gender", status: "run" }] }, runId: "r1", report: { action: "created" }, dashboard: { action: "updated" } }),
  latestRun: async () => run,
  ...over,
});

test("the planner is started by name only and plans check → apply → verify on the chosen data", async () => {
  assert.equal(analysisPlanner.matches({ message: "run the analysis plan", survey: def }), 0, "never claims a Copilot turn (analytics.edit is checked where it is started)");
  const p = await analysisPlanner.plan({ message: "Run the analysis plan", survey: def, ai: (async () => ({})) as never, options: { environment: "TEST", dataset: "clean" } });
  assert.deepEqual(p.steps.map((s) => [s.id, s.kind, s.dependsOn.join()]), [["check", "analysis.check", ""], ["apply", "analysis.apply", "check"], ["verify", "analysis.verify", "apply"]]);
  assert.deepEqual(p.steps[1].input, { environment: "TEST", dataset: "clean" });
  assert.match(p.steps[1].title, /test responses, clean dataset/);
});

test("without a database the steps pause and say why — nothing is invented", async () => {
  setResearchBackend(null);
  for (const k of ["runCheck", "runApply", "runVerify"]) {
    const r = await __research[k](ctx(k));
    assert.equal(r.status, "blocked");
    assert.match((r as { reason: string }).reason, /saved project's responses/);
  }
});

test("check: counts what will run and warns when no plan is written; apply: the engine's summary, no-data pauses", async () => {
  setResearchBackend(fake());
  const c = await __research.runCheck(ctx("check", { environment: "LIVE" }));
  assert.equal(c.status, "completed");
  const out = (c as { output: { data: { planned: number; planWritten: boolean }; validation: { warnings: string[] } } }).output;
  assert.ok(out.data.planned > 0);
  assert.equal(out.data.planWritten, false);
  assert.match(out.validation.warnings[0], /framework derived from the questionnaire/);
  const a = await __research.runApply(ctx("apply"));
  assert.equal(a.status, "completed");
  assert.equal((a as { output: { data: { n: number; report: string } } }).output.data.n, 240);
  setResearchBackend(fake({ applyPlan: async () => ({ ok: true, status: 200, summary: { status: "no_data", n: 0, message: "", counts: {}, items: [] } }) }));
  const nd = await __research.runApply(ctx("apply", { environment: "LIVE" }));
  assert.equal(nd.status, "blocked");
  assert.match((nd as { reason: string }).reason, /No production responses/);
  setResearchBackend(fake({ applyPlan: async () => ({ ok: false, status: 403, error: "no analytics access" }) }));
  const fail = await __research.runApply(ctx("apply"));
  assert.deepEqual([fail.status, (fail as { permanent: boolean }).permanent], ["failed", true]);
});

test("verify: only findings that hold after correction count; verdicts carry their evidence; untested and failed analyses are named", async () => {
  setResearchBackend(fake());
  const v = await __research.runVerify(ctx("verify"));
  const out = (v as { output: { data: ReturnType<typeof runDigest>; validation: { ok: boolean; warnings: string[] } } }).output;
  assert.equal(out.validation.ok, true);
  assert.equal(out.data.findings, 3);
  assert.equal(out.data.holding, 1, "b is significant raw but not after the Holm correction");
  assert.deepEqual(out.data.top.map((f) => f.id), ["a"]);
  assert.deepEqual(out.data.verdicts.find((x) => x.label === "H1")!.evidence, ["a"]);
  assert.ok(out.validation.warnings.some((w) => /H2: untested/.test(w)));
  assert.ok(out.validation.warnings.some((w) => /Broken/.test(w)));
  setResearchBackend(fake({ latestRun: async () => null }));
  assert.equal((await __research.runVerify(ctx("verify"))).status, "failed");
  setResearchBackend(null);
});
