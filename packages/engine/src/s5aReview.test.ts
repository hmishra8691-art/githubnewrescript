import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { reviewSummary, reviewConfig, formatReviewAnswer, reviewPages, lintReviewPages } from "./reviewPage.js";
import { start, advance, compileFlow, setAnswer } from "./flow.js";
import { createResponseState } from "./state.js";
import { goToPage } from "./sectionNav.js";

/* S5a item 5 (AQ-12): review-your-answers page */

const def = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  let d = applySurveyActions(empty, [
    { op: "create_block", title: "About you" },
    { op: "create_question", type: "single", text: "Your age group?", options: ["18-34", "35+"] },
    { op: "create_question", type: "long_text", text: "Why?" },
    { op: "create_block", title: "Brands" },
    { op: "create_question", type: "multi", text: "Brands used?", options: ["Acme", "Beta", "Gamma"] },
  ] as SurveyAction[]).def;
  const c = coerceSurveyActions([{ op: "set_review_page", add: true, title: "Check your answers", textLimit: 20 }]);
  assert.equal(c.rejected.length, 0, JSON.stringify(c.rejected));
  const r = applySurveyActions(d, c.actions);
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  d = r.def;
  return d;
})();

test("set_review_page add: a new page at the end of the last block with a text block, flagged review", () => {
  const ids = reviewPages(def);
  assert.equal(ids.length, 1);
  const cfg = reviewConfig(def, ids[0])!;
  assert.equal(cfg.title, "Check your answers");
  assert.equal(cfg.textLimit, 20);
  assert.deepEqual(lintReviewPages(def), []);
  assert.ok(SurveyDefinition.safeParse(def).success);
});

test("answers formatted as labels; long text cut with …", () => {
  const [age, why, brands] = def.questions;
  assert.equal(formatReviewAnswer(age, 2).text, "35+");
  assert.equal(formatReviewAnswer(brands, [1, 3]).text, "Acme, Gamma");
  const long = formatReviewAnswer(why, "a".repeat(50), 20);
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 21);
  assert.equal(formatReviewAnswer(why, null).text, "—");
});

function walkTo(reviewId: string) {
  const [age, why, brands] = def.questions;
  const st = createResponseState(def);
  start(def, st);
  for (let i = 0; i < 12; i++) {
    const cur = compileFlow(def, st, {})[st.stepIndex] as { kind: string; pageId: string; };
    if (!cur || cur.kind !== "page" || cur.pageId === reviewId) break;
    const qids = (def.flow.flatMap((n) => ((n as { children?: { id: string; questionIds?: string[] }[] }).children ?? [])).find((p) => p.id === cur.pageId)?.questionIds) ?? [];
    if (qids.includes(age.id)) setAnswer(def, st, age.id, 1, null);
    if (qids.includes(why.id)) setAnswer(def, st, why.id, "Because I like long explanations very much", null);
    if (qids.includes(brands.id)) setAnswer(def, st, brands.id, [2], null);
    const nav = advance(def, st, {}, { fromPageId: cur.pageId });
    if (nav.done) break;
  }
  return st;
}

test("the summary: visited pages before the review page, grouped by section, hidden questions never listed", () => {
  const reviewId = reviewPages(def)[0];
  const state = walkTo(reviewId);
  const groups = reviewSummary(def, state, reviewId);
  assert.deepEqual(groups.map((g) => g.title), ["About you", "Brands"]);
  const items = groups.flatMap((g) => g.items);
  assert.equal(items.find((i) => i.text === "Your age group?")?.answer, "18-34");
  assert.equal(items.find((i) => i.text === "Why?")?.truncated, true);
  assert.equal(items.some((i) => /check your answers/i.test(i.text)), false, "the review page's own text block is not listed");
  /* a hidden question is never listed */
  const hidden = structuredClone(def);
  hidden.questions[0].settings.hidden = true;
  assert.equal(reviewSummary(hidden, state, reviewId).flatMap((g) => g.items).some((i) => i.text === "Your age group?"), false);
});

test("Change jumps back (visited pages, Back's semantics) and Return comes forward again (mode visited)", () => {
  const reviewId = reviewPages(def)[0];
  const state = walkTo(reviewId);
  const ageItem = reviewSummary(def, state, reviewId)[0].items[0];
  const back = goToPage(def, state, ageItem.pageId, {}, {}, { as: "page" });
  assert.equal(back.ok, true, back.reason);
  assert.equal(back.via, "back");
  const forwardOff = goToPage(def, structuredClone(state), reviewId, {}, {}, { as: "page" });
  assert.equal(forwardOff.ok, false, "with section navigation off, only the review's own return may go forward");
  const ret = goToPage(def, state, reviewId, {}, {}, { as: "page", mode: "visited" });
  assert.equal(ret.ok, true, ret.reason);
  const steps = compileFlow(def, state, {});
  assert.equal((steps[state.stepIndex] as { pageId: string }).pageId, reviewId);
});
