import { test } from "node:test";
import assert from "node:assert/strict";
import { readDesignBrief } from "./designBrief.js";

test("a complete conjoint brief: method, attributes and levels, sample and time are read; the design is advised; nothing is asked", () => {
  const b = readDesignBrief(`We are launching a premium subscription and need to know how much customers would pay and which features justify the price. We want a conjoint with 400 respondents in about 10 minutes.
Price: $9, $14, $19
Storage: 50 GB, 200 GB, 1 TB
Support: Email, 24/7 chat`)!;
  assert.equal(b.method.id, "conjoint_pricing");
  assert.deepEqual(b.inputs.attributes, [{ name: "Price", levels: ["$9", "$14", "$19"] }, { name: "Storage", levels: ["50 GB", "200 GB", "1 TB"] }, { name: "Support", levels: ["Email", "24/7 chat"] }]);
  assert.equal(b.inputs.sample, 400);
  assert.equal(b.inputs.minutes, 10);
  assert.equal(b.ready, true);
  assert.deepEqual(b.questions, []);
  assert.equal(b.advice!.method, "cbc");
  assert.match(b.structure.join(" "), /choice exercise.*3 attributes/);
  assert.match(b.explanation.join(" "), /Method: Choice-based conjoint.*Design:.*tasks.*It will build:.*Analysis:/s);
  assert.equal(b.fields.attributes, "Price: $9, $14, $19\nStorage: 50 GB, 200 GB, 1 TB\nSupport: Email, 24/7 chat");
});

test("attributes written inline in a sentence are read the same way", () => {
  const b = readDesignBrief("Which features and price drive choice of our new laptop? Use a conjoint: the attributes are brand (Alpha, Beta, Gamma), memory (8 GB, 16 GB, 32 GB) and price ($799, $999, $1,199).")!;
  assert.deepEqual(b.inputs.attributes!.map((a) => [a.name, a.levels.length]), [["Brand", 3], ["Memory", 3], ["Price", 3]]);
  assert.equal(b.inputs.attributes![2].levels[2], "$1,199", "a thousands separator is not a level separator");
});

test("what is missing is ASKED, never invented: a conjoint without levels, a MaxDiff without items", () => {
  const c = readDesignBrief("I need a conjoint study to find the best price and features for our new fitness app")!;
  assert.equal(c.ready, false);
  assert.equal(c.inputs.attributes, undefined, "no attributes were made up");
  assert.match(c.questions[0].question, /What are the attributes and their levels\?/);
  assert.deepEqual(c.structure, []);
  assert.match(c.explanation.join(" "), /nothing is assumed in their place/);
  const m = readDesignBrief("Use MaxDiff to find which benefits matter most to members of our gym")!;
  assert.equal(m.method.id, "maxdiff");
  assert.match(m.questions.map((q) => q.question).join(" "), /Which items/);
  const done = readDesignBrief("Use MaxDiff to find which benefits matter most to members of our gym. The benefits are: longer opening hours, free classes, a pool, personal training, childcare and parking. 300 respondents.")!;
  assert.deepEqual(done.inputs.items, ["longer opening hours", "free classes", "a pool", "personal training", "childcare", "parking"]);
  assert.equal(done.ready, true);
  assert.equal(done.advice!.method, "maxdiff");
  assert.match(done.structure.join(" "), /MaxDiff exercise.*6 items/);
});

test("prices, concepts and a product are read for the methods that take them", () => {
  const g = readDesignBrief("Find the revenue-maximising price for our new meal kit using a Gabor-Granger price ladder. Prices to test: $45, $52, $59, $66 and $73.")!;
  assert.equal(g.method.id, "gabor_granger");
  assert.deepEqual(g.inputs.prices, [45, 52, 59, 66, 73]);
  assert.equal(g.inputs.product, "meal kit");
  assert.equal(g.ready, true);
  const s = readDesignBrief("Run a sequential monadic concept test for our new drink. The concepts are Citrus Burst, Berry Calm and Mint Rush. 250 respondents.")!;
  assert.equal(s.method.id, "sequential_monadic");
  assert.deepEqual(s.inputs.concepts, ["Citrus Burst", "Berry Calm", "Mint Rush"]);
  assert.equal(s.inputs.sample, 250);
});

test("a method chosen by hand is kept, and its own inputs are read from the same words; a too-small sample is said", () => {
  const b = readDesignBrief("How do patients trade off benefit and side effects? 80 respondents.\nChance of improvement: 50%, 70%, 90%\nSide effects: None, Mild, Moderate", { methodId: "treatment_preference" })!;
  assert.equal(b.method.id, "treatment_preference");
  assert.equal(b.inputs.attributes!.length, 2);
  assert.match(b.explanation.join(" "), /chosen by you/);
  assert.match(b.explanation.join(" "), /80 completes is below/);
  assert.match(b.explanation.join(" "), /does not establish clinical benefit/);
  assert.equal(readDesignBrief("hello"), null);
});
