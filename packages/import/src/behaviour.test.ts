import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImport } from "./index.js";
import { readBehaviour } from "./adapters/behaviour.js";
import { createResponseState, start, advance, validateQuestion } from "@rescript/engine";
import { SurveyDefinition } from "@rescript/schema";

/*
 * THE BEHAVIOUR CORPUS (audit 2026-11-17, ERR-03 to ERR-06). A healthcare-style questionnaire whose instructions say
 * how fields behave. Each expectation is the setting the engine already supports; before this, Q3 and Q5 became
 * display text, Q2's check and Q4's total were lost, and only one of the four drops was reported.
 */
const HEALTHCARE = `S1. What is your medical specialty?
1. Cardiologist
2. Oncologist
3. Other (please specify)
Q1. How many patients do you see per month?
PROGRAMMER NOTE: NUMERIC, RANGE 1-999. MUST BE ANSWERED.
Q2. Of these patients, how many have heart failure?
PROGRAMMER NOTE: MUST BE LESS THAN OR EQUAL TO Q1.
Q3. Your specialty
PROGRAMMER NOTE: AUTO-POPULATE WITH THE ANSWER FROM S1 AND MAKE IT READ-ONLY.
Q4. Total percentage of patients by treatment
1. Drug A
2. Drug B
PROGRAMMER NOTE: CONSTANT SUM, MUST ADD TO 100%. SHOW RUNNING TOTAL.
Q5. Date of interview
PROGRAMMER NOTE: HIDDEN. PRE-FILL WITH TODAY'S DATE.
Q6. Specialty confirmed by the panel
PROGRAMMER NOTE: AUTO-POPULATE FROM THE PREVIOUS QUESTION.
`;

const imported = async (text: string) => {
  const r = await analyzeImport(new TextEncoder().encode(text), "spec.txt", { surveyId: "hc" });
  const def = r.result!.def!;
  return { r, def, q: (code: string) => def.questions.find((x) => x.code === code)! };
};

test("each behaviour instruction becomes the engine setting it names", async () => {
  const { q } = await imported(HEALTHCARE);
  assert.deepEqual(q("Q1").validation.map((v) => [v.kind, v.value]), [["min_value", 1], ["max_value", 999]]);
  assert.deepEqual(q("Q2").validation.map((v) => [v.kind, v.value]), [["custom_expression", "value <= Q1"]], "the cross-question check, by variable name");
  assert.equal(q("Q3").type, "open_text", "a field filled from S1 is a field, not display text");
  assert.equal(q("Q3").settings.readOnly, true);
  assert.equal(q("Q3").settings.defaultValue, "{{S1}}");
  assert.equal(q("Q4").type, "allocation");
  assert.deepEqual(q("Q4").validation.map((v) => [v.kind, v.value]), [["sum_equals", 100]]);
  assert.equal((q("Q4").settings as { sumTarget?: number }).sumTarget, 100);
  assert.equal(q("Q5").type, "calculated", "hidden with a value is computed, never shown");
  assert.equal(q("Q5").settings.expression, "today()");
  assert.equal(q("Q5").settings.hidden, true);
});

test("a fill source the document does not name is asked, not guessed", async () => {
  const { r, q } = await imported(HEALTHCARE);
  assert.equal(q("Q6").settings.defaultValue, undefined);
  const asked = r.result!.issues.filter((i) => i.severity === "high" && i.refs?.includes("Q6"));
  assert.equal(asked.length, 1, JSON.stringify(r.result!.issues));
  assert.match(asked[0].message, /fill this field automatically/);
  assert.ok(!r.result!.issues.some((i) => i.type === "dropped" && /READ-ONLY|LESS THAN|PRE-FILL|ADD TO 100/.test(i.message)), "no behaviour instruction is reported as dropped any more");
});

test("the imported survey behaves: S1 fills Q3, Q5 holds today's date, Q2 above Q1 is refused", async () => {
  const { def } = await imported(HEALTHCARE);
  const d = SurveyDefinition.parse(def);
  const id = (code: string) => d.questions.find((x) => x.code === code)!.id;
  const st = createResponseState(d);
  start(d, st);
  st.answers[id("S1")] = 2;
  st.answers[id("Q1")] = 40;
  for (let i = 0; i < 4; i++) advance(d, st, {});
  assert.equal(st.answers[id("Q3")], "Oncologist", "the read-only field carries S1's answer");
  assert.equal(typeof st.answers[id("Q5")], "number", "today's date, computed");
  const q2 = d.questions.find((x) => x.code === "Q2")!;
  st.answers[id("Q2")] = 55;
  const errs = validateQuestion(d, q2, st.answers[id("Q2")], { def: d, state: st } as never);
  assert.ok(errs.length > 0, "55 heart-failure patients out of 40 is refused");
  st.answers[id("Q2")] = 12;
  assert.equal(validateQuestion(d, q2, 12, { def: d, state: st } as never).length, 0);
});

test("the reader's vocabulary: fills, locks, hides, comparisons and totals; logic and plain notes are not behaviour", () => {
  const self = { sourceId: "Q9" } as never;
  const by = new Map([["Q1", { sourceId: "Q1" }], ["S2", { sourceId: "S2" }]]) as never;
  const r = (t: string) => readBehaviour(t, self, by);
  assert.deepEqual(r("PRE-POPULATE FROM S2, NOT EDITABLE")?.prefill, { kind: "question", ref: "S2" });
  assert.equal(r("PRE-POPULATE FROM S2, NOT EDITABLE")?.readOnly, true);
  assert.deepEqual(r("DEFAULT TO \"Unknown\"")?.prefill, { kind: "static", value: "Unknown" });
  assert.deepEqual(r("AUTO-FILL WITH THE CURRENT DATE")?.prefill, { kind: "today" });
  assert.equal(r("HIDDEN VARIABLE")?.hidden, true);
  assert.deepEqual(r("CANNOT EXCEED Q1")?.compare?.map((c) => c.op), ["<="]);
  assert.deepEqual(r("MUST BE AT LEAST Q1")?.compare?.map((c) => c.op), [">="]);
  assert.deepEqual(r("MUST BE GREATER THAN THE ANSWER AT Q1")?.compare?.map((c) => c.op), [">"]);
  assert.equal(r("RESPONSES MUST SUM TO 10")?.total, 10);
  assert.match(r("MUST NOT EXCEED Q77")!.unclear[0], /compared with Q77 .*which is not a question/);
  assert.equal(r("RANDOMIZE OPTIONS"), null);
  assert.equal(r("Show the logo above"), null);
});

test("an auto-fill with no named source becomes a clarification; the answer fills the field (audit P1-01)", async () => {
  const { clarifications, applyDecisions, mapCanonical } = await import("./index.js");
  const doc = "S1. What is your medical specialty?\n1. Cardiology\n2. Oncology\nQ1. Specialty on file\nPROGRAMMER NOTE: AUTO-POPULATE FROM THE PREVIOUS QUESTION. READ-ONLY.\n";
  const r = await analyzeImport(new TextEncoder().encode(doc), "fill.txt", { surveyId: "f" });
  const asks = clarifications(r.canonical!);
  const fill = asks.find((a) => a.kind === "fill_source");
  assert.ok(fill, JSON.stringify(asks.map((a) => a.kind)));
  assert.match(fill.question, /Where does Q1 get its value\?/);
  assert.match(fill.recommended?.label ?? "", /answer to S1/, "“the previous question” is recommended as S1");
  assert.ok(fill.alternatives.some((a) => /today's date/.test(a.label)) && fill.alternatives.some((a) => /Leave it/.test(a.label)));
  const done = applyDecisions(r.canonical!, [fill.recommended!.decision]);
  assert.deepEqual(done.rejected, []);
  const def = mapCanonical(done.canonical, { surveyId: "f" }).def!;
  const q1 = def.questions.find((x) => x.code === "Q1")!;
  assert.equal(q1.type, "open_text", "a field, not display text");
  assert.equal(q1.settings.defaultValue, "{{S1}}");
  assert.equal(q1.settings.readOnly, true);
});

test("no prompt-injection corpus payload, written as a programmer note, changes how a field behaves", async () => {
  const { readFileSync } = await import("node:fs");
  const corpus = JSON.parse(readFileSync(new URL("../../engine/src/fixtures/prompt-injection-corpus.json", import.meta.url), "utf8")) as { payloads: (string | { text?: string })[] };
  const by = new Map([["Q1", { sourceId: "Q1" }], ["S1", { sourceId: "S1" }]]) as never;
  const moved = corpus.payloads.map((p) => (typeof p === "string" ? p : p.text ?? "")).filter((t) => t && readBehaviour(t, { sourceId: "Q9" } as never, by));
  assert.deepEqual(moved, []);
  assert.equal(readBehaviour("HIDDEN VARIABLE", { sourceId: "Q9" } as never, by)?.hidden, true, "a real hidden-field note still reads");
  assert.equal(readBehaviour("MAKE THIS QUESTION HIDDEN", { sourceId: "Q9" } as never, by)?.hidden, true);
});
