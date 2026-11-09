import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildMasterDemoSurvey, buildNpsSurvey, runSimulation, simulationRows, journeyLines, invalidProbes } from "./index.js";
import { rule } from "./builders.js";

const small = () => SurveyDefinition.parse({
  meta: { id: "sim", code: "SIM", title: "Sim" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Do you own a car?", required: true, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Which brand?", required: true, displayLogic: rule("q1", "eq", 1), options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }], randomization: { enabled: true }, settings: { recordOrder: true } },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Age", required: true, validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }, { type: "end", id: "e", status: "complete" }],
});

test("a run walks the real survey: journeys show what was shown, hidden by logic and not reached; expectations are checked against what happened", () => {
  const r = runSimulation(small(), { count: 60, seed: 3, expectations: [
    { id: "x1", question: "q2", expect: "shown", when: rule("q1", "eq", 1) as never },
    { id: "x2", question: "q2", expect: "hidden", when: rule("q1", "eq", 2) as never },
    { id: "x3", question: "q2", expect: "shown" },
  ] }, { runId: "TEST1" });
  assert.equal(r.produced, 60);
  assert.equal(r.journeys[0].code, "SIM-TEST1-0001");
  const no = r.journeys.find((j) => j.answers.q1 === 2)!, yes = r.journeys.find((j) => j.answers.q1 === 1)!;
  assert.ok(no && yes, "both paths taken");
  assert.deepEqual(no.pages[0].hiddenByLogic, ["q2"], "Q2 hidden by its display logic for a 'No'");
  assert.ok(yes.pages[0].shown.includes("q2"));
  const [x1, x2, x3] = r.expectations;
  assert.equal(x1.broken, 0); assert.ok(x1.applicable > 0);
  assert.equal(x2.broken, 0); assert.ok(x2.applicable > 0);
  assert.ok(x3.broken > 0 && x3.examples.length > 0, "an expectation that is wrong for 'No' respondents is reported with examples");
  assert.ok(r.verdict.problems.some((p) => /expectation broken/.test(p)));
  assert.ok(journeyLines(small(), no).some((l) => /hidden by logic Q2/.test(l)));
});

test("profiles and distributions steer who answers what; the invalid-answer probes check the survey's own validation", () => {
  const r = runSimulation(small(), { count: 80, seed: 9, distributions: { q1: { "1": 3, "2": 1 } }, profiles: [{ name: "Seniors", share: 1, answers: { q3: 70 } }] });
  const yes = r.journeys.filter((j) => j.answers.q1 === 1).length;
  assert.ok(yes / r.produced > 0.6 && yes / r.produced < 0.9, `about three in four say yes (${yes}/${r.produced})`);
  assert.ok(r.journeys.every((j) => j.profile === "Seniors" && j.answers.q3 === 70));
  const probes = invalidProbes(small());
  assert.ok(probes.some((p) => /below the minimum/.test(p.probe) && p.rejected));
  assert.ok(probes.some((p) => /above the maximum/.test(p.probe) && p.rejected));
  assert.ok(probes.some((p) => /required/.test(p.probe) && p.rejected));
});

test("randomization balance is measured from the orders respondents actually saw", () => {
  const r = runSimulation(small(), { count: 120, seed: 4, distributions: { q1: { "1": 1 } } });
  const ord = r.randomization.find((x) => /Q2_ORDER/.test(x.variable));
  assert.ok(ord, JSON.stringify(r.randomization.map((x) => x.variable)));
  assert.equal(ord!.items.length, 3);
  assert.ok(ord!.balanced, JSON.stringify(ord));
});

test("rows are TEST data: SIM codes, the run on every row, a real status — and the real templates simulate end to end", () => {
  const r = runSimulation(buildNpsSurvey("n"), { count: 40, seed: 2 }, { runId: "R2" });
  const rows = simulationRows(r, { startedAt: Date.UTC(2026, 10, 9) });
  assert.equal(rows.length, r.produced);
  assert.ok(rows.every((x) => /^SIM-R2-\d{4}$/.test(x.respondentCode) && x.embedded.SIMULATED_RUN === "R2"));
  assert.ok(rows.every((x) => ["complete", "screened", "quota_full", "terminated"].includes(x.status)));
  const demo = runSimulation(buildMasterDemoSurvey("m"), { count: 50, seed: 5 });
  assert.ok(demo.produced >= 40);
  assert.ok(demo.coverage.questions.exercised / demo.coverage.questions.total > 0.6, JSON.stringify(demo.coverage.questions));
});
