/**
 * AI PROVIDER ERRORS IN INTELLIGENT MODE — a researcher submits a prompt and
 * the provider is busy, refuses a key, drops the connection, or the platform
 * cuts the request off. In the browser, against the Studio dev server with
 * AI_API_URL=fake: — the fake provider cannot fail on its own, so the suite
 * scripts failures into the copilot route's model calls
 * (`window.__rescriptCopilotFault`, honoured only by the fake provider) and
 * intercepts the network for the failures the route never sees (a platform
 * 504 page, a dropped connection). Everything after the model is real: the
 * route's clock and checkpoints, the browser's checkpoint, the card, the gate,
 * the proposal, Apply.
 *
 *   node scripts/provider-resilience-test.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (402|404|501|502|503|504)/.test(m.text())) errors.push(m.text()); });
const turnRequests = [];
page.on("request", (r) => { if (r.url().endsWith("/api/copilot/turn") && r.method() === "POST") { try { turnRequests.push(JSON.parse(r.postData() ?? "{}")); } catch { turnRequests.push({}); } } });

const EMPTY = { meta: { id: "sandbox", code: "S", title: "Skincare study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
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
const fakeNext = (reply) => page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
const faultNext = (f) => page.evaluate((x) => window.__rescriptCopilotFault(x), f);
const turns = () => page.$$('[data-testid="cp-turn"]');
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const lastTurn = async () => (await turns()).at(-1);
const state = async () => (await lastTurn()).getAttribute("data-status");
const waitStatus = (re, timeout = 30000) => page.waitForFunction((src) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1]; return !!l && new RegExp(src).test(l.getAttribute("data-status") ?? ""); }, re.source, { timeout });
const waitProgress = (re, timeout = 20000) => page.waitForFunction((src) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1]; const p = l?.querySelector('[data-testid="cp-progress-text"]'); return !!p && new RegExp(src).test(p.textContent ?? ""); }, re.source, { timeout });
const submit = async (text, reply) => {
  if (reply) await fakeNext(reply);
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
};
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-apply"]'); await page.waitForTimeout(500); };
const noRawProviderText = async (t) => {
  const text = await textOf(t);
  assert.doesNotMatch(text, /\b(401|403|429|503|504)\b|rate.?limit exceeded|x-api-key|insufficient_quota|stack|ProviderError/i, `no raw provider text on the card: ${text.slice(0, 300)}`);
  return text;
};

const mk = (id, title) => ({ id, title, kind: "create", objects: [title], reason: `builds ${title}` });
const PLAN4 = { kind: "plan", summary: "Four blocks.", items: [mk("a", "Screener"), mk("b", "Exposure"), mk("c", "Intent"), mk("d", "About you")], questions: [], assumptions: [] };
const item = (n, title) => ({ kind: "proposal", reply: `${title} added.`, actions: [{ op: "create_block", title }, { op: "create_question", ref: `Q_${n}`, type: "single_select", text: `Question for ${title}?`, options: ["Yes", "No"] }] });
const ITEMS = [item("A", "Screener"), item("B", "Exposure"), item("C", "Intent"), item("D", "About you")];
const PROMPT = "Create a customer satisfaction survey about our new skincare line, with a screener, exposure, intent and demographics.";
const fresh = async () => {
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.checkpoint.")).forEach((k) => localStorage.removeItem(k)); } catch {} });
  await loadDef(EMPTY);
  await intelligent();
  turnRequests.length = 0;
};
const approveAll = async (t) => { await t.$eval('[data-testid="cp-plan-build"]', (b) => b.click()); };

/* ============================================================ 1. the plan stage, 429s and recovery */
await fresh();
{
  /* [2] a 429 then recovery: the card says the work is saved, counts down, resumes on its own, and the plan arrives — the prompt was never retyped */
  await faultNext({ faults: [{ kind: "rate_limited", status: 429, retryAfterMs: 1600 }] });
  await submit(PROMPT, PLAN4);
  await waitProgress(/Temporarily waiting for AI capacity\. Your work has been saved\./);
  const t = await lastTurn();
  assert.equal(await t.getAttribute("data-status"), "thinking", "still working, not failed");
  assert.ok(await t.$('[data-testid="cp-resume-now"]'), "the wait can be ended");
  assert.match(await textOf(t), /Resuming in \d+s/);
  await noRawProviderText(t);
  await waitStatus(/^plan$/);
  assert.equal(turnRequests.length, 2, "one retry, no more");
  assert.equal(turnRequests[1].message, PROMPT, "the same prompt, sent again by the card");
  ok("429 → \"Temporarily waiting for AI capacity. Your work has been saved.\" with a countdown, resumed by itself, plan delivered; no raw 429 on the card");
}
{
  /* [3] consecutive 429s, ended early with Resume now */
  await fresh();
  await faultNext({ faults: [{ kind: "rate_limited", status: 429, retryAfterMs: 90000 }] });
  await faultNext({ faults: [{ kind: "rate_limited", status: 429, retryAfterMs: 90000 }] });
  await faultNext({ faults: [{ kind: "overloaded", status: 529 }] });
  await submit(PROMPT, PLAN4);
  for (let i = 0; i < 3; i++) {
    await waitProgress(/Temporarily waiting/);
    await page.waitForTimeout(300);
    await page.click('[data-testid="cp-resume-now"]');
    await waitProgress(/Resuming survey generation|Temporarily waiting|Planning/).catch(() => {});
  }
  await waitStatus(/^plan$/);
  assert.equal(turnRequests.length, 4, `three refusals and the answer: ${turnRequests.length}`);
  ok("consecutive 429/529 refusals are waited out one after another (here ended with Resume now) and the fourth request succeeds");
}
{
  /* [4] a long Retry-After is honoured (the countdown shows it) */
  await fresh();
  await faultNext({ faults: [{ kind: "rate_limited", status: 429, retryAfterMs: 45000 }] });
  await submit(PROMPT, PLAN4);
  await waitProgress(/Temporarily waiting/);
  const secs = Number((await textOf(await lastTurn())).match(/Resuming in (\d+)s/)?.[1]);
  assert.ok(secs >= 40 && secs <= 45, `the countdown follows the provider's Retry-After: ${secs}s`);
  await page.click('[data-testid="cp-resume-now"]');
  await waitStatus(/^plan$/);
  ok("Retry-After is respected: a provider that says 45 s is counted down from 45 s, not hammered");
}
/* [5][6] a timeout, a 500/503 */
for (const [what, fault] of [["a provider timeout", { kind: "timeout" }], ["a 500/503", { kind: "server", status: 503 }]]) {
  await fresh();
  await faultNext({ faults: [fault] });
  await submit(PROMPT, PLAN4);
  await waitProgress(/Temporarily waiting|waiting/);
  await page.click('[data-testid="cp-resume-now"]');
  await waitStatus(/^plan$/);
  ok(`${what}: waited out and retried once, the plan arrives`);
}
{
  /* the platform's own time limit: an HTML 504 page, not JSON — never "the provider refused" */
  await fresh();
  let first = true;
  await page.route("**/api/copilot/turn", (route) => { if (first) { first = false; return route.fulfill({ status: 504, contentType: "text/html", body: "<html>An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT</html>" }); } return route.continue(); });
  await submit(PROMPT, PLAN4);
  await waitProgress(/Temporarily waiting/);
  const t = await lastTurn();
  await noRawProviderText(t);
  await page.click('[data-testid="cp-resume-now"]');
  await waitStatus(/^plan$/);
  await page.unroute("**/api/copilot/turn");
  ok("a platform 504 page (no JSON at all) is a temporary wait, not \"the provider refused the request\"; the request is sent again and succeeds");
}
{
  /* a dropped connection */
  await fresh();
  let first = true;
  await page.route("**/api/copilot/turn", (route) => { if (first) { first = false; return route.abort("connectionreset"); } return route.continue(); });
  await submit(PROMPT, PLAN4);
  await waitProgress(/Temporarily waiting/);
  await page.click('[data-testid="cp-resume-now"]');
  await waitStatus(/^plan$/);
  await page.unroute("**/api/copilot/turn");
  ok("a dropped connection is waited out and retried the same way");
}

/* ============================================================ 2. 401 and 403 are not retried */
{
  await fresh();
  await faultNext({ faults: [{ kind: "auth", status: 401 }] });
  await submit(PROMPT, PLAN4);
  await waitStatus(/^failed$/);
  const t = await lastTurn();
  const text = await noRawProviderText(t);
  assert.equal(await t.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "auth");
  assert.match(text, /THE AI CONNECTION NEEDS ATTENTION/);
  assert.match(text, /For your administrator.*AI_API_KEY/i);
  assert.ok(await t.$('[data-testid="cp-resume"]'), "Resume is offered — nothing needs retyping");
  assert.equal(turnRequests.length, 1, "a refused key is not retried by itself");
  /* the administrator fixes the key; Resume sends the saved prompt (the suite scripts the model's answer to it) */
  await fakeNext(PLAN4);
  await page.click('[data-testid="cp-resume"]');
  await waitStatus(/^plan$/);
  assert.equal(turnRequests.length, 2);
  assert.equal(turnRequests[1].message, PROMPT);
  ok("401 → \"THE AI CONNECTION NEEDS ATTENTION\" with an administrator note, one request only; Resume re-sends the saved prompt and the plan arrives");
}
{
  await fresh();
  await faultNext({ faults: [{ kind: "forbidden", status: 403 }] });
  await submit(PROMPT, PLAN4);
  await waitStatus(/^failed$/);
  const t = await lastTurn();
  await noRawProviderText(t);
  assert.equal(await t.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "forbidden");
  assert.equal(turnRequests.length, 1, "a 403 that is a permission is not a temporary rate limit");
  ok("403 (permission) → its own card, not treated as a rate limit, not retried");
}

/* ============================================================ 3. building a plan: checkpoints */
{
  /* [9] a failure after several items: 2 built, the 3rd is rate-limited; the card waits, resumes, and builds only what is left — no duplicates */
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  turnRequests.length = 0;
  await faultNext({ faults: [null, null, { kind: "rate_limited", status: 429, retryAfterMs: 1600 }] });
  await fakeNext(ITEMS);
  await approveAll(await lastTurn());
  await waitProgress(/Temporarily waiting/);
  const t = await lastTurn();
  assert.equal(await t.$eval('[data-testid="cp-progress"]', (e) => e.getAttribute("data-done")), "2", "two items are kept while it waits");
  await page.click('[data-testid="cp-resume-now"]');
  await waitStatus(/^ready$/, 45000);
  assert.equal(turnRequests.length, 2);
  assert.deepEqual(turnRequests[1].done.map((d) => d.id), ["a", "b"], "the continuation carries the two built items — they are not asked of the model again");
  const built = await lastTurn();
  assert.match(await textOf(built), /Your survey draft is ready for review\./);
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C", "Q_D"], "four questions, once each");
  ok("failure after two items: they are kept, the build resumes with items 3–4 only, ends \"Your survey draft is ready for review.\", and Apply makes four questions with no duplicates");
}
{
  /* [10] a long job in the route's own time limit: every request builds what its clock allows and hands the rest on — one click, one result */
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  turnRequests.length = 0;
  for (let i = 0; i < 4; i++) await faultNext({ budgetMs: 1 });
  await fakeNext(ITEMS);
  await approveAll(await lastTurn());
  await waitStatus(/^ready$/, 45000);
  assert.equal(turnRequests.length, 4, "each request built one item and passed the rest on");
  assert.deepEqual(turnRequests.map((r) => (r.done ?? []).length), [0, 1, 2, 3]);
  await apply();
  const def = await readDef();
  assert.equal(def.questions.length, 4);
  ok("the route's time budget runs out after each item: it answers with a checkpoint instead of timing out, the card carries on by itself, and the whole survey arrives from one click");
}
{
  /* [11][12] interrupted by a reload, then resumed without duplicating */
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  await faultNext({ faults: [null, { kind: "rate_limited", status: 429, retryAfterMs: 90000 }] });
  await fakeNext(ITEMS);
  await approveAll(await lastTurn());
  await waitProgress(/Temporarily waiting/);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await loadDef(EMPTY);
  await intelligent();
  await page.waitForSelector('[data-testid="cp-turn"]');
  const t = await lastTurn();
  const text = await noRawProviderText(t);
  assert.match(text, /YOUR GENERATION WAS INTERRUPTED/);
  assert.match(text, /Kept: 1 of 4 items built, 3 still to build/);
  assert.equal(text.includes(PROMPT.slice(0, 40)), true, "the researcher's words came back");
  turnRequests.length = 0;
  await fakeNext(ITEMS.slice(1));
  await page.click('[data-testid="cp-resume"]');
  await waitStatus(/^ready$/, 45000);
  assert.deepEqual(turnRequests[0].done.map((d) => d.id), ["a"], "item a was not built again");
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C", "Q_D"]);
  ok("a reload in the middle of generation: the request, the plan and the built item come back as an interrupted card; Resume builds only the other three — four questions, no duplicates");
}
{
  /* [16] a permanent failure with recoverable work: quota spent after one item — saved, reviewable, and built on later */
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  await faultNext({ faults: [null, { kind: "quota_exhausted", status: 429 }] });
  await fakeNext(ITEMS);
  await approveAll(await lastTurn());
  await waitStatus(/^failed$/, 30000);
  let t = await lastTurn();
  const text = await noRawProviderText(t);
  assert.match(text, /USAGE LIMIT WAS REACHED/);
  assert.match(text, /nothing was charged to your wallet/);
  assert.equal(await t.$eval('[data-testid="cp-work"]', (e) => e.getAttribute("data-built")), "1");
  assert.equal(await t.$eval('[data-testid="cp-work"]', (e) => e.getAttribute("data-pending")), "3");
  assert.ok(await t.$('[data-testid="cp-review-ready"]'));
  /* review what is ready: a proposal of the one built item, the three others still pending */
  await t.$eval('[data-testid="cp-review-ready"]', (b) => b.click());
  await waitStatus(/^ready$/, 30000);
  t = await lastTurn();
  assert.match(await textOf(t), /partly ready: 1 of 4 items built/);
  assert.ok(await t.$('[data-testid="cp-build-rest"]'));
  assert.match(await t.$eval('[data-testid="cp-build-rest"]', (b) => b.textContent), /Build the remaining 3 items/);
  /* …and the rest, later, once the limit is lifted */
  turnRequests.length = 0;
  await fakeNext(ITEMS.slice(1));
  await t.$eval('[data-testid="cp-build-rest"]', (b) => b.click());
  await page.waitForFunction(() => { const x = document.querySelectorAll('[data-testid="cp-turn"]'); const l = x[x.length - 1]; return l && l.getAttribute("data-status") === "ready" && /ready for review/.test(l.innerText); }, null, { timeout: 45000 });
  assert.deepEqual(turnRequests[0].items, ["b", "c", "d"]);
  assert.deepEqual(turnRequests[0].done.map((d) => `${d.id}:${!!d.applied}`), ["a:true"], "the built item is context for the next ones, not merged twice");
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C", "Q_D"], "no duplicates after review + build the rest");
  ok("quota spent mid-build: the card says so without raw text, keeps 1 of 4, Review what's ready opens a partial proposal (completed vs pending), Build the remaining 3 finishes it — four questions, once each");
}
{
  /* discard lets the saved work go */
  await fresh();
  await faultNext({ faults: [{ kind: "auth", status: 401 }] });
  await submit(PROMPT, PLAN4);
  await waitStatus(/^failed$/);
  await page.click('[data-testid="cp-discard"]');
  await waitStatus(/^empty$/);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.checkpoint.")).length), 0);
  ok("Discard lets the saved work go (the browser's checkpoint is cleared)");
}
{
  /* a stalled provider is not waited on forever: no new item in several rounds → the card stops, says why, keeps the work */
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  const wait = { faults: [{ kind: "overloaded", status: 529, retryAfterMs: 1 }] };
  for (let i = 0; i < 6; i++) await faultNext(wait);
  await fakeNext(ITEMS);
  await approveAll(await lastTurn());
  for (let i = 0; i < 8; i++) { if (await state() !== "thinking") break; await page.waitForTimeout(400); const b = await page.$('[data-testid="cp-resume-now"]'); if (b) await b.click().catch(() => {}); }
  await waitStatus(/^failed$/, 20000);
  const t = await lastTurn();
  await noRawProviderText(t);
  assert.ok(await t.$('[data-testid="cp-resume"]'));
  ok("a provider that stays busy is not waited on forever: after a bounded number of rounds the card stops spinning, says the work is saved and offers Resume");
}

/* ============================================================ 4. the single reply and the notices */
{
  await fresh();
  await page.click('[data-testid="iq-plan-first"] input');   // plan first off: one reply
  const DIRECT = { kind: "proposal", reply: "One block.", plan: [{ block: "Trust", questions: 1 }], actions: [{ op: "create_block", title: "Trust" }, { op: "create_question", ref: "TRUST", type: "single_select", text: "Do you trust us?", options: ["Yes", "No"] }] };
  await faultNext({ faults: [{ kind: "rate_limited", status: 429, retryAfterMs: 1600 }] });
  await submit("Create a one-question survey about trust.", DIRECT);
  await waitProgress(/Temporarily waiting/).catch(() => {});
  await waitStatus(/^ready$/, 30000);
  assert.equal(turnRequests.length, 2);
  await apply();
  assert.equal((await readDef()).questions.length, 1);
  await page.click('[data-testid="iq-plan-first"] input');
  ok("the single-reply generation (plan first off) gets the same treatment: one rate limit, waited out, one proposal, applied once");
}

const real = errors.filter((e) => !/Download the React DevTools/.test(e));
assert.equal(real.length, 0, `console errors: ${real.join(" | ").slice(0, 400)}`);
console.log(`\n${passed} passed`);
await browser.close();
