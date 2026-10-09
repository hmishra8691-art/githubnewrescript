import type { SurveyDefinition } from "@rescript/schema";
import { defaultCuts, type DataQuery } from "@rescript/engine";
import type { Dataset } from "./dataset.js";
import { categoricalColumn, categoriesOf, filterDataset, labelOf, numericColumn, weights } from "./dataset.js";
import { describe } from "./stats/descriptive.js";
import { chiSquare, independentT, oneWayAnova, proportionCI, proportionTest, type TestResult } from "./stats/tests.js";
import { MIN_BASE } from "./analyses/common.js";
import { adjustP, pairwiseComparisons, CORRECTION_WORDS } from "./posthoc.js";
import { strengthOf } from "./findings.js";
import type { ChartData } from "./types.js";

/**
 * A DATA QUESTION, ANSWERED (Research Engine audit, Phase 4).
 *
 * The engine read the sentence into a `DataQuery`; this answers it on a
 * dataset — the share or the count of an answer, the average of a measure,
 * whether a measure differs by a cut (with the test and the pairs), which
 * groups choose an option more than the rest (every demographic, each
 * group against the others, corrected as a family), the most common
 * answer. Every answer names its base, its confidence interval where one
 * applies, and the test behind any "differs"; a base below 30 is said.
 */
export interface DataAnswerSection { title: string; items: { label: string; detail?: string }[] }
export interface DataAnswer {
  /** the answer in a sentence or two */
  text: string;
  sections: DataAnswerSection[];
  /** respondents the answer reads, after the population filter */
  n: number;
  evidence?: { test: string; statistic: number | null; p: number | null; effect?: { name: string; value: number }; significant: boolean; adjusted?: { method: string; p: number } };
  chart?: ChartData;
  caveats: string[];
}

const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);
const ci = (lo: number, hi: number) => `95% CI ${pct(lo)}–${pct(hi)}`;

const selected = (v: string | string[] | null, code: string) => v != null && (Array.isArray(v) ? v.includes(code) : v === code);

/** per group of `by`: the share of `option` among those who answered */
function sharesBy(ds: Dataset, variable: string, option: string, by: string): { label: string; x: number; n: number }[] {
  const cats = categoriesOf(ds, by);
  const vv = categoricalColumn(ds, variable), gv = categoricalColumn(ds, by);
  const acc = new Map<string, { x: number; n: number }>(cats.map((c) => [c.code, { x: 0, n: 0 }]));
  vv.forEach((v, i) => { const g = gv[i]; if (v == null || (Array.isArray(v) && !v.length) || g == null || Array.isArray(g)) return; const a = acc.get(g); if (!a) return; a.n++; if (selected(v, option)) a.x++; });
  return cats.map((c) => ({ label: c.label, ...acc.get(c.code)! })).filter((g) => g.n > 0);
}

function sigWord(t: TestResult, alpha: number) { return t.p != null && t.p < alpha ? "differs significantly" : "does not differ significantly"; }

export function answerDataQuery(def: SurveyDefinition, input: Dataset, q: DataQuery, opts: { alpha?: number } = {}): DataAnswer {
  const alpha = opts.alpha ?? 0.05;
  const caveats: string[] = [];
  const ds = q.population ? filterDataset(input, q.population.condition) : input;
  const n = ds.cases.length;
  const pop = q.population ? ` among ${q.population.words}` : "";
  const L = (v: string) => labelOf(ds, v);
  /** "Q7 — Brands considered" once, not "Q7 (Q7 — Brands considered)" */
  const V = L(q.variable).startsWith(q.question) ? L(q.variable) : `${q.question} — ${L(q.variable)}`;
  if (!ds.byName.has(q.variable)) return { text: `${q.variable} is not in this dataset — the question may have been added after fieldwork started.`, sections: [], n, caveats };
  if (!n) return { text: `No respondents${pop ? pop : " in the dataset yet"} — nothing to read.`, sections: [], n, caveats };
  if (n < MIN_BASE) caveats.push(`Base ${n}${pop} is below ${MIN_BASE}: read with caution.`);
  const w = weights(ds);
  if (w) caveats.push("Weighted data: shares and means are weighted; counts are respondents.");

  switch (q.kind) {
    case "share": case "count": {
      const col = categoricalColumn(ds, q.variable);
      const answered = col.filter((v) => v != null && !(Array.isArray(v) && !v.length)).length;
      if (!q.option) {
        const text = q.kind === "count" ? `${answered} of ${n} respondents${pop} answered ${V}.` : `${pct(answered / n)} of ${n} respondents${pop} answered ${V}.`;
        return { text, sections: [], n, caveats };
      }
      const x = col.filter((v) => selected(v, q.option!.code)).length;
      const interval = proportionCI(x, answered);
      const head = q.kind === "count" ? `${x} of ${answered} respondents${pop} chose “${q.option.label}” (${V}) — ${pct(x / Math.max(1, answered))}` : `${pct(x / Math.max(1, answered))} of respondents${pop} chose “${q.option.label}” (${V}, ${x} of ${answered})`;
      const text = `${head}${interval ? `, ${ci(interval[0], interval[1])}` : ""}.`;
      const sections: DataAnswerSection[] = [];
      let evidence: DataAnswer["evidence"];
      let chart: ChartData | undefined;
      if (q.by?.[0] && ds.byName.has(q.by[0])) {
        const by = q.by[0];
        const groups = sharesBy(ds, q.variable, q.option.code, by);
        const table = [groups.map((g) => g.x), groups.map((g) => g.n - g.x)];
        const t = groups.length >= 2 ? chiSquare(table) : null;
        sections.push({ title: `“${q.option.label}” by ${L(by)}`, items: groups.map((g) => ({ label: g.label, detail: `${pct(g.x / g.n)} (${g.x} of ${g.n})${g.n < MIN_BASE ? " — small base" : ""}` })) });
        if (t && t.p != null) evidence = { test: "chi_square", statistic: t.statistic, p: t.p, ...(t.effectSize?.value != null ? { effect: { name: t.effectSize.name, value: t.effectSize.value } } : {}), significant: t.p < alpha };
        chart = { categories: groups.map((g) => g.label), series: [{ name: `“${q.option.label}”`, values: groups.map((g) => Math.round((g.x / g.n) * 1000) / 10) }], valueFormat: "pct" };
        const hi = [...groups].sort((a, b) => b.x / b.n - a.x / a.n);
        return { text: `${text} By ${L(by)}: highest ${hi[0].label} (${pct(hi[0].x / hi[0].n)}), lowest ${hi[hi.length - 1].label} (${pct(hi[hi.length - 1].x / hi[hi.length - 1].n)})${t && t.p != null ? ` — the share ${sigWord(t, alpha)} by ${L(by)} (chi-square, ${fmtP(t.p)})` : ""}.`, sections, n, ...(evidence ? { evidence } : {}), ...(chart ? { chart } : {}), caveats };
      }
      return { text, sections, n, caveats };
    }
    case "mean": {
      const xs = numericColumn(ds, q.variable);
      const d = describe(xs, w);
      if (d.n === 0) return { text: `Nobody${pop} answered ${V} yet.`, sections: [], n, caveats };
      const text = `The average ${V}${pop} is ${fmt(d.mean)} (median ${fmt(d.median, 1)}, SD ${fmt(d.sd)}, n = ${d.n}${d.ci95 ? `, 95% CI ${fmt(d.ci95[0])}–${fmt(d.ci95[1])}` : ""}).`;
      if (!q.by?.[0] || !ds.byName.has(q.by[0])) return { text, sections: [], n, caveats };
      const by = q.by[0];
      const cats = categoriesOf(ds, by);
      const gv = categoricalColumn(ds, by);
      const groups = cats.map((c) => ({ label: c.label, values: xs.filter((v, i) => v != null && gv[i] === c.code) as number[] })).filter((g) => g.values.length > 0);
      const means = groups.map((g) => ({ label: g.label, d: describe(g.values) })).sort((a, b) => (b.d.mean ?? 0) - (a.d.mean ?? 0));
      const t = groups.length === 2 ? independentT(groups[0].values, groups[1].values, false) : groups.length > 2 ? oneWayAnova(groups) : null;
      const sections: DataAnswerSection[] = [{ title: `${L(q.variable)} by ${L(by)}`, items: means.map((m) => ({ label: m.label, detail: `${fmt(m.d.mean)} (n = ${m.d.n}${m.d.ci95 ? `, 95% CI ${fmt(m.d.ci95[0])}–${fmt(m.d.ci95[1])}` : ""})${m.d.n < MIN_BASE ? " — small base" : ""}` })) }];
      const evidence = t && t.p != null ? { test: t.test, statistic: t.statistic, p: t.p, ...(t.effectSize?.value != null ? { effect: { name: t.effectSize.name, value: t.effectSize.value } } : {}), significant: t.p < alpha } : undefined;
      const chart: ChartData = { categories: means.map((m) => m.label), series: [{ name: `Mean ${L(q.variable)}`, values: means.map((m) => m.d.mean == null ? null : Math.round(m.d.mean * 100) / 100), ci: means.map((m) => (m.d.ci95 ? [Math.round(m.d.ci95[0] * 100) / 100, Math.round(m.d.ci95[1] * 100) / 100] : null)) }] };
      return { text: `${text} By ${L(by)}: ${means.map((m) => `${m.label} ${fmt(m.d.mean)}`).join(", ")}${t && t.p != null ? ` — ${sigWord(t, alpha)} (${t.test === "anova_one_way" ? "ANOVA" : "Welch's t-test"}, ${fmtP(t.p)})` : ""}.`, sections, n, ...(evidence ? { evidence } : {}), chart, caveats };
    }
    case "compare": {
      const by = q.by?.[0];
      if (!by || !ds.byName.has(by)) return { text: `${q.by?.[0] ?? "the cut"} is not in this dataset.`, sections: [], n, caveats };
      const role = ds.byName.get(q.variable)?.role;
      if (role === "numeric" || role === "scale") {
        const xs = numericColumn(ds, q.variable);
        const cats = categoriesOf(ds, by);
        const gv = categoricalColumn(ds, by);
        const groups = cats.map((c) => ({ label: c.label, values: xs.filter((v, i) => v != null && gv[i] === c.code) as number[] })).filter((g) => g.values.length >= 2);
        if (groups.length < 2) return { text: `${L(by)} has fewer than two groups with data on ${L(q.variable)}${pop} — nothing to compare.`, sections: [], n, caveats };
        const t = groups.length === 2 ? independentT(groups[0].values, groups[1].values, false) : oneWayAnova(groups);
        const means = groups.map((g) => ({ label: g.label, d: describe(g.values) })).sort((a, b) => (b.d.mean ?? 0) - (a.d.mean ?? 0));
        const strength = strengthOf(t.effectSize?.value != null ? { name: t.effectSize.name, value: t.effectSize.value } : undefined, t.p, alpha);
        const sig = t.p != null && t.p < alpha;
        const pw = groups.length > 2 && sig ? pairwiseComparisons(ds, q.variable, by, { alpha }) : null;
        const hi = means[0], lo = means[means.length - 1];
        const text = `${sig ? "Yes" : "No"} — ${V} ${sig ? "differs" : "does not differ significantly"} by ${L(by)}${pop}: ${hi.label} ${fmt(hi.d.mean)} vs ${lo.label} ${fmt(lo.d.mean)}${means.length > 2 ? ` (${means.map((m) => `${m.label} ${fmt(m.d.mean)}`).join(", ")})` : ""} (${t.test === "anova_one_way" ? "ANOVA" : "Welch's t-test"}, ${fmtP(t.p)}${t.effectSize?.value != null ? `, ${t.effectSize.name} = ${fmt(t.effectSize.value)}${sig ? ` — ${strength === "none" ? "a negligible" : strength === "weak" ? "a small" : `a ${strength}`} effect` : ""}` : ""}).${pw ? ` ${pw.summary}` : ""}`;
        const sections: DataAnswerSection[] = [{ title: `${L(q.variable)} by ${L(by)}`, items: means.map((m) => ({ label: m.label, detail: `${fmt(m.d.mean)} (n = ${m.d.n}${m.d.ci95 ? `, 95% CI ${fmt(m.d.ci95[0])}–${fmt(m.d.ci95[1])}` : ""})${m.d.n < MIN_BASE ? " — small base" : ""}` })) }];
        if (pw?.significant.length) sections.push({ title: `Pairs that differ (${CORRECTION_WORDS[pw.method]}-adjusted)`, items: pw.significant.map((p) => ({ label: `${p.a} vs ${p.b}`, detail: `${fmt(p.meanA)} vs ${fmt(p.meanB)}, ${fmtP(p.pAdj)}` })) });
        const chart: ChartData = { categories: means.map((m) => m.label), series: [{ name: `Mean ${L(q.variable)}`, values: means.map((m) => m.d.mean == null ? null : Math.round(m.d.mean * 100) / 100), ci: means.map((m) => (m.d.ci95 ? [Math.round(m.d.ci95[0] * 100) / 100, Math.round(m.d.ci95[1] * 100) / 100] : null)) }] };
        return { text, sections, n, evidence: { test: t.test, statistic: t.statistic, p: t.p, ...(t.effectSize?.value != null ? { effect: { name: t.effectSize.name, value: t.effectSize.value } } : {}), significant: sig }, chart, caveats };
      }
      // a categorical outcome by a categorical cut: the chi-square and the answer whose share moves most
      const ca = categoriesOf(ds, q.variable), cb = categoriesOf(ds, by);
      const av = categoricalColumn(ds, q.variable), bv = categoricalColumn(ds, by);
      const table = ca.map(() => cb.map(() => 0));
      av.forEach((x, i) => { const y = bv[i]; if (x == null || y == null || Array.isArray(x) || Array.isArray(y)) return; const r = ca.findIndex((c) => c.code === x), c = cb.findIndex((c) => c.code === y); if (r >= 0 && c >= 0) table[r][c]++; });
      const t = chiSquare(table);
      if (t.p == null) return { text: `${L(q.variable)} by ${L(by)}${pop} has too little data to test.`, sections: [], n, caveats };
      const colT = cb.map((_, j) => table.reduce((s, r) => s + r[j], 0));
      const rows = ca.map((c, i) => ({ label: c.label, shares: cb.map((_, j) => (colT[j] ? table[i][j] / colT[j] : 0)) }));
      const spread = rows.map((r) => ({ r, gap: Math.max(...r.shares) - Math.min(...r.shares) })).sort((a, b) => b.gap - a.gap)[0];
      const sig = t.p < alpha;
      const hiJ = spread.r.shares.indexOf(Math.max(...spread.r.shares)), loJ = spread.r.shares.indexOf(Math.min(...spread.r.shares));
      const text = `${sig ? "Yes" : "No"} — ${V} ${sig ? "differs" : "does not differ significantly"} by ${L(by)}${pop} (chi-square, ${fmtP(t.p)}${t.effectSize?.value != null ? `, ${t.effectSize.name} = ${fmt(t.effectSize.value)}` : ""}). The answer that moves most is “${spread.r.label}”: ${pct(spread.r.shares[hiJ])} of ${cb[hiJ].label} vs ${pct(spread.r.shares[loJ])} of ${cb[loJ].label}.`;
      const sections: DataAnswerSection[] = [{ title: `${L(q.variable)} by ${L(by)} (column %)`, items: rows.map((r) => ({ label: r.label, detail: cb.map((c, j) => `${c.label} ${pct(r.shares[j])}`).join(" · ") })) }];
      const chart: ChartData = { matrix: { rows: rows.map((r) => r.label), columns: cb.map((c) => c.label), values: rows.map((r) => r.shares.map((s) => Math.round(s * 1000) / 10)) } };
      return { text, sections, n, evidence: { test: "chi_square", statistic: t.statistic, p: t.p, ...(t.effectSize?.value != null ? { effect: { name: t.effectSize.name, value: t.effectSize.value } } : {}), significant: sig }, chart, caveats };
    }
    case "prefer": {
      if (!q.option) return { text: "Which option? Name the answer to look for.", sections: [], n, caveats };
      const cuts = (q.by?.length ? q.by : defaultCuts(def)).filter((c) => ds.byName.has(c) && c !== q.variable);
      const col = categoricalColumn(ds, q.variable);
      const answered = col.filter((v) => v != null && !(Array.isArray(v) && !v.length)).length;
      const x = col.filter((v) => selected(v, q.option!.code)).length;
      const overall = answered ? x / answered : 0;
      if (!cuts.length) return { text: `${pct(overall)} of respondents${pop} chose “${q.option.label}” (${V}, ${x} of ${answered}) — the survey has no demographic to cut this by.`, sections: [], n, caveats };
      type Hit = { cut: string; group: string; share: number; rest: number; n: number; p: number | null; pAdj: number | null; sig: boolean };
      const hits: Hit[] = [];
      const sections: DataAnswerSection[] = [];
      for (const cut of cuts) {
        const groups = sharesBy(ds, q.variable, q.option.code, cut);
        if (groups.length < 2) continue;
        const total = groups.reduce((s, g) => s + g.n, 0), totalX = groups.reduce((s, g) => s + g.x, 0);
        for (const g of groups) {
          const restN = total - g.n, restX = totalX - g.x;
          if (!g.n || !restN) continue;
          const t = proportionTest(g.x, g.n, restX, restN);
          hits.push({ cut, group: g.label, share: g.x / g.n, rest: restX / restN, n: g.n, p: t.p, pAdj: null, sig: false });
        }
        sections.push({ title: `“${q.option.label}” by ${L(cut)}`, items: groups.map((g) => ({ label: g.label, detail: `${pct(g.x / g.n)} (${g.x} of ${g.n})${g.n < MIN_BASE ? " — small base" : ""}` })) });
      }
      const adj = adjustP(hits.map((h) => h.p));
      hits.forEach((h, i) => { h.pAdj = adj[i]; h.sig = adj[i] != null && adj[i]! < alpha; });
      const above = hits.filter((h) => h.sig && h.share > h.rest && h.n >= MIN_BASE).sort((a, b) => (b.share - b.rest) - (a.share - a.rest));
      const below = hits.filter((h) => h.sig && h.share < h.rest && h.n >= MIN_BASE).sort((a, b) => (a.share - a.rest) - (b.share - b.rest));
      const say = (h: Hit) => `${h.group} (${L(h.cut)}: ${pct(h.share)} vs ${pct(h.rest)} of the rest, ${fmtP(h.pAdj)})`;
      const text = `${pct(overall)} of respondents${pop} chose “${q.option.label}” (${V}, ${x} of ${answered}). ${above.length ? `It is chosen more by ${above.map(say).join("; ")}` : `No group chooses it significantly more than the rest`}${below.length ? `, and less by ${below.map(say).join("; ")}` : ""} (${hits.length} groups across ${cuts.length} demographic${cuts.length === 1 ? "" : "s"}, each against the rest, Holm-adjusted).`;
      const best = above[0];
      return { text, sections, n, ...(best ? { evidence: { test: "proportion_two_sample", statistic: null, p: best.p, significant: true, adjusted: { method: "holm", p: best.pAdj ?? 1 } } } : {}), caveats };
    }
    case "top": {
      const cats = categoriesOf(ds, q.variable);
      const col = categoricalColumn(ds, q.variable);
      const answered = col.filter((v) => v != null && !(Array.isArray(v) && !v.length)).length;
      if (!answered) return { text: `Nobody${pop} answered ${V} yet.`, sections: [], n, caveats };
      const counts = cats.map((c) => ({ c, x: col.filter((v) => selected(v, c.code)).length })).sort((a, b) => b.x - a.x);
      const top = counts[0], second = counts[1];
      const multi = ds.byName.get(q.variable)?.role === "multi" || col.some((v) => Array.isArray(v));
      const text = `The most ${multi ? "chosen" : "common"} answer to ${V}${pop} is “${top.c.label}”: ${pct(top.x / answered)} (${top.x} of ${answered})${second ? `, ahead of “${second.c.label}” at ${pct(second.x / answered)}` : ""}.`;
      const sections: DataAnswerSection[] = [{ title: `${L(q.variable)}${pop}`, items: counts.map((k) => ({ label: k.c.label, detail: `${pct(k.x / answered)} (${k.x})` })) }];
      if (q.by?.[0] && ds.byName.has(q.by[0])) {
        const by = q.by[0];
        const gcats = categoriesOf(ds, by);
        const gv = categoricalColumn(ds, by);
        sections.push({ title: `Most ${multi ? "chosen" : "common"} by ${L(by)}`, items: gcats.map((g) => {
          const idx = col.map((v, i) => (gv[i] === g.code ? v : null));
          const gn = idx.filter((v) => v != null).length;
          const best = cats.map((c) => ({ c, x: idx.filter((v) => selected(v, c.code)).length })).sort((a, b) => b.x - a.x)[0];
          return { label: g.label, detail: gn && best ? `“${best.c.label}” ${pct(best.x / gn)} (n = ${gn})` : "no answers" };
        }).filter((i) => i.detail !== "no answers") });
      }
      const chart: ChartData = { categories: counts.map((k) => k.c.label), series: [{ name: L(q.variable), values: counts.map((k) => Math.round((k.x / answered) * 1000) / 10) }], valueFormat: "pct" };
      return { text, sections, n, chart, caveats };
    }
  }
}
