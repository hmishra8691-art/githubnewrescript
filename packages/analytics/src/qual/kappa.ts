import type { QualExcerpt, QualState } from "./types.js";

/**
 * INTER-CODER AGREEMENT (2026-10-18) — Cohen's kappa per code, for two coders
 * who coded the same segments.
 *
 * The unit is a SEGMENT; for each code, each coder either applied it to the
 * segment (at least one excerpt of theirs that is not rejected) or did not.
 * Over the units both coders coded, the 2×2 table gives
 *
 *     po = (both + neither) / n                      observed agreement
 *     pe = pA·pB + (1 − pA)(1 − pB)                  agreement expected by chance
 *     κ  = (po − pe) / (1 − pe)
 *
 * κ is undefined (null) when pe = 1 — both coders applied the code to every
 * unit, or to none — and is reported as such rather than as 1 or 0. The units
 * are, unless given, the segments of every source in which BOTH coders made at
 * least one coding decision (a coder who never opened a transcript did not
 * "decide not to code" it). Disagreements are listed segment by segment.
 */

export interface KappaTable { both: number; onlyA: number; onlyB: number; neither: number }
export interface KappaResult extends KappaTable { n: number; po: number; pe: number; kappa: number | null }

export function cohenKappa(t: KappaTable): KappaResult {
  const n = t.both + t.onlyA + t.onlyB + t.neither;
  if (!n) return { ...t, n, po: 0, pe: 0, kappa: null };
  const po = (t.both + t.neither) / n;
  const pA = (t.both + t.onlyA) / n, pB = (t.both + t.onlyB) / n;
  const pe = pA * pB + (1 - pA) * (1 - pB);
  const kappa = Math.abs(1 - pe) < 1e-12 ? null : (po - pe) / (1 - pe);
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return { ...t, n, po: r(po), pe: r(pe), kappa: kappa === null ? null : r(kappa) };
}

/** Landis & Koch's words for a kappa — a convention, stated as one */
export function kappaWords(k: number | null): string {
  if (k === null) return "undefined (no variation)";
  if (k < 0) return "poor (below chance)";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

export interface CodeAgreement extends KappaResult { codeId: string; codeName: string; words: string; disagreements: { segmentKey: string; appliedBy: "A" | "B" }[] }
export interface AgreementReport {
  coderA: string; coderB: string;
  /** the units compared: "<sourceId>|<segmentId>" */
  units: string[];
  codes: CodeAgreement[];
  /** the mean of the defined kappas — a summary, not a pooled kappa */
  meanKappa: number | null;
  note: string;
}

const keyOf = (e: Pick<QualExcerpt, "sourceId" | "segmentId">) => `${e.sourceId}|${e.segmentId}`;
const live = (e: QualExcerpt) => e.status !== "rejected" || e.coder === "ai";

/**
 * Agreement between two coders on every code either of them applied.
 * `units` are segment keys ("<sourceId>|<segmentId>"); `allUnits`, when given, is every segment of
 * every source (so a source both coded contributes its uncoded segments as "neither").
 * The AI is a coder like any other (`"ai"`): its decisions are its suggestions, including the ones a
 * reviewer later rejected — which is how AI-versus-human agreement is read.
 */
export function agreement(state: QualState, coderA: string, coderB: string, opts: { units?: string[]; allUnits?: string[] } = {}): AgreementReport {
  const ex = state.excerpts.filter(live);
  const a = ex.filter((e) => e.coder === coderA), b = ex.filter((e) => e.coder === coderB);
  let units = opts.units;
  if (!units) {
    const srcA = new Set(a.map((e) => e.sourceId)), srcB = new Set(b.map((e) => e.sourceId));
    const both = new Set([...srcA].filter((x) => srcB.has(x)));
    const pool = opts.allUnits ?? [...new Set(ex.map(keyOf))];
    units = pool.filter((k) => both.has(k.split("|")[0]));
  }
  const unitSet = new Set(units);
  const codeIds = [...new Set([...a, ...b].filter((e) => unitSet.has(keyOf(e))).map((e) => e.codeId))];
  const names = new Map(state.codebook.codes.map((c) => [c.id, c.name]));
  const codes: CodeAgreement[] = codeIds.map((codeId) => {
    const inA = new Set(a.filter((e) => e.codeId === codeId).map(keyOf)), inB = new Set(b.filter((e) => e.codeId === codeId).map(keyOf));
    const t: KappaTable = { both: 0, onlyA: 0, onlyB: 0, neither: 0 };
    const disagreements: CodeAgreement["disagreements"] = [];
    for (const u of units!) {
      const x = inA.has(u), y = inB.has(u);
      if (x && y) t.both++; else if (x) { t.onlyA++; disagreements.push({ segmentKey: u, appliedBy: "A" }); } else if (y) { t.onlyB++; disagreements.push({ segmentKey: u, appliedBy: "B" }); } else t.neither++;
    }
    const k = cohenKappa(t);
    return { codeId, codeName: names.get(codeId) ?? codeId, ...k, words: kappaWords(k.kappa), disagreements };
  }).sort((x, y) => (x.kappa ?? 2) - (y.kappa ?? 2) || x.codeName.localeCompare(y.codeName));
  const defined = codes.map((c) => c.kappa).filter((k): k is number => k !== null);
  const meanKappa = defined.length ? Math.round((defined.reduce((s, k) => s + k, 0) / defined.length) * 10000) / 10000 : null;
  return { coderA, coderB, units, codes, meanKappa, note: `Cohen's kappa per code over ${units.length} segment${units.length === 1 ? "" : "s"} both coders coded; a code applied to all or none of them has no kappa. Bands (Landis & Koch) are a convention, not a test.` };
}

/** the coders who have coded anything — "ai" and user ids — for the comparison picker */
export function codersOf(state: QualState): string[] {
  return [...new Set(state.excerpts.map((e) => e.coder))].sort((x, y) => (x === "ai" ? -1 : y === "ai" ? 1 : x.localeCompare(y)));
}
