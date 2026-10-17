import { test } from "node:test";
import assert from "node:assert/strict";
import { detectValueType, isListText, listContainsItem, listItems } from "./listValue.js";

test("listItems: commas, semicolons and new lines; spaces trimmed; empties dropped", () => {
  assert.deepEqual(listItems("90210, 10001,30301 ,  60601"), ["90210", "10001", "30301", "60601"]);
  assert.deepEqual(listItems("a;b\nc"), ["a", "b", "c"]);
  assert.deepEqual(listItems("x,,y, "), ["x", "y"]);
  assert.deepEqual(listItems(""), []);
  assert.deepEqual(listItems(null), []);
  assert.deepEqual(listItems(["02108", 10001]), ["02108", "10001"]);
  assert.deepEqual(listItems("single"), ["single"]);
});

test("detectValueType: integers, decimals, booleans, lists, identifiers with leading zeros, dates, URLs", () => {
  assert.equal(detectValueType("25"), "integer");
  assert.equal(detectValueType("25.75"), "decimal");
  assert.equal(detectValueType("true"), "boolean");
  assert.equal(detectValueType("FALSE"), "boolean");
  assert.equal(detectValueType("Hello World"), "string");
  assert.equal(detectValueType("90210, 10001, 30301, 60601"), "list");
  assert.equal(detectValueType("02108"), "string", "a leading zero is an identifier, never converted");
  assert.equal(detectValueType("2026-10-17"), "date");
  assert.equal(detectValueType("2026-10-17T09:30:00Z"), "datetime");
  assert.equal(detectValueType("https://example.com/a?b=1"), "url");
  assert.equal(detectValueType("{{ed.ZIP_CODE}}"), "string", "a piped reference is typed after it resolves");
  assert.equal(detectValueType("12345678901234567890"), "string", "beyond a safe integer stays text");
  assert.equal(detectValueType(""), "empty");
  assert.equal(isListText("1, 2"), true);
  assert.equal(isListText("1"), false);
});

test("listContainsItem: whole items, any-match for a list needle, never a partial match", () => {
  const zips = "10001, 10002, 10003, 10004, 10005";
  assert.equal(listContainsItem(zips, "10003"), true);
  assert.equal(listContainsItem(zips, "10005"), true);
  assert.equal(listContainsItem(zips, "10009"), false);
  assert.equal(listContainsItem(zips, "10001, 10003"), true, "any item of a list needle");
  assert.equal(listContainsItem(zips, " 10002 "), true, "spaces around an item are ignored");
  assert.equal(listContainsItem("110001, 20002", "10001"), false, "10001 never matches 110001");
  assert.equal(listContainsItem("02108, 02109", "02108"), true, "leading zeros kept");
  assert.equal(listContainsItem("02108", "2108"), false);
  assert.equal(listContainsItem("Red, Blue", "blue"), true, "case-insensitive, like contains elsewhere");
  assert.equal(listContainsItem("", "x"), false);
  assert.equal(listContainsItem(zips, ""), false);
});
