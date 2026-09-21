/**
 * THE VALIDATION MESSAGE EDITOR IS NO LONGER A ONE-LINE LABEL BOX.
 *
 *   node scripts/validation-message-editor-test.mjs      (studio on 3000)
 *
 * Sept 21 review: "The validation message input box has become far too
 * small... difficult to see the actual message, visualize formatted
 * content, work with longer messages, edit HTML, understand how the final
 * message will look." The root cause was the component, not its CSS — the
 * message field reused `InlineRichText`, the exact one-line-forever box an
 * option/row/column label needs (Enter is swallowed, text never wraps).
 * `multiline` on `InlineRichText` is the actual fix; this proves it, and
 * proves the new "Text editor" modal it sits beside, WITHOUT touching how
 * an option/row/column label behaves (that is `validation-condition-test`'s
 * and every option/row/column-editing suite's job, not this one's).
 *
 * This also guards the thing most likely to quietly break as this evolves:
 * the plain-text-message no-op guard (`packages/engine/validationMessage.test.ts`
 * already proves it at the engine level; here it has to survive the NEW
 * modal path too, since Save routes through the same `commitIfChanged` but
 * is new wiring of its own).
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(150); };
const readDef = async () => {
  // Sept 21 follow-up: the right panel is now context-aware and no longer
  // shows Question Properties while on the JSON tab (see Studio.tsx's
  // RightPanel), so this diagnostic peek must leave the tab exactly as it
  // found it, or whatever ran right after this call would find its target
  // in the right panel gone.
  const activeTab = await page.$(".leftnav .nav-item.active");
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  if (activeTab) await activeTab.click().catch(() => {});
  return JSON.parse(json);
};
const loadFixture = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(400);
};
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") {
    await page.click(head);
    await page.waitForTimeout(150);
  }
};
const selectQuestion = async (index) => {
  await goTab("Questions");
  await page.waitForSelector(".qcard");
  const cards = await page.$$(".qcard");
  await cards[index].click();
  await page.waitForTimeout(200);
};

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "ValidationMessageEditor", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "SPEND", type: "numeric", text: "How much do you spend?",
      validation: [{ kind: "min_value", value: 100, message: "Please enter a value < 100." }],
    },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
};

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await loadFixture(FIXTURE);
ok("fixture loaded: one numeric question with an existing PLAIN message (no messageFormat)");

await selectQuestion(0);
await ensureSectionOpen("validation-rules");
await page.waitForSelector('[data-testid="validation-message"]');

/* ============================================= 1. the box itself is big */

const boxHandle = page.locator('[data-testid="validation-message"]');
const emptyLabelBoxHeight = 32; // the old single-line `.rte-inline` min-height, for scale
const box0 = await boxHandle.boundingBox();
assert.ok(box0.height > emptyLabelBoxHeight * 2,
  `THE COMPLAINT ITSELF: the message box must be much taller than a one-line label box (was ~${emptyLabelBoxHeight}px) — got ${box0.height}px`);
ok(`the message box opens tall (${Math.round(box0.height)}px), not a one-line label box`);

/* ============================================ 2. Enter starts a new line */

await boxHandle.click();
// select-all + delete the existing plain text first, so we start from empty
await page.keyboard.press("Control+A");
await page.keyboard.press("Delete");
await page.keyboard.type("First line of a longer validation message");
await page.keyboard.press("Enter");
await page.keyboard.type("Second line, which an option label could never have");
await page.keyboard.press("Enter");
await page.keyboard.type("Third line — enough to prove this box actually grows");
await page.waitForTimeout(300);

const innerText = await boxHandle.evaluate((el) => el.innerText);
assert.ok(/First line/.test(innerText) && /Second line/.test(innerText) && /Third line/.test(innerText),
  `all three lines must be present — Enter must not be swallowed the way it is on an option label: ${JSON.stringify(innerText)}`);
ok("Enter inserts a new line instead of being eaten (as it correctly still is for a one-line option label)");

const boxGrown = await boxHandle.boundingBox();
assert.ok(boxGrown.height > box0.height,
  `the box must grow as content is added — was ${box0.height}px, now ${boxGrown.height}px`);
ok(`the box grows with its content (${Math.round(box0.height)}px -> ${Math.round(boxGrown.height)}px)`);

// blur to commit, and confirm the edit converted the rule to messageFormat:"html"
// (typing into the rich box is how a plain message becomes markup — unchanged
// behavior from before this fix, just re-proven through the new taller box)
await page.click('[data-testid="psec-head-validation-rules"]');
await page.click('[data-testid="psec-head-validation-rules"]');
await page.waitForTimeout(200);
let def = await readDef();
let rule = def.questions[0].validation[0];
assert.equal(rule.messageFormat, "html", "typing into the box still converts a plain message to markup, as before");
assert.match(rule.message, /First line.*Second line.*Third line/s, `the three lines must all be saved: ${rule.message}`);
ok("the edited message is saved with messageFormat:\"html\", exactly as the pre-existing conversion rule requires");

/* ==================================================== 3. the large modal */

await selectQuestion(0);
await ensureSectionOpen("validation-rules");
await page.waitForSelector('[data-testid="validation-message-expand"]');
await page.click('[data-testid="validation-message-expand"]');
await page.waitForSelector('[data-testid="validation-message-modal"]');
ok('the "Text editor" button opens the large modal');

const modalSurface = page.locator('[data-testid="validation-message-modal"] .rte-surface');
const modalBox = await modalSurface.boundingBox();
assert.ok(modalBox.height > 200, `the modal's editing area must be genuinely large — got ${modalBox.height}px`);
ok(`the modal's editing area is large (${Math.round(modalBox.height)}px tall)`);

// a real toolbar: formatting, and the same piping controls question text gets
assert.ok(await page.$('[data-testid="validation-message-modal"] .rte-bar'), "the modal has a formatting toolbar");
assert.ok(await page.$('[data-testid="validation-message-modal"] [data-testid="insert-piping"]'), "the modal has piping controls");
assert.ok(await page.$('[data-testid="validation-message-modal"] .rte-mode'), "the modal has the Visual/HTML mode toggle");
ok("the modal has a proper toolbar: formatting, piping, and Visual/HTML mode — a real editing environment, not a bigger box");

// clear and write something bold, with a piped token
await modalSurface.click();
await page.keyboard.press("Control+A");
await page.keyboard.press("Delete");
await page.keyboard.type("Way too low.");
await page.keyboard.press("Control+A");
await page.click('[data-testid="validation-message-modal"] .rte-btn[title="Bold"]');
await page.click('[data-testid="validation-message-modal"] .rte-surface'); // land caret back in the surface
await page.keyboard.press("End");
await page.keyboard.type(" ");
await page.click('[data-testid="validation-message-modal"] [data-testid="insert-piping"]');
await page.waitForSelector('[data-testid="pipe-question"]');
await page.selectOption('[data-testid="pipe-question"]', "Q1"); // the option's value is the question code
await page.click('[data-testid="pipe-insert"]');
await page.waitForTimeout(300);

// live preview updates before Save
const modalPreviewHtml = await page.$eval(
  '[data-testid="validation-message-modal-preview"] .rs-error-rich',
  (el) => el.innerHTML,
);
assert.match(modalPreviewHtml, /<b>|<strong>/, `the live preview must reflect bold formatting before Save: ${modalPreviewHtml}`);
assert.match(modalPreviewHtml, /pipe-chip/, `the live preview must show the inserted piping token as a chip: ${modalPreviewHtml}`);
ok("the modal's live preview reflects formatting and piping before Save is even clicked");

await page.click('[data-testid="validation-message-modal-save"]');
await page.waitForSelector('[data-testid="validation-message-modal"]', { state: "detached" });
ok("Save closes the modal");

def = await readDef();
rule = def.questions[0].validation[0];
assert.match(rule.message, /Way too low/, `the modal's edit must be committed to the rule: ${rule.message}`);
assert.match(rule.message, /<b>|<strong>/i, `the bold formatting must be committed: ${rule.message}`);
assert.equal(rule.messageFormat, "html");
ok("the modal's Save commits the edited, formatted, piped message back to the rule");

const panelPreviewText = await page.$eval('[data-testid="validation-message-preview"] .rs-error-rich', (el) => el.textContent);
assert.match(panelPreviewText, /Way too low/, `the panel's own preview must reflect the saved message: ${panelPreviewText}`);
ok("the panel's \"Respondent sees\" preview reflects the saved message immediately");

/* ============================================== 4. Cancel discards the draft */

await selectQuestion(0);
await ensureSectionOpen("validation-rules");
await page.click('[data-testid="validation-message-expand"]');
await page.waitForSelector('[data-testid="validation-message-modal"]');
await page.click('[data-testid="validation-message-modal"] .rte-surface');
await page.keyboard.press("Control+A");
await page.keyboard.type("This edit must never be saved.");
await page.click('[data-testid="validation-message-modal-cancel"]');
await page.waitForSelector('[data-testid="validation-message-modal"]', { state: "detached" });

def = await readDef();
rule = def.questions[0].validation[0];
assert.doesNotMatch(rule.message, /must never be saved/, `Cancel must discard the modal's draft: ${rule.message}`);
assert.match(rule.message, /Way too low/, "the message from the previous Save must still be there, untouched");
ok("Cancel discards the modal's draft — the previously saved message is untouched");

/* ===================================== 5. opening the modal on its own changes nothing */

const PLAIN_FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "ValidationMessageEditorPlain", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "SPEND", type: "numeric", text: "How much do you spend?",
      validation: [{ kind: "min_value", value: 100, message: "Please enter a value < 100." }],
    },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
};
await loadFixture(PLAIN_FIXTURE);
await selectQuestion(0);
await ensureSectionOpen("validation-rules");
await page.click('[data-testid="validation-message-expand"]');
await page.waitForSelector('[data-testid="validation-message-modal"]');
await page.click('[data-testid="validation-message-modal-save"]'); // Save with no edits made
await page.waitForSelector('[data-testid="validation-message-modal"]', { state: "detached" });

def = await readDef();
rule = def.questions[0].validation[0];
assert.equal(rule.messageFormat, undefined,
  `THE NO-OP GUARD, THROUGH THE NEW MODAL PATH: opening the modal and clicking Save without editing must not convert a plain message to markup — got messageFormat=${rule.messageFormat}`);
assert.equal(rule.message, "Please enter a value < 100.", "and the plain text, `<` and all, must be untouched");
ok("opening the modal and saving without editing does NOT convert a plain message to markup (the no-op guard holds for the new path too)");

/* ================================================== 6. nothing else moved */

// message position and piping-lint (pre-existing features) still present and wired
assert.ok(await page.$('[data-testid="validation-position"]'), "the message-position control is still there");
await page.fill('[data-testid="validation-rule"] [data-testid="validation-message"]', "You answered {{NOPE}}.");
await page.waitForTimeout(300);
assert.ok(await page.$('[data-testid="validation-message-piping-warning"]'), "the piping lint warning still fires from the (now bigger) box");
ok("message position and piping-lint — untouched by this fix — are still there and still work");

/* --------------------------------------------------------------- errors */
assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL VALIDATION MESSAGE EDITOR CHECKS PASSED (${passed})`);
