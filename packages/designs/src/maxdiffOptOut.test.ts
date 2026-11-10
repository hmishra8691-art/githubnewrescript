import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import {
  applySurveyActions, coerceSurveyActions, createResponseState, flattenVariables, buildVariableDictionary,
  designVersionFor, validateQuestion, blockingErrors, maxdiffOptOutsOf, maxdiffTaskOptOut,
} from "@rescript/engine";
import { registerBuiltinDesignGenerators, maxdiffPlugin, type MaxDiffConfig } from "./index.js";

/*
 * MAXDIFF TASK OPT-OUTS (2026-11-10): "None of these", "No preference", "I cannot choose".
 *
 * Pinned here, because each is a way the feature could quietly corrupt a study:
 *   - an opt-out is NOT an item: it adds no row to the design, changes no count, and a design with opt-outs is the
 *     same design as one without
 *   - it answers a set for a required question, and only a kind the DESIGN offers counts
 *   - the data map and the flattened response carry it as its own variable, with best / worst empty
 *   - the builder action turns it on and off without touching the generated sets
 */
registerBuiltinDesignGenerators();

const ITEMS = ["Battery life", "Camera", "Screen size", "Price", "Brand", "Storage", "Waterproof", "Weight"];
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Phones", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const run = (def: SurveyDefinition, raw: unknown[]) => { const c = coerceSurveyActions(raw); assert.deepEqual(c.rejected, []); return applySurveyActions(def, c.actions, { ids, now: "2026-11-10T00:00:00.000Z" }); };
const md = (def: SurveyDefinition) => def.questions.find((q) => q.type === "maxdiff_task")!;
const designOf = (def: SurveyDefinition, q: Question) => def.designs.find((d) => d.id === (q.settings as { designRef?: string }).designRef)!;

test("an opt-out is a switch on the design, never an item: the generated sets and every count are unchanged", () => {
  const base: MaxDiffConfig = { items: ITEMS, itemsPerTask: 4, tasks: 6, versions: 3 };
  const plain = maxdiffPlugin.generate(base, 11);
  const withOpt = maxdiffPlugin.generate({ ...base, optOutNone: true, optOutNoPreference: true, optOutCannotChoose: true, optOutNoneLabel: "None of the above" }, 11);
  assert.deepEqual(withOpt.rows, plain.rows);
  assert.deepEqual(withOpt.columns, plain.columns);
  assert.deepEqual(withOpt.summary!.itemShowCounts, plain.summary!.itemShowCounts);
  assert.ok(!withOpt.rows.some((r) => /none|preference|cannot/i.test(String(r.item_label))), "no opt-out appears among the items");
  assert.deepEqual(withOpt.summary!.optOuts, [{ kind: "none", label: "None of the above" }, { kind: "no_preference", label: "No preference between these" }, { kind: "cannot_choose", label: "I cannot choose" }]);
  assert.equal(plain.summary!.optOuts, undefined, "a standard design does not carry the key");
  assert.deepEqual(maxdiffOptOutsOf({ items: ITEMS }), []);
});

test("create_maxdiff / update_maxdiff turn opt-outs on and off; the sets are not regenerated differently", () => {
  const r = run(empty(), [{ op: "create_maxdiff", items: ITEMS, perTask: 4, tasks: 6, versions: 2, seed: 5, optOuts: ["None of the above", "no preference"], optOutLabels: { none: "None of the above" } }]);
  assert.deepEqual(r.errors, []);
  const q = md(r.def), d = designOf(r.def, q);
  assert.deepEqual(maxdiffOptOutsOf(d.config).map((o) => `${o.kind}:${o.label}`), ["none:None of the above", "no_preference:No preference between these"]);
  assert.match(r.results.map((x) => x.description).join(" "), /an opt-out, not an item/);
  const off = run(r.def, [{ op: "update_maxdiff", target: q.code, optOuts: ["cannot_choose"] }]);
  assert.deepEqual(off.errors, []);
  assert.deepEqual(maxdiffOptOutsOf(designOf(off.def, md(off.def)).config).map((o) => o.kind), ["cannot_choose"]);
  assert.deepEqual(designOf(off.def, md(off.def)).file!.rows, d.file!.rows, "changing the opt-outs does not change the sets");
  const none = run(off.def, [{ op: "update_maxdiff", target: q.code, optOuts: [] }]);
  assert.deepEqual(maxdiffOptOutsOf(designOf(none.def, md(none.def)).config), []);
  const bad = coerceSurveyActions([{ op: "create_maxdiff", items: ITEMS, optOuts: ["maybe"] }]);
  assert.match(bad.rejected[0].reason, /none, no_preference and cannot_choose/);
});

test("an opted-out set is answered; only a kind the design offers counts; the data carries it as its own variable", () => {
  const r = run(empty(), [{ op: "create_maxdiff", items: ITEMS, perTask: 4, tasks: 4, versions: 1, seed: 5, optOuts: ["none", "cannot_choose"] }]);
  const def = r.def, q = md(def), d = designOf(def, q);
  const state = createResponseState(def, { seed: 9, sessionId: "s9" });
  const rows = (d.file!.rows as Record<string, unknown>[]).filter((x) => String(x.version) === designVersionFor(q, d.file!.rows as Record<string, unknown>[], 9));
  const tasks = [...new Set(rows.map((x) => String(x.task)))];
  const itemsOf = (t: string) => rows.filter((x) => String(x.task) === t).map((x) => String(x.item_index));
  const ans: Record<string, unknown> = {};
  for (const t of tasks) ans[t] = { best: itemsOf(t)[0], worst: itemsOf(t)[1] };
  ans[tasks[1]] = { optOut: "none" };
  ans[tasks[2]] = { optOut: "cannot_choose" };
  assert.deepEqual(blockingErrors(validateQuestion(def, q, ans, { def, state })), [], "opted-out sets complete a required question");
  /* a kind the design does not offer is not an answer */
  assert.equal(maxdiffTaskOptOut(d.config, { optOut: "no_preference" }), null);
  const stale = { ...ans, [tasks[3]]: { optOut: "no_preference" } };
  assert.match(blockingErrors(validateQuestion(def, q, stale, { def, state })).map((e) => e.message).join(" "), /Please choose a best and a worst/);
  /* the data map */
  const dict = buildVariableDictionary(def);
  const v = dict.find((x) => x.name === `${q.variableName}_T${tasks[1]}_OPTOUT`)!;
  assert.ok(v, "one opt-out variable per task");
  assert.deepEqual(v.valueCodes, ["none", "cannot_choose"]);
  assert.match(String(v.notes), /not choice observations/);
  /* the flattened response */
  state.answers[q.id] = ans;
  const flat = flattenVariables(def, state);
  assert.equal(flat[`${q.variableName}_T${tasks[1]}_OPTOUT`], "none");
  assert.equal(flat[`${q.variableName}_T${tasks[2]}_OPTOUT`], "cannot_choose");
  assert.equal(flat[`${q.variableName}_T${tasks[1]}_BEST`], undefined, "no best for an opted-out set");
  assert.equal(flat[`${q.variableName}_T${tasks[0]}_OPTOUT`], undefined);
  assert.equal(flat[`${q.variableName}_T${tasks[0]}_BEST`], Number(itemsOf(tasks[0])[0]));
  /* a design without opt-outs has no such variable, and ignores the key */
  const plain = run(empty(), [{ op: "create_maxdiff", items: ITEMS, perTask: 4, tasks: 4, versions: 1, seed: 5 }]);
  assert.ok(!buildVariableDictionary(plain.def).some((x) => /_OPTOUT$/.test(x.name)));
});
