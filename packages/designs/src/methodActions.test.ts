import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import {
  applySurveyActions, coerceSurveyActions, createResponseState, flattenVariables, buildVariableDictionary,
  designVersionFor, shuffleAlternatives, validateQuestion, blockingErrors, stackedChoiceData,
} from "@rescript/engine";
import { registerBuiltinDesignGenerators, maxdiffPlugin, conjointPlugin, measureMaxDiffDesign } from "./index.js";

/*
 * INTELLIGENT MODE BUILDS METHODS THROUGH THE REAL GENERATORS (Priority 5, 2026-10-17).
 *
 * The engine's create_maxdiff / create_conjoint / update_* reach the generators through the
 * schema's registry; here the registry holds the real ones (registerBuiltinDesignGenerators, as
 * the Studio's copilot route and its browser replay do). Pinned: the brief's three example
 * requests as the methods guide answers them, the measured diagnostics in the description, the
 * same design the Design Generators panel would make from that config and seed, the panel's
 * own feasibility refusals, modifications that change only what they name, prohibited pairs /
 * None measured on the rows, and the data a respondent's answers produce.
 */

registerBuiltinDesignGenerators();

const FEATURES = ["Battery life", "Camera quality", "Price", "Screen size", "Storage", "Brand reputation", "Durability", "Weight", "Charging speed", "Design", "Software updates", "Warranty"];
const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Screen", levels: ["5 in", "6 in", "7 in"] }, { name: "Battery", levels: ["1 day", "2 days", "3 days"] }, { name: "Price", levels: ["$199", "$299", "$399"] }];

let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Phones", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const run = (def: SurveyDefinition, raw: unknown[]) => {
  const c = coerceSurveyActions(raw);
  assert.deepEqual(c.rejected, []);
  return applySurveyActions(def, c.actions, { ids, now: "2026-10-17T00:00:00.000Z" });
};
const designOf = (def: SurveyDefinition, q: Question) => def.designs.find((d) => d.id === (q.settings as { designRef?: string }).designRef)!;
const byVar = (def: SurveyDefinition, v: string) => def.questions.find((q) => q.variableName === v)!;

/** the brief's first example, as the guide teaches: the items named, the sizes left to the engine */
const MAXDIFF_REPLY = [{ op: "create_block", title: "Feature importance" }, { op: "create_maxdiff", ref: "FEAT_MD", block: "Feature importance", items: FEATURES, text: "Of these features, which is the MOST important to you when choosing a smartphone, and which is the LEAST important?" }];
/** the second: four attributes × three levels, given by the researcher (the guide asks for them when they are not) */
const CBC_REPLY = [{ op: "create_block", title: "Choice tasks" }, { op: "create_conjoint", ref: "PHONE_CBC", block: "Choice tasks", method: "cbc", attributes: ATTRS, text: "If these were the only phones available, which would you choose?" }];

test("example 1 — MaxDiff of 12 features: the panel's design from (config, seed), measured diagnostics in words", () => {
  const out = run(empty(), MAXDIFF_REPLY);
  assert.deepEqual(out.errors, []);
  const q = byVar(out.def, "FEAT_MD");
  const d = designOf(out.def, q);
  assert.deepEqual(d.config, { balance: "optimized", items: FEATURES, itemsPerTask: 4, tasks: 9, versions: 10 });
  // exactly what the Design Generators panel generates from that configuration and seed
  const panel = maxdiffPlugin.generate(d.config as never, d.seed!);
  assert.deepEqual(d.file!.rows, panel.rows);
  assert.deepEqual(d.file!.summary, panel.summary);
  // every item exactly 3 times in every version (what one respondent sees)
  const diag = measureMaxDiffDesign(d.file!.rows, FEATURES);
  assert.equal(diag.perVersion.itemSpreadMax, 0);
  assert.equal(diag.items.min, 30); assert.equal(diag.items.max, 30);
  const desc = out.results[1].description;
  assert.match(desc, /12 items, 4 per task, 9 tasks, 10 versions; each respondent sees every item 3 times; within a version every pair shares a task 0–\d times; across the 10 versions \d+–\d+ times/);
  assert.match(desc, /Assumed \(not stated\): 4 items per task, 9 tasks \(each item about 3 times per respondent\), 10 versions/);
  console.log(`      MaxDiff example: ${desc}`);
});

test("example 2 — CBC with four attributes × three levels: efficient, D-efficiency measured and said", () => {
  const out = run(empty(), CBC_REPLY);
  assert.deepEqual(out.errors, []);
  const q = byVar(out.def, "PHONE_CBC");
  assert.equal(q.variant, "conjoint.cbc");
  const d = designOf(out.def, q);
  assert.deepEqual(d.config, { attributes: ATTRS, alternativesPerTask: 3, tasks: 12, versions: 10, method: "efficient" });
  assert.deepEqual(d.file!.rows, conjointPlugin.generate(d.config as never, d.seed!).rows, "the panel's design");
  const e = (d.file!.summary as { efficiency: { perVersion: { mean: number; min: number }; duplicateConceptTasks: number } }).efficiency;
  assert.ok(e.perVersion.min > 0.95, `per-version D-efficiency ${e.perVersion.min}`);
  assert.equal(e.duplicateConceptTasks, 0);
  const desc = out.results[1].description;
  assert.match(desc, /4 attributes \(Brand 3, Screen 3, Battery 3, Price 3 levels\); 3 alternatives per task, 12 tasks, 10 versions, efficient .* D-efficiency \d+(\.\d)?% per version \(worst \d+(\.\d)?%\), \d+(\.\d)?% pooled; each level shown 120–120 times; avoidable overlap 0%; 0 tasks with a duplicate concept/);
  console.log(`      CBC example: ${desc}`);
});

test("deterministic replay: the browser's Apply regenerates the identical design", () => {
  const a = run(empty(), [...MAXDIFF_REPLY, ...CBC_REPLY]);
  const b = run(empty(), [...MAXDIFF_REPLY, ...CBC_REPLY]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.def.designs.length, 2);
  assert.deepEqual(a.def.designs.map((d) => [d.kind, d.seed, d.file!.rows]), b.def.designs.map((d) => [d.kind, d.seed, d.file!.rows]));
});

test("“make it 5 items per task” changes only that; the new design is measured again", () => {
  const made = run(empty(), MAXDIFF_REPLY).def;
  const before = designOf(made, byVar(made, "FEAT_MD"));
  const out = run(made, [{ op: "update_maxdiff", target: "FEAT_MD", perTask: 5 }]);
  assert.deepEqual(out.errors, []);
  const after = designOf(out.def, byVar(out.def, "FEAT_MD"));
  assert.deepEqual(after.config, { ...before.config, itemsPerTask: 5 });
  assert.deepEqual(after.file!.rows, maxdiffPlugin.generate(after.config as never, before.seed!).rows);
  assert.equal(new Set(after.file!.rows.filter((r) => r.task === 1 && r.version === 1).map((r) => r.item_index)).size, 5);
  assert.deepEqual(out.def.questions, made.questions.map((q) => q), "the question itself is untouched");
  assert.match(out.results[0].description, /items per task 4 → 5 — design regenerated \(v2\): 12 items, 5 per task, 9 tasks, 10 versions; each respondent sees every item 3–4 times/);
});

test("“prohibit Battery life and Price together” — never in one task, measured on the rows", () => {
  const made = run(empty(), MAXDIFF_REPLY).def;
  const out = run(made, [{ op: "update_maxdiff", target: "FEAT_MD", addProhibitedPairs: [["battery life", "price"]] }]);
  assert.deepEqual(out.errors, []);
  const d = designOf(out.def, byVar(out.def, "FEAT_MD"));
  const diag = measureMaxDiffDesign(d.file!.rows, FEATURES, { prohibitedPairs: [["Battery life", "Price"]] });
  assert.equal(diag.prohibited.violations, 0);
  assert.match(out.results[0].description, /1 prohibited pair never shown together \(checked on the rows\)/);
});

test("“add a None option” to the CBC: None rows added, nothing else in the configuration changes", () => {
  const made = run(empty(), CBC_REPLY).def;
  const before = designOf(made, byVar(made, "PHONE_CBC"));
  const out = run(made, [{ op: "update_conjoint", target: "PHONE_CBC", none: true }]);
  assert.deepEqual(out.errors, []);
  const after = designOf(out.def, byVar(out.def, "PHONE_CBC"));
  assert.deepEqual(after.config, { ...before.config, noneOption: true });
  assert.equal(after.file!.rows.filter((r) => Number(r.none_option) === 1).length, 12 * 10, "one None per task per version");
  assert.match(out.results[0].description, /3 alternatives \+ None per task/);
});

test("infeasible requests are refused with the panel's own words", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`);
  const md = run(empty(), [{ op: "create_maxdiff", items: twenty, perTask: 5, tasks: 3, versions: 1 }]);
  const panel = maxdiffPlugin.validateConfig!({ items: twenty, itemsPerTask: 5, tasks: 3, versions: 1, balance: "optimized" });
  assert.ok(panel.length);
  assert.equal(md.errors[0], `Create a MaxDiff of 20 items: this MaxDiff design is not feasible — ${panel.join(" ")}`);
  assert.match(md.errors[0], /cannot show all 20 items even once\. Use at least 4 tasks per version/);
  const cbc = run(empty(), [{ op: "create_conjoint", attributes: [{ name: "A", levels: ["a1", "a2"] }, { name: "B", levels: ["b1", "b2"] }], alternatives: 5 }]);
  assert.match(cbc.errors[0], /not feasible — These attributes make only 4 different concepts, and each task needs 5/);
  const pairs = run(empty(), [{ op: "create_maxdiff", items: ["A", "B", "C", "D"], perTask: 3, prohibitedPairs: [["A", "B"], ["A", "C"]] }]);
  assert.match(pairs.errors[0], /not feasible — .*(no possible task for A|prohibited with 2)/);
  for (const o of [md, cbc, pairs]) { assert.equal(o.def.questions.length, 0); assert.equal(o.def.designs.length, 0); }
});

test("the respondent's answers: validated against their own version, flattened to the documented columns", () => {
  const def = run(empty(), [...MAXDIFF_REPLY, ...CBC_REPLY]).def;
  const md = byVar(def, "FEAT_MD"), cbc = byVar(def, "PHONE_CBC");
  const mdRows = designOf(def, md).file!.rows, cbcRows = designOf(def, cbc).file!.rows;
  const seed = 777;
  const state = createResponseState(def, { seed });
  const mdVersion = designVersionFor(md, mdRows, seed);
  const mdAns: Record<string, { best: string; worst: string }> = {};
  for (let t = 1; t <= 9; t++) {
    const shown = shuffleAlternatives(mdRows.filter((r) => String(r.version) === mdVersion && Number(r.task) === t), seed, `${md.id}:${t}`);
    mdAns[String(t)] = { best: String(shown[0].item_index), worst: String(shown[3].item_index) };
  }
  const cbcVersion = designVersionFor(cbc, cbcRows, seed);
  const cbcAns: Record<string, string> = {};
  for (let t = 1; t <= 12; t++) cbcAns[String(t)] = String(cbcRows.find((r) => String(r.version) === cbcVersion && Number(r.task) === t)!.alt);
  state.answers[md.id] = mdAns; state.answers[cbc.id] = cbcAns;
  const ctx = { def, state };
  assert.deepEqual(blockingErrors(validateQuestion(def, md, mdAns, ctx as never)), []);
  assert.deepEqual(blockingErrors(validateQuestion(def, cbc, cbcAns, ctx as never)), []);
  // required: a missing task is refused; best = worst is refused
  assert.ok(blockingErrors(validateQuestion(def, md, { ...mdAns, "9": undefined }, ctx as never)).length);
  assert.ok(blockingErrors(validateQuestion(def, md, { ...mdAns, "1": { best: mdAns["1"].best, worst: mdAns["1"].best } }, ctx as never)).length);
  const flat = flattenVariables(def, state);
  assert.equal(flat.FEAT_MD_VERSION, mdVersion);
  assert.equal(String(flat.FEAT_MD_T1_BEST), mdAns["1"].best);
  assert.equal(String(flat.FEAT_MD_T9_WORST), mdAns["9"].worst);
  assert.equal(flat.PHONE_CBC_VERSION, cbcVersion);
  assert.equal(String(flat.PHONE_CBC_T12), cbcAns["12"]);
  const dict = buildVariableDictionary(def).map((v) => v.name);
  for (const v of ["FEAT_MD_VERSION", "FEAT_MD_T9_BEST", "FEAT_MD_T9_WORST", "FEAT_MD_T9_ORDER", "PHONE_CBC_T12", "PHONE_CBC_T12_ORDER"]) assert.ok(dict.includes(v), v);
  const stacked = stackedChoiceData(def, [{ sessionId: "S1", respondentId: "R1", seed, answers: state.answers }]);
  assert.equal(stacked.rows.filter((r) => Number(r.chosen) === 1).length, 12, "the stacked CBC file has one chosen concept per task");
});

test("ACBC and menu through the real generators: feasible configs attach, an impossible one is refused", () => {
  const acbc = run(empty(), [{ op: "create_conjoint", method: "acbc", attributes: ATTRS }]);
  assert.deepEqual(acbc.errors, []);
  assert.match(acbc.results[0].description, /Adaptive: each respondent's concepts are generated at interview time .* no ACBC estimator/);
  const menu = run(empty(), [{ op: "create_conjoint", method: "menu", items: [{ name: "Extra storage", prices: ["$2", "$4"] }, { name: "Insurance", prices: ["$5", "$8"] }, { name: "Case", prices: ["$10", "$15"] }] }]);
  assert.deepEqual(menu.errors, []);
  assert.match(menu.results[0].description, /3 menu items .* 8 tasks, 10 versions, “buy nothing” offered.* take rates/);
  const tiny = run(empty(), [{ op: "create_conjoint", method: "acbc", attributes: [{ name: "A", levels: ["1", "2"] }, { name: "B", levels: ["1", "2"] }], conceptsPerScreen: 4 }]);
  assert.match(tiny.errors[0], /not feasible — Only 3 concepts other than the BYO exist; each screen needs 4/);
});
