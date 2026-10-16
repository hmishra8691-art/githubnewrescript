import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { sendPreview } from "/home/claude/rescript/scripts/lib/preview.mjs";
const browser = await chromium.launch();
const scale = [1, 2, 3, 4, 5].map((n) => ({ code: n, label: ["Poor", "Fair", "OK", "Good", "Great"][n - 1] }));
const def = { meta: { id: "mob", code: "MOB", title: "Mobile", version: "1.0", schemaVersion: 1, status: "draft" }, logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [], deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  questions: [{ id: "m1", code: "M1", variableName: "M1", type: "matrix_single", text: "M1", options: scale, rows: [{ code: 1, label: "Service quality overall" }, { code: 2, label: "Price" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["m1"] }, { type: "end", id: "e1", status: "complete" }] };
const pv = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
await pv.goto("http://localhost:3001/preview", { waitUntil: "networkidle" });
await sendPreview(pv, { definition: def }, { selector: '[data-qid="m1"]' });
await pv.waitForTimeout(500);
console.log(await pv.evaluate(() => {
  const t = document.querySelector('[data-qid="m1"] table'); let el = t.parentElement; const chain = [];
  while (el && el !== document.body) { const cs = getComputedStyle(el); chain.push({ tag: el.tagName, cls: el.className.toString().slice(0, 40), ox: cs.overflowX, sw: el.scrollWidth, cw: el.clientWidth }); el = el.parentElement; }
  const great = [...t.querySelectorAll("th")].find((th) => /Great/.test(th.textContent)); const r = great?.getBoundingClientRect();
  const inp = t.querySelector('tr:nth-child(1) td:last-child input'); const ir = inp?.getBoundingClientRect();
  return { chain: chain.slice(0, 5), greatHeader: r && { left: Math.round(r.left), right: Math.round(r.right) }, lastInput: ir && { left: Math.round(ir.left), right: Math.round(ir.right) }, winW: innerWidth, elementAtLastInput: ir && document.elementFromPoint(Math.min(ir.left + 5, innerWidth - 1), ir.top + 5)?.tagName };
}));
// can a respondent reach "Great"? try scrolling the wrapper then clicking
const clicked = await pv.evaluate(() => { const t = document.querySelector('[data-qid="m1"] table'); const w = t.parentElement; w.scrollLeft = 500; return w.scrollLeft; });
console.log("wrapper scrollLeft after scrolling attempt:", clicked);
await pv.screenshot({ path: "/tmp/audit/browser/matrix-390-after-scroll.png" });
await browser.close();
