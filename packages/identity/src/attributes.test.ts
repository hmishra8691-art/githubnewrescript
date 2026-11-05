import test from "node:test";
import assert from "node:assert/strict";
import { claimedAttributes, observedAttributes, parseQuotaMapping, type QuotaMapping } from "./attributes.js";

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

test("the survey's answer and the vendor's claim are resolved through the SAME mapping", () => {
  /*
   * The merge, the disagreement and the hold correction used to be tested here. They are now one statement in
   * `rescript_quota_complete_session` (0089), under the lock that makes them correct when two people finish at
   * the same instant — see scripts/quota-holds-sql-test.sql tests 7 and 8. What is still this file's job is
   * that both halves speak the same vocabulary, which is what makes comparing them meaningful at all.
   */
  const claimed = claimedAttributes({ gender: "m", age: "29" }, mapping).attributes;
  const observed = observedAttributes([{ id: "scr_gender", answer: "a woman" }], mapping).attributes;
  assert.deepEqual(claimed, { gender: "male", ageBand: "18-34" });
  assert.deepEqual(observed, { gender: "female" }, "a URL parameter and a screener answer land on the same criterion");
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

test("a mapping that declares a criterion but can never resolve one is refused", () => {
  const r = parseQuotaMapping({ gender: { criterion: "gender" } });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /no values or bands/);
});

test("every problem is reported, not just the first", () => {
  const r = parseQuotaMapping({
    "not a param!": { criterion: "gender", values: { m: "male" } },
    age: { criterion: "ageBand", bands: [{ min: 60, max: 30, value: "backwards" }] },
    region: { criterion: "", values: { n: "north" } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3, "an administrator fixing one at a time saves four times");
});

test("a band unbounded at both ends is refused, because it swallows every value", () => {
  const r = parseQuotaMapping({ age: { criterion: "ageBand", bands: [{ value: "everyone" }] } });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /unbounded at both ends/);
});

test("a valid mapping comes back normalised, and no mapping at all is valid", () => {
  const r = parseQuotaMapping({ gender: { criterion: " gender ", values: { "M": " male " } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mapping.gender, { criterion: "gender", values: { m: "male" } },
    "keys lower-cased so the vendor's casing cannot miss, values trimmed");
  assert.deepEqual(parseQuotaMapping(undefined), { ok: true, mapping: {}, problems: [] });
});

test("the parsed mapping is the one that resolves — normalisation is not cosmetic", () => {
  const parsed = parseQuotaMapping({ g: { criterion: "gender", values: { "M": "male" } } });
  assert.equal(claimedAttributes({ g: "m" }, parsed.mapping).attributes.gender, "male");
});
