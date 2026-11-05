import test from "node:test";
import assert from "node:assert/strict";
import {
  claimedAttributes, observedAttributes, mergeAttributes, attributeConflicts, holdCorrection,
  type QuotaMapping,
} from "./attributes.js";

const mapping: QuotaMapping = {
  gender: { criterion: "gender", values: { m: "male", male: "male", "1": "male", f: "female", female: "female", "2": "female" } },
  age: { criterion: "ageBand", bands: [{ max: 34, value: "18-34" }, { min: 35, max: 54, value: "35-54" }, { min: 55, value: "55+" }] },
  scr_gender: { criterion: "gender", values: { "a man": "male", "a woman": "female" } },
  scr_age: { criterion: "ageBand", bands: [{ max: 34, value: "18-34" }, { min: 35, max: 54, value: "35-54" }, { min: 55, value: "55+" }] },
};

test("a vendor's codes are read through the declared mapping", () => {
  assert.deepEqual(claimedAttributes({ gender: "m", age: "29" }, mapping).attributes,
    { gender: "male", ageBand: "18-34" });
  // a different vendor, different codes, same mapping file
  assert.deepEqual(claimedAttributes({ gender: "2", age: "61" }, mapping).attributes,
    { gender: "female", ageBand: "55+" });
});

test("an UNMAPPED parameter contributes nothing and is reported", () => {
  const r = claimedAttributes({ gender: "m", income_bracket: "C2" }, mapping);
  assert.deepEqual(r.attributes, { gender: "male" });
  assert.deepEqual(r.unmapped, ["income_bracket"], "somebody configured a link to send this; it needs finishing");
});

test("an unknown VALUE produces no attribute — never the raw value passed through", () => {
  /*
   * The failure this prevents: `?gender=1` passed through creates an attribute of "1", which matches no cell
   * and is indistinguishable from a respondent whose gender is unknown.
   */
  const r = claimedAttributes({ gender: "x" }, mapping);
  assert.deepEqual(r.attributes, {}, "no gender at all, rather than a gender of 'x'");
  assert.deepEqual(r.unknownValues, [{ param: "gender", value: "x" }]);
});

test("the plumbing parameters are not reported as missing targeting", () => {
  const r = claimedAttributes({ pid: "p_123", sid: "s_1", hash: "abc", gender: "m" }, mapping);
  assert.deepEqual(r.unmapped, [], "pid and friends are not demographics anybody forgot to map");
});

test("age bands are inclusive at their edges", () => {
  const band = (age: string) => claimedAttributes({ age }, mapping).attributes.ageBand;
  assert.equal(band("34"), "18-34");
  assert.equal(band("35"), "35-54");
  assert.equal(band("54"), "35-54");
  assert.equal(band("55"), "55+");
  assert.equal(band("not a number"), undefined, "an unparseable age is no age, not band one");
});

test("the survey's answer wins over the vendor's claim", () => {
  const claimed = claimedAttributes({ gender: "m", age: "29" }, mapping).attributes;
  const observed = observedAttributes([{ id: "scr_gender", answer: "a woman" }], mapping).attributes;
  const merged = mergeAttributes(claimed, observed);
  assert.equal(merged.gender, "female", "the person answered directly; the panel is repeating an old profile");
  assert.equal(merged.ageBand, "18-34", "and what the survey did not ask keeps the vendor's value");
});

test("a disagreement is named, for counting against the vendor", () => {
  const claimed = { gender: "male", ageBand: "25-34" };
  const observed = { gender: "female", ageBand: "55+" };
  assert.deepEqual(attributeConflicts(claimed, observed), [
    { criterion: "ageBand", claimed: "25-34", observed: "55+" },
    { criterion: "gender", claimed: "male", observed: "female" },
  ]);
});

test("a question the survey did not ask is NOT a disagreement", () => {
  // otherwise every vendor looks like a liar for the criteria nobody checked
  assert.deepEqual(attributeConflicts({ gender: "male", income: "high" }, { gender: "male" }), []);
});

test("agreement produces no conflict", () => {
  assert.deepEqual(attributeConflicts({ gender: "male" }, { gender: "male" }), []);
});

test("the hold is released on what was CLAIMED and counted on what was observed", () => {
  /*
   * The leak this prevents: the door held a slot in the male cell, the completion counts into female, and the
   * male cell holds a slot for somebody who finished as somebody else. Over a field period that closes a cell
   * which is not full.
   */
  const claimed = { gender: "male", ageBand: "18-34" };
  const observed = { gender: "female" };
  const { release, count } = holdCorrection(claimed, observed);
  assert.deepEqual(release, { gender: "male", ageBand: "18-34" }, "release exactly what was held");
  assert.deepEqual(count, { gender: "female", ageBand: "18-34" }, "count what is true");
});

test("no mapping at all yields no attributes and admits everybody", () => {
  const r = claimedAttributes({ gender: "m", age: "29" }, {});
  assert.deepEqual(r.attributes, {});
  /*
   * Which is the intended behaviour: an unconfigured project must not refuse people on cells it cannot prove
   * they belong to. The quota is still protected, because the completion is counted on what the survey saw.
   */
  assert.equal(r.unmapped.length, 2);
});

test("values are matched case-insensitively, both sides", () => {
  assert.equal(claimedAttributes({ gender: "MALE" }, mapping).attributes.gender, "male");
  assert.equal(claimedAttributes({ gender: " F " }, mapping).attributes.gender, "female");
});

test("resolution is deterministic and the reports are sorted", () => {
  const a = claimedAttributes({ zebra: "1", apple: "2", gender: "m" }, mapping);
  assert.deepEqual(a.unmapped, ["apple", "zebra"]);
});
