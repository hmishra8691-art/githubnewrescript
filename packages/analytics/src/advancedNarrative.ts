import type { AnalysisDefinition, AnalysisResult, ResultTable } from "./types.js";

/**
 * THE PLAIN-LANGUAGE READING OF AN ADVANCED RESULT (2026-10-22) — what
 * quantilope's co-pilot writes beside a chart, done the way this platform
 * writes anything about numbers: the ENGINE states the facts, the
 * diagnostics and the caveats from the result's own tables (every number it
 * prints is a number the result printed), and a model may add what the
 * result means for the objective only through the gated interpretation step
 * (`gateInterpretation` — the claim check), never the diagnostics.
 *
 *   advancedFacts       the facts and diagnostics of an HB, latent class, SEM,
 *                       bootstrap-mediation, ω or Gabor–Granger result, read
 *                       from its tables (null for any other result)
 *   advancedNarrative   the engine's interpretation: summary sentences, the
 *                       diagnostics with a status each, the caveats, and
 *                       whether the result may be read at all
 *   narrativeMarkdown   the same as a report block
 *   semPathDiagramSvg   a simple path diagram of an SEM result as SVG
 *
 * Deterministic and pure; English (the model's gated part is written in the
 * researcher's language).
 */

export type AdvancedMethod = "hb" | "latent_class" | "sem" | "mediation_bootstrap" | "omega" | "gabor_granger";
export type DiagnosticStatus = "ok" | "caution" | "fail";
export interface AdvancedDiagnostic { label: string; value: string; status: DiagnosticStatus; note?: string }
export interface AdvancedFacts {
  method: AdvancedMethod;
  /** the method in words */
  methodName: string;
  /** may the estimates be read — false when the model did not converge / was refused */
  valid: boolean;
  summary: string[];
  diagnostics: AdvancedDiagnostic[];
  caveats: string[];
}

/* tables with one row per respondent: their numbers are never a claim a sentence may cite (see claims.ts) */
export const PER_RESPONDENT_TABLES = new Set(["hb_individual", "hb_individual_sd", "lca_membership"]);

const tab = (r: AnalysisResult, id: string): ResultTable | undefined => r.tables.find((t) => t.id === id);
const rowOf = (t: ResultTable | undefined, re: RegExp, key = "m"): Record<string, unknown> | undefined => t?.rows.find((x) => re.test(String(x[key] ?? "")));
const val = (row: Record<string, unknown> | undefined, key = "v"): unknown => row?.[key];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : null);
/** a value as the table printed it: numbers unchanged (no re-rounding), text as is */
const show = (v: unknown): string => (v == null ? "—" : typeof v === "number" ? String(v) : String(v));
const pctShow = (v: unknown): string => (typeof v === "number" ? `${v}%` : show(v));

/** which advanced reading a definition + result is, if any */
export function advancedMethodOf(def: Pick<AnalysisDefinition, "kind" | "options">, result: Pick<AnalysisResult, "tables">): AdvancedMethod | null {
  if (def.kind === "hb") return "hb";
  if (def.kind === "lca") return "latent_class";
  if (def.kind === "sem") return "sem";
  if (def.kind === "regression" && result.tables.some((t) => t.id === "mediation_bootstrap")) return "mediation_bootstrap";
  if (def.kind === "reliability" && result.tables.some((t) => t.id === "omega")) return "omega";
  if (def.kind === "pricing" && result.tables.some((t) => t.id === "gg")) return "gabor_granger";
  return null;
}

const NAMES: Record<AdvancedMethod, string> = {
  hb: "Hierarchical Bayes (individual-level utilities)", latent_class: "Latent class analysis", sem: "Structural equation model",
  mediation_bootstrap: "Mediation with a bootstrapped indirect effect", omega: "Scale reliability (McDonald's ω)", gabor_granger: "Gabor–Granger demand",
};

export function advancedFacts(def: Pick<AnalysisDefinition, "kind" | "options" | "name">, result: AnalysisResult): AdvancedFacts | null {
  const method = advancedMethodOf(def, result);
  if (!method) return null;
  const out: AdvancedFacts = { method, methodName: NAMES[method], valid: !result.error, summary: [], diagnostics: [], caveats: [] };
  if (result.error) {
    out.valid = false;
    out.summary.push(result.error.code === "job_pending" ? `${NAMES[method]} is still running as a background job; nothing can be read from it yet.` : `The model gave no valid result: ${result.error.message}`);
    out.caveats.push("No estimates are reported, and none should be quoted, until a valid run exists.");
    return out;
  }
  switch (method) {
    case "hb": hbFacts(result, out); break;
    case "latent_class": lcaFacts(result, out); break;
    case "sem": semFacts(def, result, out); break;
    case "mediation_bootstrap": mediationFacts(result, out); break;
    case "omega": omegaFacts(result, out); break;
    case "gabor_granger": ggFacts(result, out); break;
  }
  return out;
}

function hbFacts(r: AnalysisResult, out: AdvancedFacts) {
  const dg = tab(r, "hb_diagnostics"), fit = tab(r, "hb_fit");
  const rhat = num(val(rowOf(dg, /Largest R̂/))), ess = num(val(rowOf(dg, /effective sample size/)));
  const converged = /^Converged/.test(String(val(rowOf(dg, /^Verdict$/)) ?? ""));
  out.diagnostics.push({ label: "Largest R̂", value: show(rhat), status: rhat == null ? "caution" : rhat > 1.1 ? "fail" : rhat > 1.05 ? "caution" : "ok", note: "below 1.1: the chains agree" });
  out.diagnostics.push({ label: "Smallest effective sample size", value: show(ess), status: ess == null ? "caution" : ess < 100 ? "caution" : "ok", note: "several hundred or more is comfortable" });
  if (!converged || !fit) {
    out.valid = false;
    out.summary.push("The chains did not converge, so the part-worths are withheld; run it again with a longer burn-in and more draws.");
    out.caveats.push("Do not quote any utility or importance from a run that did not converge.");
    return;
  }
  const rlh = num(val(rowOf(fit, /^Root likelihood/))), chance = num(val(rowOf(fit, /^Chance RLH/))), resp = num(val(rowOf(fit, /^Respondents$/)));
  const cert = val(rowOf(fit, /^Percent certainty/));
  out.diagnostics.push({ label: "RLH (chance)", value: `${show(rlh)} (${show(chance)})`, status: rlh != null && chance != null && rlh > chance * 1.5 ? "ok" : "caution", note: "the fit of each respondent's own choices, against guessing" });
  out.diagnostics.push({ label: "Percent certainty", value: show(cert), status: "ok" });
  const imp = tab(r, "hb_importance");
  if (imp?.rows.length) {
    const top = imp.rows.slice(0, 3).map((x) => `${String(x.attribute)} (${pctShow(x.mean)})`);
    out.summary.push(`Across ${show(resp)} respondents, ${top[0]} carries the most weight in the choices${top.length > 1 ? `, followed by ${top.slice(1).join(" and ")}` : ""} — the average of each respondent's own importance.`);
    const sdTop = imp.rows[0]?.sd;
    if (typeof sdTop === "number") out.summary.push(`Respondents differ on it: the importance of ${String(imp.rows[0].attribute)} varies with a standard deviation of ${show(sdTop)} points between people, which an aggregate model averages away.`);
  }
  const shares = tab(r, "hb_shares");
  if (shares?.rows.length) {
    const top = shares.rows.slice(0, 3).map((x) => `“${String(x.item)}” (${pctShow(x.share)})`);
    out.summary.push(`On individual utilities, ${top[0]} has the highest mean preference share${top.length > 1 ? `, then ${top.slice(1).join(" and ")}` : ""}.`);
  }
  out.summary.push(`The model fits the respondents' own choices with an RLH of ${show(rlh)} against ${show(chance)} by chance; individual utilities are in the respondent table and can feed the simulator.`);
  out.caveats.push("Individual utilities fit each respondent's own answers closely by construction — the RLH is an in-sample measure, not a forecast.");
  out.caveats.push("HB ignores survey weights; importances and shares describe the respondents, unweighted.");
  if (rhat != null && rhat > 1.05) out.caveats.push("R̂ is above 1.05: the chains agree only roughly — a longer run is advisable before decisions rest on small differences.");
  if (ess != null && ess < 100) out.caveats.push("A small effective sample size makes the posterior intervals imprecise.");
}

function lcaFacts(r: AnalysisResult, out: AdvancedFacts) {
  const fit = tab(r, "lca_fit"), sizes = tab(r, "lca_sizes");
  const rec = fit?.rows.find((x) => String(x.status ?? "").startsWith("lowest BIC"));
  const k = sizes ? sizes.rows.length : null;
  const sel = fit?.rows.find((x) => x.k === k);
  const entropy = num(sel?.entropy), smallest = num(sel?.smallest);
  out.diagnostics.push({ label: "Classes shown (lowest BIC)", value: `${show(k)} (${show(rec?.k ?? "—")})`, status: k != null && rec && rec.k === k ? "ok" : "caution", note: "BIC is the usual guide; the choice is not automatic" });
  out.diagnostics.push({ label: "BIC", value: show(sel?.bic), status: "ok" });
  out.diagnostics.push({ label: "Entropy", value: show(entropy), status: entropy == null ? "caution" : entropy < 0.6 ? "caution" : "ok", note: "1 = classes perfectly separated; below 0.6 the boundaries are fuzzy" });
  out.diagnostics.push({ label: "Smallest class", value: smallest == null ? "—" : `${smallest}%`, status: smallest != null && smallest < 5 ? "caution" : "ok" });
  if (!sizes || !k) { out.summary.push("No valid latent class solution could be selected."); out.valid = false; return; }
  const parts = sizes.rows.map((x) => `${String(x.cls)} ${pctShow(x.size)}`);
  out.summary.push(`The respondents fall into ${k} latent classes: ${parts.join(", ")} (estimated shares).`);
  /* the most distinctive answer of each class: the category whose probability in the class is furthest above the classes' average */
  const prof = tab(r, "lca_profiles");
  if (prof && k > 1) {
    for (let c = 0; c < Math.min(k, 6); c++) {
      let best: { row: Record<string, unknown>; gap: number } | null = null;
      for (const row of prof.rows) {
        const vals = Array.from({ length: k }, (_, j) => num(row[`c${j}`]) ?? 0);
        const mine = vals[c], others = (vals.reduce((t, v) => t + v, 0) - mine) / Math.max(1, k - 1);
        if (!best || mine - others > best.gap) best = { row, gap: mine - others };
      }
      if (best && best.gap > 10) out.summary.push(`${String(sizes.rows[c]?.cls ?? `Class ${c + 1}`)} stands out on “${String(best.row.indicator)}: ${String(best.row.category)}” (${pctShow(best.row[`c${c}`])} in the class).`);
    }
  }
  if (entropy != null && entropy < 0.6) out.caveats.push("Entropy is below 0.6: many respondents sit between classes, so a class label describes them loosely.");
  if (smallest != null && smallest < 5) out.caveats.push("The smallest class holds under 5% of respondents — it may not replicate in another sample.");
  if (rec && k != null && rec.k !== k) out.caveats.push(`The ${k}-class model is shown, while BIC is lowest at ${String(rec.k)} classes.`);
  const maxK = Math.max(...(fit?.rows.map((x) => num(x.k) ?? 0) ?? [0]));
  if (rec && num(rec.k) === maxK) out.caveats.push("The lowest BIC is at the largest number of classes tried — try a wider range before settling.");
  out.caveats.push("Classes are found from the indicators only; profile them on other variables with a crosstab of the assigned class. The model ignores weights and drops respondents with a missing indicator.");
}

function semFacts(def: Pick<AnalysisDefinition, "options">, r: AnalysisResult, out: AdvancedFacts) {
  const fit = tab(r, "sem_fit");
  const v = (re: RegExp) => val(rowOf(fit, re));
  const cfi = num(v(/^CFI$/)), tli = num(v(/^TLI$/)), srmr = num(v(/^SRMR$/)), df = num(v(/^df$/));
  const rm = String(v(/^RMSEA/) ?? "—"), rmsea = num(rm.split(" ")[0]);
  out.diagnostics.push({ label: "χ² (df), p", value: `${show(v(/^χ²$/))} (${show(df)}), p ${show(v(/^p \(χ²\)$/))}`, status: "ok", note: "sensitive to sample size" });
  out.diagnostics.push({ label: "CFI / TLI", value: `${show(cfi)} / ${show(tli)}`, status: cfi == null ? "caution" : cfi >= 0.95 ? "ok" : cfi >= 0.9 ? "caution" : "fail", note: "≥ .95 good, ≥ .90 acceptable" });
  out.diagnostics.push({ label: "RMSEA [90% CI]", value: rm, status: rmsea == null ? "caution" : rmsea <= 0.06 ? "ok" : rmsea <= 0.1 ? "caution" : "fail", note: "≤ .06 good, above .10 poor" });
  out.diagnostics.push({ label: "SRMR", value: show(srmr), status: srmr == null ? "caution" : srmr <= 0.08 ? "ok" : "caution", note: "≤ .08 good" });
  const good = (cfi ?? 0) >= 0.95 && (rmsea ?? 1) <= 0.06 && (srmr ?? 1) <= 0.08;
  out.summary.push(df === 0 ? "The model is just-identified (df = 0): it reproduces the data exactly, so its fit cannot be tested — only its estimates can be read." : `The model ${good ? "fits the data well by the conventional cut-offs" : "falls short of the conventional fit cut-offs on at least one index"} (CFI ${show(cfi)}, RMSEA ${rm}, SRMR ${show(srmr)}).`);
  const hp = (def.options?.hypothesisPaths && typeof def.options.hypothesisPaths === "object" ? def.options.hypothesisPaths : {}) as Record<string, string>;
  const pathH = (lhs: string, rhs: string) => Object.entries(hp).filter(([, p]) => String(p).replace(/\s+/g, "") === `${lhs}~${rhs}`).map(([h]) => h);
  for (const row of tab(r, "sem_structural")?.rows ?? []) {
    const p = String(row.p ?? ""), sig = p === "< .001" || (num(p.replace(/^\./, "0.")) ?? 1) < 0.05;
    const hs = pathH(String(row.lhs), String(row.rhs));
    out.summary.push(`${String(row.rhs)} → ${String(row.lhs)}${hs.length ? ` (${hs.join(", ")})` : ""}: standardised β = ${show(row.std)}, p ${p.startsWith("<") ? p : `= ${p}`} — ${sig ? `a significant ${(num(row.est) ?? 0) >= 0 ? "positive" : "negative"} association` : "not significant"}.`);
  }
  for (const row of tab(r, "sem_indirect")?.rows ?? []) {
    out.summary.push(`Indirect effect ${String(row.name)} (${String(row.expr)}) = ${show(row.est)}, p ${String(row.p)}${row.ci ? `, 95% CI ${String(row.ci)}` : ""} (delta method).`);
  }
  const r2 = tab(r, "sem_r2");
  if (r2?.rows.length) out.summary.push(`Variance explained: ${r2.rows.slice(0, 4).map((x) => `${String(x.variable)} R² = ${show(x.r2)}`).join("; ")}.`);
  if (!good && df !== 0) out.caveats.push("With fit below the cut-offs, the path estimates describe a model the data do not fully support — look at the largest residuals before interpreting paths.");
  out.caveats.push("A structural path is an association under the model's assumptions; a cross-sectional survey does not establish causation.");
  out.caveats.push("ML treats every indicator as continuous and drops incomplete cases (listwise); the model ignores weights.");
  for (const w of r.warnings.filter((x) => /unordered|nominal|listwise|Heywood|identified/i.test(x)).slice(0, 2)) out.caveats.push(w);
}

function mediationFacts(r: AnalysisResult, out: AdvancedFacts) {
  const bt = tab(r, "mediation_bootstrap"), med = tab(r, "mediation");
  const v = (re: RegExp) => val(rowOf(bt, re, "stat"), "value");
  const bca = String(v(/BCa CI/) ?? "—"), perc = String(v(/percentile CI/) ?? "—");
  const ind = v(/^Indirect effect/);
  const excl = (s: string) => { const m = /\[(-?[\d.]+), (-?[\d.]+)\]/.exec(s); return m ? Number(m[1]) > 0 || Number(m[2]) < 0 : false; };
  out.diagnostics.push({ label: "95% BCa interval", value: bca, status: "ok", note: "excludes zero → the indirect path is supported" });
  out.diagnostics.push({ label: "95% percentile interval", value: perc, status: excl(bca) === excl(perc) ? "ok" : "caution", note: excl(bca) === excl(perc) ? "agrees with BCa" : "disagrees with BCa about zero" });
  out.diagnostics.push({ label: "Bootstrap SE", value: show(v(/^Bootstrap SE/)), status: "ok" });
  const title = med?.title.replace(/^Mediation: /, "") ?? "the mediation";
  out.summary.push(`Through ${title}: the indirect effect is ${show(ind)}, with a 95% bootstrap BCa interval of ${bca} — ${excl(bca) ? "the interval excludes zero, so part of the association runs through the mediator" : "the interval includes zero, so an indirect path is not supported by these data"}.`);
  const direct = med?.rows.find((x) => /^c′/.test(String(x.path ?? "")));
  if (direct) out.summary.push(`The direct path that remains is ${show(direct.estimate)} (p ${String(direct.p)}).`);
  if (excl(bca) !== excl(perc)) out.caveats.push("The percentile and BCa intervals disagree about zero: read the indirect effect as borderline.");
  out.caveats.push("Mediation in a cross-sectional survey shows a pattern consistent with the path, not that the mediator causes the outcome.");
}

function omegaFacts(r: AnalysisResult, out: AdvancedFacts) {
  const om = tab(r, "omega");
  const v = (re: RegExp) => val(rowOf(om, re, "stat"), "value");
  const omega = num(v(/ω/)), alpha = num(v(/α/)), df = num(v(/^df$/)), cfi = num(v(/^CFI$/));
  out.diagnostics.push({ label: "McDonald's ω", value: show(omega), status: omega == null ? "caution" : omega >= 0.7 ? "ok" : omega >= 0.6 ? "caution" : "fail", note: "≥ .70 acceptable for a research scale" });
  out.diagnostics.push({ label: "Cronbach's α", value: show(alpha), status: "ok" });
  if (df != null && df > 0) out.diagnostics.push({ label: "One-factor CFI", value: show(cfi), status: cfi != null && cfi >= 0.9 ? "ok" : "caution", note: "ω assumes one factor" });
  const word = omega == null ? "—" : omega >= 0.9 ? "excellent" : omega >= 0.8 ? "good" : omega >= 0.7 ? "acceptable" : omega >= 0.6 ? "questionable" : "poor";
  out.summary.push(`The scale's reliability is ${word}: McDonald's ω = ${show(omega)} (Cronbach's α = ${show(alpha)}). ω does not assume the items load equally, so where they differ it is the better estimate.`);
  if (df === 0) out.caveats.push("With three items the one-factor model is just-identified, so whether one factor is enough cannot be tested.");
  for (const w of r.warnings.filter((x) => /negatively|fits poorly/.test(x))) out.caveats.push(w);
}

function ggFacts(r: AnalysisResult, out: AdvancedFacts) {
  const gg = tab(r, "gg");
  if (!gg?.rows.length) return;
  const best = [...gg.rows].sort((a, b) => (num(b.revenue) ?? 0) - (num(a.revenue) ?? 0))[0];
  const first = gg.rows[0], last = gg.rows[gg.rows.length - 1];
  out.diagnostics.push({ label: "Price points", value: String(gg.rows.length), status: gg.rows.length >= 4 ? "ok" : "caution", note: "four or more give a usable curve" });
  out.summary.push(`The revenue index peaks at a price of ${show(best.price)}, where ${pctShow(best.probability)} would buy (revenue index ${show(best.revenue)}).`);
  out.summary.push(`Stated purchase likelihood falls from ${pctShow(first.probability)} at ${show(first.price)} to ${pctShow(last.probability)} at ${show(last.price)}.`);
  out.caveats.push("Stated intent overstates real purchase; read the curve's shape and the revenue-maximising point, not the levels.");
  out.caveats.push("Asking the prices in sequence anchors respondents; the curve is for the price range asked, not beyond it.");
}

/* ------------------------------------------------------------ the engine's narrative */

export interface AdvancedNarrative extends AdvancedFacts {
  title: string;
  /** hypotheses the item serves, with the run's verdict when one was handed in */
  hypotheses: { label: string; text?: string; verdict?: string }[];
  /** who wrote the words */
  source: "engine";
}

export function advancedNarrative(def: Pick<AnalysisDefinition, "kind" | "options" | "name">, result: AnalysisResult, ctx: { objective?: string; hypotheses?: { label: string; text: string }[]; verdicts?: { label: string; verdict: string }[] } = {}): AdvancedNarrative | null {
  const f = advancedFacts(def, result);
  if (!f) return null;
  const tagged = Array.isArray(def.options?.hypotheses) ? (def.options!.hypotheses as string[]) : [];
  const hypotheses = tagged.map((label) => ({ label, ...(ctx.hypotheses?.find((h) => h.label === label)?.text ? { text: ctx.hypotheses!.find((h) => h.label === label)!.text } : {}), ...(ctx.verdicts?.find((v) => v.label === label) ? { verdict: ctx.verdicts!.find((v) => v.label === label)!.verdict } : {}) }));
  const summary = [...f.summary];
  for (const h of hypotheses) if (h.verdict) summary.push(`${h.label}${h.text ? ` (“${h.text}”)` : ""}: the run reads it as ${h.verdict.replace(/_/g, " ")}.`);
  if (ctx.objective && f.valid) summary.unshift(`For the objective — ${ctx.objective.trim().replace(/[.]+$/, "")} — this is what the ${f.methodName.toLowerCase()} shows.`);
  return { ...f, summary, title: `${f.methodName}: ${def.name}`, hypotheses, source: "engine" };
}

const STATUS_MARK: Record<DiagnosticStatus, string> = { ok: "✓", caution: "⚠", fail: "✗" };
/** the narrative as markdown, for a report text block */
export function narrativeMarkdown(n: AdvancedNarrative, model?: { implications: string[]; recommendations: string[] } | null): string {
  const lines = [...n.summary.map((s) => `- ${s}`)];
  if (n.diagnostics.length) lines.push("", "**Diagnostics**", ...n.diagnostics.map((d) => `- ${STATUS_MARK[d.status]} ${d.label}: ${d.value}${d.note ? ` — ${d.note}` : ""}`));
  if (model && (model.implications.length || model.recommendations.length)) lines.push("", "**What it may mean** (an interpretation, checked against the numbers above)", ...model.implications.map((s) => `- ${s}`), ...(model.recommendations.length ? ["", "**Suggested next steps**", ...model.recommendations.map((s) => `- ${s}`)] : []));
  if (n.caveats.length) lines.push("", "**Caveats**", ...n.caveats.map((c) => `- ${c}`));
  return lines.join("\n");
}

/* ------------------------------------------------------------ the path diagram */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A SIMPLE PATH DIAGRAM of an SEM result (its chart's nodes and links): the
 * latent variables as ellipses in columns by structural depth (exogenous
 * first), each with its indicators as boxes below, loadings and paths as
 * arrows labelled with the standardised coefficient. Self-contained SVG with
 * no fonts or scripts; null when the result has no structure to draw.
 */
export function semPathDiagramSvg(result: Pick<AnalysisResult, "chart">): string | null {
  const nodes = result.chart.nodes ?? [], links = result.chart.links ?? [];
  const latent = nodes.filter((n) => n.group === "latent").map((n) => n.id);
  if (!latent.length || !links.length) return null;
  const isLatent = new Set(latent);
  const structural = links.filter((l) => isLatent.has(l.source) && isLatent.has(l.target));
  const depth = new Map<string, number>(latent.map((l) => [l, 0]));
  for (let pass = 0; pass < latent.length; pass++) for (const l of structural) depth.set(l.target, Math.max(depth.get(l.target) ?? 0, (depth.get(l.source) ?? 0) + 1));
  const cols = new Map<number, string[]>();
  for (const l of latent) { const d = depth.get(l) ?? 0; cols.set(d, [...(cols.get(d) ?? []), l]); }
  const indicators = (f: string) => links.filter((l) => l.source === f && !isLatent.has(l.target));
  const colW = 230, boxW = 64, boxH = 26, ellW = 120, ellH = 44, gapY = 150;
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const [d, fs] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    fs.forEach((f, i) => pos.set(f, { x: 40 + d * colW + colW / 2, y: 80 + i * (gapY + 40) }));
    maxRows = Math.max(maxRows, fs.length);
  }
  const width = 80 + cols.size * colW, height = 110 + maxRows * (gapY + 40);
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif" font-size="11">`,
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker></defs>`, `<rect width="100%" height="100%" fill="#fff"/>`];
  const label = (x: number, y: number, t: string) => parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" fill="#333">${esc(t)}</text>`);
  for (const f of latent) {
    const p = pos.get(f)!;
    const inds = indicators(f);
    const span = inds.length * (boxW + 8) - 8;
    inds.forEach((l, i) => {
      const bx = p.x - span / 2 + i * (boxW + 8) + boxW / 2, by = p.y + 95;
      parts.push(`<rect x="${(bx - boxW / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${boxW}" height="${boxH}" fill="#f4f6f8" stroke="#555"/>`);
      label(bx, by + 17, l.target.length > 10 ? `${l.target.slice(0, 9)}…` : l.target);
      parts.push(`<line x1="${p.x.toFixed(1)}" y1="${(p.y + ellH / 2).toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#555" marker-end="url(#ah)"/>`);
      label((p.x + bx) / 2 + 10, (p.y + ellH / 2 + by) / 2, l.value.toFixed(2));
    });
  }
  for (const l of structural) {
    const a = pos.get(l.source)!, b = pos.get(l.target)!;
    /* a path that skips a column (X → Y beside X → M → Y) arcs above the factors between, so neither its line nor its label hides behind them */
    if (Math.abs((depth.get(l.target) ?? 0) - (depth.get(l.source) ?? 0)) > 1 && Math.abs(b.y - a.y) < 1) {
      const top = a.y - ellH / 2, cy = top - 46;
      parts.push(`<path d="M${a.x.toFixed(1)},${top.toFixed(1)} Q${((a.x + b.x) / 2).toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${top.toFixed(1)}" fill="none" stroke="#1d4ed8" stroke-width="1.6" marker-end="url(#ah)"/>`);
      label((a.x + b.x) / 2, top - 26, l.value.toFixed(2));
      continue;
    }
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const x1 = a.x + (dx / len) * (ellW / 2), y1 = a.y + (dy / len) * (ellH / 2), x2 = b.x - (dx / len) * (ellW / 2), y2 = b.y - (dy / len) * (ellH / 2);
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#1d4ed8" stroke-width="1.6" marker-end="url(#ah)"/>`);
    label((x1 + x2) / 2, (y1 + y2) / 2 - 6, l.value.toFixed(2));
  }
  for (const f of latent) { const p = pos.get(f)!; parts.push(`<ellipse cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" rx="${ellW / 2}" ry="${ellH / 2}" fill="#eef2ff" stroke="#1d4ed8"/>`); label(p.x, p.y + 4, f.length > 18 ? `${f.slice(0, 17)}…` : f); }
  parts.push("</svg>");
  return parts.join("");
}
