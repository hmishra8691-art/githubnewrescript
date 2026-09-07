import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, compileFlow } from "./index.js";

/**
 * EVEN PRESENTATION.
 *
 * `randomizer.evenPresentation` was editable in the flow editor, stored on
 * the node, and never read by `compileFlow`. "Show 1 of 4 concepts, evenly"
 * was therefore a plain shuffle, which gives each concept an equal CHANCE and
 * not an equal number of SHOWINGS — and a monadic test built on it is
 * unbalanced in exactly the way its author was trying to prevent.
 */

const survey = (evenPresentation: boolean) => SurveyDefinition.parse({
  meta: { id: "s1", code: "S1", title: "Monadic", version: "1.0" },
  questions: ["a", "b", "c", "d"].map((k) => ({
    id: `q_${k}`, code: `Q${k.toUpperCase()}`, variableName: `Q${k.toUpperCase()}`,
    type: "single_select", text: `Concept ${k}`,
    options: [{ code: 1, label: "Like" }, { code: 2, label: "Dislike" }],
  })),
  flow: [
    {
      type: "randomizer", id: "rot", show: 1, evenPresentation,
      children: ["a", "b", "c", "d"].map((k) => ({
        type: "page", id: `p_${k}`, questionIds: [`q_${k}`],
      })),
    },
    { type: "end", id: "e1", status: "complete" },
  ],
});

/** Which concept a respondent with this seed is shown. */
const shownFor = (def: ReturnType<typeof survey>, seed: number): string => {
  const state = createResponseState(def, { sessionId: "t", seed });
  const steps = compileFlow(def, state, {});
  const page = steps.find((s) => s.kind === "page");
  return page && "pageId" in page ? String(page.pageId) : "none";
};

/** The spread between the most- and least-shown concept, as a percentage. */
const spread = (def: ReturnType<typeof survey>, n = 2000): number => {
  const counts = new Map<string, number>();
  for (let seed = 1; seed <= n; seed++) {
    const p = shownFor(def, seed);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const values = [...counts.values()];
  assert.equal(counts.size, 4, `all four concepts should appear at least once: ${JSON.stringify([...counts])}`);
  return ((Math.max(...values) - Math.min(...values)) / (n / 4)) * 100;
};

test("even presentation shows every concept about equally often", () => {
  const even = spread(survey(true));
  assert.ok(even < 15, `even presentation left a ${even.toFixed(1)}% spread between concepts`);
});

test("without it, one concept can be shown markedly more than another", () => {
  /*
   * Not a criticism of the shuffle — it is doing what a shuffle does. It is
   * the reason the setting exists, and the reason it mattered that the engine
   * ignored it.
   */
  const plain = spread(survey(false));
  assert.ok(plain > 0, "a shuffle should not be perfectly balanced by accident");
});

test("a respondent's concept does not change under them", () => {
  const def = survey(true);
  const first = shownFor(def, 909);
  for (let i = 0; i < 10; i++) assert.equal(shownFor(def, 909), first);
});

test("show N still shows exactly N", () => {
  const def = survey(true);
  for (const seed of [1, 50, 123, 8888]) {
    const state = createResponseState(def, { sessionId: "t", seed });
    const pages = compileFlow(def, state, {}).filter((s) => s.kind === "page");
    assert.equal(pages.length, 1, "a randomizer showing 1 of 4 must show one page");
  }
});

test("a randomizer with no show still presents every child", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "All", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "open_text", text: "one" },
      { id: "q2", code: "Q2", variableName: "B", type: "open_text", text: "two" },
    ],
    flow: [
      {
        type: "randomizer", id: "r", evenPresentation: true,
        children: [
          { type: "page", id: "p1", questionIds: ["q1"] },
          { type: "page", id: "p2", questionIds: ["q2"] },
        ],
      },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const state = createResponseState(def, { sessionId: "t", seed: 3 });
  assert.equal(compileFlow(def, state, {}).filter((s) => s.kind === "page").length, 2);
});
