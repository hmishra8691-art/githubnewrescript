import type { SurveyDefinition } from "@rescript/schema";

/**
 * DESIGN CALCULATORS (Level 5 roadmap A7 — 2026-11-23).
 *
 * The arithmetic a study design rests on, as pure functions an agent, a person or a script can call through the
 * tool registry (`design.*`). Each returns its number, the working that produced it, and the assumptions it made
 * where the caller gave none — so "why 385 completes" always has an answer that can be checked by hand.
 *
 *   sample size      for a margin of error; to detect a difference between two shares or two means
 *   precision        the margin a given sample gives; the smallest difference it can detect
 *   quota cells      targets from shares, summing exactly to the completes, with the cells too small to read flagged
 *   interview length from the questionnaire itself, by what each question asks of the respondent
 *   field estimate   starts and invitations from incidence, completion and response rates; cost from a price per complete
 *
 * The formulas are the standard closed forms (normal approximation, two-sided). The sample-size ones are the same
 * as @rescript/analytics' stats/sampleSize.ts, which a test in that package checks against these.
 *
 * Nothing here knows a price, an incidence or a response rate: those are inputs. Where one is missing the result
 * says what could not be worked out instead of assuming a market figure.
 */
export interface CalcResult<T> { ok: true; value: T; working: string[]; assumptions: string[] }
export interface CalcRefusal { ok: false; reason: string }
export type Calc<T> = CalcResult<T> | CalcRefusal;

const refuse = (reason: string): CalcRefusal => ({ ok: false, reason });
const up = (x: number) => Math.ceil(x - 1e-9);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
/** a share given as 0.3 or as 30 (per cent) */
const share = (v: unknown): number | null => { const n = num(v); return n == null ? null : n > 1 ? n / 100 : n; };
const pc = (p: number, dp = 1) => `${(p * 100).toFixed(dp).replace(/\.0+$/, "")}%`;

/** inverse of the standard normal CDF (Acklam's rational approximation, relative error under 1.2e-9) */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
/* ------------------------------------------------------------------ sample size */

export interface SampleSize { completes: number; perGroup?: number; groups?: number }

/** completes needed to estimate a share to within ± margin */
export function sampleForMargin(o: { margin?: unknown; share?: unknown; confidence?: unknown; population?: unknown; designEffect?: unknown }): Calc<SampleSize> {
  const margin = share(o.margin);
  if (margin == null || !(margin > 0 && margin < 0.5)) return refuse("The margin of error must be between 0 and 50% (for example 3 for ±3 points).");
  const assumptions: string[] = [];
  let p = share(o.share);
  if (p == null) { p = 0.5; assumptions.push("The share being estimated is taken as 50%, the case that needs the most completes."); }
  if (!(p > 0 && p < 1)) return refuse("The expected share must be between 0 and 100%.");
  let conf = share(o.confidence);
  if (conf == null) { conf = 0.95; assumptions.push("95% confidence."); }
  if (!(conf > 0.5 && conf < 1)) return refuse("The confidence level must be between 50% and 100%.");
  const deff = num(o.designEffect) ?? 1;
  if (!(deff >= 1 && deff <= 10)) return refuse("The design effect must be between 1 and 10.");
  const pop = num(o.population);
  if (pop != null && !(pop >= 1)) return refuse("The population must be a positive number.");
  const z = normalQuantile(1 - (1 - conf) / 2);
  const n0 = (z * z * p * (1 - p)) / (margin * margin);
  const n1 = pop ? n0 / (1 + (n0 - 1) / pop) : n0;
  const n = up(n1 * deff);
  const working = [`z = ${z.toFixed(3)} for ${pc(conf)} confidence`, `n = z² × p(1−p) ÷ E² = ${z.toFixed(3)}² × ${p} × ${(1 - p).toFixed(2)} ÷ ${margin}² = ${n0.toFixed(1)}`];
  if (pop) working.push(`finite population of ${pop.toLocaleString("en")}: ${n0.toFixed(1)} ÷ (1 + (${n0.toFixed(1)} − 1) ÷ ${pop}) = ${n1.toFixed(1)}`);
  else assumptions.push("The population is large compared with the sample (no finite-population correction).");
  if (deff !== 1) working.push(`× design effect ${deff} = ${(n1 * deff).toFixed(1)}`);
  else assumptions.push("A simple random sample (design effect 1). Weighting or clustering needs more.");
  working.push(`rounded up: ${n.toLocaleString("en")} completes`);
  return { ok: true, value: { completes: n }, working, assumptions };
}

/** completes needed to detect a difference between two groups: two shares (p1, p2) or a standardised mean difference (d) */
export function sampleForDifference(o: { share1?: unknown; share2?: unknown; effect?: unknown; alpha?: unknown; power?: unknown; groups?: unknown; designEffect?: unknown }): Calc<SampleSize> {
  const assumptions: string[] = [];
  let alpha = share(o.alpha);
  if (alpha == null) { alpha = 0.05; assumptions.push("Two-sided test at the 5% level."); }
  let power = share(o.power);
  if (power == null) { power = 0.8; assumptions.push("80% power: one real difference in five of this size would still be missed."); }
  if (!(alpha > 0 && alpha < 0.5)) return refuse("The significance level must be between 0 and 50%.");
  if (!(power > 0.5 && power < 1)) return refuse("Power must be between 50% and 100%.");
  const deff = num(o.designEffect) ?? 1;
  if (!(deff >= 1 && deff <= 10)) return refuse("The design effect must be between 1 and 10.");
  const groups = Math.round(num(o.groups) ?? 2);
  if (!(groups >= 2 && groups <= 50)) return refuse("The number of groups must be between 2 and 50.");
  const a = normalQuantile(1 - alpha / 2), b = normalQuantile(power);
  const p1 = share(o.share1), p2 = share(o.share2), d = num(o.effect);
  let n0: number; const working: string[] = [`z(α/2) = ${a.toFixed(3)}, z(β) = ${b.toFixed(3)}`];
  if (p1 != null && p2 != null) {
    if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1)) return refuse("Both shares must be between 0 and 100%.");
    if (p1 === p2) return refuse("The two shares are the same: there is no difference to detect.");
    const pbar = (p1 + p2) / 2;
    n0 = (a * Math.sqrt(2 * pbar * (1 - pbar)) + b * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p1 - p2) ** 2;
    working.push(`${pc(p1)} against ${pc(p2)}: (z(α/2)√(2p̄q̄) + z(β)√(p₁q₁ + p₂q₂))² ÷ (p₁ − p₂)² = ${n0.toFixed(1)} per group`);
  } else if (d != null) {
    if (!(Math.abs(d) > 0 && Math.abs(d) < 5)) return refuse("The standardised difference must be between 0 and 5 (0.2 is small, 0.5 medium, 0.8 large).");
    n0 = (2 * (a + b) ** 2) / (d * d) + (a * a) / 4;
    working.push(`standardised difference ${d}: 2(z(α/2) + z(β))² ÷ d² + z(α/2)² ÷ 4 = ${n0.toFixed(1)} per group`);
  } else return refuse("Give the two shares to tell apart (for example 40 and 50), or a standardised difference between two means.");
  if (deff !== 1) working.push(`× design effect ${deff} = ${(n0 * deff).toFixed(1)}`);
  const per = up(n0 * deff);
  working.push(`rounded up: ${per.toLocaleString("en")} per group, ${(per * groups).toLocaleString("en")} across ${groups} groups`);
  if (groups > 2) assumptions.push(`Each pair of the ${groups} groups is compared at the same level, with no correction for the number of comparisons.`);
  assumptions.push("Groups of equal size.");
  return { ok: true, value: { completes: per * groups, perGroup: per, groups }, working, assumptions };
}

/* ------------------------------------------------------------------ precision */

export interface Precision { marginPoints: number; detectablePoints?: number }

/** what a sample of this size gives: the margin of error on a share, and the smallest difference between two equal groups it can detect */
export function precisionOf(o: { completes?: unknown; share?: unknown; confidence?: unknown; designEffect?: unknown; groups?: unknown; power?: unknown; population?: unknown }): Calc<Precision> {
  const n = num(o.completes);
  if (n == null || !(n >= 2)) return refuse("The number of completes must be 2 or more.");
  const assumptions: string[] = [];
  let p = share(o.share);
  if (p == null) { p = 0.5; assumptions.push("A share of 50%, where the margin is widest."); }
  if (!(p > 0 && p < 1)) return refuse("The share must be between 0 and 100%.");
  let conf = share(o.confidence);
  if (conf == null) { conf = 0.95; assumptions.push("95% confidence."); }
  if (!(conf > 0.5 && conf < 1)) return refuse("The confidence level must be between 50% and 100%.");
  const deff = num(o.designEffect) ?? 1;
  if (!(deff >= 1 && deff <= 10)) return refuse("The design effect must be between 1 and 10.");
  const pop = num(o.population);
  const z = normalQuantile(1 - (1 - conf) / 2);
  const eff = n / deff;
  const fpc = pop && pop > n ? Math.sqrt((pop - n) / (pop - 1)) : 1;
  const margin = z * Math.sqrt((p * (1 - p)) / eff) * fpc;
  const working = [`effective sample ${eff.toFixed(0)}${deff !== 1 ? ` (${n} ÷ design effect ${deff})` : ""}`, `margin = z × √(p(1−p) ÷ n) = ${z.toFixed(3)} × √(${p} × ${(1 - p).toFixed(2)} ÷ ${eff.toFixed(0)})${fpc !== 1 ? ` × ${fpc.toFixed(3)} (finite population)` : ""} = ±${(margin * 100).toFixed(1)} points`];
  const value: Precision = { marginPoints: Math.round(margin * 1000) / 10 };
  const groups = Math.round(num(o.groups) ?? 0);
  if (groups >= 2) {
    let power = share(o.power);
    if (power == null) { power = 0.8; assumptions.push("80% power for the comparison between groups."); }
    const per = eff / groups, b = normalQuantile(power);
    const detectable = (z + b) * Math.sqrt((2 * p * (1 - p)) / per);
    value.detectablePoints = Math.round(detectable * 1000) / 10;
    working.push(`${groups} equal groups of ${per.toFixed(0)}: smallest difference detectable = (z(α/2) + z(β)) × √(2p(1−p) ÷ n per group) = ${(detectable * 100).toFixed(1)} points`);
  }
  return { ok: true, value, working, assumptions };
}

/* ------------------------------------------------------------------ quota cells */

export interface QuotaDimension { name: string; cells: { label: string; share: unknown }[] }
export interface QuotaCell { dimension: string; label: string; share: number; target: number; marginPoints: number; small: boolean }
export interface QuotaPlan { completes: number; cells: QuotaCell[]; interlocked: boolean; smallCells: number }

/** largest-remainder rounding: the targets are whole numbers and sum exactly to the total */
export function apportion(total: number, shares: number[]): number[] {
  const sum = shares.reduce((s, x) => s + x, 0);
  const exact = shares.map((s) => (sum ? (s / sum) * total : 0));
  const out = exact.map(Math.floor);
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]!.i]!++;
  return out;
}

/**
 * Quota targets from shares. Each dimension on its own ("independent": gender targets and age targets), or crossed
 * ("interlocked": a target for every gender × age cell, which is what the shares of the population require but
 * makes small cells quickly). A cell under `minimumCell` completes is flagged: its own results cannot be read.
 */
export function quotaCells(o: { completes?: unknown; dimensions?: unknown; interlocked?: unknown; minimumCell?: unknown }): Calc<QuotaPlan> {
  const completes = num(o.completes);
  if (completes == null || !(completes >= 1) || !Number.isInteger(completes)) return refuse("The number of completes must be a whole number of 1 or more.");
  const dims = Array.isArray(o.dimensions) ? (o.dimensions as QuotaDimension[]) : [];
  if (!dims.length) return refuse("Give at least one quota dimension with its cells and shares, for example gender: Male 49, Female 51.");
  if (dims.length > 4) return refuse("More than four quota dimensions cannot be filled in practice; use at most four.");
  const assumptions: string[] = [], working: string[] = [];
  const minCell = Math.round(num(o.minimumCell) ?? 30);
  if (num(o.minimumCell) == null) assumptions.push("A cell under 30 completes is treated as too small to report on its own.");
  const read: { name: string; cells: { label: string; share: number }[] }[] = [];
  for (const d of dims) {
    const name = String(d?.name ?? "").trim();
    const cells = Array.isArray(d?.cells) ? d.cells.map((c) => ({ label: String(c?.label ?? "").trim(), share: num(c?.share) })) : [];
    if (!name || cells.length < 2) return refuse(`Each quota dimension needs a name and at least two cells${name ? ` (${name} has ${cells.length})` : ""}.`);
    if (cells.some((c) => !c.label || c.share == null || c.share < 0)) return refuse(`Every cell of ${name} needs a label and a share of 0 or more.`);
    const total = cells.reduce((s, c) => s + (c.share as number), 0);
    if (!(total > 0)) return refuse(`The shares of ${name} add up to nothing.`);
    if (Math.abs(total - 100) > 0.5 && Math.abs(total - 1) > 0.005) assumptions.push(`The shares of ${name} add up to ${Math.round(total * 100) / 100}, not 100: they are scaled to 100%.`);
    read.push({ name, cells: cells.map((c) => ({ label: c.label, share: (c.share as number) / total })) });
  }
  const interlocked = o.interlocked === true || o.interlocked === "true";
  const z = normalQuantile(0.975);
  const cell = (dimension: string, label: string, sh: number, target: number): QuotaCell => ({ dimension, label, share: Math.round(sh * 1000) / 1000, target, marginPoints: target > 0 ? Math.round(z * Math.sqrt(0.25 / target) * 1000) / 10 : 0, small: target < minCell });
  const out: QuotaCell[] = [];
  if (interlocked && read.length > 1) {
    let combos: { label: string; share: number }[] = [{ label: "", share: 1 }];
    for (const d of read) combos = combos.flatMap((c) => d.cells.map((x) => ({ label: c.label ? `${c.label} × ${x.label}` : x.label, share: c.share * x.share })));
    if (combos.length > 400) return refuse(`Crossing these dimensions makes ${combos.length} cells; that cannot be managed. Cross fewer, or leave them independent.`);
    const targets = apportion(completes, combos.map((c) => c.share));
    combos.forEach((c, i) => out.push(cell(read.map((d) => d.name).join(" × "), c.label, c.share, targets[i]!)));
    working.push(`${read.map((d) => `${d.cells.length} ${d.name}`).join(" × ")} = ${combos.length} cells; each cell's share is the product of its dimensions' shares`);
    assumptions.push("The dimensions are independent in the population (a cell's share is the product of its dimensions' shares). If you have the real cross-distribution, give it as one dimension.");
  } else {
    for (const d of read) {
      const targets = apportion(completes, d.cells.map((c) => c.share));
      d.cells.forEach((c, i) => out.push(cell(d.name, c.label, c.share, targets[i]!)));
      working.push(`${d.name}: ${d.cells.map((c, i) => `${c.label} ${pc(c.share)} → ${targets[i]}`).join(", ")}`);
    }
    if (read.length > 1) assumptions.push("Each dimension is filled on its own; the combinations (for example young women) fall as they come.");
  }
  working.push(`targets rounded by largest remainder so each ${interlocked && read.length > 1 ? "set" : "dimension"} sums to ${completes.toLocaleString("en")}`);
  const small = out.filter((c) => c.small).length;
  if (small) working.push(`${small} of ${out.length} cells are under ${minCell} completes`);
  return { ok: true, value: { completes, cells: out, interlocked: interlocked && read.length > 1, smallCells: small }, working, assumptions };
}

/* ------------------------------------------------------------------ interview length */

/**
 * Seconds a respondent spends on one question, by what it asks of them. These are working rates for planning, not
 * measurements of this survey: once fieldwork has timings, those replace them. A caller can override any of them.
 */
export const LENGTH_RATES = {
  /** reading, per word of question and instruction text */
  perWord: 0.35,
  /** choosing one answer, plus scanning each option */
  single: 4, perOption: 0.6,
  /** choosing several */
  multi: 6, perOptionMulti: 1,
  /** one row of a grid */
  gridRow: 4,
  /** typing a number, a date, a short text */
  numeric: 7, shortText: 12,
  /** a considered open answer */
  longText: 45,
  /** ranking, per item */
  rankItem: 5,
  /** one choice task (conjoint, MaxDiff) */
  choiceTask: 20,
  /** anything not recognised */
  other: 8,
  /** share of display-conditioned questions a typical respondent sees */
  conditionalReach: 0.6,
  /** times a loop over a question's answers runs, as a share of its options, when nothing better is known */
  loopShare: 0.4,
} as const;
export type LengthRates = { -readonly [K in keyof typeof LENGTH_RATES]: number };

export interface LengthEstimate {
  typicalMinutes: number; longestMinutes: number;
  questions: number; conditional: number; loops: number;
  byKind: { kind: string; questions: number; seconds: number }[];
}

const words = (s: unknown): number => String(s ?? "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
type AnyQ = { id: string; type: string; text?: string; options?: unknown[]; rows?: unknown[]; columns?: unknown[]; displayLogic?: unknown; settings?: Record<string, unknown> };

function secondsFor(q: AnyQ, r: LengthRates): { kind: string; seconds: number } | null {
  const t = q.type, opts = q.options?.length ?? 0, rows = q.rows?.length ?? 0;
  const read = words(q.text) * r.perWord;
  if (/^(html|hidden|calculated|embedded_data|descriptive|text_block|page_timer)$/.test(t)) return t === "html" || t === "descriptive" || t === "text_block" ? { kind: "Text to read", seconds: read } : null;
  if (/matrix|grid/.test(t)) return { kind: "Grids", seconds: read + Math.max(1, rows) * r.gridRow + opts * r.perOption };
  if (/conjoint|maxdiff|cbc|choice_task/.test(t)) { const tasks = Number((q.settings as { tasks?: number } | undefined)?.tasks) || 8; return { kind: "Choice tasks", seconds: read + tasks * r.choiceTask }; }
  if (/rank/.test(t)) return { kind: "Ranking", seconds: read + Math.max(2, opts) * r.rankItem };
  if (/multi/.test(t)) return { kind: "Multiple choice", seconds: read + r.multi + opts * r.perOptionMulti };
  if (/single|dropdown|select|scale|rating|nps|likert|boolean|yes_no/.test(t)) return { kind: "Single choice and scales", seconds: read + r.single + opts * r.perOption };
  if (/long_text|essay|open/.test(t)) return { kind: "Open answers", seconds: read + r.longText };
  if (/numeric|number|date|time|slider/.test(t)) return { kind: "Numbers and dates", seconds: read + r.numeric };
  if (/text|email|phone|postcode/.test(t)) return { kind: "Short text", seconds: read + r.shortText };
  return { kind: "Other", seconds: read + r.other };
}

/** the interview length the questionnaire implies: a typical respondent, and one who sees everything */
export function interviewLength(def: SurveyDefinition, rates: Partial<LengthRates> = {}): Calc<LengthEstimate> {
  const r: LengthRates = { ...LENGTH_RATES, ...rates };
  const byId = new Map((def.questions as unknown as AnyQ[]).map((q) => [q.id, q]));
  /* how many times each question is asked: once, or once per pass of the loop it sits in */
  const times = new Map<string, { typical: number; longest: number }>();
  let loops = 0;
  const walk = (nodes: unknown[], typical: number, longest: number) => {
    for (const n of nodes as { type?: string; questionIds?: string[]; children?: unknown[]; source?: { kind?: string; items?: unknown[]; questionId?: string } }[]) {
      if (n.questionIds) for (const id of n.questionIds) times.set(id, { typical: (times.get(id)?.typical ?? 0) + typical, longest: (times.get(id)?.longest ?? 0) + longest });
      if (!n.children) continue;
      if (n.type === "loop") {
        loops++;
        const items = n.source?.kind === "static" ? (n.source.items?.length ?? 1) : (byId.get(n.source?.questionId ?? "")?.options?.length ?? 1);
        const usual = n.source?.kind === "static" ? items : Math.max(1, items * r.loopShare);
        walk(n.children, typical * usual, longest * items);
      } else walk(n.children, typical, longest);
    }
  };
  walk(def.flow as unknown[], 1, 1);
  /* shown on a condition: the question's own display logic, or a named display rule that shows it */
  const ruled = new Set(((def as { displayRules?: { target?: { kind?: string; ref?: string }; action?: string }[] }).displayRules ?? []).filter((x) => x.target?.kind === "question" && x.action !== "hide").map((x) => x.target!.ref!));
  let typical = 0, longest = 0, asked = 0, conditional = 0;
  const kinds = new Map<string, { questions: number; seconds: number }>();
  for (const q of def.questions as unknown as AnyQ[]) {
    const s = secondsFor(q, r);
    if (!s) continue;
    const t = times.get(q.id) ?? { typical: 1, longest: 1 };
    const isConditional = q.displayLogic != null || ruled.has(q.id);
    if (s.kind !== "Text to read") asked++;
    if (isConditional) conditional++;
    const usual = s.seconds * t.typical * (isConditional ? r.conditionalReach : 1);
    typical += usual; longest += s.seconds * t.longest;
    const k = kinds.get(s.kind) ?? { questions: 0, seconds: 0 };
    k.questions++; k.seconds += usual; kinds.set(s.kind, k);
  }
  if (!asked) return refuse("The survey has no question a respondent answers yet, so there is no length to estimate.");
  const min = (s: number) => Math.max(1, Math.round(s / 6) / 10);
  const byKind = [...kinds.entries()].map(([kind, v]) => ({ kind, questions: v.questions, seconds: Math.round(v.seconds) })).sort((a, b) => b.seconds - a.seconds);
  const working = byKind.map((k) => `${k.kind}: ${k.questions} question${k.questions === 1 ? "" : "s"}, about ${Math.round(k.seconds / 6) / 10} min`);
  working.push(`typical respondent: about ${min(typical)} minutes; one who sees every question and every loop pass: about ${min(longest)} minutes`);
  const assumptions = ["Working rates for planning (reading speed, seconds per answer by question type), not timings measured on this survey. Fieldwork timings replace them once they exist."];
  if (conditional) assumptions.push(`${conditional} question${conditional === 1 ? " has" : "s have"} a display condition; a typical respondent is taken to see ${pc(r.conditionalReach, 0)} of them.`);
  if (loops) assumptions.push(`${loops} loop${loops === 1 ? "" : "s"}: a loop over a question's answers is taken to run for ${pc(r.loopShare, 0)} of its options for a typical respondent.`);
  assumptions.push("Skips that end the interview early, and media that must be watched, are not counted.");
  return { ok: true, value: { typicalMinutes: min(typical), longestMinutes: min(longest), questions: asked, conditional, loops, byKind }, working, assumptions };
}

/* ------------------------------------------------------------------ field estimate */

export interface FieldEstimate { completes: number; starts?: number; invitations?: number; cost?: number; currency?: string; costPerComplete?: number; missing: string[] }

/** from completes back to starts and invitations, and forward to cost. Every rate is an input; none is assumed */
export function fieldEstimate(o: { completes?: unknown; incidence?: unknown; completionRate?: unknown; responseRate?: unknown; pricePerComplete?: unknown; currency?: unknown; fixedCost?: unknown; overQuotaRate?: unknown }): Calc<FieldEstimate> {
  const completes = num(o.completes);
  if (completes == null || !(completes >= 1)) return refuse("The number of completes must be 1 or more.");
  const rate = (v: unknown, name: string): number | null | CalcRefusal => { const x = share(v); if (x == null) return null; return x > 0 && x <= 1 ? x : refuse(`${name} must be above 0 and at most 100%.`); };
  const inc = rate(o.incidence, "Incidence"), comp = rate(o.completionRate, "The completion rate"), resp = rate(o.responseRate, "The response rate");
  for (const x of [inc, comp, resp]) if (x && typeof x === "object") return x;
  const over = share(o.overQuotaRate);
  if (over != null && !(over >= 0 && over < 1)) return refuse("The over-quota rate must be between 0 and 100%.");
  const working: string[] = [], assumptions: string[] = [], missing: string[] = [];
  const value: FieldEstimate = { completes, missing };
  if (inc != null) {
    let starts = completes / (inc as number);
    let line = `${completes.toLocaleString("en")} completes ÷ ${pc(inc as number)} incidence`;
    if (comp != null) { starts /= comp as number; line += ` ÷ ${pc(comp as number)} completion`; } else assumptions.push("Everyone who qualifies finishes (no completion rate given). Real surveys lose some; give the rate to include them.");
    if (over) { starts /= 1 - over; line += ` ÷ ${pc(1 - over)} not over quota`; }
    value.starts = up(starts);
    working.push(`${line} = ${value.starts.toLocaleString("en")} starts`);
    if (resp != null) { value.invitations = up(starts / (resp as number)); working.push(`${value.starts.toLocaleString("en")} starts ÷ ${pc(resp as number)} response = ${value.invitations.toLocaleString("en")} invitations`); }
    else missing.push("invitations (no response rate given)");
  } else missing.push("starts and invitations (no incidence given)");
  const price = num(o.pricePerComplete), fixed = num(o.fixedCost) ?? 0;
  if (price != null) {
    if (!(price >= 0) || !(fixed >= 0)) return refuse("Prices cannot be negative.");
    value.cost = Math.round((completes * price + fixed) * 100) / 100;
    value.costPerComplete = Math.round((value.cost / completes) * 100) / 100;
    if (typeof o.currency === "string" && o.currency.trim()) value.currency = o.currency.trim().slice(0, 8);
    working.push(`${completes.toLocaleString("en")} × ${price}${fixed ? ` + ${fixed} fixed` : ""} = ${value.cost.toLocaleString("en")}${value.currency ? ` ${value.currency}` : ""}`);
    assumptions.push("The price per complete is the one given. A vendor's price depends on incidence and length; the recruitment plan asks vendors for theirs.");
  } else missing.push("cost (no price per complete given)");
  return { ok: true, value, working, assumptions };
}
