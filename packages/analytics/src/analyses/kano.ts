import type { AnalysisDefinition, AnalysisResult } from "../types.js";
import { battery, itemLabelOf, numericColumn, type Dataset, type VariableMeta } from "../dataset.js";
import { describe } from "../stats/descriptive.js";
import { fmtNum, makeResult, opt, refused, round } from "./common.js";

/**
 * KANO MODEL (Design Generators phase 2, 2026-11-09). Each feature is asked twice — functional ("if it has …") and
 * dysfunctional ("if it does not have …") — on the five standard answers, coded
 *   1 I like it · 2 I expect it · 3 I am neutral · 4 I can live with it · 5 I dislike it.
 * Every respondent's pair is classified with Berger et al.'s (1993) evaluation table:
 *
 *                    dysfunctional →  like   expect  neutral  live with  dislike
 *     functional like                  Q      A       A        A          O
 *                expect / neutral /    R      I       I        I          M
 *                live with
 *                dislike               R      R       R        R          Q
 *
 * A attractive, O one-dimensional (performance), M must-be, I indifferent, R reverse, Q questionable. Per feature:
 * the share in each category (weighted when the study is; the base is every respondent who answered both), the
 * category by the most frequent answer (ties broken M > O > A > I, Berger's rule), the category strength (the gap
 * between the two largest shares) and Timko's customer-satisfaction coefficients
 *   Better = (A + O) / (A + O + M + I),   Worse = −(O + M) / (A + O + M + I).
 * variables: [functional grid, dysfunctional grid] (question variables; rows matched by row code), optionally the
 * importance grid (any numeric scale) as variables[2] or options.importance.
 */
export const KANO_TABLE: readonly (readonly KanoCategory[])[] = [
  ["Q", "A", "A", "A", "O"],
  ["R", "I", "I", "I", "M"],
  ["R", "I", "I", "I", "M"],
  ["R", "I", "I", "I", "M"],
  ["R", "R", "R", "R", "Q"],
];
export type KanoCategory = "A" | "O" | "M" | "I" | "R" | "Q";
export const KANO_NAMES: Record<KanoCategory, string> = { M: "Must-be", O: "One-dimensional (performance)", A: "Attractive (delighter)", I: "Indifferent", R: "Reverse", Q: "Questionable" };
const ORDER: KanoCategory[] = ["M", "O", "A", "I", "R", "Q"];

/** one respondent's pair → its category (null when either answer is missing or off the 1–5 scale) */
export function kanoClass(functional: number | null | undefined, dysfunctional: number | null | undefined): KanoCategory | null {
  if (functional == null || dysfunctional == null) return null;
  const f = Math.round(functional), d = Math.round(dysfunctional);
  if (f < 1 || f > 5 || d < 1 || d > 5) return null;
  return KANO_TABLE[f - 1][d - 1];
}

/** the columns of a grid by row code: the grid's battery, or the variable itself when a single column is named */
function rowsOf(ds: Dataset, name: string): { code: string; meta: VariableMeta }[] | null {
  const head = ds.byName.get(name);
  if (!head) return null;
  if (head.questionId && (head.role === "complex" || !head.rowCode)) {
    const cols = battery(ds, head.questionId).filter((v) => v.rowCode != null);
    if (cols.length) return cols.map((v) => ({ code: String(v.rowCode), meta: v }));
  }
  return [{ code: head.rowCode ?? name, meta: head }];
}

export function kano(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const [fv, dv] = def.variables;
  const iv = def.variables[2] ?? opt<string | undefined>(def, "importance", undefined);
  if (!fv || !dv) return refused(def, ds, totalCases, "The Kano analysis needs the functional and the dysfunctional question (two grids over the same features).", ["table"]);
  const F = rowsOf(ds, fv), D = rowsOf(ds, dv);
  if (!F || !D) return refused(def, ds, totalCases, `The Kano analysis needs ${!F ? fv : dv} in this survey's data.`, ["table"]);
  const I = iv ? rowsOf(ds, iv) : null;
  const dByCode = new Map(D.map((x) => [x.code, x]));
  const iByCode = new Map((I ?? []).map((x) => [x.code, x]));
  const pairs = F.filter((x) => dByCode.has(x.code));
  if (!pairs.length) return refused(def, ds, totalCases, "The functional and dysfunctional questions share no feature (their rows must use the same codes).", ["table"]);
  const w = ds.weighted ? ds.cases.map((c) => c.weight) : null;
  const unmatched = F.length + D.length - 2 * pairs.length;
  let validN = 0;
  const rows = pairs.map((p) => {
    const fc = numericColumn(ds, p.meta.name), dc = numericColumn(ds, dByCode.get(p.code)!.meta.name);
    const counts: Record<KanoCategory, number> = { A: 0, O: 0, M: 0, I: 0, R: 0, Q: 0 };
    let n = 0, W = 0;
    ds.cases.forEach((_, i) => { const k = kanoClass(fc[i], dc[i]); if (!k) return; const wi = w?.[i] ?? 1; counts[k] += wi; W += wi; n++; });
    validN = Math.max(validN, n);
    const pct = (k: KanoCategory) => (W ? (counts[k] / W) * 100 : null);
    const ranked = [...ORDER].sort((a, b) => counts[b] - counts[a] || ORDER.indexOf(a) - ORDER.indexOf(b));
    const core = counts.A + counts.O + counts.M + counts.I;
    const imp = iByCode.get(p.code) ? describe(numericColumn(ds, iByCode.get(p.code)!.meta.name).filter((x): x is number => x != null && Number.isFinite(x))).mean : null;
    return {
      feature: itemLabelOf(ds, p.meta.name), n,
      M: round(pct("M"), 1), O: round(pct("O"), 1), A: round(pct("A"), 1), I: round(pct("I"), 1), R: round(pct("R"), 1), Q: round(pct("Q"), 1),
      category: n ? KANO_NAMES[ranked[0]] : null, code: n ? ranked[0] : null,
      strength: n && W ? round(((counts[ranked[0]] - counts[ranked[1]]) / W) * 100, 1) : null,
      better: core ? round((counts.A + counts.O) / core, 3) : null,
      worse: core ? round(-(counts.O + counts.M) / core, 3) : null,
      ...(I ? { importance: round(imp, 2) } : {}),
    };
  });
  const answered = rows.filter((r) => r.n > 0);
  const insights: string[] = [];
  const by = (k: KanoCategory) => answered.filter((r) => r.code === k).map((r) => r.feature);
  if (by("M").length) insights.push(`Must-be (expected — their absence dissatisfies, their presence does not delight): ${by("M").join(", ")}.`);
  if (by("O").length) insights.push(`One-dimensional (more is better): ${by("O").join(", ")}.`);
  if (by("A").length) insights.push(`Attractive (delighters — unexpected, not missed): ${by("A").join(", ")}.`);
  if (by("I").length) insights.push(`Indifferent: ${by("I").join(", ")}.`);
  const topBetter = [...answered].filter((r) => r.better != null).sort((a, b) => (b.better ?? 0) - (a.better ?? 0))[0];
  const topWorse = [...answered].filter((r) => r.worse != null).sort((a, b) => (a.worse ?? 0) - (b.worse ?? 0))[0];
  if (topBetter) insights.push(`Largest satisfaction gain when present: ${topBetter.feature} (Better ${fmtNum(topBetter.better, 2)}); largest dissatisfaction when absent: ${topWorse!.feature} (Worse ${fmtNum(topWorse!.worse, 2)}).`);
  const warnings: string[] = [];
  const weak = answered.filter((r) => r.strength != null && r.strength < 6).map((r) => r.feature);
  if (weak.length) warnings.push(`Mixed classification (the two largest categories within 6 points): ${weak.join(", ")} — the segments may see these features differently; compare by segment before acting.`);
  const q = answered.filter((r) => (r.Q ?? 0) >= 10).map((r) => r.feature);
  if (q.length) warnings.push(`10%+ questionable answers (liked and disliked both ways): ${q.join(", ")} — check the wording of the two questions.`);
  if (unmatched) warnings.push(`${unmatched} row${unmatched === 1 ? "" : "s"} of the two grids have no partner (different row codes) and are left out.`);
  const cols = [
    { key: "feature", label: "Feature" }, { key: "n", label: "n", type: "count" as const },
    ...(["M", "O", "A", "I", "R", "Q"] as KanoCategory[]).map((k) => ({ key: k, label: `${KANO_NAMES[k].replace(/ \(.*\)/, "")} %`, type: "pct" as const, decimals: 1 })),
    { key: "category", label: "Category" }, { key: "strength", label: "Category strength (pts)", type: "number" as const, decimals: 1 },
    { key: "better", label: "Better", type: "number" as const, decimals: 2 }, { key: "worse", label: "Worse", type: "number" as const, decimals: 2 },
    ...(I ? [{ key: "importance", label: "Importance (mean)", type: "number" as const, decimals: 2 }] : []),
  ];
  return makeResult(def, ds, {
    tables: [{ id: "kano", title: "Kano classification", columns: cols, rows: rows.map(({ code: _c, ...r }) => r), base: { n: validN },
      notes: ["Classified per respondent with Berger et al.'s (1993) evaluation table; the category is the most frequent (ties M > O > A > I). Better = (A+O)/(A+O+M+I), Worse = −(O+M)/(A+O+M+I) (Timko). Base: respondents who answered both questions for the feature."] }],
    chart: { categories: answered.map((r) => r.feature), series: [{ name: "Better", values: answered.map((r) => r.better) }, { name: "Worse (absolute)", values: answered.map((r) => (r.worse == null ? null : Math.abs(r.worse))) }], valueFormat: "number" },
    insights, warnings, recommendedCharts: ["scatter", "bar_horizontal", "table"],
    variablesUsed: [...pairs.flatMap((p) => [p.meta.name, dByCode.get(p.code)!.meta.name]), ...(I ?? []).map((x) => x.meta.name)], totalCases, validN,
  });
}
