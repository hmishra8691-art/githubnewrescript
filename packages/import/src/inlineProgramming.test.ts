import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSurveyLogic } from "@rescript/engine";
import { analyzeImport } from "./index.js";

/**
 * INTELLIGENT ENGINE — QUESTIONNAIRE FIDELITY (2026-11-10).
 *
 * Four things a programmer's questionnaire does that the reader used to get wrong, each of which changed what a
 * respondent saw or how the survey routed, with nothing said:
 *   1  programming written on the question's own line stayed in the question text and its logic was never read
 *   2  a referenced picture that is not in the file vanished (now: a placeholder, a high-severity finding, and a
 *      standing check on the survey — nothing invented)
 *   3  "RANDOMIZE" shuffled Other / None / Don't know with the substantive answers
 *   4  special answers were flagged "exclusive" on single-choice questions, a setting that type does not offer
 */
const DOC = `Customer survey

Q1. Which of these brands have you heard of? (Select all that apply) [RANDOMIZE]
1. Alpha
2. Beta
3. Gamma
4. Other (please specify)
5. None of the above
6. Don't know

Q2. How satisfied are you with Alpha? (ASK IF Q1 = Alpha)
1. Very dissatisfied
2. Satisfied
3. Very satisfied
98. Prefer not to say
99. Not applicable

Q3. Please look at the picture below and tell us what you think. [SHOW IMAGE: pack_shot.png]

Q4. How old are you?

Q5. Which do you prefer? (ASK IF Q9 = 2)
1. Option one
2. Option two
3. No preference
`;
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const load = async () => { const a = await analyzeImport(new TextEncoder().encode(DOC), "survey.txt", { surveyId: "s1", uid }); return { a, def: a.result!.def!, issues: [...a.issues, ...a.result!.issues] }; };
const q = (def: { questions: { code: string }[] }, code: string) => def.questions.find((x) => x.code === code)! as unknown as { text: string; type: string; displayLogic?: unknown; options: { label: string; flags?: string[] }[]; randomization?: { enabled?: boolean } };

test("programming on the question's own line is read as logic and is not shown to respondents", async () => {
  const { def, issues } = await load();
  assert.equal(q(def, "Q2").text, "How satisfied are you with Alpha?");
  assert.deepEqual(q(def, "Q2").displayLogic, { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 1 });
  assert.equal(q(def, "Q1").text, "Which of these brands have you heard of? (Select all that apply)", "respondent wording in brackets stays");
  assert.equal(q(def, "Q1").type, "multi_select");
  /* a reference to a question the document does not have is reported, not guessed */
  assert.equal(q(def, "Q5").text, "Which do you prefer?");
  assert.equal(q(def, "Q5").displayLogic, undefined);
  assert.ok(issues.some((i) => i.severity === "high" && /Q9 is not a question in the document/.test(i.message)));
});

test("a picture the questionnaire refers to but does not include: a placeholder, a finding, a standing check — nothing invented", async () => {
  const { def, issues } = await load();
  assert.match(q(def, "Q3").text, /^Please look at the picture below and tell us what you think\.\s*<p><em>\[Image to add: pack_shot\.png\]<\/em><\/p>$/);
  assert.ok(!/<img/i.test(q(def, "Q3").text), "no picture was made up");
  const found = issues.find((i) => /pack_shot\.png/.test(i.message) && i.severity === "high")!;
  assert.match(found.message, /not in the document.*nothing was substituted/);
  assert.match(String(found.suggestion), /Upload the file in Assets/);
  const lint = lintSurveyLogic(def).filter((i) => /placeholder/.test(i.message));
  assert.equal(lint.length, 1);
  assert.match(lint[0].message, /Q3 still shows a placeholder for an image.*pack_shot\.png.*before fielding/);
  /* once the placeholder is replaced the check is silent */
  const fixed = structuredClone(def);
  (fixed.questions.find((x) => x.code === "Q3") as { text: string }).text = "Please look at the picture below.";
  assert.equal(lintSurveyLogic(fixed).filter((i) => /placeholder/.test(i.message)).length, 0);
});

test("RANDOMIZE shuffles the substantive answers; Other, None and Don't know keep their place", async () => {
  const { def, issues } = await load();
  const o = q(def, "Q1").options;
  assert.equal(q(def, "Q1").randomization?.enabled, true);
  assert.deepEqual(o.slice(0, 3).map((x) => x.flags ?? []), [[], [], []]);
  assert.deepEqual(o.slice(3).map((x) => [x.label, [...(x.flags ?? [])].sort()]), [["Other", ["anchor_bottom", "other_specify"]], ["None of the above", ["anchor_bottom", "exclusive"]], ["Don't know", ["anchor_bottom", "exclusive"]]]);
  assert.ok(issues.some((i) => /kept fixed at the end; the other options are randomized/.test(i.message)), "the assumption is said, and the clarification can change it");
});

test("special answers are exclusive in a multiple choice, and carry no such flag on a single choice", async () => {
  const { def, issues } = await load();
  assert.deepEqual(q(def, "Q2").options.map((x) => x.flags ?? []), [[], [], [], [], []]);
  assert.deepEqual(q(def, "Q5").options.map((x) => x.flags ?? []), [[], [], []]);
  assert.ok(!issues.some((i) => /this type does not offer them/.test(i.message)));
});
