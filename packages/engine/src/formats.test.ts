/**
 * COUNTRY-SHAPED FORMATS, AND THE SUBTYPE CHECKS THAT USE THEM.
 *
 * The September 2026 review asked for the same three things twice — once for
 * the Text/Open-End subtypes and once for the fields inside a List question:
 * a country for phone numbers, a country for postal codes, and a currency
 * that is not always a dollar sign. These are those, and the tests that say
 * the loose default is still the default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPhone, checkPostal, checkUrl, affixFor } from "./formats.js";
import { validateFieldValue, fieldInputProps } from "./fields.js";

test("a phone number is checked against the country the question names", () => {
  assert.equal(checkPhone("+91 98765 43210", "IN"), null);
  assert.equal(checkPhone("09876543210", "IN"), null, "a national trunk 0 is how people write their own number");
  assert.equal(checkPhone("98765 43210", "IN"), null);
  assert.ok(checkPhone("12345 67890", "IN"), "an Indian mobile does not start with 1");
  assert.ok(checkPhone("+1 415 555 0132", "IN"), "a US number is not a valid Indian one");

  assert.equal(checkPhone("+1 (415) 555-0132", "US"), null);
  assert.ok(checkPhone("+1 015 555 0132", "US"), "a US area code does not start with 0");
});

test("naming no country keeps the loose check the platform has always applied", () => {
  /*
   * This is the promise that makes the feature safe to ship: a question that
   * does not choose a country behaves exactly as it did, so nothing already
   * in field starts rejecting respondents.
   */
  assert.equal(checkPhone("+1 (555) 123-4567"), null);
  assert.equal(checkPhone("+44 7700 900123"), null);
  assert.equal(checkPhone("+91 98765 43210"), null);
  assert.ok(checkPhone("abc"));
  assert.equal(checkPostal("SW1A 1AA"), null);
  assert.equal(checkPostal("560001"), null);
});

test("a postal code is checked against its own country's shape", () => {
  assert.equal(checkPostal("560001", "IN"), null);
  assert.ok(checkPostal("94107", "IN"), "a five-digit ZIP is not an Indian PIN");
  assert.equal(checkPostal("94107", "US"), null);
  assert.equal(checkPostal("94107-1234", "US"), null);
  assert.ok(checkPostal("560001", "US"), "and a six-digit PIN is not a US ZIP — the review's exact example");
  assert.equal(checkPostal("SW1A 1AA", "GB"), null);
});

test("a web address may be typed the way people type it", () => {
  assert.equal(checkUrl("example.com"), null, "a bare host is a real answer, not a formality");
  assert.equal(checkUrl("https://example.com/a/b?c=1"), null);
  assert.ok(checkUrl("not a url"));
  assert.ok(checkUrl("javascript:alert(1)"));
});

test("a list field follows the question's country too", () => {
  /*
   * One setting, both places. The review asked for the country dropdown on
   * the scalar Phone question and again on the phone FIELD inside a List
   * question, because it is the same request about the same data.
   */
  assert.equal(validateFieldValue("phone", "98765 43210", { phoneCountry: "IN" }), null);
  assert.ok(validateFieldValue("phone", "12345", { phoneCountry: "IN" }));
  assert.equal(validateFieldValue("zip", "560001", { postalCountry: "IN" }), null);
  assert.ok(validateFieldValue("zip", "560001", { postalCountry: "US" }));
  /* and with no country, the old loose behaviour */
  assert.equal(validateFieldValue("phone", "+1 (555) 123-4567"), null);
});

test("a currency field shows the currency the study is in, on the side it was asked for", () => {
  /* it was a hard-coded "$" with no way to change it */
  assert.equal(fieldInputProps("currency").prefix, "$", "the old default still applies when nothing is chosen");
  assert.equal(fieldInputProps("currency", { currencyCode: "INR" }).prefix, "₹");
  assert.equal(fieldInputProps("currency", { currencyCode: "INR", symbolSide: "right" }).suffix, "₹");
  assert.equal(fieldInputProps("currency", { currencySymbol: "kr" }).prefix, "kr",
    "a typed symbol covers every currency not in the list");

  assert.deepEqual(affixFor({ currencySymbol: "%", symbolSide: "right" }), { text: "%", side: "right" });
  assert.equal(affixFor({}), null, "a plain numeric question shows no symbol at all");
});
