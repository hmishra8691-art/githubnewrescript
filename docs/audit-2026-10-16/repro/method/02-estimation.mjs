// Estimator audit: synthetic respondents with KNOWN utilities answer a 4-version CBC and a 4-version MaxDiff;
// the analytics runners must recover the sign/order. Also probes the version lookup in each runner.
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { conjointPlugin, maxdiffPlugin } from "/home/claude/rescript/packages/designs/dist/index.js";
import { mulberry32, designVersionFor, flattenVariables, rowToState } from "/home/claude/rescript/packages/engine/dist/index.js";
import { buildDataset, runAnalysis } from "/home/claude/rescript/packages/analytics/dist/index.js";
import { writeFileSync } from "node:fs";

const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const VERSIONS = Number(process.argv[2] ?? 4);

const attrs = [{ name: "Price", levels: ["$10", "$20", "$30"] }, { name: "Brand", levels: ["Alpha", "Beta"] }, { name: "Warranty", levels: ["1 year", "2 years"] }];
const cbc = conjointPlugin.generate({ attributes: attrs, tasks: 8, alternativesPerTask: 3, noneOption: true, versions: VERSIONS }, 7);
const items = ["Battery", "Camera", "Screen", "Price", "Speed", "Design"];
const md = maxdiffPlugin.generate({ items, itemsPerTask: 4, tasks: 9, versions: VERSIONS }, 7);

const def = SurveyDefinition.parse({
  meta: { id: "syn", code: "SYN", title: "Synthetic", version: "1.0" },
  designs: [
    { id: "d_cbc", kind: "conjoint", name: "CBC", config: { attributes: attrs, alternativesPerTask: 3, noneOption: true, versions: VERSIONS }, file: { format: "json", columns: cbc.columns, rows: cbc.rows } },
    { id: "d_md", kind: "maxdiff", name: "MD", config: { items, itemsPerTask: 4, versions: VERSIONS }, file: { format: "json", columns: md.columns, rows: md.rows } },
  ],
  questions: [
    { id: "q_cbc", code: "Q16", variableName: "CBC", type: "conjoint_task", text: "Choose", settings: { designRef: "d_cbc" } },
    { id: "q_md", code: "Q17", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d_md" } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_cbc", "q_md"] }],
});
const qcbc = def.questions[0], qmd = def.questions[1];

const PRICE_U = { $10: 1.2, $20: 0, $30: -1.2 }, BRAND_U = { Alpha: 0.4, Beta: -0.4 }, WARR_U = { "1 year": -0.2, "2 years": 0.2 };
const MD_U = [1.5, 0.8, 0.2, -0.2, -0.8, -1.5];
const gumbel = (r) => -Math.log(-Math.log(Math.max(r(), 1e-9)));

const rows = [];
const r = mulberry32(11);
const vcount = {};
for (let i = 0; i < 600; i++) {
  const seed = 1000 + i * 7919;
  // the version this respondent is SHOWN, exactly as the renderer derives it
  const vC = designVersionFor(qcbc, cbc.rows, seed), vM = designVersionFor(qmd, md.rows, seed);
  vcount[vC] = (vcount[vC] ?? 0) + 1;
  const cbcAns = {};
  for (const t of new Set(cbc.rows.filter((x) => String(x.version) === vC).map((x) => String(x.task)))) {
    const alts = cbc.rows.filter((x) => String(x.task) === t && String(x.version) === vC).sort((a, b) => Number(a.alt) - Number(b.alt));
    const u = alts.map((a) => (Number(a.none_option) === 1 ? -1.5 : PRICE_U[a.Price] + BRAND_U[a.Brand] + WARR_U[a.Warranty]) + gumbel(r));
    cbcAns[t] = String(alts[u.indexOf(Math.max(...u))].alt);
  }
  const mdAns = {};
  for (const t of new Set(md.rows.filter((x) => String(x.version) === vM).map((x) => String(x.task)))) {
    const alts = md.rows.filter((x) => String(x.task) === t && String(x.version) === vM);
    const u = alts.map((a) => MD_U[Number(a.item_index) - 1] + gumbel(r));
    const bi = u.indexOf(Math.max(...u)); const rest = alts.map((_, k) => k).filter((k) => k !== bi);
    const uw = rest.map((k) => -MD_U[Number(alts[k].item_index) - 1] + gumbel(r));
    mdAns[t] = { best: String(alts[bi].item_index), worst: String(alts[rest[uw.indexOf(Math.max(...uw))]].item_index) };
  }
  rows.push({ id: `r${i}`, session_id: `s${i}`, respondent_code: `LIVE_${i}`, status: "complete", is_test: false, seed, started_at: "2026-06-01T10:00:00Z", completed_at: "2026-06-01T10:10:00Z", answers: { q_cbc: cbcAns, q_md: mdAns }, calculated: {}, embedded: {}, flags: [] });
}
log(`## ${VERSIONS}-version designs; respondents per CBC version:`, JSON.stringify(vcount));
const vars = flattenVariables(def, rowToState(def, rows[0]));
log("flatten writes version columns:", "CBC_VERSION=" + vars.CBC_VERSION, "MD_VERSION=" + vars.MD_VERSION, "| CBC_T1=" + vars.CBC_T1, "MD_T1_BEST=" + vars.MD_T1_BEST, "MD_T1_WORST=" + vars.MD_T1_WORST);

const spec = { environment: "LIVE", dataset: "all" };
const ds = buildDataset(def, rows, { spec });
const D = (kind, variables, extra = {}) => ({ name: kind, kind, dataset: spec, variables, ...extra });

const c = runAnalysis(D("conjoint", ["CBC"]), ds);
const pw = c.tables.find((t) => t.id === "partworths");
log("\n## Conjoint (aggregate MNL) part-worths vs planted:");
for (const row of pw?.rows ?? []) {
  const planted = ({ Price: PRICE_U, Brand: BRAND_U, Warranty: WARR_U })[row.attribute][row.level];
  log(`  ${row.attribute}/${row.level}: est ${row.utility}  planted ${planted}`);
}
const imp = c.tables.find((t) => t.id === "importance");
log("importance order:", (imp?.rows ?? []).map((x) => `${x.attribute} ${x.importance}%`).join(" > "));
log("fit:", JSON.stringify((c.tables.find((t) => t.id === "fit")?.rows ?? []).map((x) => `${x.m}=${x.v}`)));
log("warnings:", JSON.stringify(c.warnings));
const priceOK = ["$10", "$20", "$30"].map((l) => pw.rows.find((x) => x.attribute === "Price" && x.level === l).utility);
log("Price monotone decreasing recovered:", priceOK[0] > priceOK[1] && priceOK[1] > priceOK[2], "| Alpha>Beta:", pw.rows.find((x) => x.level === "Alpha").utility > pw.rows.find((x) => x.level === "Beta").utility, "| 2y>1y:", pw.rows.find((x) => x.level === "2 years").utility > pw.rows.find((x) => x.level === "1 year").utility);

const m = runAnalysis(D("maxdiff", ["MD"]), ds);
const mt = m.tables.find((t) => t.id === "maxdiff");
log("\n## MaxDiff (aggregate MNL best + reversed worst) vs planted order Battery>Camera>Screen>Price>Speed>Design:");
for (const row of mt?.rows ?? []) log(`  rank ${row.rank} ${row.item}: shown ${row.shown} best ${row.best} worst ${row.worst} B-W% ${row.bw} utility ${row.utility} share ${row.share}`);
log("recovered order:", (mt?.rows ?? []).map((x) => x.item).join(" > "));
log("order correct:", (mt?.rows ?? []).map((x) => x.item).join(",") === items.join(","));
log("fit:", JSON.stringify((m.tables.find((t) => t.id === "fit")?.rows ?? []).map((x) => `${x.m}=${x.v}`)));
log("warnings:", JSON.stringify(m.warnings));
const base = mt?.base;
log("base:", JSON.stringify(base));
// expected 'shown' per item if every respondent's tasks were matched: 600 resp * 9 tasks * 4 items / 6 = 3600
const shownSum = (mt?.rows ?? []).reduce((t, x) => t + Number(x.shown), 0);
log("sum(shown) =", shownSum, "(expected 600*9*4 =", 600 * 9 * 4, "if every respondent's tasks are matched to the items they actually saw)");
writeFileSync(`/tmp/audit/method/02-estimation.v${VERSIONS}.out.txt`, out.join("\n"));
