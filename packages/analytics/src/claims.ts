import { canonicalJson, hash64 } from "./canonical.js";
import type { AnalysisRun, Finding, Strength } from "./findings.js";
import type { AnalysisResult } from "./types.js";
import { waveNumbers } from "./waves.js";
import { PER_RESPONDENT_TABLES } from "./advancedNarrative.js";

/**
 * CLAIMS AND THE CLAIM-BOUND CHECKER (Data Analytics audit A-1, Phase 2).
 *
 * The narrative gate used to ask one question of a sentence: is every number
 * in it a number the RUN printed somewhere? Two means swapped between groups
 * passed (both are in the run), a causal verb passed, an invented quotation
 * passed, and any whole number up to ten passed whatever it counted.
 *
 * A CLAIM is one thing the engine established: the metric, the groups and
 * the value of each, the direction, the p (adjusted when a family was
 * corrected), the strength and the base. The model is shown claims with ids
 * and writes a sentence per claim, naming the ids it used. This checker then
 * holds the sentence to THOSE claims, not to the run:
 *
 *   - every number it prints belongs to a claim it cites (no integer is
 *     exempt, and no year: a figure is either in the claim or it is wrong);
 *   - a number sits next to the group it belongs to ("women 3.07, men 3.86"
 *     when women are 3.86 is refused);
 *   - the comparative word agrees with the values ("women score lower than
 *     men" when women are higher is refused) and an association's sign agrees
 *     with the sign the engine found;
 *   - it does not call a non-significant result significant, nor use a
 *     strength word above the claim's own label, nor claim proof;
 *   - it does not use a causal verb (the data show association);
 *   - a quotation must be a string the results contain, never an invented
 *     respondent;
 *   - a hypothesis it names exists and has the verdict it states.
 *
 * Pure and deterministic: the same sentence and claims give the same verdict,
 * so the evaluation set in `claims.test.ts` can pin it.
 */

export type ClaimLabel = "observed" | "statistically supported" | "exploratory" | "hypothesis" | "recommendation";

export interface ClaimGroup { label: string; value: number | null; n?: number }
export interface Claim {
  /** "C0" is the run itself (bases, counts, caveats); every other id is one finding, verdict or analysis */
  id: string;
  kind: "run" | "comparison" | "association" | "level" | "verdict" | "other";
  /** the sentence the engine wrote for it — the fallback wording when a model sentence fails */
  text: string;
  /** the result it came from, so a sentence can be traced back */
  source: { analysis?: string; hash?: string; finding?: string; hypothesis?: string };
  groups: ClaimGroup[];
  /** the sign of an association the engine found */
  sign?: "positive" | "negative";
  /** is it significant — adjusted for the family when the run corrected one — or null when no test was run */
  significant: boolean | null;
  strength?: Strength;
  label: ClaimLabel;
  /** every number this claim may print, normalised */
  numbers: string[];
  /** words a quotation may use: labels and question text */
  corpus: string;
  verdict?: { label: string; verdict: string };
}

/* ------------------------------------------------------------ numbers */

const NUM = /-?\d+(?:[.,]\d+)?%?/g;
/** a number as the checker compares it: "3.86" → "3.86", "26.6%" → "26.6", ".021" → "0.021", "1,200" → "1200" */
export const normNumber = (s: string): string => {
  let t = s.replace(/%$/, "").replace(/,(?=\d{3}\b)/g, "");
  if (t.startsWith(".")) t = `0${t}`;
  if (t.startsWith("-.")) t = `-0${t.slice(1)}`;
  return t.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};
/** every way a printed value may be written: rounded to 0–3 decimals, signed or not, and as a percentage when it is a share */
export function numberForms(x: number | null | undefined): string[] {
  if (x == null || !Number.isFinite(x)) return [];
  const out = new Set<string>();
  /* rounded to a whole number only when the value is itself 10 or more: 0.52 is not "1", and a stray 1 or 0 must not be excused by it */
  for (const d of [0, 1, 2, 3]) { if (d === 0 && Math.abs(x) < 10 && !Number.isInteger(x)) continue; if (x !== 0 && Number(x.toFixed(d)) === 0) continue; out.add(normNumber(x.toFixed(d))); out.add(normNumber(Math.abs(x).toFixed(d))); }
  out.add(normNumber(String(x))); out.add(normNumber(String(Math.abs(x))));
  if (Math.abs(x) <= 1) for (const d of [0, 1]) out.add(normNumber((x * 100).toFixed(d)));
  return [...out];
}
const textNumbers = (t: unknown): string[] => (typeof t === "string" ? (t.match(NUM) ?? []).map(normNumber) : []);

const WORDS: Record<string, number> = { zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
const UNITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).join("|")})(?:[- ](${Object.keys(UNITS).join("|")}))?\\b`, "gi");

/**
 * The numbers a sentence prints — digits, and spelled-out numbers ("seven",
 * "twenty-one", "a hundred"), since a figure written in words is still a
 * figure. Identifiers such as H1, Q3 and 2nd are names, and a range is two
 * numbers. "One" alone is a pronoun and is not read as a count.
 */
export function printedTokens(text: string): { norm: string; raw: string }[] {
  /* digits of any script are digits (2026-10-22): a narrative in Hindi or Arabic writes १२.५ or ١٢٫٥ and is checked like 12.5 */
  text = asciiDigits(text);
  const t = text.replace(/\b[A-Za-z]+\d+[A-Za-z0-9]*\b/g, " ").replace(/\b\d+(?:st|nd|rd|th)\b/gi, " ").replace(/(\d)-(?=\d)/g, "$1 ");
  const out: { norm: string; raw: string }[] = (t.match(NUM) ?? []).map((m) => ({ norm: normNumber(m), raw: m }));
  for (const m of t.matchAll(WORD_RE)) {
    const base = WORDS[m[1].toLowerCase()]; const unit = m[2] ? UNITS[m[2].toLowerCase()] : 0;
    const whole = base >= 20 && base < 100;
    out.push({ norm: String(base + (whole ? unit : 0)), raw: String(base + (whole ? unit : 0)) });
    if (m[2] && !whole) out.push({ norm: String(unit), raw: String(unit) });
  }
  return out;
}
/** the zero of each script's decimal digits (Unicode Nd blocks of ten) */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x17e0, 0x1810, 0xff10];
/** every decimal digit as its ASCII digit, and the Arabic decimal separator (٫) as a point */
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (ch) => { const cp = ch.codePointAt(0)!; const z = DIGIT_ZEROS.find((x) => cp >= x && cp < x + 10); return z === undefined ? ch : String(cp - z); }).replace(/(\d)\u066b(\d)/g, "$1.$2");
}
export const printedNumbers = (text: string): string[] => printedTokens(text).map((x) => x.norm);

/* ------------------------------------------------------------ building claims */

const addAll = (set: Set<string>, xs: Iterable<string>) => { for (const x of xs) set.add(x); };
const label = (f: Finding): ClaimLabel => (f.kind === "segment" || f.kind === "anomaly" || f.kind === "trend" || f.kind === "low_base" || f.kind === "inconclusive" ? "exploratory" : f.significant && (!f.evidence.adjusted || f.evidence.adjusted.significant) ? "statistically supported" : "observed");

function findingClaim(f: Finding, id: string): Claim {
  const e = f.evidence;
  const nums = new Set<string>();
  addAll(nums, textNumbers(f.headline)); addAll(nums, textNumbers(f.detail));
  for (const x of [e.n, e.p, e.effect?.value, e.statistic, e.adjusted?.p]) addAll(nums, numberForms(x));
  if (typeof e.df === "number") addAll(nums, numberForms(e.df)); else if (Array.isArray(e.df)) for (const d of e.df) addAll(nums, numberForms(d));
  for (const g of e.groups ?? []) { addAll(nums, numberForms(g.mean)); addAll(nums, numberForms(g.n)); }
  for (const p of e.pairwise?.pairs ?? []) for (const x of [p.meanA, p.meanB, p.p, p.pAdj]) addAll(nums, numberForms(x));
  const groups: ClaimGroup[] = (e.groups ?? []).map((g) => ({ label: g.label, value: g.mean, n: g.n }));
  /* a bootstrap interval has no p, but it does decide (2026-10-22): its claim is significant exactly when the interval excludes zero */
  const sig = e.test === "bootstrap_indirect" ? f.significant : e.p == null && !e.adjusted ? null : f.significant && (!e.adjusted || e.adjusted.significant);
  const kind: Claim["kind"] = groups.length >= 2 ? "comparison" : e.direction ? "association" : "other";
  return {
    id, kind, text: [f.headline, f.detail].filter(Boolean).join(" ").trim(),
    source: { analysis: f.analysis.id ?? f.analysis.name, hash: f.analysis.hash, finding: f.id, ...(f.hypotheses[0] ? { hypothesis: f.hypotheses[0] } : {}) },
    groups, ...(e.direction ? { sign: e.direction } : {}), significant: sig, strength: f.strength, label: label(f),
    numbers: [...nums], corpus: [f.headline, f.detail ?? "", ...f.variables, ...groups.map((g) => g.label)].join(" ").toLowerCase(),
  };
}

type RunForClaims = Pick<AnalysisRun, "n" | "findings" | "verdicts" | "warnings"> & { computedAt?: string; corrections?: AnalysisRun["corrections"]; discoveries?: AnalysisRun["discoveries"]; advice?: AnalysisRun["advice"]; kpis?: AnalysisRun["kpis"]; since?: AnalysisRun["since"] };

/** the claims of a run: C0 the run itself, then one per finding, per segment/trend/anomaly, and per hypothesis verdict */
export function claimsFromRun(run: RunForClaims): Claim[] {
  const claims: Claim[] = [];
  const pool = new Set<string>();
  const add = (x: number | null | undefined) => addAll(pool, numberForms(x));
  add(run.n); add(run.verdicts.length); add(run.findings.length);
  for (const w of run.warnings) addAll(pool, textNumbers(w));
  addAll(pool, textNumbers(run.corrections?.summary));
  for (const fam of run.corrections?.families ?? []) { add(fam.tests); add(fam.before); add(fam.after); }
  addAll(pool, textNumbers(run.discoveries?.summary));
  for (const a of run.advice ?? []) addAll(pool, textNumbers(a.summary));
  for (const k of run.kpis ?? []) { add(k.value); add(k.n); addAll(pool, textNumbers(k.target)); }
  if (run.since) { for (const x of waveNumbers(run.since)) add(x); addAll(pool, textNumbers(run.since.summary)); for (const k of run.since.kpis) add(k.p); }
  const year = run.computedAt?.slice(0, 4); if (year && /^\d{4}$/.test(year)) pool.add(year);
  claims.push({ id: "C0", kind: "run", text: `${run.n} completes in this run, ${run.findings.length} findings and ${run.verdicts.length} hypotheses read.`, source: {}, groups: [], significant: null, label: "observed", numbers: [...pool], corpus: [...run.warnings, run.corrections?.summary ?? "", run.discoveries?.summary ?? ""].join(" ").toLowerCase() });
  let i = 1;
  for (const f of run.findings) claims.push(findingClaim(f, `C${i++}`));
  for (const f of [...(run.discoveries?.segments ?? []), ...(run.discoveries?.trends ?? []), ...(run.discoveries?.anomalies ?? [])]) claims.push(findingClaim(f, `C${i++}`));
  for (const v of run.verdicts) {
    const nums = new Set<string>([...textNumbers(v.reason), ...textNumbers(v.corrected?.note), ...numberForms(v.analyses)]);
    claims.push({ id: `C${i++}`, kind: "verdict", text: `${v.label}: ${v.text}. ${v.reason}`, source: { hypothesis: v.label }, groups: [], significant: null, label: "hypothesis", numbers: [...nums], corpus: `${v.text} ${v.reason}`.toLowerCase(), verdict: { label: v.label, verdict: v.verdict } });
  }
  return claims;
}

/** the claims of a set of saved analyses (the report builder): C0 the brief, then one per analysis */
export function claimsFromItems(items: readonly { id: string; name: string; result: AnalysisResult }[], brief: { objective?: string; keyQuestions?: readonly string[] } = {}): Claim[] {
  const claims: Claim[] = [];
  const pool = new Set<string>([...numberForms(items.length)]);
  addAll(pool, textNumbers(brief.objective)); for (const q of brief.keyQuestions ?? []) addAll(pool, textNumbers(q));
  claims.push({ id: "C0", kind: "run", text: `${items.length} analyses.`, source: {}, groups: [], significant: null, label: "observed", numbers: [...pool], corpus: [brief.objective ?? "", ...(brief.keyQuestions ?? [])].join(" ").toLowerCase() });
  let i = 1;
  for (const it of items) {
    const r = it.result;
    const nums = new Set<string>();
    for (const k of ["total", "filtered", "n", "weightedN"] as const) addAll(nums, numberForms(r.base?.[k]));
    for (const t of r.insights) addAll(nums, textNumbers(t));
    for (const t of r.warnings) addAll(nums, textNumbers(t));
    for (const s of r.chart.series ?? []) { for (const v of s.values) addAll(nums, numberForms(v)); for (const v of s.errors ?? []) addAll(nums, numberForms(v)); }
    for (const k of r.chart.kpis ?? []) { addAll(nums, numberForms(typeof k.value === "number" ? k.value : NaN)); addAll(nums, numberForms(k.delta)); }
    /* a table with one row per respondent (HB individual utilities, LCA membership — 2026-10-22) is not a claim: its thousands of numbers would excuse almost any figure */
    for (const t of r.tables) { if (PER_RESPONDENT_TABLES.has(t.id)) continue; for (const row of t.rows) for (const v of Object.values(row)) { if (typeof v === "number") addAll(nums, numberForms(v)); else addAll(nums, textNumbers(v)); } }
    for (const t of r.tests) { for (const x of [t.statistic, t.p, t.effectSize?.value]) addAll(nums, numberForms(x)); if (typeof t.df === "number") addAll(nums, numberForms(t.df)); else if (Array.isArray(t.df)) for (const d of t.df) addAll(nums, numberForms(d)); }
    /* a single-series bar chart is a comparison: each category's value is a group */
    const cats = r.chart.categories; const one = r.chart.series?.length === 1 ? r.chart.series[0] : null;
    const groups: ClaimGroup[] = cats && one ? cats.map((c, k) => ({ label: String(c), value: typeof one.values[k] === "number" ? one.values[k] : null })) : [];
    const tested = r.tests.find((t) => t.p != null);
    claims.push({
      id: `C${i++}`, kind: groups.length >= 2 ? "comparison" : "other", text: r.insights.slice(0, 2).join(" ") || it.name,
      source: { analysis: it.id, hash: r.definitionHash }, groups, significant: tested ? (tested.p as number) < 0.05 : null,
      label: tested && (tested.p as number) < 0.05 ? "statistically supported" : "observed", numbers: [...nums],
      corpus: [it.name, ...r.insights, ...r.warnings, ...(cats ?? [])].join(" ").toLowerCase(),
    });
  }
  return claims;
}

/** the claims, as the model is shown them: an id and the engine's own sentence — never a table */
export function claimsBrief(claims: readonly Claim[], opts: { max?: number } = {}): string {
  const max = opts.max ?? 40;
  const lines = claims.filter((c) => c.id !== "C0").slice(0, max).map((c) => `[${c.id}]${c.significant === false ? " (not significant)" : ""} ${c.text}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------ the checker */

const HIGHER = /\b(higher|more|greater|above|exceed(?:s|ed|ing)?|outscor(?:e|es|ed|ing)|outperform(?:s|ed|ing)?|ahead of|leads?|leading)\b/g;
const LOWER = /\b(lower|less|fewer|below|trail(?:s|ed|ing)?|behind|lag(?:s|ged|ging)?|underperform(?:s|ed|ing)?|smaller)\b/g;
const CAUSAL = /\b(caus(?:e|es|ed|ing)|because(?: of)?|due to|leads? to|led to|leading to|drives?|driven by|drove|results? in|resulted in|brings? about|responsible for|as a result of|thanks to|owing to|triggers?|triggered|the reason (?:for|why)|explains why)\b/i;
/** a question or a hypothesis names a cause without asserting one: "on what drives the gap", "whether price causes churn" */
const ASKING = /\b(?:what|which|whether|why|how|if)\b(?:\s+\w+){0,2}?\s+(?:caus\w*|driv\w+|drove|lead\w*|led|result\w*|explain\w*)\b/gi;
const PROOF = /\b(prove[sd]?|proof|proven|conclusively|definitive(?:ly)?|undeniabl[ey]|beyond doubt|certainly causes?)\b/i;
const TIER3 = /\b(strong(?:ly)?|huge|dramatic(?:ally)?|massive(?:ly)?|overwhelming(?:ly)?|major|sharp(?:ly)?|enormous)\b/i;
const TIER2 = /\b(substantial(?:ly)?|large|considerabl[ey]|big|marked(?:ly)?|notabl[ey])\b/i;
const NEGATED_SIG = /\b(?:not|no|never|non|isn't|aren't|wasn't|weren't|nor|without)\b(?:\s+\w+){0,2}?\s+(?:statistically\s+)?significan(?:t|tly|ce)\b/gi;
const SAYS_POSITIVE = /\b(positive(?:ly)?|rises?|rising|increas(?:e|es|ed|ing)|grows?|goes up|go up|move together|higher .{0,30}\bwith\b)\b/i;
const SAYS_NEGATIVE = /\b(negative(?:ly)?|falls?|falling|decreas(?:e|es|ed|ing)|declin(?:e|es|ed|ing)|goes down|go down|inverse(?:ly)?|lower .{0,30}\bwith\b)\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SENTENCE_ONLY = (s: string) => s.replace(/\s+/g, " ").trim();

interface Mention { group: ClaimGroup; start: number; end: number }
function mentions(text: string, groups: readonly ClaimGroup[]): Mention[] {
  const low = text.toLowerCase();
  const out: Mention[] = [];
  for (const g of groups) {
    const l = g.label.trim().toLowerCase();
    if (l.length < 2) continue;
    const re = new RegExp(`(?<![a-z0-9])${esc(l)}(?![a-z0-9])`, "g");
    for (let m = re.exec(low); m; m = re.exec(low)) out.push({ group: g, start: m.index, end: m.index + l.length });
  }
  /* "men" inside "women" is not a mention of men: keep the longest match at any one place */
  return out.filter((a) => !out.some((b) => b !== a && b.start <= a.start && b.end >= a.end && (b.end - b.start) > (a.end - a.start))).sort((a, b) => a.start - b.start);
}

function directionProblem(text: string, claim: Claim): string | null {
  const gs = claim.groups.filter((g) => g.value != null);
  if (gs.length < 2) return null;
  const low = text.toLowerCase();
  const ms = mentions(text, gs);
  if (!ms.length) return null;
  /* 1. a number printed beside the wrong group. Two readings are tried: each number belongs to the group NEAREST it ("women score 3.86 against 3.07 for men"), or the numbers run in the order the groups are named ("women are more satisfied than men (3.86 against 3.07)"). Only a sentence neither reading can make true is refused. */
  const forms = (g: ClaimGroup) => new Set(numberForms(g.value));
  const printed: { text: string; at: number; owners: ClaimGroup[] }[] = [];
  for (const m of low.matchAll(new RegExp(NUM.source, "g"))) {
    const n = normNumber(m[0]);
    const owners = gs.filter((g) => forms(g).has(n));
    if (owners.length) printed.push({ text: m[0], at: m.index ?? 0, owners });
  }
  if (printed.length) {
    const nearest = printed.map((p) => {
      let near: Mention | null = null; let best = Infinity;
      for (const x of ms) { const d = x.end <= p.at ? p.at - x.end : x.start - (p.at + p.text.length); if (d < best && d <= 45) { best = d; near = x; } }
      return near;
    });
    const okNearest = printed.every((p, i) => !nearest[i] || p.owners.some((g) => g.label === nearest[i]!.group.label));
    const order: ClaimGroup[] = []; for (const x of ms) if (!order.includes(x.group)) order.push(x.group);
    const okOrder = order.length === printed.length && printed.every((p, i) => p.owners.some((g) => g.label === order[i].label));
    if (!okNearest && !okOrder) {
      const i = printed.findIndex((p, k) => nearest[k] && !p.owners.some((g) => g.label === nearest[k]!.group.label));
      return `${printed[i].text} is printed against ${nearest[i]!.group.label}, but it is ${printed[i].owners[0].label}'s`;
    }
  }
  /* 2. a comparative word that reads the wrong way round */
  const polar = (re: RegExp, sign: 1 | -1) => [...low.matchAll(re)].map((x) => ({ at: x.index ?? 0, end: (x.index ?? 0) + x[0].length, sign }));
  for (const w of [...polar(HIGHER, 1), ...polar(LOWER, -1)]) {
    const before = [...ms].reverse().find((x) => x.end <= w.at && w.at - x.end <= 60);
    const after = ms.find((x) => x.start >= w.end && x.start - w.end <= 60);
    const subject = before ?? null;
    let object: Mention | undefined = after;
    if (subject && !object && gs.length === 2) { const other = gs.find((g) => g.label !== subject.group.label); if (other) object = { group: other, start: 0, end: 0 }; }
    if (!subject || !object || subject.group.label === object.group.label) continue;
    const a = subject.group.value as number, b = object.group.value as number;
    if (a === b) continue;
    const actual = a > b ? 1 : -1;
    if (actual !== w.sign) return `${subject.group.label} is ${actual > 0 ? "higher" : "lower"} than ${object.group.label}, not ${w.sign > 0 ? "higher" : "lower"}`;
  }
  return null;
}

export interface SentenceCheck { problem: string | null }
export interface CheckContext { claims: readonly Claim[]; /** the claims the sentence cites; empty = infer */ cited?: readonly Claim[]; verdicts?: readonly { label: string; verdict: string }[] }

/** why a sentence fails against the claims it cites, or null */
export function claimProblem(text: string, cited: readonly Claim[], verdicts: readonly { label: string; verdict: string }[] = []): string | null {
  const t = SENTENCE_ONLY(text);
  /* numbers: each must be printed by a claim this sentence cites */
  const allowed = new Set<string>(); for (const c of cited) addAll(allowed, c.numbers);
  for (const n of printedTokens(t)) if (!allowed.has(n.norm)) return `the number ${n.raw} is not in ${cited.length ? `the cited ${cited.length === 1 ? "claim" : "claims"}` : "any claim it cites"}`;
  for (const c of cited) { const p = directionProblem(t, c); if (p) return p; }
  /* association sign */
  const signed = cited.find((c) => c.sign);
  if (signed) {
    const pos = SAYS_POSITIVE.test(t), neg = SAYS_NEGATIVE.test(t);
    if (signed.sign === "negative" && pos && !neg) return "the relationship is negative, not positive";
    if (signed.sign === "positive" && neg && !pos) return "the relationship is positive, not negative";
  }
  if (PROOF.test(t)) return "claims proof; the data can only support or fail to support";
  if (CAUSAL.test(t.replace(ASKING, " "))) return "causal wording; the results show association, not cause";
  /* significance and strength */
  const stripped = t.replace(NEGATED_SIG, " ");
  const saysSig = /\bsignifican(?:t|tly|ce)\b/i.test(stripped);
  const known = cited.filter((c) => c.significant !== null);
  if (saysSig && known.length && known.every((c) => c.significant === false)) return "calls a result significant that is not significant";
  const strengths = cited.map((c) => c.strength).filter((s): s is Strength => !!s);
  if (strengths.length) {
    const top = Math.max(...strengths.map((s) => ({ strong: 3, moderate: 2, weak: 1, none: 0 }[s])));
    if (TIER3.test(t) && top < 3) return `a strong-effect word on a ${top === 2 ? "moderate" : top === 1 ? "weak" : "negligible"} result`;
    if (TIER2.test(t) && top < 2) return `a large-effect word on a ${top === 1 ? "weak" : "negligible"} result`;
  }
  /* quotations */
  const corpus = cited.map((c) => `${c.corpus} ${c.text.toLowerCase()}`).join(" ");
  for (const m of t.matchAll(/["“]([^"”]{2,})["”]/g)) {
    const q = m[1].toLowerCase().replace(/[.,;:!?]+$/, "").trim();
    if (q && !corpus.includes(q)) return `the quotation "${m[1].trim()}" is not in the results`;
  }
  /* hypotheses */
  for (const h of t.match(/\bH\d+\b/g) ?? []) {
    const v = verdicts.find((x) => x.label === h);
    if (!v) return `${h} is not a hypothesis of this run`;
    const lower = t.toLowerCase();
    const says = /\b(?:not supported|unsupported|rejected|refuted|disproved)\b/.test(lower) ? "not_supported" : /\bsupported\b|\bconfirmed\b|\bholds\b/.test(lower) ? "supported" : null;
    if (says === "supported" && (v.verdict === "not_supported" || v.verdict === "untested")) return `${h} is ${v.verdict.replace(/_/g, " ")}, not supported`;
    if (says === "not_supported" && v.verdict === "supported") return `${h} is supported, not rejected`;
  }
  return null;
}

/** the claims a sentence with no cited id must have come from: one claim that holds all its numbers, or one plus the run's own figures */
export function inferClaims(text: string, claims: readonly Claim[]): Claim[] | null {
  const nums = printedNumbers(text);
  if (!nums.length) {
    /* no figures: bind by the groups and labels it names, so direction and significance are still held to a claim */
    const low = text.toLowerCase();
    return claims.filter((c) => c.kind !== "run" && c.groups.some((g) => g.label.length > 1 && low.includes(g.label.toLowerCase()))).slice(0, 3);
  }
  const holds = (set: readonly Claim[]) => nums.every((n) => set.some((c) => c.numbers.includes(n)));
  const run = claims.find((c) => c.kind === "run");
  const named = (c: Claim) => c.groups.filter((g) => text.toLowerCase().includes(g.label.toLowerCase())).length;
  const single = claims.filter((c) => c.kind !== "run" && holds([c])).sort((a, b) => named(b) - named(a));
  if (single.length) return [single[0]];
  if (run) { const withRun = claims.filter((c) => c.kind !== "run" && nums.some((n) => c.numbers.includes(n)) && holds([c, run])).sort((a, b) => named(b) - named(a)); if (withRun.length) return [withRun[0], run]; if (holds([run])) return [run]; }
  return null;
}

/** one model sentence in, one verdict out: cited ids resolve to claims, or the claims are inferred; either way the sentence is checked against them */
export function checkSentence(text: string, claims: readonly Claim[], cited: readonly string[] | undefined, verdicts: readonly { label: string; verdict: string }[] = []): { problem: string | null; claims: Claim[] } {
  let bound: Claim[];
  if (cited && cited.length) {
    const found = cited.map((id) => claims.find((c) => c.id === id));
    const missing = cited.find((id, i) => !found[i]);
    if (missing) return { problem: `${missing} is not a claim of this run`, claims: [] };
    bound = found as Claim[];
    /* the run's own figures are always citable beside a finding */
    const run = claims.find((c) => c.kind === "run"); if (run && !bound.includes(run)) bound = [...bound, run];
  } else {
    const inferred = inferClaims(text, claims);
    if (!inferred) { const n = printedTokens(text).find((x) => !claims.some((c) => c.numbers.includes(x.norm))); return { problem: n ? `the number ${n.raw} is not in the run` : "its numbers do not come from one result", claims: [] }; }
    bound = inferred;
  }
  return { problem: claimProblem(text, bound, verdicts), claims: bound.filter((c) => c.kind !== "run") };
}

export const sentenceLabel = (cited: readonly Claim[], section: string): ClaimLabel => {
  if (section === "recommendations") return "recommendation";
  const real = cited.filter((c) => c.kind !== "run");
  if (!real.length) return "observed";
  if (real.every((c) => c.label === "hypothesis")) return "hypothesis";
  if (real.some((c) => c.label === "exploratory")) return "exploratory";
  return real.every((c) => c.label === "statistically supported") ? "statistically supported" : "observed";
};

/** a stable id for a set of claims — the cache key's content half: the same claims, worded the same, are the same */
export function claimsHash(claims: readonly Claim[]): string {
  return hash64(canonicalJson(claims.map((c) => ({ id: c.id, text: c.text, numbers: [...c.numbers].sort(), groups: c.groups, sign: c.sign ?? null, significant: c.significant, strength: c.strength ?? null, label: c.label }))));
}

/** a stable id for a prompt's wording: it changes when the instructions change, so a reply cached under an old prompt is not served under the new one */
export function promptVersion(instructions: string): string { return `p_${hash64(instructions).slice(0, 10)}`; }
