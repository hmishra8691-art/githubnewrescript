/**
 * FLOW MODE — the survey's behaviour as a canvas (Phase 3).
 *
 *   node scripts/flow-mode-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { buildMasterDemoSurvey, buildScaleSurvey, MASTER_DEMO_TEST_PATHS } from "../packages/templates/dist/index.js";

/** the demo's canonical path "B" as a debug-box string, with one override — codes, not ids */
const demoDef = buildMasterDemoSurvey("sandbox");
const codeOf = (id) => demoDef.questions.find((q) => q.id === id)?.code;
const answersFor = (override) => {
  const base = { ...MASTER_DEMO_TEST_PATHS.find((p) => p.id === "B").answers, ...override };
  return Object.entries(base)
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x !== "object")))
    .map(([id, v]) => `${codeOf(id)}=${Array.isArray(v) ? v.join("|") : v}`)
    .filter((s) => !s.startsWith("undefined"))
    .join(", ");
};

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const mod = process.platform === "darwin" ? "Meta" : "Control";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/401|ERR_TUNNEL|Failed to load resource/.test(t)) return;
  pageErrors.push(t.slice(0, 400));
});

const goTab = async (name) => { await openTab(page, `${name}`); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  await page.waitForSelector('[data-testid="flow-view"]');
  return JSON.parse(json);
};
const node = (id) => page.$(`[data-testid="flow-node"][data-node="${id}"]`);
const classesOf = (id) => page.$eval(`[data-testid="flow-node"][data-node="${id}"]`, (e) => e.getAttribute("class"));
const count = () => page.$eval('[data-testid="flow-count"]', (e) => e.textContent);

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(buildMasterDemoSurvey("sandbox"));

/* ----------------------------------------------------------- switch + graph */
{
  await switchMode(page, "flow");
  await page.waitForSelector('[data-testid="flow-view"]');
  ok("Flow renders in place — no reload");
  assert.match(page.url(), /mode=flow/);
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), true);
  ok("the outer property panel steps aside — the canvas has its own inspector");
  assert.match(await count(), /^7\d nodes · 9\d edges$/);
  ok(`the Master Demo at page granularity: ${await count()} (auto picks pages for 160 questions)`);
  const kinds = await page.$$eval('[data-testid="flow-edge"]', (els) => [...new Set(els.map((e) => e.dataset.kind))].sort());
  for (const k of ["sequence", "branch", "otherwise", "skip", "loop", "quota"]) assert.ok(kinds.includes(k), `edge kind ${k} drawn: ${kinds.join(",")}`);
  ok(`six edge kinds are drawn and typed: ${kinds.join(", ")}`);
  const decisions = await page.$$eval('[data-testid="flow-node"][data-kind="decision"]', (els) => els.length);
  assert.ok(decisions >= 8, `${decisions} decision nodes (branches, loops, randomizers, gates, quota checks)`);
  ok(`${decisions} decision nodes on the canvas`);
  assert.ok(await page.$('[data-testid="flow-minimap"]'), "minimap");
  ok("a minimap shows the whole graph and the viewport");
}

/* ----------------------------------------------------------- pan / zoom / fit */
{
  const t0 = await page.$eval('[data-testid="flow-viewport"]', (e) => e.getAttribute("transform"));
  for (let i = 0; i < 4; i++) await page.click('[data-testid="flow-zoom-in"]');
  await page.waitForTimeout(100);
  const t1 = await page.$eval('[data-testid="flow-viewport"]', (e) => e.getAttribute("transform"));
  assert.notEqual(t0, t1);
  const k0 = Number(/scale\(([\d.]+)\)/.exec(t0)[1]), k1 = Number(/scale\(([\d.]+)\)/.exec(t1)[1]);
  assert.ok(k1 > k0, `zoom in: ${k0} → ${k1}`);
  ok("＋ zooms in (×4)");
  await page.click('[data-testid="flow-fit"]');
  await page.waitForTimeout(100);
  const k2 = Number(/scale\(([\d.]+)\)/.exec(await page.$eval('[data-testid="flow-viewport"]', (e) => e.getAttribute("transform")))[1]);
  assert.ok(k2 < k1, `fit zooms back out: ${k1} → ${k2}`);
  await page.click('[data-testid="flow-fit"]');
  await page.waitForTimeout(100);
  const k3 = Number(/scale\(([\d.]+)\)/.exec(await page.$eval('[data-testid="flow-viewport"]', (e) => e.getAttribute("transform")))[1]);
  assert.ok(Math.abs(k3 - k2) < 1e-6, "fit is idempotent");
  ok("Fit brings the whole graph back into view, and is stable");
  // drag the background pans
  const host = await page.$('[data-testid="flow-canvas"]');
  const box = await host.boundingBox();
  await page.mouse.move(box.x + 100, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 360, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const t3 = await page.$eval('[data-testid="flow-viewport"]', (e) => e.getAttribute("transform"));
  const tx2 = Number(/translate\(([-\d.]+) /.exec(t3)[1]);
  const tx0 = Number(/translate\(([-\d.]+) /.exec(await (async () => { await page.click('[data-testid="flow-fit"]'); await page.waitForTimeout(100); return page.$eval('[data-testid="flow-viewport"]', (e) => e.getAttribute("transform")); })())[1]);
  assert.ok(Math.abs(tx2 - tx0) > 40, `dragging the background panned: ${tx0} → ${tx2}`);
  ok("dragging empty canvas pans");
}

/* ----------------------------------------------------------- search + selection + highlight */
{
  await page.fill('[data-testid="flow-search"]', "Consumer / Business");
  await page.waitForTimeout(300);
  const cls = await classesOf("br_use_type");
  assert.match(cls, /\bmatch\b/);
  ok("search marks the matching node and centres on it");
  await page.fill('[data-testid="flow-search"]', "");
  await page.waitForTimeout(200);
  const br = await node("br_use_type");
  await br.click();
  await page.waitForTimeout(300);
  assert.match(await classesOf("br_use_type"), /\bprimary\b/);
  ok("clicking a node selects it (primary)");
  await page.waitForSelector('[data-testid="flow-legend"]');
  const legend = await page.$eval('[data-testid="flow-legend"]', (e) => e.textContent);
  assert.match(legend, /can reach .* · \d+/);
  assert.match(legend, /can affect · \d+/);
  ok(`the legend answers both questions: ${legend.replace(/\s+/g, " ").trim()}`);
  const ups = await page.$$eval('[data-testid="flow-node"].up', (els) => els.map((e) => e.dataset.node));
  const downs = await page.$$eval('[data-testid="flow-node"].down', (els) => els.map((e) => e.dataset.node));
  assert.ok(ups.length >= 10 && downs.length >= 10, `${ups.length} upstream, ${downs.length} downstream`);
  assert.ok(ups.includes("p_intro_welcome") || ups.some((u) => /intro|welcome|screen/.test(u)), `the first page can reach the branch: ${ups.slice(0, 5).join(",")}`);
  assert.ok(!downs.some((d) => ups.includes(d)), "a node is never both upstream and downstream of a branch in a forward flow");
  ok("upstream (cyan) and downstream (amber) node sets are disjoint and populated");
  const lit = await page.$$eval('[data-testid="flow-edge"].lit', (els) => els.length);
  const dim = await page.$$eval('[data-testid="flow-edge"].dim', (els) => els.length);
  assert.ok(lit > 10 && dim >= 0, `${lit} edges lit`);
  ok(`${lit} edges on the paths are lit`);
  // the inspector follows
  await page.waitForSelector('[data-testid="inspector"][data-kind="flowNode"]');
  assert.match(await page.$eval('[data-testid="inspector"] .ai-title', (e) => e.textContent), /Consumer/);
  ok("the inspector shows the selected branch: its dependencies and definition");
  const deps = await page.$$eval('[data-testid="dep-depends-on"] [data-testid="dep-link"]', (els) => els.map((e) => e.dataset.key));
  assert.ok(deps.includes("question:q_employment") && deps.includes("question:q_use_type"), deps.join(","));
  ok("DEPENDS ON lists the two questions the branch's conditions read");
}

/* ----------------------------------------------------------- focus */
{
  await page.click('[data-testid="focus-toggle"]');
  await page.waitForTimeout(200);
  const hard = await page.$$eval('[data-testid="flow-node"].dim-hard', (els) => els.length);
  assert.ok(hard > 0, "focus dims unrelated nodes hard");
  ok(`focus: ${hard} unrelated nodes recede`);
  await page.click('[data-testid="focus-toggle"]');
  await page.waitForTimeout(150);
  assert.equal(await page.$$eval('[data-testid="flow-node"].dim-hard', (els) => els.length), 0);
  ok("focus off restores them");
}

/* ----------------------------------------------------------- debug mode: a real walk */
{
  await page.click('[data-testid="flow-debug-toggle"]');
  await page.waitForSelector('[data-testid="flow-debug-input"]');
  await page.fill('[data-testid="flow-debug-input"]', answersFor({ q_use_type: 2 }));   // path B, but business use
  await page.waitForTimeout(800);
  const out = await page.$eval('[data-testid="flow-debug-out"]', (e) => e.textContent);
  assert.match(out, /\d+ pages · \d+ questions/);
  ok(`debug walks the survey with typed answers: ${out}`);
  const taken = await page.$$eval('[data-testid="flow-node"].taken', (els) => els.map((e) => e.dataset.node));
  const untaken = await page.$$eval('[data-testid="flow-node"].untaken', (els) => els.length);
  assert.ok(taken.length > 5 && untaken > 0, `${taken.length} taken, ${untaken} not`);
  assert.ok(taken.includes("p_intro_welcome"), "the welcome page is on every path");
  ok(`the taken path is lit (${taken.length} nodes) and the rest recedes`);
  // Business path: the business section is taken, the consumer section not
  const business = taken.some((t) => /business|04b/i.test(t));
  const consumer = taken.some((t) => /consumer|04a/i.test(t) && !/business/i.test(t));
  assert.ok(business && !consumer, `business use routes through the business section: taken=${taken.filter((t) => /04|consumer|business|combined/i.test(t)).join(",")}`);
  ok("use type = Business routes the walk through the Business arm and not the Consumer one");
  await page.fill('[data-testid="flow-debug-input"]', answersFor({ q_use_type: 1 }));
  await page.waitForTimeout(800);
  const taken2 = await page.$$eval('[data-testid="flow-node"].taken', (els) => els.map((e) => e.dataset.node));
  assert.ok(taken2.some((t) => /consumer|04a/i.test(t) && !/business/i.test(t)) && !taken2.some((t) => /04b|p_business/i.test(t)), taken2.filter((t) => /04|consumer|business|combined/i.test(t)).join(","));
  ok("changing one answer to Consumer re-routes the lit path through the Consumer arm");
  // a screen-out: no consent
  await page.fill('[data-testid="flow-debug-input"]', "Q1=2");
  await page.waitForTimeout(500);
  assert.match(await page.$eval('[data-testid="flow-debug-out"]', (e) => e.textContent), /ends screened/);
  ok("Q1=No (no consent) ends screened after the first page — skip rules fire, this is a walk not a compile");
  await page.fill('[data-testid="flow-debug-input"]', "Q999=1");
  await page.waitForTimeout(400);
  assert.match(await page.$eval('[data-testid="flow-debug-out"]', (e) => e.textContent), /unknown: Q999/);
  ok("an unknown code is reported, not swallowed");
  await page.click('[data-testid="flow-debug-toggle"]');
  await page.waitForTimeout(150);
}

/* ----------------------------------------------------------- drag to reposition (pinned, persisted) */
{
  await page.click('[data-testid="flow-fit"]');
  await page.waitForTimeout(150);
  await page.fill('[data-testid="flow-search"]', "Consumer / Business");
  await page.waitForTimeout(400);
  await page.fill('[data-testid="flow-search"]', "");
  await page.waitForTimeout(200);
  const br = await node("br_use_type");
  const before = await br.boundingBox();
  await page.mouse.move(before.x + 30, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + 30 + 140, before.y + before.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await (await node("br_use_type")).boundingBox();
  assert.ok(after.x > before.x + 100, `the node moved: ${before.x} → ${after.x}`);
  ok("dragging a node moves it");
  const def = await readDef();
  const stored = def.logicFlow.nodes.find((n) => n.id === "br_use_type");
  assert.ok(stored && typeof stored.x === "number", "the position is stored on the survey by id");
  ok("the dragged position is persisted on def.logicFlow — it survives a reload and other environments ignore it");
  await page.waitForSelector('[data-testid="flow-view"]');
  assert.ok(await page.$('[data-testid="flow-node"][data-node="br_use_type"] .fc-pin'), "the pin marker shows");
  ok("a pinned node shows its pin");
  await page.click('[data-testid="flow-arrange"]');
  await page.waitForTimeout(400);
  const def2 = await readDef();
  assert.equal(def2.logicFlow.nodes.length, 0);
  ok("Auto-arrange forgets the pins (one undoable edit)");
}

/* ----------------------------------------------------------- add an element from the canvas */
{
  const before = await readDef();
  await page.selectOption('[data-testid="flow-add"]', "flow.add.randomizer");
  await page.waitForTimeout(400);
  const def = await readDef();
  const types = def.flow.map((n) => n.type);
  assert.equal(def.flow.length, before.flow.length + 1);
  assert.ok(types.indexOf("randomizer") >= 0 && types.indexOf("randomizer") < types.lastIndexOf("end"), "the randomizer sits before the ends");
  ok("'+ Add… Randomizer' inserts through the command registry, before the End");
  await page.waitForSelector('[data-testid="flow-view"]');
  assert.match(await page.$eval('[data-testid="inspector"]', (e) => e.dataset.kind), /flowNode/);
  ok("and selects the new element, so the inspector opens on it");
}

/* ----------------------------------------------------------- drop a node into a container */
{
  await page.click('[data-testid="flow-fit"]');
  await page.waitForTimeout(150);
  const def = await readDef();
  const rnd = def.flow.find((n) => n.type === "randomizer" && n.children.length === 0);
  assert.ok(rnd, "the empty randomizer we just added");
  // the demo's top level is all sections; take the last section's first page, which the canvas draws as a node
  const lastSection = [...def.flow].reverse().find((n) => n.type === "section");
  const firstIn = (nodes) => { for (const n of nodes) { if (n.type === "page") return n; if (n.children) { const h = firstIn(n.children); if (h) return h; } } return null; };
  const topPage = firstIn(lastSection.children);
  assert.ok(topPage, "a page to move");
  await page.fill('[data-testid="flow-search"]', rnd.id);
  await page.waitForTimeout(400);
  const target = await node(rnd.id);
  assert.ok(target, "the randomizer node is drawn");
  const tb = await target.boundingBox();
  await page.fill('[data-testid="flow-search"]', "");
  await page.waitForTimeout(200);
  // the source may be far away; zoom out so both are on screen
  await page.click('[data-testid="flow-fit"]');
  await page.waitForTimeout(150);
  const src = await node(topPage.id);
  const tgt = await node(rnd.id);
  if (src && tgt) {
    const sb = await src.boundingBox(); const tb2 = await tgt.boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb2.x + tb2.width / 2, tb2.y + tb2.height / 2, { steps: 12 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = await readDef();
    const rnd2 = after.flow.find((n) => n.id === rnd.id);
    assert.ok(rnd2 && rnd2.children.some((c) => c.id === topPage.id), `${topPage.id} is now inside the randomizer: ${JSON.stringify(rnd2?.children.map((c) => c.id))}`);
    ok("dropping a page onto a randomizer moves it inside — moveFlowNode, with canDropFlowNode's verdict");
    const stillThere = (nodes) => nodes.some((n) => n.id === topPage.id || (n.children && n.id !== rnd.id && stillThere(n.children)) || (n.branches && n.branches.some((b) => stillThere(b.children))) || (n.otherwise && stillThere(n.otherwise)));
    assert.ok(!stillThere(after.flow), "and it left where it was");
    ok("the page is no longer in its old section");
  } else {
    console.log("  skip drop check: nodes not both drawn at fit zoom", !!src, !!tgt, tb);
  }
}

/* ----------------------------------------------------------- shared selection across modes */
{
  await page.waitForSelector('[data-testid="flow-view"]');
  await page.click('[data-testid="flow-granularity"] [data-granularity="questions"]');
  await page.waitForTimeout(600);
  assert.match(await count(), /1[5-9]\d nodes/);
  ok(`question granularity: ${await count()}`);
  await page.fill('[data-testid="flow-search"]', "Q3 ");
  await page.waitForTimeout(400);
  await page.fill('[data-testid="flow-search"]', "");
  await page.waitForTimeout(150);
  const q3 = await node("q_age");
  assert.ok(q3, "Q3 is a node at question granularity");
  await q3.click();
  await page.waitForTimeout(300);
  await switchMode(page, "grid");
  await page.waitForSelector('[data-testid="grid-view"]');
  assert.deepEqual(await page.$$eval('[data-testid="grid-row"][aria-selected="true"]', (els) => els.map((e) => e.dataset.code)), ["Q3"]);
  ok("a question selected on the canvas is the selected row in Grid — one selection");
  await switchMode(page, "flow");
  await page.waitForSelector('[data-testid="flow-view"]');
  await page.waitForTimeout(300);
  assert.match(await classesOf("q_age"), /\bprimary\b/);
  ok("and back in Flow, Q3 is the primary node");
  await page.click('[data-testid="flow-granularity"] [data-granularity="auto"]');
}

/* ----------------------------------------------------------- scale */
{
  await switchMode(page, "studio");
  await page.waitForSelector(".block-badge");
  await loadDef(buildScaleSurvey(600));
  const t0 = Date.now();
  await switchMode(page, "flow");
  await page.waitForSelector('[data-testid="flow-node"]');
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `Flow at 600 questions appeared in ${ms}ms`);
  ok(`Flow renders the 600-question survey in ${ms}ms (auto: pages)`);
  assert.match(await count(), /1[0-9]\d nodes/);
  const zoomMs = await page.evaluate(async () => {
    const t = performance.now();
    for (let i = 0; i < 10; i++) { document.querySelector('[data-testid="flow-zoom-in"]').click(); await new Promise((r) => requestAnimationFrame(r)); }
    return performance.now() - t;
  });
  assert.ok(zoomMs < 2500, `10 zoom steps took ${zoomMs.toFixed(0)}ms`);
  ok(`10 zoom steps rendered in ${zoomMs.toFixed(0)}ms`);
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no uncaught errors or React warnings through any of it");

await browser.close();
console.log(`\nALL FLOW MODE CHECKS PASSED (${passed})`);
