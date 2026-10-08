import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, Question, resolveVariant, normalizeLegacyRowRandomization } from "@rescript/schema";
import { createQuestionFromVariant, createResponseState, effectiveQuestion, migrateQuestionType, staleFields } from "./index.js";

/**
 * 07-10-2026 review, Suraj #2 — "Matrix with Randomized Rows": the rows were
 * never randomized. The preset seeded `settings.randomizeRows`, which nothing
 * read. It now switches on the question's row randomization, and a question
 * saved with the dead setting is migrated on parse.
 */
const ROWS = Array.from({ length: 8 }, (_, i) => ({ code: `r${i + 1}`, label: `Row ${i + 1}` }));

function orderFor(q: Question, seed: number) {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" }, questions: [q],
    flow: [{ type: "page", id: "p", questionIds: [q.id] }, { type: "end", id: "e", status: "complete" }],
  });
  const state = createResponseState(def, { seed });
  return effectiveQuestion(def.questions[0]!, { def, state, loop: null }).rows.map((r) => r.code).join(",");
}

test("the preset creates a question whose rows really shuffle, per respondent and stably for one", () => {
  const v = resolveVariant("matrix.random_rows")!;
  const q = createQuestionFromVariant(v, 1);
  assert.equal(q.randomization?.enabled, true);
  assert.equal(q.randomization?.scope, "rows");
  assert.equal((q.settings as Record<string, unknown>).randomizeRows, undefined, "the dead setting is gone");
  q.rows = ROWS.map((r) => ({ ...r, flags: [], validation: [], required: false })) as never;
  q.options = [1, 2, 3].map((n) => ({ code: n, label: String(n), flags: [] })) as never;
  const parsed = Question.parse(q);
  const orders = new Set([11, 22, 33, 44, 55, 66].map((s) => orderFor(parsed, s)));
  assert.ok(orders.size > 1, `different respondents see different orders (${[...orders].join(" | ")})`);
  assert.equal(orderFor(parsed, 22), orderFor(parsed, 22), "one respondent always sees the same order (resume, back)");
  assert.notEqual([...orders].every((o) => o === ROWS.map((r) => r.code).join(",")), true);
});

test("an anchored row stays where it is", () => {
  const q = Question.parse({
    id: "q", code: "Q1", variableName: "Q1", type: "matrix_single", text: "x",
    rows: [...ROWS, { code: "r99", label: "Other", flags: ["anchor_bottom"] }],
    options: [{ code: 1, label: "1" }],
    randomization: { enabled: true, scope: "rows" },
  });
  for (const s of [1, 2, 3, 4]) assert.match(orderFor(q, s), /,r99$/);
});

test("a question saved with the dead setting is migrated on parse", () => {
  const legacy = { id: "q", code: "Q1", variableName: "Q1", type: "matrix_single", variant: "matrix.random_rows", text: "x",
    rows: ROWS, options: [{ code: 1, label: "1" }], settings: { randomizeRows: true } };
  const q = Question.parse(legacy);
  assert.equal(q.randomization?.enabled, true);
  assert.equal(q.randomization?.scope, "rows");
  assert.equal((q.settings as Record<string, unknown>).randomizeRows, undefined);
  assert.ok(new Set([1, 2, 3, 4, 5].map((s) => orderFor(q, s))).size > 1);

  // already shuffling its columns: rows become a second axis, columns kept
  const both = normalizeLegacyRowRandomization({ ...legacy, randomization: { enabled: true, scope: "options", method: "rotate" } }) as Record<string, any>;
  assert.deepEqual(both.randomization.scopes, ["options", "rows"]);
  assert.equal(both.randomization.method, "rotate");
  // already shuffling rows: unchanged
  const rows = { ...legacy, randomization: { enabled: true, scope: "rows", method: "reverse_half" } };
  assert.deepEqual((normalizeLegacyRowRandomization(rows) as Record<string, any>).randomization, rows.randomization);
  // false (never written) is just dropped; idempotent
  const off = normalizeLegacyRowRandomization({ ...legacy, settings: { randomizeRows: false } }) as Record<string, any>;
  assert.equal(off.randomization, undefined);
  assert.deepEqual(normalizeLegacyRowRandomization(normalizeLegacyRowRandomization(legacy)), normalizeLegacyRowRandomization(legacy));
  // a switched-off randomization with method "none" is switched on with a method that shuffles
  const none = normalizeLegacyRowRandomization({ ...legacy, randomization: { enabled: false, scope: "options", method: "none", scopes: ["options"] } }) as Record<string, any>;
  assert.deepEqual(none.randomization, { enabled: true, scope: "rows", method: "shuffle" });
});

test("switching to a plain matrix removes the randomization the preset seeded, keeps one the programmer extended", () => {
  const v = resolveVariant("matrix.random_rows")!;
  const plain = resolveVariant("matrix.single")!;
  const q = Question.parse({ ...createQuestionFromVariant(v, 1), rows: ROWS, options: [{ code: 1, label: "1" }] });
  const m = migrateQuestionType(q, plain);
  assert.equal(m.q.randomization, undefined);
  assert.ok(m.changes.some((c) => c.field === "randomization"));
  const picked = Question.parse({ ...q, randomization: { ...q.randomization, pick: 3 } });
  assert.equal(migrateQuestionType(picked, plain).q.randomization?.pick, 3, "a pick is the programmer's");
  assert.deepEqual(staleFields(q).filter((c) => c.field === "randomization"), [], "on its own type it is not stale");
});
