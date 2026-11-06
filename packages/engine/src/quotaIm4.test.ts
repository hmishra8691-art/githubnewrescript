import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";
import { applySurveyActions } from "./surveyActions.js";

/* IM4 — quota sentences read without a model */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Study" },
  research: { objective: "x", sampleSize: 1000, hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] },
  questions: [
    { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Prefer not to say") },
    { id: "q2", code: "Q2", variableName: "AGEGRP", type: "single_select", text: "Which age group are you in?", options: opts("18-34", "35-54", "55+") },
    { id: "q3", code: "Q3", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South", "East", "West") },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2", "q3"] }] }, { type: "end", id: "e", status: "complete" }],
});
const run = (d: SurveyDefinition, s: string) => {
  const out = interpretRequest(d, s) as unknown as { kind: string; actions: never[]; understood: string };
  assert.equal(out.kind, "actions", `${s}: ${JSON.stringify(out).slice(0, 400)}`);
  const a = applySurveyActions(d, out.actions);
  assert.ok(a.valid && a.results.every((x) => x.ok), JSON.stringify(a.results.filter((x) => !x.ok)));
  return { def: a.def, understood: out.understood };
};

test("500 completes split 50/50 by gender: two cells, the non-substantive option said to be in none", () => {
  const { def: d, understood } = run(def, "Set a quota of 500 completes split 50/50 by gender");
  const q = d.quotas[0];
  assert.deepEqual(q.cells.map((c) => [c.label, c.limit]), [["Male", 250], ["Female", 250]]);
  assert.match(understood, /Prefer not to say/);
});

test("shares in other words", () => {
  assert.deepEqual(run(def, "1,000 completes, 60/40 by gender").def.quotas[0].cells.map((c) => c.limit), [600, 400]);
  assert.deepEqual(run(def, "Split 1000 completes equally by region").def.quotas[0].cells.map((c) => c.limit), [250, 250, 250, 250]);
  assert.equal(interpretRequest(def, "500 completes 70/40 by gender").kind, "refused");
});

test("interlocking quotas for age group and region with 1,000 completes", () => {
  const { def: d } = run(def, "Create interlocking quotas for age group and region with 1,000 completes");
  assert.equal(d.quotas.length, 1);
  assert.equal(d.quotas[0].cells.length, 12);
  assert.equal(d.quotas[0].cells.reduce((s, c) => s + c.limit, 0), 1000);
  /* the research design's sample size when the sentence gives none */
  assert.equal(run(def, "Create separate quotas for gender and region").def.quotas.length, 2);
});

test("soft / hard, what happens when full, a cell's limit, delete", () => {
  let d = run(def, "Create interlocking quotas for age group and region with 1,000 completes").def;
  d = run(d, "Set a quota of 500 completes split 50/50 by gender").def;
  const before = d.quotas.length;
  d = run(d, "Make the age quota soft").def;
  const age = d.quotas.find((q) => q.cells.some((c) => /18-34/.test(c.label)))!;
  assert.equal(age.mode, "soft");
  assert.equal((interpretRequest(d, "Stop when the gender quota is full") as { noop?: boolean }).noop, true, "a new quota is hard and ends the survey already");
  d = run(d, "Make the gender quota soft").def;
  d = run(d, "Stop when the gender quota is full").def;
  assert.equal(d.quotas.find((q) => q.name === "Gender quota")!.mode, "hard");
  d = run(d, "Set the Male cell to 300").def;
  assert.equal(d.quotas.find((q) => q.cells.some((c) => c.label === "Male"))!.cells.find((c) => c.label === "Male")!.limit, 300);
  d = run(d, "Delete the gender quota").def;
  assert.equal(d.quotas.length, before - 1);
});

test("the harness's two-clause sentence", () => {
  let d = run(def, "Create interlocking quotas for age group and region with 1,000 completes").def;
  d = run(d, "Set a quota of 500 completes split 50/50 by gender").def;
  run(d, "Make the age quota soft and stop when the gender quota is full");
});

test("is there enough sample: shares given, shares missing, the arithmetic shown", async () => {
  const { sampleAvailability } = await import("./sampleAvailability.js");
  const d = run(def, "Set a quota of 500 completes split 30/70 by gender").def;
  const rep = sampleAvailability(d, { available: 4000, incidence: 25, shares: { Female: 35, Male: 65 } });
  const f = rep.cells.find((c) => c.cell === "Female")!;
  assert.equal(f.need, 350); assert.equal(Math.round(f.supply!), 350); assert.equal(f.status, "tight");
  const m = rep.cells.find((c) => c.cell === "Male")!;
  assert.equal(m.status, "ok");
  const short = sampleAvailability(d, { available: 2000, incidence: 25, shares: { Female: 35 } });
  assert.equal(short.cells.find((c) => c.cell === "Female")!.status, "short");
  assert.equal(short.cells.find((c) => c.cell === "Male")!.status, "unknown", "never assumed equal");
  assert.ok(short.lines.some((l) => /not checked/.test(l)));
});

test("the sentence", () => {
  const d = run(def, "Set a quota of 500 completes split 30/70 by gender").def;
  const out = interpretRequest(d, "Is there enough sample for the quotas? We have 2,000 panelists at 25% incidence and women are 35%") as unknown as { kind: string; answer: string };
  assert.equal(out.kind, "answer", JSON.stringify(out).slice(0, 300));
  assert.match(out.answer, /✗ Gender quota \/ Female/);
  assert.equal(interpretRequest(d, "Do we have enough sample to fill the quotas?").kind, "clarify");
});
