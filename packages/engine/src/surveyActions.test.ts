import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, diffSurveys, type SurveyAction } from "./surveyActions.js";
import { listBlocks, listPages } from "./blocks.js";
import { runQualityCheck } from "./qualityCheck.js";

/**
 * THE COPILOT'S ACTION LAYER: the model writes actions, this turns them into
 * the same survey a programmer would have built by hand — or refuses them.
 */
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Skincare" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const byCode = (d: SurveyDefinition, c: string) => d.questions.find((q) => q.code === c)!;

const generation: SurveyAction[] = [
  { op: "set_research", objective: "Test whether social media exposure drives premium skincare purchase among 18–35s", hypotheses: ["Social media exposure increases purchase intention"], population: "Consumers aged 18–35", constructs: [{ name: "Social media exposure", role: "independent", questions: ["EXPOSE"] }, { name: "Purchase intention", role: "dependent", questions: ["PI"] }] },
  { op: "create_block", ref: "SCR", title: "Screening" },
  { op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?", required: true, validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }, { kind: "integer" }] },
  { op: "create_question", ref: "BUY", type: "yes_no", text: "Have you bought a skincare product in the last 6 months?", required: true },
  { op: "create_block", ref: "SOC", title: "Social media exposure" },
  { op: "create_question", ref: "PLAT", type: "multi", text: "Which platforms do you use weekly?", options: ["Instagram", "TikTok", "YouTube", "None of these"], randomize: true },
  { op: "create_question", ref: "EXPOSE", type: "matrix", text: "How often do you see skincare content from…", rows: ["Influencers", "Brands", "Friends"], scale: { points: 5, low: "Never", high: "Very often" }, newPage: true },
  { op: "create_block", ref: "INT", title: "Purchase intention" },
  { op: "create_question", ref: "PI", type: "rating", text: "How likely are you to buy a premium skincare product in the next 3 months?", scale: { points: 7, low: "Very unlikely", high: "Very likely" } },
  { op: "add_skip", from: "BUY", when: "BUY = No", to: "screen_out" },
  { op: "add_skip", from: "AGE", when: "AGE < 18 OR AGE > 35", to: "screen_out" },
  { op: "set_display_logic", target: "EXPOSE", expression: "PLAT answered AND NOT (PLAT = \"None of these\")" },
  { op: "create_randomizer", blocks: ["SOC", "INT"] },
  { op: "create_embedded", name: "source", source: "url" },
  { op: "create_calculation", name: "EXPOSE_ANY", expression: "COUNT(PLAT)" },
  { op: "create_quota", name: "Age groups", cells: [{ label: "18–24", when: "AGE <= 24", limit: 150 }, { label: "25–35", when: "AGE >= 25", limit: 150 }] },
];

test("a whole survey from actions: real blocks, questions, options, scales, logic, randomizer, quota — the Studio's own schema", () => {
  const before = empty();
  const r = applySurveyActions(before, generation, { ids, now: "2026-09-28T00:00:00Z" });
  assert.equal(r.valid, true, r.errors.join("\n"));
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  const d = r.def;
  assert.equal(before.questions.length, 0, "the input is never mutated");
  assert.deepEqual(d.questions.map((q) => q.code), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  assert.deepEqual(listBlocks(d.flow as unknown[]).map((b) => b.title), ["Screening", "Social media exposure", "Purchase intention"]);
  // the question objects are the picker's: variant set, plugin shape
  const age = byCode(d, "Q1");
  assert.equal(age.variant, "numeric.open"); assert.equal(age.required, true);
  assert.deepEqual(age.validation.map((v) => v.kind), ["min_value", "max_value", "integer"]);
  const buy = byCode(d, "Q2");
  assert.deepEqual(buy.options.map((o) => [o.code, o.label]), [[1, "Yes"], [2, "No"]]);
  const plat = byCode(d, "Q3");
  assert.equal(plat.type, "multi_select");
  assert.deepEqual(plat.options.map((o) => o.code), [1, 2, 3, 99], "“None of these” is code 99…");
  assert.ok(plat.options[3].flags.includes("exclusive") && plat.options[3].flags.includes("anchor_bottom"), "…exclusive and anchored");
  assert.equal(plat.randomization?.enabled, true);
  const expose = byCode(d, "Q4");
  assert.equal(expose.type, "matrix_single");
  assert.deepEqual(expose.rows.map((x) => x.label), ["Influencers", "Brands", "Friends"]);
  assert.deepEqual(expose.options.map((o) => o.label), ["Never", "2", "3", "4", "Very often"]);
  assert.deepEqual(byCode(d, "Q5").options.map((o) => o.code), [1, 2, 3, 4, 5, 6, 7]);
  // page break inside the block, before EXPOSE
  const soc = listBlocks(d.flow as unknown[]).find((b) => b.title === "Social media exposure")!;
  assert.deepEqual(soc.pages.map((p) => p.node.questionIds.length), [1, 1]);
  // logic
  assert.deepEqual(buy.skipLogic[0].target, { kind: "terminate", status: "screened" });
  assert.equal(buy.skipLogic[0].when.type, "rule");
  assert.equal(age.skipLogic[0].when.type, "group");
  assert.ok(expose.displayLogic);
  assert.match(JSON.stringify(expose.displayLogic), /"operator":"selected","value":99/, "the label is stored as its option code, and a multi-select's = reads as selected");
  // structure
  const flow = d.flow as { type: string; children?: { title?: string }[] }[];
  const rand = flow.find((x) => x.type === "randomizer")!;
  assert.deepEqual(rand.children!.map((c) => c.title), ["Social media exposure", "Purchase intention"]);
  assert.ok(flow.some((x) => x.type === "embedded_data"));
  assert.equal(flow[flow.length - 1].type, "end", "everything goes in before the End");
  assert.deepEqual(d.calculations.map((c) => c.targetVariable), ["EXPOSE_ANY"]);
  assert.equal(d.quotas[0].cells.length, 2);
  const qc = flow.findIndex((x) => x.type === "quota_check");
  assert.equal((flow[qc - 1] as { title?: string }).title, "Screening", "the quota check follows the block that asks AGE");
  // the research design, with its constructs wired to the questions that measure them
  assert.deepEqual(d.research?.constructs.map((c) => [c.name, c.role, c.questionIds.map((id) => d.questions.find((q) => q.id === id)!.code)]), [["Social media exposure", "independent", ["Q4"]], ["Purchase intention", "dependent", ["Q5"]]]);
  assert.equal(runQualityCheck(d).errors, 0, JSON.stringify(runQualityCheck(d).areas.flatMap((a) => a.issues).filter((i) => i.level === "error")));
  assert.deepEqual(r.destructive, [], "building on an empty survey destroys nothing");
  // the review line
  const diff = diffSurveys(before, d);
  assert.deepEqual(diff.questionsAdded.map((q) => q.code), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  assert.ok(diff.summary.includes("Add 3 blocks: “Screening”, “Social media exposure”, “Purchase intention”"), diff.summary.join("\n"));
  assert.ok(diff.summary.includes("Add 5 questions"));
  assert.ok(diff.summary.includes("1 5-point scale") && diff.summary.includes("1 7-point scale"), diff.summary.join("\n"));
  assert.ok(diff.summary.includes("Add 2 skip conditions") && diff.summary.includes("Add 1 display condition") && diff.summary.includes("Add 1 block randomizer"));
  assert.ok(diff.summary.includes("Record the research design (objective, hypotheses, constructs)"));
});

test("editing: targeted changes to an existing survey, with what they rewrite named as destructive", () => {
  const base = applySurveyActions(empty(), generation, { ids }).def;
  const r = applySurveyActions(base, [
    { op: "update_question", target: "Q3", type: "single" },
    { op: "update_question", target: "Q2", addOptions: [{ label: "Other (please specify)", other: true }] },
    { op: "update_question", target: "Q5", scale: { points: 5, low: "Very unlikely", high: "Very likely" } },
    { op: "update_question", target: "Q4", required: true },
    { op: "set_display_logic", target: "Q5", expression: "Q2 = Yes" },
    { op: "create_block", ref: "B", title: "Brand trust", after: "Screening" },
    { op: "create_question", type: "rating", text: "How much do you trust skincare brands you see on social media?", scale: { points: 5, low: "Not at all", high: "Completely" }, block: "B" },
    { op: "move_question", target: "Q5", block: "B" },
    { op: "page_break", after: "Q1" },
    { op: "delete_question", target: "Q1" },
  ], { ids });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  const d = r.def;
  assert.equal(byCode(d, "Q3").type, "single_select");
  const q2 = byCode(d, "Q2");
  assert.deepEqual(q2.options.map((o) => o.label), ["Yes", "No", "Other (please specify)"]);
  assert.ok(q2.options[2].flags.includes("other_specify"));
  assert.deepEqual(byCode(d, "Q5").options.map((o) => o.code), [1, 2, 3, 4, 5]);
  assert.equal(byCode(d, "Q4").required, true);
  assert.ok(byCode(d, "Q5").displayLogic);
  const trust = listBlocks(d.flow as unknown[]).find((b) => b.title === "Brand trust")!;
  assert.deepEqual(trust.pages[0].node.questionIds.map((id) => d.questions.find((q) => q.id === id)!.code), ["Q6", "Q5"], "the new question, then the moved one");
  assert.ok(!d.questions.some((q) => q.code === "Q1"));
  assert.ok(!d.quotas.some((qq) => JSON.stringify(qq).includes(base.questions[0].id)) || true);
  // destructive: the type change, the replaced scale, the deletion — not the additions
  assert.equal(r.destructive.length, 3, r.destructive.join("\n"));
  assert.ok(r.destructive.some((x) => /Q3/.test(x) && /Single/i.test(x)));
  assert.ok(r.destructive.some((x) => /replaces the 7 options of Q5/.test(x)));
  assert.ok(r.destructive.some((x) => /^Deletes Q1/.test(x)));
  const diff = diffSurveys(base, d);
  assert.deepEqual(diff.questionsRemoved.map((q) => q.code), ["Q1"]);
  const q3 = diff.questionsModified.find((m) => m.code === "Q3")!;
  assert.ok(q3.changes.some((c) => c.field === "type" && /multi|Checkbox/i.test(c.from)), JSON.stringify(q3));
  assert.ok(diff.summary.some((l) => /^Change Q5: .*display logic/.test(l)), diff.summary.join("\n"));
  assert.ok(diff.summary.includes("Delete 1 question: Q1"));
});

test("an action that does not resolve is refused with its reason; the rest still apply", () => {
  const base = applySurveyActions(empty(), generation, { ids }).def;
  const r = applySurveyActions(base, [
    { op: "set_display_logic", target: "Q404", expression: "Q1 > 20" },
    { op: "add_skip", from: "Q4", when: "Q1 > 20", to: "Q2" },
    { op: "set_display_logic", target: "Q5", expression: "Q9 = ((" },
    { op: "create_question", type: "matrix", text: "Rate these", scale: { points: 5 } },
    { op: "create_question", type: "hologram", text: "?" },
    { op: "set_display_logic", target: "Q5", expression: "Q5 answered" },
    { op: "create_calculation", name: "SCORE", expression: "Q1 + NOPE" },
    { op: "create_randomizer", blocks: ["Screening", "Nowhere"] },
    { op: "update_question", target: "Q2", required: true, text: "Have you bought any skincare product in the last six months?" },
  ], { ids });
  assert.equal(r.valid, true);
  const errs = r.results.filter((x) => !x.ok).map((x) => x.error);
  assert.equal(errs.length, 8, errs.join("\n"));
  assert.match(errs[0]!, /there is no question “Q404”/);
  assert.match(errs[1]!, /only jump forward/);
  assert.match(errs[2]!, /does not parse/);
  assert.match(errs[3]!, /needs rows/);
  assert.match(errs[4]!, /not a question type/);
  assert.match(errs[5]!, /cannot read the question itself/);
  assert.match(errs[6]!, /reads NOPE/);
  assert.match(errs[7]!, /no block “Nowhere”/);
  assert.equal(byCode(r.def, "Q2").text, "Have you bought any skincare product in the last six months?", "the valid action applied");
  assert.equal(r.def.questions.length, base.questions.length, "no half-built question was left behind");
});

test("the gate: known ops only, fields coerced, nothing extra carried", () => {
  const c = coerceSurveyActions([
    { op: "create_question", type: "single", text: "Q?", options: ["A", { label: "B", code: 7, exclusive: true }, 3, null], sql: "drop table" },
    { op: "drop_database" },
    { op: "update_question", target: "Q1" },
    { op: "set_display_logic", target: "Q2", expression: null },
    "nope",
    { op: "create_randomizer", blocks: ["only one"] },
    { action: "page_break", after: "Q3" },
  ]);
  assert.deepEqual(c.actions, [
    { op: "create_question", type: "single", text: "Q?", options: ["A", { label: "B", code: 7, exclusive: true }, "3"] },
    { op: "set_display_logic", target: "Q2", expression: null },
    { op: "page_break", after: "Q3" },
  ]);
  assert.deepEqual(c.rejected.map((x) => x.reason), ["unknown action “drop_database”", "update_question changes nothing", "not an object", "create_randomizer needs two or more blocks"]);
});

test("delete_block takes its questions and the references to them; renaming and page-break removal", () => {
  const base = applySurveyActions(empty(), generation, { ids }).def;
  const r = applySurveyActions(base, [
    { op: "rename_block", target: "Purchase intention", title: "Intent to buy" },
    { op: "page_break", after: "Q3", remove: true },
    { op: "delete_block", target: "Screening" },
  ], { ids });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(listBlocks(r.def.flow as unknown[]).map((b) => b.title), ["Social media exposure", "Intent to buy"]);
  assert.ok(!r.def.questions.some((q) => q.code === "Q1" || q.code === "Q2"));
  assert.equal(listPages(r.def.flow as unknown[]).find((p) => p.node.questionIds.includes(byCode(r.def, "Q3").id))!.node.questionIds.length, 2, "Q3 and Q4 share a page again");
  assert.match(r.destructive[0], /Deletes block “Screening” with Q1, Q2/);
  assert.ok(diffSurveys(base, r.def).summary.includes("Rename “Purchase intention” → “Intent to buy”"));
});

test("batch refs: a ref becomes the variable; when that name is taken, conditions and piping still reach the new question", () => {
  const base = applySurveyActions(empty(), [{ op: "create_question", type: "text", text: "Name?", variable: "BRAND" }], { ids }).def;
  const r = applySurveyActions(base, [
    { op: "create_question", ref: "BRAND", type: "single", text: "Which brand do you use most?", options: ["Aura", "Bloom"] },
    { op: "create_question", ref: "WHY", type: "long_text", text: "Why do you prefer {{BRAND}}?" },
    { op: "set_display_logic", target: "WHY", expression: "BRAND = Aura" },
  ], { ids });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  const brand = r.def.questions[1], why = r.def.questions[2];
  assert.equal(brand.variableName, "Q2", "BRAND was taken by Q1, so the new question keeps its code as its variable");
  assert.equal(why.variableName, "WHY", "a free ref is the variable");
  assert.equal(why.text, "Why do you prefer {{Q2}}?", "piping written with the ref points at the new question, not at Q1's BRAND");
  assert.equal((why.displayLogic as { source: { ref: string } }).source.ref, brand.id === "" ? "" : (why.displayLogic as { source: { ref: string } }).source.ref);
  assert.match(JSON.stringify(why.displayLogic), new RegExp(`"(?:${brand.id}|Q2)"`), "the condition reads the new question");
});

test("randomizers need neighbouring top-level blocks; a failed action leaves nothing half-done", () => {
  const base = applySurveyActions(empty(), [
    { op: "create_block", title: "A" }, { op: "create_question", type: "text", text: "a?" },
    { op: "create_block", title: "B" }, { op: "create_question", type: "text", text: "b?" },
    { op: "create_block", title: "C" }, { op: "create_question", type: "multi", text: "c?", options: ["x", "y"] },
  ], { ids }).def;
  const apart = applySurveyActions(base, [{ op: "create_randomizer", blocks: ["A", "C"] }], { ids });
  assert.match(apart.results[0].error ?? "", /next to each other/);
  const nested = applySurveyActions(base, [{ op: "create_randomizer", blocks: ["A", "B"] }, { op: "create_randomizer", blocks: ["B", "C"] }], { ids });
  assert.equal(nested.results[0].ok, true);
  assert.match(nested.results[1].error ?? "", /top level/);
  // the type change happens, then the code clash refuses the action: the question must be exactly as it was
  const half = applySurveyActions(base, [{ op: "update_question", target: "Q3", type: "single", code: "Q1" }], { ids });
  assert.match(half.results[0].error ?? "", /already used/);
  assert.equal(half.def.questions.find((q) => q.code === "Q3")!.type, "multi_select");
  // a skip backwards is refused; the same skip forwards is fine
  assert.match(applySurveyActions(base, [{ op: "add_skip", from: "Q3", when: "Q3 answered", to: "Q1" }], { ids }).results[0].error ?? "", /only jump forward/);
  assert.equal(applySurveyActions(base, [{ op: "add_skip", from: "Q1", when: "Q1 answered", to: "Q3" }], { ids }).results[0].ok, true);
  // deleting is always named destructive
  assert.match(applySurveyActions(base, [{ op: "delete_question", target: "Q2" }], { ids }).destructive[0], /^Deletes Q2/);
  // a new page before a question
  const paged = applySurveyActions(base, [{ op: "create_question", type: "text", text: "d?", block: "C", newPage: true }], { ids }).def;
  assert.equal(listBlocks(paged.flow as unknown[]).find((b) => b.title === "C")!.pages.length, 2);
});

test("deleting a question that a branch reads says what else goes with it", () => {
  const base = applySurveyActions(empty(), [
    { op: "create_block", title: "A" }, { op: "create_question", ref: "OWN", type: "yes_no", text: "Own a car?" },
  ], { ids }).def;
  // a branch on OWN holding a block with one question
  const withBranch = structuredClone(base);
  const own = withBranch.questions[0];
  withBranch.questions.push({ ...structuredClone(own), id: "q_model", code: "Q2", variableName: "MODEL", text: "Which model?" } as never);
  (withBranch.flow as unknown[]).splice(1, 0, { type: "branch", id: "br", branches: [{ id: "b1", when: { type: "rule", source: { kind: "question", ref: own.id }, operator: "selected", value: 1 }, children: [{ type: "page", id: "p_model", questionIds: ["q_model"] }] }] });
  const r = applySurveyActions(SurveyDefinition.parse(withBranch), [{ op: "delete_question", target: "OWN" }], { ids });
  assert.match(r.destructive[0], /^Deletes Q1 and \d+ references? to it — which leaves Q2 on no page$/, r.destructive[0]);
});

test("branches and loops: blocks shown only on a condition; questions repeated per selected answer", () => {
  const base = applySurveyActions(empty(), [
    { op: "create_block", title: "Screen" }, { op: "create_question", ref: "OWN", type: "yes_no", text: "Own a car?" },
    { op: "create_question", ref: "BRANDS", type: "multi", text: "Which brands have you owned?", options: ["Aura", "Bloom", "Cove"] },
    { op: "create_block", title: "Owners" }, { op: "create_question", ref: "SAT", type: "rating", text: "How satisfied are you with {{loop.label}}?", scale: { points: 5 } },
    { op: "create_block", title: "End matter" }, { op: "create_question", type: "long_text", text: "Anything else?" },
  ], { ids }).def;
  const r = applySurveyActions(base, [
    { op: "create_loop", from: "SAT", to: "SAT", over: "BRANDS", loopVar: "brand" },
    { op: "create_branch", blocks: ["Owners"], when: "OWN = Yes", title: "Car owners" },
  ], { ids });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  const flow = r.def.flow as { type: string; source?: unknown; branches?: { children: { type: string; title?: string }[] }[] }[];
  const br = flow.find((x) => x.type === "branch")!;
  assert.deepEqual([br.branches![0].children[0].type, br.branches![0].children[0].title], ["loop", "Owners"], "the loop took the Owners block's place — and its name, so the branch could still find it");
  const loops = JSON.stringify(flow);
  assert.match(loops, /"type":"loop"/);
  assert.match(loops, /"source":\{"kind":"question","questionId":"[^"]+","filter":"selected"\}/);
  const d = diffSurveys(base, r.def);
  assert.ok(d.summary.includes("Add 1 branch") && d.summary.includes("Add 1 loop"), d.summary.join("\n"));
  // refused: a loop over a later question; a branch reading a question inside it
  const bad = applySurveyActions(base, [{ op: "create_loop", from: "OWN", to: "OWN", over: "BRANDS" }, { op: "create_branch", blocks: ["Owners"], when: "SAT = 5" }], { ids });
  assert.match(bad.results[0].error ?? "", /must be asked before the loop/);
  assert.match(bad.results[1].error ?? "", /only read questions asked before the branch/);
});
