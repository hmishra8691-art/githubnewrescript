/**
 * COPILOT RESPONSE STREAMING (2026-10-18) — docs/COPILOT-STREAMING-2026-10-18.md, in the browser against
 * the Studio dev server with AI_API_URL=fake:. The stand-in model streams only with the test seam
 * (`window.__rescriptCopilotStream(cfg)` in the page, `fakeStream` on the route), so every older suite
 * keeps reading JSON.
 *
 *   [1] the protocol at the route: NDJSON with no-buffering headers, start → text → ONE result whose body
 *       is the JSON path's; heartbeats every heartbeatMs through a slow model call; a provider failure after
 *       the stream began is the terminal error with the JSON path's status and failure; errors before the
 *       model keep their HTTP status; without the header (or with the fake and no seam) plain JSON
 *   [2] the reply text appears in the pending card before the result, and the result replaces it
 *   [3] staged generation streamed: the plan's summary, "Item k of 4" steps on the card, four requests,
 *       the draft applied once
 *   [4] the stream drops mid-build (after the first item's checkpoint): the page keeps the item it was sent,
 *       resends, the server builds ONLY the rest; applied once, on a double click
 *   [5] the provider fails mid-stream: the temporary failure is resent and the second answer replaces the
 *       first one's partial text
 *   [6] fallbacks: streaming switched off in the page (no NDJSON asked), and a server that answers JSON
 *
 *   node scripts/copilot-streaming-test.mjs      (Studio on :3000, AI_API_URL=fake:)
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
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (400|402|404|413|501|502|503|504)/.test(m.text())) errors.push(m.text()); });
const turnRequests = [];
const turnResponses = [];
page.on("request", (r) => { if (r.url().endsWith("/api/copilot/turn") && r.method() === "POST") { try { turnRequests.push({ ...JSON.parse(r.postData() ?? "{}"), __accept: r.headers()["accept"] ?? "" }); } catch { turnRequests.push({}); } } });
/* a streamed response is recorded as its terminal event's body (with the events), a broken one as { __broken } */
/* Responses are recorded inside the page: the turn's body is teed, so the app reads its stream live while the
   copy is read to the end here. (Playwright's response.text() is unreliable for streamed bodies.) */
const record = ({ ct, status, text, broken }) => {
  try {
    if (!ct.includes("ndjson")) { turnResponses.push({ ...JSON.parse(text), __ct: ct, __status: status }); return; }
    const evs = text.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const term = evs.find((e) => e.type === "result" || e.type === "error");
    turnResponses.push(term && !broken ? { ...term.body, __event: term.type, __status: term.status, __events: evs, __ct: ct } : term ? { ...term.body, __event: term.type, __status: term.status, __events: evs, __ct: ct } : { __broken: true, __events: evs, __ct: ct });
  } catch (e) { turnResponses.push({ __err: String(e).slice(0, 300), __ct: ct, __status: status }); }
};
await page.exposeFunction("__rsTurnDone", record);
await page.addInitScript(() => {
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const res = await orig(input, init);
    if (!(method === "POST" && /\/api\/copilot\/turn(\?|$)/.test(url)) || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    const ct = res.headers.get("content-type") ?? "";
    (async () => {
      const reader = theirs.getReader(); const dec = new TextDecoder(); let text = ""; let broken = false;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); } }
      catch { broken = true; }
      window.__rsTurnDone({ ct, status: res.status, text, broken });
    })();
    return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
});

const EMPTY = { meta: { id: "sandbox", code: "S", title: "Industry study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const FOUR = {
  meta: { id: "sandbox", code: "S", title: "Pricing study", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand do you buy most often?", options: opts("Brand A", "Brand B") },
    { id: "q3", code: "Q3", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: opts("Low", "High") },
    { id: "q4", code: "Q4", variableName: "SPEND", type: "numeric", text: "How much do you spend a month?" },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }] }, { type: "end", id: "e_ok", status: "complete" }],
};
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
const streamSeam = (cfg) => page.evaluate((c) => window.__rescriptCopilotStream(c), cfg);
const turns = () => page.$$('[data-testid="cp-turn"]');
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const lastTurn = async () => (await turns()).at(-1);
const waitStatus = (re, timeout = 30000) => page.waitForFunction((src) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1]; return !!l && new RegExp(src).test(l.getAttribute("data-status") ?? ""); }, re.source, { timeout });
const submit = async (text, reply) => {
  if (reply) await fakeNext(reply);
  await page.$eval('[data-testid="iq-input"]', (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await page.focus('[data-testid="iq-input"]');
  await page.keyboard.press("Enter");
};
const settled = async () => { for (let i = 0; i < 80 && turnResponses.length < turnRequests.length; i++) await page.waitForTimeout(100); };
/* waits that a suite would sit through (the page's automatic resend after a dropped connection) are ended with "Resume now" */
const untilSettled = async (re, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const st = await (await lastTurn())?.getAttribute("data-status");
    if (st && re.test(st)) return st;
    const b = await page.$('[data-testid="cp-turn"]:last-of-type [data-testid="cp-resume-now"]');
    if (b) await b.click().catch(() => {});
    await page.waitForTimeout(150);
  }
  throw new Error(`the card did not reach ${re}`);
};
const fresh = async (def = EMPTY) => {
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.checkpoint.")).forEach((k) => localStorage.removeItem(k)); localStorage.removeItem("rescript.copilot.planFirst"); localStorage.removeItem("rescript.copilot.stream"); } catch {} });
  await loadDef(def);
  await intelligent();
  turnRequests.length = 0;
  turnResponses.length = 0;
};

/** one call to the route from the page, read event by event with arrival times (ms since the request was sent) */
const callRoute = (body, accept) => page.evaluate(async ({ body, accept }) => {
  const t0 = performance.now();
  const r = await fetch("/api/copilot/turn", { method: "POST", headers: { "content-type": "application/json", ...(accept ? { accept } : {}) }, body: JSON.stringify(body) });
  const ct = r.headers.get("content-type") ?? "";
  const headers = { cacheControl: r.headers.get("cache-control"), accel: r.headers.get("x-accel-buffering") };
  if (!ct.includes("ndjson")) return { status: r.status, ct, headers, json: await r.json().catch(() => null), events: null };
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ""; const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const ev = JSON.parse(line); events.push({ ...ev, serverAt: ev.at, at: Math.round(performance.now() - t0) }); } }
  }
  return { status: r.status, ct, headers, json: null, events };
}, { body, accept });
const NDJSON = "application/x-ndjson, application/json";

const REPLY = { kind: "proposal", reply: "I'll add a purchase-frequency question after Q2 — “How often do you buy this brand?” — with five answer options, so frequency can be read against the brand chosen.", actions: [{ op: "create_question", ref: "FREQ", block: "Main", type: "single_select", text: "How often do you buy this brand?", options: ["Weekly", "Monthly", "Every few months", "Once a year", "Less often"] }] };
/* a sentence the engine hands to the model (the copilot suite's pattern) */
const EDIT = "Based on the literature, add a question measuring how often people buy the brand.";

/* ============================================================ [1] the protocol at the route */
await fresh(FOUR);
{
  const base = { surveyId: "sandbox", message: EDIT, definition: FOUR, fake: REPLY };
  const plain = await callRoute(base, null);
  assert.equal(plain.status, 200); assert.match(plain.ct, /application\/json/);
  const noSeam = await callRoute(base, NDJSON);
  assert.match(noSeam.ct, /application\/json/, "the fake without the seam answers JSON even when asked to stream (the older suites read JSON)");
  assert.deepEqual(noSeam.json.reply, plain.json.reply);

  const s = await callRoute({ ...base, fakeStream: { chunkChars: 12, delayMs: 40, heartbeatMs: 250 } }, NDJSON);
  assert.equal(s.status, 200);
  assert.match(s.ct, /application\/x-ndjson/);
  assert.equal(s.headers.cacheControl, "no-cache, no-transform"); assert.equal(s.headers.accel, "no");
  assert.equal(s.events[0].type, "start");
  const terminal = s.events.filter((e) => e.type === "result" || e.type === "error");
  assert.equal(terminal.length, 1, "exactly one terminal event"); assert.equal(s.events.at(-1).type, "result");
  const texts = s.events.filter((e) => e.type === "text");
  assert.ok(texts.length >= 3, `the reply arrives in pieces (${texts.length})`);
  assert.equal(texts.map((e) => e.delta).join(""), REPLY.reply, "the streamed text is the reply, decoded");
  assert.ok(texts[0].at < s.events.at(-1).at - 200, `text before the result (${texts[0].at} ms vs ${s.events.at(-1).at} ms)`);
  const body = s.events.at(-1).body;
  assert.equal(s.events.at(-1).status, 200);
  assert.deepEqual(body.reply, plain.json.reply, "the result carries the JSON path's reply");
  const noIds = (v) => JSON.parse(JSON.stringify(v).replace(/"q_[a-z0-9]+"/g, '"q_id"'));
  assert.deepEqual(noIds(body.validation), noIds(plain.json.validation), "and its validation (generated ids aside)");
  assert.deepEqual(body.usage, plain.json.usage);
  assert.ok(s.events.some((e) => e.type === "progress" && e.stage === "turn") && s.events.some((e) => e.type === "progress" && e.stage === "gate"));

  /* a slow model call: heartbeats at the interval, never a silent second */
  const slow = await callRoute({ ...base, faults: [{ delayMs: 3000 }], fakeStream: { heartbeatMs: 250 } }, NDJSON);
  const beats = slow.events.filter((e) => e.type === "heartbeat");
  assert.ok(beats.length >= 8, `heartbeats through a 3 s call (${beats.length})`);
  const gaps = slow.events.slice(1).map((e, i) => e.at - slow.events[i].at);
  assert.ok(Math.max(...gaps) < 1000, `no gap of a second without an event (largest ${Math.max(...gaps)} ms)`);

  /* a failure after the stream began: the JSON path's status and failure, in the terminal event */
  const failJson = await callRoute({ ...base, faults: [{ kind: "overloaded" }] }, null);
  const failStream = await callRoute({ ...base, faults: [{ kind: "overloaded" }], fakeStream: true }, NDJSON);
  assert.equal(failStream.status, 200);
  const ev = failStream.events.at(-1);
  assert.equal(ev.type, "error"); assert.equal(ev.status, failJson.status);
  assert.equal(ev.body.failure.code, failJson.json.failure.code); assert.equal(ev.body.retryable, failJson.json.retryable);

  /* before the model: the HTTP status as always */
  const bad = await callRoute({ surveyId: "sandbox", message: EDIT, fakeStream: true }, NDJSON);
  assert.equal(bad.status, 400); assert.match(bad.ct, /application\/json/);
  const poem = await callRoute({ surveyId: "sandbox", message: "Write me a poem about the sea", definition: FOUR, fakeStream: true }, NDJSON);
  assert.equal(poem.status, 200); assert.match(poem.ct, /application\/json/, "a refusal without a model call is plain JSON");
  ok(`the route: NDJSON with no-buffering headers, ${texts.length} text events before ONE result equal to the JSON path's; ${beats.length} heartbeats through a 3 s call; a provider failure → the JSON path's ${failJson.status}/${failJson.json.failure.code}; errors before the model keep their status`);
}

/* ============================================================ [2] text before the result, in the card */
{
  await fresh(FOUR);
  await streamSeam({ chunkChars: 6, delayMs: 60, heartbeatMs: 300 });
  await submit(EDIT, REPLY);
  const seen = await page.waitForFunction(() => {
    const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1];
    const live = l?.querySelector('[data-testid="cp-live"]');
    return l && l.getAttribute("data-status") === "thinking" && live && live.textContent.length > 20 ? live.textContent : null;
  }, null, { timeout: 20000 });
  const partial = await seen.jsonValue();
  assert.ok(REPLY.reply.startsWith(partial.trim().slice(0, 20)), `the live text is the reply being written: “${partial.slice(0, 60)}”`);
  await waitStatus(/^ready$/, 30000);
  const t = await lastTurn();
  assert.equal(await t.$('[data-testid="cp-live"]'), null, "the result replaced the preview");
  assert.match(await textOf(t), /purchase-frequency question after Q2/);
  assert.match(turnRequests.at(-1).__accept, /application\/x-ndjson/);
  await settled();
  assert.equal(turnResponses.at(-1).__event, "result");
  ok("the reply text appears in the pending card while the model writes it; the result replaces it");
}

/* ============================================================ [3] staged generation, streamed */
const mk = (id, title) => ({ id, title, kind: "create", objects: [title], reason: `builds ${title}` });
const item = (n, title) => ({ kind: "proposal", reply: `${title} added.`, actions: [{ op: "create_block", title }, { op: "create_question", ref: `Q_${n}`, type: "single_select", text: `Question for ${title}?`, options: ["Yes", "No"] }] });
const PLAN4 = { kind: "plan", summary: "Four blocks: a screener, exposure, intent and the demographics.", items: [mk("a", "Screener"), mk("b", "Exposure"), mk("c", "Intent"), mk("d", "About you")], questions: [], assumptions: [] };
const ITEMS4 = [item("A", "Screener"), item("B", "Exposure"), item("C", "Intent"), item("D", "About you")];
const PROMPT = "Create a customer satisfaction survey about our new skincare line, with a screener, exposure, intent and demographics.";
{
  await fresh();
  await streamSeam({ chunkChars: 10, delayMs: 60, heartbeatMs: 300 });
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/, 30000);
  await settled();
  const planRes = turnResponses.at(-1);
  assert.equal(planRes.__event, "result", JSON.stringify(planRes).slice(0, 600)); assert.equal(planRes.stage, "plan");
  assert.equal(planRes.__events.filter((e) => e.type === "text").map((e) => e.delta).join(""), PLAN4.summary, "the plan's summary streamed");
  turnRequests.length = 0; turnResponses.length = 0;
  for (let i = 0; i < 4; i++) await faultNext({ budgetMs: 1 });
  await fakeNext(ITEMS4);
  const steps = new Set();
  const watch = setInterval(async () => { try { const s = await page.$eval('[data-testid="cp-turn"]:last-of-type [data-testid="cp-progress-step"]', (e) => e.textContent.trim()); if (s) steps.add(s); } catch {} }, 40);
  await (await lastTurn()).$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  await waitStatus(/^ready$/, 60000);
  clearInterval(watch);
  assert.equal(turnRequests.length, 4, "one stage per request, as without streaming");
  assert.deepEqual(turnRequests.map((r) => (r.done ?? []).map((d) => d.id).join("")), ["", "a", "ab", "abc"]);
  await settled();
  assert.deepEqual(turnResponses.map((r) => r?.stage).sort(), ["executed", "progress", "progress", "progress"]);
  assert.ok(turnResponses.every((r) => r.__events?.some((e) => e.type === "checkpoint")), "each request sent its item as a checkpoint");
  const itemSteps = [...steps].filter((x) => /^Item \d of 4: /.test(x));
  assert.ok(itemSteps.length >= 2, `the card named the item being built: ${[...steps].join(" | ")}`);
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.$eval('[data-testid="cp-apply"]', (b) => { b.click(); b.click(); });
  await page.waitForTimeout(700);
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C", "Q_D"]);
  ok(`staged generation streamed: the plan summary streamed, steps on the card (${itemSteps.slice(0, 4).join(" → ")}), four requests, applied once on a double click`);
}

/* ============================================================ [4] the stream drops mid-build */
{
  await fresh();
  await submit(PROMPT, { ...PLAN4, items: PLAN4.items.slice(0, 3), summary: "Three blocks." });
  await waitStatus(/^plan$/, 30000);
  await settled(); turnRequests.length = 0; turnResponses.length = 0;
  /* request 1: the stream is dropped right after the first item's checkpoint (the server stops starting items); request 2: normal */
  await streamSeam([{ dropAfterCheckpoints: 1, chunkChars: 40, delayMs: 20, heartbeatMs: 300 }, { chunkChars: 40, heartbeatMs: 300 }]);
  await fakeNext(ITEMS4.slice(0, 3));
  await (await lastTurn()).$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  await untilSettled(/^(ready|failed)$/, 60000);
  assert.equal(await (await lastTurn()).getAttribute("data-status"), "ready", await textOf(await lastTurn()));
  await settled();
  assert.equal(turnRequests.length, 2, "the dropped request, then one resend");
  assert.equal(turnResponses[0].__broken, true, "the first stream ended without a result");
  assert.ok(turnResponses[0].__events.some((e) => e.type === "checkpoint" && e.id === "a"));
  assert.deepEqual((turnRequests[1].done ?? []).map((d) => d.id), ["a"], "the resend carries the item the broken stream delivered — it is not built again");
  const final = turnResponses[1];
  assert.equal(final.stage, "executed");
  const itemCalls = final.context.calls.filter((c) => /_item$/.test(c.operation));
  assert.equal(itemCalls.length, 2, "the resend built only b and c");
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.$eval('[data-testid="cp-apply"]', (b) => { b.click(); b.click(); });
  await page.waitForTimeout(700);
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C"], "three questions, once each");
  ok("a stream dropped after item 1: the page kept the item from its checkpoint event, resent, the server built only items 2–3; applied once");
}

/* ============================================================ [5] the provider fails mid-stream */
{
  await fresh(FOUR);
  await streamSeam([{ chunkChars: 10, delayMs: 40, failAfterChars: 60, heartbeatMs: 300 }, { chunkChars: 20, delayMs: 10, heartbeatMs: 300 }]);
  await submit(EDIT, REPLY);
  await untilSettled(/^(ready|failed)$/, 60000);
  assert.equal(await (await lastTurn()).getAttribute("data-status"), "ready", await textOf(await lastTurn()));
  await settled();
  assert.equal(turnRequests.length, 2);
  assert.equal(turnResponses[0].__event, "error"); assert.equal(turnResponses[0].__status, 503);
  assert.equal(turnResponses[0].retryable, true);
  assert.ok(turnResponses[0].__events.some((e) => e.type === "text"), "some text had streamed before the failure");
  const t = await lastTurn();
  assert.match(await textOf(t), /purchase-frequency question after Q2/);
  assert.equal(await t.$('[data-testid="cp-live"]'), null);
  ok("a provider failure mid-stream: a temporary failure in the terminal event, resent, the second answer shown whole");
}

/* ============================================================ [6] fallbacks */
{
  await fresh(FOUR);
  await page.evaluate(() => localStorage.setItem("rescript.copilot.stream", "off"));
  await streamSeam({ chunkChars: 6, delayMs: 20 });
  await submit(EDIT, REPLY);
  await waitStatus(/^ready$/, 30000);
  await settled();
  assert.doesNotMatch(turnRequests.at(-1).__accept, /ndjson/, "switched off: no stream asked for");
  assert.match(turnResponses.at(-1).__ct, /application\/json/);
  assert.match(await textOf(await lastTurn()), /purchase-frequency question after Q2/);
  await page.evaluate(() => localStorage.removeItem("rescript.copilot.stream"));

  /* asked for a stream, answered with JSON (the fake without the seam stands in for an older server or a proxy) */
  await fresh(FOUR);
  await submit(EDIT, REPLY);
  await waitStatus(/^ready$/, 30000);
  await settled();
  assert.match(turnRequests.at(-1).__accept, /application\/x-ndjson/);
  assert.match(turnResponses.at(-1).__ct, /application\/json/);
  assert.match(await textOf(await lastTurn()), /purchase-frequency question after Q2/);
  ok("fallbacks: streaming switched off in the page sends a plain request; a JSON answer to a streaming request is read as before");
}

assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} passed`);
