import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { checkPlan, planCatalogue, planFromActions, planFromCalculation, planFromModel, settleQuestions } from "./agentPlan.js";
import { repairBrief, routeModel, runAgentLoop, type LoopObservation, type Planner, type Verifier } from "./agentLoop.js";
import type { SurveyAction } from "./surveyActions.js";

const survey = () => SurveyDefinition.parse({
  meta: { id: "loop", code: "LOOP", title: "Loop", version: "1.0" },
  questions: [
    { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }] },
    { id: "brand", code: "Q1", variableName: "Q1", type: "single_select", text: "Which brand?", options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }] },
    { id: "sat", code: "Q2", variableName: "Q2", type: "single_select", text: "How satisfied are you?", options: [1, 2, 3, 4, 5].map((c) => ({ code: String(c), label: `Point ${c}` })) },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["own"] }, { type: "page", id: "p2", questionIds: ["brand", "sat"] }, { type: "end", id: "e", status: "complete" }],
});
const step = (tool: string, input: Record<string, unknown>, why = "The brief asks for it, so respondents are not lost here.") => ({ tool, input, why });
/* a verifier that sees one thing: Q1 shown only to non-owners (the planted defect) */
const verifier: Verifier = (def) => {
  const q1 = def.questions.find((q) => q.code === "Q1") as { displayLogic?: { value?: unknown } } | undefined;
  return q1?.displayLogic?.value === "n" ? [{ id: "never_shown:brand", kind: "never_shown", severity: "problem", message: "Q1 is shown only to people who do not own a car.", where: { codes: ["Q1"] }, condition: { text: "S1 is “No”", reads: ["S1"] }, respondents: [{ code: "SIM-1", endStatus: "complete", answers: { S1: "y" } }], look: "Owners should see Q1." }] : [];
};

test("plans from the rule reader and from a calculation have the one shape", () => {
  const p = planFromActions("Make Q1 required and delete Q2", [{ op: "update_question", target: "Q1", required: true }, { op: "delete_question", target: "Q2" }] as unknown as SurveyAction[]);
  assert.deepEqual(p.steps.map((s) => [s.id, s.tool, s.dependsOn]), [["s1", "survey.update_question", []], ["s2", "survey.delete_question", ["s1"]]]);
  assert.deepEqual(p.steps[0]!.input, { target: "Q1", required: true });
  assert.ok(p.steps.every((s) => /You asked/.test(s.why)));
  const c = checkPlan(survey(), p);
  assert.ok(c.ok && c.changed);
  assert.equal(c.approval, "explicit", "a deletion raises the whole plan to explicit approval");
  assert.ok(c.destroys.length >= 1 && c.after.questions.length === 2 && survey().questions.length === 3);
  const calc = checkPlan(survey(), planFromCalculation("How many completes for ±5%?", "design.sample_size_margin", { margin: 5 }));
  assert.deepEqual([calc.ok, calc.changed, calc.approval, (calc.steps[0]!.value as { completes: number }).completes], [true, false, "none", 385]);
});

test("a model's plan is read against the registry: unknown tools, missing reasons and bad dependencies refuse the whole plan", () => {
  const ok = planFromModel({ goal: "Tidy", steps: [{ id: "a", ...step("survey.update_question", { target: "Q1", required: true }) }], assumptions: [{ text: "Owners only", because: "The brief says car owners." }], questions: [{ ask: "How many completes?", changes: ["sample"] }] });
  assert.ok(ok.plan && ok.plan.source === "model" && ok.plan.steps[0]!.id === "a" && ok.plan.assumptions.length === 1 && ok.plan.questions.length === 1);
  assert.match(planFromModel({ steps: [step("survey.update_questions", {})] }).problems[0]!, /no tool called “survey.update_questions”.*Did you mean survey.update_question/);
  assert.match(planFromModel({ steps: [{ tool: "survey.update_question", input: { target: "Q1" }, why: "" }] }).problems[0]!, /gives no reason/);
  assert.match(planFromModel({ steps: [{ id: "a", dependsOn: ["z"], ...step("survey.update_question", { target: "Q1" }) }] }).problems[0]!, /depends on “z”/);
  assert.match(planFromModel({ steps: [{ ...step("survey.update_question", { op: "delete_question", target: "Q1" }) }] }).problems[0]!, /must not carry “op”/);
  assert.match(planFromModel("{ not json").problems[0]!, /not valid JSON/);
  assert.match(planFromModel({ steps: [], questions: [] }).problems[0]!, /nothing to do/);
  assert.equal(planFromModel({ steps: [step("survey.update_question", { target: "Q1" })], assumptions: [{ text: "x" }] }).plan, null, "an assumption with no reason is refused too");
  /* a model cannot declare its own step safe: risk and approval are not read from the plan */
  const sneaky = planFromModel({ steps: [{ ...step("survey.delete_question", { target: "Q2" }), risk: "read", approval: "none" }] });
  assert.equal(checkPlan(survey(), sneaky.plan!).approval, "explicit");
});

test("checking a plan: a refused step is reported, what depends on it is skipped, the rest still runs on the copy", () => {
  const { plan } = planFromModel({ steps: [
    { id: "a", ...step("survey.update_question", { target: "Q99", required: true }) },
    { id: "b", dependsOn: ["a"], ...step("survey.update_question", { target: "Q1", required: true }) },
    { id: "c", ...step("survey.update_question", { target: "Q2", required: true }) },
    { id: "d", ...step("design.precision", { completes: 400 }) },
    { id: "e", ...step("deployment.deploy_version", { version: 3 }) },
  ] });
  const c = checkPlan(survey(), plan!);
  assert.deepEqual(c.steps.map((s) => s.outcome), ["refused", "skipped", "ok", "ok", "route"]);
  assert.deepEqual([c.ok, c.refused, c.approval], [false, 2, "explicit"]);
  assert.equal((c.after.questions.find((q) => q.code === "Q2") as { required: boolean }).required, true);
  assert.equal((c.after.questions.find((q) => q.code === "Q1") as { required: boolean }).required, false);
  assert.match(c.steps[4]!.does[0]!, /POST \/api\//);
});

test("the clarification policy: ask what changes the design and has no default; assume the rest; drop what changes nothing", () => {
  const s = settleQuestions([
    { ask: "What colour should the logo be?", changes: [] },
    { ask: "Which markets?", changes: ["audience", "language"] },
    { ask: "How many completes?", changes: ["sample"], default: { value: "400 completes", because: "±4.9 points at 95% confidence is enough for a first read." } },
    { ask: "Conjoint or MaxDiff?", changes: ["method"] },
    { ask: "Any quotas?", changes: ["quotas"] },
    { ask: "which markets", changes: ["audience"] },
  ]);
  assert.deepEqual(s.ask.map((q) => q.ask), ["Conjoint or MaxDiff?", "Which markets?"], "the two that move the design most");
  assert.deepEqual(s.held.map((q) => q.ask), ["Any quotas?"], "held as open, not assumed: it has no default");
  assert.deepEqual(s.assumptions.map((a) => [a.text, a.insteadOf]), [["400 completes", "How many completes?"]]);
  assert.match(s.assumptions[0]!.overturn!, /How many completes\?/);
  assert.deepEqual(s.dropped, ["What colour should the logo be?"]);
  assert.equal(settleQuestions([{ ask: "A?", changes: ["method"] }, { ask: "B?", changes: ["sample"] }, { ask: "C?", changes: ["length"] }], { maxAsk: 1 }).ask.length, 1);
});

test("model routing: small for one right shape, large for judgement, one escalation, no retry after the large one fails", () => {
  assert.equal(routeModel("classify").tier, "small");
  assert.equal(routeModel("edit").tier, "small");
  assert.equal(routeModel("plan").tier, "large");
  assert.equal(routeModel("generate").tier, "large");
  assert.deepEqual([routeModel("edit", { failedOn: "small" }).tier, routeModel("edit", { failedOn: "small" }).retry], ["large", true]);
  assert.equal(routeModel("plan", { failedOn: "large" }).retry, false);
  assert.equal(routeModel("repair", { steps: 2, attempt: 1 }).tier, "small");
  assert.equal(routeModel("repair", { steps: 20, attempt: 1 }).tier, "large");
  assert.equal(routeModel("repair", { steps: 2, attempt: 2 }).tier, "large");
});

test("the loop: a plan that verifies first time is proposed, not saved", async () => {
  const def = survey();
  const r = await runAgentLoop({ goal: "Make Q1 required", def, verifier, planner: () => ({ plan: { steps: [step("survey.update_question", { target: "Q1", required: true })] }, usage: { tier: "large", cost: 0.01 } }) });
  assert.deepEqual([r.stop, r.verified, r.attempts.length, r.approval, r.spent], ["verified", true, 1, "confirm", 0.01]);
  assert.equal((r.after!.questions[1] as { required: boolean }).required, true);
  assert.equal((def.questions[1] as { required: boolean }).required, false, "the survey given in is untouched");
});

test("the loop: a defect is seen, handed back with its condition and respondents, and repaired", async () => {
  const seen: (LoopObservation[] | undefined)[] = [];
  const planner: Planner = (t) => {
    seen.push(t.previous?.observations);
    return t.attempt === 1
      ? { plan: { steps: [step("survey.set_display_logic", { target: "Q1", expression: "S1 = No" })] }, usage: { tier: t.tier, cost: 0.02 } }
      : { plan: { steps: [step("survey.set_display_logic", { target: "Q1", expression: "S1 = Yes" }, "Verification saw owners were not shown Q1; the condition was the wrong way round.")] }, usage: { tier: t.tier, cost: 0.005 } };
  };
  const r = await runAgentLoop({ goal: "Show the brand question to car owners", def: survey(), verifier, planner });
  assert.deepEqual([r.stop, r.verified, r.attempts.length], ["verified", true, 2]);
  assert.match(r.because, /after 1 repair/);
  assert.equal(seen[0], undefined);
  assert.equal(seen[1]![0]!.kind, "never_shown");
  assert.deepEqual(seen[1]![0]!.respondents![0]!.answers, { S1: "y" });
  assert.deepEqual(r.attempts.map((a) => a.tier), ["large", "small"], "the repair of a one-step plan is routed to the small model");
  assert.equal(r.spent, 0.025);
  assert.equal(r.remaining.length, 0);
  assert.match(repairBrief({ plan: r.attempts[0]!.plan!, observations: r.attempts[0]!.observations }), /simulated respondent SIM-1 ended complete: S1="y"/);
});

test("the loop stops: no progress, the cost ceiling, a refused step, an unreadable plan", async () => {
  const bad = () => ({ plan: { steps: [step("survey.set_display_logic", { target: "Q1", expression: "S1 = No" })] }, usage: { tier: "large" as const, cost: 0.1 } });
  const stuck = await runAgentLoop({ goal: "x", def: survey(), verifier, planner: bad });
  assert.deepEqual([stuck.stop, stuck.verified, stuck.attempts.length], ["no_progress", false, 3]);
  assert.equal(stuck.remaining.length, 1, "what is still seen is reported with the best attempt");
  assert.ok(stuck.plan && stuck.after);
  const cost = await runAgentLoop({ goal: "x", def: survey(), verifier, planner: bad, limits: { costCeiling: 0.15 } });
  assert.deepEqual([cost.stop, cost.attempts.length, cost.spent], ["cost", 2, 0.2]);
  /* the engine's refusal is an observation the planner gets back */
  let got = "";
  const refused = await runAgentLoop({ goal: "x", def: survey(), verifier, planner: (t) => { got = t.previous?.observations[0]?.message ?? got; return { plan: { steps: [step("survey.update_question", { target: t.attempt === 1 ? "Q99" : "Q1", required: true })] } }; } });
  assert.deepEqual([refused.stop, refused.attempts.length], ["verified", 2]);
  assert.match(got, /Step s1 \(survey.update_question\) was refused/);
  const unreadable = await runAgentLoop({ goal: "x", def: survey(), verifier, planner: () => ({ plan: { steps: [step("survey.nope", {})] } }) });
  assert.deepEqual([unreadable.stop, unreadable.plan, unreadable.attempts.length], ["planner_failed", null, 2]);
  const thrown = await runAgentLoop({ goal: "x", def: survey(), verifier, planner: () => { throw new Error("provider down"); } });
  assert.deepEqual([thrown.stop, thrown.after], ["planner_failed", null]);
  assert.match(thrown.because, /provider down/);
});

test("the loop asks before it builds: a question that changes the design stops it; an answered one does not", async () => {
  const planner: Planner = (t) => ({ plan: { steps: [step("survey.update_question", { target: "Q1", required: true })], questions: [{ ask: "Conjoint or MaxDiff?", changes: ["method"] }, { ask: "How many completes?", changes: ["sample"], default: { value: "400 completes", because: "enough for a first read" } }], assumptions: [] }, usage: { tier: t.tier, cost: 0.01 } });
  const asked = await runAgentLoop({ goal: "x", def: survey(), verifier, planner });
  assert.deepEqual([asked.stop, asked.ask.map((q) => q.ask), asked.stepsRun], ["needs_answers", ["Conjoint or MaxDiff?"], 0]);
  assert.equal(asked.assumptions[0]!.text, "400 completes");
  assert.match(asked.because, /Nothing was built on a guess/);
  const answered = await runAgentLoop({ goal: "x", def: survey(), verifier, planner, answers: { "Conjoint or MaxDiff?": "MaxDiff" } });
  assert.deepEqual([answered.stop, answered.ask.length], ["verified", 1]);
});

test("the catalogue a planning model reads names every tool with its risk", () => {
  const c = planCatalogue();
  for (const t of ["survey.update_question [draft, needs confirm approval]", "survey.delete_question [destructive_draft, needs explicit approval]", "design.sample_size_margin [read] ", "deployment.deploy_version [publish, needs explicit approval]"]) assert.ok(c.includes(t), t);
  assert.match(planCatalogue({ engines: ["design"] }), /margin\*/);
  assert.ok(!planCatalogue({ engines: ["design"] }).includes("survey.update_question"));
});
