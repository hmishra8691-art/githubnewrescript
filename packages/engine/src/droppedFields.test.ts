import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, Question } from "@rescript/schema";
import { droppedFieldPaths, hasDroppedFields } from "./droppedFields.js";

/*
 * These are the save route's data-loss detector. The bug they exist to stop:
 * the detector was `JSON.stringify(parsed) !== JSON.stringify(sent)`, which
 * reported data loss for a default the schema ADDED and for a key the editor
 * happened to place in a different position — telling programmers their work
 * was not stored while it was being stored perfectly.
 */

function definition(qPatch: Record<string, unknown> = {}) {
  const q = Question.parse({
    id: "Q1",
    code: "Q1",
    variableName: "Q1",
    type: "single",
    text: "Pick",
    options: [
      { id: "o1", code: "1", label: "Alpha" },
      { id: "o2", code: "2", label: "Beta" },
    ],
  });
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "R", version: "1.0", status: "draft" },
    questions: [{ ...q, ...qPatch }],
    flow: [
      { type: "page", id: "p1", title: "P1", questionIds: ["Q1"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
}

/** What the route does: parse, then ask whether anything was lost. */
function saveWouldReportLoss(sent: unknown): string[] {
  const parsed = SurveyDefinition.safeParse(sent);
  assert.ok(parsed.success, "fixture must be valid");
  return droppedFieldPaths(sent, parsed.data);
}

test("a lossless re-save reports nothing", () => {
  assert.deepEqual(saveWouldReportLoss(definition()), []);
});

test("an editor one build BEHIND the server is not data loss", () => {
  // The server's schema gained `punches: []` as a default. The editor's copy
  // has never had that key, so the parsed copy has a key the input lacked.
  // The server knows MORE than the editor here — nothing was dropped.
  const sent = JSON.parse(JSON.stringify(definition())) as {
    questions: Record<string, unknown>[];
  };
  for (const q of sent.questions) delete q.punches;
  assert.deepEqual(saveWouldReportLoss(sent), []);
});

test("a key the editor placed in a different position is not data loss", () => {
  // The store patches by spreading, which appends a new key at the end of the
  // object rather than in schema-declaration order. This is what made the
  // first mask a programmer built report itself as unsaved on every save.
  const withMask = definition({
    mask: { expr: { kind: "ref", questionId: "Q2", selection: "selected" } },
  });
  const reordered = JSON.parse(JSON.stringify(withMask)) as {
    questions: Record<string, unknown>[];
  };
  const q = reordered.questions[0];
  const keys = Object.keys(q);
  reordered.questions[0] = Object.fromEntries(
    [keys[keys.length - 1], ...keys.slice(0, -1)].map((k) => [k, q[k]]),
  );
  assert.deepEqual(saveWouldReportLoss(reordered), []);
  // and the mask really is stored
  const parsed = SurveyDefinition.parse(reordered);
  assert.ok(parsed.questions[0].mask, "mask survived the save");
});

test("a mask survives a save without being reported as dropped", () => {
  const sent = definition({
    mask: {
      expr: {
        kind: "op",
        operator: "union",
        left: { kind: "ref", questionId: "Q2", selection: "selected" },
        right: { kind: "ref", questionId: "Q3", selection: "selected" },
      },
    },
  });
  assert.deepEqual(saveWouldReportLoss(sent), []);
});

test("a genuinely unknown key IS reported, by path", () => {
  const sent = JSON.parse(JSON.stringify(definition())) as {
    questions: Record<string, unknown>[];
  };
  sent.questions[0].somethingTheServerHasNeverHeardOf = { a: 1 };
  const lost = saveWouldReportLoss(sent);
  assert.deepEqual(lost, ["questions[0].somethingTheServerHasNeverHeardOf"]);
});

test("several unknown keys are reported together, capped", () => {
  const sent = JSON.parse(JSON.stringify(definition())) as {
    questions: Record<string, unknown>[];
  };
  for (let i = 0; i < 20; i++) sent.questions[0][`unknown${i}`] = i;
  const lost = saveWouldReportLoss(sent);
  assert.equal(lost.length, 8, "capped at 8 — this feeds a one-line warning");
  assert.ok(lost.every((p) => p.startsWith("questions[0].unknown")));
});

// ---- the walk itself, without the schema in the way ----

test("added keys are never loss, in any position", () => {
  assert.deepEqual(droppedFieldPaths({ a: 1 }, { a: 1, b: 2 }), []);
  assert.deepEqual(droppedFieldPaths({ a: 1 }, { b: 2, a: 1 }), []);
});

test("a missing key is loss and is named", () => {
  assert.deepEqual(droppedFieldPaths({ a: 1, b: 2 }, { a: 1 }), ["b"]);
  assert.deepEqual(droppedFieldPaths({ a: { b: { c: 1 } } }, { a: { b: {} } }), ["a.b.c"]);
});

test("a changed primitive is loss (the schema has no coercions)", () => {
  assert.deepEqual(droppedFieldPaths({ a: "1" }, { a: 1 }), ["a"]);
  assert.deepEqual(droppedFieldPaths({ a: true }, { a: false }), ["a"]);
});

test("a truncated array is loss, per index", () => {
  assert.deepEqual(droppedFieldPaths({ a: [1, 2, 3] }, { a: [1, 2] }), ["a[2]"]);
});

test("a changed shape is loss", () => {
  assert.deepEqual(droppedFieldPaths({ a: [1] }, { a: { 0: 1 } }), ["a"]);
  assert.deepEqual(droppedFieldPaths({ a: { b: 1 } }, { a: "x" }), ["a"]);
});

test("undefined never counts as loss — JSON does not carry it", () => {
  assert.deepEqual(droppedFieldPaths({ a: 1, b: undefined }, { a: 1 }), []);
});

test("null is a real value and is compared", () => {
  assert.deepEqual(droppedFieldPaths({ a: null }, { a: null }), []);
  assert.deepEqual(droppedFieldPaths({ a: null }, {}), ["a"]);
});

test("deep nesting terminates", () => {
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 500; i++) deep = { down: deep };
  assert.doesNotThrow(() => droppedFieldPaths(deep, deep));
});

test("hasDroppedFields agrees with the paths", () => {
  assert.equal(hasDroppedFields({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(hasDroppedFields({ a: 1 }, {}), true);
});
