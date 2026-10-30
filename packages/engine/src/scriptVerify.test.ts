import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { buildScenarios, proposalCodeItems, expectsFromActions, hostPage, scriptDeclarations, fillAnswers, answerShape, codeItemsSignature } from "./scriptVerify.js";

/* S2c item 2 — the scenario builder: deterministic, seeded, derived from what the code declares */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const r = applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "single", text: "Brand?", options: ["Brand A", "Brand B", "Brand C"] },
    { op: "create_question", type: "numeric", text: "Age?" },
    { op: "create_question", type: "text", text: "Why?" },
  ] as SurveyAction[]);
  assert.ok(r.results.every((x) => x.ok), r.results.map((x) => x.error).join("; "));
  return r.def;
})();
const q = (code: string) => base.questions.find((x) => String(x.code) === code)!;

const propose = (actions: unknown[]) => {
  const { actions: a } = coerceSurveyActions(actions);
  const r = applySurveyActions(base, a, {});
  assert.ok(r.results.every((x) => x.ok), r.results.map((x) => x.error).join("; "));
  return { after: r.def, items: proposalCodeItems(base, r.def, expectsFromActions(a)) };
};

test("code items: a new behaviour script, a logic script, the expect hint matched by label; an unchanged survey has none", () => {
  const { after, items } = propose([
    { op: "create_behavior", label: "Q5 highlight", target: "Q1", script: `rs.listen("select", "Q1", function (e) { if (e.option == 2) rs.addClass("Q3", "hl"); });`, expect: { on: "select Q1=2", effect: "class hl on Q3" } },
    { op: "create_logic_script", name: "Seg", event: "on_change", scope: "question", ref: "Q2", code: "if (get('Q2') > 30) setEmbedded('SEG', 'old');" },
  ]);
  assert.deepEqual(items.map((i) => `${i.kind}:${i.label}`), ["behaviour:Q5 highlight", "logic:Seg"]);
  assert.deepEqual(items[0]!.expect, { on: "select Q1=2", effect: "class hl on Q3" });
  assert.equal(items[1]!.questionId, q("Q2").id, "a question-scoped logic script runs on its question's page");
  assert.equal(proposalCodeItems(after, after).length, 0, "nothing new: nothing to run");
  assert.notEqual(codeItemsSignature(items), codeItemsSignature([{ ...items[0]!, code: items[0]!.code + " " }, items[1]!]), "a changed script is verified again");
});

test("declarations: rs.listen events and targets, DOM listeners, hooks, reads and writes, error()", () => {
  const d = scriptDeclarations(`rs.listen("select", "Q1", f); rs.listen("validate", g); var box = document.querySelector('[data-qid="q9"] input'); box.addEventListener("input", h); if (rs.getAnswer("Q2") > 1) rs.setAnswer("H", 1); rs.error("no");`);
  assert.deepEqual(d.listens, [{ event: "select", target: "Q1" }, { event: "validate", target: "self" }]);
  assert.deepEqual(d.domEvents, ["input"]);
  assert.deepEqual(d.hooks, ["q9"]);
  assert.deepEqual(d.reads, ["Q2"]);
  assert.deepEqual(d.writes, ["H"]);
  assert.equal(d.raisesErrors, true);
});

test("a choice trigger: enter, each option once (cap 6), and select-then-clear", () => {
  const { items } = propose([{ op: "create_behavior", label: "hl", target: "Q1", script: `rs.listen("select", "Q1", function (e) { rs.addClass("Q3", "hl"); });` }]);
  const s = buildScenarios(base, items[0]!);
  assert.deepEqual(s.map((x) => x.id), ["enter", "select-Q1-1", "select-Q1-2", "select-Q1-3", "clear-Q1"]);
  assert.equal(s[2]!.label, "select “Brand B” in Q1");
  assert.deepEqual(s[4]!.steps.map((x) => x.do), ["answer", "clear"]);
  const many = buildScenarios(base, items[0]!, { maxOptions: 2 });
  assert.equal(many.filter((x) => x.id.startsWith("select-")).length, 2, "the option cap");
});

test("a numeric trigger: empty, min, max, typical — the declared bounds; seeded and reproducible", () => {
  const def = structuredClone(base);
  def.questions.find((x) => String(x.code) === "Q2")!.validation = [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] as never;
  const item = { key: "behaviour:x", kind: "behaviour" as const, id: "x", label: "age", code: `rs.listen("change", "self", function () {});`, questionId: q("Q2").id };
  const a = buildScenarios(def, item, { seed: 7 }), b = buildScenarios(def, item, { seed: 7 }), c = buildScenarios(def, item, { seed: 8 });
  assert.deepEqual(a.map((x) => x.id), ["enter", "empty-Q2", "min-Q2", "max-Q2", "typical-Q2"]);
  assert.deepEqual(a, b, "the same seed, the same scenarios");
  const val = (s: typeof a, id: string) => (s.find((x) => x.id === id)!.steps[0] as { value: number }).value;
  assert.equal(val(a, "min-Q2"), 18); assert.equal(val(a, "max-Q2"), 99);
  assert.ok(val(a, "typical-Q2") >= 18 && val(a, "typical-Q2") <= 99);
  assert.ok(c.length === a.length, "another seed: the same shape");
});

test("validate / submit: Next with valid answers, and with invalid-looking ones where a rule exists; a text trigger", () => {
  const item = { key: "behaviour:v", kind: "behaviour" as const, id: "v", label: "v", code: `rs.listen("validate", function () { if (!rs.getAnswer("Q3")) rs.error("say why", "Q3"); });`, questionId: q("Q3").id };
  const s = buildScenarios(base, item);
  assert.deepEqual(s.map((x) => x.id), ["enter", "empty-Q3", "short-Q3", "typical-Q3", "next-valid", "next-invalid"]);
  assert.deepEqual(s.at(-1)!.steps.map((x) => x.do), ["fill", "next"]);
  const quiet = buildScenarios(base, { ...item, code: `rs.listen("submit", function () { rs.log("bye"); });` });
  assert.deepEqual(quiet.map((x) => x.id), ["enter", "next-valid", "next-invalid"], "the page has a rule (Q2's integer check): Next twice");
  const bare = structuredClone(base);
  for (const x of bare.questions) x.validation = [];
  assert.deepEqual(buildScenarios(bare, { ...item, code: `rs.listen("submit", function () { rs.log("bye"); });` }).map((x) => x.id), ["enter", "next-valid"], "no rule anywhere: Next once, with valid answers");
  assert.equal(answerShape(q("Q1")), "single");
  const fill = fillAnswers(base, [q("Q1").id, q("Q2").id, q("Q3").id], true, 1);
  assert.equal(fill[q("Q1").id], 1); assert.equal(typeof fill[q("Q2").id], "number"); assert.equal(fill[q("Q3").id], "A typical answer");
  assert.deepEqual(Object.values(fillAnswers(base, [q("Q1").id, q("Q3").id], false)), [null, null]);
});

test("logic scripts: on_load enters the page; on_change plays its question; on_validate presses Next; a page in a loop gets two iterations", () => {
  const { items } = propose([{ op: "create_logic_script", name: "Seg", event: "on_change", scope: "question", ref: "Q2", code: "if (get('Q2') > 30) setEmbedded('SEG', 'old');" }]);
  assert.deepEqual(buildScenarios(base, items[0]!).map((x) => x.id), ["enter", "empty-Q2", "min-Q2", "max-Q2", "typical-Q2"]);
  assert.deepEqual(buildScenarios(base, { ...items[0]!, event: "on_load" }).map((x) => x.id), ["enter", "empty-Q2", "min-Q2", "max-Q2", "typical-Q2"], "it reads Q2: Q2 is still played");
  assert.deepEqual(buildScenarios(base, { ...items[0]!, event: "on_validate", code: "error('x')" }).map((x) => x.id), ["enter", "next-valid", "next-invalid"], "reads nothing, listens to nothing on the page: only Next");
  const page = hostPage(base, { questionId: q("Q2").id })!;
  const looped = structuredClone(base);
  const at = (looped.flow as { type: string; id: string }[]).findIndex((n) => n.type !== "end");
  (looped.flow as unknown[]).splice(at, 1, { type: "loop", id: "lp1", source: { kind: "static", items: [{ code: "a", label: "A" }, { code: "b", label: "B" }] }, children: [(base.flow as unknown[])[at]] });
  const lp = hostPage(looped, { questionId: q("Q2").id });
  assert.equal(lp?.loopId, "lp1");
  assert.deepEqual(buildScenarios(looped, items[0]!).slice(0, 2).map((x) => [x.id, x.iteration ?? 0]), [["enter", 0], ["enter-2", 1]], "the first two iterations");
  assert.equal(page.questionIds.length, 3);
});
