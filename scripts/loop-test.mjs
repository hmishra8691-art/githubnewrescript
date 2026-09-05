/**
 * Browser suite — the For-Loop / Repeating Block engine.
 *
 * Two halves, matching where the feature has to be true:
 *
 *   STUDIO   the loop card configures source, filter, count and order; the
 *            LOOP REFERENCES table adds columns and values that land on the
 *            loop node — and on nothing else; a paste import fills the table;
 *            the SIMULATOR shows the runtime's own resolution
 *
 *   RUNTIME  a preview respondent iterates the block once per selected item,
 *            every question pipes the current item's references, display logic
 *            on a reference is evaluated per iteration, the Loop Debug panel
 *            names the exact context, answers store per iteration, and a
 *            nested loop keys separately for every outer iteration
 *
 * The engine's own contract (filters, order, count, variables, exports) is
 * proved in packages/engine/src/loops.test.ts and packages/exporters.
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/loop-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

/* ============================================================ definition */

const BRANDS = [
  { code: "1", label: "Apple" }, { code: "2", label: "Samsung" }, { code: "3", label: "Google" },
  { code: "4", label: "OnePlus" }, { code: "5", label: "Xiaomi" },
];

const baseDef = (loop = {}, extra = {}) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Loops", version: "1.0" },
  questions: [
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which brands do you own?", options: BRANDS, settings: {} },
    { id: "q6", code: "Q6", variableName: "Q6", type: "single_select",
      text: "How satisfied are you with {{CURRENT_ITEM}}?",
      options: [{ code: "1", label: "Very" }, { code: "2", label: "Not" }], settings: {} },
    { id: "q7", code: "Q7", variableName: "Q7", type: "open_text",
      text: "Product ID: {{CURRENT_ITEM.Product_ID}} — evaluate {{loop.Brand_Nickname}} in category {{loop.Category}} ({{LOOP_INDEX}} of {{LOOP_COUNT}})", settings: {} },
    { id: "q8", code: "Q8", variableName: "Q8", type: "open_text", text: "Smartphone-only question for {{loop.label}}",
      displayLogic: { type: "rule", source: { kind: "loop", ref: "Category" }, operator: "eq", value: "Smartphone" }, settings: {} },
    { id: "q9", code: "Q9", variableName: "Q9", type: "open_text", text: "Anything else?", settings: {} },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q2"] },
    {
      type: "loop", id: "LOOP_001", loopVar: "brand",
      source: { kind: "question", questionId: "q2", filter: "selected" },
      children: [{ type: "block", id: "b2", title: "Block 2", children: [{ type: "page", id: "p6", questionIds: ["q6", "q7", "q8"] }] }],
      ...loop,
    },
    { type: "page", id: "p9", questionIds: ["q9"] },
    { type: "end", id: "e", status: "complete" },
  ],
  ...extra,
});

const REFS = {
  columns: [{ name: "Brand_Nickname" }, { name: "Product_ID" }, { name: "Client_Code" }, { name: "Category" }],
  values: {
    "1": { Brand_Nickname: "APPLE", Product_ID: "PROD_001", Client_Code: "C001", Category: "Smartphone" },
    "3": { Brand_Nickname: "GOOGLE", Product_ID: "PROD_003", Client_Code: "C003", Category: "Smartphone" },
    "5": { Brand_Nickname: "XIAOMI", Product_ID: "PROD_005", Client_Code: "C005", Category: "Accessory" },
  },
};

await h.loadDef(baseDef());

/* ============================================================ studio */

console.log("\nSTUDIO — the loop card");

await h.goTab("Survey Flow");
await page.waitForSelector('[data-node-id="LOOP_001"] [data-testid="loop-editor"]');
ok("the loop card opens into the loop editor");

{
  const kind = await page.$eval('[data-node-id="LOOP_001"] [data-testid="loop-source-kind"]', (e) => e.value);
  assert.equal(kind, "question");
  const filter = await page.$eval('[data-node-id="LOOP_001"] [data-testid="loop-filter"]', (e) => e.value);
  assert.equal(filter, "selected");
  const filters = await page.$$eval('[data-node-id="LOOP_001"] [data-testid="loop-filter"] option', (os) => os.map((o) => o.value));
  assert.deepEqual(filters, ["selected", "notSelected", "displayed", "all", "eligible", "invalid"], "every §9–§12 filter is offered");
  const kinds = await page.$$eval('[data-node-id="LOOP_001"] [data-testid="loop-source-kind"] option', (os) => os.map((o) => o.value));
  assert.ok(kinds.includes("listFill") && kinds.includes("count") && kinds.includes("variable"), "List Fill, count and variable sources are offered — the old editor could not even produce a List Fill source");
  ok("source, filter, count and order controls are present with every documented choice");
}

/* -------------------------------------------------- reference columns */

console.log("\nSTUDIO — loop references belong to the loop (§2–§7, §15–§17, §40)");

const refsRoot = '[data-node-id="LOOP_001"] [data-testid="loop-references"]';
{
  // the table lists every item the source can produce, before any column exists
  const rows = await page.$$eval(`${refsRoot} [data-testid="loop-ref-row"]`, (trs) => trs.map((t) => t.getAttribute("data-code")));
  assert.deepEqual(rows, ["1", "2", "3", "4", "5"]);
  ok("the reference table has one row per option of the source");

  // + Add Reference Column, with the name the requirement uses
  await page.fill(`${refsRoot} [data-testid="loop-ref-new-name"]`, "Product_ID");
  await page.click(`${refsRoot} [data-testid="loop-ref-add"]`);
  await page.waitForSelector(`${refsRoot} [data-testid="loop-ref-cell"][data-column="Product_ID"]`);
  ok("+ Add Reference Column creates a dynamic column");

  // a bad name is refused with a reason, not silently
  await page.fill(`${refsRoot} [data-testid="loop-ref-new-name"]`, "9 lives");
  await page.click(`${refsRoot} [data-testid="loop-ref-add"]`);
  const err = await page.textContent(`${refsRoot} [data-testid="loop-ref-error"]`);
  assert.match(err, /identifier/);
  await page.fill(`${refsRoot} [data-testid="loop-ref-new-name"]`, "label");
  await page.click(`${refsRoot} [data-testid="loop-ref-add"]`);
  assert.match(await page.textContent(`${refsRoot} [data-testid="loop-ref-error"]`), /item itself/);
  ok("a column name that would not fit {{loop.Name}}, or would shadow the item, is refused with a reason");

  // populate values by hand (§17)
  await page.fill(`${refsRoot} [data-testid="loop-ref-cell"][data-code="1"][data-column="Product_ID"]`, "PROD_001");
  await page.fill(`${refsRoot} [data-testid="loop-ref-cell"][data-code="3"][data-column="Product_ID"]`, "PROD_003");
  await page.waitForTimeout(200);

  const def = await h.readDef();
  const loop = def.flow.find((n) => n.type === "loop");
  assert.deepEqual(loop.references.columns.map((c) => c.name), ["Product_ID"]);
  assert.equal(loop.references.values["1"].Product_ID, "PROD_001");
  assert.equal(loop.references.values["3"].Product_ID, "PROD_003");
  ok("the values are stored on the loop node, keyed by item code (§5, §38)");

  const q2 = def.questions.find((q) => q.id === "q2");
  assert.equal(JSON.stringify(q2).includes("PROD_001"), false, "Q2 knows nothing about the references");
  assert.deepEqual(q2.options.map((o) => Object.keys(o).sort()), BRANDS.map(() => Object.keys(q2.options[0]).sort()));
  assert.equal(q2.references, undefined);
  ok("the source question is untouched (§40)");
}

/* -------------------------------------------------- import */

console.log("\nSTUDIO — importing a reference table (§18)");
{
  await h.goTab("Survey Flow");
  await page.waitForSelector(refsRoot);
  await page.click(`${refsRoot} [data-testid="loop-import-toggle"]`);
  await page.fill(`${refsRoot} [data-testid="loop-import-text"]`,
    "Code\tBrand_Nickname\tProduct_ID\tClient_Code\tCategory\n1\tAPPLE\tPROD_001\tC001\tSmartphone\n3\tGOOGLE\tPROD_003\tC003\tSmartphone\n5\tXIAOMI\tPROD_005\tC005\tAccessory\n");
  await page.click(`${refsRoot} [data-testid="loop-import-apply"]`);
  await page.waitForSelector(`${refsRoot} [data-testid="loop-import-note"]`);
  const note = await page.textContent(`${refsRoot} [data-testid="loop-import-note"]`);
  assert.match(note, /Imported 3 items/);
  assert.match(note, /new columns: Brand_Nickname, Client_Code, Category/, "the existing Product_ID column was reused, the others created");

  const def = await h.readDef();
  const loop = def.flow.find((n) => n.type === "loop");
  assert.deepEqual(loop.references.columns.map((c) => c.name), ["Product_ID", "Brand_Nickname", "Client_Code", "Category"]);
  assert.equal(loop.references.values["5"].Category, "Accessory");
  assert.equal(loop.references.values["1"].Product_ID, "PROD_001", "an existing value survives an import that repeats it");
  ok("a pasted table populates this loop's references, creating the columns it needs");
}

/* -------------------------------------------------- simulator */

console.log("\nSTUDIO — the simulator is the runtime's own resolution (§34)");
{
  await h.goTab("Survey Flow");
  const simRoot = '[data-node-id="LOOP_001"] [data-testid="loop-simulator"]';
  await page.click(`${simRoot} [data-testid="loop-sim-toggle"]`);
  await page.click(`${simRoot} [data-testid="loop-sim-option"][data-code="1"]`);
  await page.click(`${simRoot} [data-testid="loop-sim-option"][data-code="3"]`);
  await page.click(`${simRoot} [data-testid="loop-sim-option"][data-code="5"]`);
  await page.waitForSelector(`${simRoot} [data-testid="loop-sim-iteration"]`);
  const iters = await page.$$eval(`${simRoot} [data-testid="loop-sim-iteration"]`, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  assert.equal(iters.length, 3);
  assert.match(iters[0], /Iteration 1 — item = Apple \(1\)/);
  assert.match(iters[0], /Product_ID = PROD_001/);
  assert.match(iters[0], /Category = Smartphone/);
  assert.match(iters[1], /Iteration 2 — item = Google/);
  assert.match(iters[2], /Iteration 3 — item = Xiaomi/);
  assert.match(iters[2], /Category = Accessory/);
  ok("the simulator lists each iteration with its item and every reference value");
}

/* -------------------------------------------------- two loops, one question */

console.log("\nSTUDIO — two loops over Q2 with different tables (§6, §41)");
{
  const def = await h.readDef();
  def.flow.splice(2, 0, {
    type: "loop", id: "LOOP_002", loopVar: "client",
    source: { kind: "question", questionId: "q2", filter: "selected" },
    references: { columns: [{ name: "Region" }, { name: "Store_ID" }], values: { "1": { Region: "West", Store_ID: "S-9" } } },
    children: [{ type: "page", id: "p10", questionIds: [] }],
  });
  await h.loadDef(def);
  await h.goTab("Survey Flow");
  const cols1 = await page.$$eval('[data-node-id="LOOP_001"] [data-testid="loop-ref-column-name"]', (es) => es.map((e) => e.value));
  const cols2 = await page.$$eval('[data-node-id="LOOP_002"] [data-testid="loop-ref-column-name"]', (es) => es.map((e) => e.value));
  assert.deepEqual(cols1, ["Product_ID", "Brand_Nickname", "Client_Code", "Category"]);
  assert.deepEqual(cols2, ["Region", "Store_ID"]);
  ok("each loop shows its own columns; neither leaks into the other");
  def.flow.splice(2, 1);
  await h.loadDef(def);
}

/* -------------------------------------------------- the condition builder */

console.log("\nSTUDIO — a question inside the loop can build logic on the loop's references (§27)");
{
  await h.goTab("Questions");
  // open Q8 (third card inside the loop's page) and look at its properties
  await page.click('.qcard:has-text("Smartphone-only")');
  await page.waitForSelector('[data-testid="in-loop-chip"]');
  const chip = await page.textContent('[data-testid="in-loop-chip"]');
  assert.match(chip, /in loop “brand”/);
  assert.match(chip, /Product_ID/);
  ok("the properties panel says which loop the question is in and which references it can use");

  // the condition builder's source list offers the loop's columns, by name
  const opts = await page.$$eval("select.ref-select option", (os) => os.map((o) => o.value));
  assert.ok(opts.includes("loop:Category"), `loop:Category is offered — got ${opts.filter((o) => o.startsWith("loop")).join(", ")}`);
  assert.ok(opts.includes("loop:Product_ID"));
  assert.ok(opts.includes("loop:count"));
  ok("the condition builder lists the loop's reference columns as sources");
}

/* ============================================================ runtime */

console.log("\nRUNTIME — a preview respondent runs the loop");

const runPreview = async (def) => {
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1100 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  await pv.goto(`${process.env.RUNTIME_URL ?? "http://localhost:3001"}/preview`, { waitUntil: "networkidle" });
  await pv.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await pv.waitForSelector("[data-qid]");
  return pv;
};
const stateOf = (pv) => pv.evaluate(() => {
  const st = window.__rescriptState;
  return st ? { answers: { ...st.answers }, calculated: { ...st.calculated } } : null;
});
const textOf = (pv, qid) => pv.$eval(`[data-qid="${qid}"]`, (e) => e.textContent.replace(/\s+/g, " ").trim());

{
  const def = baseDef({ references: REFS });
  const pv = await runPreview(def);
  await pv.click('[data-qid="q2"] input[value="1"]');
  await pv.click('[data-qid="q2"] input[value="3"]');
  await pv.click('[data-qid="q2"] input[value="5"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q6"]');

  // iteration 1: Apple
  assert.match(await textOf(pv, "q6"), /satisfied are you with Apple\?/);
  assert.match(await textOf(pv, "q7"), /Product ID: PROD_001 — evaluate APPLE in category Smartphone \(1 of 3\)/);
  ok("§21/§22: the item's label and several references pipe into the block's questions at once");
  assert.ok(await pv.$('[data-qid="q8"]'), "Q8 shows for a Smartphone");

  // Loop Debug panel (§35)
  await pv.click('[data-testid="debug-toggle"]');
  await pv.waitForSelector('[data-testid="loop-debug"]');
  assert.equal(await pv.textContent('[data-testid="loop-iteration"]'), "1 / 3");
  assert.equal(await pv.textContent('[data-testid="loop-item"]'), "Apple");
  const refs = await pv.$$eval('[data-testid="loop-ref"]', (es) => es.map((e) => `${e.getAttribute("data-ref")}=${e.textContent.split("=").pop().trim()}`));
  assert.deepEqual(refs, ["Brand_Nickname=APPLE", "Product_ID=PROD_001", "Client_Code=C001", "Category=Smartphone"]);
  ok("§35: the Loop Debug panel shows loop id, iteration 1/3, the item and every reference");

  await pv.click('[data-qid="q6"] input[value="1"]');
  await pv.fill('[data-qid="q7"] input, [data-qid="q7"] textarea', "apple notes");
  await pv.fill('[data-qid="q8"] input, [data-qid="q8"] textarea', "apple phone");
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q6"]');

  // iteration 2: Google
  assert.match(await textOf(pv, "q6"), /Google\?/);
  assert.match(await textOf(pv, "q7"), /PROD_003 — evaluate GOOGLE .* \(2 of 3\)/);
  assert.equal(await pv.textContent('[data-testid="loop-iteration"]'), "2 / 3");
  const q6Now = await pv.$eval('[data-qid="q6"] input[value="1"]', (e) => e.checked);
  assert.equal(q6Now, false, "the second iteration starts blank — Apple's answer did not leak into Google's");
  ok("§23/§29: the same block runs again for the next item with its own, empty answers");
  await pv.click('[data-qid="q6"] input[value="2"]');
  await pv.fill('[data-qid="q7"] input, [data-qid="q7"] textarea', "google notes");
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q6"]');

  // iteration 3: Xiaomi — an Accessory, so Q8 must be hidden
  assert.match(await textOf(pv, "q7"), /PROD_005 — evaluate XIAOMI in category Accessory \(3 of 3\)/);
  assert.equal(await pv.$('[data-qid="q8"]'), null, "Q8 is hidden for an Accessory");
  ok("§27: display logic on a reference column is evaluated separately for every iteration");
  await pv.click('[data-qid="q6"] input[value="1"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q9"]');

  const st = await stateOf(pv);
  assert.equal(st.answers["q6@1"], "1");
  assert.equal(st.answers["q6@3"], "2");
  assert.equal(st.answers["q6@5"], "1");
  assert.equal(st.answers["q7@1"], "apple notes");
  assert.equal(st.answers["q7@3"], "google notes");
  assert.equal(st.answers["q8@1"], "apple phone");
  assert.equal(st.answers["q8@5"], undefined, "no answer for a question that was hidden in that iteration");
  ok("answers are stored per iteration");

  assert.equal(st.calculated.LOOP_BRAND_COUNT, 3);
  assert.equal(st.calculated.LOOP_BRAND_ITEM_2_CODE, "3");
  assert.equal(st.calculated.LOOP_BRAND_ITEM_2, "Google");
  assert.equal(st.calculated.LOOP_BRAND_ITEM_2_PRODUCT_ID, "PROD_003");
  assert.equal(st.calculated.LOOP_BRAND_ITEM_3_CATEGORY, "Accessory");
  ok("§24: LOOP_001's variables carry count, each item, its code and each reference");
  await pv.close();
}

/* -------------------------------------------------- not selected + count */

console.log("\nRUNTIME — not-selected filter, count and order");
{
  const def = baseDef({
    references: REFS,
    source: { kind: "question", questionId: "q2", filter: "notSelected" },
    count: { mode: "max", value: 1 },
  });
  def.questions.find((q) => q.id === "q8").displayLogic = undefined;
  const pv = await runPreview(def);
  await pv.click('[data-qid="q2"] input[value="1"]');
  await pv.click('[data-qid="q2"] input[value="2"]');
  await pv.click('[data-qid="q2"] input[value="4"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q6"]');
  assert.match(await textOf(pv, "q6"), /Google\?/, "3 of 5 selected; the first not-selected in source order is Google");
  assert.match(await textOf(pv, "q7"), /\(1 of 1\)/, "at most one iteration");
  await pv.click('[data-qid="q6"] input[value="1"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q9"]');
  ok("§10/§13: a not-selected loop capped at one iteration runs once, for the right item");
  await pv.close();
}

/* -------------------------------------------------- nested */

console.log("\nRUNTIME — nested loops (§32)");
{
  const def = {
    meta: { id: "sandbox", code: "SANDBOX", title: "Nested", version: "1.0" },
    questions: [
      { id: "qb", code: "QB", variableName: "QB", type: "multi_select", text: "Brands", options: [{ code: "a", label: "Apple" }, { code: "g", label: "Google" }], settings: {} },
      { id: "qp", code: "QP", variableName: "QP", type: "multi_select", text: "Which {{brand.label}} products?", options: [{ code: "x", label: "Phone" }, { code: "y", label: "Watch" }], settings: {} },
      { id: "qr", code: "QR", variableName: "QR", type: "open_text", text: "Rate the {{brand.label}} {{loop.label}} — region {{brand.Region}}, sku {{loop.Sku}}", settings: {} },
    ],
    flow: [
      { type: "page", id: "p0", questionIds: ["qb"] },
      {
        type: "loop", id: "outer", loopVar: "brand",
        source: { kind: "question", questionId: "qb", filter: "selected" },
        references: { columns: [{ name: "Region" }], values: { a: { Region: "US" }, g: { Region: "EU" } } },
        children: [
          { type: "page", id: "pp", questionIds: ["qp"] },
          {
            type: "loop", id: "inner", loopVar: "product",
            source: { kind: "question", questionId: "qp", filter: "selected" },
            references: { columns: [{ name: "Sku" }], values: { x: { Sku: "SKU-X" }, y: { Sku: "SKU-Y" } } },
            children: [{ type: "page", id: "pr", questionIds: ["qr"] }],
          },
        ],
      },
      { type: "end", id: "e", status: "complete" },
    ],
  };
  const pv = await runPreview(def);
  await pv.click('[data-qid="qb"] input[value="a"]');
  await pv.click('[data-qid="qb"] input[value="g"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="qp"]');
  assert.match(await textOf(pv, "qp"), /Which Apple products\?/);
  await pv.click('[data-qid="qp"] input[value="x"]');
  await pv.click('[data-qid="qp"] input[value="y"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="qr"]');
  assert.match(await textOf(pv, "qr"), /Rate the Apple Phone — region US, sku SKU-X/, "{{brand.x}} is the outer loop, {{loop.x}} the inner");
  await pv.click('[data-testid="debug-toggle"]');
  await pv.waitForSelector('[data-testid="loop-debug"]');
  const blocks = await pv.$$eval('[data-testid="loop-debug"]', (es) => es.map((e) => e.getAttribute("data-loop")));
  assert.deepEqual(blocks, ["product", "brand"], "the debug panel shows the inner loop, then the outer");
  await pv.fill('[data-qid="qr"] input, [data-qid="qr"] textarea', "apple phone");
  await h.next(pv);
  await pv.waitForSelector('[data-qid="qr"]');
  assert.match(await textOf(pv, "qr"), /Apple Watch — region US, sku SKU-Y/);
  await pv.fill('[data-qid="qr"] input, [data-qid="qr"] textarea', "apple watch");
  await h.next(pv);
  await pv.waitForSelector('[data-qid="qp"]');
  assert.match(await textOf(pv, "qp"), /Which Google products\?/);
  const blank = await pv.$eval('[data-qid="qp"] input[value="x"]', (e) => e.checked);
  assert.equal(blank, false, "Google's product question does not carry Apple's selection");
  await pv.click('[data-qid="qp"] input[value="y"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="qr"]');
  assert.match(await textOf(pv, "qr"), /Google Watch — region EU, sku SKU-Y/);
  await pv.fill('[data-qid="qr"] input, [data-qid="qr"] textarea', "google watch");
  await h.next(pv);
  await pv.waitForTimeout(300);
  const st = await stateOf(pv);
  assert.equal(st.answers["qr@a@x"], "apple phone");
  assert.equal(st.answers["qr@a@y"], "apple watch");
  assert.equal(st.answers["qr@g@y"], "google watch", "three answers under three distinct keys — before this, the inner key was qr@y for both brands and Google overwrote Apple");
  assert.equal(st.calculated.LOOP_BRAND_A_LOOP_PRODUCT_COUNT, 2);
  assert.equal(st.calculated.LOOP_BRAND_G_LOOP_PRODUCT_COUNT, 1);
  ok("§32: nested loops keep separate keys, separate namespaces and separate variables for every outer iteration");
  await pv.close();
}

console.log(`\n${pass} passed`);
await h.close();
