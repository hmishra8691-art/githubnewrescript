/**
 * INTELLIGENT COPILOT — every refusal a researcher can meet says what it is
 * (AI-04), in words they can act on, with a way to retry.
 *
 *   node scripts/copilot-errors-test.mjs
 *
 * Against the Studio dev server with AI_API_URL=fake:. Two kinds of refusal:
 *   - the Studio's own routes (signed out, a request it could not read, a
 *     locked project, a request too large, the network down, an exception in
 *     the page): the turn request is answered by the browser's route
 *     interception with exactly what the real route sends (guard.ts, turn/route.ts)
 *   - the provider's (a bad key, a refused request): scripted through the fake
 *     provider's own fault seam, `window.__rescriptCopilotFault`, no mocking.
 * Each card must carry its researcher-readable title and sentence, a "what to
 * do" list and Resume, and must never carry "could not process this request",
 * a status code or raw JavaScript.
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/401|400|402|413|423|422|501|Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_CONNECTION/.test(m.text())) pageErrors.push(m.text().slice(0, 300)); });

const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const empty = { meta: { id: "sandbox", code: "S", title: "Errors study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab("Questions");
};
const turns = () => page.$$('[data-testid="cp-turn"]');
/* a sentence the engine does not read by itself, so the model path (and its failure) is what runs */
const REQUEST = "Please design a customer satisfaction survey for a mobile network operator covering coverage, billing and support";
/** send, wait for the turn to settle — clicking "Resume now" if a retry wait is showing — and return its card */
const send = async (text = REQUEST) => {
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  const deadline = Date.now() + 60000;
  for (;;) {
    const state = await page.evaluate((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k ? t[t.length - 1].getAttribute("data-status") : "none"; }, n);
    if (state !== "thinking" && state !== "none") break;
    const wait = await page.$('[data-testid="cp-resume-now"]');
    if (wait) await wait.click().catch(() => {});
    assert.ok(Date.now() < deadline, "the turn did not settle");
    await page.waitForTimeout(250);
  }
  const last = (await turns()).at(-1);
  return { code: await (await last.$('[data-testid="cp-failure"]'))?.getAttribute("data-code"), text: (await last.innerText()).replace(/\s+/g, " "), el: last };
};
const FORBIDDEN = /could not process this request|\b(400|401|402|413|423)\b|Not signed in|Cannot read|undefined|TypeError|\[object/i;
const expectCard = async (r, { code, title, sentence }) => {
  assert.equal(r.code, code, `${code}: got ${r.code} — ${r.text.slice(0, 300)}`);
  assert.ok(r.text.includes(title), `${code}: title “${title}” in ${r.text.slice(0, 300)}`);
  assert.ok(r.text.includes(sentence), `${code}: sentence “${sentence}” in ${r.text.slice(0, 400)}`);
  assert.doesNotMatch(r.text, FORBIDDEN, `${code}: no provider blame, status code or raw JS`);
  assert.ok(await r.el.$('[data-testid="cp-resume"]'), `${code}: a retry (Resume) is offered`);
  assert.ok((await r.el.$$('[data-testid="cp-failure"] li')).length >= 1, `${code}: a what-to-do list`);
};
const intercept = async (handler) => { await page.route("**/api/copilot/turn", handler); };
const clear = async () => { await page.unroute("**/api/copilot/turn"); };
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(empty);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/* ------------------------------------------------------------ the Studio's own routes */
{
  await intercept((r) => json(r, 401, { error: "Not signed in.", code: "no_session" }));
  await expectCard(await send(), { code: "signed_out", title: "YOU'RE SIGNED OUT", sentence: "You're signed out — sign in and send again." });
  await clear();
  ok("401 (session ended): “You're signed out — sign in and send again.” with Resume — not blamed on the AI service");
}
{
  await intercept((r) => json(r, 400, { error: "send the survey as it is open in the editor (definition)" }));
  await expectCard(await send(), { code: "bad_request", title: "THE STUDIO COULD NOT READ THIS REQUEST", sentence: "could not read what this page sent" });
  await clear();
  ok("400 (the page's request unreadable): says the editor and the server are out of step, with Resume");
}
{
  await intercept((r) => json(r, 400, { error: "say what you want" }));
  await expectCard(await send(), { code: "bad_request", title: "THE STUDIO COULD NOT READ THIS REQUEST", sentence: "type what you want changed" });
  await clear();
  ok("400 (nothing to send): “type what you want changed, then send it again”");
}
{
  await intercept((r) => json(r, 423, { error: "This project has been locked by its owner and cannot be changed.", code: "project_locked" }));
  await expectCard(await send(), { code: "refused", title: "THE STUDIO DID NOT ALLOW THIS REQUEST", sentence: "locked by its owner" });
  await clear();
  ok("423 (project locked): says so — not “the wallet refused”");
}
{
  await intercept((r) => r.fulfill({ status: 413, contentType: "text/html", body: "<html>Request Entity Too Large</html>" }));
  await expectCard(await send(), { code: "too_long", title: "THIS REQUEST IS TOO LONG FOR THE MODEL", sentence: "That request was too long for the model — shorten it or split it." });
  await clear();
  ok("413 (the platform's size limit): “That request was too long for the model — shorten it or split it.”");
}
{
  await intercept((r) => json(r, 401, { error: "The AI provider rejected the API key." }));
  await expectCard(await send(), { code: "auth", title: "THE AI PROVIDER REFUSED THE KEY", sentence: "The AI provider refused the key — check Settings → AI" });
  await clear();
  ok("401 naming the provider's key: “The AI provider refused the key — check Settings → AI”");
}
{
  await intercept((r) => r.abort("connectionrefused"));
  await expectCard(await send(), { code: "unreachable", title: "THE STUDIO COULD NOT BE REACHED", sentence: "Could not reach the server — check your connection and try again." });
  await clear();
  ok("network down (every automatic retry spent): “Could not reach the server — check your connection and try again.”");
}
{
  /* an answer the page cannot read: the exception is a sentence, never the JavaScript message */
  await intercept((r) => json(r, 200, { ok: true, reply: { kind: "answer", reply: "ok", actions: [] }, usage: { charge: 0 }, context: {} }));
  const r = await send();
  await expectCard(r, { code: "unexpected", title: "SOMETHING WENT WRONG IN THE STUDIO", sentence: "Something went wrong in the Studio before the AI could answer." });
  await clear();
  ok("an exception in the page: a sentence and Resume — the raw JavaScript message is not shown");
}

/* ------------------------------------------------------------ the provider's, through the fake provider's fault seam */
{
  await page.evaluate(() => window.__rescriptCopilotFault({ faults: [{ kind: "auth", status: 401 }] }));
  const r = await send();
  assert.equal(r.code, "auth", r.text.slice(0, 300));
  assert.match(r.text, /could not sign in to the AI service|did not accept your API key/);
  assert.ok(await r.el.$('[data-testid="cp-resume"]'));
  ok("a provider 401 (bad key): the connection card, unchanged, with Resume");
}
{
  await page.evaluate(() => window.__rescriptCopilotFault({ faults: [{ kind: "bad_request", status: 400 }] }));
  const r = await send();
  assert.equal(r.code, "provider", r.text.slice(0, 300));
  assert.match(r.text, /The AI service could not process this request/);
  ok("a provider 400: still “the AI service could not process this request” — the one case where that is true");
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
