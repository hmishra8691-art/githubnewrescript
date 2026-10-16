import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { moduleStates, overviewSummary } from "./projectOverview.ts";

/**
 * THE PROJECT OVERVIEW'S MODULE STATES (dashboard brief §2B): every state is
 * read from the saved definition and the facts the route fetched — nothing
 * inferred from the lifecycle status, nothing hard-coded.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, value: unknown) => ({ type: "rule", source: { kind: "question", ref }, operator: "eq", value });
function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "Gender?", options: opts("M", "F") },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
    ...extra,
  });
}
const by = (ms: ReturnType<typeof moduleStates>, k: string) => ms.find((m) => m.key === k)!;

test("an empty project: nothing set up, said plainly; a programmed one with a logic error needs attention", () => {
  const empty = moduleStates(SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [] }));
  assert.equal(empty.length, 10);
  assert.equal(by(empty, "programming").state, "not_configured");
  /*
   * CLEAN-03: quality is on by default at standard strictness, so even an
   * empty project honestly reports the engine as ON — the one module that is
   * not "nothing set up". Everything else is untouched.
   */
  assert.equal(by(empty, "quality").state, "configured");
  assert.match(by(empty, "quality").detail, /Quality engine on/);
  assert.ok(empty.filter((m) => m.key !== "quality").every((m) => m.state === "not_configured"), empty.map((m) => `${m.key}:${m.state}`).join(" "));
  assert.deepEqual(overviewSummary(empty), { configured: 1, total: 10, attention: [] });
  const off = moduleStates(SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, quality: { enabled: false }, questions: [], flow: [] }));
  assert.ok(off.every((m) => m.state === "not_configured"), "an explicit enabled:false is kept: quality is not configured");

  const ok = moduleStates(survey());
  assert.equal(by(ok, "programming").state, "configured");
  assert.match(by(ok, "programming").detail, /^2 questions/);
  assert.equal(by(ok, "programming").count, 2);

  const broken = moduleStates(survey({ questions: [{ id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?", displayLogic: rule("q9", 1) }] }));
  assert.equal(by(broken, "programming").state, "needs_attention");
  assert.match(by(broken, "programming").detail, /1 logic error to fix/);
  assert.equal(by(broken, "programming").tab, "logic");
  assert.deepEqual(overviewSummary(broken).attention.map((m) => m.key), ["programming"]);
});

test("quotas, collection, quality, research, plan, reports, languages, fieldwork and project facts — each from what is saved", () => {
  const def = survey({
    quotas: [{ id: "qt", name: "Gender", cells: [{ id: "c1", label: "M", when: rule("q2", 1), limit: 100 }, { id: "c2", label: "F", when: rule("q2", 2), limit: 100 }] }],
    quality: { enabled: true, profile: "Standard" },
    research: { objective: "Why switch", hypotheses: ["H"], constructs: [{ name: "C", role: "dependent", questionIds: ["q1"] }], strict: true, analysisPlan: { crosstabs: [{ id: "x", rows: ["AGE"], columns: ["GENDER"], priority: 1, hypotheses: [] }], tests: [], derived: [], segments: [] } },
    localization: { sourceLanguage: "en", languages: [{ code: "de", status: "ready" }, { code: "fr", status: "draft" }] },
  });
  // quotas defined but no check in the flow: incomplete, with the live fill
  const a = moduleStates(def, { quotaCounts: { qt: { c1: 40, c2: 10 } } });
  assert.equal(by(a, "quotas").state, "incomplete");
  assert.match(by(a, "quotas").detail, /1 quota, 2 cells · 50 of 200 live completes · no quota check in the flow yet/);
  const withCheck = SurveyDefinition.parse({ ...def, flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "quota_check", id: "qc", quotaIds: ["qt"], onFull: { kind: "terminate" } }, { type: "end", id: "e", status: "complete" }] });
  assert.equal(by(moduleStates(withCheck), "quotas").state, "configured");
  // collection: from the deployments table, and the status only to flag a contradiction
  assert.equal(by(moduleStates(def, { deployments: [] }), "collection").state, "not_configured");
  assert.equal(by(moduleStates(def, { deployments: [{ mode: "test", active: true }] }), "collection").state, "incomplete");
  assert.equal(by(moduleStates(def, { deployments: [{ mode: "live", active: true }, { mode: "test", active: true }] }), "collection").detail, "Live link active · test link active");
  assert.equal(by(moduleStates(def, { deployments: [{ mode: "live", active: false }], status: "live" }), "collection").state, "needs_attention");
  assert.equal(by(moduleStates(def, { deployments: [], status: "draft" }), "collection").state, "not_configured");
  // the rest
  assert.match(by(a, "quality").detail, /Quality engine on · profile “Standard”/);
  assert.equal(by(a, "research").state, "configured"); assert.match(by(a, "research").detail, /1 hypothesis · 1 construct · enforced/);
  assert.equal(by(moduleStates(survey({ research: { objective: "O", hypotheses: [] } })), "research").state, "incomplete");
  assert.equal(by(moduleStates(survey({ research: { hypotheses: [], brief: { client: "Acme", stakeholders: [], deliverables: [] } } })), "research").detail, "Brief recorded · no objective yet");
  assert.match(by(moduleStates(def, { latestRun: { computedAt: "2026-10-01T10:00:00Z", n: 120, trigger: "halfway" } }), "analysis").detail, /1 crosstab, 0 tests · last run 2026-10-01 on 120 completes/);
  assert.match(by(a, "analysis").detail, /not run yet/);
  /* the row opens Data Analytics → Analysis plan, and reads the last apply when the database records them */
  assert.equal(by(a, "analysis").tab, "analytics:plan");
  assert.equal(by(moduleStates(def, { latestApply: null }), "analysis").state, "incomplete");
  assert.match(by(moduleStates(def, { latestApply: null }), "analysis").detail, /not applied yet/);
  assert.equal(by(moduleStates(def, { latestApply: { status: "applied", startedAt: "2026-10-11T09:00:00Z", current: true } }), "analysis").state, "configured");
  assert.match(by(moduleStates(def, { latestApply: { status: "applied", startedAt: "2026-10-11T09:00:00Z", current: true } }), "analysis").detail, /applied 2026-10-11/);
  assert.equal(by(moduleStates(def, { latestApply: { status: "applied", startedAt: "2026-10-11T09:00:00Z", current: false } }), "analysis").state, "incomplete");
  assert.match(by(moduleStates(def, { latestApply: { status: "applied", startedAt: "2026-10-11T09:00:00Z", current: false } }), "analysis").detail, /changed since it was applied/);
  assert.equal(by(moduleStates(def, { latestApply: { status: "partial", startedAt: "2026-10-11T09:00:00Z", current: true } }), "analysis").state, "needs_attention");
  assert.equal(by(moduleStates(def, { latestApply: { status: "failed", startedAt: "2026-10-11T09:00:00Z", current: true } }), "analysis").state, "needs_attention");
  assert.match(by(moduleStates(def, { latestApply: { status: "no_data", startedAt: "2026-10-11T09:00:00Z", current: true } }), "analysis").detail, /waiting for responses/);
  assert.equal(by(moduleStates(survey({})), "analysis").tab, "analytics:plan");
  assert.equal(by(moduleStates(def, { reports: [{ kind: "dashboard" }, { kind: "report" }, { kind: "report" }], analyses: 4 }), "reporting").detail, "1 dashboard, 2 reports · 4 saved analyses");
  assert.equal(by(moduleStates(def, { analyses: 2 }), "reporting").state, "not_configured");
  assert.equal(by(a, "languages").state, "incomplete"); assert.match(by(a, "languages").detail, /2 languages beside en · 1 not ready/);
  assert.equal(by(moduleStates(def, { config: { fieldworkFrom: "2026-11-01", fieldworkTo: "2026-11-20" }, sampleSources: 2 }), "fieldwork").detail, "2026-11-01 → 2026-11-20 · 2 sample sources");
  assert.equal(by(moduleStates(def, { config: { fieldworkFrom: "2026-11-01" } }), "fieldwork").state, "incomplete");
  assert.equal(by(moduleStates(def, { config: { clientName: "Acme", dueDate: "2026-12-01" } }), "project").detail, "Acme · due 2026-12-01");
  assert.equal(by(moduleStates(def, { config: { projectManager: "Ann" } }), "project").state, "incomplete");
  assert.deepEqual(a.filter((m) => m.state === "configured").map((m) => m.key), ["programming", "quality", "research", "analysis"]);
  assert.equal(overviewSummary(a).configured, 4);
});
