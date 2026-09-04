/**
 * Date/Time, Dynamic, Gamified, Experimental and Conversational variant
 * families (11 variants): created from the picker, authored in Studio,
 * rendered in the runtime, answered with mouse AND keyboard, and the answer
 * checked against the response model the base type promises.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const made = {};
const sideOf = (pv, id, suffix) => h.answerOf(pv, `${id}__${suffix}`);
const statusOf = (pv) => pv.evaluate(() => window.__rescriptState?.status);

/* ================================================== 1. picker: all 11 stable */
const PICK = [
  ["datetime", "datetime.calendar", "calendar"],
  ["datetime", "datetime.month_year", "month_year"],
  ["dynamic", "dynamic.adaptive", "adaptive"],
  ["gamified", "gamified.quiz", "quiz"],
  ["gamified", "gamified.timed", "timed"],
  ["gamified", "gamified.matching", "matching"],
  ["experimental", "experimental.attention_check", "attention"],
  ["experimental", "experimental.reaction_time", "iat"],
  ["experimental", "experimental.ab", "ab"],
  ["experimental", "experimental.stimulus", "stimulus"],
  ["conversational", "conversational.chat_based_question", "chat"],
];
for (const [family, variantId, key] of PICK) {
  made[key] = await h.createFromPicker(family, variantId);
}
console.log(`✔ all ${PICK.length} variants are stable in the picker and create with their variant id`);

/* the deferred siblings must stay greyed out */
await h.goTab("Questions");
await h.page.click('[data-testid="add-question-top"]');
for (const [family, id] of [
  ["dynamic", "dynamic.respondent_specific_options"],
  ["conversational", "conversational.voice_survey"],
  ["conversational", "conversational.adaptive_conversation"],
]) {
  await h.page.click(`[data-testid="picker-family-${family}"]`);
  const card = await h.page.waitForSelector(`[data-testid="picker-variant-${id}"]`);
  assert.equal(await card.getAttribute("data-status"), "planned", `${id} stays "coming soon"`);
}
await h.page.click('.modal-back .btn:has-text("close")');
await h.page.waitForSelector(".modal-back", { state: "detached" });
console.log("✔ the three deferred variants (APIs / speech / LLM) are still coming soon");

/* ------------------------------------------------ base types + seeded defaults */
assert.equal(made.calendar.type, "date");
assert.equal(made.month_year.type, "date");
assert.equal(made.adaptive.type, "single_select");
assert.equal(made.quiz.type, "single_select");
assert.equal(made.timed.type, "single_select");
assert.equal(made.matching.type, "matrix_single");
assert.equal(made.attention.type, "single_select");
assert.equal(made.iat.type, "matrix_single");
assert.equal(made.ab.type, "experiment");
assert.equal(made.stimulus.type, "experiment");
assert.equal(made.chat.type, "matrix_text");
assert.deepEqual(made.calendar.settings.timeSlots, ["09:00", "10:30", "13:00", "14:30", "16:00"]);
assert.deepEqual(made.calendar.settings.disabledWeekdays, [0, 6]);
assert.equal(made.quiz.options.find((o) => o.meta?.correct)?.code, 1, "the quiz seeds one correct answer");
assert.equal(made.timed.settings.timeLimitSeconds, 10);
assert.equal(made.matching.rows.length, 3);
assert.equal(made.matching.rows[0].meta.answer, "a1", "matching seeds an answer key");
assert.deepEqual(made.attention.settings.expectedCodes, [3]);
assert.equal(made.iat.rows.length, 4);
assert.equal(made.ab.settings.arms.length, 2);
assert.equal(made.stimulus.settings.arms.length, 3);
assert.equal(made.chat.rows.length, 3);
console.log("✔ base types and seeded defaults are right");

/* ============================================ 2. Studio: the settings blocks */

/** Open the editor for a question by its id (the picker leaves the panel closed). */
const openEditor = async (qid) => {
  await h.goTab("Questions");
  await h.page.click('[data-testid="close-question"]').catch(() => {});
  const def = await h.readDef();
  const i = def.questions.findIndex((q) => q.id === qid);
  await h.goTab("Questions");
  const cards = await h.page.$$('[data-testid="qcard"]');
  await cards[i].click();
  await h.page.waitForTimeout(250);
};

/**
 * Read the stored question AND come back to its open editor. The harness reads
 * the definition through the JSON tab, which navigates away from the question
 * panel — every check that reads and then keeps clicking has to come back, or
 * it waits forever for a control that is no longer on screen.
 */
const readQ = async (qid) => {
  const def = await h.readDef();
  await openEditor(qid);
  return def.questions.find((q) => q.id === qid);
};

/* calendar: dates, closed weekdays, slots */
await openEditor(made.calendar.id);
await h.page.fill('[data-testid="cal-min-date"]', "2026-03-01");
await h.page.fill('[data-testid="cal-max-date"]', "2026-03-31");
await h.page.fill('[data-testid="cal-slots"]', "09:00, 10:30");
await h.page.waitForTimeout(300);
let def = await h.readDef();
const cq = def.questions.find((q) => q.id === made.calendar.id);
assert.equal(cq.settings.minDate, "2026-03-01");
assert.equal(cq.settings.maxDate, "2026-03-31");
assert.deepEqual(cq.settings.timeSlots, ["09:00", "10:30"]);
assert.deepEqual(cq.settings.disabledWeekdays, [0, 6], "the seeded closed weekends survive");
console.log("✔ Studio: calendar window, closed weekdays and time slots");

/* month/year: the year window */
await openEditor(made.month_year.id);
await h.page.fill('[data-testid="my-min-year"]', "2000");
await h.page.fill('[data-testid="my-max-year"]', "2030");
await h.page.waitForTimeout(300);
def = await h.readDef();
const myq = def.questions.find((q) => q.id === made.month_year.id);
assert.equal(myq.settings.minYear, 2000);
assert.equal(myq.settings.maxYear, 2030);
console.log("✔ Studio: month/year window");

/* quiz: the per-option "correct" checkbox and the explanation field */
await openEditor(made.quiz.id);
await h.page.waitForSelector('[data-testid="option-meta-correct-0"]');
await h.page.fill('[data-testid="option-meta-explanation-0"]', "Because it is.");
await h.page.waitForTimeout(300);
await h.page.click('[data-testid="option-meta-correct-1"]'); // mark B correct too
await h.page.waitForTimeout(300);
let qq = await readQ(made.quiz.id);
assert.equal(qq.options[0].meta.explanation, "Because it is.");
assert.equal(qq.options[1].meta.correct, true, "a second option can be marked correct");
await h.page.click('[data-testid="option-meta-correct-1"]'); // back to one right answer
await h.page.waitForTimeout(300);
qq = await readQ(made.quiz.id);
assert.ok(!qq.options[1].meta?.correct, "unticking removes the mark");
console.log("✔ Studio: quiz answer key + explanation write to option.meta");

/* timed: the clock */
await openEditor(made.timed.id);
await h.page.fill('[data-testid="timed-limit"]', "5");
await h.page.selectOption('[data-testid="timed-ontimeout"]', "advance");
await h.page.waitForTimeout(300);
const tq = await readQ(made.timed.id);
assert.equal(tq.settings.timeLimitSeconds, 5);
assert.equal(tq.settings.onTimeout, "advance");
await h.page.selectOption('[data-testid="timed-ontimeout"]', "lock");
await h.page.waitForTimeout(250);
console.log("✔ Studio: timed limit + on-timeout");

/* matching: the answer key table writes row.meta.answer */
await openEditor(made.matching.id);
await h.page.selectOption('[data-testid="matching-answer-r3"]', "a1");
await h.page.waitForTimeout(300);
const mq = await readQ(made.matching.id);
assert.equal(mq.rows[2].meta.answer, "a1", "the key table writes row.meta.answer");
await h.page.selectOption('[data-testid="matching-answer-r3"]', "a3");
await h.page.waitForTimeout(300);
console.log("✔ Studio: matching answer key");

/* attention check: expected codes, and terminate writes real skip logic */
await openEditor(made.attention.id);
await h.page.selectOption('[data-testid="attention-onfail"]', "terminate");
await h.page.waitForTimeout(350);
let aq = await readQ(made.attention.id);
assert.equal(aq.settings.onFail, "terminate");
const rule = aq.skipLogic.find((r) => r.id === "attention_fail");
assert.ok(rule, "choosing Terminate writes a skipLogic rule on the question");
assert.equal(rule.target.kind, "end");
assert.equal(rule.target.status, "terminated");
assert.equal(rule.when.op, "and", "the rule is answered AND notIn — an unanswered check must not terminate");
assert.deepEqual(rule.when.children.map((c) => c.operator), ["answered", "notIn"]);
assert.deepEqual(rule.when.children[1].value, ["3"]);
await h.page.click('[data-testid="attention-expected-4"]'); // expect 3 or 4
await h.page.waitForTimeout(350);
aq = await readQ(made.attention.id);
assert.deepEqual(
  aq.skipLogic.find((r) => r.id === "attention_fail").when.children[1].value,
  ["3", "4"], "changing the expected answers rewrites the rule",
);
await h.page.click('[data-testid="attention-expected-4"]');
await h.page.selectOption('[data-testid="attention-onfail"]', "flag");
await h.page.waitForTimeout(350);
aq = await readQ(made.attention.id);
assert.ok(!aq.skipLogic.some((r) => r.id === "attention_fail"), "switching back to Flag removes the rule");
console.log("✔ Studio: attention check expected answers + terminate writes/removes a skip rule");

/* experiment: the arms editor */
await openEditor(made.ab.id);
await h.page.fill('[data-testid="arm-weight-0"]', "0");
await h.page.fill('[data-testid="arm-weight-1"]', "100");
await h.page.fill('[data-testid="arm-html-1"]', "<p>Treatment copy <script>alert(1)</script></p>");
await h.page.click('[data-testid="arm-add"]');
await h.page.waitForTimeout(300);
let abq = await readQ(made.ab.id);
assert.equal(abq.settings.arms.length, 3, "an arm can be added");
assert.equal(abq.settings.arms[0].weight, 0);
assert.equal(abq.settings.arms[1].weight, 100);
await h.page.click('[data-testid="arm-remove-2"]');
await h.page.waitForTimeout(300);
abq = await readQ(made.ab.id);
assert.equal(abq.settings.arms.length, 2, "and removed again");
console.log("✔ Studio: experiment arms (code, label, weight, html, media) add/remove");

/* adaptive: alternatives with a condition editor */
await openEditor(made.adaptive.id);
await h.page.click('[data-testid="adaptive-add"]');
await h.page.waitForSelector('[data-testid="adaptive-alt-0"]');
await h.page.fill('[data-testid="adaptive-label-0"]', "Detractor");
await h.page.fill('[data-testid="adaptive-text-0"]', "What went wrong?");
await h.page.fill('[data-testid="adaptive-options-0"]', "9\tPrice\n8\tService");
await h.page.waitForTimeout(350);
const adq = await readQ(made.adaptive.id);
assert.equal(adq.settings.adaptive.length, 1, "an alternative is added");
assert.equal(adq.settings.adaptive[0].label, "Detractor");
assert.equal(adq.settings.adaptive[0].text, "What went wrong?");
assert.deepEqual(adq.settings.adaptive[0].options.map((o) => o.code), [9, 8]);
assert.ok(adq.settings.adaptive[0].when, "and it carries a condition tree");
console.log("✔ Studio: adaptive alternatives (condition, text, instruction, pasted options)");

/* chat: pacing */
await openEditor(made.chat.id);
await h.page.fill('[data-testid="chat-delay"]', "50");
await h.page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.questions.find((q) => q.id === made.chat.id).settings.chatDelayMs, 50);
console.log("✔ Studio: chat pacing");

await h.goTab("Questions");
await h.page.click('[data-testid="close-question"]').catch(() => {});

/* ==================================================== 3. runtime: the answers */

/* ------------------------------------------------------------------ calendar */
let pv = await h.preview([made.calendar.id]);
const cal = `[data-qid="${made.calendar.id}"]`;
assert.equal(await pv.textContent(`${cal} [data-testid="cal-month"]`), "March 2026",
  "the grid opens on the window's first month, not on today");
// 2026-03-01 is a Sunday and Sundays are closed
const sunday = await pv.$(`${cal} [data-day="2026-03-01"]`);
assert.ok(!!sunday, "the closed day is still shown");
assert.equal(await sunday.getAttribute("aria-disabled"), "true");
assert.ok(await sunday.isDisabled(), "a closed weekday cannot be clicked");
await sunday.click({ force: true }).catch(() => {});
assert.ok(!(await h.answerOf(pv, made.calendar.id)), "clicking a closed day stores nothing");
// out of the window
assert.ok(await pv.$(`${cal} [data-day="2026-03-31"]`), "the last day of the window is offered");
await pv.click(`${cal} [data-testid="cal-next"]`);
assert.equal(await pv.textContent(`${cal} [data-testid="cal-month"]`), "April 2026");
const april1 = await pv.$(`${cal} [data-day="2026-04-01"]`);
assert.ok(await april1.isDisabled(), "a day past maxDate is not selectable");
await pv.click(`${cal} [data-testid="cal-prev"]`);

await pv.click(`${cal} [data-day="2026-03-10"]`);
assert.ok(!(await h.answerOf(pv, made.calendar.id)),
  "with slots configured the day alone is not an appointment");
await pv.waitForSelector(`${cal} [data-slot="10:30"]`);
await pv.click(`${cal} [data-slot="10:30"]`);
assert.equal(await h.answerOf(pv, made.calendar.id), "2026-03-10T10:30",
  "day + slot stores YYYY-MM-DDTHH:mm");
assert.match(await pv.textContent(`${cal} [data-testid="cal-status"]`), /2026-03-10 at 10:30/);

// keyboard: focus a day, arrows move the focused day, Enter picks it
await pv.focus(`${cal} [data-day="2026-03-10"]`);
await pv.keyboard.press("ArrowRight");
await pv.waitForTimeout(80);
assert.equal(
  await pv.evaluate(() => document.activeElement?.getAttribute("data-day")),
  "2026-03-11", "ArrowRight moves the day focus",
);
await pv.keyboard.press("ArrowDown");
await pv.waitForTimeout(80);
assert.equal(
  await pv.evaluate(() => document.activeElement?.getAttribute("data-day")),
  "2026-03-18", "ArrowDown moves a week",
);
await pv.keyboard.press("Enter");
await pv.waitForTimeout(120);
await pv.click(`${cal} [data-slot="09:00"]`);
assert.equal(await h.answerOf(pv, made.calendar.id), "2026-03-18T09:00",
  "the keyboard picks a day just like the mouse");
console.log("✔ calendar: window + closed weekdays enforced, day+slot stores a datetime, arrows move focus");

// no slots configured → the day itself is the answer
await pv.close();
pv = await h.preview([made.calendar.id], (d) => {
  d.questions.find((q) => q.id === made.calendar.id).settings.timeSlots = undefined;
});
await pv.click(`${cal} [data-day="2026-03-11"]`);
assert.equal(await h.answerOf(pv, made.calendar.id), "2026-03-11", "without slots the day stores as YYYY-MM-DD");
await pv.close();

/* ---------------------------------------------------------------- month/year */
pv = await h.preview([made.month_year.id]);
const my = `[data-qid="${made.month_year.id}"]`;
await pv.selectOption(`${my} [data-testid="my-month"]`, "06");
assert.ok(!(await h.answerOf(pv, made.month_year.id)), "a month with no year is not a date");
await pv.selectOption(`${my} [data-testid="my-year"]`, "2020");
assert.equal(await h.answerOf(pv, made.month_year.id), "2020-06", "both halves store YYYY-MM");
assert.equal(await pv.textContent(`${my} [data-testid="my-value"]`), "June 2020");
const yearCount = await pv.$$eval(`${my} [data-testid="my-year"] option`, (o) => o.length);
assert.equal(yearCount, 32, "the year list honours minYear/maxYear (2000–2030 + placeholder)");
await pv.selectOption(`${my} [data-testid="my-month"]`, "");
assert.ok(!(await h.answerOf(pv, made.month_year.id)), "clearing half the date clears the answer");
await pv.close();
console.log("✔ month/year: stores YYYY-MM only once both selects are chosen");

/* ------------------------------------------------------------------ adaptive */
// a stem question the alternative's condition reads
const stem = await h.createFromPicker("single_select", "single_select.icon_select");
await h.setQuestion(stem.id, (q) => {
  q.options = [{ code: 1, label: "Promoter", flags: [] }, { code: 2, label: "Detractor", flags: [] }];
});
await h.setQuestion(made.adaptive.id, (q) => {
  q.settings.adaptive = [{
    label: "Detractor",
    when: { type: "rule", source: { kind: "question", ref: stem.id }, operator: "eq", value: 2 },
    text: "What went wrong?",
    instruction: "Pick the biggest problem.",
    options: [{ code: 9, label: "Price", flags: [] }, { code: 8, label: "Service", flags: [] }],
  }];
});
pv = await h.preview([stem.id, made.adaptive.id]);
const ad = `[data-qid="${made.adaptive.id}"]`;
assert.ok(!(await pv.$(`${ad} [data-testid="adaptive-text"]`)), "no alternative matches yet");
assert.ok(await pv.$(`${ad} [data-code="1"]`), "the authored options show");
await pv.click(`[data-qid="${stem.id}"] .rs-iconopt[data-code="2"]`);
await pv.waitForSelector(`${ad} [data-testid="adaptive-text"]`);
assert.equal(await pv.textContent(`${ad} [data-testid="adaptive-text"]`), "What went wrong?");
assert.equal(await pv.textContent(`${ad} [data-testid="adaptive-instruction"]`), "Pick the biggest problem.");
assert.ok(!(await pv.$(`${ad} [data-code="1"]`)), "the authored options are replaced");
await pv.click(`${ad} [data-code="9"]`);
assert.equal(await h.answerOf(pv, made.adaptive.id), 9, "the stored code comes from the substituted options");
// keyboard on the custom row
await pv.focus(`${ad} [data-code="8"]`);
await pv.keyboard.press("Enter");
assert.equal(await h.answerOf(pv, made.adaptive.id), 8, "Enter selects an adapted option");
// going back to the other stem answer restores the authored question
await pv.click(`[data-qid="${stem.id}"] .rs-iconopt[data-code="1"]`);
await pv.waitForTimeout(150);
assert.ok(!(await pv.$(`${ad} [data-testid="adaptive-text"]`)), "the authored stem returns");
assert.ok(await pv.$(`${ad} [data-code="1"]`));
await pv.close();
console.log("✔ adaptive: the first matching alternative replaces text, instruction and options");

/* ---------------------------------------------------------------------- quiz */
pv = await h.preview([made.quiz.id]);
const qz = `[data-qid="${made.quiz.id}"]`;
await pv.click(`${qz} [data-code="2"]`); // wrong
assert.equal(await h.answerOf(pv, made.quiz.id), 2);
assert.equal(await sideOf(pv, made.quiz.id, "correct"), 0, "a wrong answer records __correct 0");
await pv.waitForSelector(`${qz} [data-testid="quiz-verdict"].wrong`);
assert.ok(await pv.$(`${qz} [data-code="1"].right`), "the correct answer is highlighted");
assert.ok(await pv.$(`${qz} [data-code="2"].wrong`), "the wrong choice is marked");
assert.match(await pv.textContent(`${qz} [data-code="1"]`), /Because it is/, "the explanation shows");
// aria-disabled, so Playwright refuses an ordinary click — force it to prove
// the locked row really ignores one rather than merely looking unclickable
await pv.click(`${qz} [data-code="3"]`, { force: true });
await pv.waitForTimeout(120);
assert.equal(await h.answerOf(pv, made.quiz.id), 2, "with feedback shown the answer is locked");
await pv.close();

pv = await h.preview([made.quiz.id]); // a fresh respondent
await pv.click(`${qz} [data-code="1"]`);
assert.equal(await h.answerOf(pv, made.quiz.id), 1);
assert.equal(await sideOf(pv, made.quiz.id, "correct"), 1, "the right answer records __correct 1");
await pv.waitForSelector(`${qz} [data-testid="quiz-verdict"].right`);
await pv.close();

// feedback off: no lock, no reveal
pv = await h.preview([made.quiz.id], (d) => {
  d.questions.find((q) => q.id === made.quiz.id).settings.showFeedback = false;
});
await pv.click(`${qz} [data-code="2"]`);
await pv.click(`${qz} [data-code="1"]`);
assert.equal(await h.answerOf(pv, made.quiz.id), 1, "with feedback off the answer can be changed");
assert.equal(await sideOf(pv, made.quiz.id, "correct"), 1);
assert.ok(!(await pv.$(`${qz} [data-testid="quiz-verdict"]`)), "and nothing is revealed");
await pv.close();
console.log("✔ quiz: scores into __correct, reveals and locks (or not, per showFeedback)");

/* --------------------------------------------------------------------- timed */
pv = await h.preview([made.timed.id]);
const td = `[data-qid="${made.timed.id}"]`;
await pv.waitForSelector(`${td} [data-testid="timed-remaining"]`);
await pv.waitForTimeout(400); // so the recorded rt is unambiguously > 0
await pv.click(`${td} .rs-option:nth-child(2) input`);
assert.equal(await h.answerOf(pv, made.timed.id), 2);
const rt = await sideOf(pv, made.timed.id, "rt");
assert.ok(typeof rt === "number" && rt > 0, `__rt is a positive number of ms (got ${rt})`);
assert.equal(await sideOf(pv, made.timed.id, "timeout"), 0);
assert.equal(await pv.getAttribute(`${td} [data-testid="timed"]`, "data-expired"), "0");
await pv.close();

pv = await h.preview([made.timed.id], (d) => {
  d.questions.find((q) => q.id === made.timed.id).settings.timeLimitSeconds = 1;
});
await pv.waitForSelector(`${td} [data-testid="timed"][data-expired="1"]`, { timeout: 5000 });
assert.match(await pv.textContent(`${td} [data-testid="timed-status"]`), /Time.s up/);
assert.ok(await pv.isDisabled(`${td} .rs-option input`), "the options lock when the clock runs out");
assert.equal(await sideOf(pv, made.timed.id, "timeout"), 1, "the timeout is recorded");
assert.equal(await sideOf(pv, made.timed.id, "rt"), null, "and no reaction time is invented");
await pv.close();
console.log("✔ timed: __rt on answer, lock + __timeout when the clock runs out");

/* ------------------------------------------------------------------ matching */
pv = await h.preview([made.matching.id]);
const mt = `[data-qid="${made.matching.id}"]`;
assert.match(await pv.textContent(`${mt} [data-testid="matching-progress"]`), /0 of 3/);
await pv.click(`${mt} [data-row="r1"]`);
await pv.click(`${mt} [data-code="a1"]`);
assert.deepEqual(await h.answerOf(pv, made.matching.id), { r1: "a1" }, "a pair stores {row: option}");
// keyboard for the second pair
await pv.focus(`${mt} [data-row="r2"]`);
await pv.keyboard.press("Enter");
await pv.focus(`${mt} [data-code="a3"]`);
await pv.keyboard.press("Enter");
assert.deepEqual(await h.answerOf(pv, made.matching.id), { r1: "a1", r2: "a3" }, "the keyboard pairs too");
// clicking a made pair undoes it
await pv.click(`${mt} [data-row="r2"]`);
assert.deepEqual(await h.answerOf(pv, made.matching.id), { r1: "a1" }, "clicking a matched prompt frees it");
await pv.click(`${mt} [data-row="r2"]`);
await pv.click(`${mt} [data-code="a2"]`);
await pv.click(`${mt} [data-row="r3"]`);
await pv.click(`${mt} [data-code="a3"]`);
assert.deepEqual(await h.answerOf(pv, made.matching.id), { r1: "a1", r2: "a2", r3: "a3" });
await pv.waitForSelector(`${mt} .rs-matching-score`);
assert.match(await pv.textContent(`${mt} [data-testid="matching-progress"]`), /3 of 3 correct/);
assert.equal(await sideOf(pv, made.matching.id, "correct"), 3, "all three pairs right");
assert.equal(await pv.$$eval(`${mt} .rs-matching-lines line`, (l) => l.length), 3, "three connectors are drawn");
await pv.close();

// a wrong pairing is scored as such
pv = await h.preview([made.matching.id]);
await pv.click(`${mt} [data-row="r1"]`); await pv.click(`${mt} [data-code="a2"]`);
await pv.click(`${mt} [data-row="r2"]`); await pv.click(`${mt} [data-code="a1"]`);
await pv.click(`${mt} [data-row="r3"]`); await pv.click(`${mt} [data-code="a3"]`);
await pv.waitForSelector(`${mt} .rs-matching-item.bad`);
assert.equal(await sideOf(pv, made.matching.id, "correct"), 1, "only the keyed pair counts");
await pv.close();
console.log("✔ matching: per-row map, connectors, keyboard, and scoring against the key");

/* ---------------------------------------------------------- attention check */
pv = await h.preview([made.attention.id]);
const at = `[data-qid="${made.attention.id}"]`;
assert.ok(!(await pv.$(`${at} .rs-cal, ${at} .rs-quizopt`)), "it looks like an ordinary single select");
await pv.click(`${at} .rs-option:nth-child(3) input`); // code 3 — expected
assert.equal(await h.answerOf(pv, made.attention.id), 3);
assert.equal(await sideOf(pv, made.attention.id, "passed"), 1, "the expected answer passes");
await pv.click(`${at} .rs-option:nth-child(1) input`);
assert.equal(await sideOf(pv, made.attention.id, "passed"), 0, "a wrong answer fails");
await h.next(pv);
await pv.waitForSelector(".rs-end");
assert.equal(await statusOf(pv), "complete",
  "with onFail=flag a wrong answer completes the interview like any other");
await pv.close();

// terminate mode: the skip rule Studio wrote ends the interview
pv = await h.preview([made.attention.id], (d) => {
  const q = d.questions.find((x) => x.id === made.attention.id);
  q.settings.onFail = "terminate";
  q.skipLogic = [{
    id: "attention_fail",
    label: "Attention check failed",
    when: {
      type: "group", op: "and", children: [
        { type: "rule", source: { kind: "question", ref: q.id }, operator: "answered" },
        { type: "rule", source: { kind: "question", ref: q.id }, operator: "notIn", value: ["3"] },
      ],
    },
    target: { kind: "end", status: "terminated" },
  }];
});
await pv.click(`${at} .rs-option:nth-child(3) input`); // the expected answer
await h.next(pv);
await pv.waitForSelector(".rs-end");
assert.equal(await statusOf(pv), "complete", "passing the check does not terminate");
await pv.close();

pv = await h.preview([made.attention.id], (d) => {
  const q = d.questions.find((x) => x.id === made.attention.id);
  q.settings.onFail = "terminate";
  q.skipLogic = [{
    id: "attention_fail",
    label: "Attention check failed",
    when: {
      type: "group", op: "and", children: [
        { type: "rule", source: { kind: "question", ref: q.id }, operator: "answered" },
        { type: "rule", source: { kind: "question", ref: q.id }, operator: "notIn", value: ["3"] },
      ],
    },
    target: { kind: "end", status: "terminated" },
  }];
});
await pv.click(`${at} .rs-option:nth-child(1) input`); // fail
await h.next(pv);
await pv.waitForSelector(".rs-end");
assert.equal(await statusOf(pv), "terminated", "a failed check terminates the interview");
assert.ok(!(await pv.$(at)), "the question is gone — the survey has ended");
await pv.close();
console.log("✔ attention check: __passed 0/1, and terminate mode really ends the interview");

/* ----------------------------------------------------------------- IAT block */
pv = await h.preview([made.iat.id]);
const iat = `[data-qid="${made.iat.id}"]`;
assert.match(await pv.textContent(`${iat} [data-testid="iat-progress"]`), /0 of 4/);
await pv.waitForSelector(`${iat} [data-testid="iat-fixation"]`);
const seen = [];
for (let i = 0; i < 4; i++) {
  const stim = await pv.waitForSelector(`${iat} [data-testid="iat-stimulus"]`, { timeout: 4000 });
  const row = await stim.getAttribute("data-row");
  seen.push(row);
  await pv.keyboard.press(i % 2 === 0 ? "e" : "i");
  await pv.waitForTimeout(400);
}
await pv.waitForSelector(`${iat} [data-testid="iat-done"]`);
const iatAns = await h.answerOf(pv, made.iat.id);
assert.equal(Object.keys(iatAns).length, 4, "one answer per stimulus");
assert.deepEqual([...new Set(seen)].sort(), ["s1", "s2", "s3", "s4"], "every stimulus was shown once");
assert.deepEqual(
  seen.map((r) => iatAns[r]),
  seen.map((_, i) => (i % 2 === 0 ? 1 : 2)),
  "E stores the first category and I the second",
);
const iatRt = await sideOf(pv, made.iat.id, "rt");
assert.equal(Object.keys(iatRt).length, 4, "a reaction time per stimulus");
assert.ok(Object.values(iatRt).every((ms) => typeof ms === "number" && ms > 0), "and each is positive ms");
await pv.close();

// clicking a category works as well as the key
pv = await h.preview([made.iat.id]);
await pv.waitForSelector(`${iat} [data-testid="iat-stimulus"]`);
await pv.click(`${iat} .rs-iat-cat[data-code="2"]`);
await pv.waitForTimeout(400);
assert.equal(Object.keys(await h.answerOf(pv, made.iat.id)).length, 1, "a click responds too");
await pv.close();
console.log("✔ IAT: seeded stimulus order, E/I keys and clicks, per-row map + __rt map");

/* ----------------------------------------------------- experiment / stimulus */
// a 100%-weight arm is always assigned; a 0-weight arm never is
pv = await h.preview([made.ab.id]);
const ex = `[data-qid="${made.ab.id}"]`;
await pv.waitForSelector(`${ex} [data-testid="experiment"][data-arm]`);
assert.equal(await h.answerOf(pv, made.ab.id), "B", "the 100%-weight arm is assigned");
assert.equal(await pv.getAttribute(`${ex} [data-testid="experiment"]`, "data-arm"), "B");
assert.match(await pv.textContent(`${ex} [data-testid="experiment-tag"]`), /Arm: B \(Treatment\)/,
  "test mode shows which arm was assigned");
assert.match(await pv.textContent(`${ex} [data-testid="experiment-html"]`), /Treatment copy/);
assert.ok(
  !(await pv.$$eval(`${ex} [data-testid="experiment-html"] script`, (n) => n.length)),
  "the arm's HTML is sanitized",
);
await pv.close();

// the zero-weight arm stays unassigned across fresh respondents (each preview
// load is a new seed), and the assignment never changes under re-render
for (let i = 0; i < 4; i++) {
  pv = await h.preview([made.ab.id]);
  await pv.waitForSelector(`${ex} [data-testid="experiment"][data-arm]`);
  assert.equal(await h.answerOf(pv, made.ab.id), "B", "a 0-weight arm is never assigned");
  await h.next(pv); // a validation-free navigation re-renders everything
  await pv.close();
}

// with even weights both arms are reachable and the choice is stable per load
const drawn = new Set();
for (let i = 0; i < 12; i++) {
  pv = await h.preview([made.ab.id], (d) => {
    d.questions.find((q) => q.id === made.ab.id).settings.arms.forEach((a) => { a.weight = 1; });
  });
  await pv.waitForSelector(`${ex} [data-testid="experiment"][data-arm]`);
  const first = await h.answerOf(pv, made.ab.id);
  drawn.add(first);
  await pv.click(`${ex} [data-testid="experiment"]`);
  await pv.waitForTimeout(80);
  assert.equal(await h.answerOf(pv, made.ab.id), first, "an assigned arm is never re-drawn");
  await pv.close();
}
assert.equal(drawn.size, 2, `both arms are reachable with even weights (saw ${[...drawn].join()})`);
console.log("✔ A/B experiment: weighted, sanitized, assigned once and never re-drawn");

pv = await h.preview([made.stimulus.id], (d) => {
  const arms = d.questions.find((q) => q.id === made.stimulus.id).settings.arms;
  arms[0].weight = 1; arms[1].weight = 0; arms[2].weight = 0;
  arms[0].mediaUrl = "https://example.invalid/stimulus.png";
});
const st = `[data-qid="${made.stimulus.id}"]`;
// example.invalid never loads: the image element gives way to the graceful
// "Unable to load image" note, which still names the URL it tried
const imgOrNote = `${st} [data-testid="media-image"], ${st} [data-testid="media-broken"]`;
await pv.waitForSelector(imgOrNote);
assert.equal(await h.answerOf(pv, made.stimulus.id), "S1");
const shown = await pv.$eval(imgOrNote, (el) => el.getAttribute("src") ?? el.getAttribute("title"));
assert.match(shown, /stimulus\.png/);
await pv.close();

pv = await h.preview([made.stimulus.id], (d) => {
  const arms = d.questions.find((q) => q.id === made.stimulus.id).settings.arms;
  arms[0].weight = 0; arms[1].weight = 1; arms[2].weight = 0;
  arms[1].mediaUrl = "https://example.invalid/clip.mp4";
});
await pv.waitForSelector(`${st} [data-testid="media-video"], ${st} [data-testid="media-broken"]`);
assert.equal(await h.answerOf(pv, made.stimulus.id), "S2", "a video stimulus renders as a video");
await pv.close();
console.log("✔ random stimulus: the assigned arm's image or video is what shows");

/* ---------------------------------------------------------------------- chat */
pv = await h.preview([made.chat.id]);
const ch = `[data-qid="${made.chat.id}"]`;
assert.match(await pv.textContent(`${ch} [data-testid="chat-progress"]`), /0 of 3/);
assert.equal(await pv.$$eval(`${ch} .rs-chat-bubble.in`, (n) => n.length), 1,
  "prompts arrive one at a time");
await pv.fill(`${ch} [data-testid="chat-input"]`, "A friend told me");
await pv.keyboard.press("Enter"); // Enter sends
await pv.waitForTimeout(300);
assert.deepEqual(await h.answerOf(pv, made.chat.id), { q1: "A friend told me" });
assert.match(await pv.textContent(`${ch} [data-testid="chat-progress"]`), /1 of 3/);
await pv.waitForFunction(
  (sel) => document.querySelectorAll(`${sel} .rs-chat-bubble.in`).length === 2,
  ch, { timeout: 4000 },
);
await pv.fill(`${ch} [data-testid="chat-input"]`, "The support");
await pv.click(`${ch} [data-testid="chat-send"]`); // and so does the button
await pv.waitForTimeout(300);
await pv.fill(`${ch} [data-testid="chat-input"]`, "Nothing much");
await pv.click(`${ch} [data-testid="chat-send"]`);
await pv.waitForTimeout(300);
assert.deepEqual(await h.answerOf(pv, made.chat.id),
  { q1: "A friend told me", q2: "The support", q3: "Nothing much" },
  "the transcript stores {rowCode: text}");
await pv.waitForSelector(`${ch} [data-testid="chat-done"]`);
assert.ok(await pv.isDisabled(`${ch} [data-testid="chat-input"]`), "there is nothing left to ask");

// an earlier reply can be corrected by clicking its bubble
await pv.click(`${ch} [data-reply="q1"]`);
await pv.fill(`${ch} [data-testid="chat-input"]`, "An advert, actually");
await pv.click(`${ch} [data-testid="chat-send"]`);
await pv.waitForTimeout(250);
assert.deepEqual(await h.answerOf(pv, made.chat.id),
  { q1: "An advert, actually", q2: "The support", q3: "Nothing much" },
  "editing an earlier reply rewrites that row and nothing else");
await pv.close();
console.log("✔ chat: one prompt at a time, Enter or Send, per-row map, earlier replies editable");

/* ============================================ 4. the ordinary validators apply */
const REQUIRED = [
  ["calendar", made.calendar.id, /required/i],
  ["month_year", made.month_year.id, /required/i],
  ["adaptive", made.adaptive.id, /required/i],
  ["quiz", made.quiz.id, /required/i],
  ["timed", made.timed.id, /required/i],
  ["matching", made.matching.id, /Please answer for/i],
  ["attention", made.attention.id, /required/i],
  ["iat", made.iat.id, /Please answer for/i],
  ["chat", made.chat.id, /Please answer for/i],
];
for (const [name, id, pattern] of REQUIRED) {
  const p2 = await h.preview([id], (d) => {
    const q = d.questions.find((x) => x.id === id);
    q.required = true;
    if (id === made.attention.id) q.skipLogic = [];
  });
  await h.next(p2);
  assert.ok(await p2.$(`[data-qid="${id}"]`), `${name}: still on the page`);
  assert.match(await p2.textContent(".rs-shell"), pattern, `${name}: required blocks Next`);
  await p2.close();
}
console.log(`✔ required blocks Next on all ${REQUIRED.length} answerable variants — nothing here is special to the engine`);

// a partly-answered chat is not a complete one
{
  const p2 = await h.preview([made.chat.id], (d) => {
    d.questions.find((x) => x.id === made.chat.id).required = true;
  });
  await p2.fill(`${ch} [data-testid="chat-input"]`, "only the first");
  await p2.click(`${ch} [data-testid="chat-send"]`);
  await p2.waitForTimeout(300);
  await h.next(p2);
  assert.match(await p2.textContent(".rs-shell"), /Please answer for/, "one reply of three is not enough");
  await p2.close();
}
// the experiment is derived: it needs no answer from the respondent
{
  const p2 = await h.preview([made.ab.id]);
  await p2.waitForSelector(`${ex} [data-testid="experiment"][data-arm]`);
  await h.next(p2);
  await p2.waitForSelector(".rs-end");
  assert.equal(await statusOf(p2), "complete", "a derived experiment question never blocks");
  await p2.close();
}
console.log("✔ partial answers and derived questions behave as the base types promise");

/* ================================================== 5. screenshots, all answered */
{
  const ids = [
    made.calendar.id, made.month_year.id, stem.id, made.adaptive.id, made.quiz.id,
    made.timed.id, made.matching.id, made.attention.id, made.iat.id,
    made.ab.id, made.stimulus.id, made.chat.id,
  ];
  const fill = async (page) => {
    await page.click(`${cal} [data-day="2026-03-10"]`);
    await page.click(`${cal} [data-slot="10:30"]`);
    await page.selectOption(`${my} [data-testid="my-month"]`, "06");
    await page.selectOption(`${my} [data-testid="my-year"]`, "2020");
    await page.click(`[data-qid="${stem.id}"] .rs-iconopt[data-code="2"]`);
    await page.waitForSelector(`${ad} [data-code="9"]`);
    await page.click(`${ad} [data-code="9"]`);
    await page.click(`${qz} [data-code="2"]`);
    await page.click(`${td} .rs-option:nth-child(1) input`);
    for (const [r, a] of [["r1", "a1"], ["r2", "a3"], ["r3", "a2"]]) {
      await page.click(`${mt} [data-row="${r}"]`);
      await page.click(`${mt} [data-code="${a}"]`);
    }
    await page.click(`${at} .rs-option:nth-child(3) input`);
    for (let i = 0; i < 4; i++) {
      await page.waitForSelector(`${iat} [data-testid="iat-stimulus"]`, { timeout: 4000 });
      await page.click(`${iat} .rs-iat-cat[data-code="${(i % 2) + 1}"]`);
      await page.waitForTimeout(380);
    }
    for (const text of ["A friend told me", "The support", "Nothing much"]) {
      await page.waitForSelector(`${ch} [data-testid="chat-input"]:not([disabled])`);
      await page.fill(`${ch} [data-testid="chat-input"]`, text);
      await page.click(`${ch} [data-testid="chat-send"]`);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(400);
  };

  const wide = await h.preview(ids, (d) => {
    d.questions.find((q) => q.id === made.stimulus.id).settings.arms[0].html =
      "<p><strong>Stimulus 1</strong> — the copy this arm shows.</p>";
  });
  await wide.setViewportSize({ width: 1000, height: 1000 });
  await fill(wide);
  await wide.screenshot({ path: "/tmp/variants-g6-variants.png", fullPage: true });
  await wide.close();

  const narrow = await h.preview(ids, (d) => {
    d.questions.find((q) => q.id === made.stimulus.id).settings.arms[0].html =
      "<p><strong>Stimulus 1</strong> — the copy this arm shows.</p>";
  });
  await narrow.setViewportSize({ width: 380, height: 900 });
  await fill(narrow);
  await narrow.screenshot({ path: "/tmp/variants-g6-variants-380.png", fullPage: true });
  const overflow = await narrow.evaluate(() =>
    Array.from(document.querySelectorAll("[data-qid]"))
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.getAttribute("data-qid")} (${el.scrollWidth} > ${el.clientWidth})`),
  );
  assert.deepEqual(overflow, [], "nothing overflows horizontally at 380px");
  // The survey column itself, not the document: the preview's own debug
  // toggle is `position: fixed` and hangs 25px off the right edge at 380px in
  // every survey, variant or not — that is pre-existing preview chrome
  // (Runner.tsx / globals.css), and none of this batch's business.
  const shellOverflow = await narrow.evaluate(() => {
    const el = document.querySelector(".rs-shell");
    return el ? el.scrollWidth - el.clientWidth : 0;
  });
  assert.ok(shellOverflow <= 1, `the survey column does not scroll sideways at 380px (got ${shellOverflow})`);
  const strays = await narrow.evaluate(() => {
    const W = document.querySelector(".rs-shell")?.getBoundingClientRect().right ?? 0;
    return Array.from(document.querySelectorAll(".rs-shell *"))
      .filter((el) => el.getBoundingClientRect().right > W + 1)
      .map((el) => `${el.tagName}.${el.className}`)
      .slice(0, 5);
  });
  assert.deepEqual(strays, [], "nothing inside the survey column pokes past its right edge");
  await narrow.close();
  console.log("✔ screenshots written: /tmp/variants-g6-variants.png and …-380.png");
}

await h.close();
console.log("\nALL G6 VARIANT CHECKS PASSED");
