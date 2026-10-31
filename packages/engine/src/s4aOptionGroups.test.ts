import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, SURVEY_ACTION_OPS, type SurveyAction } from "./surveyActions.js";
import { groupSegments } from "./optionGroups.js";
import { cascadeChildren, cascadeParentOf, cascadeProblems, lintCascade, CASCADING_VARIANT } from "./cascade.js";
import { validateQuestion } from "./validate.js";
import { flattenVariables } from "./flatten.js";
import { buildVariableDictionary } from "./variables.js";
import { effectiveQuestion } from "./carryforward.js";
import { nativeRouteFor, settableSettings } from "./capabilityRegistry.js";
import { createResponseState } from "./state.js";

/* S4a item 3 — AQ-08: option-group headings / collapsible groups, and the cascading dropdown */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "single", text: "Favourite fruit?", options: ["Apple", "Pear", "Carrot", "Leek", "None of these"] },
  ] as SurveyAction[]).def;
})();
const run = (raw: unknown[], def = base) => { const c = coerceSurveyActions(raw); return { c, r: applySurveyActions(def, c.actions) }; };

test("AQ-08: set_option_groups is in the vocabulary and writes groups with label + display", () => {
  assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes("set_option_groups"));
  const { c, r } = run([{ op: "set_option_groups", target: "Q1", groups: [
    { name: "Fruit", label: "Fruit", display: "heading", members: [1, 2] },
    { name: "Veg", label: "Vegetables", display: "collapsible", members: ["Carrot", 4] },
  ] }]);
  assert.equal(c.actions.length, 1, JSON.stringify(c.rejected));
  assert.ok(r.results[0].ok, r.results[0].error);
  const q = r.def.questions[0];
  assert.deepEqual(q.optionGroups?.map((g) => [g.name, g.label, g.display, g.members.map(String)]), [["Fruit", "Fruit", "heading", ["1", "2"]], ["Veg", "Vegetables", "collapsible", ["3", "4"]]]);
  assert.match(r.results[0].description ?? "", /shown to respondents: Fruit \(heading\), Veg \(collapsible\)/);
  // re-setting keeps the group ids (the randomization seed key)
  const ids = q.optionGroups!.map((g) => g.id);
  const again = run([{ op: "set_option_groups", target: "Q1", groups: [{ name: "Fruit", members: [1, 2] }, { name: "Veg", members: [3, 4] }] }], r.def).r;
  assert.deepEqual(again.def.questions[0].optionGroups!.map((g) => g.id), ids);
  assert.equal(again.def.questions[0].optionGroups![0].display, undefined, "no display asked = none (today's behaviour)");
});

test("AQ-08: set_option_groups refuses unknown members and an empty spec; clear removes", () => {
  assert.equal(run([{ op: "set_option_groups", target: "Q1", groups: [{ name: "X", members: [42] }] }]).r.results[0].ok, false);
  assert.ok(coerceSurveyActions([{ op: "set_option_groups", target: "Q1" }]).rejected.length === 1);
  const made = run([{ op: "set_option_groups", target: "Q1", groups: [{ name: "Fruit", label: "Fruit", display: "heading", members: [1, 2] }] }]).r.def;
  const cleared = run([{ op: "set_option_groups", target: "Q1", clear: true }], made).r;
  assert.ok(cleared.results[0].ok);
  assert.equal(cleared.def.questions[0].optionGroups?.length ?? 0, 0);
});

test("AQ-08: groupSegments — one run per shown group; none / no label = the old flat list", () => {
  const made = run([{ op: "set_option_groups", target: "Q1", groups: [
    { name: "Fruit", label: "Fruit", display: "heading", members: [1, 2] },
    { name: "Veg", label: "Vegetables", display: "collapsible", members: [3, 4] },
  ] }]).r.def;
  const q = made.questions[0];
  const state = createResponseState(made, { seed: 1 });
  const shown = effectiveQuestion(q, { def: made, state }).options;
  const segs = groupSegments(q, "options", shown);
  assert.deepEqual(segs.map((s) => [s.groupId ? s.label : null, s.display, s.items.map((o) => String(o.code))]), [["Fruit", "heading", ["1", "2"]], ["Vegetables", "collapsible", ["3", "4"]], [null, "none", ["99"]]]);
  const plain = { ...q, optionGroups: q.optionGroups!.map((g) => ({ ...g, display: "none" as const })) } as Question;
  assert.equal(groupSegments(plain, "options", shown).length, 1, "display none everywhere → one flat segment");
  const noLabel = { ...q, optionGroups: q.optionGroups!.map((g) => ({ ...g, label: undefined })) } as Question;
  assert.equal(groupSegments(noLabel, "options", shown).length, 1, "no label → nothing to draw");
});

const cascadeDef = () => run([{ op: "create_question", type: CASCADING_VARIANT, text: "Where do you live?", code: "Q2",
  settings: { cascadeParents: [{ code: "IN", label: "India" }, { code: "US", label: "United States" }], cascadeParentLabel: "Country", cascadeChildLabel: "State" },
  options: [{ label: "Maharashtra", code: 1, parent: "IN" }, { label: "Kerala", code: 2, parent: "IN" }, { label: "Texas", code: 3, parent: "US" }] }]);

test("AQ-08: create_question builds a cascading dropdown (settings + options with meta.parent) and the registry routes it", () => {
  const { c, r } = cascadeDef();
  assert.equal(c.actions.length, 1, JSON.stringify(c.rejected));
  assert.ok(r.results[0].ok, r.results[0].error);
  const q = r.def.questions.find((x) => x.code === "Q2")!;
  assert.equal(q.variant, CASCADING_VARIANT);
  assert.equal(q.type, "dropdown");
  assert.deepEqual(q.options.map((o) => [o.code, o.meta?.parent]), [[1, "IN"], [2, "IN"], [3, "US"]]);
  assert.deepEqual((q.settings as { cascadeParents?: unknown[] }).cascadeParents?.length, 2);
  assert.deepEqual(lintCascade(q), []);
  for (const k of ["cascadeParents", "cascadeParentLabel", "cascadeChildLabel"]) assert.ok(settableSettings(CASCADING_VARIANT).includes(k), k);
  assert.equal(nativeRouteFor("a cascading dropdown: country then state")?.id, "cascading_dropdown");
  assert.equal(nativeRouteFor("put headings above the option groups")?.id, "option_groups");
});

test("AQ-08: cascade — children filtered by parent, parent derived, a child of another parent refused", () => {
  const def = cascadeDef().r.def;
  const q = def.questions.find((x) => x.code === "Q2")!;
  assert.deepEqual(cascadeChildren(q.options, "IN").map((o) => o.code), [1, 2]);
  assert.equal(cascadeParentOf(q, 3), "US");
  assert.equal(cascadeParentOf(q, "2"), "IN");
  assert.equal(cascadeParentOf(q, 9), null);
  assert.deepEqual(cascadeProblems(q, 2, "IN"), []);
  assert.match(cascadeProblems(q, 3, "IN")[0], /does not belong to “India”/);
  assert.match(cascadeProblems(q, 9, null)[0], /not one of the choices/);
  const state = createResponseState(def, { seed: 1 });
  state.answers[q.id] = 3; state.answers[`${q.id}__parent`] = "IN";
  const errs = validateQuestion(def, q, 3, { def, state });
  assert.ok(errs.some((e) => /does not belong/.test(e.message)), JSON.stringify(errs));
  state.answers[`${q.id}__parent`] = "US";
  assert.deepEqual(validateQuestion(def, q, 3, { def, state }).filter((e) => /belong/.test(e.message)), []);
  // an orphan option is linted
  const orphan = { ...q, options: [...q.options, { code: 4, label: "Nowhere", flags: [] }] } as Question;
  assert.match(lintCascade(orphan).join(" "), /name no parent/);
});

test("AQ-08: export — VAR (the child) and VAR_PARENT derived from the definition, declared in the dictionary", () => {
  const def = cascadeDef().r.def;
  const q = def.questions.find((x) => x.code === "Q2")!;
  const state = createResponseState(def, { seed: 1 });
  state.answers[q.id] = 3;
  state.answers[`${q.id}__parent`] = "IN"; // a tampered side value does not reach the export
  const flat = flattenVariables(def, state);
  assert.equal(flat[q.variableName], 3);
  assert.equal(flat[`${q.variableName}_PARENT`], "US");
  assert.ok(!Object.keys(flat).some((k) => /__parent/.test(k)), "the side key is not exported raw");
  const dict = buildVariableDictionary(def);
  assert.ok(dict.some((v) => v.name === `${q.variableName}_PARENT`), "the dictionary declares VAR_PARENT");
});
