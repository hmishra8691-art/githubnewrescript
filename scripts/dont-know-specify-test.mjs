/**
 * 2026-11-02 — "OTHER / SPECIFY" AND "I DON'T KNOW", in a real browser against the runtime preview (the same Runner
 * that serves test and live links), on desktop and on a phone-sized viewport.
 *
 *   A  Other / specify on a single-select: choosing it reveals the box at once; choosing another hides it; choosing
 *      it again brings it back (empty); Next with the box empty is refused; the text is stored against the
 *      question AND the option (q1__other__97)
 *   B  the same on a multi-select (tick / untick / tick)
 *   C  "I don't know" on an open-text question: off → no choice drawn; on → typing, then ticking clears the text
 *      and stores only q__dk; typing again unticks it; required is met by the choice
 *   D  the same on a numeric question with min / max / integer rules: a bad number is refused, the choice is not,
 *      a good number deselects the choice
 *   E  the stored state at the end: answers and choices never together
 *
 *   node scripts/dont-know-specify-test.mjs      (runtime dev server on :3001)
 */
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let bad = 0, good = 0;
const ok = (c, m) => { console.log(`${c ? "  ok  " : "  FAIL"} ${m}`); if (c) good++; else bad++; };

const definition = {
  meta: { id: "00000000-0000-4000-8000-0000000000dk", code: "DK_SPEC", title: "Specify and don't know" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRAND", type: "single_select", text: "Which brand do you use most?", required: true,
      options: [{ code: 1, label: "Acme" }, { code: 2, label: "Globex" }, { code: 97, label: "Other (please specify)", flags: ["other_specify"] }] },
    { id: "q2", code: "Q2", variableName: "USE", type: "multi_select", text: "Where do you use it?", required: true,
      options: [{ code: 1, label: "Home" }, { code: 2, label: "Work" }, { code: 98, label: "Something else", flags: ["other_specify"] }] },
    { id: "q3", code: "Q3", variableName: "WHY", type: "open_text", text: "Why that brand?", required: true, settings: { dontKnow: true } },
    { id: "q4", code: "Q4", variableName: "SPEND", type: "numeric", text: "How much do you spend a month?", required: true, settings: { dontKnow: true, dontKnowLabel: "Not sure" },
      validation: [{ kind: "min_value", value: 0 }, { kind: "max_value", value: 1000 }, { kind: "integer" }] },
    { id: "q5", code: "Q5", variableName: "NOTE", type: "open_text", text: "Anything else?" },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3", "q4", "q5"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const answers = (page) => page.evaluate(() => { const s = window.__rescriptState ?? window.rescriptState; return s ? JSON.parse(JSON.stringify(s.answers)) : null; });
const errorsOn = (page, qid) => page.$$eval(`[data-qid="${qid}"] .rs-error, [data-qid="${qid}"] [role="alert"]`, (els) => els.map((e) => e.textContent?.trim()).filter(Boolean));

for (const [label, viewport] of [["desktop", { width: 1100, height: 1000 }], ["phone", { width: 390, height: 844 }]]) {
  console.log(`\n=== ${label} ${viewport.width}×${viewport.height}`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, ...(label === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  page.on("pageerror", (e) => { console.log("  !! page error:", e.message); bad++; });
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "domcontentloaded" });
  await sendPreview(page, { definition });
  const click = (sel) => (label === "phone" ? page.tap(sel) : page.click(sel));

  console.log("A  Other / specify — single");
  const box1 = '[data-qid="q1"] [data-testid="rs-other-input"]';
  ok(!(await page.$(box1)), "no box before Other is chosen");
  await click('[data-qid="q1"] [data-rs-id="97"] input');
  await page.waitForTimeout(150);
  ok(!!(await page.$(box1)), "choosing Other reveals its box at once");
  await click('[data-qid="q1"] [data-rs-id="1"] input');
  await page.waitForTimeout(150);
  ok(!(await page.$(box1)), "choosing Acme hides it");
  await click('[data-qid="q1"] [data-rs-id="97"] input');
  await page.waitForTimeout(150);
  ok(!!(await page.$(box1)) && (await page.inputValue(box1)) === "", "choosing Other again brings it back, empty");

  console.log("B  Other / specify — multi");
  const box2 = '[data-qid="q2"] [data-testid="rs-other-input"]';
  await click('[data-qid="q2"] [data-rs-id="1"] input[type="checkbox"]');
  await click('[data-qid="q2"] [data-rs-id="98"] input[type="checkbox"]');
  await page.waitForTimeout(150);
  ok(!!(await page.$(box2)), "ticking “Something else” reveals its box");
  await click('[data-qid="q2"] [data-rs-id="98"] input[type="checkbox"]');
  await page.waitForTimeout(150);
  ok(!(await page.$(box2)), "unticking hides it");
  await click('[data-qid="q2"] [data-rs-id="98"] input[type="checkbox"]');
  await page.waitForTimeout(150);
  ok(!!(await page.$(box2)), "ticking again brings it back");

  await click('[data-testid="rs-next"]');
  await page.waitForTimeout(400);
  const e1 = await errorsOn(page, "q1"), e2 = await errorsOn(page, "q2");
  ok(e1.some((t) => /Other/.test(t)) && e2.some((t) => /Other/.test(t)), `an empty specify box is refused on both → ${JSON.stringify([e1, e2])}`);
  await page.fill(box1, "Initech");
  await page.fill(box2, "In the car");
  await page.waitForTimeout(150);
  let a = await answers(page);
  ok(a.q1 === 97 && a.q1__other__97 === "Initech", `the single's text is stored against Q1 and option 97 → ${JSON.stringify({ q1: a.q1, k: a.q1__other__97 })}`);
  ok(JSON.stringify(a.q2) === "[1,98]" && a.q2__other__98 === "In the car", `the multi's against Q2 and option 98 → ${JSON.stringify({ q2: a.q2, k: a.q2__other__98 })}`);
  await click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q3"]', { timeout: 15000 });

  console.log("C  I don't know — open text");
  ok(!(await page.$('[data-qid="q5"] [data-testid="rs-dont-know"]')), "a question without the setting draws no choice");
  ok((await page.textContent('[data-qid="q3"] [data-testid="rs-dont-know"]'))?.includes("I don't know"), "the default label");
  ok((await page.textContent('[data-qid="q4"] [data-testid="rs-dont-know"]'))?.includes("Not sure"), "the researcher's own label");
  await page.fill('[data-qid="q3"] input.rs-input', "It is cheap");
  await click('[data-qid="q3"] [data-testid="rs-dont-know-input"]');
  await page.waitForTimeout(150);
  a = await answers(page);
  ok(await page.isChecked('[data-qid="q3"] [data-testid="rs-dont-know-input"]'), "ticked");
  ok((await page.inputValue('[data-qid="q3"] input.rs-input')) === "", "the text box is cleared");
  ok(a.q3__dk === true && (a.q3 === undefined || a.q3 === null), `only the choice is stored → ${JSON.stringify({ q3: a.q3, dk: a.q3__dk })}`);
  await page.fill('[data-qid="q3"] input.rs-input', "Actually: price");
  await page.waitForTimeout(150);
  a = await answers(page);
  ok(!(await page.isChecked('[data-qid="q3"] [data-testid="rs-dont-know-input"]')), "typing unticks it");
  ok(a.q3 === "Actually: price" && a.q3__dk === undefined, `only the text is stored → ${JSON.stringify({ q3: a.q3, dk: a.q3__dk })}`);
  await click('[data-qid="q3"] [data-testid="rs-dont-know-input"]');
  await page.waitForTimeout(100);

  console.log("D  I don't know — numeric with rules");
  await page.fill('[data-qid="q4"] input', "2000");
  await page.waitForTimeout(100);
  await click('[data-testid="rs-next"]');
  await page.waitForTimeout(400);
  const e4 = await errorsOn(page, "q4");
  ok(e4.some((t) => /1000/.test(t)), `a number over the maximum is refused → ${JSON.stringify(e4)}`);
  ok((await errorsOn(page, "q3")).length === 0, "the open-text question answered by the choice passes required");
  await click('[data-qid="q4"] [data-testid="rs-dont-know-input"]');
  await page.waitForTimeout(150);
  ok((await page.inputValue('[data-qid="q4"] input')) === "", "ticking clears the number");
  await page.fill('[data-qid="q4"] input', "12");
  await page.waitForTimeout(150);
  ok(!(await page.isChecked('[data-qid="q4"] [data-testid="rs-dont-know-input"]')), "a number unticks the choice");
  await page.fill('[data-qid="q4"] input', "12.5");
  await page.waitForTimeout(100);
  ok((await page.inputValue('[data-qid="q4"] input')) === "12", "the integer rule still refuses a decimal at the keystroke");
  await click('[data-qid="q4"] [data-testid="rs-dont-know-input"]');
  await page.waitForTimeout(150);

  console.log("E  stored, then submitted");
  a = await answers(page);
  ok(a.q4__dk === true && (a.q4 === undefined || a.q4 === null) && a.q3__dk === true && (a.q3 === undefined || a.q3 === null), `choices stored, answers empty → ${JSON.stringify({ q3: a.q3, q3dk: a.q3__dk, q4: a.q4, q4dk: a.q4__dk })}`);
  await click('[data-testid="rs-next"]');
  await page.waitForTimeout(800);
  const done = await page.evaluate(() => (window.__rescriptState ?? window.rescriptState)?.status);
  ok(done === "complete", `the interview completes with both choices → ${done}`);
  await browser.close();
}
console.log(`\ndont-know-specify: ${good} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
