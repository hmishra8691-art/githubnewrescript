/**
 * THREE "OTHER, SPECIFY" BOXES IN ONE QUESTION.
 *
 * What is proven, in a real browser against the real runtime: three boxes on
 * one multi-select hold three different answers; typing in one does not touch
 * another; clearing one leaves the others; each is stored under its own key;
 * each pipes into a later question independently; and the values survive Next
 * and Back.
 *
 * The bug this replaces: every box rendered the same binding and wrote the
 * same key, so "Apple" typed into the first appeared in all three — on screen
 * and in the data.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let bad = 0;
const ok = (c, m) => { console.log(`${c ? "  ok  " : "  FAIL"} ${m}`); if (!c) bad++; };

const definition = {
  meta: { id: "00000000-0000-4000-8000-000000000001", code: "OTHER_SPEC", title: "Other specify" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "BRAND", type: "multi_select",
      text: "Which brands do you use?",
      options: [
        { code: 1, label: "Acme" },
        { code: 2, label: "Globex" },
        { code: 97, label: "Other phone", flags: ["other_specify"] },
        { code: 98, label: "Other tablet", flags: ["other_specify"] },
        { code: 99, label: "Other laptop", flags: ["other_specify"] },
      ],
    },
    {
      id: "q2", code: "Q2", variableName: "WHY", type: "long_text",
      text: "You said {{Q1[97].other}}, {{Q1[98].other}} and {{Q1[99].other}}. Why those?",
    },
    {
      id: "q3", code: "Q3", variableName: "ECHO", type: "long_text",
      text: "And about {{Q1.other}} in particular — anything to add? You wrote: {{Q2}}",
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
page.on("pageerror", (e) => { console.log("  !! page error:", e.message); bad++; });
await page.goto(`${RUNTIME}/preview`, { waitUntil: "domcontentloaded" });
await sendPreview(page, { definition });

const box = (code) => `[data-qid="q1"] [data-other-code="${code}"]`;
const boxes = () => page.$$eval('[data-qid="q1"] [data-testid="rs-other-input"]',
  (els) => els.map((e) => ({ code: e.getAttribute("data-other-code"), value: e.value, id: e.id })));
const answers = () => page.evaluate(() => {
  const w = window;
  const s = w.__rescriptState ?? w.rescriptState;
  return s ? JSON.parse(JSON.stringify(s.answers)) : null;
});

console.log("\nTHREE BOXES, THREE IDENTITIES");
/* the checkbox itself, not the label: the label's centre is the other-specify
   input once a box is showing, and that input stops propagation */
const tick = (c) => page.click(`[data-qid="q1"] [data-rs-id="${c}"] input[type="checkbox"]`);
for (const c of [97, 98, 99]) await tick(c);
await page.waitForTimeout(200);

let seen = await boxes();
ok(seen.length === 3, `three boxes are rendered → ${seen.length}`);
ok(new Set(seen.map((b) => b.code)).size === 3, `each names its own option → ${seen.map((b) => b.code).join(",")}`);
ok(new Set(seen.map((b) => b.id)).size === 3, `and each has its own id → ${seen.map((b) => b.id).join(" ")}`);

console.log("\nTYPING IN ONE DOES NOT TOUCH ANOTHER");
await page.fill(box(97), "Apple");
await page.waitForTimeout(150);
seen = await boxes();
ok(seen.find((b) => b.code === "97").value === "Apple", "the first box holds what was typed");
ok(seen.find((b) => b.code === "98").value === "", `the second is still empty → "${seen.find((b) => b.code === "98").value}"`);
ok(seen.find((b) => b.code === "99").value === "", `and so is the third → "${seen.find((b) => b.code === "99").value}"`);

await page.fill(box(98), "Samsung");
await page.fill(box(99), "Sony");
await page.waitForTimeout(150);
seen = await boxes();
ok(JSON.stringify(seen.map((b) => b.value)) === '["Apple","Samsung","Sony"]',
  `three different answers stand together → ${seen.map((b) => b.value).join(", ")}`);

console.log("\nEDITING ONE AFTER ALL THREE ARE FILLED");
await page.fill(box(98), "Nokia");
await page.waitForTimeout(150);
seen = await boxes();
ok(JSON.stringify(seen.map((b) => b.value)) === '["Apple","Nokia","Sony"]',
  `only the edited one changed → ${seen.map((b) => b.value).join(", ")}`);

console.log("\nCLEARING ONE LEAVES THE OTHERS");
await page.fill(box(98), "");
await page.waitForTimeout(150);
seen = await boxes();
ok(JSON.stringify(seen.map((b) => b.value)) === '["Apple","","Sony"]',
  `the other two survive → ${seen.map((b) => b.value).join(", ")}`);
await page.fill(box(98), "Samsung");
await page.waitForTimeout(150);

console.log("\nEACH VALUE PIPES ON ITS OWN");
await page.click('[data-testid="rs-next"]');
await page.waitForTimeout(600);
const q2 = (await page.textContent('[data-qid="q2"] .rs-qtext')) ?? "";
ok(/You said Apple, Samsung and Sony\./.test(q2), `three tokens, three answers → ${q2.trim()}`);
ok(!/Apple, Apple, Apple/.test(q2), "and not the same one three times");

console.log("\nA PLAIN OPEN END PIPES TOO");
await page.fill('[data-qid="q2"] textarea', "Because they last.");
await page.click('[data-testid="rs-next"]');
await page.waitForTimeout(600);
const q3 = (await page.textContent('[data-qid="q3"] .rs-qtext')) ?? "";
ok(/about Apple in particular/.test(q3), `the unqualified form means the first box → ${q3.trim()}`);
ok(/You wrote: Because they last\./.test(q3), "and a long-text answer pipes verbatim");

console.log("\nGOING BACK KEEPS ALL THREE");
await page.click('[data-testid="rs-back"]');
await page.waitForTimeout(400);
await page.click('[data-testid="rs-back"]');
await page.waitForTimeout(400);
seen = await boxes();
ok(JSON.stringify(seen.map((b) => b.value)) === '["Apple","Samsung","Sony"]',
  `all three came back → ${seen.map((b) => b.value).join(", ")}`);

console.log("\nUNTICKING ONE TAKES ONLY ITS OWN TEXT");
await tick(98);
await page.waitForTimeout(200);
seen = await boxes();
ok(seen.length === 2, `the unticked box is gone → ${seen.length} left`);
ok(JSON.stringify(seen.map((b) => b.value)) === '["Apple","Sony"]',
  `and the other two are untouched → ${seen.map((b) => b.value).join(", ")}`);

await tick(98);
await page.waitForTimeout(200);
seen = await boxes();
ok(seen.find((b) => b.code === "98")?.value === "",
  "re-ticking it gives an empty box, not another box's text");

console.log(`\n======== ${bad ? `${bad} FAILURE(S)` : "ALL OTHER-SPECIFY CHECKS PASSED"}`);
await browser.close();
process.exit(bad ? 1 : 0);
