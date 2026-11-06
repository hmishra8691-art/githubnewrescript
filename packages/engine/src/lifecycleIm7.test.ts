import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { downstreamOf, launchPlan, launchReadiness } from "./lifecycle.js";
import { applySurveyActions } from "./surveyActions.js";
import { readResearchBrief } from "./researchBrief.js";

/* IM7 — downstream impact, launch readiness, the launch plan from the master prompt's sentence */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const base = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Doctors" },
  research: { objective: "Telemedicine adoption", population: "consumers in the UK", sampleSize: 600, hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] },
  questions: [
    { id: "q1", code: "Q1", variableName: "SPEC", type: "single_select", text: "Which treatment do you prescribe first for this diagnosis?", options: opts("A", "B") },
    { id: "q2", code: "Q2", variableName: "AGEG", type: "single_select", text: "Age group?", options: opts("18-34", "35+") },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2"] }] }, { type: "end", id: "e", status: "complete" }],
  quotas: [{ id: "qa", name: "Age", cells: [{ id: "a1", label: "18-34", when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "eq", value: 1 }, limit: 300 }, { id: "a2", label: "35+", when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "eq", value: 2 }, limit: 300 }] }],
});

test("an audience change names what it leaves to update — with the change, never applied by it", () => {
  const before = base();
  const out = applySurveyActions(before, [{ op: "set_research", population: "1,000 oncologists in Germany" } as never]);
  assert.ok(out.valid);
  const d = downstreamOf(before, out.def);
  assert.ok(d.some((x) => x.area === "quotas"), JSON.stringify(d));
  assert.ok(d.some((x) => x.area === "settings" && /unique links/.test(x.what)), JSON.stringify(d));
  assert.ok(out.warnings.some((w) => /^Downstream \(quotas\)/.test(w)), JSON.stringify(out.warnings));
  assert.deepEqual(out.def.quotas, before.quotas, "nothing downstream is changed by the change itself");
  assert.deepEqual(downstreamOf(before, before), []);
});

test("a method or sample-size change names the analysis plan, the fieldwork plan and the quota totals", () => {
  const before = base();
  const after = applySurveyActions(before, [{ op: "set_research", methodology: "Conjoint study", sampleSize: 800 } as never]).def;
  const d = downstreamOf(before, after);
  assert.ok(d.some((x) => x.area === "analysis"));
  assert.ok(d.some((x) => x.area === "quotas" && /800/.test(x.what)));
});

test("launch readiness: blockers and warnings, each with its fix", () => {
  const d = base();
  d.deployment.access = { ...d.deployment.access, mode: "password" };
  const r = launchReadiness(d, { now: Date.parse("2026-11-06T00:00:00Z") });
  assert.equal(r.ready, false);
  assert.ok(r.checks.some((c) => c.id === "password" && !c.ok && c.level === "blocker"));
  assert.ok(r.checks.some((c) => c.id === "tested" && !c.ok && c.fix === "Run a production-like test"));
  d.deployment.access.password = "secret1";
  const ok = launchReadiness(d, { tested: true, now: Date.parse("2026-11-06T00:00:00Z") });
  assert.equal(ok.blockers, 0, JSON.stringify(ok.checks.filter((c) => !c.ok)));
});

test("the master prompt's healthcare sentence → a reviewable launch plan", () => {
  const empty = SurveyDefinition.parse({ meta: { id: "e", code: "E", title: "New" }, questions: [], flow: [] });
  const b = readResearchBrief("I am conducting healthcare research among doctors in India. I need 1,000 completed responses, with age, specialty, and geographic quotas. I want a production-like test before launching the survey.");
  const plan = launchPlan(empty, b, Date.parse("2026-11-06T00:00:00Z"));
  assert.equal(plan.length, 7);
  assert.match(plan[1], /unique links/);
  assert.match(plan[2], /age, region, specialty over 1,000 completes/);
  assert.match(plan[3], /1,000 completes/); assert.match(plan[3], /professional audience/);
  assert.match(plan[4], /as the brief asks/);
});

test("'I changed the target audience to Gen Z; what else needs to change?'", async () => {
  const { interpretRequest } = await import("./nlIntent.js");
  const out = interpretRequest(base(), "I changed the target audience to Gen Z; what else needs to change?") as unknown as { kind: string; understood: string };
  assert.equal(out.kind, "actions", JSON.stringify(out).slice(0, 300));
  assert.match(out.understood, /quotas: the audience changed/);
});
