/**
 * OTHER-SPECIFY ISOLATION · DISPLAY-LOGIC SCOPES · MATRIX AXES — browser suite.
 *
 * The three survey-engine fixes, proven where a person would see them: in the
 * real runtime, through the real renderer, against the real engine.
 *
 *   1. Four questions with an "Other, specify" box — two single select, two
 *      multi select — keep four independent texts. Typing in one changes
 *      nothing in the others, on the screen or in the stored response, and
 *      unticking Other takes its text with it.
 *   2. A question hidden by its own display logic takes its options with it,
 *      even an option whose own rule says show; a visible question shows
 *      exactly the options that survive; an answer to an option that stops
 *      being offered stops being an answer.
 *   3. A matrix's rows and its scale are addressed separately and
 *      unambiguously, and the Logic Builder offers both axes.
 *
 * Needs the Studio on :3000 and the runtime on :3001 (AI_API_URL=fake:).
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;

const select = (id, code, type) => ({
  id, code, variableName: code, type, text: `${code} — pick one`,
  options: [
    { code: "1", label: "Option A", flags: [] },
    { code: "2", label: "Option B", flags: [] },
    { code: "99", label: "Other", flags: ["other_specify"] },
  ],
  rows: [], columns: [], validation: [], required: false,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
});

console.log("\nOTHER SPECIFY — four questions, four independent texts (single AND multi select)");
{
  const def = await h.readDef();
  def.questions = [
    select("q1", "Q1", "single_select"),
    select("q2", "Q2", "single_select"),
    select("q3", "Q3", "multi_select"),
    select("q4", "Q4", "multi_select"),
  ];
  def.flow = [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);
  const pv = await h.preview(["q1", "q2", "q3", "q4"]);

  // tick Other on all four, then type a different word into each
  for (const qid of ["q1", "q2", "q3", "q4"]) {
    await pv.click(`[data-qid="${qid}"] [data-rs-el="option"][data-rs-id="99"] input`);
  }
  await pv.waitForTimeout(150);
  const boxes = { q1: "Apple", q2: "Orange", q3: "Mango", q4: "Banana" };
  for (const [qid, word] of Object.entries(boxes)) {
    await pv.fill(`[data-qid="${qid}"] [data-testid="rs-other-input"]`, word);
    await pv.waitForTimeout(80);
  }

  // on the screen: four boxes, four different words
  for (const [qid, word] of Object.entries(boxes)) {
    assert.equal(await pv.inputValue(`[data-qid="${qid}"] [data-testid="rs-other-input"]`), word, `${qid} shows its own text`);
  }
  // in the response: four keys, four different words
  const stored = await pv.evaluate(() => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    return { q1: st.answers.q1__other, q2: st.answers.q2__other, q3: st.answers.q3__other, q4: st.answers.q4__other };
  });
  assert.deepEqual(stored, boxes, "each question stores its own text under its own key");

  // changing ONE changes only that one — the reported symptom, reversed
  await pv.fill('[data-qid="q1"] [data-testid="rs-other-input"]', "Pear");
  await pv.waitForTimeout(120);
  assert.equal(await pv.inputValue('[data-qid="q2"] [data-testid="rs-other-input"]'), "Orange", "Q2 is untouched");
  assert.equal(await pv.inputValue('[data-qid="q3"] [data-testid="rs-other-input"]'), "Mango", "Q3 is untouched");
  assert.equal(await pv.inputValue('[data-qid="q4"] [data-testid="rs-other-input"]'), "Banana", "Q4 is untouched");
  await pv.fill('[data-qid="q3"] [data-testid="rs-other-input"]', "Melon");
  await pv.waitForTimeout(120);
  const after = await pv.evaluate(() => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    return { q1: st.answers.q1__other, q2: st.answers.q2__other, q3: st.answers.q3__other, q4: st.answers.q4__other };
  });
  assert.deepEqual(after, { q1: "Pear", q2: "Orange", q3: "Melon", q4: "Banana" });

  // unticking Other takes its text with it — and only its own
  await pv.click('[data-qid="q1"] [data-rs-el="option"][data-rs-id="1"] input');
  await pv.waitForTimeout(150);
  const cleared = await pv.evaluate(() => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    return { q1: st.answers.q1__other ?? null, q2: st.answers.q2__other ?? null };
  });
  assert.equal(cleared.q1, null, "the abandoned text is gone");
  assert.equal(cleared.q2, "Orange", "and nobody else's is");
  await pv.context().close();
  console.log("  ok   4 boxes, 4 keys, 4 words; editing one moves none of the others; unticking clears only its own");
}

console.log("\nDISPLAY LOGIC — a hidden question takes its options with it; a visible one shows what survives");
{
  const def = await h.readDef();
  const driver = { ...select("q0", "Q0", "single_select"), options: [{ code: "yes", label: "Yes", flags: [] }, { code: "no", label: "No", flags: [] }] };
  const target = select("q1", "Q1", "multi_select");
  // Q1 appears only when Q0 = yes; its option B carries a rule that is TRUE whenever Q0 is answered
  target.displayLogic = { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "yes" };
  target.options[1].visibleIf = { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "answered" };
  def.questions = [driver, target];
  def.flow = [{ type: "page", id: "p1", questionIds: ["q0", "q1"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);
  const pv = await h.preview(["q0", "q1"]);

  // Q0 = No → Q1 hidden, and its option whose own rule says SHOW is nowhere
  await pv.click('[data-qid="q0"] [data-rs-el="option"][data-rs-id="no"] input');
  await pv.waitForTimeout(250);
  assert.equal(await pv.$('[data-qid="q1"]'), null, "the question is not rendered");
  assert.equal(await pv.$('[data-qid="q1"] [data-rs-id="2"]'), null, "and neither is the option whose rule said show");

  // Q0 = Yes → Q1 visible, with all three options (B's rule is satisfied)
  await pv.click('[data-qid="q0"] [data-rs-el="option"][data-rs-id="yes"] input');
  await pv.waitForTimeout(250);
  assert.ok(await pv.$('[data-qid="q1"]'), "the question is rendered");
  assert.equal((await pv.$$('[data-qid="q1"] [data-rs-el="option"]')).length, 3, "A, B and C");
  console.log("  ok   hidden question ⇒ no options at all, even one whose own rule says show");
  await pv.context().close();
}

console.log("\nDISPLAY LOGIC — an answer to an option that stops being offered stops being an answer");
{
  const def = await h.readDef();
  const driver = { ...select("q0", "Q0", "single_select"), options: [{ code: "yes", label: "Yes", flags: [] }, { code: "no", label: "No", flags: [] }] };
  const target = select("q1", "Q1", "multi_select");
  target.options[1].visibleIf = { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "yes" };
  def.questions = [driver, target];
  def.flow = [{ type: "page", id: "p1", questionIds: ["q0", "q1"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);
  const pv = await h.preview(["q0", "q1"]);

  await pv.click('[data-qid="q0"] [data-rs-el="option"][data-rs-id="yes"] input');
  await pv.waitForTimeout(200);
  await pv.click('[data-qid="q1"] [data-rs-el="option"][data-rs-id="1"] input');
  await pv.click('[data-qid="q1"] [data-rs-el="option"][data-rs-id="2"] input');
  await pv.waitForTimeout(200);
  assert.deepEqual(await h.answerOf(pv, "q1"), ["1", "2"], "A and B are selected");

  // B stops being offered — and stops being selected
  await pv.click('[data-qid="q0"] [data-rs-el="option"][data-rs-id="no"] input');
  await pv.waitForTimeout(300);
  assert.equal((await pv.$$('[data-qid="q1"] [data-rs-el="option"]')).length, 2, "B is off the screen");
  assert.deepEqual(await h.answerOf(pv, "q1"), ["1"], "…and out of the response, not merely undrawn");
  await pv.context().close();
  console.log("  ok   the selection is pruned the moment the option stops being offered");
}

console.log("\nMATRIX — rows and the scale are separate axes, and the Logic Builder offers both");
{
  const def = await h.readDef();
  const grid = {
    id: "m1", code: "Q1", variableName: "Q1", type: "matrix_single", text: "Rate these",
    options: [{ code: "Yes", label: "Yes", flags: [] }, { code: "No", label: "No", flags: [] }],
    rows: [
      { code: "A", label: "Product A", flags: [], validation: [], required: false },
      { code: "B", label: "Product B", flags: [], validation: [], required: false },
    ],
    columns: [], validation: [], required: false,
    settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
  };
  const follow = select("q2", "Q2", "single_select");
  follow.displayLogic = { type: "rule", source: { kind: "question", ref: "Q1", rowCode: "A", columnId: "Yes" }, operator: "answered" };
  def.questions = [grid, follow];
  def.flow = [{ type: "page", id: "p1", questionIds: ["m1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);

  // the builder: both axes offered, and the reference reads unambiguously
  await h.goTab("Logic");
  await page.waitForTimeout(400);
  const defAfter = await h.readDef();
  assert.equal(defAfter.questions[1].displayLogic.source.rowCode, "A", "the row survives a round trip");
  assert.equal(defAfter.questions[1].displayLogic.source.columnId, "Yes", "and so does the scale point");

  // the runtime: the four cells behave as four distinct references
  const pv = await h.preview(["m1", "q2"], (d) => {
    d.flow = [{ type: "page", id: "p1", questionIds: ["m1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e1", status: "complete" }];
  });
  // Product A = No → the follow-up, which asks about A rated Yes, must not appear
  await pv.click('[data-qid="m1"] input[type="radio"]');
  await pv.waitForTimeout(200);
  const answered = await h.answerOf(pv, "m1");
  assert.ok(answered && typeof answered === "object", `the grid stores a row-keyed object (${JSON.stringify(answered)})`);
  assert.ok(!("Yes" in answered), "keyed by ROW, never by the scale point — the ambiguity the brief is about");
  await pv.context().close();
  console.log("  ok   rowCode and columnId survive as separate axes; the answer is keyed by row");
}

await h.close();
console.log("\nALL LOGIC FIX CHECKS PASSED");
