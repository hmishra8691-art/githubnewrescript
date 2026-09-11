import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { cloneSurveyDefinition, slugForCode } from "./cloneProject.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState } from "./state.js";
import { compileFlow, visibleQuestions } from "./flow.js";

/**
 * A CLONE IS A SECOND PROJECT, NOT A SECOND COPY OF THE FIRST ONE'S NAMES.
 *
 * The survey below is deliberately awkward: a matrix addressed by row and
 * scale point, display logic and skip logic, a quota whose cell reads an
 * answer, a calculation, carry-forward, piping, an Other-specify option, a
 * loop over a question, a list fill, a named expression, randomization and a
 * translation. Every one of those is a place an id hides.
 */

let n = 0;
const seq = (prefix: string) => `${prefix}_c${(n += 1)}`;

const SOURCE = SurveyDefinition.parse({
  meta: { id: "srv_original", code: "ORIG", title: "Consumer Research Study", version: "1.0" },
  questions: [
    {
      id: "q_brand", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands do you know?",
      options: [
        { id: "opt_a", code: "1", label: "Alpha", flags: [] },
        { id: "opt_b", code: "2", label: "Beta", flags: [] },
        { id: "opt_x", code: "99", label: "Other", flags: ["other_specify"] },
      ],
      rows: [], columns: [], validation: [], required: true,
      settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
      randomization: { mode: "shuffle", groups: [["1", "2"]] },
    },
    {
      id: "q_rate", code: "Q2", variableName: "Q2", type: "matrix_single", text: "Rate {{Q1}}",
      options: [
        { id: "opt_y", code: "Yes", label: "Yes", flags: [] },
        { id: "opt_n", code: "No", label: "No", flags: [] },
      ],
      rows: [
        { id: "row_a", code: "A", label: "Product A", flags: [], validation: [], required: false },
        { id: "row_b", code: "B", label: "Product B", flags: [], validation: [], required: false },
      ],
      columns: [], required: false, settings: { readOnly: false, hidden: false }, listLogic: [],
      validation: [{ id: "val_1", kind: "required", message: "Please rate every product" }],
      /* a reference by question ID, the kind that breaks silently when cloned badly */
      carryForward: { sourceQuestionId: "q_brand", mode: "selected", into: "rows" },
      displayLogic: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "answered" },
      skipLogic: [{
        id: "skip_1",
        when: { type: "rule", source: { kind: "question", ref: "Q2", rowCode: "A", columnId: "No" }, operator: "answered" },
        target: { kind: "question", ref: "q_why" },
      }],
    },
    {
      id: "q_why", code: "Q3", variableName: "Q3", type: "open_text", text: "Why?",
      options: [], rows: [], columns: [], validation: [], required: false,
      settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
      displayLogic: { type: "rule", source: { kind: "rule", ref: "expr_detractor" }, operator: "eq", value: true },
    },
  ],
  flow: [
    { id: "page_1", type: "page", questionIds: ["q_brand"] },
    { id: "block_1", type: "block", title: "Ratings", children: [{ id: "page_2", type: "page", questionIds: ["q_rate", "q_why"] }] },
    { id: "qc_1", type: "quota_check", quotaIds: ["quota_1"], onFull: { kind: "terminate" } },
    { id: "end_1", type: "end", status: "complete" },
  ],
  quotas: [{
    id: "quota_1", name: "Brand", mode: "hard",
    cells: [{ id: "cell_1", label: "Knows Alpha", limit: 100, when: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "containsAny", value: ["1"] } }],
  }],
  calculations: [{ id: "calc_1", targetVariable: "SCORE", expression: "count(Q1)", trigger: "on_page_submit", dataType: "numeric" }],
  namedExpressions: [{ id: "expr_detractor", name: "Detractor", when: { type: "rule", source: { kind: "question", ref: "Q2", rowCode: "A", columnId: "No" }, operator: "answered" } }],
  displayRules: [{ id: "rule_1", target: { kind: "question", ref: "q_why" }, action: "show", when: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "answered" } }],
  localization: {
    sourceLanguage: "en",
    languages: [{ code: "fr", label: "French" }],
    translations: {
      fr: {
        "q:q_brand:text": { text: "Quelles marques connaissez-vous ?", status: "approved" },
        "q:q_brand:opt:1": { text: "Alpha", status: "approved" },
        "q:q_rate:row:A": { text: "Produit A", status: "approved" },
        "flow:page_1:title": { text: "Bienvenue", status: "approved" },
        "quota:quota_1:message": { text: "Quota atteint", status: "approved" },
      },
    },
    audio: [{ id: "aud_1", elementKey: "q:q_brand:text", language: "fr", kind: "ai", url: "https://example.test/a.mp3" }],
  },
});

const clone = () => cloneSurveyDefinition(SOURCE, { surveyId: "srv_copy", code: "ORIG_COPY", title: "Consumer Research Study — Copy", newId: seq });

test("no identifier is shared with the original — the whole point", () => {
  const r = clone();
  assert.deepEqual(r.stowaways, [], `the clone still refers to the original: ${r.stowaways.join(", ")}`);
  assert.equal(r.def.meta.id, "srv_copy");
  assert.equal(r.def.meta.code, "ORIG_COPY");

  const ids = (d: typeof SOURCE) => [
    ...d.questions.map((q) => q.id),
    ...d.questions.flatMap((q) => (q.options ?? []).map((o) => o.id)),
    ...d.questions.flatMap((q) => (q.rows ?? []).map((x) => x.id)),
    ...(d.quotas ?? []).map((q) => q.id),
    ...(d.quotas ?? []).flatMap((q) => q.cells.map((c) => c.id)),
    ...(d.namedExpressions ?? []).map((e) => e.id),
  ].filter(Boolean) as string[];
  const before = new Set(ids(SOURCE));
  for (const id of ids(r.def)) assert.ok(!before.has(id), `${id} is the original's id`);

  /* the flow, which nests */
  const flowIds = JSON.stringify(r.def.flow);
  for (const old of ["page_1", "page_2", "block_1", "qc_1", "end_1"]) {
    assert.ok(!flowIds.includes(old), `${old} survived into the clone's flow`);
  }
});

test("codes, variable names and option codes are NOT changed — the copy is the same survey", () => {
  const r = clone();
  assert.deepEqual(r.def.questions.map((q) => q.code), ["Q1", "Q2", "Q3"]);
  assert.deepEqual(r.def.questions.map((q) => q.variableName), ["Q1", "Q2", "Q3"]);
  assert.deepEqual(r.def.questions[0].options.map((o) => o.code), ["1", "2", "99"]);
  assert.deepEqual(r.def.questions[1].rows.map((x) => x.code), ["A", "B"]);
  assert.equal(r.def.calculations?.[0].targetVariable, "SCORE");
  assert.equal(r.def.calculations?.[0].expression, "count(Q1)", "an expression written in codes needs no rewriting at all");
  assert.equal(r.def.questions[1].text, "Rate {{Q1}}", "and neither does a piping token");
  assert.ok(r.def.questions[0].options.some((o) => o.flags?.includes("other_specify")), "the Other option is still an Other option");
});

test("every reference by ID follows the entity it points at", () => {
  const r = clone();
  const [q1, q2, q3] = r.def.questions;

  assert.equal(r.def.flow[0].type === "page" && r.def.flow[0].questionIds[0], q1.id, "the page holds the CLONE's question");
  const block = r.def.flow[1] as { children: { questionIds: string[] }[] };
  assert.deepEqual(block.children[0].questionIds, [q2.id, q3.id]);

  assert.equal(q2.carryForward?.sourceQuestionId, q1.id, "carry-forward follows its source");
  assert.equal(q2.skipLogic[0].target.ref, q3.id, "a skip target follows its question");
  assert.equal((q3.displayLogic as { source: { ref: string } }).source.ref, r.def.namedExpressions![0].id, "a rule reference follows the rule");
  assert.equal(r.def.displayRules![0].target.ref, q3.id, "a display rule follows its target");
  const qc = r.def.flow[2] as { quotaIds: string[] };
  assert.deepEqual(qc.quotaIds, [r.def.quotas![0].id], "a quota check follows its quota");
});

test("a matrix reference keeps its row and its scale point, which are codes", () => {
  const r = clone();
  const skip = r.def.questions[1].skipLogic[0].when as { source: { ref: string; rowCode: string; columnId: string } };
  assert.equal(skip.source.ref, "Q2");
  assert.equal(skip.source.rowCode, "A");
  assert.equal(skip.source.columnId, "No");

  /* and it still evaluates: the clone's own logic, against the clone's own answers */
  const st = createResponseState(r.def, { seed: 1, sessionId: "t" });
  st.answers[r.def.questions[1].id] = { A: "No", B: "Yes" } as never;
  assert.equal(evaluateCondition(r.def.namedExpressions![0].when, { def: r.def, state: st }), true);
});

test("translation keys are rewritten, so nothing is left translating a question that is not there", () => {
  const r = clone();
  const fr = r.def.localization!.translations.fr;
  const keys = Object.keys(fr);
  assert.ok(!keys.some((k) => k.includes("q_brand") || k.includes("q_rate") || k.includes("page_1") || k.includes("quota_1")),
    `a translation key still names the original: ${keys.join(" | ")}`);
  const q1 = r.def.questions[0].id;
  assert.equal(fr[`q:${q1}:text`]?.text, "Quelles marques connaissez-vous ?", "the question's own text is still translated");
  assert.equal(fr[`q:${q1}:opt:1`]?.text, "Alpha", "and the OPTION CODE inside the key is untouched");
  assert.equal(fr[`q:${r.def.questions[1].id}:row:A`]?.text, "Produit A");
  assert.equal(fr[`flow:${r.def.flow[0].id}:title`]?.text, "Bienvenue");
  assert.equal(fr[`quota:${r.def.quotas![0].id}:message`]?.text, "Quota atteint");
  /* the spoken version of a question points at the same element */
  assert.equal(r.def.localization!.audio[0].elementKey, `q:${q1}:text`, "an audio asset speaks the clone's question, not the original's");
});

test("the clone runs: the flow compiles and its first page shows its own questions", () => {
  const r = clone();
  const st = createResponseState(r.def, { seed: 7, sessionId: "t" });
  const steps = compileFlow(r.def, st);
  const first = steps.find((s) => s.kind === "page")!;
  assert.ok(first, "the cloned flow compiles to at least one page");
  const shown = visibleQuestions(r.def, first as never, st);
  assert.deepEqual(shown.map((q) => q.code), ["Q1"], "and it is the clone's own Q1, reached through the clone's own page id");
  assert.equal(shown[0].id, r.def.questions[0].id);
});

test("a slug is never shared — two projects answering on one address is the original's respondents in the copy", () => {
  const withDeployment = SurveyDefinition.parse({ ...SOURCE, deployment: { studySlug: "orig-study" } });
  const r = cloneSurveyDefinition(withDeployment, { surveyId: "srv_copy", code: "ORIG_COPY", title: "Copy", newId: seq });
  assert.notEqual(r.def.deployment?.studySlug, "orig-study");
  assert.match(slugForCode("ORIG_COPY"), /^orig-copy-/);
});

test("the mapping is reported, one entry per entity, for the audit record", () => {
  const r = clone();
  assert.equal(r.mapping.q_brand, r.def.questions[0].id);
  assert.equal(r.mapping.quota_1, r.def.quotas![0].id);
  assert.ok(r.counts.question >= 3 && r.counts.flowNode >= 4 && r.counts.quotaCell >= 1, JSON.stringify(r.counts));
  assert.ok(r.rewritten > 10, "references were actually rewritten");
});

test("cloning the clone is just as clean — nothing accumulates", () => {
  const once = clone();
  const twice = cloneSurveyDefinition(once.def, { surveyId: "srv_third", code: "C3", title: "Third", newId: seq });
  assert.deepEqual(twice.stowaways, []);
  assert.deepEqual(twice.def.questions.map((q) => q.code), ["Q1", "Q2", "Q3"]);
  for (const q of twice.def.questions) assert.ok(!once.def.questions.some((o) => o.id === q.id));
});
