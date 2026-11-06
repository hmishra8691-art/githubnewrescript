import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";
import { applySurveyActions } from "./surveyActions.js";
import { fieldworkPlan } from "./fieldworkPlan.js";
import { readResearchBrief } from "./researchBrief.js";

/* IM5 — the fieldwork plan from a brief */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Doctors" },
  questions: Array.from({ length: 40 }, (_, i) => ({ id: `q${i + 1}`, code: `Q${i + 1}`, variableName: `V${i + 1}`, type: "single_select", text: `Question ${i + 1}?`, options: opts("A", "B") })),
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "Main", questionIds: Array.from({ length: 40 }, (_, i) => `q${i + 1}`) }] }, { type: "end", id: "e", status: "complete" }],
  quotas: [{ id: "qa", name: "Specialty", cells: [{ id: "c1", label: "Cardiology", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, limit: 500 }, { id: "c2", label: "Oncology", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 2 }, limit: 20 }] }],
});
const NOW = Date.parse("2026-11-06T09:00:00Z");

test("the harness brief: 1,000 doctors in India, 15 minutes, three weeks", () => {
  const p = fieldworkPlan(def, { brief: readResearchBrief("Plan the fieldwork: 1,000 doctors in India, 15-minute survey, finish in three weeks"), now: NOW });
  assert.ok(!("error" in p));
  if ("error" in p) return;
  assert.equal(p.completes, 1000); assert.equal(p.fieldDays, 21); assert.equal(p.loiMinutes, 15);
  assert.equal(p.startDate, "2026-11-08"); assert.equal(p.endDate, "2026-11-28");
  assert.equal(p.softLaunch, 100); assert.equal(p.dailyTarget, Math.ceil(900 / 19));
  assert.deepEqual(p.markets, [{ market: "India", completes: 1000 }]);
  assert.ok(p.risks.some((r) => r.risk === "Small quota cells"), "the 20-complete Oncology cell");
  assert.ok(p.lines.some((l) => /not priced/.test(l)), "never a guessed cost");
  assert.equal(p.basis.fieldDays, "the brief");
});

test("per-market completes, incidence, CPI and budget", () => {
  const p = fieldworkPlan(def, { brief: readResearchBrief("Multi-country consumer study in Germany, France and Spain with 500 completes each, two weeks"), incidence: 20, cpi: 8, budget: 10000, currency: "EUR", now: NOW });
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.completes, 1500);
  assert.equal(p.markets.length, 3); assert.ok(p.markets.every((m) => m.completes === 500));
  assert.equal(p.invitations, 7500); assert.equal(p.cost, 12000);
  assert.ok(p.risks.some((r) => r.risk === "Over budget"));
});

test("no completes anywhere: asked, never invented", () => {
  const p = fieldworkPlan(def, { now: NOW });
  assert.ok("error" in p);
});

test("the sentences: a plan of record with a closing date, and an estimate answered", () => {
  const out = interpretRequest(def, "Plan the fieldwork: 1,000 doctors in India, 15-minute survey, finish in three weeks", { now: "2026-11-06T09:00:00Z" }) as unknown as { kind: string; actions: never[]; understood: string };
  assert.equal(out.kind, "actions", JSON.stringify(out).slice(0, 300));
  const a = applySurveyActions(def, out.actions);
  assert.ok(a.valid, JSON.stringify(a.errors));
  assert.equal(a.def.research?.fieldwork?.completes, 1000);
  assert.equal(a.def.research?.sampleSize, 1000);
  assert.match(a.def.deployment.activeUntil ?? "", /^2026-11-28/);
  const est = interpretRequest(a.def, "Estimate the cost and the daily completes we need", { now: "2026-11-06T09:00:00Z" }) as { kind: string; answer?: string };
  assert.equal(est.kind, "answer");
  assert.match(est.answer ?? "", /completes a day/);
});

test("the questions-a-minute rate is the one relevance.ts uses", async () => {
  const { QUESTIONS_PER_MINUTE } = await import("./relevance.js");
  const p = fieldworkPlan(def, { completes: 100, now: NOW });
  if ("error" in p) throw new Error(p.error);
  assert.equal(p.loiMinutes, Math.round(40 / QUESTIONS_PER_MINUTE));
});
