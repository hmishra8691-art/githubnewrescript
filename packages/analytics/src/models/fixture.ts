/*
 * TEST SUPPORT — not part of @rescript/analytics' surface (ARCH-06; excluded
 * from the packed build by the `!dist/**\/fixture.js` rule). Imported by the
 * models' *.test.ts files and by scripts/advanced-models-test.mjs.
 *
 * Synthetic studies with KNOWN structure for the advanced models:
 *  - a CBC on a real efficient design from @rescript/designs, respondents drawn
 *    from a known population N(μ, Σ) of effects-coded part-worths (Gumbel errors,
 *    so the MNL is the true lower-level model) — the individual truths are kept;
 *  - a MaxDiff with heterogeneous item utilities;
 *  - six categorical indicators from a known 3-class latent class model;
 *  - nine numeric items from a 3-factor model with a structural mediation.
 */
import { SurveyDefinition } from "@rescript/schema";
import { conjointPlugin, maxdiffPlugin } from "@rescript/designs";
import { designVersionFor } from "@rescript/engine";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { Rng } from "./rng.js";

export const CBC_ATTRIBUTES = [
  { name: "Brand", levels: ["Alpha", "Beta", "Gamma"] },
  { name: "Screen", levels: ["5in", "6in", "7in"] },
  { name: "Battery", levels: ["1 day", "2 days", "3 days"] },
  { name: "Price", levels: ["$199", "$299", "$399"] },
];
/** population means of the zero-centred part-worths (sum to zero per attribute) */
export const CBC_MU: Record<string, number[]> = { Brand: [0.5, 0, -0.5], Screen: [-0.3, 0.1, 0.2], Battery: [-0.6, 0.1, 0.5], Price: [1.0, 0.1, -1.1] };
export const CBC_NONE_MU = -0.8;
export const MD_ITEMS = ["Battery", "Camera", "Screen", "Price", "Speed", "Design", "Storage", "Support"];
export const MD_MU = [1.4, 0.9, 0.5, 0.1, -0.2, -0.6, -0.9, -1.2];

export const LCA_TRUE = {
  classSizes: [0.5, 0.3, 0.2],
  categories: [2, 2, 2, 2, 3, 3],
  itemProbs: [
    [[0.9, 0.1], [0.85, 0.15], [0.8, 0.2], [0.9, 0.1], [0.7, 0.2, 0.1], [0.6, 0.3, 0.1]],
    [[0.2, 0.8], [0.25, 0.75], [0.7, 0.3], [0.3, 0.7], [0.1, 0.3, 0.6], [0.2, 0.6, 0.2]],
    [[0.15, 0.85], [0.8, 0.2], [0.1, 0.9], [0.85, 0.15], [0.2, 0.6, 0.2], [0.1, 0.1, 0.8]],
  ],
};

export interface AdvancedFixtureOptions { n?: number; seed?: number; heterogeneity?: number; tasks?: number }

const pick = (rng: Rng, probs: number[]) => { const u = rng.next(); let c = 0; for (let k = 0; k < probs.length; k++) { c += probs[k]; if (u < c) return k; } return probs.length - 1; };
const gumbel = (rng: Rng) => -Math.log(-Math.log(rng.open()));

/**
 * One survey carrying all four exercises. `truth.cbc[i]` holds respondent i's
 * zero-centred part-worths (attribute → level utilities) and None constant.
 */
export function advancedFixture(opts: AdvancedFixtureOptions = {}) {
  const n = opts.n ?? 300, seed = opts.seed ?? 2026, het = opts.heterogeneity ?? 0.8, tasks = opts.tasks ?? 12;
  const cbcConfig = { attributes: CBC_ATTRIBUTES, tasks, alternativesPerTask: 3, noneOption: true, versions: 10, method: "efficient" as const };
  const cbc = conjointPlugin.generate(cbcConfig, 2026);
  const mdConfig = { items: MD_ITEMS, itemsPerTask: 4, tasks: 10, versions: 4 };
  const md = maxdiffPlugin.generate(mdConfig, 7);
  const scale5 = [1, 2, 3, 4, 5].map((c) => ({ code: c, label: String(c) }));
  const def = SurveyDefinition.parse({
    meta: { id: "adv", code: "ADV", title: "Advanced models", version: "1.0" },
    designs: [
      { id: "d_cbc", kind: "conjoint", name: "CBC", version: 1, config: cbcConfig, file: { format: "json", columns: cbc.columns, rows: cbc.rows } },
      { id: "d_md", kind: "maxdiff", name: "MD", version: 1, config: mdConfig, file: { format: "json", columns: md.columns, rows: md.rows } },
    ],
    questions: [
      { id: "q_cbc", code: "Q1", variableName: "CBC", type: "conjoint_task", text: "Which phone would you buy?", settings: { designRef: "d_cbc" } },
      { id: "q_md", code: "Q2", variableName: "MD", type: "maxdiff_task", text: "Most and least important", settings: { designRef: "d_md" } },
      ...LCA_TRUE.categories.map((r, j) => ({ id: `q_u${j + 1}`, code: `U${j + 1}`, variableName: `U${j + 1}`, type: "single_select", text: `Usage indicator ${j + 1}`, options: Array.from({ length: r }, (_, k) => ({ code: k + 1, label: r === 2 ? (k ? "Yes" : "No") : ["Never", "Sometimes", "Often"][k] })) })),
      ...["x1", "x2", "x3", "m1", "m2", "m3", "y1", "y2", "y3"].map((v, j) => ({ id: `q_${v}`, code: `S${j + 1}`, variableName: v.toUpperCase(), type: "numeric", text: `Attitude item ${v}` })),
      { id: "q_sat", code: "Q20", variableName: "SAT", type: "single_select", text: "Satisfaction", options: scale5 },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_cbc", "q_md", ...LCA_TRUE.categories.map((_, j) => `q_u${j + 1}`), ...["x1", "x2", "x3", "m1", "m2", "m3", "y1", "y2", "y3"].map((v) => `q_${v}`), "q_sat"] }, { type: "end", id: "e1", status: "complete" }],
  });
  const rng = new Rng(seed);
  const rows: AnalyticsRow[] = [];
  const truth = { cbc: [] as { levels: Record<string, number[]>; none: number }[], md: [] as number[][], cls: [] as number[] };
  const qCbc = def.questions[0], qMd = def.questions[1];
  for (let i = 0; i < n; i++) {
    const rseed = Math.floor(rng.next() * 2 ** 31);
    // CBC: effects-coded heterogeneity — level noise centred within the attribute
    const levels: Record<string, number[]> = {};
    for (const a of CBC_ATTRIBUTES) { const z = a.levels.map(() => het * rng.normal()); const zm = z.reduce((t, v) => t + v, 0) / z.length; levels[a.name] = CBC_MU[a.name].map((m, k) => m + z[k] - zm); }
    const none = CBC_NONE_MU + 0.6 * rng.normal();
    truth.cbc.push({ levels, none });
    const version = designVersionFor(qCbc, cbc.rows, rseed);
    const cbcAns: Record<string, string> = {};
    for (let t = 1; t <= tasks; t++) {
      const alts = cbc.rows.filter((x) => String(x.version) === version && Number(x.task) === t).sort((a, b) => Number(a.alt) - Number(b.alt));
      const u = alts.map((a) => (Number(a.none_option) === 1 ? none : CBC_ATTRIBUTES.reduce((s, at) => s + levels[at.name][at.levels.indexOf(String(a[at.name]))], 0)) + gumbel(rng));
      cbcAns[String(t)] = String(alts[u.indexOf(Math.max(...u))].alt);
    }
    // MaxDiff: heterogeneous item utilities, sequential best–worst
    const mdU = MD_MU.map((m) => m + 0.7 * rng.normal());
    truth.md.push(mdU);
    const mdVersion = designVersionFor(qMd, md.rows, rseed);
    const mdAns: Record<string, { best: string; worst: string }> = {};
    for (const t of new Set(md.rows.filter((x) => String(x.version) === mdVersion).map((x) => String(x.task)))) {
      const alts = md.rows.filter((x) => String(x.task) === t && String(x.version) === mdVersion);
      const ub = alts.map((a) => mdU[Number(a.item_index) - 1] + gumbel(rng));
      const bi = ub.indexOf(Math.max(...ub));
      const rest = alts.map((_, k) => k).filter((k) => k !== bi);
      const uw = rest.map((k) => -mdU[Number(alts[k].item_index) - 1] + gumbel(rng));
      mdAns[t] = { best: String(alts[bi].item_index), worst: String(alts[rest[uw.indexOf(Math.max(...uw))]].item_index) };
    }
    // LCA: class, then indicators
    const cls = pick(rng, LCA_TRUE.classSizes);
    truth.cls.push(cls);
    const lcaAns: Record<string, number> = {};
    LCA_TRUE.categories.forEach((_, j) => { lcaAns[`q_u${j + 1}`] = pick(rng, LCA_TRUE.itemProbs[cls][j]) + 1; });
    // SEM: X → M → Y (a = .5, b = .4, c' = .2), three indicators each
    const X = rng.normal(), M = 0.5 * X + Math.sqrt(0.75) * rng.normal(), Y = 0.2 * X + 0.4 * M + 0.8 * rng.normal();
    const lam = { x: [1, 0.8, 1.2], m: [1, 0.9, 0.7], y: [1, 1.1, 0.8] };
    const semAns: Record<string, number> = {};
    (["x", "m", "y"] as const).forEach((f) => lam[f].forEach((l, k) => { const lat = f === "x" ? X : f === "m" ? M : Y; semAns[`q_${f}${k + 1}`] = Math.round((3 + l * lat + 0.6 * rng.normal()) * 100) / 100; }));
    rows.push({
      id: `r${i}`, session_id: `s${i}`, respondent_code: `R${String(i + 1).padStart(4, "0")}`, seed: rseed, status: "complete", is_test: false,
      started_at: "2026-10-01T10:00:00Z", completed_at: "2026-10-01T10:12:00Z",
      answers: { q_cbc: cbcAns, q_md: mdAns, ...lcaAns, ...semAns, q_sat: 1 + Math.floor(rng.next() * 5) },
      calculated: {}, embedded: {}, flags: [],
    } as AnalyticsRow);
  }
  return { def, rows, truth, cbc, md, cbcConfig, mdConfig };
}

export const advSpec = { environment: "LIVE" as const, dataset: "all" as const };
export function advancedDataset(opts: AdvancedFixtureOptions = {}) {
  const f = advancedFixture(opts);
  return { ...f, ds: buildDataset(f.def, f.rows, { spec: advSpec }) };
}

/** a survey of numeric questions holding given columns (for SEM reference datasets) */
export function numericSurvey(columns: Record<string, number[]>) {
  const names = Object.keys(columns);
  const def = SurveyDefinition.parse({
    meta: { id: "num", code: "NUM", title: "Numeric", version: "1.0" },
    questions: names.map((v, j) => ({ id: `q_${v}`, code: `N${j + 1}`, variableName: v, type: "numeric", text: v })),
    flow: [{ type: "page", id: "p1", questionIds: names.map((v) => `q_${v}`) }, { type: "end", id: "e1", status: "complete" }],
  });
  const n = columns[names[0]].length;
  const rows: AnalyticsRow[] = Array.from({ length: n }, (_, i) => ({
    id: `r${i}`, session_id: `s${i}`, status: "complete", is_test: false, started_at: "2026-10-01T10:00:00Z", completed_at: "2026-10-01T10:05:00Z",
    answers: Object.fromEntries(names.map((v) => [`q_${v}`, columns[v][i]])), calculated: {}, embedded: {}, flags: [],
  } as AnalyticsRow));
  return { def, rows, ds: buildDataset(def, rows, { spec: advSpec }) };
}

/**
 * THE SAME STUDY WITH A RESEARCH DESIGN (2026-10-22, advanced models from the plan): constructs measured by the
 * nine attitude items (price perception X1–X3, trust M1–M3, purchase intent Y1–Y3), three hypotheses — a direct
 * path, a mediation and a second direct path — a segmentation objective with the six usage indicators tagged for
 * latent class, and a planned sample of 300. The data are the same as `advancedFixture` (X → M → Y holds).
 */
export function intelligentFixture(opts: AdvancedFixtureOptions = {}) {
  const f = advancedFixture(opts);
  const raw = JSON.parse(JSON.stringify(f.def)) as Record<string, unknown> & { questions: { id: string; analysis?: unknown }[] };
  for (const q of raw.questions) if (/^q_u\d$/.test(q.id)) q.analysis = { modeling: ["latent_class"], primary: [], crosstabBy: [], relatedTo: [], hypotheses: [] };
  raw.research = {
    objective: "Segment phone buyers and test what drives purchase intent",
    methodology: "Online survey, n = 300; CBC and MaxDiff exercises; attitude scales",
    sampleSize: 300,
    hypotheses: ["Trust increases purchase intent", "Trust mediates the effect of price perception on purchase intent", "Price perception increases purchase intent"],
    constructs: [
      { name: "Price perception", role: "independent", questionIds: ["q_x1", "q_x2", "q_x3"] },
      { name: "Trust", role: "mediator", questionIds: ["q_m1", "q_m2", "q_m3"] },
      { name: "Purchase intent", role: "dependent", questionIds: ["q_y1", "q_y2", "q_y3"] },
    ],
    analysis: [], assumptions: [], sources: [],
  };
  const def = SurveyDefinition.parse(raw);
  return { ...f, def, ds: buildDataset(def, f.rows, { spec: advSpec }) };
}

/** a Gabor–Granger ladder: purchase intent (5 points) at four prices, demand falling with price */
export function gaborGrangerFixture(n = 240, seed = 5) {
  const prices = [9.99, 14.99, 19.99, 24.99];
  const scale = ["Definitely not", "Probably not", "Not sure", "Probably would", "Definitely would"].map((label, k) => ({ code: k + 1, label }));
  const def = SurveyDefinition.parse({
    meta: { id: "gg", code: "GG", title: "Pricing", version: "1.0" },
    research: { objective: "Find the revenue-maximising price", hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [], sampleSize: n },
    questions: prices.map((p, i) => ({ id: `q_p${i + 1}`, code: `P${i + 1}`, variableName: `PRICE_${i + 1}`, type: "single_select", text: `How likely would you be to buy it at $${p}?`, options: scale })),
    flow: [{ type: "page", id: "p1", questionIds: prices.map((_, i) => `q_p${i + 1}`) }, { type: "end", id: "e1", status: "complete" }],
  });
  const rng = new Rng(seed);
  const rows: AnalyticsRow[] = Array.from({ length: n }, (_, i) => {
    const wtp = 8 + 20 * rng.next();
    const answers = Object.fromEntries(prices.map((p, k) => [`q_p${k + 1}`, Math.max(1, Math.min(5, Math.round(3 + (wtp - p) / 4 + 0.5 * rng.normal())))]));
    return { id: `r${i}`, session_id: `s${i}`, status: "complete", is_test: false, started_at: "2026-10-01T10:00:00Z", completed_at: "2026-10-01T10:05:00Z", answers, calculated: {}, embedded: {}, flags: [] } as AnalyticsRow;
  });
  return { def, rows, prices, ds: buildDataset(def, rows, { spec: advSpec }) };
}
