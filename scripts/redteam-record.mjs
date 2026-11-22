/**
 * RECORD REAL AUTOMATION THROUGH THE REAL COLLECTOR (Level 5 roadmap F1b — 2026-11-26).
 *
 * The red-team corpus (packages/quality/src/redTeam.ts) SIMULATES attacks: it writes the telemetry it believes an
 * attacker would leave. This records the telemetry real automated browsers DO leave: the runtime's own Runner and
 * collector, a real Chromium, five ways of driving it. The file it writes is what `fraud.recorded_automation`
 * scores, with no tuning between recording and scoring.
 *
 *   dom_script         answers set and clicked from page script: no real pointer or key events
 *   playwright_fast    Playwright clicks and types as fast as it can (its synthetic mouse and key events)
 *   playwright_stealth the same with navigator.webdriver hidden and a short fixed wait per page
 *   agent_typed        the mechanics of a model driving a browser: the pointer moved to each target, a few
 *                      seconds per page whatever is on it, fluent text typed at an even 40 ms a key
 *   agent_pasted       the same, the text pasted with Ctrl+V
 *   agent_slow_even    an agent that waits on each page as long as reading it would take, then types with the
 *                      fixed delay automation libraries offer (180 ms a key): unhurried, and perfectly regular
 *   agent_patient      an agent told to pass for a person: it waits on each page as long as reading it would take
 *                      (about 250 words a minute), moves the pointer, and types at 140 to 340 ms a key with pauses
 *
 *   agent_careful      the patient agent, also told about the checks: it moves the pointer along a curve with
 *                      uneven steps, and now and then mistypes a letter and corrects it
 *
 *   scripted_mouse     the usual way a script "moves the mouse": mouse.move to the target's centre in 25 equal steps,
 *                      then press there — what most automation libraries do when asked for mouse movement
 *
 * WHAT IT IS NOT: a recording of people (there is none here, so no false-positive rate comes from this), of a
 * headed browser on a real desktop or phone, or of a language model — the "agent" text is canned.
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/redteam-record.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { validationSurvey } from "../packages/quality/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const OUT = new URL("../packages/quality/fixtures/recorded/automation-2026-11.json", import.meta.url);
const N = { dom_script: 6, playwright_fast: 6, playwright_stealth: 6, agent_typed: 3, agent_pasted: 3, agent_patient: 0, agent_slow_even: 0, agent_careful: 0, scripted_mouse: 0, ...JSON.parse(process.env.COUNTS ?? "{}") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seed = 20261126;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const OPEN = ["I chose this brand primarily because", "My decision was mainly driven by the fact that", "The key reason I selected it is that", "What ultimately convinced me was that"];
const WHY = ["it offers a strong balance of reliability and value", "its safety record and build quality stood out", "the overall cost of ownership is reasonable", "it has a reputation for durability and low maintenance"];
const ADD = ["Additionally, the fuel efficiency suits my daily commute.", "It has also proven dependable over several years of use.", "Servicing has been straightforward and affordable too."];
const SWITCH = ["I would consider switching if a competitor offered", "I might change brands if another manufacturer provided", "A compelling reason to switch would be"];
const WHAT = ["a meaningfully lower total cost of ownership", "a significantly longer warranty with comparable quality", "noticeably better after-sales service"];
const texts = () => ({ oe: `${pick(OPEN)} ${pick(WHY)}. ${pick(ADD)}`, oe2: `${pick(SWITCH)} ${pick(WHAT)}.` });

const def = validationSurvey();
const launched = await (await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) })).json();
if (!launched.url) throw new Error(`could not launch: ${JSON.stringify(launched)}`);
const browser = await chromium.launch();
const recorded = [];

/** what to answer on each question: a coherent owner who reads the attention check */
function planFor(q) {
  if (q.id === "own") return { option: 0 };
  if (q.id === "att") return { option: 1 };
  if (q.type === "long_text") return { text: true };
  if (q.type === "matrix_single") return { rows: q.rows.map(() => Math.floor(rnd() * 5)) };
  if (q.id === "brand") return { option: Math.floor(rnd() * 4) };
  return { option: Math.floor(rnd() * q.options.length) };
}

async function session(style, i) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US", timezoneId: "America/New_York", permissions: ["clipboard-read", "clipboard-write"] });
  if (style === "playwright_stealth" || style.startsWith("agent")) await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }); });
  const pg = await ctx.newPage();
  let last = null;
  pg.on("request", (r) => { if (r.url().includes("/api/session/save") && r.method() === "POST") { try { last = r.postDataJSON(); } catch { /* not json */ } } });
  for (let k = 0; ; k++) { try { await pg.goto(`${RUNTIME}${launched.url}`, { waitUntil: "networkidle", timeout: 120000 }); break; } catch (e) { if (k >= 3) throw e; await sleep(5000); } }
  await pg.waitForSelector("[data-qid]", { timeout: 120000 });
  const said = texts();
  const human = style.startsWith("agent");
  /* a curved path with uneven steps: a quadratic curve through a random control point, each step jittered and unevenly timed */
  let at = { x: 640, y: 400 };
  const curveTo = async (sel) => {
    /* a target below the fold must be scrolled to first, as a person would; a mouse cannot press what is off screen */
    await pg.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {});
    const b = await pg.locator(sel).first().boundingBox(); if (!b) return;
    const to = { x: b.x + b.width / 2 + (rnd() - 0.5) * b.width * 0.4, y: b.y + b.height / 2 + (rnd() - 0.5) * b.height * 0.4 };
    const c = { x: (at.x + to.x) / 2 + (rnd() - 0.5) * 160, y: (at.y + to.y) / 2 + (rnd() - 0.5) * 120 };
    const n = 18 + Math.floor(rnd() * 22);
    for (let k = 1; k <= n; k++) { const u = Math.pow(k / n, 0.6 + rnd() * 0.8); const x = (1 - u) ** 2 * at.x + 2 * (1 - u) * u * c.x + u * u * to.x + (rnd() - 0.5) * 3, y = (1 - u) ** 2 * at.y + 2 * (1 - u) * u * c.y + u * u * to.y + (rnd() - 0.5) * 3; await pg.mouse.move(x, y); await sleep(6 + rnd() * 22); }
    await pg.mouse.move(to.x, to.y); at = to;
  };
  const moveTo = async (sel) => {
    if (style === "agent_careful") return curveTo(sel); const b = await pg.locator(sel).first().boundingBox(); if (b) await pg.mouse.move(b.x + b.width / 2 + (rnd() - 0.5) * 6, b.y + b.height / 2 + (rnd() - 0.5) * 4, { steps: 12 + Math.floor(rnd() * 10) }); };
  const click = async (sel) => {
    if (style === "dom_script") { await pg.evaluate((s) => { const parts = s.split(" >> nth="); const el = document.querySelectorAll(parts[0])[Number(parts[1] ?? 0)]; el?.click(); }, sel); return; }
    if (style === "scripted_mouse") { await pg.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); const b = await pg.locator(sel).first().boundingBox(); if (!b) return; await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 }); await pg.mouse.down(); await pg.mouse.up(); return; }
    if (style === "agent_careful") { await curveTo(sel); await sleep(300 + rnd() * 700); await pg.mouse.down(); await sleep(40 + rnd() * 80); await pg.mouse.up(); return; }
    if (human) { await moveTo(sel); await sleep(style === "agent_patient" || style === "agent_slow_even" || style === "agent_careful" ? 400 + rnd() * 900 : 120 + rnd() * 200); }
    await pg.click(sel);
  };
  for (let page = 0; page < 24; page++) {
    const ids = await pg.$$eval("[data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")));
    if (!ids.length) break;
    if (style === "agent_patient" || style === "agent_slow_even" || style === "agent_careful") { const words = (await pg.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText)).split(/\s+/).length; await sleep(Math.min(45000, 1500 + (words / 250) * 60000 * (0.8 + rnd() * 0.5))); }
    else if (human) await sleep(2000 + rnd() * 2000);
    else if (style === "playwright_stealth") await sleep(900);
    for (const id of ids) {
      const q = def.questions.find((x) => x.id === id);
      if (!q) continue;
      const p = planFor(q);
      if (p.option !== undefined) await click(`[data-qid="${id}"] label >> nth=${p.option}`);
      if (p.rows) for (let r = 0; r < p.rows.length; r++) await click(`[data-qid="${id}"] tbody tr:nth-child(${r + 1}) input >> nth=${p.rows[r]}`);
      if (p.text) {
        const sel = `[data-qid="${id}"] textarea, [data-qid="${id}"] input[type=text]`;
        const text = said[id] ?? said.oe;
        if (style === "dom_script") await pg.evaluate(([s, t]) => { const el = document.querySelector(s); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; set.call(el, t); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, [sel, text]);
        else if (style === "agent_pasted") { await click(sel); await pg.evaluate((t) => navigator.clipboard.writeText(t), text); await pg.keyboard.press("Control+V"); }
        else if (style === "agent_careful") { await click(sel); for (const ch of text) { if (rnd() < 0.05) { await pg.keyboard.type("qwertyuiop"[Math.floor(rnd() * 10)]); await sleep(250 + rnd() * 400); await pg.keyboard.press("Backspace"); await sleep(150 + rnd() * 250); } await pg.keyboard.type(ch); await sleep(110 + rnd() * 260 + (ch === " " && rnd() < 0.15 ? 500 + rnd() * 1500 : 0)); } }
        else if (style === "agent_patient") { await click(sel); for (const ch of text) { await pg.keyboard.type(ch); await sleep(140 + rnd() * 200 + (ch === " " && rnd() < 0.12 ? 600 + rnd() * 1200 : 0)); } }
        else { await click(sel); await pg.keyboard.type(text, style === "agent_slow_even" ? { delay: 180 } : human ? { delay: 40 } : {}); }
      }
    }
    const before = ids.join();
    if (style === "dom_script") await sleep(250);
    await click('[data-testid="rs-next"]');
    for (let w = 0; w < 40; w++) { await sleep(150); const now = (await pg.$$eval("[data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")))).join(); if (now !== before) break; }
    if (last?.completed) break;
  }
  await sleep(600);
  const tel = last?.telemetry ?? (await pg.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptTelemetry ?? null))));
  const done = !!last?.completed;
  if (!done) console.log(`     stuck on [${(await pg.$$eval("[data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")))).join(",")}] step ${last?.stepIndex} status ${last?.status}; body text: ${(await pg.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 160)}`);
  recorded.push({ style, index: i, completed: done, sessionId: `rec-${style}-${i + 1}`, answers: last?.answers ?? {}, telemetry: tel, userAgent: await pg.evaluate(() => navigator.userAgent) });
  console.log(`  ${done ? "ok  " : "FAIL"} ${style} ${i + 1}: ${done ? "completed" : "did not complete"}, ${tel?.pages?.length ?? 0} page visits, pointer ${tel?.interaction?.pointerEvents ?? "?"}, keys ${tel?.interaction?.keyEvents ?? "?"}, pastes ${tel?.clipboard?.pastes ?? "?"}, webdriver ${tel?.device?.webdriver}`);
  await ctx.close();
}

for (const [style, n] of Object.entries(N)) for (let i = 0; i < n; i++) { try { await session(style, i); if (!recorded.at(-1)?.completed && i === 0) { console.log(`     ${style}: the first session did not complete; the rest are not tried`); break; } } catch (e) { console.log(`  FAIL ${style} ${i + 1}: ${String(e.message).split("\n")[0]}`); } }
await browser.close();
/* a run of some styles keeps the earlier recordings of the others */
const ran = new Set(Object.entries(N).filter(([, n]) => n > 0).map(([k]) => k));
const kept = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).responses.filter((r) => !ran.has(r.style)) : [];
const complete = [...kept, ...recorded.filter((r) => r.completed)];
writeFileSync(OUT, JSON.stringify({
  recordedAt: new Date().toISOString(), survey: def.meta.id, source: "recorded",
  how: "headless Chromium driven by Playwright against the runtime's sandbox test link; telemetry is the collector's own, taken from the last save request (before the server's sanitiser)",
  notRecorded: ["people", "a headed browser on a real desktop or phone", "a language model: the agent styles use canned text"],
  responses: complete,
}, null, 1) + "\n");
const okNow = recorded.filter((r) => r.completed).length;
console.log(`${okNow} of ${recorded.length} sessions completed this run; ${complete.length} in the file (${kept.length} kept from earlier runs)`);
console.log(okNow === recorded.length && okNow > 0 ? `${okNow} passed` : "Error: some sessions did not complete");
