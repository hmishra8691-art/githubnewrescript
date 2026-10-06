import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { bucketCapacity, dropInto, bucketProblems } from "./bucketRules.js";
import { validateQuestion } from "./validate.js";

const make = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{
      id: "b", code: "Q1", variableName: "Q1", type: "matrix_single", variant: "dragdrop.buckets", text: "Sort",
      options: [{ code: "fruit", label: "Fruits" }, { code: "veg", label: "Vegetables", meta: { capacity: 2 } }],
      rows: [{ code: "1", label: "Apple" }, { code: "2", label: "Banana" }, { code: "3", label: "Carrot" }],
      settings, ...extra,
    }],
    flow: [{ type: "page", id: "p", questionIds: ["b"] }, { type: "end", id: "e", status: "complete" }],
  });
  return { def, q: def.questions[0] };
};
const errs = (x: ReturnType<typeof make>, v: unknown) =>
  validateQuestion(x.def, x.q, v, { def: x.def, state: { answers: {}, embedded: {} } } as never).map((e) => e.message);

test("capacity — one per bucket, a bucket's own capacity, the question's maximum, else no limit", () => {
  assert.equal(bucketCapacity({ bucketMode: "one", bucketMax: 5 } as never, { meta: { capacity: 3 } }), 1, "one-per-bucket wins");
  assert.equal(bucketCapacity({ bucketMax: 5 } as never, { meta: { capacity: 3 } }), 3, "the bucket's own capacity");
  assert.equal(bucketCapacity({ bucketMax: 5 } as never, {}), 5);
  assert.equal(bucketCapacity({} as never, {}), Infinity);
});

test("multiple per bucket (the default): Apple, Banana and Orange can all go in Fruits", () => {
  const { q } = make({});
  let v: Record<string, unknown> = {};
  for (const item of ["1", "2", "3"]) {
    const r = dropInto(q, v, item, "fruit");
    assert.ok(r.ok);
    v = r.next;
  }
  assert.deepEqual(v, { 1: "fruit", 2: "fruit", 3: "fruit" });
});

test("one per bucket — prevent refuses the second item and says why; replace sends the first back", () => {
  const prevent = make({ bucketMode: "one" }).q;
  const a = dropInto(prevent, {}, "1", "fruit");
  assert.ok(a.ok);
  const b = dropInto(prevent, a.ok ? a.next : {}, "2", "fruit");
  assert.equal(b.ok, false);
  assert.match(!b.ok ? b.reason : "", /“Fruits” already has an item/);
  const moving = dropInto(prevent, { 1: "fruit" }, "1", "fruit");
  assert.ok(moving.ok, "dropping an item back where it already is is not a second item");

  const replace = make({ bucketMode: "one", bucketFull: "replace" }).q;
  const c = dropInto(replace, { 1: "fruit" }, "2", "fruit");
  assert.ok(c.ok);
  assert.deepEqual(c.ok ? c.next : null, { 2: "fruit" });
  assert.equal(c.ok ? c.displaced : null, "1");
});

test("a bucket's own capacity — the third vegetable is refused", () => {
  const { q } = make({});
  const r = dropInto(q, { 1: "veg", 2: "veg" }, "3", "veg");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /at most 2 items/);
});

test("validation — over capacity, under the minimum, and an empty bucket where empty is not allowed", () => {
  assert.deepEqual(errs(make({ bucketMode: "one" }), { 1: "fruit", 2: "fruit" }), ["“Fruits” can hold at most 1 item."]);
  assert.deepEqual(errs(make({ allowEmptyBuckets: false }), { 1: "fruit", 2: "fruit" }), ["Please put at least one item in “Vegetables”."]);
  assert.deepEqual(errs(make({ bucketMin: 2 }), { 1: "fruit", 2: "fruit", 3: "veg" }), ["Please put at least 2 items in “Vegetables”."]);
  assert.deepEqual(errs(make({ allowEmptyBuckets: false }), {}), [], "an untouched optional question is not judged");
  assert.deepEqual(bucketProblems(make({}).q, { 1: "veg", 2: "veg", 3: "veg" }), ["“Vegetables” can hold at most 2 items."]);
});

test("every item categorized is the question's Required — a missing row is reported by name", () => {
  const x = make({}, { required: true });
  const m = errs(x, { 1: "fruit", 2: "fruit" });
  assert.ok(m.some((s) => /Carrot/.test(s)), m.join(" | "));
});
