/**
 * Browser suite — the researcher-first List Fill card (2026-11-13).
 *
 * The card opens on what the list does for a respondent and anything left to fix; the grid hides the two rarely used
 * columns until they are in use or asked for; picking the source question fills the item rows. Nothing stored changes
 * shape, and every setting is still reachable.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/listfill-simple-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

const BR = ["Apple", "Beta", "Gamma"].map((label, i) => ({ code: String.fromCharCode(65 + i), label }));
const LF = (over = {}) => ({
  id: "lf1", name: "Q1", enabled: true,
  source: { kind: "question", questionId: "q1", take: "selected" },
  selection: { count: { kind: "fixed", n: 1 }, method: "highest_priority", equalPriority: "random", afterTarget: "reduce_priority", afterMaximum: "next_priority", fallback: "random_eligible", weighted: false, allowDuplicates: false, fillToCount: true },
  tracking: { sampleLevel: true, respectQuotas: false, quotaIds: [], separateTestCounts: true, countOnCompleteOnly: false },
  options: BR.map((o, i) => ({ code: o.code, label: o.label, priority: i + 1, maximum: 100, eligible: true })),
  destinations: [{ questionId: "q2", write: "answer" }], storeTrace: false,
  ...over,
});
const def = (listFills) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "List fill", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands?", options: BR, settings: {} },
    { id: "q2", code: "Q2", variableName: "PICKED", type: "single_select", text: "About {{LISTFILL_Q1_1}}?", options: BR, settings: {} },
  ],
  listFills,
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
});
const summary = () => page.$eval('[data-testid="lf-summary-lf1"]', (e) => e.textContent.replace(/\s+/g, " ").trim());
const checks = () => page.$$eval('[data-testid="lf-summary-lf1"] [data-testid="lf-check"]', (es) => es.map((e) => `${e.getAttribute("data-level")}: ${e.textContent.trim()}`));
const heads = () => page.$$eval('[data-testid="lf-grid-lf1"] thead th', (ths) => ths.map((t) => t.textContent.trim()).filter(Boolean));
const open = async (lfs) => { await h.loadDef(def(lfs)); await h.goTab("List Fill"); await page.waitForSelector('[data-testid="lf-summary-lf1"]'); };

console.log("\nLIST FILL — what it does, first");
await open([LF()]);
{
  const s = await summary();
  assert.match(s, /Gives each respondent 1 item from the answers the respondent chose at Q1, lowest priority number first\./);
  assert.match(s, /Every item stops once it reaches its maximum\./);
  assert.match(s, /Writes the result into Q2\./);
  assert.deepEqual(await checks(), []);
  ok(`the card opens on what the list does: “${s.slice(0, 100)}…”`);
}
{
  assert.deepEqual(await heads(), ["item", "priority", "target", "at most", "given", "completed", "room left", "status"]);
  const status = await page.textContent('[data-testid="lf-grid-lf1"] tr[data-code="A"] .chip');
  assert.equal(status.trim(), "open");
  assert.equal(await page.getAttribute('[data-testid="lf-grid-lf1"] tr[data-code="A"]', "data-status"), "ACTIVE");
  await page.click('[data-testid="lf-all-limits-lf1"]');
  await page.waitForSelector('[data-testid="lf-grid-lf1"] td[data-col="weight"]');
  assert.deepEqual(await heads(), ["item", "priority", "target", "at least", "at most", "weight", "given", "completed", "room left", "status"]);
  ok("the grid shows the usual limits in plain words; “at least” and weight appear when asked for");
}
{
  const before = JSON.stringify((await h.readDef()).listFills);
  await h.goTab("List Fill");
  await page.click('[data-testid="lf-open-lf1"]');
  await page.waitForSelector('[data-testid="lf-method-lf1"]');
  const groups = await page.$$eval('[data-testid="lf-method-lf1"] > option, [data-testid="lf-method-lf1"] optgroup', (es) => es.map((e) => e.tagName === "OPTGROUP" ? `[${e.label}]` : e.value));
  assert.deepEqual(groups.slice(0, 6), ["highest_priority", "first_selected", "random", "least_filled", "balanced_random", "[Less common]"]);
  const all = await page.$$eval('[data-testid="lf-method-lf1"] option', (os) => os.map((o) => o.value));
  assert.equal(all.length, 12, "all twelve ways of choosing are still offered");
  assert.equal(JSON.stringify((await h.readDef()).listFills), before, "opening the panels writes nothing");
  ok("More options offers the five usual ways of choosing first, the other seven under “Less common” — and changes nothing");
}

console.log("\nLIST FILL — the engine explains what is unfinished");
{
  await open([LF({ selection: { ...LF().selection, method: "weighted_random" } })]);
  assert.ok((await heads()).includes("weight"), "weighted random shows the weight column");
  const c = await checks();
  assert.ok(c.some((x) => x.startsWith("warning") && /no item has a weight/.test(x)), JSON.stringify(c));
  ok("weighted random with no weights says so, and shows the weight column");
}
{
  await open([LF({ source: { kind: "static", items: [] }, options: [] })]);
  assert.ok((await checks()).some((x) => x.startsWith("problem") && /Choose the question/.test(x)));
  await page.selectOption('[data-testid="lf-source-lf1"]', "q1");
  await page.waitForSelector('[data-testid="lf-grid-lf1"] tr[data-code="C"]');
  const stored = (await h.readDef()).listFills[0];
  assert.deepEqual(stored.source, { kind: "question", questionId: "q1", take: "selected" });
  assert.deepEqual(stored.options, BR.map((o) => ({ code: o.code, label: o.label, eligible: true })), "one plain row per answer, with no limits");
  ok("an empty List Fill asks for its source; choosing it adds one row per answer, with no limits (so allocation is unchanged)");
}

await h.close();
console.log(`\nlistfill-simple-test: ${pass} checks passed`);
