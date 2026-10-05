/**
 * THE CHANGE REVIEW, CONTEXT ACTIONS AND THE DEPENDENCY MAP (Intelligent
 * Mode upgrade, Phase 4 — the audit's R13, R14, R15).
 *
 *   (a) a proposal of two steps — "Make Q3 required" read by the engine, then
 *       a (fake) model reply touching seven questions and their options — is
 *       reviewed as one card per question (code · type · text, a count,
 *       collapsed when there are many), option rows "Option 4 — United
 *       States", old above new, an Impact header with a count whose list
 *       navigates, and rows' affected lists that navigate
 *   (b) unticking the removal of Q5's "None of these" excludes it (and only
 *       it), the button reads "Apply N of M changes", Apply writes everything
 *       else and NOT the removal, and History says one change was left out;
 *       unticking one row of an action that made two takes both, and says so
 *   (c) hovering or focusing an option row previews the option: its code,
 *       flags and what depends on it
 *   (d) nothing scrolls sideways at panel widths 260, 360 and 520 px — the
 *       tab strip wraps, values wrap and clamp, technical details wrap —
 *       with a URL-like option label and a long condition in the proposal
 *   (e) selecting a question with no proposal open turns the panel to the
 *       Inspector, with "Actions for Q…" holding only that object's valid
 *       groups; a ready action produces an engine proposal, a template fills
 *       the input box
 *   (f) the dependency map lists Q7's dependents by kind and navigates
 *
 *   node scripts/change-review-test.mjs      (studio on 3000, AI_API_URL=fake:)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id, code, variableName, type, text, extra = {}) => ({ id, code, variableName, type, text, ...extra });
const rule = (ref, operator, value) => ({ type: "rule", source: { kind: "question", ref }, operator, value });

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Car study", version: "1.0" },
  questions: [
    q("gender", "Q1", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female") }),
    q("age", "Q2", "AGE", "numeric", "How old are you?"),
    q("city", "Q3", "CITY", "open_text", "Which city do you live in?"),
    q("aware", "Q4", "AWARE", "single_select", "Have you heard of our brand?", { options: opts("Yes", "No") }),
    q("brands", "Q5", "BRANDS", "multi_select", "Which of these brands have you bought?", { options: [...opts("Brand A", "Brand B", "Brand C"), { code: 99, label: "None of these", flags: ["exclusive"] }] }),
    q("sat", "Q6", "SAT", "single_select", "How satisfied are you overall?", { options: opts("1", "2", "3", "4", "5") }),
    q("own", "Q7", "OWN", "single_select", "Do you own a car?", { options: opts("Yes", "No", "Leasing", "United Sates") }),
    // Q8 reads Q7's options 1 and 4 — so option 4 has a dependent to preview
    q("make", "Q8", "MAKE", "open_text", "What make is your car?", { displayLogic: { type: "group", op: "or", children: [rule("own", "eq", 1), rule("own", "eq", 4)] } }),
    q("caryear", "Q9", "CARYEAR", "numeric", "What year was your car made?"),
    q("pref", "Q10", "PREF", "single_select", "Where did you buy it?", { options: opts("Dealer", "Private seller", "Online") }),
    q("km", "Q11", "KM", "numeric", "How many km a year do you drive your car?"),
    // Q12 reads Q11 — deleting Q11 has an impact
    q("insure", "Q12", "INSURE", "single_select", "Is your car insured?", { options: opts("Yes", "No"), displayLogic: rule("km", "gt", 10000) }),
  ],
  flow: [
    { type: "block", id: "b0", title: "About you", children: [{ type: "page", id: "p0", questionIds: ["gender", "age", "city"] }] },
    { type: "block", id: "b1", title: "Brands", children: [{ type: "page", id: "p1", questionIds: ["aware", "brands", "sat"] }] },
    { type: "block", id: "b2", title: "Cars", children: [{ type: "page", id: "p2", questionIds: ["own"] }, { type: "page", id: "p3", questionIds: ["make", "caryear", "pref"] }, { type: "page", id: "p4", questionIds: ["km", "insure"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};
const URL_LABEL = "https://www.example-car-marketplace-with-a-very-long-domain-name.com/listings/used/hatchback?utm_source=rescript&utm_medium=survey&utm_campaign=autumn";
const LONG_CONDITION = '(Q7 = 1 OR Q7 = 3) AND Q2 > 25 AND (Q1 = 1 OR Q1 = 2) AND Q4 = 1 AND NOT Q3 = "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch-and-somewhere-else"';
/* the model's step: seven actions (flat indexes 1–7 after the engine's "Make Q3 required", index 0) */
const STEP2 = [
  { op: "update_option", target: "Q7", option: 4, label: "United States" },
  { op: "set_display_logic", target: "Q9", expression: LONG_CONDITION },
  { op: "add_skip", from: "Q7", when: "Q7 = 2", to: "Q12" },
  { op: "update_question", target: "Q5", removeOptions: [99] },
  { op: "update_option", target: "Q10", option: 3, label: URL_LABEL },
  { op: "delete_question", target: "Q11" },
  { op: "update_question", target: "Q4", text: "Have you ever heard of our brand?", required: true },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());
const modelCalls = [];
page.on("request", (r) => { if (/\/api\/(?:copilot\/turn|ai\/logic)\b/.test(r.url())) modelCalls.push(r.url()); });

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const def = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  await intelligent();
  return def;
};
const say = async (message) => {
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', message);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  return (await page.$$('[data-testid="cp-turn"]')).at(-1);
};
const tab = () => page.getAttribute('[data-testid="cp-panel"]', "data-tab");
const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const card = (code) => `[data-testid="cp-qcard"][data-code="${code}"]`;
const row = (code, category) => `${card(code)} [data-testid="cp-row"][data-category="${category}"]`;
const openCard = async (code) => { if ((await page.getAttribute(card(code), "data-open")) !== "true") await page.click(`${card(code)} [data-testid="cp-qcard-toggle"]`); await page.waitForSelector(`${card(code)}[data-open="true"] [data-testid="cp-row"]`); };
const selected = () => page.$eval('[data-testid="cp-sp-q"].sel', (e) => e.dataset.code).catch(() => null);
const applyLabel = () => text('[data-testid="cp-panel-apply"]');

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
await intelligent();
ok("fixture loaded: 12 questions — Q8 reads Q7's options 1 and 4, Q12 reads Q11");

/* ------------------------------------------------ (a) the review: cards, rows, impact */
{
  const t1 = await say("Make Q3 required");
  assert.ok(await t1.$('[data-testid="cp-engine"]'), "the engine read the first step");
  assert.equal(modelCalls.length, 0);
  await page.evaluate((r) => window.__rescriptCopilotFake(r), { kind: "proposal", reply: "Fixed the typo in Q7, tidied the car logic, removed None from Q5 and dropped Q11.", actions: STEP2 });
  const t2 = await say("Tidy up the car questions and fix the typos in the options");
  assert.equal(await t2.$('[data-testid="cp-engine"]'), null, "the second step went to the (fake) model");
  assert.equal(await t2.getAttribute("data-proposal"), "open");
  assert.equal(modelCalls.length, 1);
  assert.equal(await tab(), "changes");
  assert.match(await text('[data-testid="cp-steps"]'), /^2 requests/);
  await page.waitForSelector('[data-testid="cp-modified"] [data-testid="cp-qcard"]');
  const cards = await page.$$eval('[data-testid="cp-qcard"]', (cs) => cs.map((c) => [c.dataset.code, c.dataset.open]));
  assert.deepEqual(cards.map((c) => c[0]).sort(), ["Q10", "Q11", "Q12", "Q3", "Q4", "Q5", "Q7", "Q9"], JSON.stringify(cards));
  assert.ok(cards.every((c) => c[1] === "false"), "eight cards: collapsed by default — headers first");
  assert.deepEqual(cards.slice(0, 3).map((c) => c[0]), ["Q3", "Q4", "Q5"], "in survey order");
  assert.equal(cards.at(-1)[0], "Q11", "the removed question after the ones that stay");
  // the header: code · type · text, on one line
  assert.equal(await text(`${card("Q7")} [data-testid="cp-qcard-title"]`), "Q7 · Single choice · Do you own a car?");
  assert.equal(await text(`${card("Q9")} [data-testid="cp-qcard-type"]`), "Number");
  assert.equal(await text(`${card("Q7")} [data-testid="cp-qcard-count"]`), "2");
  assert.equal(await page.$eval(`${card("Q7")} [data-testid="cp-qcard-title"]`, (e) => getComputedStyle(e).whiteSpace), "nowrap");
  // option rows: "Option 4 — United States", old above new
  await openCard("Q7");
  assert.equal(await text(`${row("Q7", "Option label")} [data-testid="cp-row-option"]`), "Option 4 — United States");
  assert.equal(await text(`${row("Q7", "Option label")} [data-testid="cp-row-from"] [data-testid="cp-val"]`), "United Sates");
  assert.equal(await text(`${row("Q7", "Option label")} [data-testid="cp-row-to"] [data-testid="cp-val"]`), "United States");
  assert.equal(await text(`${row("Q7", "Option label")} [data-testid="cp-row-cat"]`), "Option label");
  assert.equal(await text(`${row("Q7", "Option label")} [data-testid="cp-row-status"]`), "Proposed");
  const fromBox = await page.$eval(`${row("Q7", "Option label")} [data-testid="cp-row-from"]`, (e) => e.getBoundingClientRect().top);
  const toBox = await page.$eval(`${row("Q7", "Option label")} [data-testid="cp-row-to"]`, (e) => e.getBoundingClientRect().top);
  assert.ok(toBox > fromBox, "new is below old");
  assert.equal(await page.$eval(`${row("Q7", "Option label")} [data-testid="cp-row-from"] [data-testid="cp-val"]`, (e) => getComputedStyle(e).textDecorationLine), "line-through");
  assert.match(await text(`${row("Q7", "Skip logic")} [data-testid="cp-row-to"]`), /Q7 = 2.*Q12/);
  await openCard("Q5");
  assert.equal(await text(`${row("Q5", "Options")} [data-testid="cp-row-option"]`), "Option 4 — None of these");
  assert.match(await text(`${row("Q5", "Options")} [data-testid="cp-row-destructive"]`), /None of these/);
  ok("one card per question (Q7 · Single choice · Do you own a car?), collapsed when many; option rows “Option 4 — United States” with old struck through above new; the destructive note on its row");

  // the Impact header: a count, a list with severities, each navigable
  assert.equal(await page.getAttribute('[data-testid="cp-impact"]', "data-count"), "1");
  assert.equal(await text('[data-testid="cp-impact-count"]'), "1 dependent object");
  await page.click('[data-testid="cp-impact-toggle"]');
  const ref = await page.$('[data-testid="cp-impact-list"] [data-testid="cp-impact-ref"]');
  assert.equal(await ref.getAttribute("data-key"), "question:insure");
  assert.match(await text('[data-testid="cp-impact-list"] li'), /breaks.*Q12 display logic/);
  await ref.click();
  await page.waitForTimeout(200);
  assert.equal(await selected(), "Q12", "the impact item selects Q12");
  assert.equal(await tab(), "changes", "an open proposal keeps the Changes tab");
  // a row's affected list navigates too: the deletion of Q11 reaches Q12's display logic
  await page.click('[data-testid="cp-sp-q"][data-code="Q1"]');
  await page.waitForTimeout(150);
  assert.equal(await tab(), "changes", "selecting from the survey pane while a proposal is open keeps Changes");
  await openCard("Q11");
  await page.click(`${row("Q11", "Question")} [data-testid="cp-row-affected"] summary`);
  assert.match(await text(`${row("Q11", "Question")} [data-testid="cp-row-affected"] summary`), /^Affected: 1$/);
  await page.click(`${row("Q11", "Question")} [data-testid="cp-affected-ref"]`);
  await page.waitForTimeout(200);
  assert.equal(await selected(), "Q12");
  // the technical details: collapsed, a <pre> that wraps
  const tech = `${row("Q7", "Option label")} [data-testid="cp-row-tech"]`;
  assert.equal(await page.$eval(tech, (d) => d.open), false);
  await page.click(`${tech} summary`);
  assert.equal(await page.$eval(`${tech} pre`, (e) => getComputedStyle(e).whiteSpace), "pre-wrap");
  ok("Impact: 1 dependent object — breaks Q12 display logic; the impact list and a row's “Affected: 1” both navigate to Q12; technical details collapsed, wrapping");
}

/* ------------------------------------------------ (c) the option preview, on hover and on keyboard focus */
{
  const r7 = row("Q7", "Option label");
  await page.hover(r7);
  await page.waitForSelector(`${r7} [data-testid="cp-pop"]`, { state: "visible" });
  assert.equal(await text(`${r7} [data-testid="cp-pop-code"]`), "4");
  assert.equal(await text(`${r7} [data-testid="cp-pop-flags"]`), "none");
  assert.match(await text(`${r7} [data-testid="cp-pop-deps"]`), /Q8 display logic/, "Q8 reads Q7 = 4");
  assert.match(await text(`${r7} [data-testid="cp-pop"]`), /Export value\s*4/);
  // keyboard: the removed option of Q5, previewed from the survey it still lives in (first leave the row: no hover, no focus inside it)
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(5, 5);
  await page.waitForSelector(`${r7} [data-testid="cp-pop"]`, { state: "hidden" });
  const r5 = row("Q5", "Options");
  assert.equal(await page.getAttribute(r5, "tabindex"), "0", "the option row is reachable from the keyboard");
  await page.focus(r5);
  await page.waitForSelector(`${r5} [data-testid="cp-pop"]`, { state: "visible" });
  assert.equal(await text(`${r5} [data-testid="cp-pop-code"]`), "99");
  assert.match(await text(`${r5} [data-testid="cp-pop-flags"]`), /exclusive/);
  assert.match(await text(`${r5} [data-testid="cp-pop-deps"]`), /nothing in the survey reads this option/);
  await page.evaluate(() => document.activeElement?.blur());
  // the option row's title selects the option for the Inspector's actions
  await page.click(`${r7} [data-testid="cp-row-option"]`);
  await page.click('[data-testid="cp-tab-inspector"]');
  await page.waitForSelector('[data-testid="cp-ctx-title"]');
  assert.match(await text('[data-testid="cp-ctx-title"]'), /^Actions for Q7 · option 4 “United States”/);
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-modified"]');
  ok("hover and keyboard focus preview an option — code 4, no flags, read by Q8's display logic; 99 exclusive, read by nothing — and an option row's title selects the option for the Inspector");
}

/* ------------------------------------------------ (d) nothing scrolls sideways, at 260 / 360 / 520 px */
const setPanelWidth = async (w) => {
  const d = await page.$eval(".iq-divider", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const cur = await page.$eval('[data-testid="iq-inspector"]', (e) => e.getBoundingClientRect().width);
  await page.mouse.move(d.x, d.y);
  await page.mouse.down();
  await page.mouse.move(d.x + (cur - w), d.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  return page.$eval('[data-testid="iq-inspector"]', (e) => Math.round(e.getBoundingClientRect().width));
};
/** every element of the panel body that scrolls or clips sideways, wider than it shows — ellipsis truncation excepted, that is the point of it */
const sideways = () => page.evaluate(() => {
  const body = document.querySelector(".cp-panel-body");
  const out = [];
  const els = [body, ...body.querySelectorAll("*"), document.querySelector(".cp-tabs")];
  for (const el of els) {
    const cs = getComputedStyle(el);
    const clips = el === body || /auto|scroll|hidden|clip/.test(cs.overflowX);
    if (!clips || cs.textOverflow === "ellipsis" || cs.display === "none") continue;
    if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${el.scrollWidth}>${el.clientWidth}`);
  }
  // and nothing visible pokes out past the body's right edge — what an inner clipping box hides (an ellipsis) is that box's business, checked above
  const right = body.getBoundingClientRect().right;
  const clipped = (el) => { for (let p = el.parentElement; p && p !== body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return true; return false; };
  for (const el of body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= right + 1 || getComputedStyle(el).display === "none" || clipped(el)) continue;
    out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} in .${String(el.parentElement?.className).split(" ")[0]} right ${Math.round(r.right)}>${Math.round(right)}`);
    break;
  }
  return out;
});
const expandEverything = async () => {
  for (const c of await page.$$eval('[data-testid="cp-qcard"][data-open="false"]', (cs) => cs.map((x) => x.dataset.code))) await page.click(`${card(c)} [data-testid="cp-qcard-toggle"]`);
  await page.$$eval('[data-testid="cp-modified"] details', (ds) => ds.forEach((d) => { d.open = true; }));
  if (await page.$('[data-testid="cp-impact-toggle"][aria-expanded="false"]')) await page.click('[data-testid="cp-impact-toggle"]');
  await page.click('[data-testid="cp-before-after"]');
  await page.waitForTimeout(150);
};
{
  for (const w of [260, 360, 520]) {
    const got = await setPanelWidth(w);
    assert.ok(Math.abs(got - w) <= 2, `the panel is ${got}px, not ${w}px`);
    await page.click('[data-testid="cp-tab-changes"]');
    await expandEverything();
    if (w === 260) {
      // the long condition clamps to three lines with "more"; "more" shows all of it
      const cond = `${row("Q9", "Display logic")} [data-testid="cp-row-to"]`;
      assert.ok(await page.$(`${cond} [data-testid="cp-val-more"]`), "a long value is clamped with “more”");
      const h1 = await page.$eval(`${cond} [data-testid="cp-val"]`, (e) => e.getBoundingClientRect().height);
      await page.click(`${cond} [data-testid="cp-val-more"]`);
      const h2 = await page.$eval(`${cond} [data-testid="cp-val"]`, (e) => e.getBoundingClientRect().height);
      assert.ok(h2 > h1, `“more” shows the whole value (${h1} → ${h2})`);
      // the ten tabs wrap onto more than one line
      const tabTops = await page.$$eval(".cp-tab", (ts) => [...new Set(ts.map((t) => Math.round(t.getBoundingClientRect().top)))]);
      assert.ok(tabTops.length >= 2, `the tab strip wraps: ${tabTops.length} line(s)`);
      assert.match(await text(`${row("Q10", "Option label")} [data-testid="cp-row-to"]`), /https:\/\/www\.example-car-marketplace/);
    }
    const bad = await sideways();
    assert.deepEqual(bad, [], `Changes at ${w}px: ${bad.join(", ")}`);
    // a popover is the width of its row
    await page.hover(row("Q7", "Option label"));
    await page.waitForSelector(`${row("Q7", "Option label")} [data-testid="cp-pop"]`, { state: "visible" });
    assert.deepEqual(await sideways(), [], `with the option preview open at ${w}px`);
    await page.mouse.move(5, 5);
    // the Inspector tab (Q12 selected, its actions and dependencies above the inspector) too
    await page.click('[data-testid="cp-tab-inspector"]');
    await page.waitForSelector('[data-testid="cp-context"]');
    await page.waitForSelector('[data-testid="cp-ctx-group"]', { timeout: 15000 });
    const bad2 = await sideways();
    assert.deepEqual(bad2, [], `Inspector at ${w}px: ${bad2.join(", ")}`);
    await page.click('[data-testid="cp-tab-changes"]');
    await page.click('[data-testid="cp-before-after"]').catch(() => {});
    await page.waitForSelector('[data-testid="cp-modified"]');
  }
  await setPanelWidth(420);
  ok("no horizontal overflow in the Changes and Inspector tabs at 260, 360 and 520 px — every card, detail and the impact list open, the before/after outline side by side, an option preview showing; the tab strip wraps; a long condition clamps with “more”");
}

/* ------------------------------------------------ (b) selective apply */
{
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-modified"]');
  const total = Number(await page.getAttribute('[data-testid="cp-modified"]', "data-items"));
  assert.ok(total >= 9, `rows: ${total}`);
  assert.equal(await applyLabel(), "Apply changes", "nothing excluded: the plain label");
  assert.ok((await texts('[data-testid="cp-destructive"] li')).some((l) => /Q5/.test(l)), "the removal is among the destructive changes");
  // one action, two rows: unticking Q4's rewording takes its "required" with it — and says so first
  await openCard("Q4");
  assert.match(await text(`${row("Q4", "Wording")} [data-testid="cp-row-also"]`), /^Unticking also excludes: Q4 required$/);
  await page.uncheck(`${row("Q4", "Wording")} [data-testid="cp-row-check"]`);
  await page.waitForSelector(`${row("Q4", "Required")}[data-status="excluded"]`);
  assert.equal(await text(`${row("Q4", "Wording")} [data-testid="cp-row-status"]`), "Excluded");
  assert.match(await text(`${row("Q4", "Required")} [data-testid="cp-row-also"]`), /^Excluded with it: Q4 text$/);
  assert.equal(await page.$eval(`${card("Q4")} [data-testid="cp-qcard-check"]`, (c) => c.checked), false, "the card's tick follows its rows");
  assert.equal(await applyLabel(), `Apply ${total - 2} of ${total} changes`);
  await page.check(`${card("Q4")} [data-testid="cp-qcard-check"]`);
  await page.waitForSelector(`${row("Q4", "Required")}[data-status="proposed"]`);
  assert.equal(await applyLabel(), "Apply changes");
  ok("unticking one row of an action that made two excludes both — “Unticking also excludes: Q4 required” said beforehand — and the card's tick brings them back");

  // exclude the removal of Q5's None of these
  await openCard("Q5");
  await page.uncheck(`${row("Q5", "Options")} [data-testid="cp-row-check"]`);
  await page.waitForSelector(`${row("Q5", "Options")}[data-status="excluded"]`);
  assert.equal(await applyLabel(), `Apply ${total - 1} of ${total} changes`);
  assert.equal(await page.getAttribute('[data-testid="cp-panel-apply"]', "data-included"), String(total - 1));
  assert.ok(!(await texts('[data-testid="cp-destructive"] li')).some((l) => /Q5/.test(l)), "the excluded removal is no longer asked to be confirmed");
  assert.ok((await texts('[data-testid="cp-summary"] li')).every((l) => !/None of these|Q5/.test(l)), "nor in the summary of what will happen");
  // excluding everything disables Apply, with the reason
  for (const c of await page.$$eval('[data-testid="cp-qcard"]', (cs) => cs.map((x) => x.dataset.code))) {
    const box = `${card(c)} [data-testid="cp-qcard-check"]`;
    if (await page.$eval(box, (b) => !b.disabled && (b.checked || b.indeterminate))) await page.click(box);
  }
  await page.waitForSelector('[data-testid="cp-all-excluded"]');
  assert.ok(await page.$eval('[data-testid="cp-panel-apply"]', (b) => b.disabled));
  assert.match(await page.getAttribute('[data-testid="cp-panel-apply"]', "title"), /Every change is excluded/);
  // tick everything back but the removal
  for (const c of await page.$$eval('[data-testid="cp-qcard"]', (cs) => cs.map((x) => x.dataset.code))) {
    if (c === "Q5") continue;
    const box = `${card(c)} [data-testid="cp-qcard-check"]`;
    if (await page.$eval(box, (b) => !b.disabled && !b.checked)) await page.click(box);
  }
  await page.waitForFunction((n) => document.querySelector('[data-testid="cp-panel-apply"]')?.getAttribute("data-included") === String(n), total - 1);
  assert.equal(await applyLabel(), `Apply ${total - 1} of ${total} changes`);
  // Q12's logic is pruned only because Q11 is deleted — no tick of its own, but it reports what Apply does
  await openCard("Q12");
  assert.equal(await page.$eval(`${row("Q12", "Display logic")} [data-testid="cp-row-check"]`, (c) => c.disabled), true);
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "history");
  const hist = await text('[data-testid="cp-change"]');
  assert.match(await text('[data-testid="cp-change-excluded"]'), /^Excluded 1 proposed change was left out: .*Q5/);
  assert.match(hist, /AI Change #001/);
  const def = await readDef();
  const Q = (code) => def.questions.find((x) => x.code === code);
  assert.deepEqual(Q("Q5").options.map((o) => o.code), [1, 2, 3, 99], "the excluded removal was NOT written");
  assert.equal(Q("Q7").options[3].label, "United States");
  assert.equal(Q("Q10").options[2].label, URL_LABEL);
  assert.ok(Q("Q9").displayLogic, "Q9's display logic");
  assert.equal(Q("Q7").skipLogic.length, 1);
  assert.equal(Q("Q3").required, true, "the engine's step");
  assert.equal(Q("Q4").required, true);
  assert.equal(Q("Q4").text, "Have you ever heard of our brand?");
  assert.equal(Q("Q11"), undefined, "Q11 deleted");
  assert.equal(Q("Q12").displayLogic ?? null, null, "Q12's reference to Q11 pruned");
  ok(`unticking Q5's removal: “Apply ${total - 1} of ${total} changes”, Apply writes the rest and not the removal, History says “1 proposed change was left out”; everything unticked disables Apply with the reason`);
}

/* ------------------------------------------------ (e) the selection, made actionable */
{
  assert.equal(await tab(), "history");
  await page.click('[data-testid="cp-sp-q"][data-code="Q2"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "inspector");
  ok("with no proposal open, selecting a question turns the panel to the Inspector");
  await page.waitForSelector('[data-testid="cp-context"][data-target="Q2"]');
  // computed after the selection paints: a placeholder, then the groups
  await page.waitForSelector('[data-testid="cp-ctx-group"]', { timeout: 15000 });
  assert.match(await text('[data-testid="cp-ctx-title"]'), /^Actions for Q2$/);
  const g2 = await page.$$eval('[data-testid="cp-ctx-group"]', (gs) => gs.map((g) => g.dataset.group));
  assert.ok(!g2.includes("Options"), `a number has no Options group: ${g2}`);
  assert.deepEqual(g2.slice(0, 2), ["Logic", "Validation"]);
  assert.ok(await page.$('[data-testid="cp-ctx-action"][data-sentence="Q2 must be a whole number"][data-ready="true"]'));
  await page.click('[data-testid="cp-sp-q"][data-code="Q7"]');
  await page.waitForSelector('[data-testid="cp-context"][data-target="Q7"]');
  await page.waitForFunction(() => /^Actions for Q7$/.test(document.querySelector('[data-testid="cp-ctx-title"]')?.textContent ?? "") && document.querySelector('[data-testid="cp-ctx-group"][data-group="Options"]'), null, { timeout: 15000 });
  const deleteQ7 = await page.$('[data-testid="cp-ctx-action"][data-sentence="Delete Q7"]');
  assert.equal(await deleteQ7.getAttribute("data-destructive"), "true", "destructive actions are marked");
  // the option list: a chip selects the option, and previews it
  await page.hover('[data-testid="cp-ctx-option"][data-code="1"]');
  await page.waitForSelector('[data-testid="cp-ctx-options"] [data-testid="cp-pop"]', { state: "visible" });
  assert.match(await text('[data-testid="cp-ctx-options"] [data-testid="cp-pop-deps"]'), /Q8 display logic/);
  await page.click('[data-testid="cp-ctx-option"][data-code="4"]');
  await page.waitForFunction(() => /option 4 “United States”/.test(document.querySelector('[data-testid="cp-ctx-title"]')?.textContent ?? "") && document.querySelector('[data-testid="cp-ctx-group"]'), null, { timeout: 15000 });
  // only what the engine would carry out: Q8 compares Q7 with 4, so removing it would be refused — and is not offered
  assert.equal(await page.$('[data-testid="cp-ctx-action"][data-sentence="Remove option “United States” from Q7"]'), null);
  assert.ok(await page.$('[data-testid="cp-ctx-action"][data-ready="true"][data-sentence="What breaks if I remove option 4 from Q7?"]'));
  assert.ok(await page.$('[data-testid="cp-ctx-action"][data-ready="false"][data-sentence="Rename option “United States” in Q7 to "]'));
  await page.click('[data-testid="cp-ctx-option-clear"]');
  await page.waitForFunction(() => /^Actions for Q7$/.test(document.querySelector('[data-testid="cp-ctx-title"]')?.textContent ?? "") && document.querySelector('[data-testid="cp-ctx-group"]'), null, { timeout: 15000 });
  ok("Actions for Q2 (a number): Logic, Validation, … and no Options group; Actions for Q7 has Options, Delete marked destructive; an option chip previews and selects the option — whose removal Q8's logic forbids, so it is not offered");

  // a ready action goes through the engine like a typed sentence
  const before = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.click('[data-testid="cp-ctx-action"][data-sentence="Make Q7 required"]');
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="cp-turn"]').length > k, before);
  const t = (await page.$$('[data-testid="cp-turn"]')).at(-1);
  assert.ok(await t.$('[data-testid="cp-engine"]'), "the engine read it — no model call");
  assert.equal(await t.getAttribute("data-proposal"), "open");
  assert.equal(modelCalls.length, 1, "still only the one model call of (a)");
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "changes");
  assert.equal(await text(`${row("Q7", "Required")} [data-testid="cp-row-to"] [data-testid="cp-val"]`), "required");
  await page.click('[data-testid="cp-panel-cancel"]');
  // a template goes in the input box, the caret at its end
  await page.click('[data-testid="cp-sp-q"][data-code="Q7"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "inspector");
  await page.waitForSelector('[data-testid="cp-ctx-action"][data-ready="false"][data-sentence="Show Q7 only if "]', { timeout: 15000 });
  await page.click('[data-testid="cp-ctx-action"][data-sentence="Show Q7 only if "]');
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "iq-input");
  const input = await page.$eval('[data-testid="iq-input"]', (e) => ({ value: e.value, caret: e.selectionStart, end: e.selectionEnd }));
  assert.deepEqual(input, { value: "Show Q7 only if ", caret: 16, end: 16 });
  await page.fill('[data-testid="iq-input"]', "");
  ok("a ready action (“Make Q7 required”) becomes an engine proposal in Changes; a template (“Show Q7 only if …”) fills the input box, focused, the caret at its end");
}

/* ------------------------------------------------ (f) the dependency map */
{
  assert.equal(await tab(), "inspector");
  await page.waitForSelector('[data-testid="cp-depmap"]');
  assert.equal(await text('[data-testid="cp-dep-root"]'), "Q7");
  const secs = await page.$$eval('[data-testid="cp-dep-section"]', (ss) => ss.map((s) => [s.dataset.title, [...s.querySelectorAll('[data-testid="cp-dep-chip"]')].map((c) => c.dataset.key)]));
  const by = Object.fromEntries(secs);
  assert.deepEqual(by["Display logic"].sort(), ["question:caryear", "question:make"], JSON.stringify(secs));
  assert.equal(by["Skip logic"].length, 1);
  assert.match(by["Skip logic"][0], /^skipRule:own\//);
  assert.match(await text('[data-testid="cp-dep-summary"]'), /^\d+ objects depend on Q7: 2 display conditions, 1 skip/);
  assert.match(await text('[data-testid="cp-dep-reads-summary"]'), /^Q7 depends on/);
  await page.click('[data-testid="cp-dep-chip"][data-key="question:make"]');
  await page.waitForSelector('[data-testid="cp-context"][data-target="Q8"]');
  assert.equal(await selected(), "Q8");
  assert.equal(await tab(), "inspector");
  // Q8 reads Q7: the map shows it under Reads
  await page.waitForSelector('[data-testid="cp-dep-read-section"] [data-testid="cp-dep-chip"][data-key="question:own"]');
  ok("the dependency map: Q7 → ↓ Display logic Q8, Q9 · ↓ Skip logic Q7 skip 1, with the summary; a chip selects Q8, whose map reads Q7");
}

assert.deepEqual(errors, [], errors.join("\n"));
await browser.close();
console.log(`\nchange-review-test: ${passed} passed`);
