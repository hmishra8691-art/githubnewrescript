/**
 * MULTI-MODAL FOUNDATION — the shared shell layer (Phase 0).
 *
 * The mode selector, the ⌘K palette, the keyboard shortcuts, the selection
 * bridge, and the question operations that moved into the engine. Nothing
 * here needs a database: the sandbox drives the Studio in memory.
 *
 *   node scripts/multimodal-foundation-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  // the sandbox has no session (401s) and the font host is blocked here
  if (/401|ERR_TUNNEL|Failed to load resource/.test(t)) return;
  pageErrors.push(t);
});

const mod = process.platform === "darwin" ? "Meta" : "Control";

const readDef = async () => {
  const before = await page.$eval(".leftnav .nav-item.active", (e) => e.textContent.trim());
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await page.click(`.leftnav >> text=${before.replace(/\d+$/, "").trim()}`);
  return JSON.parse(json);
};
const questionCount = async () => (await readDef()).questions.length;
const activeTab = () => page.$eval(".leftnav .nav-item.active", (e) => e.textContent.replace(/\d+$/, "").trim());
const paletteOpen = () => page.isVisible('[data-testid="command-palette"]');
/* a card header TOGGLES: clicking the open question collapses it. Select for sure. */
const selectCard = async (n) => {
  for (let i = 0; i < 2; i++) {
    await page.click(`.qlist-item >> nth=${n}`);
    await page.waitForTimeout(150);
    if (!(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")))) return;
  }
  throw new Error(`could not select card ${n}`);
};

// a previous suite may have left another mode remembered in this browser profile; this suite is about the Studio shell
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ----------------------------------------------------------- selector */
{
  const modes = await page.$$eval('[data-testid="mode-selector"] .mode-option', (els) =>
    els.map((e) => ({ id: e.dataset.mode, active: e.classList.contains("active"), available: e.dataset.available, disabled: e.disabled })));
  assert.deepEqual(modes.map((m) => m.id), ["studio", "grid", "architect", "flow", "intelligent"]);
  ok("the mode selector shows all five environments in order");
  assert.ok(modes[0].active && modes[0].available === "1" && !modes[0].disabled, JSON.stringify(modes[0]));
  ok("Studio is the active, available mode");
  const built = modes.filter((m) => m.available === "1").map((m) => m.id);
  assert.deepEqual(built, ["studio", "grid", "architect", "flow", "intelligent"], "every mode has a renderer");
  for (const m of modes) assert.ok(!m.disabled, JSON.stringify(m));
  ok("all five modes are enabled");
  const title = await page.getAttribute('[data-testid="mode-intelligent"]', "title");
  assert.match(title, /Describe what you want/);
  ok("a mode's tagline is its tooltip");
}

/* ----------------------------------------------------------- palette */
{
  assert.equal(await paletteOpen(), false);
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="command-palette"]');
  ok(`${mod}+K opens the palette`);
  await page.waitForFunction(() => document.activeElement?.dataset.testid === "palette-input", null, { timeout: 2000 });
  ok("the search field has focus on open");
  const groups = await page.$$eval(".palette-group", (els) => els.map((e) => e.textContent));
  assert.ok(groups.includes("Add") && groups.includes("Navigate"), groups.join(", "));
  ok("an empty query lists commands grouped");
  assert.equal(await page.$('[data-testid="palette-item-palette.open"]'), null);
  ok("the palette does not list the command that opens it");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="command-palette"]', { state: "detached" });
  ok("Escape closes it");
  await page.click('[data-testid="palette-open"]');
  await page.waitForSelector('[data-testid="command-palette"]');
  ok("the top-bar button opens it too");
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="command-palette"]', { state: "detached" });
  ok(`${mod}+K again toggles it closed`);
}

/* ----------------------------------------------------------- add question via palette */
{
  const before = await questionCount();
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="palette-input"]');
  await page.type('[data-testid="palette-input"]', "add quest");
  await page.waitForSelector('.palette-item.active[data-testid="palette-item-question.add"]');
  const first = await page.$eval(".palette-item.active .palette-item-title", (e) => e.textContent);
  assert.equal(first, "Add question", `top result for "add quest" is ${first}`);
  ok("fuzzy ranking puts 'Add question' first for 'add quest'");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="command-palette"]', { state: "detached" });
  await page.waitForTimeout(250);
  const after = await questionCount();
  assert.equal(after, before + 1);
  ok("Enter runs it: one more question in the definition");
  const def = await readDef();
  const q = def.questions[def.questions.length - 1];
  assert.equal(def.flow[0].questionIds.includes(q.id), true, "the new question is on the first page");
  ok("the new question landed on a page, not unplaced");
  assert.ok(await page.isVisible(".qlist-item"), "a question card is rendered");
  const rp = await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden"));
  assert.equal(rp, false, "the property panel should show the new question");
  ok("the command selected the new question — the property panel opened (selection bridge works)");
}

/* ----------------------------------------------------------- shortcuts */
{
  const before = await questionCount();
  await page.click("main.center", { position: { x: 10, y: 10 } }); // a plain click on the canvas, not in a field
  await page.keyboard.press(`${mod}+Shift+a`);
  await page.waitForTimeout(250);
  assert.equal(await questionCount(), before + 1);
  ok(`${mod}+Shift+A adds a question when nothing is focused`);
  // but not while typing: focus a text field and press it again
  const b2 = await questionCount();               // (this navigates JSON → Questions, so query the input AFTER it)
  const input = await page.$(".block input[type=text], .block input:not([type]), input.input");
  assert.ok(input, "an input to type in");
  await input.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "INPUT");
  await page.keyboard.press(`${mod}+Shift+a`);
  await page.waitForTimeout(250);
  assert.equal(await questionCount(), b2, "the shortcut must stand back while typing");
  ok("the same chord inside a text field does nothing — the field keeps its own keys");
}

/* ----------------------------------------------------------- duplicate via shortcut + find via palette */
{
  const before = await readDef();
  const first = before.questions[0];
  await selectCard(0);
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="palette-input"]');
  await page.type('[data-testid="palette-input"]', "duplicate");
  await page.waitForSelector('[data-testid="palette-item-question.duplicate"]');
  await page.click('[data-testid="palette-item-question.duplicate"]');
  await page.waitForTimeout(250);
  const after = await readDef();
  assert.equal(after.questions.length, before.questions.length + 1);
  const copy = after.questions.find((q) => q.code === `${first.code}_COPY`);
  assert.ok(copy, `a ${first.code}_COPY exists: ${after.questions.map((q) => q.code).join(",")}`);
  ok("'Duplicate question' from the palette copies the selected question with a fresh, unique code");
  const page0 = after.flow[0].questionIds;
  assert.equal(page0[page0.indexOf(first.id) + 1], copy.id, "the copy sits right after its source");
  ok("the copy is placed directly after the original");

  // the palette finds survey objects
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="palette-input"]');
  await page.type('[data-testid="palette-input"]', copy.code);
  await page.waitForSelector(`[data-testid="palette-item-find.question.${copy.id}"]`);
  ok("typing a question code finds that question");
  await page.click(`[data-testid="palette-item-find.question.${copy.id}"]`);
  await page.waitForTimeout(200);
  const rpHidden = await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden"));
  assert.equal(rpHidden, false);
  ok("picking it selects it — the property panel shows it");
}

/* ----------------------------------------------------------- navigation via palette */
{
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="palette-input"]');
  await page.type('[data-testid="palette-input"]', "open logic");
  await page.waitForSelector('.palette-item.active[data-testid="palette-item-nav.logic"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="command-palette"]', { state: "detached" });
  await page.waitForSelector(".leftnav .nav-item.active >> text=Logic");
  assert.equal(await activeTab(), "Logic");
  ok("'Open Logic' switches the tab");
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="palette-input"]');
  const hasSelf = await page.$('[data-testid="palette-item-nav.logic"]');
  assert.equal(hasSelf, null, "the current tab is not offered");
  ok("the current tab is not offered as a destination");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="command-palette"]', { state: "detached" });
  await page.click(".leftnav >> text=Questions");
  await page.waitForSelector(".block-badge");
}

/* ----------------------------------------------------------- the card buttons still work (question ops moved to the engine) */
{
  const before = await readDef();
  const codes = () => page.$$eval(".qlist-item strong.mono", (els) => els.map((e) => e.textContent));
  const c0 = await codes();
  assert.ok(c0.length >= 3, `need three questions, have ${c0.length}`);
  // move the first question down with its ↓ button
  const cards = await page.$$(".qlist-item");
  await (await cards[0].$('button[title="Move down"]')).click();
  await page.waitForTimeout(200);
  const c1 = await codes();
  assert.equal(c1[1], c0[0], `after ↓ the first card is second: ${c0.join(",")} → ${c1.join(",")}`);
  assert.equal(c1[0], c0[1]);
  ok("↓ swaps a question with the one below it");
  const cards2 = await page.$$(".qlist-item");
  await (await cards2[1].$('button[title="Move up"]')).click();
  await page.waitForTimeout(200);
  assert.deepEqual(await codes(), c0);
  ok("↑ puts it back");
  // duplicate button
  const cards3 = await page.$$(".qlist-item");
  await (await cards3[0].$('button[title="Duplicate"]')).click();
  await page.waitForTimeout(200);
  const c3 = await codes();
  assert.equal(c3.length, c0.length + 1);
  assert.equal(c3[1], `${c0[0]}_COPY_2`, `a second copy of ${c0[0]} gets _COPY_2, not a collision: ${c3.join(",")}`);
  ok("the card's ⧉ duplicates with a unique name even when a _COPY already exists");
  // delete via the dialog
  const cards4 = await page.$$(".qlist-item");
  await (await cards4[1].$('[data-testid="delete-question"]')).click();
  await page.waitForSelector('[data-testid="delete-question-dialog"]');
  await page.click('[data-testid="delete-question-confirm"]');
  await page.waitForSelector('[data-testid="delete-question-dialog"]', { state: "detached" });
  await page.waitForTimeout(200);
  const after = await readDef();
  assert.equal(after.questions.length, before.questions.length);
  assert.ok(!after.questions.some((q) => q.code === `${c0[0]}_COPY_2`), "the deleted copy is gone");
  for (const p of after.flow.filter((n) => n.type === "page")) {
    for (const id of p.questionIds) assert.ok(after.questions.some((q) => q.id === id), `page still lists a deleted question ${id}`);
  }
  ok("× deletes through the dialog and no page keeps a dangling id");
}

/* ----------------------------------------------------------- read-only hides edits */
{
  // the sandbox opts into collaboration with ?collab=1, which lands read-only (no session) — the palette must offer no edits there
  await page.goto(`${STUDIO}/sandbox?collab=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".topbar");
  await page.waitForTimeout(600);
  const ro = await page.$eval("main.center", (e) => e.dataset.readonly);
  if (ro === "1") {
    await page.keyboard.press(`${mod}+k`);
    await page.waitForSelector('[data-testid="palette-input"]');
    assert.equal(await page.$('[data-testid="palette-item-question.add"]'), null, "Add question offered in read-only");
    assert.ok(await page.$('[data-testid="palette-item-nav.logic"]'), "navigation still offered");
    ok("in read-only, the palette offers navigation but no edits");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="command-palette"]', { state: "detached" });
  } else {
    console.log("  skip read-only check: sandbox did not land read-only here");
  }
}

/* ----------------------------------------------------------- ?mode= */
{
  await page.goto(`${STUDIO}/sandbox?mode=nonsense`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="mode-selector"]');
  const active = await page.$eval('[data-testid="mode-selector"] .mode-option.active', (e) => e.dataset.mode);
  assert.equal(active, "studio");
  ok("?mode=<unknown> falls back to Studio — never an empty screen");
  const url = page.url();
  assert.ok(url.includes("mode=nonsense") || !url.includes("mode="), "the url is left alone until a real switch happens");
  ok("the URL is not rewritten by the fallback");
  await page.goto(`${STUDIO}/sandbox?mode=intelligent`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="intelligent-view"]');
  ok("?mode=intelligent opens straight into Intelligent");
  await page.goto(`${STUDIO}/sandbox?mode=grid`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="grid-view"]');
  ok("?mode=grid opens straight into Grid");
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL MULTI-MODAL FOUNDATION CHECKS PASSED (${passed})`);
