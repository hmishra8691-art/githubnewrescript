/** Shared synthetic fixture: a survey with planted structure plus generated responses. */
import { SurveyDefinition } from "@rescript/schema";
import { conjointPlugin, maxdiffPlugin } from "@rescript/designs";
import { mulberry32 } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import type { AnalysisDefinition } from "../types.js";

export const rule = (ref: string, value: unknown, operator = "eq") => ({ type: "rule" as const, source: { kind: "question" as const, ref }, operator: operator as "eq", value });

const cbc = conjointPlugin.generate({ attributes: [{ name: "Price", levels: ["$10", "$20", "$30"] }, { name: "Brand", levels: ["Alpha", "Beta"] }, { name: "Warranty", levels: ["1 year", "2 years"] }], tasks: 8, alternativesPerTask: 3, noneOption: true, versions: 1 }, 7);
const md = maxdiffPlugin.generate({ items: ["Battery", "Camera", "Screen", "Price", "Speed", "Design"], itemsPerTask: 4, tasks: 9, versions: 1 }, 7);

export const def = SurveyDefinition.parse({
  meta: { id: "syn", code: "SYN", title: "Synthetic", version: "1.0" },
  designs: [
    { id: "d_cbc", kind: "conjoint", name: "CBC", config: { attributes: [{ name: "Price", levels: ["$10", "$20", "$30"] }, { name: "Brand", levels: ["Alpha", "Beta"] }, { name: "Warranty", levels: ["1 year", "2 years"] }], alternativesPerTask: 3, noneOption: true }, file: { format: "json", columns: cbc.columns, rows: cbc.rows } },
    { id: "d_md", kind: "maxdiff", name: "MD", config: { items: ["Battery", "Camera", "Screen", "Price", "Speed", "Design"], itemsPerTask: 4 }, file: { format: "json", columns: md.columns, rows: md.rows } },
  ],
  questions: [
    { id: "q_gender", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
    { id: "q_age", code: "Q2", variableName: "AGE", type: "numeric", text: "Age" },
    { id: "q_region", code: "Q3", variableName: "REGION", type: "single_select", text: "Region", options: [{ code: 1, label: "North" }, { code: 2, label: "South" }, { code: 3, label: "East" }] },
    { id: "q_sat", code: "Q4", variableName: "SAT", type: "single_select", text: "Overall satisfaction", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `${c}` })) },
    { id: "q_nps", code: "Q5", variableName: "NPS", type: "nps", text: "Recommend?", settings: { minValue: 0, maxValue: 10 } },
    { id: "q_brands", code: "Q6", variableName: "AWARE", type: "multi_select", text: "Brands aware of", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
    { id: "q_consider", code: "Q7", variableName: "CONSIDER", type: "multi_select", text: "Brands considered", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
    { id: "q_items", code: "Q8", variableName: "ITEMS", type: "matrix_single", text: "Rate", rows: [{ code: "a", label: "Quality" }, { code: "b", label: "Value" }, { code: "c", label: "Service" }], options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `${c}` })) },
    { id: "q_rank", code: "Q9", variableName: "RANK", type: "ranking", text: "Rank", options: [{ code: 1, label: "Speed" }, { code: 2, label: "Price" }, { code: 3, label: "Design" }] },
    { id: "q_alloc", code: "Q10", variableName: "ALLOC", type: "allocation", text: "Allocate 100", options: [{ code: 1, label: "Rent" }, { code: 2, label: "Food" }, { code: 3, label: "Fun" }] },
    { id: "q_text", code: "Q11", variableName: "TEXT", type: "open_text", text: "Comments" },
    { id: "q_cheap", code: "Q12", variableName: "P_CHEAP", type: "numeric", text: "Too cheap" },
    { id: "q_bargain", code: "Q13", variableName: "P_BARGAIN", type: "numeric", text: "Bargain" },
    { id: "q_exp", code: "Q14", variableName: "P_EXP", type: "numeric", text: "Expensive" },
    { id: "q_tooexp", code: "Q15", variableName: "P_TOOEXP", type: "numeric", text: "Too expensive" },
    { id: "q_cbc", code: "Q16", variableName: "CBC", type: "conjoint_task", text: "Choose", settings: { designRef: "d_cbc" } },
    { id: "q_md", code: "Q17", variableName: "MD", type: "maxdiff_task", text: "Best/worst", settings: { designRef: "d_md" } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_gender", "q_age", "q_region", "q_sat", "q_nps", "q_brands", "q_consider", "q_items", "q_rank", "q_alloc", "q_text", "q_cheap", "q_bargain", "q_exp", "q_tooexp", "q_cbc", "q_md"] }],
});

const PRICE_U: Record<string, number> = { $10: 1.2, $20: 0, $30: -1.2 }, BRAND_U: Record<string, number> = { Alpha: 0.4, Beta: -0.4 }, WARR_U: Record<string, number> = { "1 year": -0.2, "2 years": 0.2 };
const MD_U = [1.5, 0.8, 0.2, -0.2, -0.8, -1.5];
const WORDS_POS = ["great service", "love the quality", "easy to use and helpful", "excellent value"], WORDS_NEG = ["too expensive", "slow delivery problem", "poor support", "confusing app"];

function gumbel(r: () => number) { return -Math.log(-Math.log(Math.max(r(), 1e-9))); }

export function synthRows(n = 400, seed = 11): AnalyticsRow[] {
  const r = mulberry32(seed);
  const rows: AnalyticsRow[] = [];
  for (let i = 0; i < n; i++) {
    const gender = r() < 0.5 ? 1 : 2;
    const age = Math.round(18 + r() * 60);
    const region = 1 + Math.floor(r() * 3);
    // women more satisfied
    const satBase = gender === 2 ? 3.8 : 3.0;
    const sat = Math.max(1, Math.min(5, Math.round(satBase + (r() - 0.5) * 2.4)));
    const npsv = Math.max(0, Math.min(10, Math.round(sat * 1.8 + (r() - 0.5) * 3)));
    const aware = [1, 2, 3].filter((b) => r() < [0.9, 0.7, 0.4][b - 1]);
    const consider = aware.filter((b) => r() < [0.7, 0.5, 0.3][b - 1]);
    const items = { a: Math.max(1, Math.min(5, Math.round(sat + (r() - 0.5) * 1.5))), b: Math.max(1, Math.min(5, Math.round(sat - 0.5 + (r() - 0.5) * 1.5))), c: Math.max(1, Math.min(5, Math.round(3 + (r() - 0.5) * 2.5))) };
    const rank = r() < 0.6 ? [2, 1, 3] : [1, 2, 3].sort(() => r() - 0.5); // ordered codes: Price first for 60%
    const a1 = Math.round(30 + r() * 30), a2 = Math.round((100 - a1) * (0.4 + r() * 0.3));
    const cheap = Math.round(5 + r() * 5), bargain = cheap + Math.round(3 + r() * 5), exp = bargain + Math.round(3 + r() * 6), tooexp = exp + Math.round(3 + r() * 6);
    const cbcAns: Record<string, string> = {};
    for (const t of new Set(cbc.rows.map((x) => String(x.task)))) {
      const alts = cbc.rows.filter((x) => String(x.task) === t && String(x.version) === "1").sort((a, b) => Number(a.alt) - Number(b.alt));
      const u = alts.map((a) => (Number(a.none_option) === 1 ? -1.5 : PRICE_U[String(a.Price)] + BRAND_U[String(a.Brand)] + WARR_U[String(a.Warranty)]) + gumbel(r));
      cbcAns[t] = String(alts[u.indexOf(Math.max(...u))].alt);
    }
    const mdAns: Record<string, { best: string; worst: string }> = {};
    for (const t of new Set(md.rows.map((x) => String(x.task)))) {
      const alts = md.rows.filter((x) => String(x.task) === t && String(x.version) === "1");
      const u = alts.map((a) => MD_U[Number(a.item_index) - 1] + gumbel(r));
      const bi = u.indexOf(Math.max(...u)); const rest = alts.map((_, k) => k).filter((k) => k !== bi);
      const uw = rest.map((k) => -MD_U[Number(alts[k].item_index) - 1] + gumbel(r));
      mdAns[t] = { best: String(alts[bi].item_index), worst: String(alts[rest[uw.indexOf(Math.max(...uw))]].item_index) };
    }
    const started = new Date(Date.UTC(2026, 5 + Math.floor(i / 140), 1 + (i % 28), 10));
    rows.push({
      id: `r${i}`, session_id: `s${i}`, respondent_code: `LIVE_${i}`, status: "complete", is_test: false, started_at: started.toISOString(), completed_at: new Date(started.getTime() + (300 + r() * 600) * 1000).toISOString(),
      quality: { classification: r() < 0.9 ? "CLEAN" : "SUSPECT", qualityScore: 80, riskScore: 10 },
      answers: { q_gender: gender, q_age: age, q_region: region, q_sat: sat, q_nps: npsv, q_brands: aware, q_consider: consider, q_items: items, q_rank: rank, q_alloc: { 1: a1, 2: a2, 3: 100 - a1 - a2 }, q_text: sat >= 4 ? WORDS_POS[i % 4] : sat <= 2 ? WORDS_NEG[i % 4] : "", q_cheap: cheap, q_bargain: bargain, q_exp: exp, q_tooexp: tooexp, q_cbc: cbcAns, q_md: mdAns },
      calculated: {}, embedded: {}, flags: [],
    });
  }
  return rows;
}


export const spec = { environment: "LIVE" as const, dataset: "all" as const };
export function synthDataset(n = 400) { return buildDataset(def, synthRows(n), { spec }); }
export const D = (kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: spec, variables, ...extra });
