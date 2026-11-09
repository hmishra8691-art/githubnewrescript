import { test } from "node:test";
import assert from "node:assert/strict";
import { designGeneratorRegistry } from "@rescript/schema";
import { registerBuiltinDesignGenerators } from "./index.js";
import { readDesignRequest, recommendDesign, DESIGN_SAMPLES } from "./designRequest.js";

registerBuiltinDesignGenerators();

test("the spec's own example: understood, recommended, missing names asked", () => {
  const r = readDesignRequest("I want to create a choice-based conjoint study with six attributes and three to four levels per attribute. I need an efficient, balanced experimental design with 12 choice tasks per respondent and three alternatives per task. Please recommend the optimal design.");
  assert.equal(r.kind, "conjoint");
  assert.equal(r.attributeCount, 6);
  assert.deepEqual(r.levels, [3, 4]);
  assert.equal(r.tasks, 12);
  assert.equal(r.alternatives, 3);
  assert.equal(r.method, "efficient");
  const rec = recommendDesign(r);
  assert.equal(rec.kind, "conjoint");
  assert.equal(rec.config.tasks, 12); assert.equal(rec.config.alternativesPerTask, 3); assert.equal(rec.config.method, "efficient");
  assert.equal((rec.config.attributes as unknown[]).length, 6);
  assert.ok(rec.placeholders);
  assert.equal(rec.questions[0].key, "attributes");
  assert.ok(rec.why.some((w) => /Orme/.test(w)) && rec.minSample! >= 300);
  /* the placeholder design is still a valid, generatable design */
  const plugin = designGeneratorRegistry.get("conjoint")!;
  assert.deepEqual(plugin.validateConfig?.(rec.config as never) ?? [], []);
});

test("named attributes and a constraint; answers replace placeholders", () => {
  const r = readDesignRequest("CBC with 3 alternatives per task.\nBrand: Acme, Globex, Initech\nPrice: $9, $14, $19\nStorage: 64 GB, 128 GB\nNever show Initech with $9.");
  assert.equal(r.attributes.length, 3);
  assert.deepEqual(r.prohibitions, [{ a: { attribute: "Brand", level: "Initech" }, b: { attribute: "Price", level: "$9" } }]);
  const rec = recommendDesign(r);
  assert.ok(!rec.placeholders && rec.questions.length === 0);
  assert.equal((rec.config.prohibitions as unknown[]).length, 1);
  const later = recommendDesign(readDesignRequest("a conjoint with 4 attributes"), { attributes: [{ name: "A", levels: ["1", "2"] }, { name: "B", levels: ["1", "2", "3"] }] });
  assert.ok(!later.placeholders);
});

test("the method follows the description when it is not named", () => {
  assert.equal(recommendDesign(readDesignRequest("rank 20 claims for our toothpaste, 5 per task")).kind, "maxdiff");
  assert.equal(recommendDesign(readDesignRequest("9 attributes of a car, we want to know trade-offs")).kind, "acbc");
  assert.equal(recommendDesign(readDesignRequest("5 attributes, physicians only, small sample")).kind, "cva");
  const w = recommendDesign(readDesignRequest("Test 4 ads in sequence and balance carry-over effects"));
  assert.equal(w.kind, "experiment"); assert.equal(w.config.designType, "williams");
  const m = recommendDesign(readDesignRequest("MaxDiff:\nFree delivery\nLonger warranty\n24/7 support\nEasy returns\nLoyalty points\nPrice match"));
  assert.equal((m.config.items as string[]).length, 6);
});

test("warnings: too few tasks, too many alternatives, sample too small", () => {
  const rec = recommendDesign(readDesignRequest("A conjoint with 6 attributes and 4 levels, 25 tasks and 6 alternatives, sample of 150"));
  const w = rec.warnings.join(" ");
  assert.match(w, /fatigue/); assert.match(w, /hard to read/); assert.match(w, /below/);
});

test("every sample generates through its real generator, with no validation errors", () => {
  for (const [kind, s] of Object.entries(DESIGN_SAMPLES)) {
    const plugin = designGeneratorRegistry.get(kind)!;
    assert.ok(plugin, kind);
    assert.deepEqual(plugin.validateConfig?.(s.config as never) ?? [], [], kind);
    const out = plugin.generate(s.config as never, 20261109);
    assert.ok(out.rows.length > 0, `${kind} rows`);
    if (s.request) assert.equal(readDesignRequest(s.request).kind, kind === "custom" ? null : kind, `${kind}: its request names its method`);
  }
});

test("partial profile: read, recommended with more tasks, and offered for many attributes", () => {
  const r = readDesignRequest("A partial-profile CBC with 10 attributes, showing 4 attributes per task");
  assert.equal(r.kind, "conjoint"); assert.equal(r.attributesPerTask, 4);
  const rec = recommendDesign(r);
  assert.equal(rec.config.attributesPerTask, 4);
  assert.ok((rec.config.tasks as number) >= 16, String(rec.config.tasks));
  assert.ok(rec.why.some((w) => /Partial profile: each task shows 4 of the 10/.test(w)));
  const plugin = designGeneratorRegistry.get("conjoint")!;
  assert.deepEqual(plugin.validateConfig?.(rec.config as never) ?? [], []);
  const full = recommendDesign(readDesignRequest("a choice-based conjoint with 8 attributes"));
  assert.match(full.warnings.join(" "), /partial-profile CBC/);
});

test("mergeDesignReading: the model fills only what the rules missed, and only with names the researcher said", async () => {
  const { mergeDesignReading } = await import("./designRequest.js");
  const text = "We want to test a coffee subscription: brand with Arabica Co, Bean Bros and Café Uno, price of 9, 12 or 15 dollars, and delivery weekly or monthly. Give people about a dozen choice sets.";
  const rules = readDesignRequest(text);
  const m = mergeDesignReading(rules, {
    kind: "conjoint",
    attributes: [{ name: "brand", levels: ["Arabica Co", "Bean Bros", "Café Uno"] }, { name: "price", levels: ["9", "12", "15 dollars"] }, { name: "delivery", levels: ["weekly", "monthly"] }, { name: "Roast", levels: ["Light", "Dark"] }],
    items: [], treatments: [], tasks: 12, alternatives: 99, none: null,
  }, text);
  assert.equal(m.read.kind, rules.kind ?? "conjoint");
  assert.deepEqual(rules.attributes, [], "the rules do not split a spoken sentence into attributes");
  assert.deepEqual(m.read.attributes.map((a) => [a.name, a.levels.length]), [["brand", 3], ["price", 3], ["delivery", 2]]);
  assert.ok(m.dropped >= 1, "the invented Roast attribute is dropped");
  assert.equal(rules.tasks, undefined); assert.equal(m.read.tasks, 12);
  assert.equal(m.read.alternatives, rules.alternatives, "out-of-range numbers are ignored");
  assert.ok(m.read.understood.some((u) => /\(read by the AI\)/.test(u)));
  /* a field the rules read is never overruled */
  const r2 = readDesignRequest("A MaxDiff of 12 items, 4 per task.");
  const m2 = mergeDesignReading(r2, { kind: "conjoint", perTask: 5, items: [], attributes: [], treatments: [] }, "A MaxDiff of 12 items, 4 per task.");
  assert.equal(m2.read.kind, "maxdiff"); assert.equal(m2.read.perTask, 4); assert.deepEqual(m2.added, []);
  /* garbage from the model changes nothing */
  assert.deepEqual(mergeDesignReading(r2, "nonsense", "x").read, r2);
});
