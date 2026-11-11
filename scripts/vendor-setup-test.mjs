/**
 * A SAMPLE VENDOR FROM ITS FOUR REDIRECT LINKS, IN INTELLIGENT MODE (2026-11-11) — in the browser, with no model:
 *
 *   [1] "Add vendor Acme …" + four links → a proposal with the vendor card: each link's outcome and the evidence,
 *       the vendor code, the link for the vendor, the checks, the redirect test. Apply → on the definition.
 *   [2] a second vendor: Acme is byte-identical afterwards, the ends are untouched, and the test shows every
 *       vendor × outcome going to that vendor's own link
 *   [3] links that only differ by a number are a QUESTION with a one-click answer — never a guess
 *   [4] a vendor that already exists: update or separate? — nothing changes until one is chosen
 *   [5] the real runner (runtime /preview) as an Acme respondent, a Bravo respondent and nobody's: each leaves by
 *       its own vendor's link, on a complete AND on a screen-out from a skip rule
 *   [6] Launch study on the applied card: the sandbox has nowhere to publish, and the card says so (no fake link)
 *
 *   node scripts/vendor-setup-test.mjs      (Studio on :3000, runtime on :3001)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (402|404|413|501|502|503|504)/.test(m.text())) errors.push(m.text()); });
const modelCalls = [];
page.on("request", (r) => { if (r.url().endsWith("/api/copilot/turn") && r.method() === "POST") modelCalls.push(r.url()); });

const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const DEF = {
  meta: { id: "sandbox", code: "S", title: "Vendor study", version: "1.0" },
  questions: [{
    id: "q1", code: "Q1", variableName: "AGE", type: "single_select", text: "How old are you?", options: opts("Under 18", "18 or over"),
    skipLogic: [{ id: "sk1", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, target: { kind: "terminate", status: "screened" } }],
  }],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1"] }] }, { type: "end", id: "e_ok", status: "complete" }],
};
const A = ["https://acme-sample.com/end?status=complete&rid=[RID]", "https://acme-sample.com/end?status=screenout&rid=[RID]", "https://acme-sample.com/end?status=quotafull&rid=[RID]", "https://acme-sample.com/end?status=quality&rid=[RID]"];
const B = ["https://survey.bravo.io/r/success?uid={{uid}}&proj=771", "https://survey.bravo.io/r/term?uid={{uid}}&proj=771", "https://survey.bravo.io/r/overquota?uid={{uid}}&proj=771", "https://survey.bravo.io/r/security?uid={{uid}}&proj=771"];

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const readDef = async () => { await openTab(page, "JSON"); await page.waitForSelector("textarea.code"); const json = await page.$eval("textarea.code", (e) => e.value); await intelligent(); return JSON.parse(json); };
const lastTurn = async () => (await page.$$('[data-testid="cp-turn"]')).at(-1);
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const submit = async (text) => {
  const before = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.$eval('[data-testid="iq-input"]', (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await page.focus('[data-testid="iq-input"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="cp-turn"]').length > n, before, { timeout: 15000 });
  await page.waitForTimeout(400);
  return lastTurn();
};
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-apply"]'); await page.waitForTimeout(700); };
const attr = (h, sel, name) => h.$eval(sel, (e, n) => e.getAttribute(n), name);

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(DEF);
await intelligent();

/* ============================================================ [1] the first vendor */
{
  const t = await submit(`Add vendor Acme with these redirect links:\n${A.join("\n")}`);
  assert.equal(await t.getAttribute("data-kind"), "proposal", await textOf(t));
  const card = await t.$('[data-testid="vendor-card"]');
  assert.ok(card, "the vendor card is on the proposal");
  assert.equal(await card.getAttribute("data-vendor"), "acme");
  assert.equal(await card.getAttribute("data-checks"), "pass");
  assert.match(await card.$eval('[data-testid="vendor-code"]', (e) => e.textContent), /code acme/);
  for (const [o, word, url] of [["complete", "complete", "status=complete&rid={{pid}}"], ["screenout", "screenout", "status=screenout&rid={{pid}}"], ["quota_full", "quotafull", "status=quotafull&rid={{pid}}"], ["terminate", "quality", "status=quality&rid={{pid}}"]]) {
    const row = await textOf(await card.$(`[data-testid="vendor-link-${o}"]`));
    assert.ok(row.includes(url), `${o}: ${row}`);
    assert.ok(row.includes(`the address says “${word}”`), `${o} evidence: ${row}`);
  }
  assert.match(await card.$eval('[data-testid="vendor-entry-link"]', (e) => e.textContent), /\/s\/[^?]+\?rp=acme&rid=\[RID\]$/);
  assert.match(await card.$eval('[data-testid="vendor-others"]', (e) => e.textContent), /none on this study yet/);
  assert.equal((await card.$$('[data-testid^="vendor-check-"][data-ok="1"]')).length, 6);
  ok("[1] four pasted links → a proposal: each outcome with its evidence, code acme, the vendor's link, six checks passing");
  await card.$eval('[data-testid="vendor-test-toggle"]', (e) => e.click());
  await page.waitForSelector('[data-testid="vendor-sim"]');
  const sims = await page.$$('[data-testid^="vendor-sim-acme-"]');
  assert.equal(sims.length, 4);
  assert.match(await textOf(await page.$('[data-testid="vendor-sim-acme-terminate"]')), /https:\/\/acme-sample\.com\/end\?status=quality&rid=TEST12345/);
  await page.fill('[data-testid="vendor-test-pid"]', "ZX-77");
  assert.match(await textOf(await page.$('[data-testid="vendor-sim-acme-complete"]')), /status=complete&rid=ZX-77/);
  ok("[1] the redirect test resolves all four exits with the test id, before anything is applied");
  assert.equal((await readDef()).panels, undefined, "nothing is written until Apply");
  await apply();
  const def = await readDef();
  assert.deepEqual(def.panels.map((p) => p.key), ["acme"]);
  assert.equal(def.flow[0].id, "ed_vendor_acme");
  assert.deepEqual(def.flow[0].fields.map((f) => f.name), ["rp", "rid"]);
  assert.equal(def.flow.find((n) => n.type === "end").redirectUrl, undefined);
  ok("[1] applied: the vendor is on the definition, its code and id are captured, the end is not rewritten");
}

/* ============================================================ [2] a second vendor — additive */
let two;
{
  const before = await readDef();
  const t = await submit(`add a new vendor Bravo: ${B.join(" ")}`);
  assert.equal(await t.getAttribute("data-kind"), "proposal", await textOf(t));
  const card = await t.$('[data-testid="vendor-card"]');
  assert.equal(await card.getAttribute("data-vendor"), "bravo");
  assert.match(await card.$eval('[data-testid="vendor-others"]', (e) => e.textContent), /Acme \(acme\) — not changed/);
  assert.equal(await attr(card, '[data-testid="vendor-link-screenout"]', "data-confidence"), "inferred");
  assert.match(await textOf(await card.$('[data-testid="vendor-link-screenout"]')), /worked out — please check/);
  await card.$eval('[data-testid="vendor-test-toggle"]', (e) => e.click());
  await page.waitForSelector('[data-testid="vendor-sim"]');
  const rows = await card.$$('[data-testid^="vendor-sim-"][data-ok]');
  assert.equal(rows.length, 8);
  for (const r of rows) {
    const id = await r.getAttribute("data-testid");
    const text = await textOf(r);
    assert.equal(await r.getAttribute("data-ok"), "1", text);
    assert.ok(id.includes("-acme-") ? /acme-sample\.com/.test(text) && !/bravo\.io/.test(text) : /survey\.bravo\.io/.test(text) && !/acme-sample/.test(text), text);
  }
  if (process.env.SHOTS) { await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOTS}/vendor-2.png` }); }
  await apply();
  two = await readDef();
  assert.deepEqual(two.panels.map((p) => p.key), ["acme", "bravo"]);
  assert.equal(JSON.stringify(two.panels[0]), JSON.stringify(before.panels[0]), "Acme is byte-identical");
  assert.equal(JSON.stringify(two.flow.filter((n) => n.id !== "ed_vendor_bravo")), JSON.stringify(before.flow), "the rest of the flow is as it was");
  assert.equal(JSON.stringify(two.questions), JSON.stringify(before.questions));
  ok("[2] Bravo added beside Acme: Acme byte-identical, flow and logic untouched, 8 simulated exits each to its own vendor");
}

/* ============================================================ [3] unclear links are a question */
{
  const t = await submit(`add vendor Numbers: ${[1, 2, 3, 4].map((n) => `https://panel.example.com/cb?st=${n}&id=[ID]`).join(" ")}`);
  assert.equal(await t.getAttribute("data-kind"), "clarify", await textOf(t));
  assert.match(await textOf(t), /cannot tell what these links are for/);
  assert.equal(await t.$('[data-testid="vendor-card"]'), null);
  const choice = await t.$('[data-testid="cp-engine-choice"]');
  assert.ok(choice, "a one-click answer is offered");
  assert.match(await textOf(choice), /In the order pasted: complete, screened out, quota full, quality check \/ termination/);
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await choice.click();
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="cp-turn"]').length > k, n);
  await page.waitForTimeout(400);
  const t2 = await lastTurn();
  assert.equal(await t2.getAttribute("data-kind"), "proposal", await textOf(t2));
  assert.match(await textOf(await t2.$('[data-testid="vendor-link-quota_full"]')), /st=3&id=\{\{pid\}\}.*labelled/);
  await page.click('[data-testid="cp-cancel"]');
  await page.waitForTimeout(300);
  assert.deepEqual((await readDef()).panels.map((p) => p.key), ["acme", "bravo"]);
  ok("[3] links that differ only by a number: a question, a one-click answer, then a proposal — nothing guessed");
}

/* ============================================================ [4] an existing vendor */
{
  const t = await submit(`add vendor Acme ${B.map((u) => u.replace("bravo.io", "acme2.io")).join(" ")}`);
  assert.equal(await t.getAttribute("data-kind"), "clarify", await textOf(t));
  assert.match(await textOf(t), /Acme is already a vendor on this study \(code acme\).*UPDATE.*SEPARATE.*Nothing has been changed/);
  const labels = await t.$$eval('[data-testid="cp-engine-choice"]', (els) => els.map((e) => e.innerText.trim().split("\n")[0]));
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/vendor-4.png`, fullPage: false });
  assert.deepEqual(labels, ["Update Acme (acme)", "Add as a separate vendor"]);
  assert.equal(JSON.stringify((await readDef()).panels), JSON.stringify(two.panels));
  ok("[4] a vendor that exists is not touched: “update or separate?” with both answers offered");
}
assert.equal(modelCalls.length, 0, "no language model was called for any of it");
ok("no model call: the links reach the definition exactly as pasted");

/* ============================================================ [5] the real runner */
{
  const finish = async (search, answer) => {
    const pv = await openPreview(browser, RUNTIME, { definition: two }, { search });
    await pv.click(`[data-qid="q1"] label:has-text("${answer}")`);
    await pv.click('button:has-text("Next"), [data-testid="rs-next"]');
    await pv.waitForFunction(() => /would redirect|Thank you|ended|complete/i.test(document.body.innerText), null, { timeout: 15000 });
    await pv.waitForTimeout(300);
    const el = await pv.$('[data-testid="rs-would-redirect"]');
    const text = el ? await el.innerText() : null;
    await pv.close();
    return text;
  };
  assert.match(await finish("?rp=acme&rid=A-001", "18 or over"), /https:\/\/acme-sample\.com\/end\?status=complete&rid=A-001/);
  assert.match(await finish("?rp=bravo&uid=B-900", "18 or over"), /https:\/\/survey\.bravo\.io\/r\/success\?uid=B-900&proj=771/);
  assert.match(await finish("?rp=acme&rid=A-002", "Under 18"), /https:\/\/acme-sample\.com\/end\?status=screenout&rid=A-002/);
  assert.match(await finish("?rp=bravo&uid=B-901", "Under 18"), /https:\/\/survey\.bravo\.io\/r\/term\?uid=B-901&proj=771/);
  assert.equal(await finish("", "18 or over"), null, "nobody's respondent is redirected nowhere, as before");
  ok("[5] the runner: Acme's and Bravo's respondents each leave by their own complete and screen-out links; others are unaffected");
}

/* ============================================================ [6] launch */
{
  const cards = await page.$$('[data-testid="vendor-card"][data-state="applied"]');
  const card = cards.at(-1);
  assert.ok(card, "the applied vendor card is still on the conversation");
  const btn = await card.$('[data-testid="vendor-launch-btn"]');
  assert.ok(btn && !(await btn.isDisabled()), "Launch study is offered once applied and the checks pass");
  await btn.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="vendor-live"], [data-testid="vendor-launch-error"]'), null, { timeout: 30000 });
  const live = await card.$('[data-testid="vendor-live"]');
  if (process.env.SHOTS) { await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOTS}/vendor-6.png` }); }
  assert.equal(live, null, "the sandbox has no project to publish: no link is shown for a launch that did not happen");
  const err = await textOf(await card.$('[data-testid="vendor-launch-error"]'));
  assert.match(err, /not launched/i);
  ok(`[6] the sandbox cannot publish, and the card says so without inventing a link (“${err.slice(0, 70)}…”)`);

  /*
   * The same button with the two server routes answering as they do for a real project (the sandbox has no
   * database behind them, so they are stubbed HERE, in the test): the card shows the live link, each vendor's
   * link with its code and id placeholder, and Copy.
   */
  await page.route("**/api/surveys/sandbox/versions", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "ver-1", version: "1.1", variables: 1, revision: 2 }) }) : r.continue()));
  let deployed = null;
  await page.route("**/api/surveys/sandbox/deploy", (r) => { deployed = JSON.parse(r.request().postData() ?? "{}"); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
  await (await card.$('[data-testid="vendor-launch-btn"]')).click();
  await page.waitForSelector('[data-testid="vendor-live"]', { timeout: 30000 });
  assert.equal(deployed?.mode, "live"); assert.equal(deployed?.versionId, "ver-1");
  assert.match(await textOf(await card.$('[data-testid="vendor-live-acme"]')), /\/s\/[^?\s]+\?rp=acme&rid=\[RID\]/);
  assert.match(await textOf(await card.$('[data-testid="vendor-live-bravo"]')), /\/s\/[^?\s]+\?rp=bravo&uid=\[UID\]/);
  const copy = await card.$eval('[data-testid="vendor-copy-bravo"]', (e) => e.getAttribute("data-copy"));
  assert.match(copy, /^https?:\/\/[^/]+\/s\/[^?]+\?rp=bravo&uid=\[UID\]$/);
  assert.ok(await card.$('[data-testid="vendor-copy-plain"]'));
  assert.equal(await card.$('[data-testid="vendor-launch-btn"]'), null, "launched once");
  if (process.env.SHOTS) { await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOTS}/vendor-7.png` }); }
  ok("[6] with the publish routes answering: version saved, deployed live, the survey link and each vendor's link shown with Copy");
}

assert.deepEqual(errors, [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);
