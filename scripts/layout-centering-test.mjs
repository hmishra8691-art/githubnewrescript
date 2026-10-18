/**
 * LAYOUT CENTERING — THEMES, INTELLIGENT MODE, OVERFLOW (layout brief §12/§13, 2026-10-17).
 *
 *   node scripts/layout-centering-test.mjs
 *   STUDIO_URL=http://localhost:3100 RUNTIME_URL=http://localhost:3101 node scripts/layout-centering-test.mjs
 *   SECTIONS=runtime node scripts/layout-centering-test.mjs      (runtime only; SECTIONS=studio for the Studio only)
 *
 * The Studio needs AI_API_URL=fake: (the copilot replies are supplied by the suite).
 *
 * "When a theme or layout is applied or updated, the content can shift toward
 * the left side of the screen." Measured, at 1600×1000, 1280×800, 1024×768,
 * 768×1024 and 390×844:
 *
 *   RUNTIME  the respondent survey's frame (`.rs-shell`) is centred on the
 *            window — with no theme, a preset, a "contained" theme, a theme that
 *            sets contentAlign — and applying the theme does not move its centre;
 *            cards sit centred in the frame; contentAlign moves the TEXT only;
 *            nothing scrolls sideways; a survey's scoped look-and-behaviour CSS
 *            still applies under a different theme.
 *   STUDIO   Intelligent Mode's conversation column is centred in its pane,
 *            before and after a preset and a Design-with-AI theme are applied;
 *            the toolbar's controls stay inside the pane; a 25,000-character
 *            prompt and a very long research plan never widen the page, the log
 *            or a card; the ask bar lines up with the column; the theme's live
 *            preview and the copilot's card preview (`cp-ux-shell`) stay centred
 *            in their frames on every device size; the Studio canvas is centred.
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions } from "../packages/engine/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? process.env.RUNTIME ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "runtime,studio").split(",").map((s) => s.trim()));
const SHOTS = process.env.SHOTS ?? "";
const VIEWPORTS = [[1600, 1000], [1280, 800], [1024, 768], [768, 1024], [390, 844]];
const TOL = 1.5;
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const near = (a, b, what, tol = TOL) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (off by ${Math.round((a - b) * 10) / 10}px)`);

/* ------------------------------------------------------------ a survey */
let n = 0;
const build = (actions, base) => {
  const c = coerceSurveyActions(actions);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  const r = applySurveyActions(base, c.actions, { ids: (p) => `${p}_${++n}` });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  return r.def;
};
const LONG_WORD = "Supercalifragilistic".repeat(20); // 400 characters with no break opportunity
const structure = build([
  { op: "create_block", title: "Brand" },
  { op: "create_question", ref: "FAV", type: "single", text: "Which brand do you prefer?", options: ["Alpha", "Beta", "Gamma"] },
  { op: "create_question", ref: "OTHERQ", type: "single", text: "Which colour do you like?", options: ["Red", "Blue"] },
], SurveyDefinition.parse({ meta: { id: "layout-srv", code: "L", title: "Layout" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] }));
const withUx = build([
  { op: "create_style", label: "Q1 cards", target: "Q1.options", rules: [{ declarations: { "border-radius": "14px", "border-color": "rgb(255, 0, 128)" } }] },
  { op: "create_animation", label: "Pop on select", target: "Q1.options", preset: "pop", trigger: "select", duration: 200 },
  { op: "create_behavior", label: "Mark Q2 picks", target: "Q2", script: `rs.listen("select", "self", (e) => rs.addClass("self", "picked-" + e.option));` },
], structure);

/** the themes a researcher applies — Branding presets (apps/studio/lib/defaults.ts) and what Design with AI proposes */
const THEMES = {
  "no theme": {},
  "Gen-Z preset (640px, full)": { colors: { primary: "#7c3aed" }, layout: { maxWidth: "640px", cardStyle: "card", radius: "20px", spacing: "regular", widthMode: "full", contentAlign: "left" } },
  "Luxury preset (680px, line)": { colors: { primary: "#111827" }, layout: { maxWidth: "680px", cardStyle: "line", radius: "2px", spacing: "relaxed", widthMode: "full", contentAlign: "left" } },
  "contained 640px (default align)": { colors: { primary: "#0f766e" }, layout: { widthMode: "contained", maxWidth: "640px" } },
  "contained 560px, align right": { layout: { widthMode: "contained", maxWidth: "560px", contentAlign: "right" }, appearance: { optionStyle: "pills" } },
  "AI theme: contained, centred text": { colors: { primary: "#dc3214" }, layout: { widthMode: "contained", maxWidth: "600px", contentAlign: "center", radius: "16px" }, appearance: { optionStyle: "cards", shadow: "soft" } },
};
const themed = (def, branding, id) => SurveyDefinition.parse({ ...structuredClone(def), meta: { ...def.meta, id }, branding: { ...structuredClone(def.branding ?? {}), ...branding, layout: { ...(def.branding?.layout ?? {}), ...(branding.layout ?? {}) } } });

const browser = await chromium.launch();

/* ======================================================================= RUNTIME */
if (SECTIONS.has("runtime")) {
  const frame = (pv) => pv.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const s = document.querySelector(".rs-shell"), cs = getComputedStyle(s), b = s.getBoundingClientRect();
    const contentL = b.x + parseFloat(cs.paddingLeft), contentR = b.right - parseFloat(cs.paddingRight);
    const cards = [...document.querySelectorAll(".rs-card")].map((c) => { const r = c.getBoundingClientRect(); return { x: r.x, w: r.width, cx: r.x + r.width / 2 }; });
    return { vw, iw: innerWidth, sw: document.documentElement.scrollWidth, x: b.x, w: b.width, cx: b.x + b.width / 2, contentCx: (contentL + contentR) / 2, cards };
  });
  for (const [w, h] of VIEWPORTS) {
    let base = null;
    for (const [name, branding] of Object.entries(THEMES)) {
      const def = themed(structure, branding, `lc-${w}-${Object.keys(THEMES).indexOf(name)}`);
      const pv = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: w, height: h } });
      const f = await frame(pv);
      if (SHOTS && w === 1600) await pv.screenshot({ path: `${SHOTS}/runtime-${w}-${Object.keys(THEMES).indexOf(name)}.png` });
      await pv.close();
      near(f.cx, f.vw / 2, `${w}px, ${name}: the survey frame's centre vs the window's centre`);
      assert.ok(f.sw <= f.iw, `${w}px, ${name}: no horizontal scroll (${f.sw} > ${f.iw})`);
      assert.ok(f.cards.length > 0);
      for (const c of f.cards) near(c.cx, f.contentCx, `${w}px, ${name}: a card centred in the frame`);
      if (!base) base = f; else near(f.cx, base.cx, `${w}px: applying "${name}" moved the frame's centre`);
    }
    ok(`${w}×${h}: the survey frame is centred on the window (±${TOL}px) with no theme and with ${Object.keys(THEMES).length - 1} themes (presets, contained, aligned) — applying one never moves it; cards centred; no sideways scroll`);
  }
  {
    // contentAlign: the text inside the frame, never the frame
    const read = async (align, width) => {
      const def = themed(structure, { layout: { widthMode: width, maxWidth: "640px", contentAlign: align } }, `al-${align}-${width}`);
      const pv = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1600, height: 1000 } });
      const r = await pv.evaluate(() => {
        const t = document.querySelector(".rs-qtext"), tb = t.getBoundingClientRect();
        const c = t.closest(".rs-card"), cb = c.getBoundingClientRect(), cs = getComputedStyle(c);
        const s = document.querySelector(".rs-shell").getBoundingClientRect();
        return { align: getComputedStyle(t).textAlign, tl: tb.x - (cb.x + parseFloat(cs.paddingLeft)), tr: (cb.right - parseFloat(cs.paddingRight)) - tb.right, shellCx: s.x + s.width / 2, vw: document.documentElement.clientWidth };
      });
      await pv.close();
      return r;
    };
    for (const width of ["contained", "full"]) {
      const l = await read("left", width), c = await read("center", width), r = await read("right", width);
      for (const x of [l, c, r]) near(x.shellCx, x.vw / 2, `${width}: the frame stays centred whatever contentAlign says`);
      assert.equal(l.align, "start", "left = the writing direction's start (an RTL survey stays right-aligned)");
      assert.equal(c.align, "center"); assert.equal(r.align, "right");
      if (width === "full") {
        // the 68ch measured text block follows the alignment inside a wide card
        near(l.tl, 0, "left: the measured text starts at the card's content edge");
        near(c.tl, c.tr, "center: the measured text block is centred in the card", 2);
        near(r.tr, 0, "right: the measured text ends at the card's content edge");
      }
    }
    ok("contentAlign moves the question text (start / center / right, and the 68ch block in a full-width card) — never the survey frame, which stays centred in contained and full mode");
  }
  {
    // nothing a survey says can widen the page on a phone
    const def = build([{ op: "create_question", ref: "LONGQ", type: "single", text: `A very long word: ${LONG_WORD}`, options: [`Option ${LONG_WORD}`, "Short"] }], structure);
    for (const [w, h] of [[390, 844], [768, 1024]]) {
      const pv = await openPreview(browser, RUNTIME, { definition: themed(def, THEMES["AI theme: contained, centred text"], `lw-${w}`) }, { viewport: { width: w, height: h } });
      const f = await frame(pv);
      await pv.close();
      assert.ok(f.sw <= f.iw, `${w}px: a 400-character word in a question widened the page to ${f.sw}px`);
      near(f.cx, f.vw / 2, `${w}px, long word: frame centred`);
    }
    ok("a 400-character unbroken word in a question and an option wraps inside its card at 390px and 768px — no sideways scroll");
  }
  {
    // §13: a survey's scoped look-and-behaviour CSS keeps working when the theme changes
    const radius = async (branding, id) => {
      const pv = await openPreview(browser, RUNTIME, { definition: themed(withUx, branding, id) }, { viewport: { width: 1280, height: 900 } });
      const q1 = withUx.questions[0].id, q2 = withUx.questions[1].id;
      const r = await pv.evaluate(([a, b]) => {
        const o1 = document.querySelector(`[data-rs-el="question"][data-rs-id="${a}"] [data-rs-el="option"]`), o2 = document.querySelector(`[data-rs-el="question"][data-rs-id="${b}"] [data-rs-el="option"]`);
        return { r1: getComputedStyle(o1).borderTopLeftRadius, c1: getComputedStyle(o1).borderTopColor, r2: getComputedStyle(o2).borderTopLeftRadius, css: !!document.querySelector("style[data-rs-ux-css]") };
      }, [q1, q2]);
      await pv.close();
      return r;
    };
    const plain = await radius({}, "ux-a"), pills = await radius(THEMES["contained 560px, align right"], "ux-a"), cards = await radius(THEMES["AI theme: contained, centred text"], "ux-a");
    for (const r of [plain, pills, cards]) { assert.ok(r.css); assert.equal(r.r1, "14px", "the scoped style wins over the theme's option style"); assert.equal(r.c1, "rgb(255, 0, 128)"); }
    assert.equal(pills.r2, "999px", "the theme still styles what the UX does not (pills)");
    assert.equal(cards.r2, "16px", "the theme still styles what the UX does not (cards at the theme radius)");
    ok("a scoped style (Q1 options: 14px, pink border) keeps applying under no theme, a pills theme and a cards theme, while the theme still restyles Q2 (999px / 16px)");
  }
  {
    // §13: the theme CHANGES while the survey is open (the Studio pushes a new definition to its preview window):
    // the scoped CSS, the animation and the sandboxed script survive the re-render — once, not twice — and the frame stays put
    const q1 = withUx.questions[0].id, q2 = withUx.questions[1].id;
    const pv = await openPreview(browser, RUNTIME, { definition: themed(withUx, {}, "ux-live") }, { viewport: { width: 1280, height: 900 } });
    await pv.waitForSelector("iframe[data-rs-ux-sandbox]", { state: "attached", timeout: 10000 });
    const state = () => pv.evaluate(([a, b]) => {
      const s = document.querySelector(".rs-shell").getBoundingClientRect();
      const o1 = document.querySelector(`[data-rs-el="question"][data-rs-id="${a}"] [data-rs-el="option"]`), o2 = document.querySelector(`[data-rs-el="question"][data-rs-id="${b}"] [data-rs-el="option"]`);
      return { cx: s.x + s.width / 2, vw: document.documentElement.clientWidth, cls: document.querySelector(".rs-shell").className, r1: getComputedStyle(o1).borderTopLeftRadius, r2: getComputedStyle(o2).borderTopLeftRadius, sheets: document.querySelectorAll("style[data-rs-ux-css]").length, frames: document.querySelectorAll("iframe[data-rs-ux-sandbox]").length, css: document.querySelector("style[data-rs-ux-css]")?.textContent ?? "" };
    }, [q1, q2]);
    const a = await state();
    await pv.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), themed(withUx, THEMES["contained 560px, align right"], "ux-live"));
    await pv.waitForFunction(() => document.querySelector(".rs-shell")?.className.includes("rs-opt-pills"), null, { timeout: 10000 });
    await pv.waitForTimeout(400);
    const b = await state();
    near(a.cx, a.vw / 2, "live theme change, before: frame centred"); near(b.cx, b.vw / 2, "live theme change, after: frame centred");
    assert.equal(a.r1, "14px"); assert.equal(b.r1, "14px", "the scoped style survives the theme change");
    assert.equal(b.r2, "999px", "the new theme applies to what the UX does not style");
    assert.equal(b.sheets, 1, "one compiled stylesheet, not one per render"); assert.equal(b.frames, 1, "one sandbox frame for the script, not one per render");
    assert.match(b.css, /prefers-reduced-motion: no-preference/, "the animation stays behind the reduced-motion query");
    await pv.click(`[data-rs-el="question"][data-rs-id="${q2}"] [data-rs-el="option"] >> nth=0`);
    await pv.waitForFunction((id) => (document.querySelector(`[data-rs-el="question"][data-rs-id="${id}"]`)?.getAttribute("data-rs-ux-on") ?? "").includes("picked-"), q2, { timeout: 5000 });
    const on = await pv.$eval(`[data-rs-el="question"][data-rs-id="${q2}"]`, (e) => e.getAttribute("data-rs-ux-on"));
    assert.equal(on.split(/\s+/).filter((c) => c.startsWith("picked-")).length, 1, `the script ran once after the theme change: ${on}`);
    await pv.close();
    ok("a theme changed live (the Studio pushing a new definition): the frame stays centred, the scoped style keeps 14px, the new theme styles the rest, one stylesheet and one script frame remain, the script still answers once");
  }
}

/* ======================================================================= STUDIO */
if (SECTIONS.has("studio")) {
  const goto = async (page) => {
    // the dev server restarts itself near its memory ceiling; a navigation that lands on that gap is retried
    for (let i = 0; ; i++) {
      try { await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: 120000 }); await page.waitForSelector(".menubar [data-group-button]", { timeout: 60000 }); return; }
      catch (e) { if (i >= 4) throw e; await page.waitForTimeout(8000); }
    }
  };
  const loadDef = async (page, def) => {
    await openTab(page, "JSON");
    await page.waitForSelector("textarea.code");
    await page.click('button:has-text("edit")');
    await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
    await page.click('button:has-text("validate & apply")');
    await page.waitForTimeout(800);
    await openTab(page, "Questions");
  };
  const intelligent = async (page) => { await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); await page.waitForTimeout(300); };
  /** the conversation column: whatever the log shows first (the welcome) or last (a turn), against the log's content box */
  const column = (page) => page.evaluate(() => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, right: b.right, w: b.width, cx: b.x + b.width / 2 }; };
    const log = document.querySelector('[data-testid="iq-log"]'), ls = getComputedStyle(log), lb = log.getBoundingClientRect();
    const main = document.querySelector('[data-testid="iq-main"]');
    const turns = [...document.querySelectorAll(".iq-turn")];
    const col = turns.at(-1) ?? document.querySelector('[data-testid="iq-welcome"]');
    const mainB = r(main);
    const tools = [...document.querySelectorAll(".iq-toolbar > *")].filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "none" && !e.classList.contains("iq-spacer") && !e.classList.contains("iq-hint"));
    const hidden = tools.filter((e) => { const b = e.getBoundingClientRect(); if (b.x < mainB.x - 1 || b.right > mainB.right + 1) return true; const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !hit || !(e === hit || e.contains(hit)); }).map((e) => e.getAttribute("data-testid") || e.className);
    const input = document.querySelector('[data-testid="iq-input"]').getBoundingClientRect(), send = document.querySelector(".iq-ask .iq-send")?.getBoundingClientRect();
    return {
      iw: innerWidth, sw: document.documentElement.scrollWidth,
      logCx: lb.x + parseFloat(ls.paddingLeft) + (lb.width - parseFloat(ls.paddingLeft) - parseFloat(ls.paddingRight)) / 2,
      logSw: log.scrollWidth, logCw: log.clientWidth, main: mainB, col: r(col),
      turnOverflow: turns.map((t) => t.scrollWidth - t.clientWidth).filter((d) => d > 1),
      hidden, inputX: input.x, sendRight: send?.right ?? null,
    };
  });
  const checkColumn = (m, where) => {
    near(m.col.cx, m.logCx, `${where}: the conversation column's centre vs its pane's`);
    assert.ok(m.sw <= m.iw, `${where}: the page scrolls sideways (${m.sw} > ${m.iw})`);
    assert.ok(m.logSw <= m.logCw + 1, `${where}: the conversation scrolls sideways (${m.logSw} > ${m.logCw})`);
    assert.deepEqual(m.turnOverflow, [], `${where}: a card is wider than its turn`);
    assert.deepEqual(m.hidden, [], `${where}: toolbar controls outside the pane or covered`);
  };
  const LONG_PROMPT = "Measure brand trust across segments with a detailed objective, hypotheses, population and analysis plan. ".repeat(250).slice(0, 25000);
  const LONG_PLAN = {
    kind: "answer",
    reply: "Here is the research plan. " + "The methodology, sampling and analysis are explained at length so the reply keeps going. ".repeat(60) + ` See https://example.com/${"a".repeat(400)}`,
    plan: Array.from({ length: 14 }, (_, i) => ({ block: `Block ${i + 1}: ${"Very long block name ".repeat(6)}`, questions: 5, purpose: `${"Explains the reason for this block in depth ".repeat(5)}${"y".repeat(200)}` })),
    understanding: { objective: `Objective ${"o".repeat(500)}`, hypotheses: [`H1 ${"a long hypothesis ".repeat(30)}`, `H2 ${"z".repeat(300)}`], population: "Adults 18+", variables: Array.from({ length: 8 }, (_, i) => ({ name: `Variable_${i}_${"v".repeat(80)}`, role: i % 2 ? "dependent" : "independent", measure: `Measured by ${"a long scale description ".repeat(5)}` })), methodology: "m ".repeat(200), analysis: ["regression", "t-test"] },
    assumptions: [`Assume ${"w".repeat(300)}`], questions: [], actions: [], findings: [], sources: [],
  };
  /*
   * The dev server restarts itself near its memory ceiling (NODE_OPTIONS=--max-old-space-size=2000, shared
   * machine); a request that lands on the restart fails with a network error. Those — and only those — are
   * retried: a turn that fails for any other reason fails the suite.
   */
  const say = async (page, text, reply) => {
    for (let attempt = 0; ; attempt++) {
      const before = (await page.$$('[data-testid="cp-turn"]')).length;
      await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
      if (reply) await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
      await page.fill('[data-testid="iq-input"]', text);
      await page.keyboard.press("Enter");
      const done = await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, before, { timeout: 90000 }).then(() => true, () => false);
      const status = done ? await page.$$eval('[data-testid="cp-turn"]', (t) => t.at(-1).getAttribute("data-status")) : "timeout";
      if (status !== "failed" && status !== "timeout") return;
      const why = done ? await page.$$eval('[data-testid="cp-turn"]', (t) => t.at(-1).textContent.slice(0, 300)) : "no answer in 90s";
      if (attempt >= 2 || (done && !/network|fetch|reach|connect|server|restart|unavailable|try again/i.test(why))) throw new Error(`the copilot turn failed: ${why}`);
      console.log(`  ..   the Studio dev server dropped a copilot request (${status}); retrying`);
      await page.waitForTimeout(10000);
    }
  };
  const askTheme = async (page, prompt, reply) => {
    for (let attempt = 0; ; attempt++) {
      await page.evaluate((r) => window.__rescriptThemeFake(r), reply);
      await page.fill('[data-testid="theme-assistant-input"]', prompt);
      await page.click('[data-testid="theme-assistant-ask"]');
      const got = await page.waitForSelector('[data-testid="theme-assistant-proposal"], [data-testid="theme-assistant-error"]', { timeout: 90000 }).then(() => true, () => false);
      const err = got ? await page.$('[data-testid="theme-assistant-error"]') : null;
      if (got && !err) return;
      const why = err ? await err.textContent() : "no answer in 90s";
      if (attempt >= 2 || (err && !/network|fetch|reach|connect|server|restart|unavailable|try again/i.test(why))) throw new Error(`the theme request failed: ${why}`);
      console.log("  ..   the Studio dev server dropped a theme request; retrying");
      await page.waitForTimeout(10000);
    }
  };
  const studioDef = { ...structuredClone(structure), meta: { ...structure.meta, id: "sandbox" }, deployment: { clientSlug: "c", studySlug: "s" } };

  const previewFrame = (page) => page.evaluate(() => {
    const s = document.querySelector('[data-testid="theme-preview-shell"]').getBoundingClientRect(), f = document.querySelector(".theme-preview-frame").getBoundingClientRect();
    return { l: s.x - f.x, r: f.right - s.right, sw: document.documentElement.scrollWidth, iw: innerWidth };
  });
  const checkPreview = async (page, where) => {
    for (const d of ["desktop", "tablet", "mobile"]) {
      await page.click(`[data-testid="theme-preview-${d}"]`);
      await page.waitForTimeout(120);
      const p = await previewFrame(page);
      near(p.l, p.r, `${where}, ${d}: the theme preview's survey is centred in its frame`);
      assert.ok(p.sw <= p.iw, `${where}, ${d}: the page scrolls sideways`);
    }
    await page.click('[data-testid="theme-preview-desktop"]');
  };

  for (const [w, h] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    // a dev-server restart (see `say`) can drop a chunk or a fetch: that is the environment, not the page
    page.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk|Failed to fetch|NetworkError/.test(String(e))) errors.push(String(e).slice(0, 300)); });
    page.on("dialog", (d) => d.accept());
    await goto(page);
    await loadDef(page, studioDef);
    // the Studio canvas: its column is centred in the workspace
    const canvas = await page.evaluate(() => {
      const c = document.querySelector(".center"), cs = getComputedStyle(c), b = c.getBoundingClientRect();
      const q = document.querySelector(".qcard").getBoundingClientRect();
      const blk = document.querySelector(".block")?.getBoundingClientRect() ?? q;
      return { centerCx: b.x + parseFloat(cs.paddingLeft) + (c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / 2, blockCx: blk.x + blk.width / 2, sw: document.documentElement.scrollWidth, iw: innerWidth };
    });
    near(canvas.blockCx, canvas.centerCx, `${w}px: the Studio canvas's block column vs the workspace`);
    assert.ok(canvas.sw <= canvas.iw, `${w}px: the Studio canvas scrolls sideways (${canvas.sw})`);

    await intelligent(page);
    const before = await column(page);
    checkColumn(before, `${w}px, welcome`);

    // apply a theme: a Branding preset, then Design with AI's proposal (contained, narrow, right-aligned text)
    await openTab(page, "Branding");
    await page.waitForSelector('[data-testid="theme-preview-shell"]');
    await checkPreview(page, `${w}px, survey's own theme`);
    const preset = await page.$('select.select:has(option:text("Apply preset theme…"))');
    await preset.selectOption("Gen-Z");
    await page.waitForTimeout(250);
    await checkPreview(page, `${w}px, Gen-Z preset applied`);
    await askTheme(page, "make it compact and teal, text on the right", { kind: "proposal", reply: "A compact teal theme.", actions: [{ op: "set_theme", colors: { primary: "#0f766e" }, layout: { widthMode: "contained", maxWidth: "300px", contentAlign: "right" } }] });
    await checkPreview(page, `${w}px, AI theme proposed`);
    await page.click('[data-testid="theme-assistant-apply"]');
    await page.waitForSelector('[data-testid="theme-assistant-proposal"]', { state: "detached" });
    await checkPreview(page, `${w}px, AI theme applied`);

    await openTab(page, "Questions");
    await intelligent(page);
    const after = await column(page);
    checkColumn(after, `${w}px, after the themes`);
    near(after.col.cx, before.col.cx, `${w}px: applying the themes moved Intelligent Mode's column`);
    near(after.col.w, before.col.w, `${w}px: applying the themes re-sized Intelligent Mode's column`);

    // a 25,000-character prompt and a very long research plan
    await say(page, LONG_PROMPT, LONG_PLAN);
    await page.waitForTimeout(300);
    const long = await column(page);
    checkColumn(long, `${w}px, 25k prompt + long plan`);
    near(long.col.cx, before.col.cx, `${w}px: a long turn moved the column`);
    if (long.main.w >= 860 + 48) {
      near(long.inputX, long.col.x, `${w}px: the ask bar's left edge vs the column's`, 2);
      if (long.sendRight != null) near(long.sendRight, long.col.right, `${w}px: the ask bar's right edge vs the column's`, 2);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/iq-${w}-after.png` });

    // the copilot's card preview (cp-ux-shell) with the applied theme (contained 300px, text right)
    if (w >= 1024) {
      await say(page, "For Q1, make the answer options look like modern cards. Don't change any survey logic.", {
        kind: "proposal", reply: "UX only: card-style options on Q1.",
        actions: [{ op: "create_style", label: "Q1 option cards", target: "Q1.options", rules: [{ declarations: { "border-radius": "16px" } }] }],
      });
      await page.waitForSelector('[data-testid="cp-ux-shell"] [data-rs-el="option"]', { timeout: 30000 });
      for (const d of ["desktop", "tablet", "mobile"]) {
        const m = await page.evaluate(() => {
          const s = document.querySelector('[data-testid="cp-ux-shell"]').getBoundingClientRect(), st = s && document.querySelector('[data-testid="cp-ux-shell"]').closest(".cp-ux-stage").getBoundingClientRect();
          const o = document.querySelector('[data-testid="cp-ux-shell"] [data-rs-el="option"]');
          return { l: s.x - st.x, r: st.right - s.right, w: s.width, radius: getComputedStyle(o).borderTopLeftRadius, device: document.querySelector('[data-testid="cp-ux-preview"]').dataset.device ?? "desktop" };
        });
        near(m.l, m.r, `${w}px, cp-ux-shell (${m.device}): the themed card preview is centred in its stage`);
        assert.equal(m.radius, "16px", "the proposed scoped style applies under the theme");
        if (d !== "mobile") await page.click('[data-testid="cp-ux-mobile"]');
      }
      await page.click('[data-testid="cp-panel-cancel"]').catch(() => {});
      const ux = await column(page);
      checkColumn(ux, `${w}px, with the card preview open`);
    }
    assert.deepEqual(errors, [], errors.join("\n"));
    ok(`${w}×${h}: Studio canvas centred; Intelligent Mode's column centred in its pane (±${TOL}px) and unmoved by a preset and an AI theme; toolbar controls all in the pane; a 25k-character prompt + 14-block plan never scroll sideways${w >= 1024 ? "; the themed card preview centred at desktop / tablet / phone" : ""}; the theme preview centred on every device`);
    await page.close();
  }
}

await browser.close();
console.log(`\n${passed} passed`);
