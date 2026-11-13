import test from "node:test";
import assert from "node:assert/strict";
import { listFillPlainSummary, listFillChecks, LIST_FILL_METHOD_WORDS, LIST_FILL_COMMON_METHODS } from "./index.js";

const q = (id: string) => ({ id, code: id, type: "multi_select", text: id, options: [{ code: "1", label: "A" }, { code: "2", label: "B" }, { code: "3", label: "C" }], rows: [], columns: [] });
const def = { meta: { id: "s", code: "S", title: "t", version: "1.0" }, questions: [q("Q1"), q("Q5")], flow: [], listFills: [] } as any;
const lf = (x: any = {}) => ({
  id: "lf1", name: "BR", enabled: true,
  source: { kind: "question", questionId: "Q1", take: "selected" },
  selection: { count: { kind: "fixed", n: 1 }, method: "highest_priority", equalPriority: "random", afterTarget: "reduce_priority", afterMaximum: "next_priority", fallback: "random_eligible", weighted: false, allowDuplicates: false, fillToCount: true, ...(x.selection ?? {}) },
  tracking: { sampleLevel: true, respectQuotas: false, quotaIds: [], separateTestCounts: true, countOnCompleteOnly: false, ...(x.tracking ?? {}) },
  options: [], destinations: [], storeTrace: false,
  ...Object.fromEntries(Object.entries(x).filter(([k]) => k !== "selection" && k !== "tracking")),
}) as any;
const levels = (l: any) => listFillChecks(def, l).map((c) => c.level);

test("the summary says how many items, from where, how they are picked and where they go", () => {
  assert.deepEqual(listFillPlainSummary(def, lf({ options: [{ code: "1", priority: 1, maximum: 100 }, { code: "2", priority: 2, maximum: 100 }], destinations: [{ questionId: "Q5", write: "answer" }] })), [
    "Gives each respondent 1 item from the answers the respondent chose at Q1, lowest priority number first.",
    "Every item stops once it reaches its maximum.",
    "Writes the result into Q5.",
  ]);
  const s = listFillPlainSummary(def, lf({ enabled: false, selection: { count: { kind: "fixed", n: 2, allUpTo: 3 }, method: "least_filled" }, options: [{ code: "1", target: 50 }, { code: "3", eligible: false }], tracking: { countOnCompleteOnly: true } }));
  assert.match(s[0]!, /Switched off/);
  assert.match(s[1]!, /2 items \(all of them when 3 or fewer qualify\).*given to the fewest respondents so far/);
  assert.match(s[2]!, /1 item with a target steps back behind the others once it reaches it \(counting completed interviews only\)/);
  assert.match(s[3]!, /1 item is switched off/);
  assert.match(s[4]!, /not written into a question/);
  assert.deepEqual(listFillPlainSummary(def, lf({ source: { kind: "static", items: [] } })), ["Choose what it picks from: a question whose answers feed it."]);
});

test("every stored method has words, and the common ones are real methods", () => {
  for (const m of ["highest_priority", "lowest_priority", "priority_quota", "priority_random", "first_selected", "selection_order", "random", "weighted_random", "least_filled", "balanced_random", "quota_aware_random", "custom"]) assert.ok(LIST_FILL_METHOD_WORDS[m], m);
  for (const m of LIST_FILL_COMMON_METHODS) assert.ok(LIST_FILL_METHOD_WORDS[m], m);
});

test("checks catch what is unfinished, in plain words, and never change the list", () => {
  const empty = lf({ source: { kind: "static", items: [] } });
  const before = JSON.stringify(empty);
  assert.deepEqual(levels(empty), ["problem"]);
  assert.equal(JSON.stringify(empty), before);
  assert.deepEqual(levels(lf()), ["tip"], "no per-item settings yet is a tip, not a problem");
  assert.deepEqual(levels(lf({ options: [{ code: "1" }, { code: "2" }] })), ["tip"], "priority method with no priorities");
  assert.deepEqual(levels(lf({ options: [{ code: "1", priority: 1 }, { code: "2", priority: 2 }] })), []);
  assert.deepEqual(levels(lf({ selection: { method: "weighted_random" }, options: [{ code: "1" }] })), ["warning"]);
  assert.deepEqual(levels(lf({ selection: { method: "balanced_random" }, options: [{ code: "1" }] })), ["warning"]);
  assert.deepEqual(levels(lf({ selection: { method: "custom" }, options: [{ code: "1" }] })), ["problem"]);
  assert.deepEqual(levels(lf({ selection: { method: "random", count: { kind: "fixed", n: 0 } }, options: [{ code: "1" }] })), ["problem"]);
  assert.deepEqual(levels(lf({ selection: { method: "random", count: { kind: "fixed", n: 4 } }, source: { kind: "static", items: [{ code: "1", label: "a" }] } })), ["warning"]);
  assert.deepEqual(levels(lf({ selection: { method: "random" }, options: [{ code: "1" }], destinations: [{ questionId: "", write: "answer" }] })), ["problem"]);
});
