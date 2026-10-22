/**
 * The inputs and outputs the conjoint-suite backward-compatibility snapshots
 * cover (see make-snapshots.mjs). Imported by the snapshot writer AND by
 * packages/analytics/src/conjoint/compat.test.ts, so the test recomputes
 * exactly what was snapshotted, with the current build.
 *
 * Only pre-existing configurations appear here: CBC (balanced, efficient,
 * None, holdouts, pair + combination prohibitions, versions), MaxDiff, menu,
 * ACBC — no option the suite added.
 */
import { SurveyDefinition } from "../../packages/schema/dist/index.js";
import { conjointPlugin, maxdiffPlugin, menuPlugin, acbcPlugin } from "../../packages/designs/dist/index.js";
import { mulberry32, designVersionFor, flattenVariables, buildVariableDictionary, stackedChoiceData } from "../../packages/engine/dist/index.js";
import { buildDataset, runAnalysis } from "../../packages/analytics/dist/index.js";

/** FNV-1a over a JSON string — a compact, order-sensitive fingerprint */
export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const strip = (r) => { const { computedAt, provenance, definitionHash, advice, ...rest } = r; return rest; };

export const ATTRS = [
  { name: "Brand", levels: ["Alpha", "Beta", "Gamma"] },
  { name: "Screen", levels: ["5in", "6in", "7in"] },
  { name: "Battery", levels: ["1 day", "2 days", "3 days"] },
  { name: "Price", levels: ["$199", "$299", "$399"] },
];
export const DESIGN_CASES = {
  cbc_balanced: ["conjoint", { attributes: ATTRS, tasks: 10, alternativesPerTask: 3, versions: 4 }, 11],
  cbc_efficient_none: ["conjoint", { attributes: ATTRS, tasks: 12, alternativesPerTask: 3, noneOption: true, versions: 6, method: "efficient" }, 2026],
  cbc_holdout_prohibit: ["conjoint", { attributes: ATTRS, tasks: 10, alternativesPerTask: 3, holdoutTasks: 2, versions: 3, method: "efficient", prohibitions: [{ a: { attribute: "Brand", level: "Gamma" }, b: { attribute: "Price", level: "$399" } }, { a: { attribute: "Brand", level: "Alpha" }, b: { attribute: "Screen", level: "5in" }, also: [{ attribute: "Battery", level: "1 day" }] }] }, 5],
  cbc_mixed: ["conjoint", { attributes: [{ name: "A", levels: ["a1", "a2", "a3"] }, { name: "B", levels: ["b1", "b2", "b3", "b4"] }, { name: "C", levels: ["c1", "c2"] }], tasks: 8, alternativesPerTask: 4, versions: 2 }, 3],
  maxdiff: ["maxdiff", { items: ["Battery", "Camera", "Screen", "Price", "Speed", "Design", "Storage", "Support"], itemsPerTask: 4, tasks: 10, versions: 4 }, 7],
  menu: ["menu", { items: [{ name: "Base", levels: ["$10", "$12", "$14"] }, { name: "Data", levels: ["$2", "$4"] }, { name: "Cloud", levels: ["$3", "$5", "$7"] }], requiredItems: ["Base"], tasks: 8, versions: 3 }, 9],
  acbc: ["acbc", { attributes: ATTRS, screeningTasks: 5, conceptsPerScreen: 4 }, 1],
};
const PLUGINS = { conjoint: conjointPlugin, maxdiff: maxdiffPlugin, menu: menuPlugin, acbc: acbcPlugin };

/** the CBC + MaxDiff + menu survey and its simulated answers (all pre-existing shapes) */
export function compatStudy(n = 240) {
  const [, cbcCfg, cbcSeed] = DESIGN_CASES.cbc_efficient_none;
  const cbc = conjointPlugin.generate(cbcCfg, cbcSeed);
  const [, mdCfg, mdSeed] = DESIGN_CASES.maxdiff;
  const md = maxdiffPlugin.generate(mdCfg, mdSeed);
  const [, menuCfg, menuSeed] = DESIGN_CASES.menu;
  const menu = menuPlugin.generate(menuCfg, menuSeed);
  const def = SurveyDefinition.parse({
    meta: { id: "compat", code: "COMPAT", title: "Compat", version: "1.0" },
    designs: [
      { id: "d_cbc", kind: "conjoint", name: "CBC", version: 1, seed: cbcSeed, config: cbcCfg, file: { format: "json", columns: cbc.columns, rows: cbc.rows } },
      { id: "d_md", kind: "maxdiff", name: "MD", version: 1, seed: mdSeed, config: mdCfg, file: { format: "json", columns: md.columns, rows: md.rows } },
      { id: "d_menu", kind: "menu", name: "Menu", version: 1, seed: menuSeed, config: menuCfg, file: { format: "json", columns: menu.columns, rows: menu.rows } },
    ],
    questions: [
      { id: "q_cbc", code: "Q1", variableName: "CBC", type: "conjoint_task", text: "Choose", settings: { designRef: "d_cbc" } },
      { id: "q_md", code: "Q2", variableName: "MD", type: "maxdiff_task", text: "Most / least", settings: { designRef: "d_md" } },
      { id: "q_menu", code: "Q3", variableName: "MENU", type: "conjoint_task", variant: "conjoint.pricing_configurator", text: "Build", settings: { designRef: "d_menu" } },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_cbc", "q_md", "q_menu"] }, { type: "end", id: "e1", status: "complete" }],
  });
  const PW = { Brand: [0.5, 0, -0.5], Screen: [-0.3, 0.1, 0.2], Battery: [-0.6, 0.1, 0.5], Price: [1, 0.1, -1.1] };
  const MDU = [1.4, 0.9, 0.5, 0.1, -0.2, -0.6, -0.9, -1.2];
  const r = mulberry32(4242), g = () => -Math.log(-Math.log(Math.max(r(), 1e-12)));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(r() * 2 ** 31);
    const v = designVersionFor(def.questions[0], cbc.rows, seed);
    const a = {};
    for (let t = 1; t <= 12; t++) {
      const alts = cbc.rows.filter((x) => String(x.version) === v && x.task === t);
      const u = alts.map((x) => (Number(x.none_option) === 1 ? -0.8 : ATTRS.reduce((s, at) => s + PW[at.name][at.levels.indexOf(String(x[at.name]))], 0)) + g());
      a[t] = String(alts[u.indexOf(Math.max(...u))].alt);
    }
    const mv = designVersionFor(def.questions[1], md.rows, seed);
    const m = {};
    for (const t of new Set(md.rows.filter((x) => String(x.version) === mv).map((x) => String(x.task)))) {
      const its = md.rows.filter((x) => String(x.version) === mv && String(x.task) === t);
      const ub = its.map((x) => MDU[Number(x.item_index) - 1] + g());
      const bi = ub.indexOf(Math.max(...ub));
      const rest = its.filter((_, k) => k !== bi);
      const uw = rest.map((x) => -MDU[Number(x.item_index) - 1] + g());
      m[t] = { best: String(its[bi].item_index), worst: String(rest[uw.indexOf(Math.max(...uw))].item_index) };
    }
    const nv = designVersionFor(def.questions[2], menu.rows, seed);
    const mn = {};
    for (let t = 1; t <= 8; t++) {
      const its = menu.rows.filter((x) => String(x.version) === nv && x.task === t);
      if (r() < 0.08) { mn[t] = ["none"]; continue; }
      mn[t] = its.filter((x) => Number(x.required) !== 1 && 1.5 - 0.5 * Number(x.price_value) + 2 * (r() - 0.5) > 0).map((x) => String(x.item));
    }
    rows.push({ id: `r${i}`, session_id: `s${i}`, respondent_code: `R${String(i + 1).padStart(4, "0")}`, seed, status: "complete", is_test: false, started_at: "2026-10-01T10:00:00Z", completed_at: "2026-10-01T10:10:00Z", answers: { q_cbc: a, q_md: m, q_menu: mn }, calculated: {}, embedded: {}, flags: [] });
  }
  return { def, rows };
}

export async function snapshotInputs() {
  const designs = {};
  for (const [name, [kind, cfg, seed]] of Object.entries(DESIGN_CASES)) {
    const f = PLUGINS[kind].generate(cfg, seed);
    designs[name] = { columns: f.columns, rows: f.rows.length, rowsHash: fnv(JSON.stringify(f.rows)), summaryHash: fnv(JSON.stringify(f.summary ?? null)) };
  }
  const { def, rows } = compatStudy();
  const spec = { environment: "LIVE", dataset: "all" };
  const ds = buildDataset(def, rows, { spec });
  const A = (kind, variables, options) => strip(runAnalysis({ name: kind, kind, dataset: spec, variables, ...(options ? { options } : {}) }, ds));
  const cbc = A("conjoint", ["CBC"]);
  const md = A("maxdiff", ["MD"]);
  const menu = A("conjoint", ["MENU"]);
  const hb = A("hb", ["CBC"], { burnIn: 3000, draws: 2000, thin: 5, seed: 3, timeBudgetMs: 600000 });
  const flat = rows.slice(0, 5).map((r) => flattenVariables(def, { answers: r.answers, seed: r.seed, calculated: {}, embedded: {} }));
  const dict = buildVariableDictionary(def).map((v) => ({ name: v.name, label: v.label, dataType: v.dataType, valueCodes: v.valueCodes ?? null }));
  const stacked = stackedChoiceData(def, rows.slice(0, 20).map((r) => ({ sessionId: r.session_id, respondentId: r.respondent_code, seed: r.seed, answers: r.answers })));
  return {
    designs,
    analyses: {
      cbc: { tables: cbc.tables, warnings: cbc.warnings, insights: cbc.insights },
      maxdiff: { tables: md.tables, warnings: md.warnings },
      menuCounts: menu.tables.find((t) => t.id === "menu_counts") ?? null,
      hb: { mean: hb.tables.find((t) => t.id === "hb_mean")?.rows ?? null, fit: hb.tables.find((t) => t.id === "hb_fit")?.rows ?? null, diagnostics: (hb.tables.find((t) => t.id === "hb_diagnostics")?.rows ?? []).filter((x) => x.m !== "Estimator version"), warnings: hb.warnings },
    },
    exports: { flat, dict, stacked: { columns: stacked.columns, rows: stacked.rows.length, hash: fnv(JSON.stringify(stacked.rows)) } },
  };
}
