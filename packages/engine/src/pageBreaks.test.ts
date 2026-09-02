import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { createResponseState, compileFlow, countRespondentQuestions } from "./index.js";

/**
 * Page breaks INSIDE a block.
 *
 * A block holds one or more respondent pages. One page is the ordinary case
 * and stays a bare `page` node; adding a break wraps the block in a `block`
 * container whose children are pages. Both shapes were already in the schema
 * — these tests pin what the runtime does with them, and prove the single-page
 * shape still behaves exactly as it did before blocks could paginate.
 */

function survey(flow: unknown[]) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Test", version: "1.0" },
    questions: ["q1", "q2", "q3", "q4", "q5", "q6"].map((id, i) => ({
      id,
      code: `Q${i + 1}`,
      variableName: `Q${i + 1}`,
      type: "single_select",
      text: id,
      options: [
        { code: 1, label: "Yes" },
        { code: 2, label: "No" },
      ],
    })),
    flow,
  });
}

const pagesOf = (def: any, answers: Record<string, unknown> = {}) => {
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, answers);
  return compileFlow(def, state).filter((s) => s.kind === "page") as any[];
};

test("a block with two pages asks its questions on two pages", () => {
  const def = survey([
    {
      type: "block",
      id: "b1",
      title: "Demographics",
      children: [
        { type: "page", id: "p1", questionIds: ["q1", "q2"] },
        { type: "page", id: "p2", questionIds: ["q3", "q4"] },
      ],
    },
    { type: "end", id: "e", status: "complete" },
  ]);
  const pages = pagesOf(def);
  assert.equal(pages.length, 2, "one block, two respondent pages");
  assert.deepEqual(pages[0].questionIds, ["q1", "q2"]);
  assert.deepEqual(pages[1].questionIds, ["q3", "q4"]);
  // both pages report the same block in their section path — still ONE block
  assert.deepEqual(pages[0].sectionPath, ["Demographics"]);
  assert.deepEqual(pages[1].sectionPath, ["Demographics"]);
});

test("several breaks in one block, in the authored order", () => {
  const def = survey([
    {
      type: "block",
      id: "b1",
      children: [
        { type: "page", id: "p1", questionIds: ["q1", "q2"] },
        { type: "page", id: "p2", questionIds: ["q3", "q4", "q5"] },
        { type: "page", id: "p3", questionIds: ["q6"] },
      ],
    },
  ]);
  assert.deepEqual(
    pagesOf(def).map((p) => p.questionIds),
    [["q1", "q2"], ["q3", "q4", "q5"], ["q6"]],
  );
});

test("an untitled page inherits the block's heading; its own title wins", () => {
  const def = survey([
    {
      type: "block",
      id: "b1",
      title: "About you",
      children: [
        { type: "page", id: "p1", questionIds: ["q1"] },
        { type: "page", id: "p2", title: "Your household", questionIds: ["q2"] },
      ],
    },
  ]);
  const pages = pagesOf(def);
  assert.equal(pages[0].title, "About you", "inherited from the block");
  assert.equal(pages[1].title, "Your household", "an explicit page heading is not overridden");
});

test("a block's visibility governs every page inside it", () => {
  const def = survey([
    { type: "page", id: "p0", questionIds: ["q1"] },
    {
      type: "block",
      id: "b1",
      visibleIf: cond.rule("q1", "eq", 1),
      children: [
        { type: "page", id: "p1", questionIds: ["q2"] },
        { type: "page", id: "p2", questionIds: ["q3"] },
      ],
    },
  ]);
  assert.equal(pagesOf(def, { q1: 2 }).length, 1, "the whole block is skipped, not just one page");
  assert.equal(pagesOf(def, { q1: 1 }).length, 3, "and both of its pages return together");
});

test("a section does NOT lend its title to pages — only a block does", () => {
  // Sections group for reporting; changing that would alter existing surveys.
  const def = survey([
    {
      type: "section",
      id: "s1",
      title: "Screener",
      children: [{ type: "page", id: "p1", questionIds: ["q1"] }],
    },
  ]);
  const pages = pagesOf(def);
  assert.equal(pages[0].title, undefined, "no heading appears where none was authored");
  assert.deepEqual(pages[0].sectionPath, ["Screener"], "but the section still groups it");
});

test("a single-page block is unchanged — the legacy shape still compiles identically", () => {
  const def = survey([
    { type: "page", id: "p1", title: "Introduction", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3"] },
  ]);
  const pages = pagesOf(def);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].title, "Introduction");
  assert.equal(pages[1].title, undefined, "an untitled page outside a block gets no heading");
  assert.deepEqual(pages[0].sectionPath, [], "no block wrapper, no section path");
});

test("pages inside a block repeat per loop iteration, each scoped to the item", () => {
  const def = survey([
    { type: "page", id: "p0", questionIds: ["q1"] },
    {
      type: "loop",
      id: "l1",
      source: { kind: "static", items: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }] },
      loopVar: "item",
      children: [
        {
          type: "block",
          id: "b1",
          title: "Per item",
          children: [
            { type: "page", id: "p1", questionIds: ["q2"] },
            { type: "page", id: "p2", questionIds: ["q3"] },
          ],
        },
      ],
    },
  ]);
  const pages = pagesOf(def);
  assert.equal(pages.length, 5, "p0 + 2 pages × 2 iterations");
  assert.deepEqual(
    pages.slice(1).map((p) => p.pageId),
    ["p1@a", "p2@a", "p1@b", "p2@b"],
    "each page is answered separately per iteration",
  );
  assert.equal(pages[1].title, "Per item", "the block heading still applies inside a loop");
});

test("breaking a block into pages does not change the question count", () => {
  const one = survey([{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }]);
  const two = survey([
    {
      type: "block",
      id: "b1",
      children: [
        { type: "page", id: "p1", questionIds: ["q1"] },
        { type: "page", id: "p2", questionIds: ["q2", "q3"] },
      ],
    },
  ]);
  assert.equal(countRespondentQuestions(one), 3);
  assert.equal(countRespondentQuestions(two), 3, "a break adds a page, never a question");
});
