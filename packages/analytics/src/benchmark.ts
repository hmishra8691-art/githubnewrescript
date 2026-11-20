/**
 * BENCHMARKS FOR THE RESPONDENT PORTAL (Respondent Intelligence Engine, phase 2, 2026-11-20): how one person's score
 * sits among everyone's, and among their own group's.
 *
 * The privacy rules are the point of this file:
 *
 *   1. A figure is produced for a group only when at least `minCohort` people in it have that score. The floor is
 *      10 and a caller cannot go below it.
 *   2. COMPLEMENTARY SUPPRESSION. If the hidden groups of a split together hold fewer than `minCohort` people, the
 *      smallest shown group is hidden too. Otherwise "everyone" minus "the shown groups" would describe the hidden
 *      few. People with no group count as a hidden group.
 *   3. The snapshot holds no person: per group it keeps the count, mean, spread and 101 percentile cut points.
 *      What reaches a respondent is narrower still: a count, an average and two whole-number percentages.
 *
 * Pure: rows in, snapshot out. The portal stores the snapshot and reads comparisons from it.
 */
export const BENCHMARK_FLOOR = 10;

export interface BenchmarkRow {
  /** dimension id → raw score (null = not scored) */
  values: Record<string, number | null>;
  /** grouping id → this person's group (null = none) */
  cohort: Record<string, string | null>;
}
export interface Dist { n: number; mean: number; sd: number; median: number; cuts: number[] }
export interface BenchmarkSnapshot {
  v: 1;
  /** the scoring these scores share; rows of another scoring are never mixed in */
  fingerprint: string;
  minCohort: number;
  /** completed interviews that were read */
  n: number;
  all: Record<string, Dist>;
  /** grouping id → group → dimension id → distribution; only groups that may be shown */
  groups: Record<string, Record<string, Record<string, Dist>>>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function distribution(values: number[]): Dist {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const at = (p: number) => { const pos = (p / 100) * (n - 1); const lo = Math.floor(pos), hi = Math.ceil(pos); return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo); };
  return { n, mean: r2(mean), sd: r2(sd), median: r2(at(50)), cuts: Array.from({ length: 101 }, (_, p) => r2(at(p))) };
}

export function buildBenchmark(rows: BenchmarkRow[], opts: { fingerprint: string; minCohort?: number; groupings?: string[] }): BenchmarkSnapshot {
  const min = Math.max(BENCHMARK_FLOOR, Math.floor(opts.minCohort ?? BENCHMARK_FLOOR));
  const dims = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.values)) dims.add(k);
  const groupings = opts.groupings ?? [...new Set(rows.flatMap((r) => Object.keys(r.cohort)))];
  const snap: BenchmarkSnapshot = { v: 1, fingerprint: opts.fingerprint, minCohort: min, n: rows.length, all: {}, groups: {} };

  for (const dim of dims) {
    const scored = rows.filter((r) => typeof r.values[dim] === "number" && Number.isFinite(r.values[dim] as number));
    if (scored.length < min) continue;
    snap.all[dim] = distribution(scored.map((r) => r.values[dim] as number));

    for (const g of groupings) {
      const by = new Map<string, number[]>();
      let ungrouped = 0;
      for (const r of scored) {
        const key = r.cohort[g];
        if (!key) { ungrouped++; continue; }
        (by.get(key) ?? by.set(key, []).get(key)!).push(r.values[dim] as number);
      }
      const shown = [...by.entries()].filter(([, v]) => v.length >= min).sort((a, b) => a[1].length - b[1].length);
      const hidden = ungrouped + [...by.values()].filter((v) => v.length < min).reduce((a, v) => a + v.length, 0);
      /* rule 2: a few hidden people must not be recoverable by subtraction */
      if (hidden > 0 && hidden < min) shown.shift();
      for (const [key, v] of shown) ((snap.groups[g] ??= {})[key] ??= {})[dim] = distribution(v);
    }
  }
  return snap;
}

/** whole-number shares of the group scoring below and above this score (ties are in neither) */
export function standing(d: Dist, score: number): { below: number; above: number } {
  let below = 0, above = 0;
  for (const c of d.cuts) { if (c < score) below++; else if (c > score) above++; }
  const pct = (k: number) => Math.min(99, Math.max(0, Math.round((k / d.cuts.length) * 100)));
  return { below: pct(below), above: pct(above) };
}

export interface GroupStanding { n: number; mean: number; median: number; below: number; above: number }
export interface Comparison {
  dimension: string;
  everyone: GroupStanding | null;
  groups: (GroupStanding & { grouping: string; group: string })[];
  /** why nothing is shown, in the respondent's words */
  note: string | null;
}

/** one person against the snapshot: everyone, and each of THEIR OWN groups that may be shown — never another group */
export function compare(snap: BenchmarkSnapshot | null, values: Record<string, number | null>, cohort: Record<string, string | null>, fingerprint: string): Comparison[] {
  const out: Comparison[] = [];
  for (const [dimension, score] of Object.entries(values)) {
    if (typeof score !== "number") continue;
    const none = (note: string): Comparison => ({ dimension, everyone: null, groups: [], note });
    if (!snap || snap.fingerprint !== fingerprint) { out.push(none("A comparison is not available yet.")); continue; }
    const all = snap.all[dimension];
    if (!all) { out.push(none(`A comparison is shown once at least ${snap.minCohort} people have this score.`)); continue; }
    const see = (d: Dist): GroupStanding => ({ n: d.n, mean: d.mean, median: d.median, ...standing(d, score) });
    const groups: Comparison["groups"] = [];
    for (const [grouping, group] of Object.entries(cohort)) {
      const d = group ? snap.groups[grouping]?.[group]?.[dimension] : undefined;
      if (d && group) groups.push({ grouping, group, ...see(d) });
    }
    out.push({ dimension, everyone: see(all), groups, note: null });
  }
  return out;
}

/** a stored score with who it belongs to: a person who took the survey twice counts once, with their latest */
export interface StoredScore extends BenchmarkRow { person: string | null; at: string | null }
export function onePerPerson(rows: StoredScore[]): BenchmarkRow[] {
  const latest = new Map<string, StoredScore>();
  const out: BenchmarkRow[] = [];
  for (const r of rows) {
    if (!r.person) { out.push({ values: r.values, cohort: r.cohort }); continue; }
    const had = latest.get(r.person);
    if (!had || String(r.at ?? "") >= String(had.at ?? "")) latest.set(r.person, r);
  }
  for (const r of latest.values()) out.push({ values: r.values, cohort: r.cohort });
  return out;
}
