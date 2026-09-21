/**
 * VALIDATION MESSAGES IN A REAL BROWSER — formatting, piping, and position.
 *
 *   node scripts/validation-message-test.mjs          (runtime on :3001)
 *
 * The engine tests prove what a message BECOMES. This proves what a
 * respondent SEES, through the real runtime, the real renderer and the real
 * stylesheet — which is where the three things that could go wrong live:
 *
 *   · markup rendered as markup rather than as visible angle brackets;
 *   · a plain message left alone, `<` and all, which is the regression the
 *     opt-in format flag exists to prevent;
 *   · the message appearing where the author put it.
 *
 * And one thing that was already broken before any of this: a per-row error
 * was found by matching the row's label against the front of the message, so
 * two rows whose labels share a prefix took each other's errors. That is
 * asserted here because it is the sort of fix that silently un-fixes itself.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME ?? "http://localhost:3001";
let bad = 0;
const ok = (c, m) => { console.log(`${c ? "  ok  " : "  FAIL"} ${m}`); if (!c) bad++; };

const def = SurveyDefinition.parse({
  meta: { id: "00000000-0000-4000-8000-0000000vmb01", code: "VMB", title: "Validation messages" },
  questions: [
    {
      id: "q_brand", code: "Q1", variableName: "BRAND", type: "single_select",
      text: "Which brand do you buy most often?",
      options: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }],
    },
    /* formatted, piped, and left where messages have always gone */
    {
      id: "q_below", code: "Q2", variableName: "SPEND", type: "numeric",
      text: "How much do you spend a month?",
      validation: [{
        kind: "min_value", value: 100,
        message: "You told us you buy <strong>{{Q1.label}}</strong> — please enter <em>at least 100</em>.",
        messageFormat: "html",
      }],
    },
    /* the same, moved above the question */
    {
      id: "q_above", code: "Q3", variableName: "UNITS", type: "numeric",
      text: "And how many units?",
      settings: { validationPosition: "above" },
      validation: [{
        kind: "min_value", value: 10,
        message: "<strong>Too few.</strong> Ten is the minimum.",
        messageFormat: "html",
      }],
    },
    /*
     * The message nobody has touched since before any of this existed.
     *
     * The angle bracket is followed by a LETTER on purpose. `< 100` and
     * `<100` both survive being parsed as HTML — a browser needs a letter
     * after the `<` before it will read a tag — so a fixture using either
     * proves nothing about whether the format flag is being honoured. It
     * passed happily against a renderer that ignored the flag entirely,
     * which is how this fixture came to be written this way.
     *
     * "the format <first> <last>" is both realistic for a validation message
     * and unambiguously destroyed by being treated as markup.
     */
    {
      id: "q_plain", code: "Q4", variableName: "AGE", type: "numeric",
      text: "How old are you?",
      validation: [{ kind: "min_value", value: 18, message: "Enter it in the format <first> <last> — and over 18." }],
    },
    /*
     * Two rows, one label a prefix of the other, LONGER FIRST.
     *
     * The order is the whole point. With the short label first, matching by
     * prefix happens to give both rows the right error, because the first
     * message in the array is also the right one. Put the long label first
     * and the short row's `startsWith("Other")` matches the long row's
     * message instead — which is the bug, and which only this ordering
     * exposes.
     */
    {
      id: "q_rows", code: "Q5", variableName: "CONTACT", type: "text_list", text: "Your details",
      rows: [
        { code: "other_say", label: "Other (please say)", flags: [], fieldType: "text", validation: [{ kind: "min_length", value: 5, message: "five here too" }], required: false },
        { code: "other", label: "Other", flags: [], fieldType: "text", validation: [{ kind: "min_length", value: 5, message: "five characters, please" }], required: false },
      ],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_brand", "q_below", "q_above", "q_plain", "q_rows"] },
    { type: "end", id: "e1", status: "complete", message: "Done" },
  ],
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

try {
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector: "[data-qid]" });

  /* answer Q1 so the piped token has something to resolve, then fail the rest */
  await page.click('[data-qid="q_brand"] input[type="radio"]');
  const type = async (qid, value) => {
    const box = await page.$(`[data-qid="${qid}"] input`);
    await box.fill(String(value));
  };
  await type("q_below", 5);
  await type("q_above", 1);
  await type("q_plain", 12);
  await page.fill('[data-qid="q_rows"] [data-rs-el="row"][data-rs-id="other"] input', "ab");
  await page.fill('[data-qid="q_rows"] [data-rs-el="row"][data-rs-id="other_say"] input', "cd");

  await page.click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q_below"] .rs-error-msg');

  /* ------------------------------------------------ 1. markup is markup */

  const richHtml = await page.$eval('[data-qid="q_below"] .rs-error-msg', (el) => el.innerHTML);
  const richText = await page.$eval('[data-qid="q_below"] .rs-error-msg', (el) => el.textContent.trim());
  ok(/<strong>Alpha<\/strong>/.test(richHtml), `the formatting rendered, and the pipe resolved inside it — got: ${richHtml}`);
  ok(!richText.includes("<strong>"), `no angle brackets on screen — got: ${richText}`);
  ok(/at least 100/.test(richText), `the rest of the sentence is there — got: ${richText}`);

  /* -------------------------- 2. a plain message is left exactly alone */

  const plainText = await page.$eval('[data-qid="q_plain"] .rs-error-msg', (el) => el.textContent.trim());
  ok(
    plainText.includes("<first>") && plainText.includes("<last>"),
    `THE REGRESSION: a pre-existing plain message was parsed as markup — got: ${plainText}`,
  );
  const plainHtml = await page.$eval('[data-qid="q_plain"] .rs-error-msg', (el) => el.innerHTML);
  ok(
    plainHtml.includes("&lt;first&gt;"),
    `a plain message must be escaped on the way to the DOM — got: ${plainHtml}`,
  );

  /* ----------------------------------------------------- 3. position */

  const order = (qid) => page.$eval(`[data-qid="${qid}"]`, (card) => {
    const err = card.querySelector('[role="alert"]');
    const text = card.querySelector(".rs-qtext");
    if (!err || !text) return "missing";
    /* DOCUMENT_POSITION_FOLLOWING === 4 : the error comes after the text */
    return (err.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) ? "above" : "below";
  });
  ok(await order("q_above") === "above", `Q3 asked for the message above the question`);
  ok(await order("q_below") === "below", `Q2 left it where it has always been`);

  /* ------------------------ 4. the right row gets the right message */

  const rowErr = (row) => page.$eval(
    `[data-qid="q_rows"] [data-rs-el="row"][data-rs-id="${row}"]`,
    (el) => el.querySelector(".rs-error-msg")?.textContent?.trim() ?? "",
  );
  const first = await rowErr("other");
  const second = await rowErr("other_say");
  ok(/five characters/.test(first), `"Other" shows its own message — got: ${first}`);
  ok(/five here too/.test(second), `"Other (please say)" shows its own — got: ${second}`);
  ok(first !== second, "two rows whose labels share a prefix must not share an error");

  /* --------------------------------- 5. nothing script-shaped survives */

  const scripts = await page.$$eval('[role="alert"] script', (els) => els.length);
  ok(scripts === 0, "no script element inside a validation message");

  console.log(bad === 0 ? "\nALL VALIDATION MESSAGE CHECKS PASSED" : `\n${bad} CHECK(S) FAILED`);
} finally {
  await browser.close();
}
process.exit(bad === 0 ? 0 : 1);
