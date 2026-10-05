import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { contextActions, type SurveyAction } from "@rescript/engine";
import { actionMap, evaluateProposal, changeRecord, type Proposal } from "./client.ts";
import {
  reviewTree, actionCategories, itemStatus, presentIds, refusals, toggleItems, siblings, itemName, applyCount, excludedLabels, validExclusions,
  typeName, questionHeader, optionTitle, optionFacts, impactKey, groupContextActions, CONTEXT_GROUP_ORDER,
} from "./review.ts";

/*
 * THE CHANGE REVIEW'S PURE PART: the flat action index, exclusions through
 * evaluateProposal, the tree's rows and their statuses, what a row's
 * untick takes with it, the Apply count, the history's "excluded", the
 * option preview's facts and the context-action groups.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id: string, code: string, variableName: string, type: string, text: string, extra: Record<string, unknown> = {}) => ({ id, code, variableName, type, text, ...extra });
const fixture = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Cars" },
  questions: [
    q("gender", "Q1", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female") }),
    q("age", "Q2", "AGE", "numeric", "How old are you?"),
    q("city", "Q3", "CITY", "open_text", "Which city do you live in?"),
    q("brands", "Q5", "BRANDS", "multi_select", "Which brands have you bought?", { options: [...opts("Brand A", "Brand B", "Brand C"), { code: 99, label: "None of these", flags: ["exclusive"] }] }),
    q("own", "Q7", "OWN", "single_select", "Do you own a car?", { options: [...opts("Yes", "No", "Leasing"), { code: 4, label: "United Sates" }] }),
    q("make", "Q8", "MAKE", "open_text", "What make is your car?"),
    q("year", "Q9", "YEAR", "numeric", "What year was your car made?"),
  ],
  flow: [
    { type: "block", id: "b0", title: "About you", children: [{ type: "page", id: "p0", questionIds: ["gender", "age", "city", "brands"] }] },
    { type: "block", id: "b1", title: "Cars", children: [{ type: "page", id: "p1", questionIds: ["own"] }, { type: "page", id: "p2", questionIds: ["make", "year"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
});

/* the browser suite's proposal: two steps, five actions, across four questions */
const proposal = (base = fixture()): Proposal => ({
  base,
  steps: [
    { request: "fix the label and the logic", actions: [
      { op: "update_option", target: "Q7", option: 4, label: "United States" },
      { op: "set_display_logic", target: "Q9", expression: "Q7 = 1" },
      { op: "add_skip", from: "Q7", when: "Q7 = 2", to: "Q9" },
    ] as SurveyAction[] },
    { request: "drop None and require the city", actions: [
      { op: "update_question", target: "Q5", removeOptions: [99] },
      { op: "update_question", target: "Q3", required: true },
    ] as SurveyAction[] },
  ],
});

test("every action of the chain has one flat index, step by step", () => {
  const m = actionMap(proposal());
  assert.deepEqual(m.map((x) => [x.flat, x.step, x.action, x.op]), [[0, 0, 0, "update_option"], [1, 0, 1, "set_display_logic"], [2, 0, 2, "add_skip"], [3, 1, 0, "update_question"], [4, 1, 1, "update_question"]]);
  assert.deepEqual(validExclusions(proposal(), [7, 3, 3, -1, 1.5, 0]), [0, 3], "an index the chain does not have is dropped, duplicates once, sorted");
});

test("evaluateProposal leaves the excluded actions out — and its results carry the flat index", () => {
  const p = proposal();
  const full = evaluateProposal(p);
  assert.deepEqual(full.errors, []);
  assert.deepEqual(full.results.map((r) => r.index), [0, 1, 2, 3, 4], "the second step's results are numbered after the first's");
  assert.deepEqual(full.excluded, []);
  assert.equal(full.after.questions.find((x) => x.id === "brands")!.options.length, 3);
  const part = evaluateProposal(p, { excluded: [3] });
  assert.deepEqual(part.excluded, [3]);
  assert.deepEqual(part.results.map((r) => r.index), [0, 1, 2, 4], "the excluded action has no result");
  assert.equal(part.after.questions.find((x) => x.id === "brands")!.options.length, 4, "None of these stays");
  assert.equal(part.after.questions.find((x) => x.id === "city")!.required, true, "the rest of its step still applies");
  assert.equal(part.after.questions.find((x) => x.id === "own")!.options[3].label, "United States");
  assert.ok(!part.destructive.some((d) => /Q5/.test(d)), `the removal's destructive note goes with it: ${part.destructive.join(" | ")}`);
  assert.ok(full.destructive.some((d) => /Q5/.test(d)), full.destructive.join(" | "));
  // everything excluded: nothing to apply
  const none = evaluateProposal(p, { excluded: [0, 1, 2, 3, 4] });
  assert.ok(none.diff.empty);
  assert.deepEqual(none.results, []);
});

test("an included action that needed an excluded one is refused, with the engine's reason, by its flat index", () => {
  const base = fixture();
  const p: Proposal = { base, steps: [{ request: "new question and a skip to it", actions: [
    { op: "create_question", ref: "NEWQ", type: "single", text: "Would you buy electric?", options: ["Yes", "No"], block: "Cars" },
    { op: "add_skip", from: "Q7", when: "Q7 = 2", to: "NEWQ" },
  ] as SurveyAction[] }] };
  const st = evaluateProposal(p, { excluded: [0] });
  const r = refusals(st);
  assert.deepEqual([...r.keys()], [1]);
  assert.ok(r.get(1)!.length > 0);
  const tree = reviewTree(p, evaluateProposal(p));
  const added = tree.items.find((i) => i.kind === "added" && i.category === "Question")!;
  assert.ok(added.actionIndexes.includes(0), "the created question is made by action 0");
  assert.equal(itemStatus(added, new Set([0]), r).status, "excluded");
  const skip = tree.items.find((i) => i.category === "Skip logic")!;
  assert.equal(skip.question!.code, "Q7");
  assert.deepEqual(itemStatus(skip, new Set([0]), r), { status: "refused", reason: r.get(1) }, "the skip to the new question would be refused once the question is left out");
});

test("the review's rows: one card per question, option rows, actions per row, siblings, statuses and the Apply count", () => {
  const p = proposal();
  const full = evaluateProposal(p);
  const tree = reviewTree(p, full);
  assert.deepEqual(tree.byQuestion.map((g) => g.question.code), ["Q3", "Q5", "Q7", "Q9"], "in survey order");
  const label = tree.items.find((i) => i.category === "Option label")!;
  assert.equal(label.question!.code, "Q7");
  assert.deepEqual(label.option, { code: 4, label: "United States", index: 4 });
  assert.equal(optionTitle(label.option!), "Option 4 — United States");
  assert.deepEqual([label.from, label.to], ["United Sates", "United States"]);
  assert.deepEqual(label.actionIndexes, [0], "the skip on Q7 touched Q7 too, but cannot relabel an option: unticking the skip leaves the label");
  const skip = tree.items.find((i) => i.category === "Skip logic")!;
  assert.deepEqual(skip.actionIndexes, [2]);
  const removed = tree.items.find((i) => i.category === "Options" && i.kind === "removed")!;
  assert.equal(removed.question!.code, "Q5");
  assert.deepEqual(removed.actionIndexes, [3]);
  assert.ok(removed.destructive, "the removal carries the engine's destructive note");
  const req = tree.items.find((i) => i.category === "Required")!;
  assert.deepEqual(req.actionIndexes, [4]);
  // statuses
  const none = new Map<number, string>();
  assert.equal(itemStatus(removed, new Set(), none).status, "proposed");
  assert.equal(itemStatus(removed, new Set([3]), none).status, "excluded");
  assert.equal(itemStatus({ id: "x", actionIndexes: [3, 4] }, new Set([3]), none).status, "partial");
  assert.equal(itemStatus({ id: "x", actionIndexes: [] }, new Set([0, 1, 2, 3, 4]), none).status, "proposed", "a row no action is known for cannot be excluded by itself…");
  assert.deepEqual(itemStatus({ id: "x", actionIndexes: [] }, new Set([3]), none, new Set(["y"])), { status: "excluded", reason: "It followed from a change you excluded." }, "…but when the included actions no longer make it, it says so");
  assert.equal(itemStatus({ id: "y", actionIndexes: [] }, new Set([3]), none, new Set(["y"])).status, "proposed");
  // unticking excludes the row's actions; ticking brings them back
  const ex = toggleItems([], [removed], false);
  assert.deepEqual(ex, [3]);
  assert.deepEqual(toggleItems(ex, [removed], true), []);
  assert.deepEqual(toggleItems([4], [removed, label], false), [0, 3, 4]);
  // the Apply count: rows, not actions
  assert.deepEqual(applyCount(tree, []), { included: tree.items.length, total: tree.items.length });
  assert.deepEqual(applyCount(tree, ex), { included: tree.items.length - tree.items.filter((i) => i.actionIndexes.length && i.actionIndexes.every((x) => x === 3)).length, total: tree.items.length });
  // the history's words for what was left out
  assert.equal(excludedLabels(p, full, ex).length, 1);
  assert.match(excludedLabels(p, full, ex)[0], /Q5/);
  const part = evaluateProposal(p, { excluded: ex });
  const rec = changeRecord(1, "x", part, p.base, "2026-10-05T10:00:00Z", excludedLabels(p, full, ex));
  assert.deepEqual(rec.excluded, excludedLabels(p, full, ex));
  assert.equal(changeRecord(2, "x", full, p.base, "2026-10-05T10:00:00Z").excluded, undefined, "nothing excluded: no field");
  assert.match(itemName(label), /^Q7 option 4 label$/);
});

test("a cascade the engine cannot attribute follows the change it came from", () => {
  const base = fixture();
  // Q9's display logic reads Q8; deleting Q8 prunes it — a row on Q9 that no action "touched"
  const withLogic = evaluateProposal({ base, steps: [{ request: "x", actions: [{ op: "set_display_logic", target: "Q9", expression: "Q8 answered" }] as SurveyAction[] }] }).after;
  const p: Proposal = { base: withLogic, steps: [{ request: "x", actions: [{ op: "delete_question", target: "Q8" }, { op: "update_question", target: "Q2", required: true }] as SurveyAction[] }] };
  const full = evaluateProposal(p);
  const tree = reviewTree(p, full);
  const pruned = tree.items.find((i) => i.question?.code === "Q9" && i.category === "Display logic")!;
  assert.ok(pruned, tree.items.map((i) => `${i.question?.code} ${i.category}`).join(", "));
  assert.equal(presentIds(p, full), null, "nothing excluded: nothing to compare");
  const kept = evaluateProposal(p, { excluded: [0] });
  const present = presentIds(p, kept)!;
  const st = itemStatus(pruned, new Set([0]), refusals(kept), present);
  assert.deepEqual(pruned.actionIndexes, [], "the engine's `touched` names the deleted question, not the one whose logic it pruned");
  assert.equal(st.status, "excluded", "Q9's logic is no longer pruned once the deletion is unticked");
  assert.equal(itemStatus(pruned, new Set([1]), refusals(evaluateProposal(p, { excluded: [1] })), presentIds(p, evaluateProposal(p, { excluded: [1] }))).status, "proposed", "unticking something else leaves it");
  assert.equal(applyCount(tree, [0], present).included, tree.items.filter((i) => i.question?.code === "Q2").length);
});

test("rows made by one action are siblings: unticking one says it takes the others", () => {
  const base = fixture();
  // one update_question that rewords AND requires Q8 — two rows, one action
  const p: Proposal = { base, steps: [{ request: "x", actions: [{ op: "update_question", target: "Q8", text: "Which make is your car?", required: true }, { op: "update_question", target: "Q2", required: true }] as SurveyAction[] }] };
  const tree = reviewTree(p, evaluateProposal(p));
  const wording = tree.items.find((i) => i.category === "Wording")!;
  const req8 = tree.items.find((i) => i.category === "Required" && i.question!.code === "Q8")!;
  assert.deepEqual(siblings(tree, wording), [req8]);
  assert.deepEqual(siblings(tree, tree.items.find((i) => i.question!.code === "Q2")!), [], "another action's row is not taken with it");
  assert.deepEqual(siblings(tree, { ...wording, actionIndexes: [] }), []);
  // a single-action proposal attributes every row to it
  const one: Proposal = { base, steps: [{ request: "x", actions: [{ op: "set_survey_settings", title: "Car owners" }] as SurveyAction[] }] };
  const t1 = reviewTree(one, evaluateProposal(one));
  assert.ok(t1.items.length > 0 && t1.items.every((i) => i.actionIndexes.length === 1 && i.actionIndexes[0] === 0));
});

test("what an action can change, read off the action", () => {
  assert.deepEqual([...actionCategories({ op: "update_question", target: "Q1", required: true })!], ["Required"]);
  assert.deepEqual([...actionCategories({ op: "update_question", target: "Q1", text: "x", removeOptions: [1] })!].slice(0, 2), ["Wording", "Options"]);
  assert.equal(actionCategories({ op: "update_question", target: "Q1", code: "Q100" }), null, "a recode rewrites conditions anywhere");
  assert.equal(actionCategories({ op: "update_option", target: "Q1", option: 1, code: 7 } as SurveyAction), null);
  assert.deepEqual([...actionCategories({ op: "update_option", target: "Q1", option: 1, label: "x" } as SurveyAction)!], ["Option label"]);
  assert.deepEqual([...actionCategories({ op: "add_skip", from: "Q1", when: "Q1 = 1", to: "Q3" })!], ["Skip logic"]);
  assert.equal(actionCategories({ op: "create_block", title: "x" }), null, "an op it does not know is never narrowed");
});

test("a card's header: code, the type in a researcher's words, the text", () => {
  assert.equal(typeName({ type: "single_select" }), "Single choice");
  assert.equal(typeName({ type: "numeric" }), "Number");
  assert.equal(typeName({ type: "conjoint_thing" }), "Conjoint thing");
  assert.equal(typeName(undefined, "x"), "x");
  const p = proposal();
  const full = evaluateProposal(p);
  const g = reviewTree(p, full).byQuestion.find((x) => x.question.code === "Q7")!;
  assert.deepEqual(questionHeader(g.question, [full.after, p.base]), { code: "Q7", type: "Single choice", text: "Do you own a car?" });
  assert.equal(impactKey({ kind: "option", id: "x", code: "Q7", label: "", questionId: "own" }), "question:own");
  assert.equal(impactKey({ kind: "block", id: "b1", code: "", label: "" }), "flowNode:b1");
  assert.equal(impactKey({ kind: "calculation", id: "c1", code: "", label: "" }), "calculation:c1");
});

test("an option's preview: code, export value, flags, condition, the question's order, and what reads it", () => {
  const base = fixture();
  const p: Proposal = { base, steps: [{ request: "x", actions: [
    { op: "set_display_logic", target: "Q9", expression: "Q7 = 1" },
    { op: "update_option", target: "Q7", option: 3, visibleIf: "Q2 > 25" },
    { op: "set_option_randomization", target: "Q5", enabled: true, keepLast: ["None of these"] },
  ] as SurveyAction[] }] };
  const after = evaluateProposal(p).after;
  const yes = optionFacts(after, "own", 1)!;
  assert.equal(yes.code, "1");
  assert.equal(yes.label, "Yes");
  assert.equal(yes.value, null);
  assert.deepEqual(yes.flags, []);
  assert.equal(yes.condition, null);
  assert.ok(yes.dependents.some((d) => /Q9/.test(d.phrase) && d.key === "question:year"), JSON.stringify(yes.dependents));
  const leasing = optionFacts(after, "own", 3)!;
  assert.match(leasing.condition!, /Q2 > 25/);
  assert.deepEqual(leasing.dependents, [], "nothing compares Q7 with 3");
  const none = optionFacts(after, "brands", 99)!;
  assert.ok(none.flags.includes("exclusive"));
  assert.ok(none.flags.includes("anchored last"));
  assert.match(none.randomization!, /shuffled|random/);
  assert.equal(optionFacts(after, "brands", 12345), null);
  assert.equal(optionFacts(after, "nope", 1), null);
});

test("context actions are grouped in a fixed order — and a number has no Options group", () => {
  const def = fixture();
  const num = groupContextActions(contextActions(def, { questionId: "age" }));
  assert.ok(!num.some((g) => g.group === "Options"), num.map((g) => g.group).join(","));
  assert.deepEqual(num.map((g) => g.group), CONTEXT_GROUP_ORDER.filter((g) => num.some((x) => x.group === g)), "the groups keep the Inspector's order");
  assert.ok(num.find((g) => g.group === "Validation")!.actions.some((a) => a.ready && a.sentence === "Make Q2 required"));
  const choice = groupContextActions(contextActions(def, { questionId: "own" }));
  assert.ok(choice.some((g) => g.group === "Options"));
  assert.ok(groupContextActions([]).length === 0);
});

test("the edges of the review's rules: a row neither action can make keeps both; a refusal of an excluded action is not this row's; a partial row counts; the last index; option facts", () => {
  /* a Wording row touched by two actions that cannot make wording keeps both — narrowing to nothing would orphan it */
  const base = fixture();
  const p: Proposal = { base, steps: [{ request: "r", actions: [{ op: "update_question", target: "Q8", required: true }, { op: "add_skip", from: "Q8", when: "Q8 answered", to: "Q9" }] as SurveyAction[] }] };
  const full = evaluateProposal(p);
  const after = structuredClone(full.after);
  after.questions.find((x) => x.id === "make")!.text = "Which make is your car?";
  const tree = reviewTree(p, { ...full, after });
  const wording = tree.items.find((i) => i.category === "Wording" && i.question?.id === "make");
  assert.ok(wording, JSON.stringify(tree.items.map((i) => [i.category, i.question?.code])));
  assert.deepEqual(wording!.actionIndexes, [0, 1]);
  /* a refusal of an action this row excluded is not reported on it: the row is partly excluded */
  assert.deepEqual(itemStatus({ id: "x", actionIndexes: [0, 1] }, new Set([0]), new Map([[0, "no"]])), { status: "partial" });
  /* nothing excluded: a cascade row is proposed whatever a stale present-set says */
  assert.deepEqual(itemStatus({ id: "x", actionIndexes: [] }, new Set(), new Map(), new Set(["y"])), { status: "proposed" });
  /* a partly excluded row still goes in, so it counts */
  assert.deepEqual(applyCount({ items: [{ actionIndexes: [0, 1] }, { actionIndexes: [2] }] as never }, [0, 2]), { included: 1, total: 2 });
  /* the index just past the end is not an action */
  assert.deepEqual(validExclusions(proposal(), [5, 4]), [4]);
  /* an export value equal to the code is no news; the preview lists what reads the option directly, not what reads that */
  const d = fixture();
  (d.questions.find((x) => x.id === "own")!.options[0] as { value?: unknown }).value = 1;
  d.questions.find((x) => x.id === "make")!.displayLogic = { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: 1 } as never;
  d.questions.find((x) => x.id === "year")!.displayLogic = { type: "rule", source: { kind: "question", ref: "make" }, operator: "answered" } as never;
  const f = optionFacts(d, "own", 1)!;
  assert.equal(f.value, null);
  assert.deepEqual(f.dependents.map((x) => x.key), ["question:make"], JSON.stringify(f.dependents));
});
