import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, readQuotaFills } from "./nlIntent.js";

/* IM3 — a production-like test, read from a sentence */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Doctors" },
  questions: [
    { id: "q1", code: "Q1", variableName: "SPEC", type: "single_select", text: "Specialty?", options: opts("Cardiology", "Oncology", "General practice") },
    { id: "q2", code: "Q2", variableName: "AGEG", type: "single_select", text: "Age?", options: opts("18-34", "35-54", "55+") },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2"] }] }, { type: "end", id: "e", status: "complete" }],
  quotas: [
    { id: "qs", name: "Specialty", cells: [{ id: "c1", label: "Cardiology", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, limit: 300 }, { id: "c2", label: "Oncology", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 2 }, limit: 300 }] },
    { id: "qa", name: "Age", cells: [{ id: "a1", label: "18-34", when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "eq", value: 1 }, limit: 200 }] },
  ],
});

test("the sentences that ask for it", () => {
  for (const s of ["Run a production-like test", "Test the survey as if it were live", "Simulate 500 respondents", "Run a production test with 300 respondents and the Cardiology cell full", "What happens when Oncology is full?", "Do a pre-launch test", "Show me the paths through the survey", "Who goes where?", "Which pages does nobody reach?"]) {
    const out = interpretRequest(def, s);
    assert.equal(out.kind, "test", `${s}: ${JSON.stringify(out).slice(0, 200)}`);
    assert.match((out as { understood: string }).understood, /Nothing is written/);
  }
});

test("counts and fills are read against the survey's quotas", () => {
  const out = interpretRequest(def, "Run a production test with 300 respondents and the Cardiology cell full") as { request: { count?: number; fill?: { quota: string; cell?: string; share: number }[] } };
  assert.equal(out.request.count, 300);
  assert.deepEqual(out.request.fill, [{ quota: "Specialty", cell: "Cardiology", share: 1 }]);
  assert.deepEqual(readQuotaFills(def, "with 18–34 at 90% and Oncology full"), [{ quota: "Specialty", cell: "Oncology", share: 1 }, { quota: "Age", cell: "18-34", share: 0.9 }]);
});

test("ordinary testing words are not a production test", () => {
  for (const s of ["Add a test question", "Test Q1 for errors", "Show Q2 only if Q1 is Cardiology"]) assert.notEqual(interpretRequest(def, s).kind, "test", s);
});

test("a person asking to take it under live conditions", () => {
  assert.equal(interpretRequest(def, "Let me test the survey exactly as a live respondent will see it, with the live quotas").kind, "test");
});

test("the counters a production-like test link starts from", async () => {
  const { simulatedQuotaCounts } = await import("./quotas.js");
  const base = { qs: { c1: 12 } };
  const out = simulatedQuotaCounts(def, base, ["Oncology", "a1"]);
  assert.deepEqual(out, { qs: { c1: 12, c2: 300 }, qa: { a1: 200 } });
  assert.deepEqual(base, { qs: { c1: 12 } }, "the base is never mutated");
  assert.deepEqual(simulatedQuotaCounts(def, base, [""]), base);
});
