import type { AnalysisRun } from "./findings.js";
import { waveNumbers } from "./waves.js";
import type { NarrativeSections } from "./deck.js";

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
 * Numbers up to ten pass as counting words ("two of the three tests");
 * years do not need to be in the run.
 */
export interface NarrativeCandidate { headline?: unknown; summary?: unknown; implications?: unknown; recommendations?: unknown }
export interface NarrativeRejection { section: keyof NarrativeSections; text: string; reason: string }
export interface GatedNarrative { accepted: NarrativeSections; rejected: NarrativeRejection[]; /** how many sentences were offered and how many kept */ offered: number; kept: number }

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

const SMALL = 10;
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 400)) : typeof v === "string" && v.trim() ? [v.trim().slice(0, 400)] : []).slice(0, max);

/** why a sentence fails the gate, or null when it passes */
export function sentenceProblem(text: string, numbers: Set<string>, verdicts: RunForGate["verdicts"]): string | null {
  for (const m of text.match(NUM) ?? []) {
    const n = norm(m);
    const v = Number(n);
    if (Number.isInteger(v) && Math.abs(v) <= SMALL && !m.endsWith("%")) continue;
    if (/^(?:19|20)\d\d$/.test(n)) continue;
    if (!numbers.has(n)) return `the number ${m} is not in the run`;
  }
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

/** The candidate narrative, sentence by sentence, against the run. */
export function gateNarrative(run: RunForGate, candidate: NarrativeCandidate): GatedNarrative {
  const numbers = runNumbers(run);
  const rejected: NarrativeRejection[] = [];
  let offered = 0, kept = 0;
  const section = (key: keyof NarrativeSections, items: string[]): string[] => {
    const ok: string[] = [];
    for (const t of items) {
      offered++;
      const problem = sentenceProblem(t, numbers, run.verdicts);
      if (problem) rejected.push({ section: key, text: t, reason: problem });
      else { ok.push(t); kept++; }
    }
    return ok;
  };
  const headline = section("headline", strs(candidate.headline, 1));
  const summary = section("summary", strs(candidate.summary, 6));
  const implications = section("implications", strs(candidate.implications, 7));
  const recommendations = section("recommendations", strs(candidate.recommendations, 7));
  const accepted: NarrativeSections = { ...(headline[0] ? { headline: headline[0] } : {}), ...(summary.length ? { summary } : {}), ...(implications.length ? { implications } : {}), ...(recommendations.length ? { recommendations } : {}) };
  return { accepted, rejected, offered, kept };
}

/** the prompt's instructions for the model, and the shape it must answer in */
export const NARRATIVE_INSTRUCTIONS = `Write the story of this analysis run for the audience named, from the RUN BRIEF below and nothing else. Answer as JSON: {"headline": "<one sentence, the single most important finding>", "summary": ["<3-5 bullets: what we set out to learn, what we found>"], "implications": ["<3-5 bullets: what each verdict means for the objective>"], "recommendations": ["<3-5 bullets: what to do next, as the evidence calls for>"]}. Rules: every number you write must appear in the brief exactly as printed there (a base, a p-value, an effect size, a mean, a share); name hypotheses by their label (H1, H2) and state only the verdict the brief gives; do not invent causes, segments or figures; plain sentences, no markdown.`;
