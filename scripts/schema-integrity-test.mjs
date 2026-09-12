/**
 * ONE SCHEMA, ONE ORDER, NO DEAD REFERENCES — browser suite.
 *
 * The architecture pass, proven where a programmer would meet it. Four
 * things that were each true independently and wrong together:
 *
 *   1. A TYPE CHANGE IS A SCHEMA CHANGE. Changing a question's type wrote
 *      two strings and left the rest of the question as it was, so a matrix
 *      that became an open end still carried rows, a scale, a row mask and a
 *      `minSelections`. Nothing rendered them; everything that reads the
 *      schema rather than the screen believed them. Now the change is
 *      computed first, shown in full, and applied only if approved.
 *
 *   2. THERE IS ONE QUESTION ORDER. Dragging rewrote the page's
 *      `questionIds` and left `def.questions` alone, so the Questions panel
 *      and the flow showed one order while every logic picker, the variable
 *      dictionary and the JSON showed another, permanently.
 *
 *   3. DELETING IS A CHANGE TO THE WHOLE SURVEY. Everything that pointed at
 *      a deleted question kept pointing at it, rendering as an unset row —
 *      so the rule read as unfinished rather than broken.
 *
 *   4. A LOGIC BUILDER SHOWS THE CURRENT SCHEMA. Opening it against a
 *      question whose type had changed offered the old type's operators and
 *      the old type's option codes.
 *
 * Needs the Studio on :3000 and the runtime on :3001 (AI_API_URL=fake:).
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;

const opts = (...codes) => codes.map((c) => ({ code: String(c), label: `Option ${c}`, flags: [] }));
const rows = (...codes) => codes.map((c) => ({
  code: String(c), label: `Row ${c}`, flags: [], validation: [], required: false,
}));
const base = (id, code, type, over = {}) => ({
  id, code, variableName: code, type, text: `${code} — a question`,
  options: [], rows: [], columns: [], validation: [], required: false,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], punches: [],
  ...over,
});

const openQuestion = async (qid) => {
  await h.goTab("Questions");
  await page.waitForSelector(`[data-qid="${qid}"]`);
  const selected = await page.$(`[data-qid="${qid}"].selected`);
  if (!selected) await page.click(`[data-qid="${qid}"] .qlist-item`);
  await page.waitForTimeout(250);
};

/* ================================================================ 1. type change */

console.log("\nA TYPE CHANGE IS A SCHEMA CHANGE — shown before it happens, complete when it does");
{
  const def = await h.readDef();
  def.questions = [
    base("q1", "Q1", "matrix_single", {
      variant: "matrix.likert",
      rows: rows("r1", "r2"),
      options: opts(1, 2, 3, 4, 5),
      rowMask: { expr: { kind: "ref", questionId: "q2", selection: "selected" }, action: "display", keepAlwaysShow: true },
      randomization: { enabled: true, scope: "rows", method: "shuffle" },
      settings: { readOnly: false, hidden: false, minSelections: 1, maxSelections: 3 },
    }),
    base("q2", "Q2", "multi_select", { options: opts(1, 2, 3) }),
  ];
  def.flow = [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);

  await openQuestion("q1");
  await page.waitForSelector('[data-testid="variant-switcher"]');

  /* --- the dialog appears, and says what it is going to do */
  /* the switcher lists one family at a time, so leaving a family IS the type
     change — the same `switchTo`, the same dialog */
  await page.selectOption('[data-testid="family-switcher"]', "text");
  await page.waitForSelector('[data-testid="type-change-dialog"]');
  const models = await page.$eval('[data-testid="type-change-models"]', (e) => e.innerText.replace(/\s+/g, " "));
  assert.match(models, /one answer per row/, `it names the shape it is leaving: ${models}`);
  assert.match(models, /text/, `and the shape it is going to: ${models}`);

  const removedText = await page.$eval('[data-testid="type-change-removed"]', (e) => e.innerText);
  for (const phrase of ["2 rows", "5 options", "Row masking", "Randomization", "Minimum selections", "Maximum selections"]) {
    assert.ok(removedText.includes(phrase),
      `the list names ${phrase} — nothing goes without being shown. Got:\n${removedText}`);
  }

  /* --- cancel changes nothing at all */
  await page.click('[data-testid="type-change-cancel"]');
  await page.waitForTimeout(200);
  let now = await h.readDef();
  let q1 = now.questions.find((q) => q.id === "q1");
  assert.equal(q1.type, "matrix_single", "cancel means cancel");
  assert.equal(q1.rows.length, 2);
  assert.equal(q1.options.length, 5);
  assert.ok(q1.rowMask, "and nothing was quietly applied behind the dialog");

  /* --- confirm applies exactly what was listed */
  await openQuestion("q1");
  await page.selectOption('[data-testid="family-switcher"]', "text");
  await page.waitForSelector('[data-testid="type-change-dialog"]');
  await page.click('[data-testid="type-change-confirm"]');
  await page.waitForTimeout(400);

  now = await h.readDef();
  q1 = now.questions.find((q) => q.id === "q1");
  assert.equal(q1.type, "open_text", "the type changed");
  assert.deepEqual(q1.rows, [], "and so did the schema: no rows");
  assert.deepEqual(q1.options, [], "no scale");
  assert.equal(q1.rowMask, undefined, "no mask over rows that do not exist");
  assert.equal(q1.randomization, undefined, "no randomization of a list that is gone");
  assert.equal(q1.settings.minSelections, undefined, "and no selection bounds on an open end");
  assert.equal(q1.settings.maxSelections, undefined);
  assert.equal(q1.text, "Q1 — a question", "what the question ASKS is never touched by a type change");
  assert.equal(q1.variableName, "Q1");
}

console.log("\nA CONVERSION THAT LOSES NOTHING ASKS NOTHING");
{
  await openQuestion("q2");
  await page.selectOption('[data-testid="variant-switcher"]', "multi_select.buttons");
  await page.waitForTimeout(350);
  assert.equal(await page.$('[data-testid="type-change-dialog"]'), null,
    "a rendering choice within one response model is not a decision to put to somebody");
  const now = await h.readDef();
  assert.equal(now.questions.find((q) => q.id === "q2").options.length, 3, "and it kept its options");
}

console.log("\nOPTIONS BECOME FIELDS RATHER THAN BEING RETYPED");
{
  const def = await h.readDef();
  def.questions = [base("q5", "Q5", "single_select", { options: opts("a", "b", "c") })];
  def.flow = [{ type: "page", id: "p1", questionIds: ["q5"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);
  await openQuestion("q5");
  await page.selectOption('[data-testid="family-switcher"]', "list");
  await page.waitForSelector('[data-testid="type-change-dialog"]');
  const moved = await page.$eval('[data-testid="type-change-transformed"]', (e) => e.innerText);
  assert.match(moved, /3 options became 3 rows/, `the list travels, and says so: ${moved}`);
  await page.click('[data-testid="type-change-confirm"]');
  await page.waitForTimeout(400);
  const now = await h.readDef();
  const q5 = now.questions.find((q) => q.id === "q5");
  assert.deepEqual(q5.rows.map((r) => r.code), ["a", "b", "c"], "codes and labels are the ones authored");
  assert.deepEqual(q5.options, []);
}

/* ================================================== 2. one question order */

console.log("\nONE QUESTION ORDER — the flow decides, and the array follows");
{
  const def = await h.readDef();
  def.questions = [
    base("qa", "QA", "single_select", { options: opts(1, 2) }),
    base("qb", "QB", "single_select", { options: opts(1, 2) }),
    base("qc", "QC", "single_select", { options: opts(1, 2) }),
  ];
  /* the page asks them in a different order from the array — exactly the
     state dragging used to leave behind */
  def.flow = [{ type: "page", id: "p1", questionIds: ["qc", "qa", "qb"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);

  const now = await h.readDef();
  assert.deepEqual(now.questions.map((q) => q.code), ["QC", "QA", "QB"],
    "loading a definition puts the questions in the order the survey asks them");

  /* and the panels agree, because there is nothing left for them to disagree about */
  await h.goTab("Questions");
  await page.waitForSelector('[data-qid="qc"]');
  const onScreen = await page.$$eval(".qcard .mono", (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(onScreen, ["QC", "QA", "QB"], "the Questions panel reads in flow order");

  await h.goTab("Variables");
  await page.waitForTimeout(400);
  const dictOrder = await page.$$eval("table tbody tr td:first-child", (els) =>
    els.map((e) => e.textContent.trim()).filter((t) => ["QA", "QB", "QC"].includes(t)));
  assert.deepEqual(dictOrder.slice(0, 3), ["QC", "QA", "QB"],
    `the variable dictionary reads in the same order, so the export does too: ${dictOrder.join(", ")}`);
}

/* =========================================== 3. the logic builder is current */

console.log("\nA LOGIC BUILDER LOADS THE CURRENT SCHEMA, NOT THE ONE THE RULE WAS WRITTEN AGAINST");
{
  const def = await h.readDef();
  def.questions = [
    base("qs", "QS", "multi_select", { options: opts(1, 2, 3) }),
    base("qt", "QT", "open_text", {
      displayLogic: { type: "group", op: "and", children: [
        { type: "rule", source: { kind: "question", ref: "qs" }, operator: "containsAny", value: ["1"] },
      ] },
    }),
  ];
  def.flow = [{ type: "page", id: "p1", questionIds: ["qs", "qt"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);

  /* retype the source: a list of codes becomes a number */
  await openQuestion("qs");
  await page.selectOption('[data-testid="family-switcher"]', "numeric");
  await page.waitForSelector('[data-testid="type-change-dialog"]');
  await page.click('[data-testid="type-change-confirm"]');
  await page.waitForTimeout(400);

  /* the rule on QT still says "contains any of" — an operator a number
     cannot take. The builder must SAY so rather than render it as ordinary. */
  await openQuestion("qt");
  /* the properties panel remembers which sections a person left open, so the
     suite opens the one it is about to read rather than assuming */
  if (!(await page.$('[data-testid="psec-body-display-logic"]'))) {
    await page.click('[data-testid="psec-head-display-logic"]');
    await page.waitForTimeout(300);
  }
  await page.waitForSelector('.op-select[data-stale="1"]', { timeout: 8000 });
  const staleLabel = await page.$eval('.op-select[data-stale="1"]', (e) => e.selectedOptions[0].textContent);
  assert.match(staleLabel, /not available for this question/,
    `the saved operator is labelled for what it is: ${staleLabel}`);
  assert.ok(await page.$('[data-testid="fix-operator"]'), "and there is one click that repairs it");

  await page.click('[data-testid="fix-operator"]');
  await page.waitForTimeout(350);
  assert.equal(await page.$('.op-select[data-stale="1"]'), null, "fixed");
  const after = await h.readDef();
  /* the editor canonicalises as it saves, so a lone rule may no longer be
     wrapped in a group — the assertion is about the OPERATOR, not the shape */
  const dl = after.questions.find((q) => q.id === "qt").displayLogic;
  const rule = dl.type === "group" ? dl.children[0] : dl;
  const NUMERIC_OK = ["answered", "unanswered", "isEmpty", "isNotEmpty", "eq", "ne",
    "gt", "gte", "lt", "lte", "between", "notBetween", "in", "notIn"];
  assert.ok(NUMERIC_OK.includes(rule.operator),
    `the stored rule now holds an operator a number can take: ${rule.operator}`);
  assert.ok(rule.operator !== "containsAny", "and not the one that could never resolve");
}

/* ========================================= 4. deleting prunes, and says what */

console.log("\nDELETING A QUESTION CLEANS UP AFTER ITSELF — after showing what it will break");
{
  const def = await h.readDef();
  def.questions = [
    base("qx", "QX", "multi_select", { options: opts(1, 2, 3) }),
    base("qy", "QY", "open_text", {
      displayLogic: { type: "group", op: "and", children: [
        { type: "rule", source: { kind: "question", ref: "qx" }, operator: "containsAny", value: ["1"] },
      ] },
    }),
    base("qz", "QZ", "single_select", {
      options: opts(1, 2),
      carryForward: { sourceQuestionId: "qx", filter: "selected", into: "options", keepOwn: false },
      punches: [{
        id: "pu1", source: { kind: "ref", questionId: "qx", selection: "selected" },
        action: "select", mapping: [], ignoreUnmatched: true, recompute: "once",
      }],
    }),
  ];
  def.flow = [{ type: "page", id: "p1", questionIds: ["qx", "qy", "qz"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);

  const pressDelete = async () => {
    await openQuestion("qx");
    await page.click('[data-qid="qx"] [data-testid="delete-question"]');
    await page.waitForSelector('[data-testid="delete-question-dialog"]');
  };
  await pressDelete();

  const listed = await page.$eval('[data-testid="delete-question-dialog"]', (e) => e.innerText);
  assert.ok(listed.includes("QY"), `it names the question whose display logic goes: ${listed}`);
  assert.ok(listed.includes("QZ"), "and the one whose carry-forward and punch go");
  assert.ok(/always be shown/.test(listed),
    "and says what the survey will now DO, which is the part that matters");
  assert.ok(await page.$('[data-testid="delete-refs-warning"]'), "prominently");

  /* cancel leaves everything exactly as it was */
  await page.click('[data-testid="delete-question-cancel"]');
  await page.waitForTimeout(250);
  let now = await h.readDef();
  assert.equal(now.questions.length, 3, "cancel means cancel");
  assert.ok(now.questions.find((q) => q.id === "qy").displayLogic);

  /* confirm removes the question AND everything that pointed at it */
  await pressDelete();
  await page.click('[data-testid="delete-question-confirm"]');
  await page.waitForTimeout(500);

  now = await h.readDef();
  assert.equal(now.questions.find((q) => q.id === "qx"), undefined, "the question is gone");
  const qy = now.questions.find((q) => q.id === "qy");
  const qz = now.questions.find((q) => q.id === "qz");
  assert.equal(qy.displayLogic, undefined, "a rule that could never resolve again is not left standing");
  assert.equal(qz.carryForward, undefined, "nor a carry-forward from nothing");
  assert.deepEqual(qz.punches, [], "nor a punch with no source");
  assert.deepEqual(now.flow[0].questionIds, ["qy", "qz"], "and it comes off its page");

  const serialised = JSON.stringify(now);
  assert.ok(!serialised.includes('"qx"'), "no dead id survives anywhere in the definition");

  /* one undo step, not three */
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  const back = await h.readDef();
  assert.equal(back.questions.length, 3, "undo brings the question back");
  assert.ok(back.questions.find((q) => q.id === "qy").displayLogic,
    "and the logic with it — the cleanup was part of the same edit");
}

/* ================================= 5. what an older survey is still carrying */

console.log("\nCONFIGURATION FROM AN EARLIER TYPE IS REPORTED, NOT HIDDEN");
{
  const def = await h.readDef();
  /* a definition written before type changes migrated anything: an open end
     still holding a matrix's rows, a scale and a selection bound */
  def.questions = [base("ql", "QL", "open_text", {
    options: opts(1, 2, 3),
    rows: rows("r1", "r2"),
    settings: { readOnly: false, hidden: false, minSelections: 2 },
  })];
  def.flow = [{ type: "page", id: "p1", questionIds: ["ql"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);

  await openQuestion("ql");
  await page.waitForSelector('[data-testid="stale-fields"]');
  const banner = await page.$eval('[data-testid="stale-fields"]', (e) => e.innerText);
  for (const phrase of ["3 options", "2 rows", "Minimum selections"]) {
    assert.ok(banner.includes(phrase), `it says exactly what is there: ${phrase}\n${banner}`);
  }

  await page.click('[data-testid="stale-fields-clear"]');
  await page.waitForTimeout(450);
  const now = await h.readDef();
  const ql = now.questions.find((q) => q.id === "ql");
  assert.deepEqual(ql.options, []);
  assert.deepEqual(ql.rows, []);
  assert.equal(ql.settings.minSelections, undefined);
  assert.equal(ql.text, "QL — a question", "cleaning up removes what nothing reads, and nothing else");

  await openQuestion("ql");
  assert.equal(await page.$('[data-testid="stale-fields"]'), null, "and the banner goes with it");
}

/* ============================================ 6. the runtime sees the same thing */

console.log("\nTHE RUNTIME AGREES WITH THE SCHEMA IT WAS GIVEN");
{
  const def = await h.readDef();
  def.questions = [
    base("qr", "QR", "single_select", { options: opts(1, 2, 3) }),
  ];
  def.flow = [{ type: "page", id: "p1", questionIds: ["qr"] }, { type: "end", id: "e1", status: "complete" }];
  await h.loadDef(def);

  await openQuestion("qr");
  await page.selectOption('[data-testid="family-switcher"]', "text");
  await page.waitForSelector('[data-testid="type-change-dialog"]');
  await page.click('[data-testid="type-change-confirm"]');
  await page.waitForTimeout(400);

  const pv = await h.preview(["qr"]);
  await pv.waitForSelector('[data-qid="qr"]');
  const radios = await pv.$$('[data-qid="qr"] input[type="radio"]');
  assert.equal(radios.length, 0, "the options are not offered, because they are not there");
  await pv.fill('[data-qid="qr"] input[type="text"], [data-qid="qr"] textarea', "typed");
  await pv.waitForTimeout(200);
  assert.equal(await h.answerOf(pv, "qr"), "typed", "and a text answer lands as a text answer");
  await pv.close();
}

console.log("\nALL SCHEMA-INTEGRITY CHECKS PASSED");
await h.close();
