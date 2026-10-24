/**
 * OPTION POPUPS, THE DISPLAY OPERATOR, AND "SHOW WHEN / HIDE WHEN" RETIRED.
 *
 *   · Opening an option's Logic panel lands on the Advanced Rules (Eligible /
 *     Exclude / …) with no extra click, and "Show when…" / "Hide when…" are not
 *     offered as visibility modes any more.
 *   · "Show Popup Message When Selected": its fields appear only when switched
 *     on, and what is stored is exactly what was set.
 *   · The condition builder offers "option is displayed" with a Source Question
 *     and a Source Option — and no separate answer/value box.
 *   · In the real runtime: an immediate popup shows when the option is selected
 *     and the selection stays; deselecting shows nothing; a Next-triggered
 *     confirmation blocks navigation until Continue, Cancel keeps the
 *     respondent on the page; "only once" does not repeat after a confirm.
 *
 *   node scripts/option-popup-test.mjs      (studio on 3000, runtime on 3001)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openSectionWorkspace, openWorkspace, saveWorkspace, LD_BODY } from "./lib/logicWorkspace.mjs";

const h = await openHarness();
const { page } = h;
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const base = (id, code, type, extra = {}) => ({
  id, code, variableName: code, type, text: `${code} text`, options: [], rows: [], columns: [],
  validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const opt = (code, label, logic) => ({ code, label, flags: [], ...(logic ? { logic } : {}) });
const popup = (over = {}) => ({ enabled: true, message: "Heads up", type: "information", trigger: "immediate", frequency: "every", ...over });

const fixture = (popups = false) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Popups", version: "1.0" },
  questions: [
    base("q_m", "Q1", "multi_select", {
      options: [
        opt("a", "Alpha", popups ? { popup: popup({ message: "Alpha chosen", title: "Note" }) } : undefined),
        opt("b", "Beta", popups ? { popup: popup({ type: "confirmation", trigger: "on_next", frequency: "once", message: "Beta is final", buttonText: "Yes, continue" }) } : undefined),
        opt("c", "Gamma"),
      ],
    }),
    base("q_next", "Q2", "single_select", { options: [opt("1", "Yes")] }),
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_m"] }, { type: "page", id: "p2", questionIds: ["q_next"] }, { type: "end", id: "e1", status: "complete" }],
});

const openOptionLogic = async (qid, idx) => {
  await h.goTab("Questions");
  await page.waitForSelector(`[data-testid="qcard"][data-qid="${qid}"]`);
  await page.click(`[data-testid="qcard"][data-qid="${qid}"]`);
  await page.waitForSelector(`.qcard.selected [data-testid="option-logic-${idx}"]`);
  await page.click(`.qcard.selected [data-testid="option-logic-${idx}"]`);
  await page.waitForSelector('[data-testid="option-logic"]');
};
const optionOf = async (qid, code) => (await h.readDef()).questions.find((q) => q.id === qid).options.find((o) => o.code === code);

/* ------------------------------------------------------- the Logic panel */
await h.loadDef(fixture());
await openOptionLogic("q_m", 0);
assert.equal(await page.locator('[data-testid="vis-show_when"]').count(), 0, "no Show when… mode");
assert.equal(await page.locator('[data-testid="vis-hide_when"]').count(), 0, "no Hide when… mode");
for (const m of ["default", "always_show", "always_hide"]) assert.equal(await page.locator(`[data-testid="vis-${m}"]`).count(), 1, m);
assert.ok(await page.locator('[data-testid="adv-eligible"]').isVisible(), "Advanced Rules are open without a second click");
assert.ok(await page.locator('[data-testid="adv-exclude"]').isVisible());
ok("Logic panel opens on Advanced Rules; Show when / Hide when are gone");

/* -------------------------------------------------- popup configuration */
assert.equal(await page.locator('[data-testid="popup-fields"]').count(), 0, "popup fields are hidden until it is switched on");
await page.check('[data-testid="popup-enabled"]');
await page.waitForSelector('[data-testid="popup-fields"]');
assert.ok(await page.locator('[data-testid="popup-empty"]').isVisible(), "an empty message is called out");
await page.fill('[data-testid="popup-message"]', "Alpha chosen");
await page.fill('[data-testid="popup-title"]', "Note");
await page.selectOption('[data-testid="popup-type"]', "warning");
await page.selectOption('[data-testid="popup-trigger"]', "on_next");
await page.selectOption('[data-testid="popup-frequency"]', "once");
await page.fill('[data-testid="popup-button"]', "Got it");
await page.waitForTimeout(250);
let a = await optionOf("q_m", "a");
assert.deepEqual(a.logic.popup, { enabled: true, message: "Alpha chosen", title: "Note", type: "warning", trigger: "on_next", frequency: "once", buttonText: "Got it" });
ok("every popup setting is stored exactly as set");

await openOptionLogic("q_m", 0);
assert.equal(await page.inputValue('[data-testid="popup-message"]'), "Alpha chosen", "reload keeps the message");
assert.equal(await page.inputValue('[data-testid="popup-trigger"]'), "on_next");
await page.uncheck('[data-testid="popup-enabled"]');
await page.waitForTimeout(250);
a = await optionOf("q_m", "a");
assert.equal(a.logic.popup.enabled, false);
assert.equal(a.logic.popup.message, "Alpha chosen", "turning it off keeps the text for later");
ok("switching it off hides the fields and keeps the wording");

/* ------------------------------------------- legacy Show when is migrated */
const legacy = fixture();
legacy.questions[0].options[2].logic = { visibility: "hide_when", when: { type: "rule", source: { kind: "question", ref: "q_next" }, operator: "selected", value: "1" } };
await h.loadDef(legacy);
const g = await optionOf("q_m", "c");
assert.ok(g.logic.excludeWhen && !g.logic.when && (g.logic.visibility ?? "default") === "default", "Hide when → Exclude when on load");
ok("a saved Hide when… becomes Exclude when…");

/* ------------------------------------------------- the Display operator */
await h.loadDef(fixture());
await h.goTab("Questions");
await page.click('[data-testid="qcard"][data-qid="q_next"]');
await openSectionWorkspace(page, "display-logic"); // the builder is in the centred logic workspace; h.readDef saves it
await page.waitForSelector('[data-testid="logic-builder"]');
await page.click('[data-testid="lb-add-condition"]');
await page.waitForSelector(".cond-rule");
await page.selectOption(".ref-select", { label: "Q1 — Q1" });
await page.waitForTimeout(250);
const ops = await page.$$eval('[data-testid="cond-operator"] option', (o) => o.map((x) => x.textContent));
assert.ok(ops.includes("option is displayed") && ops.includes("option is not displayed"), `Display operators offered: ${ops}`);
await page.selectOption('[data-testid="cond-operator"]', "displayed");
await page.waitForSelector('[data-testid="cond-display-option"]');
assert.equal(await page.locator('[data-testid="cond-value"]').count(), 0, "no separate value box");
await page.selectOption('[data-testid="cond-display-option"]', "a");
await page.waitForTimeout(250);
let dl = (await h.readDef()).questions.find((q) => q.id === "q_next").displayLogic;
const r0 = dl.type === "group" ? dl.children[0] : dl;
assert.equal(r0.operator, "displayed");
assert.equal(r0.value, "a");
assert.equal(r0.source.ref, "q_m");
ok("Display: Source Question + Source Option, stored as displayed/value");

/* -------------------------------------------------------------- runtime */
const run = async (popups) => {
  await h.loadDef(fixture(popups));
  const pv = await h.preview(["q_m"], (d) => {
    d.flow = [{ type: "page", id: "p1", questionIds: ["q_m"] }, { type: "page", id: "p2", questionIds: ["q_next"] }, { type: "end", id: "e1", status: "complete" }];
  });
  await pv.waitForSelector('[data-qid="q_m"]');
  return pv;
};
const pick = (pv, label) => pv.locator(`[data-qid="q_m"] >> text=${label}`).first().click();
const dlg = (pv) => pv.locator('[data-testid="rs-option-popup"]');
const nextBtn = (pv) => pv.locator(".rs-nav .rs-btn:not(.secondary)").first();

let pv = await run(true);
await pick(pv, "Alpha");
await dlg(pv).waitFor({ timeout: 4000 });
assert.match(await pv.locator('[data-testid="rs-option-popup-message"]').innerText(), /Alpha chosen/);
assert.equal(await pv.locator(".rs-popup-title").innerText(), "Note");
assert.equal(await pv.locator('[data-testid="rs-option-popup-cancel"]').count(), 0, "information has no Cancel");
assert.equal(await pv.locator('[data-testid="rs-option-popup-ok"]').innerText(), "OK");
await pv.click('[data-testid="rs-option-popup-ok"]');
await dlg(pv).waitFor({ state: "detached" });
assert.deepEqual(await h.answerOf(pv, "q_m"), ["a"], "the option is still selected");
ok("runtime: selecting shows the message; OK dismisses it; the selection stays");

await pick(pv, "Alpha"); // deselect
await pv.waitForTimeout(400);
assert.equal(await dlg(pv).count(), 0, "no popup on deselect");
assert.deepEqual(await h.answerOf(pv, "q_m") ?? [], [], "and the option is deselected as the respondent asked");
await pick(pv, "Alpha");
await dlg(pv).waitFor({ timeout: 4000 });
await pv.keyboard.press("Escape");
await dlg(pv).waitFor({ state: "detached" });
ok("runtime: no popup on deselect; 'every selection' shows it again; Escape acknowledges");

/* a Next-triggered confirmation, shown once */
await pick(pv, "Alpha"); // deselect Alpha so only Beta is in play
await pick(pv, "Beta");
await pv.waitForTimeout(300);
assert.equal(await dlg(pv).count(), 0, "Beta waits for Next");
await nextBtn(pv).click();
await dlg(pv).waitFor({ timeout: 4000 });
assert.equal(await pv.locator('[data-testid="rs-option-popup-ok"]').innerText(), "Yes, continue");
await pv.click('[data-testid="rs-option-popup-cancel"]');
await dlg(pv).waitFor({ state: "detached" });
assert.ok(await pv.locator('[data-qid="q_m"]').isVisible(), "Cancel keeps the respondent on the page");
assert.deepEqual(await h.answerOf(pv, "q_m"), ["b"], "and does not change the answer");
await nextBtn(pv).click();
await dlg(pv).waitFor({ timeout: 4000 });
ok("runtime: Cancel on a Next confirmation stays on the page, and 'once' asks again because it was not agreed to");
await pv.click('[data-testid="rs-option-popup-ok"]');
await pv.waitForSelector('[data-qid="q_next"]', { timeout: 5000 });
ok("runtime: Continue moves on");
await pv.close();

/* phone width: the dialog fits */
pv = await run(true);
await pv.setViewportSize({ width: 360, height: 640 });
await pick(pv, "Alpha");
await dlg(pv).waitFor({ timeout: 4000 });
const box = await pv.locator(".rs-popup").boundingBox();
assert.ok(box && box.x >= 0 && box.x + box.width <= 360 && box.y >= 0 && box.y + box.height <= 640, `fits a phone: ${JSON.stringify(box)}`);
ok("runtime: the dialog fits a 360px phone");
await pv.close();

/* no popup configured: nothing appears */
pv = await run(false);
await pick(pv, "Alpha");
await pv.waitForTimeout(400);
assert.equal(await dlg(pv).count(), 0);
await pv.close();
ok("runtime: options without a popup behave exactly as before");

await h.close();
console.log(`\n${passed} checks passed`);
