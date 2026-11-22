import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applyLibraryUpdate, insertFromLibrary, libraryItems, libraryStatus } from "./library.js";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";

const sat = [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `Point ${c}` }));
const library = (v: 1 | 2 = 1) => SurveyDefinition.parse({
  meta: { id: "lib", code: "LIB", title: "Agency standards", version: String(v) },
  questions: [
    { id: "age", code: "D1", variableName: "AGE", type: "single_select", text: "How old are you?", options: [{ code: 1, label: "18-34" }, { code: 2, label: "35-54" }, { code: 3, label: "55+" }] },
    { id: "gender", code: "D2", variableName: "GENDER", type: "single_select", text: v === 1 ? "What is your gender?" : "How do you describe your gender?", options: [{ code: 1, label: "Man" }, { code: 2, label: "Woman" }, ...(v === 1 ? [{ code: 3, label: "Other" }] : [{ code: 4, label: "In another way" }, { code: 9, label: "Prefer not to say" }])] },
    { id: "kids", code: "D3", variableName: "KIDS", type: "single_select", text: "Do you have children under 18?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }], displayLogic: { type: "rule", source: { kind: "question", ref: "age" }, operator: "in", value: [1, 2] } },
    ...(v === 2 ? [{ id: "region", code: "D4", variableName: "REGION", type: "single_select", text: "Where do you live?", options: [{ code: 1, label: "North" }, { code: 2, label: "South" }] }] : []),
    { id: "sat", code: "S1", variableName: "SATSCALE", type: "single_select", text: "Satisfaction", options: sat },
  ],
  flow: [{ type: "block", id: "b_demo", title: "Standard demographics", children: [{ type: "page", id: "pd1", questionIds: ["age", "gender"] }, { type: "page", id: "pd2", questionIds: v === 1 ? ["kids"] : ["kids", "region"] }] }, { type: "page", id: "ps", questionIds: ["sat"] }, { type: "end", id: "e", status: "complete" }],
});
const study = () => SurveyDefinition.parse({
  meta: { id: "st", code: "ST", title: "Car study", version: "1" },
  questions: [
    { id: "own", code: "D1", variableName: "OWN", type: "single_select", text: "Do you own a car?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "rate", code: "Q1", variableName: "Q1", type: "single_select", text: "Rate your car", options: [{ code: 1, label: "Bad" }, { code: 2, label: "Good" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["own", "rate"] }, { type: "end", id: "e", status: "complete" }],
});
const ok = <T,>(r: T | { error: string }): T => { assert.ok(!("error" in (r as object)), (r as { error: string }).error); return r as T; };
const libs = (v: 1 | 2) => ({ lib1: { def: library(v), version: v } });

test("a library survey's items: its blocks, its questions and its option lists", () => {
  const items = libraryItems(library());
  assert.ok(items.some((i) => i.id === "b_demo" && i.kind === "block" && i.questionIds.length === 3));
  assert.ok(items.some((i) => i.id === "q:sat" && i.kind === "question"));
  assert.ok(items.some((i) => i.id === "list:sat" && i.kind === "list" && /5 options/.test(i.summary)));
});

test("inserting a block: codes that collide are renumbered, the block's own logic follows its questions, a link is kept", () => {
  const r = ok(insertFromLibrary(study(), library(), "b_demo", { library: { surveyId: "lib1", title: "Agency standards" }, version: 1, after: "p1" }));
  const codes = r.def.questions.map((q) => q.code);
  assert.deepEqual(codes, ["D1", "Q1", "D1_2", "D2", "D3"]);
  assert.ok(r.notes.some((n) => /library's D1 came in as D1_2/.test(n)));
  const kids = r.def.questions.find((q) => q.code === "D3") as unknown as { displayLogic: { source: { ref: string } } };
  assert.equal(kids.displayLogic.source.ref, r.link.keys.age, "D3's logic reads the inserted age question, not the library's");
  assert.equal(r.def.flow[1]!.type, "block");
  assert.equal(r.def.flow.at(-1)!.type, "end");
  assert.equal(r.def.libraryLinks!.length, 1);
  assert.deepEqual(libraryStatus(r.def, libs(1)).map((s) => s.state), ["up_to_date"]);
});

test("an update in the library is seen, with what it changes here and the logic it would break", () => {
  let def = ok(insertFromLibrary(study(), library(), "b_demo", { library: { surveyId: "lib1" }, version: 1 })).def;
  /* a quota elsewhere in the study reads gender = Other (code 3), which version 2 removes */
  const genderId = def.libraryLinks![0]!.keys.gender!;
  def = SurveyDefinition.parse({ ...def, quotas: [{ id: "qg", name: "Gender", cells: [{ id: "o", label: "Other", when: { type: "rule", source: { kind: "question", ref: genderId }, operator: "eq", value: 3 }, limit: 10 }] }] });
  const [s] = libraryStatus(def, libs(2));
  assert.equal(s!.state, "update_available");
  assert.deepEqual(s!.impact!.added, ["D4"]);
  assert.ok(s!.impact!.changed.some((c) => c.code === "D2" && c.what.includes("wording") && c.what.some((w) => /options removed: 3/.test(w))));
  assert.ok(s!.impact!.broken.some((b) => /quota Gender, cell Other reads option 3 of D2/.test(b)), JSON.stringify(s!.impact!.broken));
  assert.deepEqual(s!.impact!.overwrites, []);
  /* updating takes the new version, keeps the local ids and codes, adds the new question to the block */
  const u = ok(applyLibraryUpdate(def, s!.link.id, library(2), 2));
  assert.ok(u.def.questions.some((q) => q.code === "D4"));
  assert.equal(u.def.questions.find((q) => q.id === genderId)!.text, "How do you describe your gender?");
  assert.deepEqual(libraryStatus(u.def, libs(2)).map((x) => x.state), ["up_to_date"]);
});

test("a local edit is told apart from a library update, and an update says it would overwrite it", () => {
  const def = ok(insertFromLibrary(study(), library(), "b_demo", { library: { surveyId: "lib1" }, version: 1 })).def;
  const edited = applySurveyActions(def, [{ op: "update_question", target: "D3", text: "Any children at home?" }] as unknown as SurveyAction[]).def;
  assert.deepEqual(libraryStatus(edited, libs(1)).map((s) => s.state), ["changed_here"]);
  const both = libraryStatus(edited, libs(2))[0]!;
  assert.equal(both.state, "both");
  assert.deepEqual(both.impact!.overwrites, ["D3"]);
  assert.match(both.message, /overwrite those edits/);
});

test("a list goes into an existing question; a removed item and a missing library are reported, not guessed", () => {
  const r = ok(insertFromLibrary(study(), library(), "list:sat", { library: { surveyId: "lib1" }, version: 1, into: "Q1" }));
  assert.equal(r.def.questions.find((q) => q.code === "Q1")!.options.length, 5);
  assert.deepEqual(libraryStatus(r.def, libs(1)).map((s) => s.state), ["up_to_date"]);
  assert.deepEqual(libraryStatus(r.def, {}).map((s) => s.state), ["library_missing"]);
  const gone = SurveyDefinition.parse({ ...library(), questions: library().questions.filter((q) => q.id !== "sat"), flow: library().flow.filter((n) => n.id !== "ps") });
  assert.deepEqual(libraryStatus(r.def, { lib1: { def: gone, version: 3 } }).map((s) => s.state), ["item_removed"]);
  assert.match((insertFromLibrary(study(), library(), "nope", { library: {}, version: 1 }) as { error: string }).error, /no item nope/);
});
