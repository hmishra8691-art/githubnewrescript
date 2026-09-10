/**
 * ADAPTIVE CBC — a respondent goes through the whole exercise in the runtime.
 *
 *   Studio: the ACBC generator and the picker type
 *       ↓
 *   BYO → screens (concepts near the BYO, a possibility / won't work) →
 *   a rule the respondent's own verdicts produced → tournament → winner
 *       ↓
 *   required is honoured stage by stage; the answer is one replayable
 *   transcript; the flattened columns carry the decisions
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

console.log("\nSTUDIO — generator and type");
await h.goTab("Design Generators");
await h.page.waitForSelector('button:has-text("Adaptive CBC (ACBC)")');
await h.page.click('button:has-text("Adaptive CBC (ACBC)")');
await h.page.waitForSelector('text=Screening screens');
assert.ok(await h.page.$('text=Rejections before a level is asked as unacceptable'));
await h.page.click('button:has-text("close")');
const q = await h.createFromPicker("conjoint", "conjoint.acbc");
assert.equal(q.type, "acbc_task");
assert.ok(!(await h.page.$('[data-testid="picker-variant-conjoint.adaptive_cbc_acbc"]')), "the planned placeholder is gone");
console.log("  ok   ACBC design form; conjoint.acbc → acbc_task");

const config = {
  attributes: [
    { name: "Brand", levels: ["Apex", "Nova", "Zen"] },
    { name: "Price", levels: ["$199", "$299", "$399"] },
    { name: "Battery", levels: ["8 h", "12 h", "20 h"] },
  ],
  screeningTasks: 4, conceptsPerScreen: 4, maxAttributesVaried: 2, unacceptableThreshold: 2, mustHaveThreshold: 3, tournamentAlternatives: 3, minTournamentConcepts: 4,
};
const def = {
  meta: { id: "sandbox", code: "ACBC", title: "ACBC", version: "1.0" },
  designs: [{ id: "acbc1", kind: "acbc", name: "Headphones", version: 1, seed: 1, config, file: { format: "json", columns: ["stage", "step", "items", "note"], rows: [] } }],
  questions: [
    { id: "a", code: "A1", variableName: "HP", type: "acbc_task", variant: "conjoint.acbc", text: "Let's find the headphones for you.", required: true, settings: { designRef: "acbc1" } },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Done?", options: [{ code: 1, label: "Yes" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["a"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e1", status: "complete" }],
};
await h.loadDef(def);
const stored = await h.readDef();

console.log("\nRUNTIME — BYO");
const pv = await openPreview(h.browser, RUNTIME, { definition: stored }, { selector: '[data-testid="rs-acbc"]' });
const stage = () => pv.getAttribute('[data-testid="rs-acbc"]', "data-stage");
const ans = () => h.answerOf(pv, "a");
assert.equal(await stage(), "byo");
assert.ok(await pv.$eval('[data-testid="rs-acbc-continue"]', (e) => e.disabled), "Continue waits for every attribute");
// required: Next is refused at this stage, in stage words
await h.next(pv);
await pv.waitForTimeout(150);
assert.match(await pv.evaluate(() => document.body.innerText), /This question is required|build your preferred product/);
await pv.click('[data-attribute="Brand"] input[value="Apex"]');
await pv.click('[data-attribute="Price"] input[value="$199"]');
await pv.click('[data-attribute="Battery"] input[value="20 h"]');
await pv.click('[data-testid="rs-acbc-continue"]');
await pv.waitForSelector('[data-testid="rs-acbc"][data-stage="screen"]');
let a = await ans();
assert.deepEqual(a.byo, { Brand: "Apex", Price: "$199", Battery: "20 h" });
assert.equal(a.screens.length, 1);
assert.equal(a.screens[0].concepts.length, 4);
console.log("  ok   BYO stored; first screen of 4 near concepts");

console.log("\nRUNTIME — screening with a consistent respondent (only $199 will do) → an unacceptable price is asked");
const profileOf = async (card) => {
  const rows = await card.$$eval("tr", (trs) => trs.map((tr) => [tr.querySelector("th").textContent, tr.querySelector("td").textContent]));
  return Object.fromEntries(rows);
};
let ruleSeen = null;
for (let guard = 0; guard < 12; guard++) {
  const st = await stage();
  if (st === "screen") {
    await h.next(pv); // required mid-exercise: refused with the screen wording
    await pv.waitForTimeout(100);
    assert.match(await pv.evaluate(() => document.body.innerText), /could work for you/);
    const cards = await pv.$$('[data-testid="rs-acbc-concept"]');
    for (const card of cards) {
      const prof = await profileOf(card);
      assert.ok(prof.Brand !== "Apex" || prof.Price !== "$199" || prof.Battery !== "20 h", "a concept is never the BYO itself");
      await (await card.$(prof.Price !== "$199" ? '[data-testid="rs-acbc-no"]' : '[data-testid="rs-acbc-yes"]')).click();
    }
    await pv.click('[data-testid="rs-acbc-continue"]');
    await pv.waitForTimeout(150);
  } else if (st === "rule") {
    const text = await pv.textContent('[data-testid="rs-acbc-rule"]');
    if (/Price: \$[23]99/.test(text) && /never/.test(text)) { ruleSeen = text; await pv.click('[data-testid="rs-acbc-rule-yes"]'); }
    else await pv.click('[data-testid="rs-acbc-rule-no"]');
    await pv.waitForTimeout(150);
  } else break;
}
assert.equal(await stage(), "tournament", "screens done → tournament");
a = await ans();
assert.ok(a.screens.length >= 2 && a.screens.length <= 4, `screens: ${a.screens.length} — fewer than 4 when the banned prices leave no new legal concept`);
assert.ok(ruleSeen, "with 16 concepts and a threshold of 2, a rejected price was put to the respondent");
const confirmed = a.unacceptable.filter((r) => r.confirmed);
assert.ok(confirmed.length >= 1 && confirmed.every((r) => r.attribute === "Price" && r.level !== "$199"), "the confirmed unacceptable(s) are prices other than $199");
// once a price is banned, only $199 concepts remain legal (3 brands × 3 batteries − the BYO): later screens
// may be SHORTER than 4 rather than repeat or break a rule — that is the generator degrading honestly
for (const s of a.screens.slice(-1)) for (const c of s.concepts) assert.ok(!confirmed.some((r) => c.profile[r.attribute] === r.level) || a.unacceptable.length === 0, "the last screen carries no confirmed-unacceptable level");
assert.equal(a.tournament.length >= 1, true);
console.log(`  ok   unacceptable asked ("${ruleSeen.trim().slice(0, 60)}…") and confirmed: ${confirmed.map((r) => r.level).join(", ")}`);
assert.ok(a.remaining.includes("byo"), "the BYO competes");

console.log("\nRUNTIME — tournament to a winner; then Next");
let rounds = 0;
while ((await stage()) === "tournament" && rounds < 30) {
  await h.next(pv);
  await pv.waitForTimeout(80);
  assert.match(await pv.evaluate(() => document.body.innerText), /finish choosing/);
  const cards = await pv.$$('[data-testid="rs-acbc-concept"]');
  assert.ok(cards.length >= 2 && cards.length <= 3);
  // pick the cheapest
  let best = null, bestPrice = Infinity;
  for (const card of cards) {
    const prof = await profileOf(card);
    const v = Number(prof.Price.replace(/[^0-9]/g, ""));
    if (v < bestPrice) { bestPrice = v; best = card; }
  }
  await (await best.$('[data-testid="rs-acbc-choose"]')).click();
  await pv.waitForTimeout(120);
  rounds++;
}
assert.equal(await stage(), "done");
a = await ans();
assert.ok(a.winner, "a winner");
assert.equal(a.winner.profile.Price, "$199", "cheapest-picker's winner is $199");
assert.equal(a.tournament.filter((r) => r.chosen).length, rounds);
assert.ok(await pv.$('[data-testid="rs-acbc-winner"]'));
await h.next(pv);
await pv.waitForSelector('[data-qid="q2"]');
console.log(`  ok   ${rounds} rounds → winner ${JSON.stringify(a.winner.profile)}; page turned`);

console.log("\nEXPORT — the decisions, flattened");
const { flattenVariables, createResponseState, setAnswer, buildVariableDictionary } = await import("../packages/engine/dist/index.js");
const { SurveyDefinition } = await import("../packages/schema/dist/index.js");
const parsed = SurveyDefinition.parse(stored);
const names = buildVariableDictionary(parsed).filter((v) => v.questionId === "a").map((v) => v.name);
assert.deepEqual(names, ["HP_BYO_Brand", "HP_BYO_Price", "HP_BYO_Battery", "HP_WINNER_Brand", "HP_WINNER_Price", "HP_WINNER_Battery", "HP_UNACCEPTABLE", "HP_MUSTHAVE", "HP_SCREENED", "HP_ACCEPTED", "HP_ROUNDS", "HP_JSON"]);
const state = createResponseState(parsed, { seed: 1 });
setAnswer(parsed, state, "a", a);
const cols = flattenVariables(parsed, state);
assert.equal(cols.HP_BYO_Brand, "Apex");
assert.equal(cols.HP_WINNER_Price, "$199");
const screened = a.screens.reduce((n, s) => n + s.concepts.length, 0);
assert.ok(screened <= 16 && screened >= 10, `screened ${screened}: shorter screens once a price is banned`);
assert.equal(cols.HP_SCREENED, screened);
assert.equal(cols.HP_ROUNDS, rounds);
assert.equal(JSON.parse(cols.HP_JSON).stage, "done", "the transcript round-trips");
assert.match(cols.HP_UNACCEPTABLE, /Price=\$[23]99/);
console.log(`  ok   BYO Apex/$199/20 h; screened ${screened}, accepted ${cols.HP_ACCEPTED}; rules "${cols.HP_UNACCEPTABLE}"`);
await pv.close();

await h.close();
console.log("\nALL ACBC CHECKS PASSED");
