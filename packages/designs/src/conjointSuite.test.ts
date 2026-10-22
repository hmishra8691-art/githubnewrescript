import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, createResponseState, flattenVariables, buildVariableDictionary, validateQuestion, blockingErrors, conjointMethodOf, cvaTasksFor } from "@rescript/engine";
import { registerBuiltinDesignGenerators, conjointPlugin, cvaPlugin, cvaDEfficiency, menuPlugin, acbcPlugin } from "./index.js";

/*
 * THE CONJOINT SUITE'S DESIGNS (F4, 2026-10-22): the rating-based (CVA) generator, alternative-specific
 * / labelled and dual-response CBC, exclusive menu sections, ACBC summed price — and Intelligent Mode
 * creating / changing them through the real generators, as the copilot route does.
 */
registerBuiltinDesignGenerators();

const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Screen", levels: ["5 in", "6 in", "7 in"] }, { name: "Battery", levels: ["1 day", "2 days", "3 days"] }, { name: "Price", levels: ["$199", "$299", "$399"] }];
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Phones", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const run = (def: SurveyDefinition, raw: unknown[]) => { const c = coerceSurveyActions(raw); assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected)); return applySurveyActions(def, c.actions, { ids, now: "2026-10-22T00:00:00.000Z" }); };
const designOf = (def: SurveyDefinition, q: Question) => def.designs.find((d) => d.id === (q.settings as { designRef?: string }).designRef)!;
const byVar = (def: SurveyDefinition, v: string) => def.questions.find((q) => q.variableName === v)!;

test("CVA design: D-optimal per version (measured), level-balanced, prohibitions honoured, holdouts identical in every version, reproducible", () => {
  const cfg = { attributes: ATTRS, versions: 3, holdouts: 2 };
  const d = cvaPlugin.generate(cfg, 4);
  const s = d.summary as Record<string, any>;
  assert.equal(s.profilesPerVersion, 14, "default ≈ 1.5 × (8 part-worths + intercept)");
  assert.ok(s.efficiency.perVersion.min >= 0.9, `D-efficiency ${JSON.stringify(s.efficiency)}`);
  assert.equal(d.rows.length, 3 * (14 + 2));
  assert.deepEqual(cvaPlugin.generate(cfg, 4).rows, d.rows, "same (config, seed) → same design");
  assert.notDeepEqual(cvaPlugin.generate(cfg, 5).rows, d.rows);
  const hold = (v: number) => d.rows.filter((r) => r.version === v && r.is_holdout === 1).map((r) => ATTRS.map((a) => r[a.name]).join("|"));
  assert.deepEqual(hold(1), hold(2)); assert.deepEqual(hold(2), hold(3));
  for (const v of [1, 2, 3]) { const keys = d.rows.filter((r) => r.version === v && r.is_holdout === 0).map((r) => ATTRS.map((a) => r[a.name]).join("|")); assert.equal(new Set(keys).size, keys.length, "no profile twice in a version"); }
  // a random design is clearly worse — the exchange is doing the work
  const random = Array.from({ length: 14 }, (_, k) => [ATTRS.map((a, q) => (k * (q + 2) + q) % a.levels.length)]);
  assert.ok((cvaDEfficiency(ATTRS, random, "single") ?? 0) < s.efficiency.perVersion.min);
  const pro = cvaPlugin.generate({ ...cfg, prohibitions: [{ a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Price", level: "$399" } }] }, 4);
  assert.ok(!pro.rows.some((r) => r.Brand === "Gamma" && r.Price === "$399"));
  const pairs = cvaPlugin.generate({ attributes: ATTRS, mode: "paired" }, 2);
  assert.ok(((pairs.summary as Record<string, any>).efficiency.perVersion.min) >= 0.8, JSON.stringify(pairs.summary));
  assert.ok(pairs.rows.every((r) => r.alt === 1 || r.alt === 2));
  assert.equal((pairs.summary as Record<string, any>).scale.min, 1);
});

test("CVA validation: too few profiles, a bad task mode, an unwritable order constraint, a too-small scale — refused with the fix", () => {
  assert.match(cvaPlugin.validateConfig!({ attributes: ATTRS, profiles: 6 }).join(" "), /cannot identify 8 part-worths and an intercept .* at least 9/);
  assert.match(cvaPlugin.validateConfig!({ attributes: ATTRS, mode: "ranked" as never }).join(" "), /single or paired/);
  assert.match(cvaPlugin.validateConfig!({ attributes: ATTRS, monotone: ["Price goes down"] }).join(" "), /Price: decreasing/);
  assert.match(cvaPlugin.validateConfig!({ attributes: ATTRS, scaleMin: 1, scaleMax: 2 }).join(" "), /at least 3 points/);
  assert.deepEqual(cvaPlugin.validateConfig!({ attributes: ATTRS, monotone: ["Price: decreasing"] }), []);
});

test("brand-specific CBC: an attribute only some brands carry is blank elsewhere; efficient swapping never moves a blank or a brand; validation in words", () => {
  const attrs = [...ATTRS, { name: "5G", levels: ["No", "Yes"] }];
  const cfg = { attributes: attrs, alternativeSpecific: ["5G: Alpha, Beta"], tasks: 12, versions: 4, method: "efficient" as const };
  const d = conjointPlugin.generate(cfg, 3);
  for (const r of d.rows) { if (r.Brand === "Gamma") assert.equal(r["5G"], ""); else assert.ok(r["5G"] === "Yes" || r["5G"] === "No"); }
  const s = d.summary as Record<string, any>;
  assert.equal(s.alternativeSpecific.brandAttribute, "Brand");
  assert.ok(s.efficiency.perVersion.mean > 0.85, JSON.stringify(s.efficiency));
  const bal = conjointPlugin.generate({ ...cfg, method: "balanced" }, 3);
  assert.ok(s.efficiency.perVersion.mean >= (bal.summary as Record<string, any>).efficiency.perVersion.mean - 1e-9, "swapping does not lose efficiency");
  assert.match(conjointPlugin.validateConfig!({ ...cfg, alternativeSpecific: ["5G: Alpha, Delta"] }).join(" "), /“Delta”, which is not a level of Brand/);
  assert.match(conjointPlugin.validateConfig!({ ...cfg, alternativeSpecific: ["Brand: Alpha"] }).join(" "), /cannot be alternative-specific/);
  assert.match(conjointPlugin.validateConfig!({ ...cfg, alternativeSpecific: ["Colour: Alpha"] }).join(" "), /“Colour”, which is not an attribute/);
  // labelled: alternatives = brands, each brand once per task in brand order
  assert.match(conjointPlugin.validateConfig!({ attributes: ATTRS, labelled: true, alternativesPerTask: 4 }).join(" "), /must be 3/);
  const lab = conjointPlugin.generate({ attributes: ATTRS, labelled: true, tasks: 10, versions: 2, method: "efficient" }, 5);
  for (const t of new Set(lab.rows.map((r) => `${r.version}:${r.task}`))) assert.deepEqual(lab.rows.filter((r) => `${r.version}:${r.task}` === t).map((r) => r.Brand), ["Alpha", "Beta", "Gamma"]);
});

test("dual-response None: the forced-choice rows are a no-None design's rows; the summary says dual; None + dual refused", () => {
  const base = { attributes: ATTRS, tasks: 12, versions: 3, method: "efficient" as const };
  const plain = conjointPlugin.generate(base, 9), dual = conjointPlugin.generate({ ...base, dualResponseNone: true }, 9);
  assert.deepEqual(dual.rows, plain.rows);
  assert.equal((dual.summary as Record<string, any>).dualResponseNone, true);
  assert.equal((plain.summary as Record<string, any>).dualResponseNone, undefined, "absent when off — existing summaries unchanged");
  assert.match(conjointPlugin.validateConfig!({ ...base, dualResponseNone: true, noneOption: true }).join(" "), /Dual-response None replaces the None alternative/);
});

test("menu sections and ACBC summed price: a group column only when sections exist; validation names the problem", () => {
  const items = [{ name: "Basic", levels: ["$5", "$7"] }, { name: "Plus", levels: ["$9", "$12"] }, { name: "Extra", levels: ["$1", "$2"] }];
  const m = menuPlugin.generate({ items, exclusiveGroups: ["Plan: Basic | Plus"], tasks: 4 }, 2);
  assert.ok(m.columns.includes("group"));
  assert.deepEqual([...new Set(m.rows.map((r) => `${r.item_label}:${r.group}`))].sort(), ["Basic:Plan", "Extra:", "Plus:Plan"]);
  assert.ok(!menuPlugin.generate({ items, tasks: 4 }, 2).columns.includes("group"));
  assert.match(menuPlugin.validateConfig!({ items, exclusiveGroups: ["Plan: Basic | Gold"] }).join(" "), /“Gold”, which is not on the menu/);
  assert.match(menuPlugin.validateConfig!({ items, requiredItems: ["Basic"], exclusiveGroups: ["Plan: Basic | Plus"] }).join(" "), /always included, so it cannot be in an exclusive section/);
  assert.match(acbcPlugin.validateConfig!({ attributes: ATTRS.slice(0, 3), priceBase: 300, priceIncrements: ["Brand: 0, 50"] }).join(" "), /3 levels but 2 price increments/);
  assert.match(acbcPlugin.validateConfig!({ attributes: ATTRS, priceBase: 300, priceIncrements: ["Brand: 0, 50, 100"] }).join(" "), /“Price” should not also be an attribute/);
  assert.deepEqual(acbcPlugin.validateConfig!({ attributes: ATTRS.slice(0, 3), priceBase: 300, priceIncrements: ["Brand: 0, 50, 100", "Battery: +0, +₹30, +₹60"] }), []);
});

test("Intelligent Mode: a rating-based conjoint with 4 attributes — created through the real generator, measured, answered and exported", () => {
  const out = run(empty(), [{ op: "create_conjoint", ref: "PHONE_CVA", method: "rating-based", attributes: ATTRS }]);
  assert.deepEqual(out.errors, []);
  const q = byVar(out.def, "PHONE_CVA");
  assert.equal(q.variant, "conjoint.cva");
  const d = designOf(out.def, q);
  assert.equal(d.kind, "cva");
  assert.deepEqual(d.file!.rows, cvaPlugin.generate(d.config as never, d.seed!).rows, "exactly what the Design Generators panel makes");
  assert.match(out.results[0].description, /rating-based conjoint \(CVA\).*14 profiles rated 0–10 per version, 4 versions.*D-efficiency \d+(\.\d)?% per version/);
  assert.match(out.results[0].description, /Assumed \(not stated\): single profiles rated 0–10, 14 profiles per version.*4 versions/);
  // the respondent's tasks, validation and export
  const state = createResponseState(out.def, { seed: 12345 });
  const tasks = cvaTasksFor(out.def, q, state.seed);
  assert.equal(tasks.length, 14);
  const answers = Object.fromEntries(tasks.map((t, i) => [t.task, i % 11]));
  state.answers[q.id] = answers;
  assert.deepEqual(blockingErrors(validateQuestion(out.def, q, answers, { def: out.def, state } as never)), []);
  state.answers[q.id] = { ...answers, [tasks[0].task]: 12 };
  assert.match(blockingErrors(validateQuestion(out.def, q, state.answers[q.id], { def: out.def, state } as never)).map((e) => e.message).join(" "), /rating from 0 to 10/);
  state.answers[q.id] = answers;
  const flat = flattenVariables(out.def, state);
  assert.equal(flat[`PHONE_CVA_T${tasks[1].task}`], 1);
  assert.equal(flat[`PHONE_CVA_T${tasks[1].task}_ORDER`], undefined, "a rating task has no shown order");
  assert.ok(buildVariableDictionary(out.def).some((v) => v.name === "PHONE_CVA_T1" && /rating/.test(v.label)));
  assert.equal(conjointMethodOf(out.def, q)!.method, "cva");
});

test("Intelligent Mode: dual-response None, labelled and brand-specific CBC, menu sections, summed price — each a patch; simulate_conjoint checked and saved", () => {
  const made = run(empty(), [{ op: "create_conjoint", ref: "CBC", method: "cbc", attributes: [...ATTRS, { name: "5G", levels: ["No", "Yes"] }], none: true }]);
  assert.deepEqual(made.errors, []);
  const dual = run(made.def, [{ op: "update_conjoint", target: "CBC", dualResponse: true }]);
  assert.deepEqual(dual.errors, []);
  const d1 = designOf(dual.def, byVar(dual.def, "CBC"));
  assert.equal(d1.config.dualResponseNone, true);
  assert.equal(d1.config.noneOption, false);
  assert.match(dual.results[0].description, /dual-response None|the None alternative is replaced/);
  assert.ok(!d1.file!.rows.some((r) => Number(r.none_option) === 1), "regenerated without the None rows");
  const as = run(dual.def, [{ op: "update_conjoint", target: "CBC", alternativeSpecific: [{ attribute: "5g", appliesTo: ["alpha", "BETA"] }] }]);
  assert.deepEqual(as.errors, []);
  const d2 = designOf(as.def, byVar(as.def, "CBC"));
  assert.deepEqual(d2.config.alternativeSpecific, ["5G: Alpha, Beta"]);
  assert.equal(d2.config.brandAttribute, "Brand");
  assert.ok(d2.file!.rows.filter((r) => r.Brand === "Gamma").every((r) => r["5G"] === ""));
  const lab = run(empty(), [{ op: "create_conjoint", ref: "LAB", method: "labelled", attributes: ATTRS }]);
  assert.deepEqual(lab.errors, []);
  assert.equal(designOf(lab.def, byVar(lab.def, "LAB")).config.labelled, true);
  assert.equal(designOf(lab.def, byVar(lab.def, "LAB")).config.alternativesPerTask, 3);
  // menu with a section, then a scenario with a bundle at ₹ prices
  const menu = run(empty(), [{ op: "create_conjoint", ref: "PLAN", method: "menu", items: [{ name: "Data pack", prices: ["₹99", "₹149"] }, { name: "Insurance", prices: ["₹149", "₹199"] }, { name: "Streaming", prices: ["₹199", "₹299"] }, { name: "Basic support", prices: ["₹49", "₹79"] }, { name: "Priority support", prices: ["₹99", "₹149"] }], exclusiveGroups: [{ name: "Support", items: ["basic support", "Priority Support"] }] }]);
  assert.deepEqual(menu.errors, []);
  const md = designOf(menu.def, byVar(menu.def, "PLAN"));
  assert.deepEqual(md.config.exclusiveGroups, ["Support: Basic support | Priority support"]);
  const sim = run(menu.def, [{ op: "simulate_conjoint", target: "PLAN", scenario: { name: "Premium bundle at ₹499", bundles: [{ name: "Premium", items: ["Insurance", "Streaming", "Data pack"], price: "₹499" }] } }]);
  assert.deepEqual(sim.errors, []);
  const after = designOf(sim.def, byVar(sim.def, "PLAN"));
  assert.deepEqual(after.file!.rows, md.file!.rows, "a scenario never regenerates the tasks");
  assert.deepEqual((after.config.simulations as unknown[])[0], { name: "Premium bundle at ₹499", bundles: [{ name: "Premium", items: ["Insurance", "Streaming", "Data pack"], price: 499 }] });
  assert.match(sim.results[0].description, /Simulator scenario “Premium bundle at ₹499” saved on .* bundle “Premium” \(Insurance \+ Streaming \+ Data pack\) at 499.*The tasks are unchanged/);
  assert.match(run(sim.def, [{ op: "simulate_conjoint", target: "PLAN", scenario: { name: "x", prices: { Gold: "₹9" } } }]).errors[0], /“Gold” is not on the menu/);
  const cbcSim = run(as.def, [{ op: "simulate_conjoint", target: "CBC", scenario: { name: "Ours vs theirs", products: [{ name: "Ours", levels: { brand: "alpha", price: "$299" } }, { name: "Theirs", levels: { Brand: "Beta", Price: "$199" } }], rule: "rfc" } }]);
  assert.deepEqual(cbcSim.errors, []);
  assert.ok(cbcSim.warnings.some((w) => /every attribute/.test(w)), "missing attributes are said");
  assert.match(run(as.def, [{ op: "simulate_conjoint", target: "CBC", scenario: { name: "x", prices: { Brand: 3 } } }]).errors[0], /prices and bundles belong to a menu scenario/);
  // ACBC summed price as increments per attribute
  const acbc = run(empty(), [{ op: "create_conjoint", ref: "ACBC", method: "acbc", attributes: ATTRS.slice(0, 3), priceBase: 20000, priceIncrements: { Brand: [0, 2000, 4000], battery: [0, 1500, 3000] } }]);
  assert.deepEqual(acbc.errors, []);
  const ac = designOf(acbc.def, byVar(acbc.def, "ACBC"));
  assert.deepEqual(ac.config.priceIncrements, ["Brand: 0, 2000, 4000", "Battery: 0, 1500, 3000"]);
  assert.equal(ac.config.priceVariation, 30);
  assert.match(acbc.results[0].description, /summed price from 20000 plus level increments, varied ±30%/);
});

test("the gate: still-unsupported variants refused with the reason; method-only fields refused on the wrong method", () => {
  const rejected = (raw: unknown) => coerceSurveyActions([raw]).rejected[0]?.reason ?? "";
  assert.match(rejected({ op: "create_conjoint", method: "ranking", attributes: ATTRS }), /ranking-based conjoint is not implemented/);
  assert.match(rejected({ op: "create_conjoint", attributes: ATTRS, estimation: "HB" }), /not a design setting .* Data Analytics/);
  assert.match(rejected({ op: "create_conjoint", attributes: ATTRS, none: true, dualResponse: true }), /dual-response None replaces the None alternative/);
  assert.match(rejected({ op: "create_conjoint", attributes: ATTRS, alternativeNames: ["A", "B"] }), /labelled: true/);
  assert.equal(rejected({ op: "create_conjoint", method: "cva", attributes: ATTRS, mode: "paired", scale: "1-9" }), "");
  assert.match(run(empty(), [{ op: "create_conjoint", method: "cva", attributes: ATTRS }]).def.questions[0].variant!, /conjoint\.cva/);
  const out = applySurveyActions(empty(), coerceSurveyActions([{ op: "create_conjoint", method: "cva", attributes: ATTRS, dualResponse: true }]).actions, { ids });
  assert.match(out.errors[0], /“dualResponse” does not apply to a rating-based conjoint/);
  const menuOut = applySurveyActions(empty(), coerceSurveyActions([{ op: "create_conjoint", method: "menu", items: [{ name: "A", prices: ["$1", "$2"] }, { name: "B", prices: ["$1", "$2"] }], labelled: true }]).actions, { ids });
  assert.match(menuOut.errors[0], /“labelled” does not apply to a menu-based conjoint/);
});
