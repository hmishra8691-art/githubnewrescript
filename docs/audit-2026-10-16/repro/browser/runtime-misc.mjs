import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { sendPreview } from "/home/claude/rescript/scripts/lib/preview.mjs";
const RUNTIME = "http://localhost:3001";
const browser = await chromium.launch();
const base = { logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [], deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } } };
const q = (id, code, type, extra = {}) => ({ id, code, variableName: code, type, text: `${code} text`, ...extra });
// RUNTIME-08: a UX script hides Next
{
  const def = { ...base, meta: { id: "r8", code: "R8", title: "R8", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [q("q1", "Q1", "single_select", { options: [{ code: 1, label: "A" }] }), q("q2", "Q2", "open_text")],
    ux: { styles: [], animations: [], behaviors: [{ id: "b", label: "hide next", target: { kind: "survey" }, effects: [], script: `document.querySelector('[data-testid="rs-next"]').hidden = true; document.querySelector('[data-testid="rs-next"]').setAttribute("disabled","");` }] },
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e1", status: "complete" }] };
  const pv = await browser.newPage();
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(pv, { definition: def }, { selector: '[data-qid="q1"]' });
  await pv.waitForTimeout(1200);
  const st = await pv.$eval('[data-testid="rs-next"]', (e) => ({ hidden: e.hidden, disabled: e.disabled, visible: !!(e.offsetWidth || e.offsetHeight) }));
  console.log("RUNTIME-08 next button after script:", JSON.stringify(st));
  await pv.click('[data-qid="q1"] label');
  await pv.keyboard.press("Enter").catch(() => {});
  await pv.waitForTimeout(500);
  console.log("  still on page 1:", !!(await pv.$('[data-qid="q1"]')));
  await pv.close();
}
// RUNTIME-10: mobile 390 px with matrix, slider matrix, choice grid, sum
{
  const scale = [1, 2, 3, 4, 5].map((n) => ({ code: n, label: ["Poor", "Fair", "OK", "Good", "Great"][n - 1] }));
  const def = { ...base, meta: { id: "mob", code: "MOB", title: "Mobile", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      q("m1", "M1", "matrix_single", { options: scale, rows: [{ code: 1, label: "Service quality overall" }, { code: 2, label: "Price" }, { code: 3, label: "Store cleanliness and layout" }] }),
      q("m2", "M2", "multi_select", { options: Array.from({ length: 8 }, (_, i) => ({ code: i + 1, label: `Brand option number ${i + 1}` })) }),
      q("m3", "M3", "constant_sum", { options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }], settings: { total: 100 } }),
      q("m4", "M4", "slider", { settings: { minValue: 0, maxValue: 100 } }),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["m1", "m2", "m3", "m4"] }, { type: "end", id: "e1", status: "complete" }] };
  for (const w of [360, 390, 768]) {
    const pv = await browser.newPage({ viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true });
    const errs = []; pv.on("pageerror", (e) => errs.push(String(e)));
    await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
    await sendPreview(pv, { definition: def }, { selector: '[data-qid="m1"]' });
    await pv.waitForTimeout(600);
    const m = await pv.evaluate(() => {
      const out = {};
      out.docW = document.documentElement.scrollWidth; out.winW = window.innerWidth; out.overflow = out.docW > out.winW;
      for (const el of document.querySelectorAll("[data-qid]")) { const r = el.getBoundingClientRect(); out[el.getAttribute("data-qid")] = { w: Math.round(r.width), right: Math.round(r.right), sw: el.scrollWidth, cw: el.clientWidth, hscroll: el.scrollWidth > el.clientWidth + 1 }; }
      const t = document.querySelector('[data-qid="m1"] table'); if (t) out.m1table = { w: Math.round(t.getBoundingClientRect().width), cells: t.querySelectorAll("td,th").length };
      return out;
    });
    await pv.screenshot({ path: `/tmp/audit/browser/mobile-${w}.png`, fullPage: true });
    console.log(`RUNTIME-10 @${w}px:`, JSON.stringify(m), "errors:", errs.length);
    await pv.close();
  }
}
await browser.close();
