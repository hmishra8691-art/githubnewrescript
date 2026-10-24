/**
 * THE LOGIC WORKSPACE FROM A BROWSER SUITE.
 *
 * Since 24 Oct 2026 the Properties panel and the Survey Flow cards show each
 * rule set as a read-only summary with "Edit logic ⤢"; the builders live in a
 * centred dialog that edits a DRAFT and commits on Save
 * (apps/studio/components/studio/LogicDialog.tsx, docs/LOGIC-DIALOG-2026-10-24.md).
 * A suite that used to drive the builder in the panel now:
 *
 *   await openSectionWorkspace(page, "display-logic");   // expand the section, open the dialog
 *   await page.click(`${LD_BODY} [data-testid="lb-add-condition"]`);   // …the same builder, in the dialog
 *   await saveWorkspace(page);                           // commit (before reading the JSON — the dialog is modal)
 *
 * While the dialog is open the rest of the Studio (the menubar, the JSON tab)
 * is behind its backdrop, so `readDef` helpers must `saveWorkspace` first.
 * Global selectors (`.ref-select`, `[data-testid="cond-operator"]`, …) keep
 * working: with the compact panel the dialog is the only builder on screen.
 *
 * `useInlineLogic(page)` is the explicit opt-out (the old in-panel builders),
 * for a suite whose subject is engine behaviour rather than this UI.
 */

export const LD = '[data-testid="logic-dialog"]';
export const LD_BODY = '[data-testid="logic-dialog-body"]';

export const workspaceOpen = async (page) => !!(await page.$(LD));

/** the opt-out, before the Studio loads (per browser context, localStorage) */
export async function useInlineLogic(page) {
  await page.addInitScript(() => { try { localStorage.setItem("rescript.logicSurface", "inline"); } catch { /* ignore */ } });
}

/**
 * Open the workspace from inside `scope` (a selector): the configured logic's
 * "Edit logic ⤢", else the empty condition's "Add logic ⤢". `nth` picks among
 * several in the scope. Returns the dialog body selector. Already open: a no-op.
 */
export async function openWorkspace(page, scope = "body", { nth = 0, timeout = 15000 } = {}) {
  const key = `scope:${scope}#${nth}`;
  if (await workspaceOpen(page)) {
    if (page.__logicWorkspace?.key === key) return LD_BODY;
    await saveWorkspace(page); // another workspace was open: commit it first, as a person would
  }
  page.__logicWorkspace = { key, reopen: () => openWorkspace(page, scope, { nth, timeout }) };
  const sel = `${scope} [data-testid="logic-workspace-open"]:visible, ${scope} [data-testid="optional-add-workspace"]:visible, ${scope} [data-testid^="mask-workspace-open"]:visible`;
  const deadline = Date.now() + timeout;
  for (;;) {
    const btns = await page.$$(sel);
    if (btns[nth]) { await btns[nth].click(); break; }
    if (Date.now() > deadline) throw new Error(`no "Edit logic ⤢" button in ${scope} (found ${btns.length})`);
    await page.waitForTimeout(250);
  }
  await page.waitForSelector(LD, { timeout });
  return LD_BODY;
}

/** Expand Properties section `id` (display-logic, skip-logic, validation-rules, auto-punch, …) and open its workspace. */
export async function openSectionWorkspace(page, id, opts = {}) {
  const key = `section:${id}#${opts.nth ?? 0}`;
  if (await workspaceOpen(page)) {
    if (page.__logicWorkspace?.key === key) return LD_BODY;
    await saveWorkspace(page);
  }
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") { await page.click(head); await page.waitForTimeout(150); }
  await openWorkspace(page, `[data-testid="psec-body-${id}"]`, opts);
  page.__logicWorkspace = { key, reopen: () => openSectionWorkspace(page, id, opts) };
  return LD_BODY;
}

/**
 * "Peek at the JSON, then keep editing": a suite's readDef saves the open
 * workspace (openTab does) and calls this afterwards to open the same one again.
 */
export async function reopenLastWorkspace(page) {
  if (await workspaceOpen(page)) return LD_BODY;
  /* best effort: if the suite has since moved somewhere the workspace cannot be reached from, it simply stays closed */
  return page.__logicWorkspace?.reopen?.().catch(() => null) ?? null;
}

/** Commit the draft (or simply close a clean dialog) and wait for it to go. No dialog: a no-op. */
export async function saveWorkspace(page) {
  if (!(await workspaceOpen(page))) return;
  const { disabled, reason } = await page.$eval('[data-testid="logic-dialog-save"]', (b) => ({ disabled: b.disabled, reason: b.title }))
    .catch(() => ({ disabled: true, reason: "" }));
  if (!disabled) await page.click('[data-testid="logic-dialog-save"]');
  else {
    /* clean: Close. Dirty but refused by the feature's own check ("Rule 2: … needs a value"): the draft cannot be stored, so it is discarded — say so */
    if (reason && reason !== "No changes to save") console.log(`  (logic workspace: Save refused — ${reason}; draft discarded)`);
    await page.click('[data-testid="logic-dialog-cancel"]');
    const confirm = await page.waitForSelector('[data-testid="logic-dialog-discard"]', { timeout: 1000 }).catch(() => null);
    if (confirm) await confirm.click();
  }
  await page.waitForSelector(LD, { state: "detached", timeout: 10000 });
  await page.waitForTimeout(150);
}

/** Throw the draft away (answering "Discard?" if asked). */
export async function discardWorkspace(page) {
  if (!(await workspaceOpen(page))) return;
  await page.click('[data-testid="logic-dialog-cancel"]');
  const confirm = await page.waitForSelector('[data-testid="logic-dialog-discard"]', { timeout: 1500 }).catch(() => null);
  if (confirm) await confirm.click();
  await page.waitForSelector(LD, { state: "detached", timeout: 10000 });
}

/** the Properties sections whose editing lives in the workspace (simple sections stay inline) */
export const LOGIC_SECTIONS = new Set(["display-logic", "skip-logic", "validation-rules", "auto-punch", "list-logic", "masking", "row-masking", "column-masking"]);
