import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { changeItems, CHANGE_CATEGORIES } from "./changeItems.js";
import type { ChangeItem } from "./changeItems.js";

/**
 * THE CHANGE TREE IS ONE ROW PER FIELD THAT DIFFERS, IN WORDS.
 *
 * One before/after pair carries every kind of change the review has to
 * render — an option renamed, recoded and removed; display logic replaced;
 * a skip added; a question moved; a type changed; a block renamed; a
 * question added; a translation written; a crosstab planned — and each test
 * finds its row and checks the level, category, kind, old and new value, the
 * option it names, and the dependents attached to it. The last test is the
 * contract the UI relies on: nothing in `from` / `to` is JSON.
 */

const before = () =>
  SurveyDefinition.parse({
    meta: { id: "svy", code: "CHG", title: "Changes" },
    questions: [
      { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender?", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: [{ code: 1, label: "Very dissatisfied" }, { code: 2, label: "Dissatisfied" }, { code: 3, label: "Neutral" }, { code: 4, label: "Satisfied" }, { code: 5, label: "Very satisfied" }] },
      { id: "q9", code: "Q9", variableName: "WHY", type: "text", text: "Why neutral?", displayLogic: cond.rule("SAT", "eq", 3) },
      { id: "q11", code: "Q11", variableName: "RECO", type: "single_select", text: "Recommend?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q12", code: "Q12", variableName: "NOTE", type: "text", text: "Anything else?" },
    ],
    quotas: [{ id: "qt1", name: "Happy", cells: [{ id: "cell1", label: "Top two", when: cond.rule("SAT", "in", [4, 5]), limit: 50 }] }],
    research: { hypotheses: ["Satisfaction differs by gender"], constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q7"] }], analysisPlan: { crosstabs: [], tests: [] } },
    localization: { sourceLanguage: "en", languages: [{ code: "de" }], translations: { de: {} } },
    flow: [
      { type: "block", id: "blk_a", title: "Screening", children: [{ type: "page", id: "p1", questionIds: ["q1", "q7"] }] },
      { type: "block", id: "blk_b", title: "Main", children: [{ type: "page", id: "p2", questionIds: ["q9", "q11"] }, { type: "page", id: "p3", questionIds: ["q12"] }] },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

const after = () => {
  const def = structuredClone(before());
  const q7 = def.questions[1];
  q7.options[1].label = "Somewhat dissatisfied";                       // rename
  q7.options[4].code = 9;                                              // recode 5 → 9 (no option ids: paired by label)
  q7.options.splice(3, 1);                                             // remove 4 "Satisfied"
  def.questions[2].displayLogic = cond.rule("SAT", "in", [2, 3]);     // display logic replaced
  def.questions[3].skipLogic = [{ id: "sk1", when: cond.rule("SAT", "eq", 9), target: { kind: "question", ref: "q12" } }]; // skip added
  def.questions[0] = { ...def.questions[0], type: "numeric", options: [] };  // type change
  def.questions.push({ id: "q13", code: "Q13", variableName: "COMMENTS", type: "text", text: "Any <i>comments</i>?", options: [], rows: [], columns: [], validation: [], required: false, settings: {}, skipLogic: [], listLogic: [], optionPipeline: [], punches: [] } as never);
  const blkA = def.flow[0] as { title: string }; blkA.title = "Screener";          // block rename
  const p2 = (def.flow[1] as { children: { questionIds: string[] }[] }).children[0];
  const p3 = (def.flow[1] as { children: { questionIds: string[] }[] }).children[1];
  p2.questionIds = ["q11"]; p3.questionIds = ["q12", "q9", "q13"];                   // Q9 moved after Q12; Q13 placed
  def.localization!.translations.de["q:q7:text"] = { text: "Wie zufrieden sind Sie?", status: "edited", version: 1, history: [] };
  def.research!.analysisPlan!.crosstabs.push({ id: "xt_1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] });
  return SurveyDefinition.parse(def);
};

const results = [
  { index: 0, op: "update_question", ok: true, description: "Changed Q7", destructive: "removes option “Satisfied” from Q7", touched: ["q7"] },
  { index: 1, op: "set_display_logic", ok: true, description: "Q9 shown only when …", destructive: "Replaces the display logic of Q9", touched: ["q9"] },
  { index: 2, op: "rename_block", ok: true, description: "Renamed block", touched: ["blk_a"] },
];

const pick = (items: ChangeItem[], category: string, pred: (i: ChangeItem) => boolean = () => true) => items.find((i) => i.category === category && pred(i));

test("options: a rename, a recode and a removal are three rows on Q7, each naming its option", () => {
  const tree = changeItems(before(), after(), { results });
  const renamed = pick(tree.items, "Option label");
  assert.ok(renamed);
  assert.equal(renamed.level, "option");
  assert.equal(renamed.kind, "modified");
  assert.equal(renamed.question?.code, "Q7");
  assert.deepEqual(renamed.option, { code: 2, label: "Somewhat dissatisfied", index: 2 });
  assert.equal(renamed.from, "Dissatisfied");
  assert.equal(renamed.to, "Somewhat dissatisfied");
  assert.deepEqual(renamed.actionIndexes, [0], "the update_question result touched Q7");
  const recoded = pick(tree.items, "Option code");
  assert.ok(recoded, "5 → 9 is read as a recode of “Very satisfied”, not a removal and an addition");
  assert.equal(recoded.from, "5");
  assert.equal(recoded.to, "9");
  assert.equal(recoded.option?.code, 9);
  const quota = recoded.affected.find((a) => a.object.kind === "quota");
  assert.ok(quota, "the quota cell compares SAT with 5");
  assert.equal(quota.severity, "breaks");
  const removed = pick(tree.items, "Options", (i) => i.kind === "removed" && i.question?.code === "Q7");
  assert.ok(removed);
  assert.equal(removed.option?.code, 4);
  assert.equal(removed.from, "Satisfied");
  assert.equal(removed.affected.find((a) => a.object.kind === "quota")?.severity, "breaks");
  assert.equal(removed.destructive, "removes option “Satisfied” from Q7", "the engine's note rides on the row");
  assert.ok(!pick(tree.items, "Options", (i) => i.kind === "added" && i.question?.code === "Q7"), "nothing was added to Q7");
  assert.ok(!pick(tree.items, "Option order", (i) => i.question?.code === "Q7"), "the surviving options kept their order");
});

test("logic: display logic replaced is one modified row with both conditions in words; a skip added is one added row", () => {
  const tree = changeItems(before(), after(), { results });
  const display = pick(tree.items, "Display logic", (i) => i.question?.code === "Q9");
  assert.ok(display);
  assert.equal(display.level, "logic");
  assert.equal(display.kind, "modified");
  assert.match(display.from!, /= 3/);
  assert.match(display.to!, /2, 3|in/);
  assert.deepEqual(display.affected, [], "a changed condition has no dependents of its own — its text is the change");
  assert.equal(display.destructive, "Replaces the display logic of Q9");
  assert.ok(display.technical && "before" in display.technical && "after" in display.technical, "the trees go in technical, not in from / to");
  const skip = pick(tree.items, "Skip logic");
  assert.ok(skip);
  assert.equal(skip.kind, "added");
  assert.equal(skip.question?.code, "Q11");
  assert.equal(skip.from, undefined);
  assert.match(skip.to!, /^when .*→ Q12$/);
});

test("a moved question is one Placement row with positions; its neighbours that merely shifted are not", () => {
  const tree = changeItems(before(), after(), { results });
  const moved = tree.items.filter((i) => i.category === "Placement");
  assert.deepEqual(moved.map((i) => i.question?.code), ["Q9"], "Q11 and Q12 shifted, Q9 moved");
  assert.equal(moved[0].kind, "moved");
  assert.equal(moved[0].detail, "moved from position 3 to 5");
  assert.match(moved[0].from!, /“Main” #3/);
  assert.match(moved[0].to!, /“Main” #5/);
});

test("a type change names both types and carries the readers of the question", () => {
  const tree = changeItems(before(), after(), { results });
  const typed = pick(tree.items, "Question type");
  assert.ok(typed);
  assert.equal(typed.question?.code, "Q1");
  assert.equal(typed.kind, "modified");
  assert.match(typed.from!, /single select|radio/i);
  assert.match(typed.to!, /numeric/i);
  assert.ok(typed.affected.some((a) => a.object.kind === "analysis" && a.via === "analysis plan"), "the planned crosstab reads GENDER");
  // the options the type change dropped are rows too
  assert.equal(tree.items.filter((i) => i.category === "Options" && i.kind === "removed" && i.question?.code === "Q1").length, 2);
});

test("blocks, added questions, translations and the plan each have their row", () => {
  const tree = changeItems(before(), after(), { results });
  const block = pick(tree.items, "Block");
  assert.ok(block);
  assert.equal(block.level, "block");
  assert.equal(block.kind, "modified");
  assert.deepEqual(block.block, { id: "blk_a", title: "Screener" });
  assert.equal(block.from, "Screening");
  assert.equal(block.to, "Screener");
  assert.deepEqual(block.actionIndexes, [2]);
  const added = pick(tree.items, "Question", (i) => i.kind === "added");
  assert.ok(added);
  assert.equal(added.question?.code, "Q13");
  assert.equal(added.question?.text, "Any comments?", "plain text, no markup");
  assert.match(added.to!, /Any comments\?/);
  assert.match(added.detail!, /“Main”/);
  assert.equal(added.destructive, undefined);
  const tr = pick(tree.items, "Translation");
  assert.ok(tr);
  assert.equal(tr.level, "language");
  assert.equal(tr.kind, "added");
  assert.match(tr.field, /Deutsch translations/);
  assert.equal(tr.to, "1 written");
  assert.equal(tr.detail, "Q7");
  const plan = pick(tree.items, "Analysis plan");
  assert.ok(plan);
  assert.equal(plan.level, "analysis");
  assert.equal(plan.kind, "added");
  assert.equal(plan.field, "crosstab");
  assert.equal(plan.to, "SAT by GENDER");
  // nothing invented: no page-break rows (the breaks are where they were), no research-design rows, no theme or ux rows
  assert.equal(tree.items.filter((i) => ["Page break", "Research design", "Theme", "Style"].includes(i.category)).length, 0);
});

test("the tree groups by question in survey order, keeps survey-level rows apart, and counts by level", () => {
  const tree = changeItems(before(), after(), { results });
  const codes = tree.byQuestion.map((g) => g.question.code);
  assert.deepEqual(codes, ["Q1", "Q7", "Q11", "Q12", "Q9", "Q13"].filter((c) => codes.includes(c)), `after order: ${codes.join(", ")}`);
  assert.ok(codes.indexOf("Q7") < codes.indexOf("Q9"));
  const q7 = tree.byQuestion.find((g) => g.question.code === "Q7")!;
  assert.ok(q7.items.length >= 3 && q7.items.every((i) => i.question?.id === "q7"));
  for (const it of tree.survey) assert.ok(!it.question && !it.block, it.id);
  assert.ok(tree.survey.some((i) => i.category === "Analysis plan"));
  assert.ok(tree.blocks.every((i) => i.block && !i.question));
  assert.equal(tree.blocks.length, 1);
  assert.equal(tree.counts.option, tree.items.filter((i) => i.level === "option").length);
  assert.equal(Object.values(tree.counts).reduce((a, b) => a + b, 0), tree.items.length);
  assert.ok(tree.impact.count > 0, "the rows' dependents roll up into one report");
  assert.ok(tree.impact.items.some((i) => i.object.kind === "quota"));
  for (const it of tree.items) { assert.equal(it.status, "proposed"); assert.ok(CHANGE_CATEGORIES.includes(it.category), it.category); assert.match(it.id, /^[a-z]+:.+:.+/); }
  assert.equal(new Set(tree.items.map((i) => i.id)).size, tree.items.length, "ids are unique within the tree");
});

test("no from / to value is JSON, and identical surveys produce no rows", () => {
  const tree = changeItems(before(), after(), { results });
  for (const it of tree.items) {
    for (const v of [it.from, it.to, it.detail]) if (v) assert.ok(!v.includes('{"') && !v.includes("[{"), `${it.id}: ${v}`);
  }
  const none = changeItems(before(), before());
  assert.deepEqual(none.items, []);
  assert.equal(none.impact.count, 0);
});

test("without results, a destructive note is matched to the question it names", () => {
  const tree = changeItems(before(), after(), { destructive: ["removes option “Satisfied” from Q7", "Replaces the display logic of Q9"] });
  const removed = pick(tree.items, "Options", (i) => i.kind === "removed" && i.question?.code === "Q7");
  assert.equal(removed?.destructive, "removes option “Satisfied” from Q7");
  const display = pick(tree.items, "Display logic", (i) => i.question?.code === "Q9");
  assert.equal(display?.destructive, "Replaces the display logic of Q9");
  assert.deepEqual(removed?.actionIndexes, [], "unknown without results");
  const added = pick(tree.items, "Question", (i) => i.kind === "added");
  assert.equal(added?.destructive, undefined, "an addition never carries a note");
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 2) */

type Def = ReturnType<typeof before>;
const pair = (edit: (b: Def) => void, edit2: (a: Def) => void): [Def, Def] => {
  const b = structuredClone(before()); edit(b);
  const a = structuredClone(b); edit2(a);
  return [SurveyDefinition.parse(b), SurveyDefinition.parse(a)];
};
const withSkip = (b: Def) => { b.questions[3].skipLogic = [{ id: "sk1", when: cond.rule("SAT", "eq", 5), target: { kind: "question", ref: "q12" } }] as never; };
const page = (d: Def, id: string) => (d.flow as { children?: { id: string; questionIds: string[] }[] }[]).flatMap((n) => n.children ?? []).find((p) => p.id === id)!;

test("affected: a type change lists its direct readers, judged as a retype; a removed question takes the readers' readers too", () => {
  const [b, a] = pair(withSkip, (a) => { a.questions[1] = { ...a.questions[1], type: "open_text", variant: undefined, options: [] } as never; });
  const typed = pick(changeItems(b, a).items, "Question type")!;
  assert.ok(typed.affected.length > 0);
  assert.ok(typed.affected.every((i) => !i.indirect), "Q11, reached through its skip, is not a direct reader");
  assert.equal(typed.affected.find((i) => i.object.kind === "quota")?.severity, "breaks", "`in` does not fit a text answer");
  const [b2, a2] = pair(withSkip, (a) => { a.questions.splice(1, 1); page(a, "p1").questionIds = ["q1"]; });
  const removed = pick(changeItems(b2, a2).items, "Question", (i) => i.kind === "removed")!;
  assert.ok(removed.affected.some((i) => i.indirect && i.object.id === "q11"), JSON.stringify(removed.affected.map((i) => [i.object.id, i.indirect])));
});

test("action results: only the ones that applied are attached — a refused action's index and note do not ride on the rows", () => {
  const refused = [{ index: 0, op: "update_question", ok: false, description: "Change Q7", error: "refused", destructive: "removes option “Satisfied” from Q7", touched: ["q7"] }];
  const removed = pick(changeItems(before(), after(), { results: refused }).items, "Options", (i) => i.kind === "removed" && i.question?.code === "Q7")!;
  assert.deepEqual(removed.actionIndexes, []);
  assert.equal(removed.destructive, undefined);
});

test("a destructive note is matched to a code as a whole word: a note about Q12 is not Q1's", () => {
  const tree = changeItems(before(), after(), { destructive: ["Replaces the display logic of Q12"] });
  const typed = pick(tree.items, "Question type")!;
  assert.equal(typed.question?.code, "Q1");
  assert.equal(typed.destructive, undefined);
});

test("an added option never carries the engine's note, even when the action that added it was destructive", () => {
  const [b, a] = pair(() => {}, (a) => { a.questions[1].options.push({ code: 6, label: "Delighted", flags: [] } as never); });
  const tree = changeItems(b, a, { results: [{ index: 0, op: "update_question", ok: true, description: "Changed Q7", destructive: "replaces the options of Q7", touched: ["q7"] }] });
  const added = pick(tree.items, "Options", (i) => i.kind === "added")!;
  assert.equal(added.option?.code, 6);
  assert.equal(added.destructive, undefined);
  assert.deepEqual(added.actionIndexes, [0]);
});

test("skip rules: one replaced by another at the same place is two rows with two ids; one removed is a removed row", () => {
  const [b, a] = pair(withSkip, (a) => { a.questions[3].skipLogic = [{ id: "sk2", when: cond.rule("SAT", "eq", 1), target: { kind: "question", ref: "q12" } }] as never; });
  const skips = changeItems(b, a).items.filter((i) => i.category === "Skip logic");
  assert.deepEqual(skips.map((i) => i.kind).sort(), ["added", "removed"]);
  assert.equal(new Set(skips.map((i) => i.id)).size, 2, skips.map((i) => i.id).join(", "));
  const [b2, a2] = pair(withSkip, (a) => { a.questions[3].skipLogic = []; });
  const gone = changeItems(b2, a2).items.filter((i) => i.category === "Skip logic");
  assert.deepEqual(gone.map((i) => [i.kind, i.field, i.to]), [["removed", "skip rule 1", undefined]]);
  assert.match(gone[0].from!, /^when .*= 5 → Q12$/);
});

test("display logic: a condition removed lists what reads the question; a condition changed does not", () => {
  const readsWhy = (b: Def) => { b.questions[4].displayLogic = cond.rule("WHY", "answered"); };
  const [b, a] = pair(readsWhy, (a) => { a.questions[2].displayLogic = cond.rule("SAT", "eq", 2); });
  assert.deepEqual(pick(changeItems(b, a).items, "Display logic", (i) => i.question?.code === "Q9")!.affected, []);
  const [b2, a2] = pair(readsWhy, (a) => { delete (a.questions[2] as { displayLogic?: unknown }).displayLogic; });
  const removed = pick(changeItems(b2, a2).items, "Display logic", (i) => i.question?.code === "Q9")!;
  assert.equal(removed.kind, "removed");
  assert.ok(removed.affected.some((i) => i.object.id === "q12"), "Q12 reads Q9 and now always sees it");
});

test("placement: a question that changes block keeps its rank and is still a move; a swap of neighbours names the one that went down", () => {
  const [b, a] = pair(() => {}, (a) => { page(a, "p1").questionIds = ["q1"]; page(a, "p2").questionIds = ["q7", "q9", "q11"]; });
  const moved = changeItems(b, a).items.filter((i) => i.category === "Placement");
  assert.deepEqual(moved.map((i) => i.question?.code), ["Q7"]);
  assert.equal(moved[0].detail, "moved from position 2 to 2 (“Screening” → “Main”)");
  const [b2, a2] = pair(() => {}, (a) => { page(a, "p2").questionIds = ["q11", "q9"]; });
  const swap = changeItems(b2, a2).items.filter((i) => i.category === "Placement");
  assert.deepEqual(swap.map((i) => [i.question?.code, i.detail]), [["Q9", "moved from position 3 to 4"]]);
});

test("options: paired by id before code — two options that swapped codes are two recodes, not two relabels", () => {
  const ids = (b: Def) => { b.questions[3].options = [{ id: "o_yes", code: 1, label: "Yes", flags: [] }, { id: "o_no", code: 2, label: "No", flags: [] }] as never; };
  const [b, a] = pair(ids, (a) => { a.questions[3].options = [{ id: "o_yes", code: 2, label: "Yes", flags: [] }, { id: "o_no", code: 1, label: "No", flags: [] }] as never; });
  const items = changeItems(b, a).items.filter((i) => i.question?.code === "Q11");
  assert.deepEqual(items.map((i) => [i.category, i.from, i.to]), [["Option code", "1", "2"], ["Option code", "2", "1"]]);
});

test("options: a recode needs one removed and one added option with that label — two removed “Other”s and one new are a removal and a replacement", () => {
  const [b, a] = pair((b) => { b.questions[3].options = [{ code: 1, label: "Other", flags: [] }, { code: 2, label: "Other", flags: [] }, { code: 3, label: "Yes", flags: [] }] as never; },
    (a) => { a.questions[3].options = [{ code: 3, label: "Yes", flags: [] }, { code: 7, label: "Other", flags: [] }] as never; });
  const items = changeItems(b, a).items.filter((i) => i.question?.code === "Q11");
  assert.deepEqual(items.map((i) => [i.category, i.kind, i.option?.code]), [["Options", "removed", 1], ["Options", "removed", 2], ["Options", "added", 7]]);
});

test("options: a relabel lists only the translations keyed to the option, not the logic comparing its code", () => {
  const [b, a] = pair(() => {}, (a) => { a.questions[1].options[2].label = "Neither"; });
  const label = pick(changeItems(b, a).items, "Option label")!;
  assert.equal(label.option?.code, 3);
  assert.deepEqual(label.affected, [], "Q9 compares code 3, which did not change");
});

test("option order: a recoded option still anchors the order; options that only shifted are not moves", () => {
  const [b, a] = pair((b) => { b.questions[3].options = [{ code: 1, label: "R", flags: [] }, { code: 2, label: "A", flags: [] }, { code: 3, label: "B", flags: [] }] as never; },
    (a) => { a.questions[3].options = [{ code: 3, label: "B", flags: [] }, { code: 9, label: "R", flags: [] }, { code: 2, label: "A", flags: [] }] as never; });
  const order = changeItems(b, a).items.filter((i) => i.category === "Option order");
  assert.deepEqual(order.map((i) => i.field), ["option 3 position"], "R (recoded to 9) and A kept their order; B moved to the top");
  const [b2, a2] = pair(() => {}, (a) => { a.questions[3].options.unshift({ code: 3, label: "Maybe", flags: [] } as never); });
  const items = changeItems(b2, a2).items.filter((i) => i.question?.code === "Q11");
  assert.deepEqual(items.map((i) => [i.category, i.kind]), [["Options", "added"]], "Yes and No moved down one place because of the addition, not because they moved");
});

test("blocks: a lone page wrapped into a block container is the same block, not a removal and an addition", () => {
  const [b, a] = pair((b) => { b.flow[0] = (b.flow[0] as { children: unknown[] }).children[0] as never; },
    (a) => { a.flow[0] = { type: "block", id: "blk_new", title: "Screening", children: [a.flow[0]] } as never; });
  assert.deepEqual(changeItems(b, a).items.filter((i) => i.category === "Block"), []);
});

test("page breaks: only on questions both sides have — a new question on its own page is its own row, not a page-break row", () => {
  const [b, a] = pair(() => {}, (a) => {
    a.questions.push({ ...structuredClone(a.questions[4]), id: "q13", code: "Q13", variableName: "MORE", text: "More?" });
    (a.flow[1] as { children: unknown[] }).children.splice(1, 0, { type: "page", id: "p_new", questionIds: ["q13"] });
  });
  const items = changeItems(b, a).items;
  assert.ok(pick(items, "Question", (i) => i.kind === "added"));
  assert.deepEqual(items.filter((i) => i.category === "Page break"), []);
});

test("embedded data: one field gone and one new with the same settings is a rename row", () => {
  const field = (name: string) => ({ type: "embedded_data", id: "ed1", fields: [{ name, source: "url" }] });
  const [b, a] = pair((b) => { b.flow.splice(2, 0, field("PANEL") as never); }, (a) => { a.flow[2] = field("PANEL_ID") as never; });
  const items = changeItems(b, a).items.filter((i) => i.category === "Embedded data");
  assert.deepEqual(items.map((i) => [i.kind, i.field, i.from, i.to]), [["modified", "name", "PANEL", "PANEL_ID"]]);
});

test("translations: an empty or not-translated entry is not written; writing into a language that had some is a modification", () => {
  const tr = (text: string, status: string) => ({ text, status, version: 1, history: [] });
  const [b, a] = pair(() => {}, (a) => { a.localization!.translations.de["q:q9:text"] = tr("", "not_translated") as never; });
  assert.deepEqual(changeItems(b, a).items.filter((i) => i.category === "Translation"), []);
  const [b2, a2] = pair((b) => { b.localization!.translations.de["q:q7:text"] = tr("Wie zufrieden?", "edited") as never; },
    (a) => { a.localization!.translations.de["q:q9:text"] = tr("Warum neutral?", "edited") as never; });
  const row = pick(changeItems(b2, a2).items, "Translation")!;
  assert.equal(row.kind, "modified");
  assert.equal(row.to, "1 written");
});

test("option flags in words: anchored last is not anchored first", () => {
  const [b, a] = pair(() => {}, (a) => { a.questions[3].options[1].flags = ["anchor_bottom"]; });
  const flags = pick(changeItems(b, a).items, "Option flags")!;
  assert.deepEqual([flags.from, flags.to], ["none", "anchored last"]);
});

test("wording: a text edit lists the pipes and translations that show it, not the logic that reads the answer", () => {
  const [b, a] = pair((b) => { b.questions[4].text = "You rated {{SAT}}: anything else?"; }, (a) => { a.questions[1].text = "How happy are you?"; });
  const wording = pick(changeItems(b, a).items, "Wording", (i) => i.question?.code === "Q7")!;
  assert.deepEqual(wording.affected.map((i) => [i.object.id, i.via]), [["q12", "piping"]]);
});

test("calculations: a new label alone is a modified row", () => {
  const calc = (label: string) => ({ id: "c1", targetVariable: "SCORE", expression: "SAT * 20", label });
  const [b, a] = pair((b) => { b.calculations = [calc("Score")] as never; }, (a) => { a.calculations = [calc("Total score")] as never; });
  const row = pick(changeItems(b, a).items, "Calculation")!;
  assert.equal(row.kind, "modified");
  assert.equal(row.field, "SCORE");
});
