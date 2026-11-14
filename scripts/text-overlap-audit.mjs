/**
 * TEXT OVERLAP AUDIT (2026-11-13) — finds text drawn on top of other text, and text squeezed into a sliver.
 *
 * Found first by eye: a "Tip" check on the Branch card carried the class `tip`, the Studio's 16 px tooltip icon,
 * and its sentence wrapped one word per line over the fields below. This walks every Studio tool with the Master
 * Demo loaded (every flow element, loops, List Fills, quotas…), at three window widths, and reports:
 *
 *   overlap   two different text runs whose boxes intersect by more than 35% of the smaller one
 *   sliver    a run of 24+ characters laid out in a box narrower than 48 px (one word per line)
 *   clipped   text whose line box extends outside an ancestor that clips it (overflow hidden) by 4+ px vertically
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/text-overlap-audit.mjs [--widths 1700,1280,1024] [--tools "Survey Flow,List Fill"]
 *   … --self-test   re-plants the original bug (the `tip` class on every check) and expects it to be found
 */
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";
import { buildMasterDemoSurvey, buildScaleSurvey } from "../packages/templates/dist/index.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WIDTHS = arg("widths", "1700,1280,1024").split(",").map(Number);
const TOOLS = arg("tools", null)?.split(",").map((s) => s.trim());

/* a 30-question survey (display logic, skips, matrices) plus one of every flow element, a List Fill and a quota */
function seedSurvey() {
  const d = buildScaleSurvey(30);
  const master = buildMasterDemoSurvey();
  const q1 = d.questions.find((q) => q.type === "multi_select") ?? d.questions[0];
  d.listFills = master.listFills.slice(0, 1).map((lf) => ({ ...lf, source: { kind: "question", questionId: q1.id, take: "selected" }, destinations: [] }));
  d.quotas = [{ id: "qt1", name: "Region quota with a long descriptive name for wrapping", mode: "hard", targetTotal: 500, onFull: { kind: "terminate" }, cells: [] }];
  const page0 = d.flow.find((n) => n.type === "page" || n.type === "block" || n.type === "section");
  d.flow.splice(1, 0,
    { type: "embedded_data", id: "ED1", fields: [{ name: "source_panel_identifier", source: "url", dataType: "auto" }, { name: "", source: "static" }] },
    { type: "randomizer", id: "RND1", children: [{ type: "page", id: "pr1", questionIds: [] }] },
    { type: "branch", id: "BR1", branches: [{ id: "b1", label: "Path 1", when: { type: "rule", source: { kind: "question", ref: q1.id }, operator: "eq", value: "1" }, children: [] }, { id: "b2", label: "A path with a long name", when: { type: "group", op: "and", children: [] }, children: [] }], otherwise: [] },
    { type: "loop", id: "LOOP1", loopVar: "brand", source: { kind: "static", items: [] }, children: [] },
    { type: "quota_check", id: "QC1", quotaIds: [], onFull: { kind: "redirect", url: "" } },
    { type: "redirect", id: "RD1", url: "https://" },
  );
  return d;
}
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTHS[0], height: 1000 } });
await ctx.addInitScript((s) => { window.__rescriptSandboxSeed = s; }, process.argv.includes("--master") ? buildMasterDemoSurvey() : seedSurvey());
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const PAGES_MODE = process.argv.includes("--urls") || process.argv.includes("--runtime");
let tools = [];
if (!PAGES_MODE) {
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "domcontentloaded", timeout: 150000 });
  await page.waitForSelector(".menubar [data-group-button]", { timeout: 120000 });
  const labels = await page.$$eval(".menubar [data-group-button]", (bs) => bs.flatMap((b) => (b.getAttribute("data-nav-items") ?? "").split(" ").filter(Boolean).map((x) => x.replace(/_/g, " "))));
  tools = (TOOLS ?? [...new Set(labels)]).filter((t) => !/^(JSON)$/.test(t));
}

const scan = () => page.evaluate(() => {
  const vis = (el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : !!el.offsetParent) && !el.closest('[aria-hidden="true"]');
  const describe = (el) => {
    const tid = el.closest("[data-testid]")?.getAttribute("data-testid");
    return `${el.tagName.toLowerCase()}.${String(el.className || "").split(" ").filter(Boolean).slice(0, 3).join(".")}${tid ? ` in [${tid}]` : ""}`;
  };
  const runs = [];
  const walker = document.createTreeWalker(document.querySelector("main, .ide-body, body"), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.replace(/\s+/g, " ").trim();
    if (text.length < 2) continue;
    const el = n.parentElement;
    if (!el || ["SCRIPT", "STYLE", "OPTION", "TEXTAREA", "TITLE"].includes(el.tagName) || el.closest("select, svg, [role=tooltip], .sr-only, .visually-hidden")) continue;
    if (!vis(el)) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    /* a line box reports its position even when a scroll container has scrolled it out of sight: keep only the part
       inside every scrolling ancestor's visible box (otherwise scrolled-away text "overlaps" the menubar) */
    let view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.overflowY !== "visible" || st.overflowX !== "visible") {
        const c = e.getBoundingClientRect();
        view = { left: Math.max(view.left, c.left), top: Math.max(view.top, c.top), right: Math.min(view.right, c.right), bottom: Math.min(view.bottom, c.bottom) };
      }
    }
    const clipRect = (x) => ({ left: Math.max(x.left, view.left), top: Math.max(x.top, view.top), right: Math.min(x.right, view.right), bottom: Math.min(x.bottom, view.bottom) });
    const rawRects = [...r.getClientRects()].filter((x) => x.width > 2 && x.height > 4);
    const rects = rawRects.map(clipRect).map((x) => ({ ...x, width: x.right - x.left, height: x.bottom - x.top })).filter((x) => x.width > 2 && x.height > 4);
    if (!rects.length && !rawRects.length) continue;
    /* the layer: the nearest fixed or sticky ancestor (header, menubar, toolbars). Content scrolled under a sticky
       header is hidden by it, not overlapping it — so only runs in the same layer are compared */
    let layer = null;
    /* …and popovers: an absolutely positioned box with its own z-index paints over what is beneath on purpose */
    for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.position === "fixed" || cs.position === "sticky" || (cs.position === "absolute" && cs.zIndex !== "auto")) { layer = e; break; } }
    runs.push({ el, text, rects, rawRects, box: el.getBoundingClientRect(), layer });
  }
  const issues = [];
  /* sliver */
  for (const r of runs) {
    if (r.text.length >= 24 && r.box.width < 48 && r.rawRects.length >= 3) issues.push({ kind: "sliver", where: describe(r.el), text: r.text.slice(0, 60), detail: `${Math.round(r.box.width)} px wide, ${r.rawRects.length} lines` });
  }
  /* overlap: compare line rects of different elements, neither containing the other */
  const area = (a) => Math.max(0, a.width) * Math.max(0, a.height);
  const inter = (a, b) => ({ width: Math.min(a.right, b.right) - Math.max(a.left, b.left), height: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) });
  const seen = new Set();
  const CELL = 120, grid = new Map();
  runs.forEach((r, idx) => {
    for (let gx = Math.floor(r.box.left / CELL); gx <= Math.floor(r.box.right / CELL); gx++)
      for (let gy = Math.floor(r.box.top / CELL); gy <= Math.floor(r.box.bottom / CELL); gy++) {
        const k = gx + ":" + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx);
      }
  });
  const pairs = new Set();
  for (const ids of grid.values()) for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) pairs.add(ids[a] < ids[b] ? ids[a] * 1e6 + ids[b] : ids[b] * 1e6 + ids[a]);
  for (const p of pairs) {
    const A = runs[Math.floor(p / 1e6)], B = runs[p % 1e6];
    if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el) || A.layer !== B.layer) continue;
    let hit = null;
    for (const ra of A.rects) { for (const rb of B.rects) { const x = inter(ra, rb); if (x.width > 2 && x.height > 2 && area(x) > 0.35 * Math.min(area(ra), area(rb))) { hit = x; break; } } if (hit) break; }
    if (!hit) continue;
    const key = `${describe(A.el)}|${describe(B.el)}`;
    if (seen.has(key)) continue; seen.add(key);
    issues.push({ kind: "overlap", where: `${describe(A.el)} × ${describe(B.el)}`, text: `“${A.text.slice(0, 40)}” × “${B.text.slice(0, 40)}”` });
  }
  /* clipped: the nearest ancestor that does not let content overflow visibly HIDES it (a scroll container only scrolls
     it, and horizontal ellipsis truncation is intended) */
  for (const r of runs) {
    for (let e = r.el.parentElement; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.overflowY === "visible" && s.overflowX === "visible") continue;
      if (s.overflowY === "auto" || s.overflowY === "scroll") break;
      const c = e.getBoundingClientRect();
      const last = r.rawRects[r.rawRects.length - 1], first = r.rawRects[0];
      if ((s.overflowY === "hidden" || s.overflowY === "clip") && c.height > 10 && (last.bottom - c.bottom > 4 || c.top - first.top > 4)
          && s.textOverflow !== "ellipsis" && getComputedStyle(r.el).textOverflow !== "ellipsis" && !/-webkit-box/.test(s.display) && !s.webkitLineClamp?.match(/\d/)) {
        issues.push({ kind: "clipped", where: describe(r.el), text: r.text.slice(0, 60), detail: `cut by ${describe(e)}` });
      }
      break;
    }
  }
  return issues;
});

/* ---------------------------------------------------------------- other pages and the respondent survey */
const URLS = arg("urls", null)?.split(",").map((x) => x.trim()).filter(Boolean);
const RUNTIME = arg("runtime", null); // e.g. http://localhost:3001 — walks a sandbox survey page by page
async function scanScrolling() {
  const found = [];
  for (let step = 0; step < 12; step++) {
    found.push(...(await scan()));
    const more = await page.evaluate(() => { const m = document.scrollingElement; if (m.scrollTop + innerHeight >= m.scrollHeight - 4) return false; m.scrollTop += Math.floor(innerHeight * 0.9); return true; });
    if (!more) break;
    await page.waitForTimeout(150);
  }
  return found;
}
if (URLS || RUNTIME) {
  const out = [];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w < 600 ? 800 : 1000 });
    for (const u of URLS ?? []) {
      await page.goto(`${STUDIO}${u}`, { waitUntil: "domcontentloaded", timeout: 150000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const f = await scanScrolling(); console.log(`  scanned ${u} @${w}: ${f.length}`);
      for (const i of f) out.push({ width: w, tool: u, ...i });
    }
    if (RUNTIME) {
      const def = process.argv.includes("--master") ? buildMasterDemoSurvey() : buildScaleSurvey(30);
      const r = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) }).then((x) => x.json());
      await page.goto(`${RUNTIME}${r.url}`, { waitUntil: "domcontentloaded", timeout: 150000 });
      await page.waitForTimeout(3000);
      let walked = 0;
      for (let p = 0; p < 40; p++) {
        walked = p + 1;
        const f = await scanScrolling(); for (const i of f) out.push({ width: w, tool: `respondent page ${p + 1}`, ...i });
        /* answer what is on the page with the first choice, type into text boxes, then Next */
        await page.evaluate(() => {
          for (const g of document.querySelectorAll('[role="radiogroup"], .rs-options')) { const first = g.querySelector('input[type=radio], input[type=checkbox]'); if (first && !first.checked) first.click(); }
          for (const i of document.querySelectorAll('input[type=number]')) if (!i.value) { i.value = "30"; i.dispatchEvent(new Event("input", { bubbles: true })); }
          for (const i of document.querySelectorAll('input[type=text], textarea')) if (!i.value) { i.value = "fine"; i.dispatchEvent(new Event("input", { bubbles: true })); }
          window.scrollTo(0, 0);
        });
        const next = await page.$('.rs-nav .rs-btn:not(.secondary)');
        if (!next) break;
        await next.click().catch(() => {});
        await page.waitForTimeout(700);
        if (await page.$('[data-testid="end-screen"], .rs-end, .rs-complete')) { const f2 = await scanScrolling(); for (const i of f2) out.push({ width: w, tool: "respondent end", ...i }); break; }
      }
      console.log(`  scanned respondent survey @${w}: ${walked} page(s)`);
    }
  }
  const u2 = new Map();
  for (const i of out) { const k = `${i.tool}|${i.kind}|${i.where}`; if (!u2.has(k)) u2.set(k, { ...i, widths: [i.width] }); else u2.get(k).widths.push(i.width); }
  for (const i of u2.values()) console.log(`${i.kind.padEnd(8)} ${i.tool} @${[...new Set(i.widths)].join("/")}: ${i.where} — ${i.text}${i.detail ? ` (${i.detail})` : ""}`);
  console.log(`\ntext-overlap-audit (pages): ${u2.size} issue(s)`);
  await browser.close();
  process.exit(0);
}

const all = [];
for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 1000 });
  for (const t of tools) {
    try {
      await openTab(page, t);
      await page.waitForTimeout(700);
      /* open every collapsed flow card and <details> so their contents are laid out */
      await page.evaluate(() => { for (const d of document.querySelectorAll("main details")) d.open = true; });
      for (const b of await page.$$('.flow-card .block-toggle')) { const txt = (await b.textContent())?.trim(); if (txt === "▸") await b.click().catch(() => {}); }
      /* Questions: open a question of each kind and expand every properties section */
      const extra = [];
      if (t === "Questions" && !process.argv.includes("--no-properties")) {
        /* three questions of different kinds (single select, numeric, grid …), each with every section open */
        for (const idx of [1, 6, 14]) {
          const toggles = await page.$$('[data-testid="qcard-toggle"]');
          if (!toggles[idx]) continue;
          await toggles[idx].click().catch(() => {});
          await page.waitForTimeout(500);
          for (const head of await page.$$('[data-testid^="psec-head-"]')) { if ((await head.getAttribute("aria-expanded")) === "false") await head.click().catch(() => {}); }
          await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
          await page.waitForTimeout(300);
          extra.push(...(await scan()));
          const panel = await page.$(".rightpanel");
          if (panel) for (let k = 0; k < 8; k++) { const more = await page.evaluate(() => { const r = document.querySelector(".rightpanel"); if (!r || r.scrollTop + r.clientHeight >= r.scrollHeight - 4) return false; r.scrollTop += Math.floor(r.clientHeight * 0.9); return true; }); if (!more) break; await page.waitForTimeout(120); extra.push(...(await scan())); }
        }
      }
      await page.waitForTimeout(300);
      /* --self-test: put the original bug back (a check carrying the tooltip-icon class `tip`) — the audit must find it */
      if (process.argv.includes("--self-test")) await page.evaluate(() => { for (const e of document.querySelectorAll(".loop-check")) e.classList.add("tip"); });
      /* scan what is on screen, then scroll the main area a screen at a time (up to 12 screens): only laid-out,
         visible text can be judged */
      const found = [...extra];
      for (let step = 0; step < 12; step++) {
        const part = await Promise.race([scan(), new Promise((_, rej) => setTimeout(() => rej(new Error("scan took over 60 s")), 60_000))]);
        found.push(...part);
        const more = await page.evaluate(() => {
          const m = document.querySelector("main.center") ?? document.scrollingElement;
          if (!m || m.scrollTop + m.clientHeight >= m.scrollHeight - 4) return false;
          m.scrollTop += Math.floor(m.clientHeight * 0.9); return true;
        });
        if (!more) break;
        await page.waitForTimeout(150);
      }
      await page.evaluate(() => { const m = document.querySelector("main.center"); if (m) m.scrollTop = 0; });
      for (const i of found) all.push({ width: w, tool: t, ...i });
      (await import("node:fs")).appendFileSync("/tmp/ovl-issues.jsonl", found.map((i) => JSON.stringify({ width: w, tool: t, ...i })).join("\n") + (found.length ? "\n" : ""));
      console.log(`  scanned ${t} @${w}: ${found.length}`);
    } catch (e) { all.push({ width: w, tool: t, kind: "error", where: "", text: String(e.message).slice(0, 120) }); }
  }
}
const uniq = new Map();
for (const i of all) { const k = `${i.tool}|${i.kind}|${i.where}`; if (!uniq.has(k)) uniq.set(k, { ...i, widths: [i.width] }); else uniq.get(k).widths.push(i.width); }
for (const i of uniq.values()) console.log(`${i.kind.padEnd(8)} ${i.tool} @${i.widths.join("/")}: ${i.where} — ${i.text}${i.detail ? ` (${i.detail})` : ""}`);
console.log(`\ntext-overlap-audit: ${tools.length} tools × ${WIDTHS.length} widths — ${[...uniq.values()].filter((i) => i.kind !== "error").length} issue(s), ${[...uniq.values()].filter((i) => i.kind === "error").length} tool(s) not opened`);
await browser.close();
