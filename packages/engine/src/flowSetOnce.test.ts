import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { start, advance, createResponseState, setAnswer } from "./index.js";

/*
 * Qualtrics' "set once" pattern (I2, 2026-11-27): a branch "if ED.X is empty" holds a page and an embedded-data
 * element that sets X. Running the element collapses the branch, its page included, so the steps behind the cursor
 * shrink — and the cursor, a number, pointed past the pages after it. Respondents skipped them.
 */
const def = SurveyDefinition.parse({
  meta: { id: "set-once", code: "SO", title: "Set once", version: "1" },
  questions: ["a", "b", "c", "d", "e"].map((x) => ({ id: x, code: x.toUpperCase(), variableName: x.toUpperCase(), type: "single_select", text: x, options: [{ code: "1", label: "One" }, { code: "2", label: "Two" }] })),
  flow: [
    { type: "page", id: "pa", questionIds: ["a"] },
    { type: "branch", id: "br", branches: [{ id: "arm", when: { type: "rule", source: { kind: "embedded", ref: "X" }, operator: "unanswered" }, children: [
      { type: "page", id: "pb", questionIds: ["b"] },
      { type: "embedded_data", id: "set", fields: [{ name: "X", source: "static", value: "done" }] },
    ] }], otherwise: [] },
    { type: "page", id: "pc", questionIds: ["c"] },
    { type: "page", id: "pd", questionIds: ["d"] },
    { type: "page", id: "pe", questionIds: ["e"] },
    { type: "end", id: "end", status: "complete" },
  ],
});
const pageOf = (n: ReturnType<typeof start>) => { const s = n.steps[n.stepIndex]; return s?.kind === "page" ? s.pageId : n.done ? `done:${n.endStatus}` : s?.kind; };

test("the page after a branch that switches itself off is shown, and every one after it", () => {
  const st = createResponseState(def, { seed: 1 });
  let nav = start(def, st, {});
  const seen: string[] = [];
  for (let i = 0; i < 10 && !nav.done; i++) {
    const s = nav.steps[nav.stepIndex];
    if (s?.kind !== "page") break;
    seen.push(s.pageId);
    for (const id of s.questionIds) setAnswer(def, st, id, "1", null);
    nav = advance(def, st, {}, { fromPageId: s.pageId });
  }
  assert.deepEqual(seen, ["pa", "pb", "pc", "pd", "pe"]);
  assert.equal(st.embedded.X, "done");
  assert.equal(pageOf(nav), "done:complete");
});

test("a second respondent who already has X skips the branch and nothing else", () => {
  const st = createResponseState(def, { seed: 1, embedded: { X: "preset" } });
  let nav = start(def, st, {});
  const seen: string[] = [];
  for (let i = 0; i < 10 && !nav.done; i++) {
    const s = nav.steps[nav.stepIndex];
    if (s?.kind !== "page") break;
    seen.push(s.pageId);
    for (const id of s.questionIds) setAnswer(def, st, id, "1", null);
    nav = advance(def, st, {}, { fromPageId: s.pageId });
  }
  assert.deepEqual(seen, ["pa", "pc", "pd", "pe"]);
});
