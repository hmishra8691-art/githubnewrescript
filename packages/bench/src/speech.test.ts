import { test } from "node:test";
import assert from "node:assert/strict";
import { corpusWordErrorRate, percentile, speechTokens, wordErrorRate } from "./speech.js";

test("word error rate counts substitutions, deletions and insertions against the reference", () => {
  assert.equal(wordErrorRate("the price is too high", "The price is too high.").rate, 0);
  const sub = wordErrorRate("the price is too high", "the prize is too high");
  assert.deepEqual([sub.substitutions, sub.deletions, sub.insertions, sub.rate], [1, 0, 0, 0.2]);
  const del = wordErrorRate("the price is too high", "the price too high");
  assert.deepEqual([del.substitutions, del.deletions, del.insertions], [0, 1, 0]);
  const ins = wordErrorRate("the price is too high", "the price is far too high");
  assert.deepEqual([ins.substitutions, ins.deletions, ins.insertions], [0, 0, 1]);
  assert.equal(wordErrorRate("", "").rate, 0);
  assert.equal(wordErrorRate("", "hello").rate, 1);
  assert.equal(wordErrorRate("hello there", "").rate, 1);
});

test("other scripts: Hindi by word, Chinese by character", () => {
  assert.deepEqual(speechTokens("कीमत बहुत ज़्यादा है।"), ["कीमत", "बहुत", "ज़्यादा", "है"]);
  assert.equal(wordErrorRate("कीमत बहुत ज़्यादा है", "कीमत बहुत कम है").rate, 0.25);
  assert.deepEqual(speechTokens("价格太高了。"), ["价", "格", "太", "高", "了"]);
  assert.equal(wordErrorRate("价格太高了", "价格太低了").rate, 0.2);
});

test("a set's rate is total errors over total words, and percentiles are nearest-rank", () => {
  const rate = corpusWordErrorRate([{ reference: "one two three four five six seven eight", hypothesis: "one two three four five six seven eight" }, { reference: "yes no", hypothesis: "yes yes" }]);
  assert.equal(rate, 0.1);
  assert.equal(percentile([900, 1100, 1000, 3000, 1200], 50), 1100);
  assert.equal(percentile([900, 1100, 1000, 3000, 1200], 95), 3000);
  assert.equal(percentile([], 50), 0);
});
