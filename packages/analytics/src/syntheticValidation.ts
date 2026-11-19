import { categoricalColumn, categoriesOf, type Dataset } from "./dataset.js";

/**
 * HOW FAR SYNTHETIC RESPONDENTS ARE FROM REAL ONES (audit 2026-11-17, P3-05: "validation harness compares to real
 * data").
 *
 * Simulated respondents (templates/simulationRun.ts) are for pre-testing the questionnaire and sizing the study:
 * they are stored as TEST data, coded SIM-…, and never reach live data, reports, quotas or deliverables. Before a
 * simulation is used for anything beyond logic testing — a power estimate, an expected incidence — this compares
 * it with real responses, question by question: the total variation distance between the two answer distributions
 * (0 = identical, 1 = no overlap) and the share of each side that answered at all.
 *
 * The verdict is deliberately blunt. A simulation that does not resemble the field is fine for testing paths and
 * logic; it is NOT evidence about the population, and the report says which questions it diverges on.
 */
export interface VariableGap { variable: string; tvd: number; simAnswered: number; realAnswered: number; biggest: { code: string; sim: number; real: number } | null }
export interface SyntheticComparison { variables: VariableGap[]; meanTvd: number; diverging: string[]; verdict: "close" | "partly" | "far"; note: string }

function shares(ds: Dataset, v: string): { dist: Map<string, number>; answered: number } {
  const col = categoricalColumn(ds, v);
  const dist = new Map<string, number>();
  let answered = 0, picks = 0;
  for (const x of col) {
    if (x == null || (Array.isArray(x) && !x.length)) continue;
    answered++;
    for (const c of Array.isArray(x) ? x : [x]) { dist.set(c, (dist.get(c) ?? 0) + 1); picks++; }
  }
  for (const [k, n] of dist) dist.set(k, n / Math.max(1, picks));
  return { dist, answered: col.length ? answered / col.length : 0 };
}

/** compare the categorical variables two datasets share (the synthetic and the real one, built from the same survey) */
export function compareSyntheticToReal(sim: Dataset, real: Dataset, opts: { variables?: string[]; threshold?: number } = {}): SyntheticComparison {
  const threshold = opts.threshold ?? 0.15;
  const names = (opts.variables ?? sim.variables.filter((v) => v.categories?.length && real.byName.has(v.name) && !v.hidden && v.role !== "system").map((v) => v.name));
  const variables: VariableGap[] = [];
  for (const v of names) {
    const a = shares(sim, v), b = shares(real, v);
    if (!a.dist.size || !b.dist.size) continue;
    const codes = new Set([...a.dist.keys(), ...b.dist.keys(), ...categoriesOf(real, v).map((c) => c.code)]);
    let tvd = 0, biggest: VariableGap["biggest"] = null, gap = -1;
    for (const c of codes) {
      const s = a.dist.get(c) ?? 0, r = b.dist.get(c) ?? 0;
      tvd += Math.abs(s - r);
      if (Math.abs(s - r) > gap) { gap = Math.abs(s - r); biggest = { code: c, sim: Math.round(s * 1000) / 1000, real: Math.round(r * 1000) / 1000 }; }
    }
    variables.push({ variable: v, tvd: Math.round((tvd / 2) * 1000) / 1000, simAnswered: Math.round(a.answered * 1000) / 1000, realAnswered: Math.round(b.answered * 1000) / 1000, biggest });
  }
  const meanTvd = variables.length ? Math.round((variables.reduce((t, x) => t + x.tvd, 0) / variables.length) * 1000) / 1000 : 0;
  const diverging = variables.filter((x) => x.tvd > threshold).sort((x, y) => y.tvd - x.tvd).map((x) => x.variable);
  const share = variables.length ? diverging.length / variables.length : 0;
  const verdict = share === 0 ? "close" : share <= 0.25 ? "partly" : "far";
  const note = verdict === "close"
    ? `The simulation's answers are within ${threshold} of the field on every compared question (mean distance ${meanTvd}).`
    : `The simulation diverges from the field on ${diverging.length} of ${variables.length} questions (${diverging.slice(0, 5).join(", ")}${diverging.length > 5 ? "…" : ""}). Use it for testing logic and paths, not as evidence about the population or for power.`;
  return { variables, meanTvd, diverging, verdict, note };
}
