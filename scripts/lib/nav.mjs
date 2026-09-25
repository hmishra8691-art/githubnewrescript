/**
 * NAVIGATING THE STUDIO FROM A BROWSER SUITE — the menubar edition.
 *
 * The Studio's tools live in a horizontal menubar (2026-09-25): a group
 * opens on hover or click, and the tool is an item inside it. A suite that
 * used to `page.click(".leftnav >> text=JSON")` now calls `openTab(page,
 * "JSON")`, which hovers the group whose button lists that tool and clicks
 * the item — the same two gestures a person makes.
 *
 * Group buttons carry `data-nav-items`, their items' labels with spaces as
 * underscores, so the owner of a tool is found without opening anything.
 */

const token = (label) => label.trim().replace(/\s+/g, "_");

/** the group button that owns a tool, by the tool's label */
export function groupButtonFor(label) {
  return `.menubar [data-group-button][data-nav-items~="${token(label)}"]`;
}

/** hover a group open and wait for its panel */
export async function openGroup(page, groupSel) {
  await page.hover(groupSel);
  const id = await page.getAttribute(groupSel, "data-group-button");
  const panel = `[data-testid="menu-panel-${id}"]`;
  try {
    await page.waitForSelector(panel, { state: "visible", timeout: 1500 });
  } catch {
    // hover-intent can be lost to a re-render; a click opens at once
    await page.click(groupSel);
    await page.waitForSelector(panel, { state: "visible" });
  }
  return panel;
}

/** open the tool whose menu label is `label` ("JSON", "Survey Settings", …) */
export async function openTab(page, label) {
  const panel = await openGroup(page, groupButtonFor(label));
  const want = label.trim();
  // the exact label first (so "Data" is not "Data Analytics"), then Playwright's substring match
  const items = await page.$$(`${panel} .nav-item`);
  for (const it of items) {
    const text = await it.$eval(".nav-label", (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()).catch(() => "");
    if (text === want) { await it.click(); await page.waitForSelector(panel, { state: "detached" }); return; }
  }
  await page.click(`${panel} .nav-item >> text=${want}`);
  await page.waitForSelector(panel, { state: "detached" });
}

/** open a tool by its tab key ("json", "settings", …) — what `.menubar-here` reports in `data-tab` */
export async function openTabKey(page, key) {
  const panel = await openGroup(page, `.menubar [data-group-button][data-nav-keys~="${key}"]`);
  await page.click(`${panel} [data-testid="nav-${key}"]`);
  await page.waitForSelector(panel, { state: "detached" });
}

/** switch the programming mode by id ("grid", "flow", …) through the Mode menu */
export async function switchMode(page, id) {
  const panel = await openGroup(page, '.menubar [data-group-button="mode"]');
  await page.click(`${panel} [data-testid="mode-${id}"]`);
  await page.waitForSelector(panel, { state: "detached" });
}

/** click any item inside the Mode menu by test id (split-flow, split-off, focus-mode-toggle, open-chooser) */
export async function modeMenuClick(page, testId) {
  const panel = await openGroup(page, '.menubar [data-group-button="mode"]');
  await page.click(`${panel} [data-testid="${testId}"]`);
  await page.waitForSelector(panel, { state: "detached" }).catch(() => {});
}

/** every tool label, in menu order (group by group) — what the sidebar's item list used to be */
export async function navLabels(page) {
  const groups = await page.$$eval(".menubar-groups [data-group-button]", (bs) => bs.map((b) => b.dataset.groupButton).filter((g) => g !== "mode"));
  const out = [];
  for (const g of groups) {
    const panel = await openGroup(page, `.menubar [data-group-button="${g}"]`);
    out.push(...await page.$$eval(`${panel} .nav-item .nav-label`, (es) => es.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim())));
  }
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 400);
  return out;
}

/** the count badge on a tool, or null */
export async function navCount(page, label) {
  const panel = await openGroup(page, groupButtonFor(label));
  const n = await page.$eval(`${panel} .nav-item .nav-label >> text="${label}"`, (e) => e.querySelector(".nav-count")?.textContent ?? null);
  await page.keyboard.press("Escape");
  return n;
}
