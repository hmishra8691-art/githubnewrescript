// Conjoint audit 2026-10-17: synthetic recovery through the platform's own path
// (design → stored answers {task: design alt} → buildDataset → runAnalysis("conjoint")), plus an
// example of the stacked choice export. usage: node docs/conjoint-audit-2026-10-17/recovery.mjs
import { SurveyDefinition } from "../../packages/schema/dist/index.js";
import { conjointPlugin } from "../../packages/designs/dist/index.js";
import { mulberry32, designVersionFor } from "../../packages/engine/dist/index.js";
import { buildDataset, runAnalysis } from "../../packages/analytics/dist/index.js";
import { choiceDataToCSV } from "../../packages/exporters/dist/index.js";

const TRUE = { Brand: { Alpha: 0.5, Beta: 0, Gamma: -0.5 }, Screen: { "5in": -0.3, "6in": 0.1, "7in": 0.2 }, Battery: { "1 day": -0.6, "2 days": 0.1, "3 days": 0.5 }, Price: { "$199": 1.0, "$299": 0.1, "$399": -1.1 } };
const NONE_U = -0.8;
const attributes = Object.entries(TRUE).map(([name, l]) => ({ name, levels: Object.keys(l) }));
const config = { attributes, tasks: 12, alternativesPerTask: 3, noneOption: true, versions: 6, method: "efficient" };
const design = conjointPlugin.generate(config, 2026);
const def = SurveyDefinition.parse({
  meta: { id: "rec", code: "REC", title: "Recovery", version: "1.0" },
  designs: [{ id: "d", kind: "conjoint", name: "CBC", version: 1, config, file: { format: "json", columns: design.columns, rows: design.rows } }],
  questions: [{ id: "q_cbc", code: "Q1", variableName: "CBC", type: "conjoint_task", text: "Choose", settings: { designRef: "d" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q_cbc"] }, { type: "end", id: "e1", status: "complete" }],
});
const u = (row) => (Number(row.none_option) === 1 ? NONE_U : attributes.reduce((t, a) => t + TRUE[a.name][row[a.name]], 0));
const r = mulberry32(99), g = () => -Math.log(-Math.log(Math.max(r(), 1e-12)));
const rows = [];
for (let i = 0; i < 900; i++) {
  const seed = Math.floor(r() * 2 ** 31), version = designVersionFor(def.questions[0], design.rows, seed), answers = {};
  for (let t = 1; t <= 12; t++) { const alts = design.rows.filter((x) => String(x.version) === version && x.task === t); const v = alts.map((a) => u(a) + g()); answers[t] = String(alts[v.indexOf(Math.max(...v))].alt); }
  rows.push({ id: `r${i}`, session_id: `s${i}`, respondent_code: `R${i}`, seed, status: "complete", is_test: false, started_at: "2026-10-01T10:00:00Z", answers: { q_cbc: answers }, calculated: {}, embedded: {}, flags: [] });
}
const ds = buildDataset(def, rows, { spec: { environment: "LIVE", dataset: "all" } });
const res = runAnalysis({ name: "c", kind: "conjoint", dataset: { environment: "LIVE", dataset: "all" }, variables: ["CBC"] }, ds);
const pw = res.tables.find((t) => t.id === "partworths");
console.log("| Attribute | Level | Planted (zero-centred) | Estimated | SE |\n|---|---|---|---|---|");
for (const [a, l] of Object.entries(TRUE)) { const m = Object.values(l).reduce((t, v) => t + v, 0) / 3; for (const [lv, v] of Object.entries(l)) { const e = pw.rows.find((x) => x.attribute === a && x.level === lv); console.log(`| ${a} | ${lv} | ${(v - m).toFixed(3)} | ${e.utility} | ${e.se ?? ""} |`); } }
const imp = res.tables.find((t) => t.id === "importance");
const ranges = Object.fromEntries(Object.entries(TRUE).map(([a, l]) => [a, Math.max(...Object.values(l)) - Math.min(...Object.values(l))])); const tot = Object.values(ranges).reduce((t, v) => t + v, 0);
console.log("\n| Attribute | Planted importance % | Estimated % |\n|---|---|---|");
for (const x of imp.rows) console.log(`| ${x.attribute} | ${(100 * ranges[x.attribute] / tot).toFixed(1)} | ${x.importance} |`);
const sim = res.tables.find((t) => t.id === "simulation");
console.log("\nsimulation:", JSON.stringify(sim.rows.map((x) => [x.profile, x.utility, x.share])));
console.log("fit:", JSON.stringify(res.tables.find((t) => t.id === "fit").rows.map((x) => `${x.m}=${x.v}`)));
console.log("planted None constant vs zero-centred attributes:", (NONE_U - attributes.reduce((t, a) => t + Object.values(TRUE[a.name]).reduce((s, v) => s + v, 0) / 3, 0)).toFixed(3));
const ex = choiceDataToCSV(def, rows.slice(0, 1).map((x) => ({ sessionId: x.session_id, respondentId: x.respondent_code, seed: x.seed, answers: x.answers })));
console.log("\nexample stacked export (respondent R0, first two tasks):\n" + ex.csv.split("\n").slice(0, 9).join("\n"));
