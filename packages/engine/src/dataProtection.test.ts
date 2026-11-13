import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { protectCollectedData, describeProtected, holdsData, DATA_PROTECTION_NOTICE, DATA_PROTECTION_DONE } from "./dataProtection.js";
import { explainQuestionVisibility } from "./visibility.js";

const YN = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }, { code: 3, label: "Not sure" }];
const base = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", options: YN },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which brands?", options: [{ code: 1, label: "Ford" }, { code: 2, label: "Kia" }] },
    { id: "t1", code: "T1", variableName: "T1", type: "html", text: "<p>Thanks so far</p>" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "matrix_single", text: "Rate", rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Service" }], options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }] },
    { id: "q4", code: "Q4", variableName: "Q4", type: "composite", variant: "matrix.constant_sum", text: "Split", rows: [{ code: "a", label: "A" }],
      columns: [{ id: "c1", label: "Online", responseType: "numeric", variableStem: "Q4_C1" }, { id: "c2", label: "Store", responseType: "numeric", variableStem: "Q4_C2" }] },
  ],
  flow: [
    { type: "page", id: "p1", title: "Start", questionIds: ["q1", "q2"] },
    { type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p2", questionIds: ["t1", "q3"] }, { type: "page", id: "p3", questionIds: ["q4"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const edit = (fn: (d: SurveyDefinition) => void) => { const before = base(); const after = structuredClone(before); fn(after); return { before, r: protectCollectedData(before, after) }; };
const dropQ = (d: SurveyDefinition, id: string) => {
  d.questions = d.questions.filter((q) => q.id !== id);
  const walk = (nodes: any[]) => nodes.forEach((n) => { if (n.questionIds) n.questionIds = n.questionIds.filter((x: string) => x !== id); if (n.children) walk(n.children); });
  walk(d.flow as any[]);
};

test("nothing removed: the definition is returned as it is, wording and order edits included", () => {
  const { r } = edit((d) => { d.questions[0].text = "Do you own a car?"; d.questions[0].options[0].label = "Yes, I do"; d.questions[1].options.reverse(); d.questions[1].options.push({ code: 9, label: "Other", flags: [] } as never); });
  assert.equal(r.changed, false); assert.deepEqual(r.restored, []);
  assert.equal(r.def.questions[0].text, "Do you own a car?");
  assert.deepEqual(r.def.questions[1].options.map((o) => o.code), [2, 1, 9]);
});

test("a deleted question comes back in its page, hidden, with everything it had", () => {
  const { before, r } = edit((d) => dropQ(d, "q2"));
  assert.equal(r.changed, true);
  assert.deepEqual(r.restored.map((x) => [x.kind, x.questionCode]), [["question", "Q2"]]);
  const q2 = r.def.questions.find((q) => q.id === "q2")!;
  assert.equal(q2.settings.hidden, true);
  assert.deepEqual(q2.options, before.questions[1].options, "its codes and labels are intact");
  assert.equal(q2.variableName, "Q2");
  assert.deepEqual((r.def.flow[0] as any).questionIds, ["q1", "q2"], "back after Q1, in the same page");
  assert.deepEqual(r.def.questions.map((q) => q.id), ["q1", "q2", "t1", "q3", "q4"]);
  SurveyDefinition.parse(r.def);
  assert.equal(explainQuestionVisibility(q2, { def: r.def, answers: {}, calculated: {}, embedded: {} } as never).visible, false, "a respondent is not asked it");
});

test("a display-only block is deleted as asked", () => {
  const { r } = edit((d) => dropQ(d, "t1"));
  assert.equal(r.changed, false);
  assert.equal(r.def.questions.some((q) => q.id === "t1"), false);
  assert.equal(holdsData({ type: "html" } as never), false);
});

test("a deleted page (inside a block) comes back holding only the questions that carry data", () => {
  const { r } = edit((d) => { d.questions = d.questions.filter((q) => !["t1", "q3"].includes(q.id)); (d.flow[1] as any).children = (d.flow[1] as any).children.filter((n: any) => n.id !== "p2"); });
  assert.deepEqual(r.restored.map((x) => x.questionCode), ["Q3"]);
  const pages: any[] = []; const walk = (ns: any[]) => ns.forEach((n) => { if (n.type === "page") pages.push(n); if (n.children) walk(n.children); }); walk(r.def.flow as any[]);
  const p2 = pages.find((p) => p.id === "p2");
  assert.deepEqual(p2.questionIds, ["q3"]);
  assert.equal(r.def.flow[r.def.flow.length - 1].type, "end", "the survey still ends with its end");
  assert.equal(r.def.questions.find((q) => q.id === "q3")!.settings.hidden, true);
  SurveyDefinition.parse(r.def);
});

test("a deleted option, row and column come back in place with “always hide”", () => {
  const { r } = edit((d) => {
    d.questions[0].options.splice(1, 1);
    d.questions[3].rows.splice(0, 1);
    d.questions[4].columns.splice(1, 1);
  });
  assert.deepEqual(r.restored.map((x) => [x.kind, x.questionCode, x.code]), [["option", "Q1", "2"], ["row", "Q3", "r1"], ["column", "Q4", "c2"]]);
  const q1 = r.def.questions[0];
  assert.deepEqual(q1.options.map((o) => [o.code, o.logic?.visibility ?? "shown"]), [[1, "shown"], [2, "always_hide"], [3, "shown"]]);
  assert.equal(q1.options[1].label, "No");
  assert.equal(r.def.questions[3].rows[0].logic?.visibility, "always_hide");
  assert.equal(r.def.questions[4].columns[1].logic?.visibility, "always_hide");
  SurveyDefinition.parse(r.def);
});

test("a code typed over is put back; the same place with new wording is a new option and the old one is kept hidden", () => {
  const recode = edit((d) => { d.questions[0].options[1].code = 7; });
  assert.deepEqual(recode.r.restored.map((x) => [x.kind, x.code]), [["code", "2"]]);
  assert.deepEqual(recode.r.def.questions[0].options.map((o) => o.code), [1, 2, 3]);
  const swap = edit((d) => { d.questions[0].options[2] = { code: 8, label: "Maybe", flags: [] } as never; });
  assert.deepEqual(swap.r.restored.map((x) => [x.kind, x.code]), [["option", "3"]]);
  assert.deepEqual(swap.r.def.questions[0].options.map((o) => [o.code, o.label, o.logic?.visibility ?? "shown"]), [[1, "Yes", "shown"], [2, "No", "shown"], [3, "Not sure", "always_hide"], [8, "Maybe", "shown"]]);
});

test("replacing the whole survey (import, JSON, an AI rewrite) keeps every data-bearing question", () => {
  const before = base();
  const after = SurveyDefinition.parse({ ...before, questions: [{ id: "n1", code: "N1", variableName: "N1", type: "open_text", text: "New" }], flow: [{ type: "page", id: "np", questionIds: ["n1"] }, { type: "end", id: "e", status: "complete" }] });
  const r = protectCollectedData(before, after);
  assert.deepEqual(r.restored.map((x) => x.questionCode).sort(), ["Q1", "Q2", "Q3", "Q4"]);
  assert.ok(r.def.questions.filter((q) => q.id !== "n1").every((q) => q.settings.hidden));
  assert.equal(r.def.flow[r.def.flow.length - 1].type, "end");
  const ids = new Set<string>(); const walk = (ns: any[]) => ns.forEach((n) => { (n.questionIds ?? []).forEach((x: string) => ids.add(x)); if (n.children) walk(n.children); }); walk(r.def.flow as any[]);
  assert.deepEqual([...ids].sort(), ["n1", "q1", "q2", "q3", "q4"], "every kept question is in the flow");
  SurveyDefinition.parse(r.def);
});

test("running it twice changes nothing more; the messages are the ones the editor shows", () => {
  const { before, r } = edit((d) => { dropQ(d, "q1"); d.questions.find((q) => q.id === "q2")!.options.pop(); });
  const again = protectCollectedData(before, r.def);
  assert.equal(again.changed, false);
  assert.match(describeProtected(r.restored), /option “Kia” \(2\) of Q2 and question Q1|question Q1/);
  assert.match(DATA_PROTECTION_NOTICE, /cannot be permanently deleted/);
  assert.match(DATA_PROTECTION_DONE, /hidden successfully\. Existing response data has been preserved\./);
});
