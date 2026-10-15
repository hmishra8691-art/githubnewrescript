/**
 * EMBEDDED DATA IN CALCULATIONS — `{{ed.FieldName}}` in the Calculations list,
 * Embedded Data calculations and inline `{{expr: …}}`.
 *
 *   · The Calculations tab accepts `{{ed.A}} + {{ed.B}}` — no "Unexpected
 *     character '{'" — and has the "Empty Embedded Data Handling" setting.
 *   · In the real runtime the total is computed from the field values (numeric
 *     strings are numbers: "1" + "1" is 2), an `{{expr: {{ed.A}} + 1}}` in
 *     question text renders as one value with no stray fragments, and an
 *     Embedded Data calculation can read other embedded fields.
 *
 *   node scripts/calc-embedded-test.mjs      (studio on 3000, runtime on 3001)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const base = (id, code, type, extra = {}) => ({
  id, code, variableName: code, type, text: `${code} text`, options: [], rows: [], columns: [],
  validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const fields = [
  { name: "LOWCAL_1", source: "static", value: "1" },
  { name: "LOWCAL_2", source: "static", value: "1" },
  { name: "LOWCAL_3", source: "static", value: "1" },
  { name: "BIGGER", source: "expression", value: "{{ed.LOWCAL_1}} + {{ed.LOWCAL_2}} + 10" },
];
const def = (calcs = [], settings) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "CalcEd", version: "1.0" },
  questions: [
    base("q_go", "Q1", "single_select", { options: [{ code: "1", label: "Go", flags: [] }] }),
    base("q_show", "Q2", "html", { text: "Total {{calc.TOTAL}} | expr {{expr: {{ed.LOWCAL_1}} + {{ed.LOWCAL_2}} * 2}} | bigger {{ed.BIGGER}}." }),
  ],
  embeddedData: fields.map((f) => ({ name: f.name })),
  calculations: calcs,
  ...(settings ? { calculationSettings: settings } : {}),
  flow: [
    { type: "embedded_data", id: "ed1", fields },
    { type: "page", id: "p1", questionIds: ["q_go"] },
    { type: "page", id: "p2", questionIds: ["q_show"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});
const TOTAL = [{ id: "c1", targetVariable: "TOTAL", expression: "{{ed.LOWCAL_1}} + {{ed.LOWCAL_2}} + {{ed.LOWCAL_3}}", trigger: "on_page_submit", dataType: "numeric" }];

/* ---------------------------------------------------------------- Studio */
await h.loadDef(def());
await h.goTab("Calculations");
await page.waitForSelector('[data-testid="calc-empty-embedded"]');
const opts = await page.$$eval('[data-testid="calc-empty-embedded"] option', (o) => o.map((x) => x.textContent));
assert.deepEqual(opts.map((t) => t.split(" (")[0]), ["Treat Empty as 0", "Show Calculation Error", "Skip Empty Values"]);
await page.selectOption('[data-testid="calc-empty-embedded"]', "skip");
await page.waitForTimeout(250);
assert.equal((await h.readDef()).calculationSettings.emptyEmbedded, "skip");
ok("Calculations has Empty Embedded Data Handling with its three choices, and it is stored");

await h.loadDef(def(TOTAL));
await h.goTab("Calculations");
await page.waitForSelector('[data-testid="calculation-0"]');
await page.waitForTimeout(500);
assert.equal(await page.locator('[data-testid="calculation-0"] .chip.warn').count(), 0, "no syntax error on {{ed.X}}");
assert.equal(await page.locator('[data-testid="calc-problem"]').count(), 0, "no lint problem: every field is declared");
ok("the Calculations card accepts {{ed.LOWCAL_1}} + … with no syntax error");

const bad = def([{ ...TOTAL[0], expression: "{{ed.LOWCAL_1}} + {{ed.NOPE}}" }]);
await h.loadDef(bad);
await h.goTab("Calculations");
await page.waitForSelector('[data-testid="calc-problem"]');
assert.match(await page.textContent('[data-testid="calc-problem"]'), /"NOPE".*no embedded data declares/);
ok("an undeclared embedded field is named in the Calculations list");

/* --------------------------------------------------------------- runtime */
const open = async (d) => {
  await h.loadDef(d);
  const pv = await h.preview(["q_go"], (x) => { x.flow = d.flow; });
  await pv.waitForSelector('[data-qid="q_go"]');
  return pv;
};
const goOn = async (pv) => {
  await pv.locator('[data-qid="q_go"] >> text=Go').first().click();
  await pv.locator(".rs-nav .rs-btn:not(.secondary)").first().click();
  await pv.waitForSelector('[data-qid="q_show"]');
  return pv.locator('[data-qid="q_show"]').innerText();
};

let pv = await open(def(TOTAL));
let text = await goOn(pv);
assert.match(text, /Total 3 \|/, `three static fields of "1" total 3: ${text}`);
assert.match(text, /expr 3 \|/, `{{expr: {{ed.A}} + {{ed.B}} * 2}} = 1 + 1*2: ${text}`);
assert.match(text, /bigger 12\./, `an Embedded Data calculation reads other embedded fields: ${text}`);
assert.doesNotMatch(text, /\{\{|\}\}|ed\.LOWCAL/, "no stray token fragments");
ok("runtime: numeric strings add (3), inline {{expr: …}} renders cleanly (3), embedded calculation reads embedded fields (12)");
await pv.close();

/* a non-numeric value: the total has no value and the console says which field */
const nonNum = def(TOTAL);
nonNum.flow[0].fields = nonNum.flow[0].fields.map((f) => (f.name === "LOWCAL_2" ? { ...f, value: "abc" } : f));
pv = await open(nonNum);
text = await goOn(pv);
assert.match(text, /Total \s*\|/, `a non-numeric field leaves the total empty: ${text}`);
const err = await pv.evaluate(() => window.__rescriptState?.calcErrors?.TOTAL);
assert.match(err ?? "", /"LOWCAL_2".*non-numeric.*"abc"/);
ok("runtime: a non-numeric embedded value names the field (LOWCAL_2) instead of failing silently");
await pv.close();

/* empty handling */
const emptyDef = (setting) => {
  const d = def(TOTAL, setting ? { emptyEmbedded: setting } : undefined);
  d.flow[0].fields = d.flow[0].fields.map((f) => (f.name === "LOWCAL_2" ? { ...f, value: "" } : f));
  return d;
};
pv = await open(emptyDef());
text = await goOn(pv);
assert.match(text, /Total 2 \|/, `Treat Empty as 0: 1 + 0 + 1 = 2: ${text}`);
await pv.close();
pv = await open(emptyDef("error"));
text = await goOn(pv);
assert.match(text, /Total \s*\|/);
assert.match((await pv.evaluate(() => window.__rescriptState?.calcErrors?.TOTAL)) ?? "", /"LOWCAL_2" is empty/);
await pv.close();
ok("runtime: Treat Empty as 0 gives 2; Show Calculation Error names the empty field");

await h.close();
console.log(`\n${passed} checks passed`);
