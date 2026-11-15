import type { ResultTable } from "../types.js";
import { categoricalColumn, categoriesOf, labelOf, type Dataset } from "../dataset.js";
import { normalCdf, normalQuantile } from "../stats/distributions.js";
import type { TestResult } from "../stats/tests.js";
import { adjustP, CORRECTION_WORDS, type CorrectionMethod } from "../posthoc.js";
import { MIN_BASE } from "./common.js";

/**
 * NPS ACROSS GROUPS, TESTED (2026-11-15).
 *
 * NPS is the mean of a per-respondent score — +100 a promoter, 0 a passive, −100 a detractor — so its standard error
 * is that score's: √((p + d − (p − d)²) / n_eff) on the proportion scale, with n_eff = (Σw)² / Σw² for weighted data.
 * Two groups' NPS are compared with a two-sample z on the difference, √(se₁² + se₂²); the pairs within one grouping
 * are one family and are adjusted together (Holm by default, as the crosstab letters are). A group gets the letter
 * of every group it is significantly HIGHER than.
 *
 * Not tested, and saying so: a group under MIN_BASE respondents (its NPS is shown, flagged), and the groups of a
 * multi-select grouping — a respondent can be in two of them, so the groups are not independent samples and a
 * two-sample test between them would be wrong.
 */

export interface NpsGroupRow { group: string; letter: string; n: number; promoters: number; passives: number; detractors: number; nps: number | null; lo: number | null; hi: number | null; sig: string; small: boolean }

export function npsForCases(values: (number | null)[], w: number[] | undefined, idx: number[]) {
  let P = 0, N = 0, D = 0, W = 0, W2 = 0, n = 0;
  for (const i of idx) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    const wt = w?.[i] ?? 1;
    if (!(wt > 0)) continue;
    n++; W += wt; W2 += wt * wt;
    if (v >= 9) P += wt; else if (v >= 7) N += wt; else D += wt;
  }
  if (!W) return { n: 0, p: 0, a: 0, d: 0, nps: null as number | null, se: null as number | null };
  const p = P / W, a = N / W, d = D / W;
  const neff = (W * W) / W2;
  const variance = p + d - (p - d) ** 2;
  return { n, p, a, d, nps: (p - d) * 100, se: neff > 1 ? Math.sqrt(Math.max(variance, 0) / neff) * 100 : null };
}

export function npsByGroups(ds: Dataset, v: string, values: (number | null)[], w: number[] | undefined, by: string, opts: { confidence: number; correction: CorrectionMethod | "none" }): { table: ResultTable; tests: TestResult[]; notes: string[]; rows: NpsGroupRow[] } {
  const cats = categoriesOf(ds, by), col = categoricalColumn(ds, by);
  const multi = ds.byName.get(by)?.role === "multi" || col.some((x) => Array.isArray(x) && x.length > 1);
  const z = normalQuantile(1 - (1 - opts.confidence) / 2);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const stats = cats.map((c, ci) => {
    const idx = col.map((x, i) => (Array.isArray(x) ? x.includes(c.code) : x === c.code) ? i : -1).filter((i) => i >= 0);
    const s = npsForCases(values, w, idx);
    return { c, letter: letters[ci] ?? `${ci + 1}`, ...s };
  }).filter((s) => s.n > 0);
  const notes: string[] = [];
  const testable = stats.filter((s) => s.n >= MIN_BASE && s.se != null);
  const sig = new Map<string, string[]>(stats.map((s) => [s.letter, []]));
  const tests: TestResult[] = [];
  const pct = Math.round(opts.confidence * 100);
  if (multi) notes.push(`${labelOf(ds, by)} is a multi-choice question — a respondent can be in more than one group — so its groups are not independent and were not tested against each other.`);
  else if (testable.length >= 2) {
    const pairs: { a: typeof testable[number]; b: typeof testable[number]; zv: number; p: number }[] = [];
    for (let i = 0; i < testable.length; i++) for (let j = i + 1; j < testable.length; j++) {
      const a = testable[i], b = testable[j];
      const se = Math.sqrt(a.se! ** 2 + b.se! ** 2);
      if (!se) continue;
      const zv = (a.nps! - b.nps!) / se;
      pairs.push({ a, b, zv, p: 2 * (1 - normalCdf(Math.abs(zv))) });
    }
    const adj = opts.correction === "none" ? pairs.map((x) => x.p) : adjustP(pairs.map((x) => x.p), opts.correction);
    pairs.forEach((x, k) => {
      const p = adj[k] ?? 1;
      if (p < 1 - opts.confidence) { const hi = x.zv > 0 ? x.a : x.b, lo = x.zv > 0 ? x.b : x.a; sig.get(hi.letter)!.push(lo.letter); }
    });
    const significant = pairs.filter((_, k) => (adj[k] ?? 1) < 1 - opts.confidence);
    tests.push({
      test: "NPS difference (two-sample z on the promoter/detractor score)", statistic: null, p: null,
      note: `${labelOf(ds, by)}: ${pairs.length} pair${pairs.length === 1 ? "" : "s"} compared at ${pct}% confidence${opts.correction === "none" ? "" : `, ${CORRECTION_WORDS[opts.correction]}-adjusted`}; ${significant.length ? significant.map((x) => `${x.a.c.label} vs ${x.b.c.label}`).join(", ") + " differ" : "no pair differs significantly"}.`,
      detail: { pairs: pairs.map((x, k) => ({ a: x.a.c.label, b: x.b.c.label, diff: x.a.nps! - x.b.nps!, z: x.zv, p: x.p, pAdjusted: adj[k] })) },
    });
  } else notes.push(`${labelOf(ds, by)}: fewer than two groups have ${MIN_BASE}+ respondents, so no significance test was run.`);
  const small = stats.filter((s) => s.n < MIN_BASE);
  if (small.length) notes.push(`${small.map((s) => `${s.c.label} (n=${s.n})`).join(", ")}: fewer than ${MIN_BASE} respondents — shown, not tested.`);
  const rows: NpsGroupRow[] = stats.map((s) => ({
    group: s.c.label, letter: s.letter, n: s.n, promoters: s.p * 100, passives: s.a * 100, detractors: s.d * 100, nps: s.nps,
    lo: s.se != null && s.n >= 10 ? s.nps! - z * s.se : null, hi: s.se != null && s.n >= 10 ? s.nps! + z * s.se : null,
    sig: (sig.get(s.letter) ?? []).join(""), small: s.n < MIN_BASE,
  }));
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  const table: ResultTable = {
    id: `by_${by}`, title: `NPS by ${labelOf(ds, by)}`,
    columns: [
      { key: "group", label: labelOf(ds, by) }, { key: "letter", label: "" }, { key: "n", label: "n", type: "count" },
      { key: "promoters", label: "Promoters %", type: "pct", decimals: 1 }, { key: "passives", label: "Passives %", type: "pct", decimals: 1 }, { key: "detractors", label: "Detractors %", type: "pct", decimals: 1 },
      { key: "nps", label: "NPS", type: "number", decimals: 1 }, { key: "lo", label: `${pct}% CI low`, type: "number", decimals: 1 }, { key: "hi", label: `${pct}% CI high`, type: "number", decimals: 1 },
      { key: "sig", label: multi ? "Not tested (overlapping groups)" : `Higher than (${pct}%)`, type: "sig" },
    ],
    rows: rows.map((r) => ({ group: r.group, letter: r.letter, n: r.n, promoters: r1(r.promoters), passives: r1(r.passives), detractors: r1(r.detractors), nps: r1(r.nps), lo: r1(r.lo), hi: r1(r.hi), sig: r.small ? "n<30" : r.sig })),
  } as ResultTable;
  void v;
  return { table, tests, notes, rows };
}
