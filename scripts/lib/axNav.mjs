/**
 * Moving around the analytics workspace in the browser suites (Phase 5).
 * The workspace has five places (`ax-place-*`); the views that used to be tabs
 * are inside them (`ax-tab-*`, shown for the place you are in). `axTab` goes
 * to a view from wherever you are — click its place, then its view — so a
 * suite says what it means ("the Reports view") and not which place holds it.
 */
export const PLACE_OF = { home: "overview", plan: "plan", analysis: "explore", tables: "explore", charts: "explore", segments: "explore", filters: "explore", findings: "findings", themes: "findings", reports: "deliver", exports: "deliver", sharing: "deliver" };

export async function axTab(page, key) {
  if (key === "ask") {
    if (!(await page.isVisible('[data-testid="ax-ask-drawer"]'))) await page.click('[data-testid="ax-ask-open"]');
    return;
  }
  const place = PLACE_OF[key];
  if (!place) throw new Error(`unknown analytics view: ${key}`);
  await page.click(`[data-testid="ax-place-${place}"]`);
  const view = await page.$(`[data-testid="ax-tab-${key}"]`);
  if (view) await view.click();
}
