/**
 * CROSS-FEATURE CHAIN — one survey, every new capability, one respondent.
 *
 *   geo pin (home) + geo pin (store) → distance_km() as a calculated variable
 *       → display logic on the next page reads it
 *   long_text with a fixed-wording probe → the probe's answer
 *   ai_classify() on the open end → display logic reads the category
 *   menu-based conjoint task
 *   conversational presentation over the whole thing, voice dictation on
 *       → the flattened export carries every column the dictionary declared
 *
 * The point: these are not five features; they are one engine. A value
 * produced by any of them is a variable, and every consumer — logic,
 * calculations, piping, export — reads it the same way.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { menuPlugin } from "../packages/designs/dist/menu.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

const menuCfg = { items: [{ name: "Delivery", levels: ["$3", "$5"] }, { name: "Gift wrap", levels: ["$1", "$2"] }], tasks: 2, versions: 1, noneOption: true, currency: "$" };
const menu = menuPlugin.generate(menuCfg, 5);

const def = {
  meta: { id: "sandbox", code: "CHAIN", title: "Chain", version: "1.0" },
  branding: { layout: { presentation: "conversational", voice: { readAloud: false, dictation: true } } },
  designs: [{ id: "menu1", kind: "menu", name: "Extras", version: 1, seed: 5, config: menuCfg, file: { format: "json", columns: menu.columns, rows: menu.rows } }],
  questions: [
    { id: "home", code: "HOME", variableName: "HOME", type: "geo", variant: "location.pin", text: "Where do you live?", required: true, settings: { geoMode: "pin", mapCenter: { lat: 51.5, lng: -0.12 }, mapZoom: 10 } },
    { id: "store", code: "STORE", variableName: "STORE", type: "geo", variant: "location.pin", text: "Where is the store you use most?", required: true, settings: { geoMode: "pin", mapCenter: { lat: 51.5, lng: -0.12 }, mapZoom: 10 } },
    { id: "dist", code: "DIST", variableName: "DIST_KM", type: "calculated", text: "", settings: { expression: "distance_km(HOME, STORE)" } },
    { id: "far", code: "FAR", variableName: "FAR", type: "single_select", text: "Your store is {{DIST_KM}} km away. Is that too far?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
      displayLogic: { type: "rule", source: { kind: "question", ref: "DIST_KM" }, operator: "gt", value: 5 } },
    { id: "why", code: "WHY", variableName: "WHY", type: "long_text", text: "What would make you shop there more often?",
      probe: { maxProbes: 1, minWords: 0, required: false, prompt: "You said “{answer}” — what one change would matter most?" } },
    { id: "cat", code: "WHY_CAT", variableName: "WHY_CAT", type: "calculated", text: "", settings: { expression: 'ai_classify(WHY, "Price|Range|Service|Other")' } },
    { id: "price", code: "PRICE", variableName: "PRICE", type: "single_select", text: "You mentioned price. Which matters more?", options: [{ code: 1, label: "Everyday prices" }, { code: 2, label: "Promotions" }],
      displayLogic: { type: "rule", source: { kind: "question", ref: "WHY_CAT" }, operator: "eq", value: "Price" } },
    { id: "extras", code: "EXTRAS", variableName: "EXTRAS", type: "conjoint_task", variant: "conjoint.menu", text: "Which extras would you pay for?", required: true, settings: { designRef: "menu1" } },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["home", "store"] },
    { type: "page", id: "p2", questionIds: ["far", "why"] },
    { type: "page", id: "p3", questionIds: ["price", "extras"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};
await h.loadDef(def);
const stored = await h.readDef();

console.log("\nPAGE 1 — two pins → distance_km → the next page's logic");
const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
await pv.addInitScript(() => { window.SpeechRecognition = function () { this.start = () => {}; this.stop = () => {}; this.abort = () => {}; }; delete window.webkitSpeechRecognition; });
await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(pv, { definition: stored }, { selector: '[data-qid="home"]' });
const qids = () => pv.$$eval("#rs-questions [data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")));
assert.deepEqual(await qids(), ["home"], "conversational: one question at a time");
const clickMap = async (qid, dx) => {
  const map = `[data-qid="${qid}"] [data-testid="rs-map"]`;
  await (await pv.$(map)).scrollIntoViewIfNeeded();
  const box = await (await pv.$(map)).boundingBox();
  await pv.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2);
  await pv.waitForSelector(`[data-qid="${qid}"] [data-testid="rs-map-pin"]`);
};
await clickMap("home", 0);
await h.next(pv);
await pv.waitForSelector('[data-qid="store"]');
await clickMap("store", 100); // ≈ 9.5 km east at z10
await h.next(pv);
await pv.waitForSelector('[data-qid="far"]');
const dist = await h.answerOf(pv, "dist");
assert.ok(dist > 8 && dist < 11, `distance_km = ${dist}`);
assert.match(await pv.textContent('[data-qid="far"]'), new RegExp(`is ${dist} km away`), "the calculated variable pipes into the question that its logic just showed");
console.log(`  ok   DIST_KM = ${dist}; FAR shown (> 5 km) with the value piped`);

console.log("\nPAGE 2 — the open end (dictation on), its probe, then AI classification gates page 3");
await pv.click('[data-qid="far"] input[value="1"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="why"]');
assert.ok(await pv.$('[data-qid="why"] [data-testid="speech-input"]'), "voice.dictation put a microphone on the open end");
await pv.fill('[data-qid="why"] textarea', "Lower prices, everything is too expensive there.");
await h.next(pv); // last question of the page → the page's Next → probe due
await pv.waitForSelector('[data-testid="rs-probe"]');
assert.match(await pv.evaluate(() => document.body.innerText), /You said “Lower prices, everything is too expensive there\.” — what one change would matter most\?/);
await pv.fill('[data-testid="rs-probe"] textarea', "Match the supermarket on staples.");
await h.next(pv);
await pv.waitForSelector('[data-qid="price"]');
assert.equal(await h.answerOf(pv, "cat"), "Price", "ai_classify resolved before the page turned…");
assert.deepEqual(await qids(), ["price"], "…so PRICE's display logic held and it is the first question of page 3");
assert.equal(await h.answerOf(pv, "why__probe_1"), "Match the supermarket on staples.");
const turns = await pv.$$eval('[data-testid="rs-convo-turn"]', (els) => els.map((e) => e.getAttribute("data-qid")));
assert.deepEqual(turns, ["home", "store", "far", "why"], "the transcript spans pages; calculated questions are not shown as turns");
console.log("  ok   probe asked from the answer; WHY_CAT = Price; PRICE shown; transcript intact");

console.log("\nPAGE 3 — menu conjoint, then complete");
await pv.click('[data-qid="price"] input[value="1"]');
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-menu-tasks"]');
for (const t of ["1", "2"]) await pv.click(`[data-testid="rs-menu-task"][data-task="${t}"] [data-item="1"]`);
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-ended"]');
console.log("  ok   completed");

console.log("\nEXPORT — every column the dictionary declared, filled from one respondent's answers");
const answers = await pv.evaluate(() => window.__rescriptState.answers);
const { flattenVariables, createResponseState, setAnswer, buildVariableDictionary, runCalculations } = await import("../packages/engine/dist/index.js");
const { SurveyDefinition } = await import("../packages/schema/dist/index.js");
const parsed = SurveyDefinition.parse(stored);
const state = createResponseState(parsed, { seed: 1 });
for (const [k, v] of Object.entries(answers)) state.answers[k] = v;
runCalculations(parsed, state, "on_complete");
const flat = flattenVariables(parsed, state);
const declared = buildVariableDictionary(parsed).map((v) => v.name);
for (const n of ["HOME", "HOME_LAT", "STORE_LNG", "DIST_KM", "FAR", "WHY", "WHY_PROBE_1", "WHY_PROBE_1_Q", "WHY_CAT", "PRICE", "EXTRAS_T1_1", "EXTRAS_T1_TOTAL", "EXTRAS_T2_NONE"]) {
  assert.ok(declared.includes(n), `${n} declared`);
}
assert.equal(flat.DIST_KM, dist);
assert.equal(flat.WHY_CAT, "Price", "the AI variable survived the on_complete recomputation");
assert.equal(flat.WHY_PROBE_1, "Match the supermarket on staples.");
assert.match(flat.WHY_PROBE_1_Q, /what one change would matter most/);
assert.equal(flat.FAR, 1);
assert.equal(flat.PRICE, 1);
assert.equal(flat.EXTRAS_T1_1, 1);
assert.equal(flat.EXTRAS_T1_2, 0);
assert.equal(flat.EXTRAS_T1_TOTAL, menu.rows.find((r) => r.task === 1 && r.item === 1).price_value);
assert.match(String(flat.HOME), /^51\.\d+,-0\.\d+$/);
console.log("  ok   geo, calc, logic, probe, AI, menu — one export");
await pv.close();

await h.close();
console.log("\nALL CHAIN CHECKS PASSED");
