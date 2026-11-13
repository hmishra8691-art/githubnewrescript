/**
 * Browser suite — the researcher-first loop editor (2026-11-13).
 *
 * The loop card used to open on every setting at once under programming
 * names. It now opens on a sentence saying what the loop does, anything that
 * needs fixing in plain words, and the two decisions every loop needs; the
 * rest is under "More options". This proves the simplification removed
 * nothing: every setting is still reachable and the stored loop is unchanged.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/loop-simple-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
const L = '[data-node-id="LOOP_001"]';
const BRANDS = [{ code: "1", label: "Apple" }, { code: "2", label: "Samsung" }, { code: "3", label: "Google" }];
const q = (id, type, text, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text, options: [], settings: {}, ...extra });
const def = (loop, flowBefore = true) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Loops", version: "1.0" },
  questions: [
    q("q1", "multi_select", "Which brands do you own?", { options: BRANDS }),
    q("q2", "single_select", "How satisfied are you with {{brand.label}}?", { options: [{ code: "1", label: "Very" }, { code: "2", label: "Not" }] }),
    q("q3", "open_text", "Why?"),
  ],
  flow: [
    ...(flowBefore ? [{ type: "page", id: "p1", questionIds: ["q1"] }] : []),
    { type: "loop", id: "LOOP_001", loopVar: "brand", children: [{ type: "page", id: "p2", questionIds: ["q2", "q3"] }], ...loop },
    ...(flowBefore ? [] : [{ type: "page", id: "p1", questionIds: ["q1"] }]),
    { type: "end", id: "e", status: "complete" },
  ],
});
const loopOf = async () => (await h.readDef()).flow.find((n) => n.type === "loop");
const summary = () => page.$eval(`${L} [data-testid="loop-summary"]`, (e) => e.textContent.replace(/\s+/g, " ").trim());
const checks = () => page.$$eval(`${L} [data-testid="loop-check"]`, (es) => es.map((e) => `${e.getAttribute("data-level")}: ${e.textContent.replace(/\s+/g, " ").trim()}`));
const open = async (d) => { await h.loadDef(d); await h.goTab("Survey Flow"); await page.waitForSelector(`${L} [data-testid="loop-editor"]`); };

console.log("\nLOOP — plain language first");

const SIMPLE = { source: { kind: "question", questionId: "q1", filter: "selected" } };
await open(def(SIMPLE));
{
  const s = await summary();
  assert.match(s, /Repeats 2 questions/); assert.match(s, /Q1/); assert.match(s, /chose/);
  assert.doesNotMatch(s, /iteration|loopVar|filter|aggregate/i, `the summary is jargon-free: ${s}`);
  assert.deepEqual((await checks()).filter((c) => c.startsWith("problem")), [], "a complete loop reports no problem");
  ok(`the card opens on what the loop does: “${s.slice(0, 90)}…”`);
}
{
  assert.equal(await page.$eval(`${L} [data-testid="loop-more"]`, (e) => e.open), false);
  for (const id of ["loop-var", "loop-references", "loop-aggregates", "loop-statement", "loop-resolve-source"]) {
    const el = await page.$(`${L} [data-testid="${id}"]`);
    if (el) assert.equal(await el.isVisible(), false, `${id} is out of the way until asked for`);
  }
  for (const id of ["loop-source-kind", "loop-filter", "loop-count-mode", "loop-order"]) assert.equal(await page.isVisible(`${L} [data-testid="${id}"]`), true, `${id} is up front`);
  ok("a plain loop shows only what to repeat for, how many and the order; the rest is folded under More options");
}
{
  const before = JSON.stringify(await loopOf());
  await h.goTab("Survey Flow");
  await page.waitForSelector(`${L} [data-testid="loop-more-toggle"]`);
  await page.click(`${L} [data-testid="loop-more-toggle"]`);
  await page.waitForFunction((s) => document.querySelector(`${s} [data-testid="loop-more"]`)?.open === true, L);
  for (const id of ["loop-var", "loop-references", "loop-aggregates", "loop-statement"]) assert.equal(await page.isVisible(`${L} [data-testid="${id}"]`), true, `${id} is reachable under More options`);
  assert.equal(await page.inputValue(`${L} [data-testid="loop-var"]`), "brand");
  assert.equal(JSON.stringify(await loopOf()), before, "opening More options writes nothing");
  ok("More options holds the loop name, item details, totals and the technical summary — and opening it changes nothing");
}
{
  await h.goTab("Survey Flow");
  await page.waitForSelector(`${L} [data-testid="loop-count-mode"]`);
  await page.selectOption(`${L} [data-testid="loop-count-mode"]`, "max");
  await page.waitForSelector(`${L} [data-testid="loop-count-value"]`);
  await page.selectOption(`${L} [data-testid="loop-order"]`, "random");
  await page.waitForFunction((s) => /random order/.test(document.querySelector(`${s} [data-testid="loop-summary"]`)?.textContent ?? ""), L);
  const s = await summary();
  assert.match(s, /at most/); assert.match(s, /random order/);
  const node = await loopOf();
  assert.equal(node.count?.mode ?? node.maxIterations !== undefined ? "max" : null, "max");
  ok(`the sentence follows every change: “${s.slice(0, 110)}…”`);
}

console.log("\nLOOP — the engine explains what is wrong");
{
  await open(def(SIMPLE, false));
  const c = await checks();
  assert.ok(c.some((x) => x.startsWith("problem") && /Q1/.test(x) && /after|before|later|earlier/.test(x)), `a loop reading a later question is called out: ${JSON.stringify(c)}`);
  ok(`a source asked after the loop is a plain-language problem: “${c.find((x) => x.startsWith("problem")).slice(9, 110)}…”`);
}
{
  await open(def({ source: { kind: "static", items: [] } }));
  const c = await checks();
  assert.ok(c.some((x) => x.startsWith("problem")), `an empty typed list is a problem: ${JSON.stringify(c)}`);
  ok("an empty list is reported in words, with what to do");
}

console.log("\nLOOP — settings in use are never hidden, stored loops are untouched");
{
  const FULL = {
    source: { kind: "question", questionId: "q1", filter: "selected" },
    references: { columns: [{ name: "Category" }], values: { "1": { Category: "Phone" } } },
    aggregates: [{ name: "TOTAL_SAT", op: "sum", questionRef: "Q2" }],
  };
  /* forget that the section was opened by hand above — it must open because the settings are in use */
  await page.evaluate(() => sessionStorage.removeItem("rescript.loop.more"));
  await open(def({ source: { kind: "static", items: [{ code: "1", label: "A" }] } }));
  assert.equal(await page.$eval(`${L} [data-testid="loop-more"]`, (e) => e.open), false, "closed again for a plain loop");
  await open(def(FULL));
  assert.equal(await page.$eval(`${L} [data-testid="loop-more"]`, (e) => e.open), true);
  assert.equal(await page.isVisible(`${L} [data-testid="loop-references"]`), true);
  const node = await loopOf();
  assert.deepEqual(node.references, FULL.references); assert.deepEqual(node.aggregates, FULL.aggregates); assert.equal(node.loopVar, "brand");
  ok("a loop that uses item details or totals opens with More options showing, and its stored configuration is byte-for-byte what was loaded");
}

console.log("\nLOOP — a new loop starts from the obvious question");
{
  await h.loadDef({ ...def(SIMPLE), flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2", "q3"] }, { type: "end", id: "e", status: "complete" }] });
  await h.goTab("Survey Flow");
  const inserts = await page.$$('[data-testid="flow-insert"]');
  await inserts[Math.min(1, inserts.length - 1)].click();
  await page.waitForSelector('[data-testid="flow-insert-menu"]');
  await page.click('[data-testid="insert-loop"]');
  await page.waitForTimeout(400);
  const d = await h.readDef();
  const at = d.flow.findIndex((n) => n.type === "loop");
  const node = d.flow[at];
  assert.ok(node, "a loop was added");
  const p1At = d.flow.findIndex((n) => n.id === "p1");
  if (p1At < at) assert.deepEqual(node.source, { kind: "question", questionId: "q1", filter: "selected" }, "it reads the multi-select asked before it");
  else assert.deepEqual(node.source, { kind: "static", items: [] }, "nothing is asked before it, so it starts as an empty list as before");
  ok(`a loop added ${p1At < at ? "after the brand question repeats for the brands chosen there" : "first in the flow starts as an empty list"} (position ${at})`);
}

console.log("\nFLOW ELEMENTS — the same opening sentence and checks");
{
  await h.loadDef({
    meta: { id: "sandbox", code: "SANDBOX", title: "Flow", version: "1.0" },
    questions: [q("q1", "multi_select", "Which brands do you own?", { options: BRANDS }), q("q2", "open_text", "Why?")],
    quotas: [],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "randomizer", id: "RND", children: [{ type: "page", id: "p2", questionIds: ["q2"] }] },
      { type: "quota_check", id: "QC", quotaIds: [], onFull: { kind: "terminate" } },
      { type: "redirect", id: "RD", url: "https://" },
      { type: "end", id: "END", status: "screened" },
    ],
  });
  await h.goTab("Survey Flow");
  const guide = async (id) => {
    const root = `[data-node-id="${id}"] [data-testid="flow-guide"]`;
    if (!(await page.$(root))) await page.click(`[data-node-id="${id}"] > .fc-head .block-toggle`);
    await page.waitForSelector(root, { timeout: 8000 });
    return {
      text: await page.$eval(`${root} .loop-summary-main`, (e) => e.textContent.trim()),
      checks: await page.$$eval(`${root} [data-testid="flow-guide-check"]`, (es) => es.map((e) => `${e.getAttribute("data-level")}: ${e.textContent.trim()}`)),
    };
  };
  const flagged = await page.$$eval('[data-testid="flow-needs-fix"]', (es) => es.map((e) => e.closest("[data-node-id]").getAttribute("data-node-id")));
  assert.deepEqual(flagged.sort(), ["QC", "RD"], "the unfinished quota check and redirect say so while still closed; the finished end point does not");
  const rnd = await guide("RND");
  assert.match(rnd.text, /Each respondent sees all 1 part inside/); assert.ok(rnd.checks.some((c) => /^problem: Fix.*nothing to shuffle/.test(c)), JSON.stringify(rnd));
  const qc = await guide("QC");
  assert.match(qc.text, /No quota is chosen yet/); assert.ok(qc.checks.some((c) => /no quotas yet/.test(c)), JSON.stringify(qc));
  const rd = await guide("RD");
  assert.equal(rd.text, "No link is set yet."); assert.ok(rd.checks.some((c) => c.startsWith("problem")));
  const end = await guide("END");
  assert.equal(end.text, "The survey ends here as screened out (not eligible)."); assert.deepEqual(end.checks, []);
  const labels = await page.$$eval('[data-node-id="END"] select option', (os) => os.map((o) => `${o.value}=${o.textContent}`));
  assert.deepEqual(labels, ["complete=Completed", "screened=Screened out (not eligible)", "quota_full=Quota full", "terminated=Terminated"], "plain labels, the stored values unchanged");
  const stored = (await h.readDef()).flow;
  assert.deepEqual(stored.find((n) => n.id === "END"), { type: "end", id: "END", status: "screened" });
  assert.deepEqual(stored.find((n) => n.id === "QC"), { type: "quota_check", id: "QC", quotaIds: [], onFull: { kind: "terminate" } });
  ok("the randomizer, quota check, redirect and end point each say what they do and what is missing; nothing stored changed");
}

await h.close();
console.log(`\nloop-simple-test: ${pass} checks passed`);
