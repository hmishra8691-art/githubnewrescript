/**
 * Shared harness for the variant-family browser suites.
 *
 *   const h = await openHarness();
 *   const q = await h.createFromPicker("single_select", "single_select.icon_select");
 *   await h.setQuestion(q.id, (q) => { q.options = [...] });
 *   const pv = await h.preview([q.id]);          // runtime page showing just those questions
 *   await pv.click(...); h.answerOf(pv, q.id) ...
 *   await h.close();
 *
 * Every family suite proves the same three things per variant: the picker
 * offers it as stable and creates the right base type + renderer; the runtime
 * renders it and a respondent can answer it; the answer lands in the shape
 * the response model promises.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab } from "./nav.mjs";
import assert from "node:assert/strict";
import { openPreview } from "./preview.mjs";

export { assert };

export async function openHarness({
  studio = process.env.STUDIO_URL ?? "http://localhost:3000",
  runtime = process.env.RUNTIME_URL ?? "http://localhost:3001",
} = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
  page.on("pageerror", (e) => console.error("STUDIO PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());

  const goTab = async (name) => { await openTab(page, `${name}`); await page.waitForTimeout(150); };
  const readDef = async () => {
    await goTab("JSON");
    await page.waitForSelector("textarea.code");
    return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  };
  const loadDef = async (def) => {
    await goTab("JSON");
    await page.waitForSelector("textarea.code");
    await page.click('button:has-text("edit")');
    await page.fill("textarea.code", JSON.stringify(def, null, 2));
    await page.click('button:has-text("validate & apply")');
    await page.waitForTimeout(400);
  };

  await page.goto(`${studio}/sandbox`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  // start from a clean, minimal survey
  await loadDef({
    meta: { id: "sandbox", code: "SANDBOX", title: "Variants", version: "1.0" },
    questions: [],
    flow: [{ type: "page", id: "p1", title: "Page 1", questionIds: [] }, { type: "end", id: "e1", status: "complete" }],
  });

  /** Open the picker, choose a family and a variant; returns the created question. */
  const createFromPicker = async (family, variantId) => {
    /*
     * WHICH question was just created, identified by id rather than by
     * position. `questions[length - 1]` worked only while that array kept
     * creation order; it is now kept in FLOW order — one question order for
     * the whole platform — so a question created above another is not last.
     * See claude/schema-integrity.md.
     */
    const idsBefore = new Set((await readDef()).questions.map((q) => q.id));
    await goTab("Questions");
    await page.waitForSelector('[data-testid="add-question-top"]');
    await page.click('[data-testid="add-question-top"]');
    await page.waitForSelector(`[data-testid="picker-family-${family}"]`);
    await page.click(`[data-testid="picker-family-${family}"]`);
    const card = await page.waitForSelector(`[data-testid="picker-variant-${variantId}"]`);
    const status = await card.getAttribute("data-status");
    assert.equal(status, "stable", `${variantId} is offered as stable, not "coming soon"`);
    await card.click();
    await page.waitForTimeout(300);
    // close whatever opened so the next pick starts clean
    await page.click('[data-testid="close-question"]').catch(() => {});
    const def = await readDef();
    const q = def.questions.find((x) => !idsBefore.has(x.id));
    assert.ok(q, "a question was created");
    assert.equal(q.variant, variantId, "the created question stores the variant id");
    return q;
  };

  /** Mutate one question in the definition (through the JSON tab) and reapply. */
  const setQuestion = async (id, mutate) => {
    const def = await readDef();
    const q = def.questions.find((x) => x.id === id);
    assert.ok(q, `question ${id} exists`);
    mutate(q, def);
    await loadDef(def);
    return def;
  };

  /** Open a runtime preview showing only the given questions on one page. */
  const preview = async (questionIds, mutateDef) => {
    const def = await readDef();
    def.flow = [{ type: "page", id: "p1", questionIds }, { type: "end", id: "e1", status: "complete" }];
    mutateDef?.(def);
    /*
     * `openPreview` re-sends the definition until the page renders. The one
     * post this used to do could land before /preview had hydrated its
     * `message` listener, in which case it was lost and the suite died on a
     * selector timeout — rare on its own, reliable enough in a 54-suite run to
     * have failed two of them. See scripts/lib/preview.mjs.
     */
    return openPreview(browser, runtime, { definition: def });
  };

  /** The runtime's current answer for a question, read from the debug snapshot. */
  const answerOf = async (pv, qid) => {
    return pv.evaluate((id) => {
      const w = window;
      const st = w.__rescriptState ?? w.__RESCRIPT_STATE__;
      return st ? st.answers?.[id] : undefined;
    }, qid);
  };

  const next = async (pv) => { await pv.click(".rs-nav .rs-btn:not(.secondary)"); await pv.waitForTimeout(250); };

  return { browser, page, goTab, readDef, loadDef, createFromPicker, setQuestion, preview, answerOf, next,
    close: () => browser.close() };
}
