/**
 * ARCHITECT MODE — survey map · workspace · inspector (Phase 2).
 *
 *   node scripts/architect-mode-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";

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
  await page.waitForSelector('[data-testid="architect-view"]');
  return JSON.parse(json);
};
const mapRow = (key) => page.$(`[data-testid="map-row"][data-key="${key}"]`);
const rowKeys = () => page.$$eval('[data-testid="map-row"]', (els) => els.map((e) => e.dataset.key));

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(buildMasterDemoSurvey("sandbox"));

/* ----------------------------------------------------------- switch + panes */
{
  await switchMode(page, "architect");
  await page.waitForSelector('[data-testid="architect-view"]');
  ok("Architect renders in place — no reload");
  assert.match(page.url(), /mode=architect/);
  for (const t of ["survey-map", "workspace-overview", "inspector-empty"]) assert.ok(await page.$(`[data-testid="${t}"]`), t);
  ok("three panes: map, workspace (overview), inspector (empty state)");
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), true);
  ok("the outer property panel steps aside — the inspector lives inside Architect");
  const stats = await page.$$eval(".aw-stat-n", (els) => els.map((e) => Number(e.textContent)));
  assert.equal(stats[0], 160);
  ok("the overview counts 160 questions");
}

/* ----------------------------------------------------------- the map */
{
  const keys = await rowKeys();
  assert.ok(keys.length > 100, `${keys.length} rows`);
  assert.ok(keys.some((k) => k.startsWith("flowNode:")) && keys.some((k) => k.startsWith("question:")), "containers and questions");
  assert.ok(keys.includes("section:rules") && keys.includes("section:calculations") && keys.includes("section:quotas"));
  ok("the map lists flow containers, questions, and the rules / calculations / quotas sections");
  const branch = await mapRow("flowNode:br_use_type");
  assert.ok(branch, "the Consumer/Business/Both branch is a row");
  const branchKind = await branch.getAttribute("data-kind");
  assert.equal(branchKind, "branch");
  const arms = await page.$$('[data-testid="map-row"][data-kind="arm"]');
  assert.equal(arms.length, 2, `${arms.length} arms — the demo branch has Consumer and Business`);
  assert.ok(await page.$('[data-testid="map-row"][data-kind="otherwise"]'), "and an Otherwise");
  const armDetail = await page.$eval('[data-testid="map-row"][data-kind="arm"] .am-detail', (e) => e.textContent);
  assert.match(armDetail, /^IF /);
  ok("a branch shows its arms and its otherwise as children, each arm with its IF");
  // collapse the branch: its arms disappear
  await (await branch.$('[data-testid="map-disclosure"]')).click();
  await page.waitForTimeout(150);
  const after = (await page.$$('[data-testid="map-row"][data-kind="arm"]')).length;
  assert.ok(after < arms.length, "arms hidden after collapsing the branch");
  ok("the disclosure collapses a container");
  await (await (await mapRow("flowNode:br_use_type")).$('[data-testid="map-disclosure"]')).click();
  await page.waitForTimeout(150);
  await page.click('[data-testid="map-collapse-all"]');
  await page.waitForTimeout(150);
  const collapsedKeys = await rowKeys();
  assert.ok(!collapsedKeys.some((k) => k.startsWith("question:")), "no questions visible when everything is collapsed");
  ok("collapse all hides every question");
  await page.click('[data-testid="map-expand-all"]');
  await page.waitForTimeout(150);
  assert.ok((await rowKeys()).some((k) => k.startsWith("question:")));
  ok("expand all brings them back");
  await page.fill('[data-testid="map-search"]', "employment");
  await page.waitForTimeout(200);
  const found = await rowKeys();
  assert.ok(found.includes("question:q_employment"), found.join(","));
  assert.ok(found.length < 40, `search narrows to ${found.length} rows including the path to each match`);
  ok("map search keeps matches and the path to them");
  await page.fill('[data-testid="map-search"]', "");
  await page.waitForTimeout(200);
}

/* ----------------------------------------------------------- selection → workspace + inspector */
{
  await (await mapRow("question:q_employment")).click();
  await page.waitForSelector('[data-testid="workspace-question"]');
  assert.equal(await page.$eval('[data-testid="workspace-question"] input[value="Q10"]', (e) => e.value), "Q10");
  ok("selecting a question opens the Studio's own question editor in the workspace");
  await page.waitForSelector('[data-testid="inspector"][data-kind="question"]');
  const usedBy = await page.$$eval('[data-testid="dep-used-by"] [data-testid="dep-link"]', (els) => els.map((e) => e.dataset.key));
  assert.ok(usedBy.length >= 5, `Q10 (EMPLOYMENT) is read by a rule, a branch, a skip and several questions: ${usedBy.join(",")}`);
  assert.ok(usedBy.includes("displayRule:dr_show_work_page"), "the named rule that reads it is listed");
  assert.ok(usedBy.includes("flowNode:br_use_type") || usedBy.some((k) => k.startsWith("flowNode:")), "the branch that reads it is listed");
  ok(`the inspector's USED BY lists ${usedBy.length} readers, across object kinds — from the dependency index`);
  assert.ok(await page.$(".ai-props"), "the property panel sections follow");
  ok("the question's property panel (all its sections) sits below the dependencies");
  // follow a dependency link: the display rule
  await page.click('[data-testid="dep-link"][data-key="displayRule:dr_show_work_page"]');
  await page.waitForSelector('[data-testid="workspace-rule"]');
  assert.equal(await page.$eval('[data-testid="inspector"]', (e) => e.dataset.kind), "displayRule");
  ok("clicking a dependency selects that object: the rule opens in the workspace, the inspector describes it");
  assert.ok(await page.$('[data-testid="inspector-summary"]'), "the rule's definition is summarised");
  const dependsOn = await page.$$eval('[data-testid="dep-depends-on"] [data-testid="dep-link"]', (els) => els.map((e) => e.dataset.key));
  assert.ok(dependsOn.includes("question:q_employment"), `the rule depends on Q10: ${dependsOn.join(",")}`);
  ok("and the rule's DEPENDS ON points back at Q10 — the same edge, both directions");
  // the map expanded the path to the rule and marks it primary
  assert.equal(await page.$eval('[data-testid="map-row"][data-key="displayRule:dr_show_work_page"]', (e) => e.classList.contains("primary")), true);
  ok("the map follows: the rule's row is the primary");
}

/* ----------------------------------------------------------- editing non-question objects */
{
  // rule label, through the shared DisplayRuleCard
  const labelInput = await page.$('[data-testid="workspace-rule"] input[placeholder="rule label"]');
  await labelInput.fill("Work page — employed only");
  await page.waitForTimeout(250);
  let def = await readDef();
  assert.equal(def.displayRules.find((r) => r.id === "dr_show_work_page").label, "Work page — employed only");
  ok("editing a rule in the workspace writes to the definition (the Logic panel's own card)");
  // calculation
  await (await mapRow("calculation:calc_n_used")).click();
  await page.waitForSelector('[data-testid="workspace-calculation"]');
  const expr = await page.$('[data-testid="workspace-calculation"] input.mono.grow');
  await expr.fill("count(BRANDS_USED) + 0");
  await page.waitForTimeout(250);
  def = await readDef();
  assert.equal(def.calculations.find((c) => c.id === "calc_n_used").expression, "count(BRANDS_USED) + 0");
  ok("editing a calculation's expression in the workspace writes to the definition");
  // a branch: NodeEditor
  await (await mapRow("flowNode:br_use_type")).click();
  await page.waitForSelector('[data-testid="workspace-flow"]');
  assert.equal(await page.$eval('[data-testid="inspector"]', (e) => e.dataset.kind), "flowNode");
  const title = await page.$('[data-testid="workspace-node-title"]');
  await title.fill("Consumer / Business / Both (renamed)");
  await page.waitForTimeout(250);
  def = await readDef();
  const findNode = (nodes) => { for (const n of nodes) { if (n.id === "br_use_type") return n; for (const kids of [n.children, n.otherwise, ...(n.branches ?? []).map((b) => b.children)]) { if (kids) { const hit = findNode(kids); if (hit) return hit; } } } return null; };
  assert.equal(findNode(def.flow).title, "Consumer / Business / Both (renamed)");
  ok("renaming a branch in the workspace lands on the right node in the flow (replaceFlowNode)");
  const dl = await page.$$eval('[data-testid="inspector-summary"] dt', (els) => els.map((e) => e.textContent));
  assert.ok(dl.some((t) => /Consumer|Business|Path/.test(t)), `the inspector lists the branch's paths: ${dl.join(" | ")}`);
  ok("the inspector summarises each path of the branch with its condition");
}

/* ----------------------------------------------------------- editing a question in the workspace */
{
  await (await mapRow("question:q_city")).click();
  await page.waitForSelector('[data-testid="workspace-question"]');
  // the question editor's rich text field — type into the visible editor
  const editor = await page.$('[data-testid="workspace-question"] [contenteditable="true"]');
  assert.ok(editor, "the rich text editor is there");
  await editor.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type("Which city do you call home?");
  await page.waitForTimeout(400);
  const def = await readDef();
  assert.match(def.questions.find((q) => q.id === "q_city").text, /Which city do you call home\?/);
  ok("typing in the workspace's question editor edits the survey — it is the Studio's editor");
}

/* ----------------------------------------------------------- focus mode */
{
  await (await mapRow("question:q_employment")).click();
  await page.waitForTimeout(200);
  const total = (await page.$$('[data-testid="map-row"]')).length;
  assert.equal((await page.$$(".am-row.dim")).length, 0, "nothing dimmed before focus");
  await page.click('[data-testid="focus-toggle"]');
  await page.waitForSelector('[data-testid="focus-bar"]');
  assert.match(await page.$eval('[data-testid="focus-bar"]', (e) => e.textContent), /FOCUSING ON\s*Q10/);
  ok("Focus shows 'FOCUSING ON Q10'");
  const dim = (await page.$$(".am-row.dim")).length;
  assert.ok(dim > total / 2 && dim < total, `${dim} of ${total} rows dimmed`);
  ok(`focus dims what is outside Q10's dependency neighbourhood (${dim} of ${total} rows)`);
  assert.equal(await page.$eval('[data-testid="map-row"][data-key="question:q_employment"]', (e) => e.classList.contains("dim")), false);
  assert.equal(await page.$eval('[data-testid="map-row"][data-key="displayRule:dr_show_work_page"]', (e) => e.classList.contains("dim")), false);
  ok("the selection and the rule that reads it stay bright");
  await page.click("main.center .ar-work-body", { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press(`${mod}+Shift+f`);
  await page.waitForSelector('[data-testid="focus-bar"]', { state: "detached" });
  assert.equal((await page.$$(".am-row.dim")).length, 0);
  ok(`${mod}+Shift+F toggles focus off — the command registry`);
}

/* ----------------------------------------------------------- keyboard in the map */
{
  await (await mapRow("question:q_age")).click();
  await page.focus('[data-testid="map-list"]');
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  assert.equal(await page.$eval('[data-testid="inspector"] .ai-title', (e) => e.textContent), "Q4");
  ok("↓ in the map moves the selection to the next row (Q3 → Q4), and the inspector follows");
  // ← on a question goes to its parent block; ← again collapses it
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(100);
  const primaryKey = await page.$eval(".am-row.primary", (e) => e.dataset.key);
  assert.ok(primaryKey.startsWith("flowNode:"), `← from a question selects its block: ${primaryKey}`);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(100);
  assert.equal(await page.$eval(`[data-testid="map-row"][data-key="${primaryKey}"]`, (e) => e.getAttribute("aria-expanded")), "false");
  ok("← on a block collapses it; → would expand it again");
}

/* ----------------------------------------------------------- resizing */
{
  const before = await page.$eval(".ar-map", (e) => e.getBoundingClientRect().width);
  const divider = await page.$('[data-testid="ar-divider-map"]');
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + 3, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await page.$eval(".ar-map", (e) => e.getBoundingClientRect().width);
  assert.ok(after > before + 80, `map grew ${before} → ${after}`);
  ok("dragging the divider resizes the map pane");
}

/* ----------------------------------------------------------- the selection is shared across modes */
{
  await page.click('[data-testid="map-expand-all"]');   // the keyboard check collapsed Q5's block
  await page.waitForTimeout(150);
  await (await mapRow("question:q_region")).click();
  await page.waitForTimeout(150);
  await switchMode(page, "grid");
  await page.waitForSelector('[data-testid="grid-view"]');
  const sel = await page.$$eval('[data-testid="grid-row"][aria-selected="true"]', (els) => els.map((e) => e.dataset.code));
  assert.deepEqual(sel, ["Q5"]);
  ok("switching to Grid, Q5 is the selected row — one selection across environments");
  await switchMode(page, "architect");
  await page.waitForSelector('[data-testid="architect-view"]');
  assert.equal(await page.$eval(".am-row.primary", (e) => e.dataset.key), "question:q_region");
  ok("and back in Architect it is the primary in the map");
  await switchMode(page, "studio");
  await page.waitForSelector(".block-badge");
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), false);
  assert.match(await page.$eval(".rightpanel h2", (e) => e.textContent), /Q5/);
  ok("and in Studio the property panel shows Q5 — the outer panel returns when Architect leaves");
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no uncaught errors or React warnings through any of it");

await browser.close();
console.log(`\nALL ARCHITECT MODE CHECKS PASSED (${passed})`);
