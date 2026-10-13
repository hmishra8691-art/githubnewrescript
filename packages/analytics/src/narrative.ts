import type { AnalysisRun } from "./findings.js";
import { waveNumbers } from "./waves.js";
import type { NarrativeSections } from "./deck.js";
import { checkSentence, claimsFromRun, claimsBrief, sentenceLabel, printedTokens, type Claim, type ClaimLabel } from "./claims.js";

/**
 * THE NARRATIVE GATE (Research Engine audit, Phase 5).
 *
 * The model may WRITE the story — a headline, the summary bullets, what it
 * means, what to do next — from the run's brief and nothing else. The gate
 * is how "nothing else" is enforced: every number a sentence carries must
 * be a number the run printed (a base, a p, an effect, a mean, a share, a
 * count), every hypothesis it names must exist, and a verdict it states
 * must be the verdict the run gave. A sentence that fails is dropped with
 * the reason; a section left empty falls back to the engine's own text.
 * Phase 2 (A-1): the gate is CLAIM-BOUND. A sentence cites the claims it
 * rests on (see `claims.ts`) and is held to them — numbers, direction,
 * significance, strength, causal wording, quotations. No integer and no year
 * is exempt: a figure is in a cited claim or it is wrong. A sentence that
 * fails and cites a claim is replaced by the engine's own wording for that
 * claim and marked as such; one that cites nothing checkable is dropped.
 */
export interface NarrativeCandidate { headline?: unknown; summary?: unknown; implications?: unknown; recommendations?: unknown }
/** one sentence the model wrote, the claims it says it rests on, how it is labelled, and who wrote the words that stand */
export interface GatedSentence { section: keyof NarrativeSections; text: string; claims: string[]; label: ClaimLabel; source: "model" | "template" }
export interface NarrativeRejection { section: keyof NarrativeSections; text: string; reason: string }
export interface GatedNarrative { accepted: NarrativeSections; rejected: NarrativeRejection[]; /** how many sentences were offered and how many kept */ offered: number; kept: number; /** every sentence that stands, with the claims it cites and its label — what the audit record stores */ sentences: GatedSentence[]; /** sentences replaced by the engine's wording for the claim they cited */ replaced: number }

type RunForGate = Pick<AnalysisRun, "n" | "findings" | "verdicts" | "warnings"> & { corrections?: AnalysisRun["corrections"]; discoveries?: AnalysisRun["discoveries"]; advice?: AnalysisRun["advice"]; kpis?: AnalysisRun["kpis"]; since?: AnalysisRun["since"] };

const NUM = /-?\d+(?:[.,]\d+)?%?/g;
/** a number as the gate compares it: "3.86" → "3.86", "3.9" → "3.9", "26.6%" → "26.6", ".021" → "0.021", "1,200" → "1200" */
const norm = (s: string) => { let t = s.replace(/%$/, "").replace(/,(?=\d{3}\b)/g, ""); if (t.startsWith(".")) t = `0${t}`; if (t.startsWith("-.")) t = `-0${t.slice(1)}`; return t.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); };

/** every number the run printed, plus each at one decimal less, plus the counts a narrative may cite */
export function runNumbers(run: RunForGate): Set<string> {
  const out = new Set<string>();
  const add = (x: number | null | undefined) => {
    if (x == null || !Number.isFinite(x)) return;
    for (const d of [0, 1, 2, 3]) { out.add(norm(x.toFixed(d))); out.add(norm(Math.abs(x).toFixed(d))); }
    out.add(norm(String(x))); out.add(norm(String(Math.abs(x))));
    if (Math.abs(x) <= 1) { for (const d of [0, 1]) out.add(norm((x * 100).toFixed(d))); } // a share as a percentage
  };
  const addText = (t: string | undefined) => { for (const m of (t ?? "").match(NUM) ?? []) out.add(norm(m)); };
  add(run.n); add(run.verdicts.length); add(run.findings.length);
  for (const f of run.findings) {
    addText(f.headline); addText(f.detail);
    add(f.evidence.n); add(f.evidence.p); add(f.evidence.effect?.value); add(f.evidence.statistic); add(f.evidence.adjusted?.p);
    for (const g of f.evidence.groups ?? []) { add(g.mean); add(g.n); }
    for (const p of f.evidence.pairwise?.pairs ?? []) { add(p.meanA); add(p.meanB); add(p.pAdj); add(p.p); }
  }
  for (const v of run.verdicts) { addText(v.reason); addText(v.corrected?.note); add(v.analyses); }
  for (const w of run.warnings) addText(w);
  addText(run.corrections?.summary);
  for (const fam of run.corrections?.families ?? []) { add(fam.tests); add(fam.before); add(fam.after); }
  for (const f of [...(run.discoveries?.segments ?? []), ...(run.discoveries?.trends ?? []), ...(run.discoveries?.anomalies ?? [])]) { addText(f.headline); add(f.evidence.n); add(f.evidence.effect?.value); for (const g of f.evidence.groups ?? []) { add(g.mean); add(g.n); } }
  addText(run.discoveries?.summary);
  for (const a of run.advice ?? []) addText(a.summary);
  /* Phase 8: the KPIs and what moved since the last wave are the run's numbers too */
  for (const k of run.kpis ?? []) { add(k.value); add(k.n); addText(k.target); }
  if (run.since) { for (const x of waveNumbers(run.since)) add(x); addText(run.since.summary); for (const k of run.since.kpis) add(k.p); }
  return out;
}

/** a sentence the model offered: a bare string (no claim cited) or {claims, text} */
export interface OfferedSentence { text: string; claims: string[] }
export const offeredSentences = (v: unknown, max: number): OfferedSentence[] => {
  const one = (x: unknown): OfferedSentence | null => {
    if (typeof x === "string") return x.trim() ? { text: x.trim().slice(0, 400), claims: [] } : null;
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const text = typeof o.text === "string" ? o.text.trim().slice(0, 400) : "";
      const ids = Array.isArray(o.claims) ? o.claims : typeof o.claim === "string" ? [o.claim] : [];
      return text ? { text, claims: ids.filter((i): i is string => typeof i === "string").map((i) => i.trim().toUpperCase()).slice(0, 4) } : null;
    }
    return null;
  };
  return (Array.isArray(v) ? v.map(one) : [one(v)]).filter((x): x is OfferedSentence => !!x).slice(0, max);
};

/**
 * Why a sentence fails against the run's numbers, or null. Kept for callers
 * that hold a set of numbers rather than claims: the integer and year
 * exemptions are gone (a figure is in the set or it is wrong), identifiers
 * such as H1 are names, and the hypothesis verdicts are checked as before.
 * The full check — direction, significance, strength, causal wording,
 * quotations — needs claims: `checkSentence`.
 */
export function sentenceProblem(text: string, numbers: Set<string>, verdicts: RunForGate["verdicts"]): string | null {
  for (const n of printedTokens(text)) if (!numbers.has(n.norm)) return `the number ${n.raw} is not in the run`;
  for (const m of text.match(/\bH(\d+)\b/g) ?? []) {
    const v = verdicts.find((x) => x.label === m);
    if (!v) return `${m} is not a hypothesis of this run`;
    const lower = text.toLowerCase();
    const says = /\b(?:not supported|unsupported|rejected|refuted|disproved)\b/.test(lower) ? "not_supported" : /\bsupported\b|\bconfirmed\b|\bholds\b/.test(lower) ? "supported" : null;
    if (says === "supported" && (v.verdict === "not_supported" || v.verdict === "untested")) return `${m} is ${v.verdict.replace(/_/g, " ")}, not supported`;
    if (says === "not_supported" && v.verdict === "supported") return `${m} is supported, not rejected`;
  }
  return null;
}

/** The candidate narrative, sentence by sentence, against the claims of the run. */
export function gateNarrative(run: RunForGate, candidate: NarrativeCandidate, opts: { claims?: Claim[] } = {}): GatedNarrative {
  const claims = opts.claims ?? claimsFromRun(run);
  const rejected: NarrativeRejection[] = [];
  const sentences: GatedSentence[] = [];
  let count = 0, kept = 0, replaced = 0;
  const section = (key: keyof NarrativeSections, items: OfferedSentence[]): string[] => {
    const ok: string[] = [];
    for (const it of items) {
      count++;
      const r = checkSentence(it.text, claims, it.claims, run.verdicts);
      if (!r.problem) { ok.push(it.text); kept++; sentences.push({ section: key, text: it.text, claims: r.claims.map((c) => c.id), label: sentenceLabel(r.claims, key), source: "model" }); continue; }
      rejected.push({ section: key, text: it.text, reason: r.problem });
      /* the sentence failed but named a real claim: the engine's own wording for it stands, marked as the engine's — never for a recommendation, which has no claim to fall back on */
      const cited = key === "recommendations" ? undefined : it.claims.map((id) => claims.find((c) => c.id === id)).find((c): c is Claim => !!c && c.kind !== "run");
      if (cited && cited.text && !ok.includes(cited.text)) { ok.push(cited.text); replaced++; sentences.push({ section: key, text: cited.text, claims: [cited.id], label: sentenceLabel([cited], key), source: "template" }); }
    }
    return ok;
  };
  const headline = section("headline", offeredSentences(candidate.headline, 1));
  const summary = section("summary", offeredSentences(candidate.summary, 6));
  const implications = section("implications", offeredSentences(candidate.implications, 7));
  const recommendations = section("recommendations", offeredSentences(candidate.recommendations, 7));
  const accepted: NarrativeSections = { ...(headline[0] ? { headline: headline[0] } : {}), ...(summary.length ? { summary } : {}), ...(implications.length ? { implications } : {}), ...(recommendations.length ? { recommendations } : {}) };
  return { accepted, rejected, offered: count, kept, sentences, replaced };
}

/** the claims block of a run's prompt: ids the model cites, each with the engine's own sentence */
export const runClaimsBrief = (run: RunForGate): string => claimsBrief(claimsFromRun(run));

/** the prompt's instructions for the model, and the shape it must answer in */
export const NARRATIVE_INSTRUCTIONS = `Write the story of this analysis run for the audience named, from the CLAIMS below and nothing else. Each claim has an id such as C3. Answer as JSON where every sentence is an object naming the claim ids it rests on: {"headline": {"claims": ["C1"], "text": "<one sentence, the single most important finding>"}, "summary": [{"claims": ["C2"], "text": "<3-5 bullets: what we set out to learn, what we found>"}], "implications": [{"claims": ["C3"], "text": "<3-5 bullets: what each verdict means for the objective>"}], "recommendations": [{"claims": [], "text": "<3-5 bullets: what to do next, as the evidence calls for>"}]}. Rules: a sentence may use only the numbers of the claims it cites, exactly as printed there, and each number stays with the group it belongs to; say which group is higher only as the claim says; name hypotheses by their label (H1, H2) and state only the verdict given; never use a causal word (causes, because, due to, leads to, drives) - results show association; call a result significant only if its claim is not marked "(not significant)"; never put words in a respondent's mouth or use quotation marks for anything the claims do not contain; do not invent causes, segments or figures; recommendations are your suggestions, not findings, and carry no numbers; plain sentences, no markdown.`;
