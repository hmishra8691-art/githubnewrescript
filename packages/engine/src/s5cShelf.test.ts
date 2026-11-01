import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { lintShelf, noteExamined, shelfParadataKeys, shelfSeconds } from "./shelf.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { buildVariableDictionary } from "./variables.js";
import { validateQuestion } from "./validate.js";
import { variantRegistry } from "@rescript/schema";

/* S5c item 5 (SM-16): the shelf test — variant, paradata, lint, template */

test("shelf paradata: keys, the examined list (each product once, in order), seconds", () => {
  assert.deepEqual(shelfParadataKeys("Q7"), { time: "SHELF_Q7_TIME", examined: "SHELF_Q7_EXAMINED", pick2: "SHELF_Q7_PICK2" });
  assert.deepEqual(noteExamined(noteExamined(noteExamined([], "p2"), "p1"), "p2"), ["p2", "p1"]);
  assert.equal(shelfSeconds(4321), 4.3);
  assert.equal(shelfSeconds(-5), 0);
});

test("hotspot.shelf is a registered image_select variant; lint names what is missing", () => {
  const v = variantRegistry.get("hotspot.shelf")!;
  assert.equal(v.baseType, "image_select");
  assert.equal(v.renderer, "shelf");
  const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [{ id: "q", code: "Q", variableName: "Q", type: "image_select", variant: "hotspot.shelf", text: "x", options: [{ code: "p1", label: "A", meta: { region: { x: 0, y: 0, w: 10, h: 10 } } }], settings: { maxSelections: 2 } }], flow: [] });
  const lint = lintShelf(def.questions[0]).join(" | ");
  assert.match(lint, /needs the shelf image/);
  assert.match(lint, /at least two product regions on the shelf \(1 drawn\)/);
  assert.match(lint, /maxSelections to 1/);
});

test("add_method_template shelf_test: needs the image; regions per product; the paradata variables and plan item; the pick validates", () => {
  const base = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  assert.match(JSON.stringify(coerceSurveyActions([{ op: "add_method_template", template: "shelf_test", products: ["A", "B"] }]).rejected), /needs imageUrl/);
  const c = coerceSurveyActions([{ op: "add_method_template", template: "shelf_test", imageUrl: "https://example.com/shelf.jpg", products: ["Alpha", "Beta", "Gamma", "Delta"], secondPick: true, product: "breakfast cereal" }]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(base, c.actions);
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const q = r.def.questions[0];
  assert.equal(q.variant, "hotspot.shelf");
  assert.deepEqual(q.options.map((o) => o.label), ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.deepEqual(lintShelf(q), []);
  const names = buildVariableDictionary(r.def).map((v) => v.name);
  for (const n of ["SHELF_SHELF_TIME", "SHELF_SHELF_EXAMINED", "SHELF_SHELF_PICK2"]) assert.ok(names.includes(n), n);
  assert.equal(r.def.research!.analysisPlan!.tests[0].method, "shelf_share");
  const ctx = { def: r.def, state: { answers: {}, embedded: {} } } as never;
  assert.deepEqual(validateQuestion(r.def, q, ["p2"], ctx), []);
});
