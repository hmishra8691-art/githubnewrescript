import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, type Interpretation } from "./nlIntent.js";
import { applySurveyActions } from "./surveyActions.js";

/*
 * RESEARCH ENGINE AUDIT, PHASE 2 — the audit's sentences (section F) read by
 * the engine against its brand-switching fixture. Each descriptive edit ends
 * in actions that apply, an answer, a clarifying choice or a precise refusal;
 * what still needs the model carries what the engine can do without one.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    research: { objective: "Understand why customers switch from Brand A to Brand B", hypotheses: ["Price perception drives switching", "Service satisfaction reduces switching"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6"] }], analysis: [], assumptions: [], sources: [] },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Prefer not to say") },
      { id: "q3", code: "Q3", variableName: "BRAND_PREF", type: "single_select", text: "Which brand do you prefer?", options: opts("Brand A", "Brand B", "Brand C"), analysis: { role: "dependent", hypotheses: ["H1"] } },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands in the last 12 months?", options: opts("Yes", "No"), analysis: { role: "dependent", hypotheses: ["H1", "H2"] } },
      { id: "q5", code: "Q5", variableName: "REASONS", type: "multi_select", text: "Why did you switch?", options: opts("Price", "Quality", "Availability") },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value for money", options: opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your current brand?", options: opts("1", "2", "3", "4", "5", "6", "7"), analysis: { role: "independent", hypotheses: ["H2"] } },
      { id: "q8", code: "Q8", variableName: "PETS", type: "single_select", text: "Do you have pets?", options: opts("Yes", "No") },
      { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South") },
      { id: "q10", code: "Q10", variableName: "COMMENTS", type: "open_text", text: "Anything else?" },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
      { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q3", "q4", "q5", "q6", "q7"] }] },
      { type: "block", id: "b3", title: "About you", children: [{ type: "page", id: "p3", title: "About you", questionIds: ["q8", "q9", "q10"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}
const actionsOf = (r: Interpretation) => { assert.equal(r.kind, "actions", JSON.stringify(r)); return (r as Extract<Interpretation, { kind: "actions" }>); };
const applied = (def: SurveyDefinition, r: Interpretation) => { const a = actionsOf(r); const out = applySurveyActions(def, a.actions); assert.ok(out.valid && out.results.every((x) => x.ok), JSON.stringify(out.errors.concat(out.results.filter((x) => !x.ok).map((x) => x.error ?? "")))); return out.def; };

test("the screener: a population phrase becomes a screened terminate on the question that learns it", () => {
  const def = survey();
  for (const t of ["Change the screener so that respondents under 25 are excluded.", "Screen out respondents under 25", "Exclude anyone younger than 25 from the survey", "Do not allow people under 25"]) {
    const r = interpretRequest(def, t);
    const a = actionsOf(r);
    assert.deepEqual(a.actions, [{ op: "add_skip", from: "Q1", when: "Q1 < 25", to: "screened" }], t);
    assert.match(a.understood, /Q1 \(AGE\) is where the survey learns it/);
    assert.match(a.understood, /screen out when Q1 < 25/);
    assert.ok(a.detected.some((d) => d.what === "population" && /→ Q1 \(AGE\) under 25/.test(d.value)), JSON.stringify(a.detected));
    const after = applied(def, r);
    const q1 = after.questions.find((q) => q.id === "q1")!;
    assert.equal(q1.skipLogic?.length, 1);
    assert.equal(q1.skipLogic![0].target.kind, "terminate");
  }
  const only = actionsOf(interpretRequest(def, "Only allow women into the survey"));
  assert.deepEqual(only.actions, [{ op: "add_skip", from: "Q2", when: "NOT (Q2 = 2)", to: "screened" }]);
  assert.match(only.understood, /Allow only women .* screen out everyone else/);
  const restrict = actionsOf(interpretRequest(def, "Restrict the survey to people aged 18 to 65"));
  assert.deepEqual(restrict.actions, [{ op: "add_skip", from: "Q1", when: "NOT (Q1 >= 18 AND Q1 <= 65)", to: "screened" }]);
  const either = actionsOf(interpretRequest(def, "Screen out respondents under 18 and anyone over 65"));
  assert.deepEqual(either.actions, [{ op: "add_skip", from: "Q1", when: "Q1 < 18 OR Q1 > 65", to: "screened" }]);
  // the second time, the rule is there already: planSkip says so rather than adding a twin
  const twice = interpretRequest(applied(def, interpretRequest(def, "Screen out respondents under 25")), "Change the screener so that respondents under 25 are excluded");
  assert.equal(twice.kind, "refused");
  assert.ok((twice as { noop?: boolean }).noop, "the rule is there already: nothing to add");
  assert.match((twice as { reason: string }).reason, /Q1 already screens out when Q1 < 25/);
});

test("the screener: what cannot be resolved is said, what fits two questions is asked, what is not a population is left alone", () => {
  const none = survey();
  none.questions = none.questions.filter((q) => q.id !== "q1");
  (none.flow[0] as unknown as { children: { questionIds: string[] }[] }).children[0].questionIds = ["q2"];
  const r = interpretRequest(none, "Screen out respondents under 25");
  assert.equal(r.kind, "refused");
  assert.match((r as Extract<Interpretation, { kind: "refused" }>).reason, /no question that asks it/);
  const raw = JSON.parse(JSON.stringify(survey()));
  raw.questions.push({ id: "q11", code: "Q11", variableName: "CHILD_AGE", type: "numeric", text: "How old is your eldest child?" });
  raw.flow[2].children[0].questionIds.push("q11");
  const two = SurveyDefinition.parse(raw);
  const ask = interpretRequest(two, "Screen out respondents under 25");
  assert.equal(ask.kind, "clarify", JSON.stringify(ask));
  const c = ask as Extract<Interpretation, { kind: "clarify" }>;
  assert.match(c.question, /Q1 .* or Q11 .* which question should the screener read/);
  assert.equal(c.choices.length, 2);
  assert.deepEqual(c.choices.map((x) => x.text), ["Screen out when Q1 < 25", "Screen out when Q11 < 25"]);
  // each choice is a sentence the engine then reads to the same action
  const picked = actionsOf(interpretRequest(two, c.choices[1].text));
  assert.deepEqual(picked.actions, [{ op: "add_skip", from: "Q11", when: "Q11 < 25", to: "screened" }]);
  assert.equal(interpretRequest(survey(), "remove the price question").kind, "actions", "a question named by its words is still a question, not a population");
  assert.equal((interpretRequest(survey(), "remove the price question") as { actions: { op: string }[] }).actions[0].op, "delete_question");
  assert.equal(interpretRequest(survey(), "Screen out Q8").kind, "model");
  // "exclude the price question" names a question (an option label is inside the words), not the people who chose Price
  const excl = interpretRequest(survey(), "Exclude the price question");
  assert.ok(excl.kind !== "actions" || !excl.actions.some((a) => a.op === "add_skip"), JSON.stringify(excl));
});

test("a scale: this question / Q7 / a described question → update_question.scale; the type decides what happens", () => {
  const def = survey();
  const sel = actionsOf(interpretRequest(def, "Change this question to a 5-point scale.", { selectedId: "q7" }));
  assert.deepEqual(sel.actions, [{ op: "update_question", target: "Q7", scale: { points: 5 } }]);
  assert.match(sel.understood, /replaces its 7 current options/);
  const after = applied(def, sel);
  assert.deepEqual(after.questions.find((q) => q.id === "q7")!.options!.map((o) => o.label), ["1", "2", "3", "4", "5"]);
  const agree = actionsOf(interpretRequest(def, "Make Q6 a 7-point agree-disagree scale"));
  assert.equal((agree.actions[0] as { scale: { labels: string[] } }).scale.labels.length, 7);
  assert.match(agree.understood, /Strongly disagree · Disagree · Somewhat disagree/);
  const described = actionsOf(interpretRequest(def, "Change the satisfaction question to a 5-point satisfaction scale"));
  assert.equal((described.actions[0] as { target: string }).target, "Q7");
  assert.deepEqual((described.actions[0] as { scale: { labels: string[] } }).scale.labels, ["Very dissatisfied", "Dissatisfied", "Neither satisfied nor dissatisfied", "Satisfied", "Very satisfied"]);
  const numeric = actionsOf(interpretRequest(def, "Change Q1 to a 1-10 scale"));
  assert.deepEqual(numeric.actions, [{ op: "update_question", target: "Q1", type: "single_select", scale: { points: 10, start: 1 } }]);
  assert.match(numeric.understood, /from numeric to a single-select/);
  applied(def, numeric);
  const multi = interpretRequest(def, "Change Q5 to a 5-point scale");
  assert.equal(multi.kind, "refused");
  const m = multi as Extract<Interpretation, { kind: "refused" }>;
  assert.match(m.reason, /multi-select — each option is a separate answer/);
  assert.ok(m.suggestion?.actions?.length, "the fix is offered with its actions");
  assert.equal((m.suggestion!.actions![0] as { type?: string }).type, "single_select");
  const already = interpretRequest(def, "Change Q7 to a 7-point scale");
  assert.equal(already.kind, "refused");
  assert.ok((already as { noop?: boolean }).noop, "already a 7-point scale: nothing to change");
  assert.equal(interpretRequest(def, "Change Q7 to a dropdown").kind, "actions", "a type change is still the type-change recogniser's");
  assert.equal((interpretRequest(def, "Change Q7 to a dropdown") as { actions: { type?: string }[] }).actions[0].type, "dropdown");
  const text = interpretRequest(def, "Change Q10 to a 5-point scale");
  assert.equal(text.kind, "actions", "open text becomes a single-select scale, said as a type change");
  assert.match((text as { understood: string }).understood, /from open text to a single-select 5-point scale/);
});

test("crosstabs: two concepts → add_crosstab, the demographic in the banner; 'X by Y' keeps the order; ambiguity asks", () => {
  const def = survey();
  const between = actionsOf(interpretRequest(def, "Create a cross-tab between age and brand preference."));
  assert.deepEqual(between.actions.map((a) => ({ ...a, reason: undefined })), [{ op: "add_crosstab", rows: ["BRAND_PREF"], columns: ["AGE"], priority: 1, reason: undefined }]);
  assert.match(between.understood, /AGE goes in the banner as the demographic/);
  assert.match(between.understood, /AGE is numeric and is banded/);
  const after = applied(def, between);
  assert.equal(after.research!.analysisPlan!.crosstabs.length, 1);
  const by = actionsOf(interpretRequest(def, "Add a crosstab of AGE by BRAND_PREF"));
  assert.deepEqual([(by.actions[0] as { rows: string[] }).rows, (by.actions[0] as { columns: string[] }).columns], [["AGE"], ["BRAND_PREF"]], "said 'X by Y': X stays the rows");
  const sat = actionsOf(interpretRequest(def, "Cross-tab satisfaction by region"));
  assert.deepEqual([(sat.actions[0] as { rows: string[] }).rows, (sat.actions[0] as { columns: string[] }).columns], [["SAT"], ["REGION"]]);
  const brk = actionsOf(interpretRequest(def, "Break down brand switching by gender"));
  assert.deepEqual([(brk.actions[0] as { rows: string[] }).rows, (brk.actions[0] as { columns: string[] }).columns], [["SWITCHED"], ["GENDER"]]);
  const sw = interpretRequest(def, "Break down switching by gender");
  assert.equal(sw.kind, "clarify", "“switching” fits Q4 and Q5 equally: ask");
  assert.deepEqual((sw as Extract<Interpretation, { kind: "clarify" }>).choices.map((x) => x.text), ["Break down SWITCHED by gender", "Break down REASONS by gender"]);
  const twice = interpretRequest(after, "Create a cross-tab between age and brand preference.");
  assert.equal(twice.kind, "refused");
  assert.match((twice as { reason: string }).reason, /already planned/);
  const amb = interpretRequest(def, "Create a crosstab of brand by region");
  assert.equal(amb.kind, "clarify", JSON.stringify(amb));
  const c = amb as Extract<Interpretation, { kind: "clarify" }>;
  assert.ok(c.choices.length >= 2);
  assert.ok(c.choices.every((x) => /^Create a crosstab of \w+ by region$/.test(x.text)), c.choices.map((x) => x.text).join(" | "));
  const picked = actionsOf(interpretRequest(def, c.choices[0].text));
  assert.equal(picked.actions[0].op, "add_crosstab");
  const none = interpretRequest(def, "Create a crosstab of shoe size by region");
  assert.equal(none.kind, "refused");
  assert.match((none as { reason: string }).reason, /No question measures “shoe size”/);
  const compound = interpretRequest(def, "Add a crosstab of brand preference by region and test satisfaction across age groups");
  assert.equal(compound.kind, "model", "a second instruction after 'and' is not swallowed into the second concept");
  const same = interpretRequest(def, "Create a crosstab of age by AGE");
  assert.equal(same.kind, "refused");
  assert.match((same as { reason: string }).reason, /two different variables/);
});

test("the most important crosstabs: planned from the framework (hypothesis-linked first), or listed when asked which", () => {
  const def = survey();
  const r = actionsOf(interpretRequest(def, "Create the most important crosstabs for this research"));
  assert.ok(r.actions.length >= 2);
  assert.ok(r.actions.every((a) => a.op === "add_crosstab"));
  const first = r.actions[0] as { rows: string[]; hypotheses: string[] };
  assert.ok(first.hypotheses.length >= 1, "hypothesis-linked first");
  assert.match(r.understood, /Hypothesis-linked tables come first/);
  const after = applied(def, r);
  assert.equal(after.research!.analysisPlan!.crosstabs.length, r.actions.length);
  const again = interpretRequest(after, "Create the most important crosstabs for this research");
  assert.equal(again.kind, "refused");
  assert.ok((again as { noop?: boolean }).noop, "already planned: nothing to add");
  const which = interpretRequest(def, "Show me the most important crosstabs");
  assert.equal(which.kind, "answer");
  assert.match((which as { answer: string }).answer, /hypothesis-linked and priority-1 first/);
  assert.ok((which as { sections: { items: unknown[] }[] }).sections[0].items.length >= 2);
  const bare = survey();
  bare.research = undefined;
  bare.questions.forEach((q) => { delete (q as { analysis?: unknown }).analysis; });
  const nothing = interpretRequest(bare, "Create the most important crosstabs");
  // with no roles the framework still profiles the sample; with nothing at all it refuses with the next step
  assert.ok(nothing.kind === "actions" || (nothing.kind === "refused" && /Tag the outcome/.test(nothing.reason)), JSON.stringify(nothing));
});

test("which questions are not connected: read off the design, with the roles that explain the expected ones", () => {
  const def = survey();
  const r = interpretRequest(def, "Which questions are not connected to any hypothesis?");
  assert.equal(r.kind, "answer", JSON.stringify(r));
  const a = r as Extract<Interpretation, { kind: "answer" }>;
  assert.match(a.answer, /6 of 10 questions are not connected .*: Q1, Q2, Q5, Q8, Q9, Q10/);
  assert.match(a.answer, /Demographics and screeners are expected here/);
  const loose = a.sections.find((s) => /Not connected/.test(s.title))!;
  assert.deepEqual(loose.items.map((i) => i.label), ["Q1", "Q2", "Q5", "Q8", "Q9", "Q10"]);
  assert.match(loose.items.find((i) => i.label === "Q10")!.detail ?? "", /open text/);
  assert.match(loose.items.find((i) => i.label === "Q9")!.detail ?? "", /a demographic/);
  const connected = a.sections.find((s) => s.title === "Connected")!;
  assert.match(connected.items.find((i) => i.label === "Q6")!.detail ?? "", /construct “Price perception”/);
  assert.match(connected.items.find((i) => i.label === "Q4")!.detail ?? "", /hypotheses H1, H2/);
  for (const t of ["which questions have no hypothesis", "list the orphan questions", "Which questions don't serve any research objective?", "show me the questions that are not linked to the research framework"]) assert.equal(interpretRequest(def, t).kind, "answer", t);
  const bare = survey();
  bare.research = undefined;
  const none = interpretRequest(bare, "Which questions are not connected to any hypothesis?");
  assert.match((none as { answer: string }).answer, /no research design yet/);
});

test("the objective: set by sentence; and what the engine offers when the model is not there", () => {
  const def = survey();
  const obj = actionsOf(interpretRequest(def, "Set the research objective to understand churn"));
  assert.deepEqual(obj.actions, [{ op: "set_research", objective: "Understand churn" }]);
  assert.equal(applied(def, obj).research!.objective, "Understand churn");
  const same = interpretRequest(def, `Set the research objective to "${def.research!.objective}"`);
  assert.equal(same.kind, "refused");
  assert.ok((same as { noop?: boolean }).noop, "the objective already is that: nothing to change");
  const design = interpretRequest(def, "Create a research design for understanding why customers are switching from Brand A to Brand B.");
  assert.equal(design.kind, "model");
  const d = design as Extract<Interpretation, { kind: "model" }>;
  assert.equal(d.category, "research_design");
  assert.ok(d.fallback, "the engine says what it can do without a model");
  assert.equal(d.fallback!.choices[0].text, 'Set the research objective to "Why customers are switching from Brand A to Brand B"');
  const step = actionsOf(interpretRequest(def, d.fallback!.choices[0].text));
  assert.equal((step.actions[0] as { objective: string }).objective, "Why customers are switching from Brand A to Brand B");
  const intent = interpretRequest(def, "Add a question to measure purchase intent.");
  assert.equal(intent.kind, "model");
  const i = intent as Extract<Interpretation, { kind: "model" }>;
  assert.equal(i.category, "question_creation");
  assert.ok(i.fallback && i.fallback.choices.length === 2, JSON.stringify(i.fallback));
  assert.match(i.fallback!.choices[0].text, /How likely are you to purchase Brand B in the next 3 months\?/, "the brand from the objective");
  const made = actionsOf(interpretRequest(def, i.fallback!.choices[0].text));
  assert.equal(made.actions[0].op, "create_question");
  assert.equal((made.actions[0] as { options: unknown[] }).options.length, 5);
  const after = applied(def, made);
  assert.equal(after.questions.length, 11);
  const delivery = interpretRequest(def, "Add a question to measure satisfaction with the delivery");
  assert.match((delivery as Extract<Interpretation, { kind: "model" }>).fallback!.choices[0].text, /how satisfied are you with the delivery\?/);
  const unknown = interpretRequest(def, "Add a question to measure shoe size");
  assert.equal((unknown as Extract<Interpretation, { kind: "model" }>).fallback, undefined, "an unknown measure has no standard item");
  assert.equal((interpretRequest(def, "why is Q8 not showing") as Extract<Interpretation, { kind: "model" }>).fallback, undefined, "the grammar's sentences are not given fallbacks");
});
