import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition as SurveyDefinitionSchema, type SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, parseSurveyIncrementally } from "./surveyActions.js";

/*
 * P1 (2026-11-27): an edit parses only the questions it changed. These hold that to the full parse — the same
 * success, the same normalised survey, the same issues — for changes the schema normalises, changes it refuses, new
 * questions, removed ones, a changed id, and a change outside the questions; and that a chain of edits returns what
 * it returned when every edit parsed the whole survey.
 */

function survey(n = 40): SurveyDefinition {
  const scale = [1, 2, 3, 4, 5].map((c) => ({ code: String(c), label: `Point ${c}` }));
  const questions: Record<string, unknown>[] = [];
  const pages: Record<string, unknown>[] = [];
  for (let i = 1; i <= n; i++) {
    const kind = ["single_select", "multi_select", "numeric", "open_text"][i % 4];
    const q: Record<string, unknown> = { id: `q${i}`, code: `Q${i}`, variableName: `Q${i}`, type: kind, text: `Question ${i}` };
    if (kind === "single_select" || kind === "multi_select") q.options = scale;
    if (i > 3 && i % 4 === 0) q.displayLogic = { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "q2", count: { where: { type: "rule", source: { kind: "option", ref: "code" }, operator: "ne", value: "1" } } }, operator: "gte", value: 1 }] };
    questions.push(q);
    pages.push({ type: "page", id: `p${i}`, questionIds: [`q${i}`] });
  }
  return SurveyDefinitionSchema.parse({ meta: { id: "parse-test", code: "PT", title: "Parse test", version: "1.0" }, questions, flow: [...pages, { type: "end", id: "end", status: "complete" }] });
}

const judged = (def: SurveyDefinition) => ({ normalized: def, errors: new Set<string>() });
const issueSet = (r: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => `${i.path.join(".")}|${i.message}`).sort());

function same(raw: SurveyDefinition, prior: SurveyDefinition, label: string) {
  const full = SurveyDefinitionSchema.safeParse(structuredClone(raw));
  const inc = parseSurveyIncrementally(structuredClone(raw), judged(prior));
  assert.equal(inc.success, full.success, `${label}: success`);
  if (full.success && inc.success) assert.equal(JSON.stringify(inc.data), JSON.stringify(full.data), `${label}: the normalised survey`);
  assert.deepEqual(issueSet(inc as never), issueSet(full as never), `${label}: the issues`);
}

test("the incremental parse equals the full parse, change by change", () => {
  const base = survey();
  const mutate = (label: string, f: (d: any) => void) => { const d = structuredClone(base) as any; f(d); same(d, base, label); };
  mutate("nothing changed", () => {});
  mutate("a text", (d) => { d.questions[5].text = "Changed"; });
  mutate("a field the schema defaults", (d) => { delete d.questions[7].options[0].label; });
  mutate("a numeric code the schema turns into text", (d) => { d.questions[4].options[2].code = 3; });
  mutate("an unknown key, stripped", (d) => { d.questions[9].notAField = true; });
  mutate("a type that does not exist", (d) => { d.questions[3].type = "not_a_type"; });
  mutate("two broken questions", (d) => { d.questions[2].text = 5; d.questions[30].type = 7; });
  mutate("a condition broken deep inside", (d) => { d.questions[7].displayLogic.children[0].operator = "approximately"; });
  mutate("a new question", (d) => { d.questions.push({ id: "qn", code: "QN", variableName: "QN", type: "open_text", text: "New" }); });
  mutate("a question removed", (d) => { d.questions.splice(10, 1); });
  mutate("an id changed", (d) => { d.questions[4].id = "q4b"; });
  mutate("a duplicated id", (d) => { d.questions[6] = { ...d.questions[5] }; });
  mutate("a change outside the questions", (d) => { d.meta.title = 9; });
  mutate("a broken page and a broken question", (d) => { d.flow[0].questionIds = "q1"; d.questions[0].type = "nope"; });
  mutate("questions missing", (d) => { delete d.questions; });
});

test("a prior survey that was not normalised: a question differing from its normalised form is parsed", () => {
  const raw = structuredClone(survey(10)) as any;
  raw.questions[0].options[0].code = 1;
  const normalised = SurveyDefinitionSchema.parse(structuredClone(raw));
  const inc = parseSurveyIncrementally(structuredClone(raw), judged(normalised));
  const full = SurveyDefinitionSchema.parse(structuredClone(raw));
  assert.ok(inc.success);
  assert.equal(JSON.stringify(inc.success && inc.data), JSON.stringify(full));
  assert.equal(parseSurveyIncrementally(structuredClone(raw), null).success, true, "with nothing known, the whole survey is parsed");
});

test("a chain of edits returns the same surveys and messages as edits judged from scratch", () => {
  const edits: Parameters<typeof applySurveyActions>[1][] = [
    [{ op: "update_question", target: "Q12", required: true } as never],
    [{ op: "update_question", target: "Q13", text: "What else?" } as never],
    [{ op: "update_question", target: "Q14", type: "not_a_type" } as never],
    [{ op: "delete_question", target: "Q20" } as never],
    [{ op: "update_question", target: "Q22", required: false } as never],
  ];
  let chained = survey();
  let fresh = survey();
  for (const batch of edits) {
    const a = applySurveyActions(chained, batch, { now: "2026-11-27T00:00:00.000Z" });
    /* a structurally equal copy is a new object: nothing is known about it, so it is judged and parsed from scratch */
    const b = applySurveyActions(JSON.parse(JSON.stringify(fresh)), batch, { now: "2026-11-27T00:00:00.000Z" });
    assert.equal(JSON.stringify(a.def), JSON.stringify(b.def), `${JSON.stringify(batch)}: the survey`);
    assert.deepEqual(a.errors, b.errors);
    assert.deepEqual(a.warnings, b.warnings);
    assert.equal(a.structureUnchanged, b.structureUnchanged);
    chained = a.def; fresh = b.def;
  }
});

test("the caller's survey is never edited, even when the first action is refused and undone", () => {
  const def = survey(10);
  const before = JSON.stringify(def);
  const out = applySurveyActions(def, [{ op: "update_question", target: "Q99", required: true } as never, { op: "update_question", target: "Q2", text: "Edited" } as never]);
  assert.equal(JSON.stringify(def), before);
  assert.ok(out.errors.length >= 1);
  assert.equal(out.def.questions.find((q) => q.code === "Q2")?.text, "Edited");
  assert.notEqual(out.def, def);
});
