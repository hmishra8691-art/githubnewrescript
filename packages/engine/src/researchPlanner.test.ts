import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { researchWorkflow, describeWorkflow, modelSteps, populationFromObjective, questionsMeasuring, constructName, type WorkflowStep, type WorkflowStepId } from "./researchPlanner.js";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { interpretRequest } from "./nlIntent.js";

/*
 * RESEARCH ENGINE AUDIT, PHASE 6 — the research agent's planner. From one
 * objective the workflow runs: each step is done, ready (the engine's own
 * actions, for approval), the researcher's to answer, or the model's — and
 * a model step in internal mode becomes the engine's alternative or a
 * question, never a silent skip. The planner never writes and never calls.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const OBJECTIVE = "Understand why UK adults who bought a car switch from Brand A to Brand B";
function survey(research?: Record<string, unknown>): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    ...(research ? { research: { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [], ...research } } : {}),
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands in the last 12 months?", options: opts("Yes", "No") },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value for money", options: opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your current brand?", options: opts("1", "2", "3", "4", "5", "6", "7") },
      { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South", "East") },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
      { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q4", "q6", "q9", "q7"] }] },
      { type: "block", id: "b3", title: "About you", children: [{ type: "page", id: "p3", title: "About you", questionIds: [] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}
const stepOf = (def: SurveyDefinition, id: WorkflowStepId, o: Parameters<typeof researchWorkflow>[1] = {}): WorkflowStep => researchWorkflow(def, o).steps.find((s) => s.id === id)!;
const apply = (def: SurveyDefinition, actions: SurveyAction[] | undefined): SurveyDefinition => { assert.ok(actions?.length, "actions"); const out = applySurveyActions(def, actions!); assert.ok(out.valid && out.results.every((x) => x.ok), JSON.stringify(out.errors ?? out.results.filter((x) => !x.ok))); return out.def; };
const statuses = (def: SurveyDefinition, o: Parameters<typeof researchWorkflow>[1] = {}) => Object.fromEntries(researchWorkflow(def, o).steps.map((s) => [s.id, s.status]));

test("the workflow from one objective: every step done, ready, asked or the model's; the engine's actions apply and advance the next step; the planner never writes", () => {
  let def = survey();
  const before = JSON.stringify(def);
  let wf = researchWorkflow(def, { objective: OBJECTIVE });
  assert.equal(JSON.stringify(def), before, "the planner writes nothing");
  assert.equal(wf.total, 12);
  assert.equal(wf.done, 0);
  assert.equal(wf.next?.id, "objective");
  assert.equal(wf.next?.status, "ready");
  assert.deepEqual(wf.next?.actions, [{ op: "set_research", objective: OBJECTIVE }]);
  assert.equal(wf.next?.sentence, `Set the research objective to "${OBJECTIVE}"`);
  assert.match(wf.summary, /^0 of 12 steps done — next: Objective \(the engine has 1 action ready\)$/);
  // downstream steps wait on it, with the step they wait on named
  assert.equal(stepOf(def, "assumptions").status, "blocked");
  assert.equal(stepOf(def, "assumptions").blockedBy, "objective");
  assert.equal(stepOf(def, "hypotheses").blockedBy, "objective");
  assert.equal(stepOf(def, "framework").blockedBy, "hypotheses");
  // without an objective in the sentence, the researcher is asked — with an example sentence that records it
  const asked = stepOf(def, "objective");
  assert.equal(asked.status, "needs_input");
  assert.equal(asked.executor, "researcher");
  assert.match(asked.questions![0].example, /^Set the research objective to "/);
  assert.equal(interpretRequest(def, asked.questions![0].example).kind, "actions", "the example is a sentence the engine reads");

  // 1. objective
  def = apply(def, wf.next!.actions);
  assert.equal(stepOf(def, "objective").status, "done");
  // 2. assumptions: the population read from the objective is recorded as an assumption; methodology and sample size are the researcher's
  let s = stepOf(def, "assumptions");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions, [{ op: "set_research", population: "UK adults who bought a car", assumptions: ["Population read from the objective: UK adults who bought a car"] }]);
  assert.deepEqual(s.questions!.map((q) => q.ask), ["Which methodology — an online panel survey, a tracker, a concept test?", "How many completes are planned?"]);
  assert.match(s.why, /the population "UK adults who bought a car" read from the objective, as assumptions to confirm; it still needs which methodology and how many completes are planned/);
  def = apply(def, s.actions);
  s = stepOf(def, "assumptions");
  assert.equal(s.status, "needs_input");
  assert.equal(s.actions, undefined);
  def = apply(def, [{ op: "set_research", methodology: "Online panel survey", sampleSize: 400 }]);
  s = stepOf(def, "assumptions");
  assert.equal(s.status, "done");
  assert.match(s.why, /1 assumption listed/);

  // 3. hypotheses: none recorded → the model drafts (large tier), the researcher may state them; the workflow's next is this step
  s = stepOf(def, "hypotheses");
  assert.equal(s.status, "model");
  assert.equal(s.executor, "model");
  assert.equal(s.tier, "large");
  assert.equal(s.model?.operation, "workflow_hypotheses");
  assert.match(s.model!.estimateText, /OBJECTIVE: Understand why UK adults/);
  assert.equal(researchWorkflow(def).next?.id, "hypotheses");
  assert.match(researchWorkflow(def).summary, /next: Structured hypotheses \(the model is asked \(large call\)\)/);
  assert.deepEqual(modelSteps(researchWorkflow(def)).map((m) => [m.id, m.tier]), [["hypotheses", "large"]]);
  def = apply(def, [{ op: "add_hypothesis", text: "Price perception drives switching" }, { op: "add_hypothesis", text: "Women are more satisfied than men" }] as SurveyAction[]);
  // the readings parsed from the words are recorded by the engine
  s = stepOf(def, "hypotheses");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions, [
    { op: "set_hypothesis", hypothesis: "H1", detail: { type: "causal", direction: "positive", independent: "Price perception", dependent: "switching" } },
    { op: "set_hypothesis", hypothesis: "H2", detail: { type: "difference", direction: "positive", dependent: "satisfied", group: "women", lower: "men" } },
  ]);
  assert.match(s.why, /^H1 and H2 read from the words \(H1: causal, positive; H2: difference, positive\)/);
  def = apply(def, s.actions);
  s = stepOf(def, "hypotheses");
  assert.equal(s.status, "done");
  assert.match(s.why, /2 hypotheses recorded with their readings \(H1: causal, H2: difference\)/);

  // 4. framework: a construct per hypothesis side, named as a noun, each with the questions that already measure it
  s = stepOf(def, "framework");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions, [{ op: "set_research", constructs: [
    { name: "Price perception", role: "independent", questions: ["Q6"] },
    { name: "Switching", role: "dependent", questions: ["Q4"] },
    { name: "Gender", role: "independent", questions: ["Q2"] },
    { name: "Satisfaction", role: "dependent", questions: ["Q7"] },
  ] }]);
  assert.match(s.why, /4 constructs named by the hypotheses and not yet in the framework: Price perception \(independent, measured by Q6\), Switching \(dependent, measured by Q4\), Gender \(independent, measured by Q2\), Satisfaction \(dependent, measured by Q7\)/);
  assert.equal(s.sentence, 'Add the constructs "Price perception", "Switching", "Gender" and "Satisfaction" to the research framework');
  def = apply(def, s.actions);
  assert.equal(stepOf(def, "framework").status, "done");
  assert.equal(def.research!.constructs[3].questionIds[0], "q7");

  // 5–6. questionnaire: every construct measured; variables: nothing multi-item
  assert.equal(stepOf(def, "questionnaire").status, "done");
  s = stepOf(def, "variables");
  assert.equal(s.status, "done");
  assert.match(s.why, /No construct is measured by several scale items/);

  // 7. the plan: the engine's framework
  s = stepOf(def, "analysis_plan");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions, [{ op: "propose_analysis_plan" }]);
  assert.match(s.why, /proposes \d+ crosstabs?, \d+ tests? and \d+ derived variables? from the hypotheses and the questions' levels/);
  def = apply(def, s.actions);
  assert.equal(stepOf(def, "analysis_plan").status, "done");
  // 8. recommendations: the framework's plan covers both hypotheses
  s = stepOf(def, "recommendations");
  assert.equal(s.status, "done");
  assert.match(s.why, /^Every measured hypothesis has a test or a table\.$/);
  // 9. KPIs from the dependent constructs, the direction from the name; the audience optional
  s = stepOf(def, "reporting_framework");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions, [{ op: "set_research", kpis: [{ name: "Switching", variable: "SWITCHED", measure: "share", direction: "lower" }, { name: "Satisfaction", variable: "SAT", measure: "top-2-box share", direction: "higher" }] }]);
  assert.equal(s.questions?.length, 1);
  assert.match(s.questions![0].ask, /optional/);
  def = apply(def, s.actions);
  s = stepOf(def, "reporting_framework");
  assert.equal(s.status, "done");
  assert.match(s.why, /2 KPIs recorded \(Switching, Satisfaction\); no audience recorded \(optional\)/);
  // 10. the design document: an output, ready; done once produced, and told when to produce again
  s = stepOf(def, "design_document");
  assert.equal(s.status, "ready");
  assert.equal(s.executor, "output");
  assert.deepEqual(s.output, { type: "proposal_docx", audience: "client", words: "the research proposal (Word)" });
  assert.equal(s.sentence, "Create the client-ready research proposal");
  assert.equal(interpretRequest(def, s.sentence!).kind, "output");
  assert.equal(stepOf(def, "design_document", { produced: ["design_document"] }).status, "done");
  // 11. the structure: REGION asked mid-survey goes to the closing block
  s = stepOf(def, "survey_structure");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions, [{ op: "move_question", target: "Q9", block: "About you" }]);
  assert.equal(s.sentence, 'Move Q9 to "About you"');
  assert.match(s.why, /Q9 \(REGION\) is a demographic asked mid-survey/);
  def = apply(def, s.actions);
  s = stepOf(def, "survey_structure");
  assert.equal(s.status, "done");
  assert.match(s.why, /3 blocks: screening questions first, demographics last/);
  // 12. the deck waits for fieldwork; ready with data; done once produced
  s = stepOf(def, "deck");
  assert.equal(s.status, "blocked");
  assert.match(s.why, /After fieldwork/);
  s = stepOf(def, "deck", { runAvailable: true });
  assert.equal(s.status, "ready");
  assert.equal(s.output?.type, "findings_pptx");
  assert.equal(interpretRequest(def, s.sentence!).kind, "output");
  wf = researchWorkflow(def, { runAvailable: true, produced: ["design_document", "deck"] });
  assert.equal(wf.done, 12);
  assert.equal(wf.next, null);
  assert.equal(wf.summary, "All 12 steps done.");
  const lines = describeWorkflow(wf).split("\n");
  assert.equal(lines.length, 13);
  assert.ok(lines.slice(1).every((l) => l.startsWith("✓ ")), describeWorkflow(wf));
});

test("the questionnaire step: a standard item for a construct the library knows (the question and the construct's link in one approval); bespoke wording goes to the model, or to the researcher in internal mode", () => {
  let def = survey({ objective: "Measure purchase intent for Brand B", population: "UK adults", methodology: "Online panel survey", sampleSize: 300, hypotheses: ["Trust drives purchase intent"], hypothesisDetails: [{ type: "causal", direction: "positive", independent: "trust", dependent: "purchase intent" }], constructs: [{ name: "Trust", role: "independent", questionIds: [] }, { name: "Purchase intent", role: "dependent", questionIds: [] }, { name: "Brand love", role: "mediator", questionIds: [] }] });
  let s = stepOf(def, "questionnaire");
  assert.equal(s.status, "ready");
  assert.equal(s.executor, "engine");
  assert.match(s.why, /^Trust \(5-point agreement\) and Purchase intent \(5-point likelihood to purchase\) have a standard item the engine can add; Brand love needs bespoke wording\.$/);
  assert.equal(s.actions!.length, 3);
  const [t, p, link] = s.actions as unknown as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  assert.equal(t.op, "create_question"); assert.equal(t.ref, "TRUST"); assert.equal(t.text, "I trust Brand B"); assert.equal(t.required, true);
  assert.equal(p.op, "create_question"); assert.equal(p.ref, "PURCHASE_INTENT"); assert.match(String(p.text), /^How likely are you to purchase Brand B/);
  assert.deepEqual(link, { op: "set_research", constructs: [{ name: "Trust", role: "independent", questions: ["TRUST"] }, { name: "Purchase intent", role: "dependent", questions: ["PURCHASE_INTENT"] }, { name: "Brand love", role: "mediator", questions: [] }] });
  assert.equal(s.sentence, "Add the standard items for Trust and Purchase intent");
  assert.deepEqual(s.questions!.map((q) => q.ask), ['How should "Brand love" be asked?']);
  def = apply(def, s.actions);
  assert.equal(def.research!.constructs[0].questionIds.length, 1);
  assert.equal(def.questions.find((q) => q.id === def.research!.constructs[0].questionIds[0])!.text, "I trust Brand B");
  // what is left is the model's — a large call, with the prompt the cost preview prices; in internal mode the researcher is asked instead, and no model step is listed
  s = stepOf(def, "questionnaire");
  assert.equal(s.status, "model");
  assert.equal(s.tier, "large");
  assert.equal(s.sentence, "Write the questions that measure Brand love");
  assert.match(s.model!.estimateText, /CONSTRUCTS: Brand love \(mediator\)/);
  assert.equal(s.model!.maxTokens, 400);
  const internal = stepOf(def, "questionnaire", { mode: "internal" });
  assert.equal(internal.status, "needs_input");
  assert.equal(internal.executor, "researcher");
  assert.match(internal.why, /internal mode calls no model to write one/);
  assert.deepEqual(internal.questions!.map((q) => q.ask), ['How should "Brand love" be asked?']);
  assert.equal(researchWorkflow(def, { mode: "internal" }).mode, "internal");
  // a hypothesis nobody can read: the model structures it (small), or the researcher in internal mode
  const vague = survey({ objective: "O", population: "P", methodology: "M", sampleSize: 100, hypotheses: ["Things will be interesting"] });
  s = stepOf(vague, "hypotheses");
  assert.equal(s.status, "model");
  assert.equal(s.tier, "small");
  assert.equal(s.model?.operation, "workflow_structure");
  assert.match(s.why, /H1 cannot be read into a type, a direction and two sides/);
  s = stepOf(vague, "hypotheses", { mode: "internal" });
  assert.equal(s.status, "needs_input");
  assert.match(s.questions![0].ask, /What does H1 compare or relate/);
  // no hypotheses in internal mode: asked, with the sentence that records one
  s = stepOf(survey({ objective: "O", population: "P", methodology: "M", sampleSize: 100 }), "hypotheses", { mode: "internal" });
  assert.equal(s.status, "needs_input");
  assert.equal(interpretRequest(def, s.questions![0].example).kind, "actions");
});

test("variables and recommendations: a mean score for a multi-item construct; the test a measured hypothesis lacks; a missing priority-1 crosstab; nothing twice", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "T" },
    research: { objective: "O", population: "P", methodology: "M", sampleSize: 200, hypotheses: ["Service quality drives satisfaction", "Women are more satisfied than men"], hypothesisDetails: [{ type: "causal", direction: "positive", independent: "Service quality", dependent: "Satisfaction" }, { type: "difference", direction: "positive", group: "women", lower: "men", dependent: "Satisfaction" }],
      constructs: [{ name: "Service quality", role: "independent", questionIds: ["q3", "q4", "q5"] }, { name: "Satisfaction", role: "dependent", questionIds: ["q6"] }, { name: "Gender", role: "control", questionIds: ["q2"] }], analysis: [], assumptions: [], sources: [],
      analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H2"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H2"] }], derived: [], segments: [] } },
    questions: [
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "Gender?", options: opts("Male", "Female") },
      { id: "q3", code: "Q3", variableName: "SQ1", type: "single_select", text: "Staff are helpful", options: opts("1", "2", "3", "4", "5") },
      { id: "q4", code: "Q4", variableName: "SQ2", type: "single_select", text: "Staff are quick", options: opts("1", "2", "3", "4", "5") },
      { id: "q5", code: "Q5", variableName: "SQ3", type: "single_select", text: "Staff are polite", options: opts("1", "2", "3", "4", "5") },
      { id: "q6", code: "Q6", variableName: "SAT", type: "single_select", text: "Overall satisfaction", options: opts("1", "2", "3", "4", "5") },
    ],
    flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "P", questionIds: ["q2", "q3", "q4", "q5", "q6"] }] }, { type: "end", id: "e", status: "complete" }],
  });
  let s = stepOf(def, "variables");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions, [{ op: "add_derived_variable", name: "SERVICE_QUALITY_SCORE", kind: "mean_score", from: ["SQ1", "SQ2", "SQ3"], reason: "the mean of the 3 items that measure Service quality" }]);
  // a score over the same items under another name is the score: nothing to derive
  const named = SurveyDefinition.parse({ ...def, research: { ...def.research, analysisPlan: { ...def.research!.analysisPlan, derived: [{ name: "SQ_MEAN", kind: "mean_score", from: ["SQ3", "SQ1", "SQ2"] }] } } });
  assert.equal(stepOf(named, "variables").status, "done");
  // a plan object with nothing in it is no plan: the engine still proposes
  const empty = SurveyDefinition.parse({ ...def, research: { ...def.research, analysisPlan: { crosstabs: [], tests: [], derived: [], segments: [] } } });
  const ap = stepOf(empty, "analysis_plan");
  assert.equal(ap.status, "ready");
  assert.deepEqual(ap.actions, [{ op: "propose_analysis_plan" }]);
  assert.equal(s.sentence, "Plan the derived variables SERVICE_QUALITY_SCORE");
  const withScore = apply(def, s.actions);
  s = stepOf(withScore, "variables");
  assert.equal(s.status, "done");
  assert.match(s.why, /1 derived variable planned; every multi-item construct has its score/);
  // H1 is measured but untested: the framework's test for it is recommended, once
  s = stepOf(withScore, "recommendations");
  assert.equal(s.status, "ready");
  const tests = s.actions!.filter((a) => a.op === "add_analysis_test") as { method: string; hypotheses: string[]; reason: string }[];
  assert.equal(tests.length, 1);
  assert.deepEqual(tests[0].hypotheses, ["H1"]);
  assert.match(tests[0].reason, /H1 is measured but nothing in the plan tests it/);
  assert.equal(tests[0].method, "regression", `the test that takes every item, not one item's correlation: ${JSON.stringify(tests[0])}`);
  assert.deepEqual((tests[0] as unknown as { variables: string[] }).variables, ["SQ1", "SQ2", "SQ3"]);
  assert.match(s.why, /^The plan lacks a regression for H1 \(measured, untested\)\.$/);
  const after = apply(withScore, s.actions);
  s = stepOf(after, "recommendations");
  assert.equal(s.status, "done", JSON.stringify(s));
  // a priority-1 crosstab the framework recommends and the plan lacks (H2 is tested, so only the table is missing)
  const noTable = SurveyDefinition.parse({ ...after, research: { ...after.research, analysisPlan: { ...after.research!.analysisPlan, crosstabs: [] } } });
  s = stepOf(noTable, "recommendations");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.actions!.map((a) => a.op), ["add_crosstab"]);
  assert.deepEqual((s.actions![0] as unknown as { rows: string[]; columns: string[]; priority: number }).rows, ["SAT"]);
  assert.deepEqual((s.actions![0] as unknown as { columns: string[] }).columns, ["GENDER"]);
  assert.match(s.why, /^The plan lacks the priority-1 crosstab SAT by GENDER\.$/);
  assert.equal(stepOf(apply(noTable, s.actions), "recommendations").status, "done");
  // the KPI of a multi-item construct is its score's mean; a control construct is no KPI
  s = stepOf(after, "reporting_framework");
  assert.deepEqual(s.actions, [{ op: "set_research", kpis: [{ name: "Satisfaction", variable: "SAT", measure: "top-2-box share", direction: "higher" }] }]);
  const dep = SurveyDefinition.parse({ ...after, research: { ...after.research, constructs: after.research!.constructs.map((c) => c.name === "Service quality" ? { ...c, role: "dependent" } : c) } });
  s = stepOf(dep, "reporting_framework");
  assert.deepEqual((s.actions![0] as { kpis: unknown[] }).kpis[0], { name: "Service quality", variable: "SERVICE_QUALITY_SCORE", measure: "mean", direction: "higher" });
});

test("the words: a population from an objective, a construct's noun, the questions that measure a name; the workflow sentences", () => {
  assert.equal(populationFromObjective("Understand why UK adults who bought a car switch from Brand A to Brand B"), "UK adults who bought a car");
  assert.equal(populationFromObjective("Measure satisfaction among first-time buyers aged 25-40 in London"), "first-time buyers aged 25-40 in London");
  assert.equal(populationFromObjective("Which features do consumers value most"), "consumers");
  assert.equal(populationFromObjective("Find out what parents of toddlers want from a nursery and whether price matters"), "parents of toddlers");
  assert.equal(populationFromObjective("Test whether the new ad works"), null);
  assert.equal(constructName("satisfied"), "Satisfaction");
  assert.equal(constructName("the switching"), "Switching");
  assert.equal(constructName("brand love"), "Brand love");
  const def = survey();
  assert.deepEqual(questionsMeasuring(def, "Switching").map((q) => q.code), ["Q4"]);
  assert.deepEqual(questionsMeasuring(def, "Price perception").map((q) => q.code), ["Q6"]);
  assert.deepEqual(questionsMeasuring(def, "Gender").map((q) => q.code), ["Q2"]);
  assert.deepEqual(questionsMeasuring(def, "Brand love").map((q) => q.code), []);
  // the standard measure's own words find a question the name's words do not: "continue buying" measures loyalty, "how important" importance
  const more = SurveyDefinition.parse({ ...def, questions: [...def.questions, { id: "q11", code: "Q11", variableName: "CONT", type: "single_select", text: "How likely are you to continue buying?", options: opts("Unlikely", "Likely") }, { id: "q12", code: "Q12", variableName: "IMP", type: "single_select", text: "How important is price to you?", options: opts("Not", "Very") }] });
  assert.deepEqual(questionsMeasuring(more, "Loyalty").map((q) => q.code), ["Q11"]);
  assert.deepEqual(questionsMeasuring(more, "Importance").map((q) => q.code), ["Q12"]);
  // a framework step keeps the constructs already recorded, with their questions, beside the new ones
  const partly = survey({ objective: "O", population: "P", methodology: "M", sampleSize: 100, hypotheses: ["Price perception drives switching"], hypothesisDetails: [{ type: "causal", direction: "positive", independent: "Price perception", dependent: "switching" }], constructs: [{ name: "Price perception", role: "independent", definition: "value for money", questionIds: ["q6"] }] });
  const fw = stepOf(partly, "framework");
  assert.equal(fw.status, "ready");
  assert.deepEqual(fw.actions, [{ op: "set_research", constructs: [{ name: "Price perception", role: "independent", definition: "value for money", questions: ["Q6"] }, { name: "Switching", role: "dependent", questions: ["Q4"] }] }]);
  assert.match(fw.why, /^1 construct named by the hypotheses and not yet in the framework: Switching \(dependent, measured by Q4\)\.$/);
  // the sentences the Intelligent box reads into the workflow
  let r = interpretRequest(def, "start the research workflow for understanding why customers switch from Brand A to Brand B");
  assert.equal(r.kind, "workflow");
  assert.equal((r as { objective?: string }).objective, "Understanding why customers switch from Brand A to Brand B");
  assert.equal((r as { understood: string }).understood, "Run the research workflow for “Understanding why customers switch from Brand A to Brand B”.");
  for (const t of ["run the workflow", "What's next?", "what is the next step in the workflow", "where are we in the research workflow", "continue the workflow"]) { r = interpretRequest(def, t); assert.equal(r.kind, "workflow", t); assert.equal((r as { objective?: string }).objective, undefined, t); }
  r = interpretRequest(def, "plan the whole study for measuring satisfaction among first-time buyers");
  assert.equal(r.kind, "workflow");
  assert.equal((r as { objective?: string }).objective, "Measuring satisfaction among first-time buyers");
  // with a recorded objective that differs, the card says so; an edit in the same sentence is the model's; "start the survey" is not the workflow
  const withObj = survey({ objective: "Old objective" });
  assert.match((interpretRequest(withObj, "start the workflow for a new study") as { understood: string }).understood, /the recorded objective is “Old objective”/);
  assert.equal(interpretRequest(def, "start the research workflow and make Q1 required").kind, "model");
  assert.equal(interpretRequest(def, "start the survey").kind, "model");
  // a blocked step keeps the whole picture readable: the first survey's structure step is ready even before the objective
  const blank = statuses(def);
  assert.equal(blank.objective, "needs_input");
  assert.equal(blank.survey_structure, "ready");
  assert.equal(blank.deck, "blocked");
});
