import { test } from "node:test";
import assert from "node:assert/strict";
import { conjointPlugin } from "./conjoint.js";

/**
 * PROHIBITIONS.
 *
 * The point is not that the option exists — it is that a generated design
 * cannot contain a forbidden concept, that an impossible set of prohibitions
 * is refused before fielding rather than after, and that the cost to the
 * design space is reported instead of discovered.
 */

const attributes = [
  { name: "Brand", levels: ["Premium", "Mainstream", "Value"] },
  { name: "Price", levels: ["$399", "$599", "$799", "$999"] },
  { name: "Warranty", levels: ["1 year", "2 years", "3 years"] },
];

const base = { attributes, tasks: 8, alternativesPerTask: 3, versions: 2 };

/** Every concept in a generated design, as attribute→level maps. */
const concepts = (rows: Record<string, unknown>[]) =>
  rows.filter((r) => Number(r.none_option) !== 1)
    .map((r) => Object.fromEntries(attributes.map((a) => [a.name, String(r[a.name])])));

test("a forbidden pair never appears in a generated design", () => {
  const config = {
    ...base,
    prohibitions: [
      { a: { attribute: "Brand", level: "Value" }, b: { attribute: "Price", level: "$999" } },
      { a: { attribute: "Brand", level: "Value" }, b: { attribute: "Warranty", level: "3 years" } },
    ],
  };
  assert.deepEqual(conjointPlugin.validateConfig!(config), []);
  const { rows } = conjointPlugin.generate(config, 4242);
  for (const c of concepts(rows)) {
    assert.ok(!(c.Brand === "Value" && c.Price === "$999"), `illegal concept: ${JSON.stringify(c)}`);
    assert.ok(!(c.Brand === "Value" && c.Warranty === "3 years"), `illegal concept: ${JSON.stringify(c)}`);
  }
  assert.ok(rows.length > 0);
});

test("prohibitions are symmetric — the order of the pair does not matter", () => {
  const forward = conjointPlugin.generate({
    ...base,
    prohibitions: [{ a: { attribute: "Brand", level: "Value" }, b: { attribute: "Price", level: "$999" } }],
  }, 7);
  const backward = conjointPlugin.generate({
    ...base,
    prohibitions: [{ a: { attribute: "Price", level: "$999" }, b: { attribute: "Brand", level: "Value" } }],
  }, 7);
  assert.deepEqual(forward.rows, backward.rows);
});

test("a design is still reproducible from (config, seed) with prohibitions", () => {
  const config = {
    ...base,
    prohibitions: [{ a: { attribute: "Brand", level: "Premium" }, b: { attribute: "Price", level: "$399" } }],
  };
  assert.deepEqual(
    conjointPlugin.generate(config, 99).rows,
    conjointPlugin.generate(config, 99).rows,
  );
});

test("a prohibition naming something that does not exist is refused", () => {
  const bad = conjointPlugin.validateConfig!({
    ...base,
    prohibitions: [{ a: { attribute: "Colour", level: "Red" }, b: { attribute: "Price", level: "$999" } }],
  });
  assert.ok(bad.some((e) => /attribute "Colour"/.test(e)), bad.join(" | "));

  const badLevel = conjointPlugin.validateConfig!({
    ...base,
    prohibitions: [{ a: { attribute: "Brand", level: "Luxury" }, b: { attribute: "Price", level: "$999" } }],
  });
  assert.ok(badLevel.some((e) => /level "Luxury"/.test(e)), badLevel.join(" | "));
});

test("pairing two levels of the same attribute is refused, with the reason", () => {
  const errs = conjointPlugin.validateConfig!({
    ...base,
    prohibitions: [{ a: { attribute: "Price", level: "$399" }, b: { attribute: "Price", level: "$999" } }],
  });
  assert.ok(errs.some((e) => /only ever has one of them/.test(e)), errs.join(" | "));
});

test("a prohibition set that rules out a whole level is refused — it could never be estimated", () => {
  const errs = conjointPlugin.validateConfig!({
    ...base,
    prohibitions: attributes[1].levels.map((price) => ({
      a: { attribute: "Brand", level: "Value" },
      b: { attribute: "Price", level: price },
    })),
  });
  assert.ok(errs.some((e) => /appears in no legal concept/.test(e)), errs.join(" | "));
});

test("a set that leaves fewer concepts than a task needs is refused before fielding", () => {
  const tiny = {
    attributes: [
      { name: "A", levels: ["a1", "a2"] },
      { name: "B", levels: ["b1", "b2"] },
    ],
    tasks: 4, alternativesPerTask: 3,
    prohibitions: [
      { a: { attribute: "A", level: "a1" }, b: { attribute: "B", level: "b1" } },
      { a: { attribute: "A", level: "a2" }, b: { attribute: "B", level: "b2" } },
    ],
  };
  const errs = conjointPlugin.validateConfig!(tiny);
  assert.ok(errs.some((e) => /only 2 legal concepts/.test(e)), errs.join(" | "));
});

test("generate refuses an impossible configuration rather than emitting an illegal design", () => {
  const impossible = {
    attributes: [
      { name: "A", levels: ["a1", "a2"] },
      { name: "B", levels: ["b1", "b2"] },
    ],
    tasks: 2, alternativesPerTask: 3,
    prohibitions: [
      { a: { attribute: "A", level: "a1" }, b: { attribute: "B", level: "b1" } },
      { a: { attribute: "A", level: "a2" }, b: { attribute: "B", level: "b2" } },
    ],
  };
  assert.throws(() => conjointPlugin.generate(impossible, 1), /legal concepts/);
});

test("the summary says what the prohibitions cost", () => {
  const { summary } = conjointPlugin.generate({
    ...base,
    prohibitions: [{ a: { attribute: "Brand", level: "Value" }, b: { attribute: "Price", level: "$999" } }],
  }, 11) as { summary: Record<string, unknown> };
  assert.equal(summary.prohibitions, 1);
  assert.equal(summary.totalConcepts, 36);
  assert.equal(summary.legalConcepts, 33);
  assert.equal(summary.spaceRemaining, 91.7);
});

test("a design with no prohibitions is byte-identical to before the feature", () => {
  /*
   * The whole point of a new capability in a survey platform is that it costs
   * existing studies nothing: a design generated last month must regenerate
   * the same way today, or every fielded conjoint changes under its owner.
   */
  const withField = conjointPlugin.generate({ ...base, prohibitions: [] }, 20260901);
  const without = conjointPlugin.generate({ ...base }, 20260901);
  assert.deepEqual(withField.rows, without.rows);
  assert.equal("prohibitions" in (without.summary as object), false,
    "a design with no prohibitions should not gain a prohibitions summary");
});
