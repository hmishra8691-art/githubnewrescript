import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { impactOf, impactOfAction, impactReport } from "./impact.js";
import type { ImpactItem } from "./impact.js";
import { buildDependencyIndex } from "./dependencyIndex.js";

/**
 * THE IMPACT REPORT NAMES EVERY DEPENDENT, WITH HOW BADLY IT IS HIT.
 *
 * One fixture, every kind of dependent on Q7: display logic (Q9), a skip
 * (Q11), a calculation (SCORE), a quota cell, a planned crosstab and test, a
 * construct and German translations. Each test asks one question of it —
 * what a delete breaks, what a recode of ONE code touches, what a type
 * change leaves unfit, what a move puts out of order — and checks the
 * severity the review will colour it with.
 */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "svy", code: "IMP", title: "Impact" },
    questions: [
      { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender?", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "How <b>satisfied</b> are you?", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: String(c) })) },
      { id: "q9", code: "Q9", variableName: "WHY", type: "text", text: "Why neutral?", displayLogic: cond.rule("SAT", "eq", 3) },
      {
        id: "q11", code: "Q11", variableName: "RECO", type: "single_select", text: "Recommend?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
        skipLogic: [{ id: "sk1", when: cond.rule("SAT", "eq", 5), target: { kind: "question", ref: "q12" } }],
      },
      { id: "q12", code: "Q12", variableName: "NOTE", type: "text", text: "You rated {{SAT}}: anything else?" },
    ],
    calculations: [{ id: "c_score", targetVariable: "SCORE", expression: "SAT * 20" }],
    quotas: [{ id: "qt1", name: "Happy", cells: [{ id: "cell1", label: "Top", when: cond.rule("SAT", "gte", 4), limit: 50 }] }],
    research: {
      hypotheses: ["Satisfaction differs by gender"],
      constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q7"] }],
      analysisPlan: {
        crosstabs: [{ id: "xt_1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }],
        tests: [{ id: "t_1", method: "t_test", outcome: "SAT", groupBy: "GENDER", variables: [], priority: 1, hypotheses: ["H1"] }],
      },
    },
    localization: {
      sourceLanguage: "en", languages: [{ code: "de" }],
      translations: { de: {
        "q:q7:text": { text: "Wie zufrieden sind Sie?", status: "approved" },
        "q:q7:opt:3": { text: "Drei", status: "edited" },
        "q:q7:opt:5": { text: "Fünf", status: "edited" },
        "q:q9:text": { text: "Warum neutral?", status: "edited" },
      } },
    },
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q7"] },
      { type: "page", id: "p2", questionIds: ["q9", "q11"] },
      { type: "page", id: "p3", questionIds: ["q12"] },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

const find = (items: ImpactItem[], kind: string, id: string, via?: string) => items.find((i) => i.object.kind === kind && i.object.id === id && (!via || i.via === via));

test("deleting Q7: logic that reads it breaks, the plan / construct / language inform, the skip's owner is indirect", () => {
  const def = survey();
  const r = impactOf(def, { questions: ["q7"] }, { change: "delete" });
  const display = find(r.items, "question", "q9", "display");
  assert.ok(display, "Q9's display logic reads Q7");
  assert.equal(display.severity, "breaks");
  assert.equal(display.indirect, undefined);
  assert.match(display.text, /^Q9 — display logic reads .*= 3/);
  const skip = find(r.items, "skipRule", "q11/sk1", "skip");
  assert.ok(skip, "the skip rule reads Q7");
  assert.equal(skip.severity, "breaks");
  assert.equal(skip.object.questionId, "q11", "a skip rule item points at its owner question");
  const calc = find(r.items, "calculation", "c_score", "calculation");
  assert.ok(calc && calc.severity === "breaks");
  assert.match(calc.text, /SCORE — expression = SAT \* 20/);
  const quota = find(r.items, "quota", "qt1", "quotaCell");
  assert.ok(quota && quota.severity === "breaks");
  const pipe = find(r.items, "question", "q12", "piping");
  assert.ok(pipe && pipe.severity === "informs", "a pipe is reported, not counted as broken logic");
  for (const [kind, id, via] of [["analysis", "xt_1", "analysis plan"], ["analysis", "t_1", "analysis plan"], ["construct", "Satisfaction", "construct"], ["translation", "de", "translation"]] as const) {
    const it = find(r.items, kind, id, via);
    assert.ok(it, `${kind} ${id} is listed`);
    assert.equal(it.severity, "informs", `${kind} ${id} informs`);
  }
  // Q11 reads its own skip rule, so it is reached through the rule — indirect, "changes"
  const owner = find(r.items, "question", "q11");
  assert.ok(owner?.indirect, "Q11 is reached through its skip");
  assert.equal(owner.severity, "changes");
  assert.match(owner.text, /through/);
  // the shape
  assert.equal(r.count, r.items.length);
  assert.equal(r.bySeverity.breaks, 4, JSON.stringify(r.bySeverity));
  assert.equal(r.byVia.display, 1);
  assert.equal(r.byVia["analysis plan"], 2);
  assert.match(r.summary, /^Impact: \d+ dependent objects — Q9 display logic, Q11 skip logic, calculation SCORE, quota “Happy”/);
  assert.match(r.summary, /construct Satisfaction/);
  // Phase 3: the hypothesis measured only through Q7 is affected, and says what it would lose
  assert.match(r.summary, /hypothesis H1/);
  const h1 = r.items.find((i) => i.object.kind === "hypothesis" && i.object.id === "H1")!;
  assert.equal(h1.severity, "changes");
  assert.match(h1.text, /measures its construct “Satisfaction” \(its only question\); it would be left unmeasured/);
  assert.ok(r.items.some((i) => i.via === "translation" && /Deutsch/.test(i.object.label)), "the language is among the items (the summary names the first eight)");
  // one row per object and via, however many edges carry the same reason
  const keys = r.items.map((i) => `${i.object.kind}:${i.object.id}|${i.via}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("nothing depends on Q12: an empty report with the quiet summary", () => {
  const r = impactOf(survey(), { questions: ["q12"] }, { change: "delete" });
  assert.equal(r.count, 0);
  assert.deepEqual(r.items, []);
  assert.equal(r.summary, "Impact: nothing else depends on it");
});

test("an option scope lists only the comparers of THOSE codes", () => {
  const def = survey();
  const r3 = impactOf(def, { options: [{ questionId: "q7", codes: [3] }] }, { change: "recode" });
  const display = find(r3.items, "question", "q9", "display");
  assert.ok(display, "Q9 compares Q7 with 3");
  assert.equal(display.severity, "breaks");
  assert.match(display.text, /compares Q7 with 3/);
  assert.ok(!find(r3.items, "skipRule", "q11/sk1"), "the skip compares with 5, not 3");
  assert.ok(!find(r3.items, "quota", "qt1"), "the quota compares with 4, not 3");
  assert.ok(!find(r3.items, "calculation", "c_score"), "an expression reads the question, not a code");
  const de = find(r3.items, "translation", "de");
  assert.ok(de, "German has a translation keyed to code 3");
  assert.equal(de.severity, "breaks", "a recoded option's translation key dangles");
  assert.match(de.text, /1 option translation/);
  const r5 = impactOf(def, { options: [{ questionId: "q7", codes: [5] }] }, { change: "delete" });
  assert.ok(find(r5.items, "skipRule", "q11/sk1", "skip"), "code 5 is what the skip compares");
  assert.equal(find(r5.items, "skipRule", "q11/sk1")!.severity, "breaks");
  assert.ok(!find(r5.items, "question", "q9"));
  const r4 = impactOf(def, { options: [{ questionId: "q7", codes: [4] }] }, { change: "recode" });
  const quota = find(r4.items, "quota", "qt1", "quotaCell");
  assert.ok(quota, "the quota cell compares with 4");
  assert.equal(quota.object.code, "Happy");
  assert.equal(quota.object.label, "Top");
  // a label edit on an option touches translations only, as a change to review
  const edit = impactOf(def, { options: [{ questionId: "q7", codes: [3] }] }, { change: "edit" });
  assert.equal(find(edit.items, "question", "q9", "display")!.severity, "informs");
  assert.equal(find(edit.items, "translation", "de")!.severity, "changes");
});

test("a type change breaks the rules whose operators no longer fit and leaves the others as changes", () => {
  const def = survey();
  def.questions[1] = { ...def.questions[1], type: "open_text", options: [] } as never;
  const r = impactOf(def, { questions: ["q7"] }, { change: "retype" });
  assert.equal(find(r.items, "question", "q9", "display")!.severity, "changes", "= still fits a text answer");
  assert.equal(find(r.items, "quota", "qt1", "quotaCell")!.severity, "breaks", ">= does not fit a text answer");
  assert.equal(find(r.items, "calculation", "c_score")!.severity, "changes");
  assert.equal(find(r.items, "translation", "de")!.severity, "changes", "the translations of a changed question are to re-check");
});

test("a move breaks the readers that would now run before the question", () => {
  const def = survey();
  // Q7 moves after Q9 and Q11: both read it, both now run first; Q12 still comes after
  (def.flow[0] as { questionIds: string[] }).questionIds = ["q1"];
  (def.flow[1] as { questionIds: string[] }).questionIds = ["q9", "q11", "q7"];
  const r = impactOf(def, { questions: ["q7"] }, { change: "move" });
  assert.equal(find(r.items, "question", "q9", "display")!.severity, "breaks");
  assert.equal(find(r.items, "skipRule", "q11/sk1", "skip")!.severity, "breaks");
  assert.equal(find(r.items, "calculation", "c_score")!.severity, "changes", "a calculation has no page order to violate");
  assert.equal(find(r.items, "question", "q12", "piping")!.severity, "informs");
});

test("a reused index gives the same report", () => {
  const def = survey();
  const index = buildDependencyIndex(def);
  const a = impactOf(def, { questions: ["q7"] }, { change: "delete", index });
  const b = impactOf(def, { questions: ["q7"] }, { change: "delete" });
  assert.deepEqual(a.items, b.items);
});

test("a variable scope reports what a rename rewrites and what it cannot", () => {
  const def = survey();
  def.scripts = [{ id: "s1", name: "tracker", code: "track(getVar('SAT'))", trigger: "on_complete" }] as never;
  const r = impactOf(def, { variables: ["SAT"] }, { change: "edit" });
  assert.ok(find(r.items, "question", "q9", "display"), "a rule reads it by name");
  assert.equal(find(r.items, "question", "q9", "display")!.severity, "changes", "the rename rewrites it");
  assert.equal(find(r.items, "question", "q12", "piping")!.severity, "changes");
  const script = r.items.find((i) => i.via === "script");
  assert.ok(script, "the script that mentions it is listed");
  assert.equal(script.severity, "breaks", "scripts are never rewritten");
  assert.ok(r.items.some((i) => i.via === "analysis plan"), "the plan names it");
  assert.ok(!r.items.some((i) => i.text.includes("the question's variable name")), "the variable itself is not its own dependent");
});

/* ------------------------------------------------------------ from an action */

test("impactOfAction: delete_question scopes the question as a delete", () => {
  const def = survey();
  const after = SurveyDefinition.parse({ ...def, questions: def.questions.filter((q) => q.id !== "q7") });
  const r = impactOfAction(def, after, { op: "delete_question", target: "Q7" }, ["q7"]);
  assert.deepEqual(r.items, impactOf(def, { questions: ["q7"] }, { change: "delete" }).items);
});

test("impactOfAction: update_question.removeOptions scopes the codes that went", () => {
  const def = survey();
  const after = structuredClone(def);
  after.questions[1].options = after.questions[1].options.filter((o) => o.code !== 3);
  const r = impactOfAction(def, after, { op: "update_question", target: "Q7", removeOptions: [3] }, ["q7"]);
  assert.ok(find(r.items, "question", "q9", "display"));
  assert.equal(find(r.items, "question", "q9", "display")!.severity, "breaks");
  assert.ok(!find(r.items, "skipRule", "q11/sk1"), "code 5 stays");
  assert.ok(!find(r.items, "calculation", "c_score"), "an option removal is not a question deletion");
});

test("impactOfAction: update_option.code is a recode of the old code", () => {
  const def = survey();
  const after = structuredClone(def);
  after.questions[1].options[4].code = 9;
  const r = impactOfAction(def, after, { op: "update_option", target: "Q7", option: 5, code: 9 }, ["q7"]);
  const skip = find(r.items, "skipRule", "q11/sk1", "skip");
  assert.ok(skip && skip.severity === "breaks");
  assert.ok(find(r.items, "translation", "de"), "Fünf is keyed to code 5");
  assert.ok(!find(r.items, "question", "q9"));
  // a label-only change on the same option: the same comparers, as changes
  const label = impactOfAction(def, def, { op: "update_option", target: "Q7", option: 5, label: "Five" }, ["q7"]);
  assert.equal(find(label.items, "skipRule", "q11/sk1")!.severity, "informs");
});

test("impactOfAction: update_question.type is a retype against the survey after it", () => {
  const def = survey();
  const after = structuredClone(def);
  after.questions[1] = { ...after.questions[1], type: "open_text", options: [] } as never;
  const r = impactOfAction(def, after, { op: "update_question", target: "Q7", type: "text" }, ["q7"]);
  assert.equal(find(r.items, "quota", "qt1", "quotaCell")!.severity, "breaks");
  assert.equal(find(r.items, "question", "q9", "display")!.severity, "changes");
});

test("impactOfAction: move_question is judged on the new order; a wording edit only informs", () => {
  const def = survey();
  const after = structuredClone(def);
  (after.flow[0] as { questionIds: string[] }).questionIds = ["q1"];
  (after.flow[1] as { questionIds: string[] }).questionIds = ["q9", "q11", "q7"];
  const moved = impactOfAction(def, after, { op: "move_question", target: "Q7", after: "Q11" }, ["q7"]);
  assert.equal(find(moved.items, "question", "q9", "display")!.severity, "breaks");
  const worded = impactOfAction(def, def, { op: "update_question", target: "Q7", text: "How happy are you?" }, ["q7"]);
  assert.equal(find(worded.items, "question", "q9", "display")!.severity, "informs");
  assert.equal(find(worded.items, "translation", "de")!.severity, "changes", "its translations are now out of date");
  // an action that only adds depends on nothing
  assert.equal(impactOfAction(def, def, { op: "create_block", title: "New" }, ["blk"]).count, 0);
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 2) */

test("impactReport: a second reason for the same object and via keeps the worse severity and the direct reading, in either order", () => {
  const item = (severity: ImpactItem["severity"], indirect = false): ImpactItem => ({ object: { kind: "question", id: "q9", code: "Q9", label: "Why neutral?", questionId: "q9" }, via: "display", text: indirect ? "Q9 — display logic — through Q7" : "Q9 — display logic reads Q7 = 3", severity, ...(indirect ? { indirect: true } : {}) });
  for (const items of [[item("breaks"), item("informs")], [item("informs"), item("breaks")]]) {
    const r = impactReport(items);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].severity, "breaks", items.map((i) => i.severity).join(" then "));
  }
  for (const items of [[item("changes", true), item("informs")], [item("informs"), item("changes", true)]]) {
    const [it] = impactReport(items).items;
    assert.equal(it.indirect, undefined, "found directly once is direct");
    assert.equal(it.text, "Q9 — display logic reads Q7 = 3", "the direct reading's words");
    assert.equal(it.severity, "changes");
  }
});

test("a type change: a reader that is not a condition (a loop over the answers) is a change to review, not a break; a question-scope recode changes its readers", () => {
  const def = survey();
  def.flow = [def.flow[0], def.flow[1], { type: "loop", id: "lp1", loopVar: "g", source: { kind: "question", questionId: "q1", filter: "selected" }, children: [def.flow[2]] }, def.flow[3]] as never;
  const r = impactOf(SurveyDefinition.parse(def), { questions: ["q1"] }, { change: "retype" });
  const loop = r.items.find((i) => i.via === "loopSource");
  assert.ok(loop, JSON.stringify(r.items.map((i) => i.via)));
  assert.equal(loop.severity, "changes");
  const recode = impactOf(survey(), { questions: ["q7"] }, { change: "recode" });
  assert.equal(find(recode.items, "question", "q9", "display")!.severity, "changes");
});

test("the scope's own wiring is not impact: deleting Q7 and Q9 together does not list Q9's logic", () => {
  const r = impactOf(survey(), { questions: ["q7", "q9"] }, { change: "delete" });
  assert.ok(!r.items.some((i) => i.object.questionId === "q9" || (i.object.kind === "question" && i.object.id === "q9")), JSON.stringify(r.items.map((i) => i.object.id)));
  assert.ok(find(r.items, "skipRule", "q11/sk1"), "what reads them from outside still is");
});

test("an option scope: a rank is not a code, a count's own code list is, and the source language has no translations to break", () => {
  const def = survey();
  def.questions.push(
    { ...structuredClone(def.questions[1]), id: "q20", code: "Q20", variableName: "RANK", type: "ranking", text: "Rank them", options: [1, 2, 3].map((c) => ({ code: c, label: `R${c}`, flags: [] })) },
    { ...structuredClone(def.questions[2]), id: "q21", code: "Q21", variableName: "RANKED", text: "Why that first?", displayLogic: { type: "rule", source: { kind: "question", ref: "q20" }, operator: "rankEquals", value: 1, value2: 3 } },
    { ...structuredClone(def.questions[2]), id: "q22", code: "Q22", variableName: "COUNTED", text: "Why neutral?", displayLogic: { type: "rule", source: { kind: "question", ref: "q7", count: { of: "selected", scope: "options", only: [3] } }, operator: "gte", value: 1 } },
  );
  (def.flow[2] as { questionIds: string[] }).questionIds.push("q20", "q21", "q22");
  def.localization!.translations.en = { "q:q7:opt:3": { text: "Three", status: "approved", version: 1, history: [] } } as never;
  assert.ok(!find(impactOf(def, { options: [{ questionId: "q20", codes: [3] }] }, { change: "delete" }).items, "question", "q21"), "rank 3 is a position");
  assert.ok(find(impactOf(def, { options: [{ questionId: "q20", codes: [1] }] }, { change: "delete" }).items, "question", "q21", "display"), "code 1 is the option");
  const r = impactOf(def, { options: [{ questionId: "q7", codes: [3] }] }, { change: "recode" });
  assert.equal(find(r.items, "question", "q22", "display")?.severity, "breaks", "the count compares code 3");
  assert.ok(find(r.items, "translation", "de"));
  assert.ok(!find(r.items, "translation", "en"), "English is the source, not a translation");
});

test("embedded fields: a deletion breaks the logic that reads one and only informs the text that pipes it", () => {
  const def = survey();
  def.questions[4].text = "Panel {{ed.PANEL}}";
  def.questions[2].displayLogic = { type: "rule", source: { kind: "embedded", ref: "PANEL" }, operator: "eq", value: "A" } as never;
  const r = impactOf(def, { embedded: ["PANEL"] }, { change: "delete" });
  assert.equal(find(r.items, "question", "q9", "display")?.severity, "breaks");
  assert.equal(find(r.items, "question", "q12", "piping")?.severity, "informs");
  // from the action: an update that does not rename it reports nothing; a rename reports its readers
  assert.equal(impactOfAction(def, def, { op: "update_embedded", name: "PANEL", value: "x" } as never, []).count, 0);
  assert.equal(impactOfAction(def, def, { op: "update_embedded", name: "PANEL", newName: "PANEL" } as never, []).count, 0);
  assert.equal(impactOfAction(def, def, { op: "update_embedded", name: "PANEL", newName: "SOURCE" } as never, []).count, 2);
});

test("the summary counts what it does not name: 'and N more' for the indirect dependents", () => {
  const r = impactOf(survey(), { questions: ["q7"] }, { change: "delete" });
  const indirect = r.items.filter((i) => i.indirect).length;
  assert.ok(indirect > 0);
  // the summary names up to eight direct dependents; the rest, with the indirect ones, are counted
  const direct = new Set(r.items.filter((i) => !i.indirect).map((i) => (i.object.kind === "analysis" ? "analyses" : `${i.object.kind}:${i.object.id}`))).size;
  const unnamed = Math.max(0, direct - 8);
  assert.ok(r.summary.endsWith(` and ${indirect + unnamed} more`), r.summary);
});

test("impactOfAction: a variable rename reports every place the old name is held", () => {
  const def = survey();
  const after = structuredClone(def);
  after.questions[1].variableName = "SATIS";
  const r = impactOfAction(def, after, { op: "update_question", target: "Q7", variable: "SATIS" }, ["q7"]);
  assert.ok(r.count > 0);
  assert.deepEqual(r.items, impactOf(def, { variables: ["SAT"] }, { change: "edit" }).items);
});

test("a block scope takes its questions: what outside the block reads them is listed", () => {
  const def = survey();
  def.flow = [{ type: "block", id: "b1", title: "Intro", children: [def.flow[0]] }, ...def.flow.slice(1)] as never;
  const parsed = SurveyDefinition.parse(def);
  const r = impactOf(parsed, { blocks: ["b1"] }, { change: "delete" });
  assert.equal(find(r.items, "question", "q9", "display")?.severity, "breaks", "Q9 reads Q7, which is in the block");
  assert.ok(find(r.items, "quota", "qt1"));
});

test("a type change lists the saved export settings of the variable, as a delete does", () => {
  const def = survey();
  def.variables = [{ name: "SAT", label: "Satisfaction", dataType: "numeric", responseType: "single", valueCodes: [], valueLabels: {}, derived: false, hidden: false }] as never;
  const retype = impactOf(def, { questions: ["q7"] }, { change: "retype" });
  const col = find(retype.items, "question", "q7", "export column");
  assert.ok(col, JSON.stringify(retype.items.map((i) => i.via)));
  assert.equal(col.severity, "informs");
  assert.equal(col.text, "Variables — the saved settings for this variable");
  assert.ok(!find(impactOf(def, { questions: ["q7"] }, { change: "edit" }).items, "question", "q7", "export column"), "an edit keeps the column");
});
