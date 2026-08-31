/**
 * End-to-end smoke test: runs a scripted respondent through the demo survey
 * exactly as the runtime does (same engine calls), verifies logic, piping,
 * carry-forward, composite variables, calculations, quotas, scripts and the
 * Excel/JSON/CSV exporters — all against the real definition.
 */
import assert from "node:assert/strict";
import { buildDemoDefinition } from "./demo-survey.mjs";
import {
  createResponseState, start, advance, setAnswer, visibleQuestions,
  validatePage, effectiveQuestion, resolvePiping, flattenVariables,
  buildVariableDictionary, lintVariables, runScripts, inspect, compileFlow,
} from "../packages/engine/dist/index.js";
import { exportVariableDictionaryXlsx, exportSurveyJson, importSurveyJson, responsesToCSV } from "../packages/exporters/dist/index.js";

const def = buildDemoDefinition("00000000-0000-0000-0000-000000000001");
console.log("✔ definition parses;", def.questions.length, "questions,", def.flow.length, "flow roots");

// lint
const lint = lintVariables(def);
assert.deepEqual(lint, [], `variable lint: ${lint}`);
console.log("✔ no duplicate variables");

// ---- respondent A: full happy path
const state = createResponseState(def, { seed: 20260831, embedded: { SOURCE: "email-blast" } });
let nav = start(def, state);
const page = () => nav.steps[nav.stepIndex];
assert.equal(page().pageId, "p_consent");

const answerAndNext = (answers) => {
  for (const [qid, v] of Object.entries(answers)) setAnswer(def, state, qid, v);
  const vis = visibleQuestions(def, page(), state);
  const errs = validatePage(def, vis, { def, state, loop: page().loop });
  assert.deepEqual(errs, [], `validation errors on ${page().pageId}: ${JSON.stringify(errs)}`);
  runScripts(def, state, "on_submit", { scopeRef: page().pageId });
  nav = advance(def, state, {});
};

answerAndNext({ q_consent: 1 });
assert.equal(page().pageId, "p_demo");
answerAndNext({ q_age: 34, q_gender: 2 });
assert.equal(page().pageId, "p_brands", "quota check should pass with zero counts");

answerAndNext({ q_brands: [1, 2] }); // Apple + Samsung
assert.equal(page().pageId, "p_fav");

// carry-forward check
const qFav = def.questions.find((q) => q.id === "q_fav");
const favView = effectiveQuestion(qFav, { def, state });
assert.deepEqual(favView.options.map((o) => o.label).sort(), ["Apple", "Samsung"]);
console.log("✔ carry-forward: favorite shows only selected brands");

// piping check
const favText = resolvePiping(qFav.text, { def, state });
assert.ok(favText.includes("Apple") && favText.includes("Samsung"), favText);

answerAndNext({ q_fav: 1, q_why: "Great ecosystem" });
assert.equal(page().pageId, "p_grid");

// composite rows carried from selection
const qGrid = def.questions.find((q) => q.id === "q_grid");
const gridView = effectiveQuestion(qGrid, { def, state });
assert.deepEqual(gridView.rows.map((r) => r.label), ["Apple", "Samsung"]);
assert.equal(gridView.columns.length, 4);
console.log("✔ composite: dynamic rows × 4 typed columns");

answerAndNext({
  q_grid: {
    "1": { c_owned: 1, c_rating: 9, c_channel: 1, c_comment: "daily driver" },
    "2": { c_owned: 0, c_rating: 7, c_channel: 3, c_comment: "" },
  },
});
assert.equal(page().pageId, "p_nps");
answerAndNext({ q_nps: 10 });
assert.equal(page().pageId, "p_budget");
answerAndNext({ q_budget: { battery: 30, camera: 65, price: 5, design: 0 } });
assert.equal(page().pageId, "p_maxdiff");
answerAndNext({
  q_maxdiff: { "1": { best: "0", worst: "2" }, "2": { best: "1", worst: "3" }, "3": { best: "0", worst: "4" }, "4": { best: "5", worst: "2" }, "5": { best: "1", worst: "0" } },
});
assert.equal(nav.done, true);
assert.equal(nav.endStatus, "complete");

// calculations + flat variables
const flat = flattenVariables(def, state);
assert.equal(state.calculated.N_BRANDS, 2);
assert.equal(state.calculated.ENGAGEMENT, 80); // avg(9,7)*10
assert.equal(flat.RATING_1, 9);
assert.equal(flat.CHANNEL_2, 3);
assert.equal(flat.BRANDS_1, 1);
assert.equal(flat.BRANDS_3, 0);
assert.equal(flat.BUDGET_total, 100);
assert.equal(state.answers.q_hidden_seg, "promoter");
assert.ok(state.flags.includes("camera_lover"), `flags: ${state.flags}`);
console.log("✔ calculations, hidden calculated question, custom script flag");

// end message piping
const endStep = nav.steps[nav.stepIndex];
const endMsg = resolvePiping(endStep.message ?? "", { def, state });
assert.ok(endMsg.includes("Apple") && endMsg.includes("80"), endMsg);
console.log("✔ end message piping:", JSON.stringify(endMsg));

// inspector snapshot
const snap = inspect(def, state, nav.steps, {});
assert.equal(snap.status, "complete");
assert.ok(Object.keys(snap.flatVariables).length > 20);
console.log("✔ inspector snapshot:", Object.keys(snap.flatVariables).length, "flat variables");

// ---- respondent B: screened by age branch
const s2 = createResponseState(def, { seed: 2 });
let nav2 = start(def, s2);
setAnswer(def, s2, "q_consent", 1);
nav2 = advance(def, s2, {});
setAnswer(def, s2, "q_age", 17);
setAnswer(def, s2, "q_gender", 1);
nav2 = advance(def, s2, {});
assert.equal(nav2.done, true);
assert.equal(nav2.endStatus, "screened");
console.log("✔ branch: under-18 screened");

// ---- respondent C: no consent -> skip logic terminates
const s3 = createResponseState(def, { seed: 3 });
let nav3 = start(def, s3);
setAnswer(def, s3, "q_consent", 2);
nav3 = advance(def, s3, {});
assert.equal(nav3.endStatus, "screened");
console.log("✔ skip logic: no consent screened");

// ---- respondent D: quota full for females
const s4 = createResponseState(def, { seed: 4 });
let nav4 = start(def, s4);
setAnswer(def, s4, "q_consent", 1);
nav4 = advance(def, s4, {});
setAnswer(def, s4, "q_age", 30);
setAnswer(def, s4, "q_gender", 2);
nav4 = advance(def, s4, { quota_gender: { cell_female: 100 } }); // 50% of 200 = 100 -> full
assert.equal(nav4.endStatus, "quota_full");
console.log("✔ quota: female cell full terminates");

// ---- variable dictionary + exporters
const dict = buildVariableDictionary(def);
const names = dict.map((d) => d.name);
for (const expected of ["CONSENT", "AGE", "GENDER", "BRANDS_1", "FAV_BRAND", "OWNED_1", "RATING_2", "CHANNEL_1", "COMMENT_2", "NPS", "BUDGET_camera", "BUDGET_total", "N_BRANDS", "ENGAGEMENT", "SEGMENT", "SOURCE"]) {
  assert.ok(names.includes(expected), `dictionary missing ${expected}`);
}
console.log("✔ variable dictionary:", dict.length, "variables");

const xlsx = await exportVariableDictionaryXlsx(def);
assert.ok(xlsx.length > 5000 && xlsx[0] === 0x50 && xlsx[1] === 0x4b);
console.log("✔ xlsx export:", xlsx.length, "bytes");

const json = exportSurveyJson(def);
const roundTrip = importSurveyJson(json);
assert.equal(roundTrip.questions.length, def.questions.length);
console.log("✔ JSON round-trip");

const csv = responsesToCSV(def, [state]);
const lines = csv.trim().split("\n");
assert.equal(lines.length, 2);
assert.ok(lines[0].includes("RATING_1") && lines[0].includes("BUDGET_camera"));
console.log("✔ responses CSV:", lines[0].split(",").length, "columns");

console.log("\nALL E2E SMOKE CHECKS PASSED");
