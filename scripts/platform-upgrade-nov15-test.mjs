/**
 * 15/11/2026 — research workspace positioning, answer-list rules, Publish, deletion protection — in the Studio.
 *
 *   SIGN-IN      the page says what the product is: an AI-assisted research workspace (design → report), not a
 *                "survey programming platform"; fits a phone
 *   LIST RULES   carry-forward, list logic, masking and list operations sit together, numbered in applied order,
 *                under an overview that states what is configured and flags a contradiction and an overlap
 *   PUBLISH      a Publish button is always in the top bar; the dialog says what is live; a refusal says the live
 *                link is unchanged; a success shows the live link with Copy; editing afterwards does not publish
 *   PROTECTION   with no live responses a delete deletes; with live responses deleting a question hides it, deleting
 *                an option hides it, and a JSON replace that drops a question keeps it hidden — with the two notices
 *
 *   node scripts/platform-upgrade-nov15-test.mjs      (Studio on :3000; set STUDIO_URL to override)
 *
 * The sandbox has no database: the three publish calls are answered by the test (page.route), and live responses are
 * declared with `window.__rescriptSandboxLive`. The server's own guard is unit-tested (lib/liveDataGuard.test.ts).
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const BRANDS = [{ code: 1, label: "Nike" }, { code: 2, label: "Adidas" }, { code: 3, label: "Puma" }];
const seed = {
  meta: { id: "sandbox", code: "SBX", title: "Workspace", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands do you know?", options: BRANDS, required: true },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which have you bought?", options: BRANDS, required: true },
    { id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", text: "Which would you consider?", options: BRANDS, required: true,
      listLogic: [{ id: "r1", sourceQuestionId: "q1", action: "include", which: "selected" }, { id: "r2", sourceQuestionId: "q1", action: "exclude", which: "selected" }],
      mask: { expr: { kind: "ref", questionId: "q2", selection: "selected" }, action: "remove" },
      optionPipeline: [{ id: "o1", kind: "difference", sources: [{ questionId: "q2", which: "selected" }] }] },
    { id: "q4", code: "Q4", variableName: "Q4", type: "single_select", text: "Overall?", options: [{ code: 1, label: "Good" }, { code: 2, label: "Fair" }, { code: 3, label: "Poor" }], required: true },
    { id: "t1", code: "T1", variableName: "T1", type: "html", text: "<p>Thank you</p>" },
  ],
  flow: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2", "q3", "q4", "t1"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { clientSlug: "acme", studySlug: "brand-2026", languages: ["en"], access: { mode: "open" } },
};
const browser = await chromium.launch();
const pageErrors = [];

console.log("\nSIGN-IN — what the product is");
{
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 800 } })).newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${STUDIO}/login`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForSelector('[data-testid="login-positioning"]');
  const text = await page.innerText("body");
  assert.doesNotMatch(text, /survey programming platform/i);
  assert.match(text, /AI-ASSISTED RESEARCH WORKSPACE/i);
  assert.match(await page.innerText('[data-testid="login-positioning"]'), /The AI-assisted research workspace/);
  assert.deepEqual(await page.$$eval('[data-testid="login-stages"] li strong', (els) => els.map((e) => e.textContent)), ["Design", "Program", "Collect", "Clean", "Analyze", "Report"]);
  const boxes = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const a = r('[data-testid="login-positioning"]'), c = r(".auth-card"); return { side: a.right <= c.left, sw: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
  assert.ok(boxes.side, "positioning beside the form on a desktop"); assert.equal(boxes.sw, 0);
  assert.ok(await page.$('input[type="password"]'), "the sign-in form is there");
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/login-desktop.png` });
  ok("the sign-in page presents an AI-assisted research workspace: design, program, collect, clean, analyze, report — beside the form");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth - document.documentElement.clientWidth, card: document.querySelector(".auth-card").getBoundingClientRect().width }));
  assert.equal(m.sw, 0); assert.ok(m.card <= 390);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/login-phone.png` });
  for (const path of ["/signup", "/forgot"]) {
    await page.goto(`${STUDIO}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector(".auth-brand");
    assert.match(await page.innerText(".auth-brand"), /AI-ASSISTED RESEARCH WORKSPACE/i, path);
  }
  ok("fits a phone (no sideways scroll); sign-up and forgot-password carry the same positioning");
  await page.close();
}

const openStudio = async (live) => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript(([s, live]) => { window.__rescriptSandboxSeed = s; if (live) window.__rescriptSandboxLive = true; }, [seed, live]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForSelector('[data-testid="qcard"]', { timeout: 60000 });
  return page;
};
const readDef = async (page) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await openTab(page, "Questions");
  await page.waitForSelector('[data-testid="qcard"]');
  return JSON.parse(json);
};
const card = (id) => `[data-testid="qcard"][data-qid="${id}"]`;
const select = async (page, id) => { if (!(await page.$(`${card(id)}.selected`))) await page.click(`${card(id)} [data-testid="qcard-toggle"]`); await page.waitForSelector(`${card(id)}.selected`); };

console.log("\nANSWER LIST RULES — one group, in applied order, overlaps named");
{
  const page = await openStudio(false);
  await select(page, "q3");
  await page.waitForSelector('[data-testid="answer-list-overview"]');
  const steps = await page.$$eval('[data-testid="alr-step"]', (els) => els.map((e) => [e.getAttribute("data-section"), e.textContent.trim()]));
  assert.deepEqual(steps.map((s) => s[0]), ["list-logic", "list-logic", "masking", "list-operations"]);
  assert.match(steps[0][1], /Keeps only the options selected at Q1/);
  assert.match(steps[2][1], /^3Removes /);
  const notes = await page.$$eval('[data-testid="alr-note"]', (els) => els.map((e) => [e.getAttribute("data-level"), e.textContent]));
  assert.ok(notes.some(([l, t]) => l === "conflict" && /nothing would be left/.test(t)), "keep-only + remove on the same answers");
  assert.ok(notes.some(([l, t]) => l === "overlap" && /both decide which options are shown/.test(t)), "masking + a set-style list step");
  ok("the overview lists the four configured rules in applied order in plain words, and flags the contradiction and the overlap");
  const order = await page.evaluate(() => ["answer-list-overview", "psec-carry-forward", "psec-list-logic", "psec-masking", "psec-list-operations"].map((t) => Math.round(document.querySelector(`[data-testid="${t}"]`).getBoundingClientRect().top)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "overview, then the four tools in order, adjacent");
  const titles = await page.$$eval('[data-testid^="psec-head-"]', (els) => els.map((e) => e.textContent.replace(/[▸▾●]/g, "").trim()).filter((t) => /^[1-4] · /.test(t)));
  assert.deepEqual(titles, ["1 · Copy the list from another question (carry-forward)", "2 · Keep, remove or reorder by an earlier answer (list logic)", "3 · Show a calculated set (masking)", "4 · Extra list steps (list operations)"]);
  ok("the four sections are adjacent, numbered 1–4 and named for what they do (technical name in brackets)");
  /* fix the contradiction from the section the note opens */
  await page.locator('[data-testid="alr-note"][data-level="conflict"] button').first().click();
  await page.waitForSelector('[data-testid="psec-body-list-logic"]');
  await page.click('[data-testid="list-logic-strip"] button');
  await page.waitForSelector('[data-testid="logic-dialog"]');
  await page.locator('[data-testid="logic-dialog"] [data-testid="list-logic-remove"]').nth(1).click();
  await page.click('[data-testid="logic-dialog-save"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="alr-note"][data-level="conflict"]'));
  assert.equal(await page.locator('[data-testid="alr-step"]').count(), 3);
  assert.equal((await readDef(page)).questions[2].listLogic.length, 1);
  ok("the note opens the section; removing the contradictory rule clears the conflict and the overview follows");
  await select(page, "q4");
  await page.waitForSelector('[data-testid="alr-plain"]');
  assert.match(await page.innerText('[data-testid="answer-list-overview"]'), /shows its own options, as written/);
  assert.equal(await page.locator('[data-testid^="alr-tool-"]').count(), 4);
  /* the four tools sit behind "Something else?" since 2026-11-13 — the goal builder comes first */
  assert.ok(await page.isVisible('[data-testid="alr-goal"]'), "a plain question offers the goal builder first");
  await page.click('[data-testid="alr-guide"] > summary');
  await page.click('[data-testid="alr-tool-list-logic"]');
  await page.waitForSelector('[data-testid="psec-body-list-logic"] [data-testid="list-logic-strip"]');
  ok("a question with no rules says so and offers “Which one do I need?” — each choice opens its section");
  await page.close();
}

console.log("\nPUBLISH — the button, the dialog, the link, draft vs live");
{
  const page = await openStudio(false);
  let deployed = null, versionCalls = 0, deployCalls = 0, refuse = true;
  await page.route("**/api/surveys/sandbox/publish", (r) => r.fulfill({ json: { deployments: deployed ? [{ mode: "live", versionId: "v2", version: deployed, client_slug: "acme", study_slug: "brand-2026" }] : [] } }));
  await page.route("**/api/surveys/sandbox/versions", (r) => {
    if (r.request().method() !== "POST") return r.continue();
    versionCalls++;
    if (refuse) return r.fulfill({ status: 500, json: { error: "The database could not be reached." } });
    return r.fulfill({ json: { id: "v2", version: "1.1", variables: 12, revision: 2, lint: { status: "ok", errors: 0, warnings: 0, summary: "ok" } } });
  });
  await page.route("**/api/surveys/sandbox/deploy", (r) => { deployCalls++; deployed = "1.1"; return r.fulfill({ json: { ok: true, url: "https://survey.example/s/acme/brand-2026", lint: null, readiness: null } }); });

  assert.ok(await page.isVisible('[data-testid="publish-open"]'), "Publish is in the top bar of a survey that was never published");
  assert.equal(await page.$('[data-testid="publish-bar"]'), null);
  await page.click('[data-testid="publish-open"]');
  await page.waitForSelector('[data-testid="publish-dialog"]');
  assert.match(await page.innerText('[data-testid="publish-live-now"]'), /Not published yet/);
  assert.match(await page.innerText('[data-testid="publish-dialog"]'), /edits stay in Preview and Test Survey/);
  assert.equal(versionCalls, 0, "opening the dialog publishes nothing");
  ok("Publish is always visible; the dialog says nothing is live yet and that edits stay in Preview / Test until published");

  await page.click('[data-testid="publish-confirm"]');
  await page.waitForSelector('[data-testid="publish-failed"]');
  assert.match(await page.innerText('[data-testid="publish-failed"]'), /Not published\..*Nothing was made live/s);
  assert.equal(deployCalls, 0, "a version that could not be saved is not deployed");
  ok("a refused publish says so and that nothing was made live; the live link is not touched");

  refuse = false;
  await page.click('[data-testid="publish-confirm"]');
  await page.waitForSelector('[data-testid="publish-done"]');
  assert.match(await page.innerText('[data-testid="publish-done"]'), /Your survey is live.*Version 1\.1/s);
  const url = await page.inputValue('[data-testid="publish-url"]');
  assert.match(url, /\/s\/acme\/brand-2026$/);
  await page.click('[data-testid="publish-copy"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="publish-copy"]').textContent === "Copied");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url, "the link is on the clipboard");
  assert.match(await page.innerText('[data-testid="publish-separation"]'), /edits appear in Preview and Test Survey only.*until you press Publish again/s);
  assert.equal(await page.getAttribute('[data-testid="publish-open-live"]', "href"), url);
  assert.equal(deployCalls, 1);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/publish-done.png` });
  ok("a successful publish shows “Your survey is live”, the live link, Copy link (on the clipboard) and the draft-vs-live note");
  await page.click('[data-testid="publish-close"]');

  /* editing after publishing sends nothing to the live link */
  const before = { versionCalls, deployCalls };
  await select(page, "q4");
  await page.fill(`${card("q4")} [data-testid="question-code"]`, "Q4");
  const ed = page.locator(`${card("q4")} [contenteditable="true"]`).first();
  await ed.click(); await page.keyboard.type(" (edited)");
  await page.click(`${card("q4")} [data-testid="question-code"]`);
  await page.waitForTimeout(1500);
  assert.match((await readDef(page)).questions.find((q) => q.id === "q4").text, /edited/);
  assert.deepEqual({ versionCalls, deployCalls }, before, "no version is cut and nothing is deployed by editing");
  await page.click('[data-testid="publish-open"]');
  await page.waitForSelector('[data-testid="publish-dialog"]');
  assert.match(await page.innerText('[data-testid="publish-live-now"]'), /version 1\.1/);
  assert.match(await page.innerText('[data-testid="publish-dialog"]'), /replacing version 1\.1 on the same link/);
  await page.click('[data-testid="publish-cancel"]');
  assert.deepEqual({ versionCalls, deployCalls }, before);
  ok("an edit after publishing reaches the draft only: no version cut, no deploy; the dialog shows version 1.1 still live until Publish is pressed");
  await page.close();
}

console.log("\nDELETION PROTECTION — hide instead of delete once live responses exist");
{
  /* A: no live responses — delete deletes */
  const a = await openStudio(false);
  await a.click(`${card("q4")} [data-testid="delete-question"]`);
  await a.waitForSelector('[data-testid="delete-question-dialog"]');
  assert.equal(await a.getAttribute('[data-testid="delete-question-dialog"]', "data-mode"), null);
  await a.click('[data-testid="delete-question-confirm"]');
  await a.waitForFunction(() => document.querySelectorAll('[data-testid="qcard"]').length === 4);
  assert.equal((await readDef(a)).questions.some((q) => q.id === "q4"), false);
  assert.equal(await a.$('[data-testid="data-protect-notice"]'), null);
  ok("no live responses: deleting a question deletes it, as before");
  await a.close();

  /* B: live responses */
  const page = await openStudio(true);
  await page.click(`${card("q4")} [data-testid="delete-question"]`);
  await page.waitForSelector('[data-testid="delete-question-dialog"][data-mode="hide"]');
  assert.match(await page.innerText('[data-testid="delete-hide-notice"]'), /This survey is live and already contains responses\. This element cannot be permanently deleted because it may be associated with existing response data\. We recommend hiding it instead\./);
  await page.click('[data-testid="delete-question-confirm"]');
  await page.waitForSelector('[data-testid="data-protect-notice"]');
  assert.match(await page.innerText('[data-testid="data-protect-done"]'), /This element has been hidden successfully\. Existing response data has been preserved\./);
  let d = await readDef(page);
  const q4 = d.questions.find((q) => q.id === "q4");
  assert.ok(q4 && q4.settings.hidden === true, "Q4 is still in the definition, hidden");
  assert.equal(q4.options.length, 3); assert.equal(q4.variableName, "Q4");
  assert.ok(d.flow[0].questionIds.includes("q4"));
  assert.equal(await page.locator('[data-testid="qcard"]').count(), 5, "it is still listed in the editor");
  ok("live responses: Delete on a question explains why, hides it, and says so — the question, its variable and codes stay");
  await page.click('[data-testid="data-protect-close"]');

  /* an option */
  await select(page, "q1");
  await page.locator(`${card("q1")} button.btn.small.danger:has-text("×")`).nth(2).click();
  await page.waitForSelector('[data-testid="data-protect-notice"]');
  assert.match(await page.innerText('[data-testid="data-protect-what"]'), /option “Adidas” \(2\) of Q1/);
  d = await readDef(page);
  assert.deepEqual(d.questions[0].options.map((o) => [o.code, o.logic?.visibility ?? "shown"]), [[1, "shown"], [2, "always_hide"], [3, "shown"]]);
  ok("deleting an answer option keeps it with “always hide”: code 2 keeps its label, respondents no longer see it");
  await page.click('[data-testid="data-protect-close"]');

  /* wording is still editable; a display-only block is still deletable */
  await select(page, "q2");
  const ed = page.locator(`${card("q2")} [contenteditable="true"]`).first();
  await ed.click(); await page.keyboard.type(" Please tick all.");
  await page.click(`${card("q2")} [data-testid="question-code"]`);
  await page.click(`${card("t1")} [data-testid="delete-question"]`);
  await page.waitForSelector('[data-testid="delete-question-dialog"]');
  assert.equal(await page.getAttribute('[data-testid="delete-question-dialog"]', "data-mode"), null, "a text block holds no data");
  await page.click('[data-testid="delete-question-confirm"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="qcard"]').length === 4);
  d = await readDef(page);
  assert.match(d.questions.find((q) => q.id === "q2").text, /Please tick all/);
  assert.equal(d.questions.some((q) => q.id === "t1"), false);
  assert.equal(await page.$('[data-testid="data-protect-notice"]'), null);
  ok("wording stays editable, and a display-only text block (no data) is still deleted");

  /* every other way in: replacing the definition through JSON */
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  const cut = { ...d, questions: d.questions.filter((q) => q.id !== "q3"), flow: [{ ...d.flow[0], questionIds: d.flow[0].questionIds.filter((x) => x !== "q3") }, d.flow[1]] };
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(cut));
  await page.click('button:has-text("validate & apply")');
  await page.waitForSelector('[data-testid="data-protect-notice"]');
  assert.match(await page.innerText('[data-testid="data-protect-what"]'), /question Q3/);
  await openTab(page, "Questions");
  d = await readDef(page);
  const q3 = d.questions.find((q) => q.id === "q3");
  assert.ok(q3 && q3.settings.hidden === true);
  assert.deepEqual(d.flow[0].questionIds, ["q1", "q2", "q3", "q4"], "back in its place in the page");
  ok("a JSON replace that drops a question keeps it too (hidden, in its place) — the rule is on every edit, not on one button");
  await page.close();
}

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\n15/11 PLATFORM UPGRADE: ${passed} checks passed`);
