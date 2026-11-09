import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { runSimulation } from "@rescript/templates";
import { parseDistributions, parseExpectations, parseProfiles, simulationAnswer, simulationRequest } from "./simulationRequest.ts";

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", required: true, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Brand?", required: true, displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
  ],
  flow: [{ type: "block", id: "b_usage", title: "Usage", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }] }, { type: "end", id: "e", status: "complete" }],
});

test("Intelligent Mode reads a simulation request — count, edge cases, terminations, a named block — and leaves other sentences alone", () => {
  const r = simulationRequest("Generate 200 test responses and thoroughly test the questionnaire, including edge cases, quotas and terminations in the usage block", def)!;
  assert.equal(r.config.count, 200); assert.equal(r.config.edgeRate, 0.5); assert.equal(r.config.completeShare, 0.6);
  assert.deepEqual(r.config.focus, ["b_usage"]);
  assert.equal(simulationRequest("create fifty dummy respondents", def)!.config.count, 50);
  for (const s of ["Generate a survey about cars", "Run a production-like test", "delete the test responses", "Add a question about test drives"]) assert.equal(simulationRequest(s, def), null, s);
});

test("the Manual form's fields become profiles, distributions and expectations — with clear errors", () => {
  const p = parseProfiles(def, "Drivers, 60%, Q1=1\nOthers, 40%, Q1=2");
  assert.deepEqual(p.errors, []); assert.equal(p.profiles[0].share, 0.6); assert.deepEqual(p.profiles[0].answers, { q1: 1 });
  assert.match(parseProfiles(def, "nonsense line").errors[0], /Name, 30%/);
  const d = parseDistributions(def, "Q1: 1=70, 2=30");
  assert.deepEqual(d.distributions, { q1: { "1": 70, "2": 30 } });
  assert.match(parseDistributions(def, "Q1: 9=10").errors[0], /not one of its option codes/);
  const e = parseExpectations(def, "Q2 shown when Q1 = 1\nQ2 hidden when Q1 != 1");
  assert.deepEqual(e.errors, []);
  assert.equal((e.expectations[1].when as { operator: string }).operator, "ne");
  const run = runSimulation(def, { count: 40, seed: 1, expectations: e.expectations });
  assert.ok(run.expectations.every((x) => x.broken === 0 && x.applicable > 0), JSON.stringify(run.expectations));
  const a = simulationAnswer(def, run);
  assert.match(a.answer, /40 simulated test respondents/);
  assert.ok(a.sections.some((s) => s.title === "Validation probes"));
});
