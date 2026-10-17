import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, designGeneratorRegistry, type DesignGeneratorPlugin } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, diffSurveys, SURVEY_ACTION_OPS } from "./surveyActions.js";
import { inferMaxDiffPerTask, inferConjointTasks, describeDesignQuestion, METHOD_ACTION_OPS } from "./methodActions.js";
import { mulberry32, subSeed } from "./random.js";

/*
 * MAXDIFF AND CONJOINT AS COPILOT ACTIONS (Priority 5, 2026-10-17) — the engine half.
 *
 * The engine reaches the generators only through the schema's design-generator
 * registry (it may not import @rescript/designs, which depends on it). These
 * tests register small deterministic STAND-INS for the generators, so what is
 * pinned here is the action layer: the gate, the inferred defaults and what is
 * said about them, patch semantics (an update changes only what it names),
 * regeneration only when a generation field changes, the refusals in words, no
 * silent substitution, and the seed that makes a replay identical. The real
 * generators are exercised end to end in packages/designs/src/methodActions.test.ts.
 */

const ITEMS = ["Battery life", "Camera", "Price", "Screen size", "Storage", "Brand", "Durability", "Weight", "Charging speed", "Design", "Software updates", "Warranty"];
const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Screen", levels: ["5in", "6in", "7in"] }, { name: "Battery", levels: ["1 day", "2 days", "3 days"] }, { name: "Price", levels: ["$199", "$299", "$399"] }];

let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const base = (extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Phones", version: "1" },
  questions: [
    { id: "q_use", code: "Q1", variableName: "USE", type: "single_select", text: "Do you own a smartphone?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q_feat", code: "Q2", variableName: "FEATURES", type: "multi_select", text: "Which features matter?", options: [...ITEMS.slice(0, 6).map((label, i) => ({ code: i + 1, label })), { code: 99, label: "None of these", flags: ["exclusive"] }] },
  ],
  flow: [{ type: "block", id: "b1", title: "Screening", children: [{ type: "page", id: "p1", questionIds: ["q_use", "q_feat"] }] }, { type: "end", id: "e", status: "complete" }],
  ...extra,
});
const run = (def: SurveyDefinition, raw: unknown[]) => {
  const c = coerceSurveyActions(raw);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  return applySurveyActions(def, c.actions, { ids, now: "2026-10-17T00:00:00.000Z" });
};
const rejected = (raw: unknown) => coerceSurveyActions([raw]).rejected[0]?.reason ?? "";

/* the stand-in generators: deterministic in (config, seed), with a feasibility check in words */
const calls: { kind: string; config: Record<string, unknown>; seed: number }[] = [];
const rowsFrom = (kind: string, config: Record<string, unknown>, seed: number, count: number) => {
  calls.push({ kind, config: structuredClone(config), seed });
  // the rows depend on the generation config and the seed, as the real generators' do
  const rng = mulberry32(subSeed(seed, JSON.stringify(config)));
  return Array.from({ length: count }, (_, i) => ({ version: 1 + (i % Number(config.versions ?? 1)), task: 1 + Math.floor(i / 3), item_index: 1 + Math.floor(rng() * 1000), position: 1 + (i % 3) }));
};
const stub = (kind: string, validate: (c: Record<string, any>) => string[]): DesignGeneratorPlugin => ({
  kind, label: kind, configFields: [], validateConfig: validate,
  generate: (c, seed) => ({ columns: ["version", "task", "position", "item_index"], rows: rowsFrom(kind, c, seed, 12), summary: { stub: true } }),
});

test("not loaded: without the generators the action is refused in words and nothing changes", () => {
  const out = applySurveyActions(base(), coerceSurveyActions([{ op: "create_maxdiff", items: ITEMS }]).actions, { ids });
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].error!, /design generator is not loaded here/);
  assert.equal(out.def.questions.length, 2);
  assert.equal(out.def.designs.length, 0);
});

test("register the stand-in generators", () => {
  designGeneratorRegistry.register(stub("maxdiff", (c) => {
    const k = Number(c.itemsPerTask), items = (c.items as string[]) ?? [];
    const e: string[] = [];
    if (items.length < k + 1) e.push(`MaxDiff requires at least itemsPerTask + 1 items (need ${k + 1}, got ${items.length}).`);
    if (Number(c.tasks) * k * Number(c.versions ?? 1) < items.length) e.push(`${c.tasks} tasks of ${k} items cannot show all ${items.length} items even once.`);
    return e;
  }));
  designGeneratorRegistry.register(stub("conjoint", (c) => ((c.attributes as unknown[]).length < 2 ? ["Conjoint requires at least 2 attributes."] : [])));
  designGeneratorRegistry.register(stub("menu", () => []));
  designGeneratorRegistry.register(stub("acbc", () => []));
  assert.ok(designGeneratorRegistry.has("maxdiff"));
});

test("the gate: every method op is a survey action; missing essentials and unsupported methods are refused with the reason", () => {
  for (const op of METHOD_ACTION_OPS) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
  assert.match(rejected({ op: "create_maxdiff", text: "x" }), /needs the items .* ask the researcher/);
  assert.match(rejected({ op: "create_conjoint", text: "x" }), /needs the attributes and their levels .* ask the researcher .* rather than inventing/);
  assert.match(rejected({ op: "create_conjoint", method: "menu" }), /needs the menu/);
  assert.match(rejected({ op: "create_conjoint", method: "rating-based", attributes: ATTRS }), /rating-based .* not implemented.*choice-based \(cbc\), menu-based \(menu\) and adaptive \(acbc\)/);
  assert.match(rejected({ op: "create_conjoint", method: "ranking", attributes: ATTRS }), /ranking-based conjoint is not implemented/);
  assert.match(rejected({ op: "create_conjoint", attributes: ATTRS, estimation: "HB" }), /HB .* not available .* aggregate/);
  assert.match(rejected({ op: "create_maxdiff", items: ITEMS, estimation: "hb" }), /HB .* not available/);
  assert.match(rejected({ op: "create_conjoint", attributes: ATTRS, dualNone: true }), /dual-response None is not implemented/);
  assert.match(rejected({ op: "create_conjoint", attributes: [{ name: "Price", levels: ["199", "299"], type: "numeric" }, ATTRS[0]] }), /linear\) term is not implemented/);
  assert.match(rejected({ op: "create_maxdiff", items: ITEMS, responseMode: "worst only" }), /worst-only MaxDiff is not supported/);
  assert.match(rejected({ op: "create_maxdiff", items: ITEMS, perTask: 2 }), /perTask .* 3 or more/);
  assert.match(rejected({ op: "create_maxdiff", items: ITEMS, addItems: ["X"] }), /belong to update_maxdiff/);
  assert.match(rejected({ op: "update_maxdiff", target: "Q3" }), /changes nothing/);
  assert.match(rejected({ op: "create_conjoint", method: "acbcx", attributes: ATTRS }), /not a conjoint method here/);
});

test("create_maxdiff: the design attached and pinned, the question points at it, defaults inferred and SAID", () => {
  calls.length = 0;
  const out = run(base(), [{ op: "create_block", title: "Features" }, { op: "create_maxdiff", ref: "MD", block: "Features", items: ITEMS, text: "Which matters most, and which least?" }]);
  assert.deepEqual(out.errors, []);
  const q = out.def.questions.find((x) => x.variableName === "MD")!;
  assert.equal(q.type, "maxdiff_task");
  assert.equal(q.variant, "maxdiff.best_worst");
  assert.equal(q.required, true);
  assert.equal(q.text, "Which matters most, and which least?");
  const d = out.def.designs.find((x) => x.id === (q.settings as { designRef?: string }).designRef)!;
  assert.ok(d, "the question points at the design it made");
  assert.equal(d.kind, "maxdiff");
  assert.deepEqual(d.config, { balance: "optimized", items: ITEMS, itemsPerTask: 4, tasks: 9, versions: 10 });
  assert.equal(d.file!.rows.length, 12, "the generated rows are stored with the design (pinned, not regenerated per render)");
  assert.equal(calls.length, 1, "generated once");
  assert.equal(calls[0].seed, d.seed);
  const desc = out.results[1].description;
  assert.match(desc, /Created Q3 — MaxDiff \(seed \d+\): 12 items/);
  assert.match(desc, /Assumed \(not stated\): 4 items per task, 9 tasks \(each item about 3 times per respondent\), 10 versions/);
  assert.match(desc, /MD_VERSION, MD_T<n>_BEST, MD_T<n>_WORST, MD_T<n>_ORDER/);
  assert.deepEqual(diffSurveys(base(), out.def).summary.filter((l) => /design/i.test(l)), [`Add design “Q3 MaxDiff design” (MaxDiff, 12 rows)`]);
  assert.match(describeDesignQuestion(out.def, q)!, /Q3 MaxDiff \[design .*\]: 12 items .* 4 per task, 9 tasks, 10 versions, best_worst/);
});

test("inferred sizes: about a third of the list per task (3–5), tasks for ~3 shows; CBC tasks identify the model", () => {
  assert.deepEqual([4, 5, 7, 8, 12, 15, 16, 30].map(inferMaxDiffPerTask), [3, 3, 3, 4, 4, 4, 5, 5]);
  assert.equal(inferConjointTasks(ATTRS, 3), 12);
  assert.equal(inferConjointTasks([{ levels: Array(9).fill("x") }, { levels: Array(9).fill("y") }, { levels: Array(9).fill("z") }, { levels: Array(9).fill("w") }], 2), 32);
});

test("deterministic: the same actions replayed give the same seed and the identical design (the browser's replay on Apply)", () => {
  const acts = [{ op: "create_maxdiff", items: ITEMS, perTask: 4, tasks: 9, versions: 3 }, { op: "create_conjoint", attributes: ATTRS }];
  const a = run(base(), acts), b = run(base(), acts);
  assert.deepEqual(a.def.designs.map((d) => [d.seed, d.file!.rows]), b.def.designs.map((d) => [d.seed, d.file!.rows]));
  const c = run(base(), [{ ...acts[0], seed: 4242 }]);
  assert.equal(c.def.designs[0].seed, 4242, "an explicit seed is used as given");
});

test("itemsFrom: the items are a question's options, without None / Other", () => {
  const out = run(base(), [{ op: "create_maxdiff", itemsFrom: "FEATURES" }]);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.def.designs[0].config.items, ITEMS.slice(0, 6));
  assert.equal(out.def.designs[0].config.itemsPerTask, 3);
  assert.match(run(base(), [{ op: "create_maxdiff", itemsFrom: "Q1" }]).errors[0], /at least 4 items .* has 2/);
});

test("update_maxdiff patches ONLY what it names; the design is regenerated only when a generation field changed", () => {
  const made = run(base(), [{ op: "create_maxdiff", ref: "MD", items: ITEMS, perTask: 4, tasks: 9, versions: 10, bestLabel: "Most important" }, { op: "set_display_logic", target: "MD", expression: "USE = 1" }]).def;
  const q0 = made.questions.find((x) => x.variableName === "MD")!;
  const d0 = made.designs[0];
  calls.length = 0;
  const five = run(made, [{ op: "update_maxdiff", target: "MD", perTask: 5 }]);
  assert.deepEqual(five.errors, []);
  const d1 = five.def.designs[0], q1 = five.def.questions.find((x) => x.id === q0.id)!;
  assert.deepEqual(d1.config, { ...d0.config, itemsPerTask: 5 }, "only items per task changed: items, tasks, versions, labels kept");
  assert.equal(d1.seed, d0.seed, "the stored seed is kept");
  assert.equal(d1.version, 2);
  assert.equal(d1.id, d0.id, "the same design, regenerated in place — the question still points at it");
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...q1, settings: undefined }, { ...q0, settings: undefined }, "the question — text, display logic, everything — untouched");
  assert.match(five.results[0].description, /items per task 4 → 5 — design regenerated \(v2\)/);
  assert.match(five.results[0].description, /Everything else on Q3 .* is unchanged/);
  assert.match(five.destructive.join(" "), /Regenerates the MaxDiff design of Q3 \(v2\)/);
  // a label is read at render time: no regeneration, the same rows
  calls.length = 0;
  const label = run(made, [{ op: "update_maxdiff", target: "Q3", worstLabel: "Least important", instructions: "Pick one of each." }]);
  assert.equal(calls.length, 0, "not regenerated");
  assert.deepEqual(label.def.designs[0].file!.rows, d0.file!.rows);
  assert.equal(label.def.designs[0].version, 1);
  assert.equal(label.def.designs[0].config.worstLabel, "Least important");
  assert.match(label.results[0].description, /the tasks are unchanged \(12 rows kept\)/);
  assert.deepEqual(label.destructive, []);
  // text and required patch the question only
  const text = run(made, [{ op: "update_maxdiff", target: "MD", text: "New wording", required: false }]);
  assert.equal(text.def.questions.find((x) => x.id === q0.id)!.text, "New wording");
  assert.deepEqual(text.def.designs[0], d0);
});

test("prohibited pairs: resolved to the list's spelling; add / remove; an unknown item refused naming the list", () => {
  const made = run(base(), [{ op: "create_maxdiff", ref: "MD", items: ITEMS, perTask: 4, tasks: 9, versions: 2 }]).def;
  const add = run(made, [{ op: "update_maxdiff", target: "MD", addProhibitedPairs: [["price", "WARRANTY"]] }]);
  assert.deepEqual(add.errors, []);
  assert.deepEqual(add.def.designs[0].config.prohibitedPairs, [["Price", "Warranty"]]);
  const again = run(add.def, [{ op: "update_maxdiff", target: "MD", addProhibitedPairs: [["Camera", "Brand"]], removeProhibitedPairs: [["Warranty", "Price"]] }]);
  assert.deepEqual(again.def.designs[0].config.prohibitedPairs, [["Camera", "Brand"]]);
  assert.match(run(made, [{ op: "update_maxdiff", target: "MD", addProhibitedPairs: [["Price", "Brand Z"]] }]).errors[0], /“Brand Z” is not one of the items \(Battery life, Camera/);
  assert.match(run(made, [{ op: "update_maxdiff", target: "MD", addProhibitedPairs: [["Price", "price"]] }]).errors[0], /two different items/);
  // removing an item drops a pair that names it, and says so
  const drop = run(add.def, [{ op: "update_maxdiff", target: "MD", removeItems: ["warranty"] }]);
  assert.equal((drop.def.designs[0].config.items as string[]).includes("Warranty"), false);
  assert.equal(drop.def.designs[0].config.prohibitedPairs, undefined);
  assert.match(drop.results[0].description, /dropped the prohibited pair Price \/ Warranty/);
});

test("infeasible: refused with the generator's own words, nothing changed", () => {
  const out = run(base(), [{ op: "create_maxdiff", items: [...ITEMS, ...ITEMS.map((x) => `${x} 2`)], perTask: 5, tasks: 3, versions: 1 }]);
  assert.equal(out.results[0].ok, false);
  assert.match(out.errors[0], /not feasible — 3 tasks of 5 items cannot show all 24 items even once/);
  assert.equal(out.def.questions.length, 2);
  assert.equal(out.def.designs.length, 0);
});

test("a design question is never created bare: create_question / update_question to a design type point at the method action", () => {
  const c = run(base(), [{ op: "create_question", type: "maxdiff", text: "Most and least?" }]);
  assert.match(c.errors[0], /use create_maxdiff .* generates and attaches the design/);
  const cbc = run(base(), [{ op: "create_question", type: "cbc", text: "Which?" }]);
  assert.match(cbc.errors[0], /use create_conjoint/);
  const u = run(base(), [{ op: "update_question", target: "Q2", type: "maxdiff" }]);
  assert.match(u.errors[0], /Q2 cannot become a .*MaxDiff.* create_maxdiff \(it can take its items from Q2: itemsFrom\)/);
});

test("a live survey: a regenerating update is destructive and warned; a label change is not", () => {
  const made = run(base({ meta: { id: "s", code: "S", title: "Phones", version: "1", status: "live" } }), [{ op: "create_maxdiff", ref: "MD", items: ITEMS, perTask: 4, tasks: 9, versions: 2 }]).def;
  const out = run(made, [{ op: "update_maxdiff", target: "MD", tasks: 10 }]);
  assert.match(out.destructive.join(" "), /while the survey is live: respondents who already answered saw the previous tasks/);
  assert.ok(out.warnings.some((w) => /answers collected so far belong to the previous design/.test(w)));
  assert.deepEqual(run(made, [{ op: "update_maxdiff", target: "MD", bestLabel: "Best" }]).destructive, []);
});

test("create_conjoint (CBC): attributes resolved, sensible defaults said, the design attached", () => {
  const out = run(base(), [{ op: "create_conjoint", ref: "CBC", attributes: ATTRS, text: "Which phone would you buy?" }]);
  assert.deepEqual(out.errors, []);
  const q = out.def.questions.find((x) => x.variableName === "CBC")!;
  assert.equal(q.type, "conjoint_task");
  assert.equal(q.variant, "conjoint.cbc");
  const d = out.def.designs[0];
  assert.equal(d.kind, "conjoint");
  assert.deepEqual(d.config, { attributes: ATTRS, alternativesPerTask: 3, tasks: 12, versions: 10, method: "efficient" });
  assert.match(out.results[0].description, /choice-based conjoint \(CBC\).*Assumed \(not stated\): 3 alternatives per task, 12 tasks, 10 versions/);
  assert.match(out.results[0].description, /CBC_VERSION, CBC_T<n> \(the chosen design alternative\)/);
});

test("update_conjoint: None and a prohibition added, nothing else; wrong method / wrong op refused", () => {
  const made = run(base(), [{ op: "create_conjoint", ref: "CBC", attributes: ATTRS, alternatives: 3, tasks: 12, versions: 4 }]).def;
  const d0 = made.designs[0];
  const out = run(made, [{ op: "update_conjoint", target: "CBC", none: true, addProhibitions: [{ brand: "gamma", Battery: "3 DAYS" }] }]);
  assert.deepEqual(out.errors, []);
  const d1 = out.def.designs[0];
  assert.deepEqual(d1.config, { ...d0.config, noneOption: true, prohibitions: [{ a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Battery", level: "3 days" } }] });
  assert.equal(d1.seed, d0.seed);
  assert.match(out.results[0].description, /None option not set → on/);
  const none = run(made, [{ op: "update_conjoint", target: "CBC", none: "None of these phones" }]);
  assert.equal(none.def.designs[0].config.noneLabel, "None of these phones");
  assert.match(run(made, [{ op: "update_conjoint", target: "CBC", addProhibitions: [["Brand: Alpha", "Brand: Beta"]] }]).errors[0], /two different attributes/);
  assert.match(run(made, [{ op: "update_conjoint", target: "CBC", addProhibitions: [{ Brand: "Delta", Price: "$199" }] }]).errors[0], /“Delta” is not a level of Brand \(Alpha, Beta, Gamma\)/);
  assert.match(run(made, [{ op: "update_conjoint", target: "CBC", method: "menu" }]).errors[0], /different question and design — create one with create_conjoint/);
  assert.match(run(made, [{ op: "update_maxdiff", target: "CBC", perTask: 5 }]).errors[0], /use update_conjoint/);
  assert.match(run(made, [{ op: "update_conjoint", target: "Q1", tasks: 5 }]).errors[0], /not a MaxDiff or conjoint question with a design/);
  // levels of one attribute replaced; a prohibition naming a removed level dropped and said
  const lv = run(out.def, [{ op: "update_conjoint", target: "CBC", levels: { battery: ["1 day", "2 days"] } }]);
  assert.deepEqual((lv.def.designs[0].config.attributes as { name: string; levels: string[] }[])[2], { name: "Battery", levels: ["1 day", "2 days"] });
  assert.equal(lv.def.designs[0].config.prohibitions, undefined);
  assert.match(lv.results[0].description, /dropped 1 prohibition naming a level that is no longer in the design/);
});

test("ACBC and menu: their own fields; CBC-only fields refused with the reason, not ignored", () => {
  const acbc = run(base(), [{ op: "create_conjoint", method: "adaptive", attributes: ATTRS, screeningTasks: 5 }]);
  assert.deepEqual(acbc.errors, []);
  assert.equal(acbc.def.questions[2].variant, "conjoint.acbc");
  assert.equal(acbc.def.designs[0].kind, "acbc");
  assert.match(run(base(), [{ op: "create_conjoint", method: "acbc", attributes: ATTRS, versions: 10 }]).errors[0], /does not apply to ACBC/);
  const menu = run(base(), [{ op: "create_conjoint", method: "menu", items: [{ name: "Base plan", prices: ["$10"] }, { name: "Extra data", prices: ["$2", "$4"] }], requiredItems: ["base plan"] }]);
  assert.deepEqual(menu.errors, []);
  assert.equal(menu.def.questions[2].variant, "conjoint.pricing_configurator");
  assert.deepEqual(menu.def.designs[0].config.requiredItems, ["Base plan"]);
  assert.match(run(base(), [{ op: "create_conjoint", method: "menu", items: [{ name: "A", prices: ["$1"] }], alternatives: 3 }]).errors[0], /does not apply to a menu-based conjoint/);
});

test("least fill: basis (completes), tie-break and the Back/change rule are settable; a least-fill setting on another method is refused", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "lf", version: "1" },
    questions: [
      { id: "qa", code: "QA", variableName: "QA", type: "multi_select", text: "Brands", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }] },
      { id: "qb", code: "QB", variableName: "QB", type: "single_select", text: "Deep dive", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }] },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["qa"] }, { type: "page", id: "p2", questionIds: ["qb"] }, { type: "end", id: "e", status: "complete" }],
  });
  const out = run(def, [{ op: "create_list_fill", name: "DEEP", source: "QA", count: 1, method: "least fill", basis: "completes", onChange: "keep", destinations: ["QB"] }]);
  assert.deepEqual(out.errors, []);
  const lf = out.def.listFills[0];
  assert.equal(lf.selection.method, "least_filled");
  assert.deepEqual(lf.selection.leastFilled, { basis: "completed", tieBreak: "random" });
  assert.equal(lf.selection.onChange, "keep_valid");
  assert.match(out.results[0].description, /least-filled first \(fewest completed interviews\).*on a changed answer: keep what still qualifies and top up/);
  const upd = run(out.def, [{ op: "update_list_fill", listFill: "DEEP", tieBreak: "sequential" }]);
  assert.deepEqual(upd.def.listFills[0].selection.leastFilled, { basis: "completed", tieBreak: "sequential" }, "the basis is kept");
  assert.equal(upd.def.listFills[0].selection.onChange, "keep_valid");
  const random = run(def, [{ op: "create_list_fill", name: "R", source: "QA", count: 1, method: "random", destinations: ["QB"] }]);
  assert.match(run(random.def, [{ op: "update_list_fill", listFill: "R", basis: "completed" }]).errors[0], /basis and tieBreak are least fill's settings/);
  assert.match(rejected({ op: "update_list_fill", listFill: "R", basis: "weekly" }), /basis is auto .* not “weekly”/);
});

import { interpretRequest } from "./nlIntent.js";
test("the engine's grammar hands MaxDiff / conjoint configuration to the model (with the methods guide); questions about the method stay", () => {
  const made = run(base(), [{ op: "create_conjoint", ref: "CBC", attributes: ATTRS }]).def;
  for (const s of ["add a None option to the conjoint", "Create a MaxDiff study to identify the most and least important product features", "make the MaxDiff 5 items per task", "prohibit Gamma at $199 in the CBC", "Create a choice-based conjoint with four attributes and three levels per attribute"]) {
    const i = interpretRequest(made, s);
    assert.equal(i.kind, "model", `${s}: ${i.kind} ${"reason" in i ? i.reason : ""}`);
  }
  assert.match((interpretRequest(made, "add a None option to the conjoint") as { reason: string }).reason, /design actions and the methods guide/);
  const why = interpretRequest(made, "why maxdiff scores?");
  assert.doesNotMatch("reason" in why ? String(why.reason) : "", /design actions/, "a question about the method is not a design request");
});

test("an update never adds settings the design did not have (a panel-made design keeps its generator defaults)", () => {
  const made = run(base(), [{ op: "create_maxdiff", ref: "MD", items: ITEMS, perTask: 4, tasks: 9, versions: 2 }]).def;
  // as the Design Generators panel stores it: no tasks (the generator's default), no versions
  const d = made.designs[0];
  d.config = { items: ITEMS, itemsPerTask: 4 };
  const out = run(made, [{ op: "update_maxdiff", target: "MD", bestLabel: "Best" }]);
  assert.deepEqual(out.def.designs[0].config, { items: ITEMS, itemsPerTask: 4, bestLabel: "Best" });
  assert.doesNotMatch(out.results[0].description, /Assumed/);
});
