import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedLru } from "./boundedLru.ts";

test("ANALYTICS-11: the stamp cache never holds more than its ceiling", () => {
  const c = new BoundedLru<string, number>(500);
  for (let i = 0; i < 2_000; i++) c.set(`survey-${i}:LIVE`, i);
  assert.equal(c.size, 500);
  assert.equal(c.get("survey-0:LIVE"), undefined, "the oldest went first");
  assert.equal(c.get("survey-1999:LIVE"), 1999);
});

test("ANALYTICS-11: a read keeps an entry young; a rewrite does not grow the map", () => {
  const c = new BoundedLru<string, string>(2);
  c.set("a", "1"); c.set("b", "2");
  assert.equal(c.get("a"), "1");
  c.set("c", "3");
  assert.equal(c.has("a"), true, "a was read after b, so b is the one evicted");
  assert.equal(c.has("b"), false);
  c.set("a", "4");
  assert.equal(c.size, 2);
  assert.equal(c.get("a"), "4");
  assert.throws(() => new BoundedLru(0));
});
