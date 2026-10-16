// Matrix logic editor: what the row/column/value controls show for rating / dropdown matrices.
import { openHarness } from "/home/claude/rescript/scripts/lib/variantHarness.mjs";
const h = await openHarness();
const { page } = h;
const row = (code, label) => ({ code, label, flags: [], validation: [], required: false });
const base = (id, code, type, extra = {}) => ({ id, code, variableName: code, type, text: `${code} text`, options: [], rows: [], columns: [], validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra });
const def = {
  meta: { id: "sandbox", code: "SANDBOX", title: "MatrixSel", version: "1.0" },
  questions: [
    base("q_rate", "Q1", "matrix_single", { variant: "matrix.rating", options: [1, 2, 3, 4, 5].map((n) => ({ code: String(n), label: String(n), flags: [] })), rows: [row("1", "Service"), row("2", "Price")] }),
    base("q_drop", "Q2", "matrix_dropdown", { variant: "matrix.dropdown", rows: [row("1", "Row A"), row("2", "Row B")], columns: [{ id: "c1", label: "Choice", responseType: "dropdown", variableStem: "Q2_CHOICE", options: [{ code: "1", label: "Choice 1", flags: [] }, { code: "2", label: "Choice 2", flags: [] }, { code: "3", label: "Choice 3", flags: [] }] }] }),
    base("q_text", "Q3", "open_text"),
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_rate", "q_drop"] }, { type: "page", id: "p2", questionIds: ["q_text"] }, { type: "end", id: "e1", status: "complete" }],
};
await h.loadDef(def);
await h.goTab("Questions");
await page.waitForSelector('[data-testid="qcard"][data-qid="q_text"]');
await page.click('[data-testid="qcard"][data-qid="q_text"]');
const head = '[data-testid="psec-head-display-logic"]';
await page.waitForSelector(head);
if ((await page.getAttribute(head, "aria-expanded")) !== "true") await page.click(head);
await page.waitForTimeout(200);
const add = await page.$('[data-testid="optional-add"]'); if (add) await add.click();
await page.waitForSelector('[data-testid="logic-builder"]');
await page.click('[data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="lb-row"]');
const dump = async (label) => {
  const out = {};
  for (const t of ["cond-row", "cond-column", "cond-operator", "cond-value"]) {
    const n = await page.locator(`[data-testid="${t}"]`).count();
    out[t] = n ? await page.$$eval(`[data-testid="${t}"] option`, (o) => o.map((x) => x.textContent.trim())) : "(absent)";
  }
  const ref = await page.locator('[data-testid="cond-reference"]').count() ? await page.textContent('[data-testid="cond-reference"]') : "(absent)";
  console.log(`\n== ${label}\n  reference chip: ${ref}`);
  for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${Array.isArray(v) ? v.join(" | ") : v}`);
  const rowText = await page.$eval('[data-testid="lb-row"]', (e) => e.innerText.replace(/\s+/g, " ").trim());
  console.log(`  row text: ${rowText.slice(0, 300)}`);
};
const opts = async () => page.$$eval('.ref-select option', (o) => o.map((x) => x.textContent));
console.log("source options:", (await opts()).join(" | "));
await page.selectOption(".ref-select", { label: "Q1 — Q1" }); await page.waitForTimeout(300);
await dump("Q1 rating matrix, default operator");
const opsQ1 = await page.$$eval('[data-testid="cond-operator"] option', (o) => o.map((x) => ({ v: x.value, t: x.textContent })));
const gte = opsQ1.find((o) => /gte|≥|at least/i.test(o.v + o.t));
if (gte) { await page.selectOption('[data-testid="cond-operator"]', gte.v); await page.waitForTimeout(300); await dump(`Q1 after operator ${gte.t}`); }
await page.selectOption(".ref-select", { label: "Q2 — Q2" }); await page.waitForTimeout(300);
await dump("Q2 dropdown matrix, default");
if (await page.locator('[data-testid="cond-column"]').count()) {
  const cols = await page.$$eval('[data-testid="cond-column"] option', (o) => o.map((x) => x.value));
  const c = cols.find((v) => v && v !== "" && !/any/i.test(v));
  if (c) { await page.selectOption('[data-testid="cond-column"]', c); await page.waitForTimeout(300); await dump(`Q2 after picking column ${c}`); }
}
await page.screenshot({ path: "/tmp/audit/browser/matrix-selector.png", fullPage: false });
await h.close?.();
process.exit(0);
