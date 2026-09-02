import { test } from "node:test";
import assert from "node:assert/strict";
import { countRespondentQuestions, questionsPerPage } from "./index.js";

/**
 * The dashboard's question count. The same rule is implemented in SQL by
 * `rescript_question_count` (migration 0002), so these cases document the
 * contract both must satisfy.
 */

const q = (id: string, type = "single_select") => ({
  id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: "", options: [],
});

test("counts respondent-facing questions across every page", () => {
  const def = {
    questions: [
      ...["a", "b", "c"].map((x) => q(x)),
      ...["d", "e"].map((x) => q(x)),
      ...["f", "g", "h", "i"].map((x) => q(x)),
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["a", "b", "c"] },
      { type: "page", id: "p2", questionIds: ["d", "e"] },
      { type: "page", id: "p3", questionIds: ["f", "g", "h", "i"] },
    ],
  };
  assert.equal(countRespondentQuestions(def), 9);
  assert.deepEqual(
    questionsPerPage(def).map((p) => p.count),
    [3, 2, 4],
  );
});

test("page breaks are not questions", () => {
  // a page break IS a page — structure, never an entry in `questions`
  const def = {
    questions: [q("a"), q("b")],
    flow: [
      { type: "page", id: "p1", questionIds: ["a"] },
      { type: "page", id: "p2", questionIds: ["b"] },
    ],
  };
  assert.equal(countRespondentQuestions(def), 2, "two pages, two questions — not four");
});

test("display-only and derived elements are not questions", () => {
  const def = {
    questions: [
      q("intro", "html"),
      q("a"),
      q("hidden1", "hidden"),
      q("score", "calculated"),
      q("panel", "embedded_data"),
      q("b", "multi_select"),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["intro", "a", "hidden1", "score", "panel", "b"] }],
  };
  assert.equal(countRespondentQuestions(def), 2);
});

test("questions on no page do not count, but a survey with no flow still reports", () => {
  const placed = {
    questions: [q("a"), q("orphan")],
    flow: [{ type: "page", id: "p1", questionIds: ["a"] }],
  };
  assert.equal(countRespondentQuestions(placed), 1, "an unplaced question can never be shown");

  const noFlow = { questions: [q("a"), q("b")], flow: [] };
  assert.equal(countRespondentQuestions(noFlow), 2, "mid-build surveys report what is written");
});

test("pages nested in blocks, loops and branches are all counted", () => {
  const def = {
    questions: ["a", "b", "c", "d"].map((x) => q(x)),
    flow: [
      { type: "page", id: "p1", questionIds: ["a"] },
      {
        type: "section", id: "s1", children: [
          { type: "page", id: "p2", questionIds: ["b"] },
          { type: "loop", id: "l1", children: [{ type: "page", id: "p3", questionIds: ["c"] }] },
        ],
      },
      {
        type: "branch", id: "br1",
        branches: [{ when: null, children: [{ type: "page", id: "p4", questionIds: ["d"] }] }],
        otherwise: [],
      },
    ],
  };
  assert.equal(countRespondentQuestions(def), 4);
});

test("empty and malformed definitions return 0 rather than throwing", () => {
  assert.equal(countRespondentQuestions({ questions: [], flow: [] }), 0);
  assert.equal(countRespondentQuestions({}), 0);
  assert.equal(countRespondentQuestions(null), 0);
  assert.equal(countRespondentQuestions({ questions: [q("a")] }), 1);
});

test("adding and removing a question moves the count (req §20)", () => {
  const base = {
    questions: Array.from({ length: 32 }, (_, i) => q(`q${i}`)),
    flow: [{ type: "page", id: "p1", questionIds: Array.from({ length: 32 }, (_, i) => `q${i}`) }],
  };
  assert.equal(countRespondentQuestions(base), 32);

  const added = {
    questions: [...base.questions, q("q32")],
    flow: [{ type: "page", id: "p1", questionIds: [...base.flow[0].questionIds, "q32"] }],
  };
  assert.equal(countRespondentQuestions(added), 33);

  const removed = {
    questions: base.questions.slice(1),
    flow: [{ type: "page", id: "p1", questionIds: base.flow[0].questionIds.slice(1) }],
  };
  assert.equal(countRespondentQuestions(removed), 31);
});
