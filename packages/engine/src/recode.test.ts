import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type ConditionRule } from "@rescript/schema";
import {
  recodeOptionCode, recodeRowCode, parseLogicExpression, formatCondition, evaluateCondition,
  createResponseState, setAnswer, canonicalizeSurveyConditions, lintSurveyLogic, renumberQuestionCodes,
} from "./index.js";

/**
 * LOGIC-01 — A HAND-EDITED OPTION OR ROW CODE RETARGETS EVERYTHING THAT NAMED IT.
 *
 * The Studio's Options editor wrote the new code into the option and left
 * every reference comparing with the old one; only the Intelligent-Mode
 * `update_option` action repointed them. `recodeOptionCode` / `recodeRowCode`
 * are the one path both now share. The survey here is the audit's repro
 * (`docs/audit-2026-10-16/repro/logic/ref-integrity.mjs`), with a mask, a
 * punch and a randomisation group added on the recoded question.
 */

const mk = () => {
  const def = SurveyDefinition.parse({
    meta: { id: "r", code: "R", title: "Ref", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "COLOR", type: "single_select", text: "Colour?",
        options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }, { code: "3", label: "Green" }],
        mask: { expr: { kind: "codes", codes: ["2", "3"] } },
        punches: [{ id: "p1", source: { kind: "codes", codes: ["2"] }, when: { type: "rule", source: { kind: "question", ref: "q4" }, operator: "selected", value: "1" }, action: "select" }],
        randomization: { enabled: true, groups: [["1", "2"]] } },
      { id: "qm", code: "QM", variableName: "SAT", type: "matrix_single", text: "Rate",
        options: [{ code: "1", label: "Poor" }, { code: "2", label: "Great" }],
        rows: [{ code: "svc", label: "Service", flags: [], validation: [], required: false }, { code: "prc", label: "Price", flags: [], validation: [], required: false }],
        rowMask: { expr: { kind: "codes", codes: ["svc"] } } },
      { id: "q2", code: "Q2", variableName: "WHY", type: "text", text: "Why blue?" },
      { id: "q3", code: "Q3", variableName: "WHY2", type: "text", text: "Why service great?" },
      { id: "q4", code: "Q4", variableName: "MASKED", type: "multi_select", text: "masked", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
      { id: "q5", code: "Q5", variableName: "PIPE", type: "text", text: "You said {{QM[svc]}}" },
    ],
    calculations: [{ id: "c1", targetVariable: "ISBLUE", expression: "Q1 == 2", trigger: "on_change" }],
    quotas: [{ id: "qt1", name: "Blue quota", type: "hard", limitType: "count", cells: [{ id: "cell1", label: "Blue", limit: 10, when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" } }] }],
    localization: { sourceLanguage: "en", languages: [{ code: "de", name: "German" }], translations: { de: { "q:q1:opt:2": { text: "Blau", sourceHash: "h", status: "approved" } } } },
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "qm"] }, { type: "page", id: "p2", questionIds: ["q2", "q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
  });
  def.questions[2].displayLogic = parseLogicExpression(def, "Q1 = 2").condition!;
  def.questions[3].displayLogic = parseLogicExpression(def, "QM.svc.2").condition!;
  return SurveyDefinition.parse(def);
};

const q = (d: SurveyDefinition, id: string) => d.questions.find((x) => x.id === id)!;
const visible = (d: SurveyDefinition, id: string, answers: Record<string, unknown>): boolean => {
  const state = createResponseState(d);
  for (const [k, v] of Object.entries(answers)) setAnswer(d, state, k, v, null);
  return evaluateCondition(q(d, id).displayLogic!, { def: d, state, loop: null });
};

test("recodeOptionCode: display logic, quota cell, mask, punch, randomisation group and translations follow the code", () => {
  const def = mk();
  /* the Studio writes the keystrokes into the option first, then commits on blur */
  const edited = structuredClone(def);
  q(edited, "q1").options[1].code = "20";
  const r = recodeOptionCode(edited, "q1", "2", "20");
  assert.equal(r.problem, undefined);
  assert.ok(r.updated >= 5, `references updated: ${r.updated}`);
  const d = r.def;
  assert.equal(q(d, "q1").options[1].code, "20");
  assert.equal(formatCondition(d, q(d, "q2").displayLogic), "Q1 = 20");
  assert.equal(visible(d, "q2", { q1: "20" }), true, "Q2 is shown when Blue (now 20) is chosen");
  assert.equal((d.quotas[0].cells[0].when as ConditionRule).value, "20", "the quota cell counts the new code");
  assert.deepEqual((q(d, "q1").mask as { expr: { codes: string[] } }).expr.codes, ["20", "3"]);
  assert.deepEqual((q(d, "q1").punches[0].source as { codes: string[] }).codes, ["20"], "the punch selects the recoded option");
  assert.deepEqual(q(d, "q1").randomization?.groups, [["1", "20"]]);
  assert.equal(d.localization?.translations?.de?.["q:q1:opt:20"]?.text, "Blau", "the German label moved to the new key");
  assert.equal(d.localization?.translations?.de?.["q:q1:opt:2"], undefined);
  assert.equal(r.translationsMoved, 1);
  /* the calculation's free text is reported, not rewritten */
  assert.deepEqual(r.needsReview.map((x) => x.expression), ["Q1 == 2"]);
  /* nothing left pointing at the old code */
  assert.deepEqual(canonicalizeSurveyConditions(d).unresolved, []);
  assert.ok(!lintSurveyLogic(d).some((i) => /has no option coded/.test(i.message)));
  /* the input was not mutated: the edited copy still holds its unretargeted rule */
  assert.equal(formatCondition(edited, q(edited, "q2").displayLogic), "Q1 = 2");
});

test("recodeOptionCode: works from the action side too (the option still holds the old code)", () => {
  const def = mk();
  const r = recodeOptionCode(def, "q1", "2", "20");
  assert.equal(q(r.def, "q1").options[1].code, "20");
  assert.equal(visible(r.def, "q2", { q1: "20" }), true);
  assert.equal(q(def, "q1").options[1].code, "2", "input untouched");
});

test("recodeOptionCode: a new code the list's neighbours spell as a number is stored as a number", () => {
  const def = mk();
  q(def, "q1").options = [{ code: 1, label: "Red" }, { code: 2, label: "Blue" }] as never;
  const r = recodeOptionCode(def, "q1", 2, "20");
  assert.equal(q(r.def, "q1").options[1].code, 20);
  assert.equal((q(r.def, "q2").displayLogic as ConditionRule).value, "20", "a string rule value keeps its type");
});

test("recodeRowCode: grid cell conditions, the row mask and a row pipe follow the row code", () => {
  const def = mk();
  const edited = structuredClone(def);
  q(edited, "qm").rows[0].code = "service";
  const r = recodeRowCode(edited, "qm", "svc", "service");
  assert.equal(r.problem, undefined);
  assert.ok(r.updated >= 2, `references updated: ${r.updated}`);
  const d = r.def;
  assert.equal(q(d, "qm").rows[0].code, "service");
  assert.equal((q(d, "q3").displayLogic as ConditionRule).source.rowCode, "service");
  assert.equal(visible(d, "q3", { qm: { service: "2" } }), true, "Q3 is shown when Service (now `service`) is rated Great");
  assert.deepEqual((q(d, "qm").rowMask as { expr: { codes: string[] } }).expr.codes, ["service"]);
  assert.match(q(d, "q5").text, /\{\{QM\[service\]/, "the pipe addresses the row by its new code");
  assert.ok(!lintSurveyLogic(d).some((i) => /has no row/.test(i.message)));
  /* the option-coded column of the same cell rule is untouched */
  assert.equal((q(d, "q3").displayLogic as ConditionRule).source.columnId, "2");
});

test("recode refuses a clash and a code nothing holds, and reports why", () => {
  const def = mk();
  const clash = recodeOptionCode(def, "q1", "2", "3");
  assert.equal(clash.updated, 0);
  assert.match(clash.problem ?? "", /already has an option coded 3/);
  assert.equal(clash.def, def);
  const missing = recodeOptionCode(def, "q1", "9", "10");
  assert.match(missing.problem ?? "", /has no option coded 9/);
  const same = recodeOptionCode(def, "q1", "2", "2");
  assert.equal(same.updated, 0);
  assert.equal(same.problem, undefined);
  const rowClash = recodeRowCode(def, "qm", "svc", "prc");
  assert.match(rowClash.problem ?? "", /another row coded prc/);
});

test("a stale code left behind is an ERROR in the lint and is named by canonicalize", () => {
  const def = mk();
  q(def, "q1").options[1].code = "20"; // the raw patch, no recode
  const c = canonicalizeSurveyConditions(def);
  assert.equal(c.unresolved.length, 1);
  assert.match(c.unresolved[0], /Q1 has no option “2”/);
  const stale = lintSurveyLogic(c.def).filter((i) => /has no option coded “2”/.test(i.message));
  assert.ok(stale.length >= 2, "the display rule and the quota cell are both reported");
  assert.ok(stale.every((i) => i.level === "error"));
});

test("a right-hand question reference is not read as a missing option code (LOGIC-10)", () => {
  const def = mk();
  q(def, "q2").displayLogic = parseLogicExpression(def, "Q1 = Q4").condition!;
  assert.ok(!lintSurveyLogic(def).some((i) => /has no option coded/.test(i.message)));
});

test("renumber: a punch's simple codes on the renumbered question move with its options", () => {
  const def = mk();
  const r = renumberQuestionCodes(def, "q1", "options", { "2": "9" });
  assert.deepEqual((q(r.def, "q1").punches[0].source as { codes: string[] }).codes, ["9"]);
});
