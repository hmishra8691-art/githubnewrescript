import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { pipeSourceCatalog, testEmbeddedValue } from "@rescript/engine";
import { compactWidthCh, previewText, insertAt, gridMove } from "./flowEd.ts";

test("compact value field: small for short values, grows with content, capped", () => {
  assert.equal(compactWidthCh("Male"), 12, "never narrower than the minimum");
  assert.equal(compactWidthCh("25"), 12);
  assert.equal(compactWidthCh("Customer: {{ed.CustomerName}}"), 32, "grows with the text");
  const zips = Array.from({ length: 400 }, (_, i) => String(2000 + i)).join(", ");
  assert.equal(compactWidthCh(zips), 200, "a long list asks for the cap — the CSS holds it to the container and it wraps");
  assert.equal(compactWidthCh("short\nmuch longer second line"), 26, "the longest line decides");
});

test("stored-as preview: long values are shortened with an expand control, on a whole item", () => {
  assert.deepEqual(previewText("India"), { shown: "India", truncated: false, length: 5 });
  const zips = Array.from({ length: 300 }, (_, i) => String(10000 + i)).join(", ");
  const p = previewText(zips, 140);
  assert.equal(p.truncated, true);
  assert.equal(p.length, zips.length);
  assert.ok(p.shown.length <= 142);
  assert.match(p.shown, /\d, … ?$|\d …$/, p.shown);
});

test("insertAt puts the token at the cursor, over a selection, caret after it", () => {
  assert.deepEqual(insertAt("Customer: ", 10, 10, "{{ed.Name}}"), { value: "Customer: {{ed.Name}}", caret: 21 });
  assert.deepEqual(insertAt("a XX b", 2, 4, "{{Q1}}"), { value: "a {{Q1}} b", caret: 8 });
  assert.deepEqual(insertAt("abc", null, null, "!"), { value: "abc!", caret: 4 }, "no cursor: at the end");
});

test("Add Element grid: arrow keys, Home / End, 3 per row", () => {
  assert.equal(gridMove(0, "ArrowRight", 3, 9), 1);
  assert.equal(gridMove(2, "ArrowRight", 3, 9), 3, "wraps to the next row");
  assert.equal(gridMove(1, "ArrowDown", 3, 9), 4);
  assert.equal(gridMove(7, "ArrowDown", 3, 9), 7, "no row below: stays");
  assert.equal(gridMove(4, "ArrowUp", 3, 9), 1);
  assert.equal(gridMove(0, "ArrowLeft", 3, 9), 0);
  assert.equal(gridMove(5, "End", 3, 9), 8);
  assert.equal(gridMove(5, "Home", 3, 9), 0);
  assert.equal(gridMove(5, "a", 3, 9), null);
});

test("the menu the Studio renders offers numeric sources only to a number field (engine catalog)", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{ id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age" }, { id: "q2", code: "Q2", variableName: "NAME", type: "open_text", text: "Name" }],
    flow: [{ type: "embedded_data", id: "ed", fields: [{ name: "LOWCAL_1", source: "static", value: "10", dataType: "auto" }] }, { type: "page", id: "p", questionIds: ["q1", "q2"] }],
  });
  const q = pipeSourceCatalog(def, { accept: "number" }).find((c) => c.id === "question")!;
  assert.deepEqual(q.items.map((i) => i.id), ["q1"]);
  const r = testEmbeddedValue(def, { name: "T", source: "static", value: "{{ed.LOWCAL_1}} kcal", dataType: "auto" }, {});
  assert.equal(r.stored, "10 kcal");
});
