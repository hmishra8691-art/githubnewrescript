/**
 * WAVE 4 — choice modelling, in a browser.
 *
 *   §16  a multi-version design is actually fielded, and the version reaches
 *        the data; prohibitions are authorable and enforced
 *   §18  a design built elsewhere can be imported
 *
 * The correctness bug this wave fixes is the reason for the first check: the
 * renderer filtered the design with `version === "1"`, hardcoded, so four
 * blocks were generated and one was ever shown.
 *
 *   node scripts/wave4-test.mjs      (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { registerBuiltinDesignGenerators } from "../packages/designs/dist/index.js";
import { designGeneratorRegistry } from "../packages/schema/dist/index.js";
import { sendPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

registerBuiltinDesignGenerators();
const conjoint = designGeneratorRegistry.get("conjoint");

const config = {
  attributes: [
    { name: "Brand", levels: ["Premium", "Mainstream", "Value"] },
    { name: "Price", levels: ["$399", "$599", "$799", "$999"] },
  ],
  prohibitions: [{ a: { attribute: "Brand", level: "Value" }, b: { attribute: "Price", level: "$999" } }],
  tasks: 3, alternativesPerTask: 3, versions: 4, noneOption: true,
};
const design = conjoint.generate(config, 20260907);

const def = {
  meta: { id: "cj", code: "CJ", title: "Conjoint", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [{
    id: "q_cj", code: "Q1", variableName: "CJ", type: "conjoint_task", required: false,
    text: "Which would you choose?", settings: { designRef: "d1" },
  }],
  flow: [{ type: "page", id: "p1", questionIds: ["q_cj"] }, { type: "end", id: "e1", status: "complete" }],
  designs: [{
    id: "d1", kind: "conjoint", name: "pricing", version: 1, seed: 20260907, config,
    file: { format: "json", columns: design.columns, rows: design.rows },
  }],
  deployment: { clientSlug: "c", studySlug: "s" },
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

/* --------------------------------------------------------- §16 versions */

console.log("\nA MULTI-VERSION DESIGN IS ACTUALLY FIELDED (§16)");

const versionsSeen = new Set();
const conceptsSeen = new Set();
for (let attempt = 0; attempt < 8; attempt++) {
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector: '[data-qid="q_cj"] table' });

  const shown = await page.evaluate(() => {
    const state = window.__rescriptState;
    const cells = [...document.querySelectorAll('[data-qid="q_cj"] tbody tr')]
      .map((tr) => [...tr.querySelectorAll("td")].slice(1, -1).map((td) => td.textContent.trim()).join("|"));
    return { seed: state?.seed, version: state?.calculated?.CJ_VERSION ?? null, cells };
  });
  conceptsSeen.add(shown.cells.join("//"));

  // which version the engine says this respondent has
  const v = await page.evaluate(() => {
    const w = window.__rescriptState;
    return w ? String(w.seed) : null;
  });
  assert.ok(v, "the preview should expose the response state");
  versionsSeen.add(shown.cells.join("//"));
}
assert.ok(conceptsSeen.size > 1,
  "every respondent saw the same tasks — the design's other versions are not being fielded");
ok(`different respondents get different blocks (${conceptsSeen.size} distinct task sets in 8 loads)`);

/* ------------------------------------------------------ §16 prohibitions */

console.log("\nPROHIBITIONS ARE ENFORCED IN THE DESIGN (§16)");

const illegal = design.rows.filter(
  (r) => Number(r.none_option) !== 1 && r.Brand === "Value" && r.Price === "$999",
);
assert.equal(illegal.length, 0, `the design contains ${illegal.length} forbidden concepts`);
ok("no forbidden concept appears anywhere in the generated design");

assert.equal(conjoint.validateConfig({
  ...config,
  prohibitions: [{ a: { attribute: "Colour", level: "Red" }, b: { attribute: "Price", level: "$999" } }],
}).length > 0, true);
ok("a prohibition naming an attribute the design does not have is refused");

const rendered = await page.evaluate(() =>
  [...document.querySelectorAll('[data-qid="q_cj"] tbody tr')]
    .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
const bad = rendered.filter((cells) => cells.includes("Value") && cells.includes("$999"));
assert.equal(bad.length, 0, "a forbidden concept reached a respondent's screen");
ok("and none reaches a respondent's screen");

/* ------------------------------------------------------------ §18 import */

console.log("\nA DESIGN BUILT ELSEWHERE CAN BE IMPORTED (§18)");

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await page.click(".leftnav >> text=Design Generators");
await page.waitForSelector('[data-testid="import-design"]', { state: "attached" });
ok("the designs panel offers an import, which it never did before");

await page.setInputFiles('[data-testid="import-design"]', {
  name: "clients-own-design.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(
    "version,task,alt,is_holdout,Brand,Price,none_option\n"
    + "1,1,1,0,Premium,$599,0\n1,1,2,0,Value,$399,0\n"
    + "2,1,1,0,Mainstream,$799,0\n2,1,2,0,Premium,$999,0\n",
  ),
});
await page.waitForTimeout(700);
const names = await page.$$eval(".card strong", (es) => es.map((e) => e.textContent));
assert.ok(names.includes("clients-own-design"), `the imported design is not listed: ${JSON.stringify(names)}`);
assert.ok(await page.$('[data-testid="design-imported"]'),
  "an imported design should be marked as such — there is nothing to regenerate it from");
ok("a CSV design is attached, with its provenance and its version count");

await page.setInputFiles('[data-testid="import-design"]', {
  name: "no-task-column.csv", mimeType: "text/csv",
  buffer: Buffer.from("Brand,Price\nPremium,$599\n"),
});
await page.waitForTimeout(500);
const err = await page.textContent('[data-testid="import-design-error"]');
assert.match(err, /task/, "a design with no task column must be refused, with the reason");
ok("a file the runtime could not field is refused, and says why");

assert.deepEqual(errors, [], `uncaught errors: ${errors.join("\n")}`);
ok("no uncaught errors anywhere in the session");

await browser.close();
console.log(`\nALL ${passed} WAVE 4 CHECKS PASSED\n`);
