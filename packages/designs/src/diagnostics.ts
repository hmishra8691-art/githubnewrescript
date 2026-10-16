/**
 * Design diagnostics (METHOD-05).
 *
 * The generators have always balanced ONE-way — every level of an attribute
 * is shown about equally often — and reported it. One-way balance says nothing
 * about whether two attributes are crossed evenly: a design can show every
 * brand and every price equally often and still never put Brand A with the
 * top price, which is exactly the confound a conjoint cannot untangle.
 *
 * `twoWayBalance` counts every pair of attributes' level co-occurrence over the
 * concepts of the design and says which pair is worst. It is a METRIC, not a
 * generator: it does not change the design, it tells the programmer what the
 * design is. The result lives in `summary.diagnostics`, which the Studio
 * stores on the design (`DesignReference.file.summary`) so it is still there
 * after the preview is closed.
 */

export interface PairBalance {
  /** the two attributes */
  a: string;
  b: string;
  /** level × level cells that could occur (prohibited cells are not counted) */
  cells: number;
  /** concepts counted */
  concepts: number;
  /** concepts per cell if the design were perfectly crossed */
  expectedPerCell: number;
  min: number;
  max: number;
  /** max / min over the possible cells; null when a possible cell is empty */
  ratio: number | null;
  /** possible cells that never occur */
  emptyCells: number;
  /** "poor" only when the cells are populated enough for the number to mean something */
  poor: boolean;
}

export interface DesignDiagnostics {
  method: "two_way_balance";
  /** every attribute pair, worst first */
  pairs: PairBalance[];
  worst: { a: string; b: string; min: number; max: number; ratio: number | null; emptyCells: number } | null;
  /** true when no pair is poor */
  balanced: boolean;
  warnings: string[];
}

/** a cell is judged poor above this max/min ratio… */
export const POOR_RATIO = 2;
/** …or when any possible cell is empty — but only once the average cell holds at least this many concepts */
const MIN_EXPECTED_FOR_EMPTY = 2;
const MIN_EXPECTED_FOR_RATIO = 3;

/**
 * Two-way level balance of a set of concepts.
 *
 * `profiles` are the concepts (attribute → level); `isPossible` lets the caller
 * exclude cells a prohibition makes impossible, so a prohibited pair is never
 * reported as an unbalanced one.
 */
export function twoWayBalance(
  attributes: { name: string; levels: string[] }[],
  profiles: Record<string, string>[],
  isPossible?: (a: string, levelA: string, b: string, levelB: string) => boolean,
): DesignDiagnostics {
  const pairs: PairBalance[] = [];
  for (let i = 0; i < attributes.length; i++) {
    for (let j = i + 1; j < attributes.length; j++) {
      const A = attributes[i];
      const B = attributes[j];
      const counts = new Map<string, number>();
      for (const p of profiles) {
        const k = `${p[A.name]}\u0001${p[B.name]}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const values: number[] = [];
      for (const la of A.levels) {
        for (const lb of B.levels) {
          if (isPossible && !isPossible(A.name, la, B.name, lb)) continue;
          values.push(counts.get(`${la}\u0001${lb}`) ?? 0);
        }
      }
      if (!values.length) continue;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const expected = profiles.length / values.length;
      const emptyCells = values.filter((v) => v === 0).length;
      const ratio = min === 0 ? null : Math.round((max / min) * 100) / 100;
      const poor =
        (min === 0 && expected >= MIN_EXPECTED_FOR_EMPTY) ||
        (min > 0 && expected >= MIN_EXPECTED_FOR_RATIO && max / min > POOR_RATIO);
      pairs.push({
        a: A.name, b: B.name, cells: values.length, concepts: profiles.length,
        expectedPerCell: Math.round(expected * 10) / 10, min, max, ratio, emptyCells, poor,
      });
    }
  }
  // worst first: empty cells, then the widest spread
  const severity = (p: PairBalance) => (p.ratio === null ? Number.MAX_SAFE_INTEGER : p.ratio);
  pairs.sort((x, y) => severity(y) - severity(x));
  const warnings = pairs.filter((p) => p.poor).map((p) =>
    p.emptyCells > 0
      ? `Two-way balance is poor for ${p.a} × ${p.b}: ${p.emptyCells} of ${p.cells} level combinations never appear (expected about ${p.expectedPerCell} each). Their effects cannot be separated — add tasks or versions.`
      : `Two-way balance is poor for ${p.a} × ${p.b}: level combinations appear between ${p.min} and ${p.max} times (max/min ${p.ratio}, expected about ${p.expectedPerCell}). Add tasks or versions, or accept unequal precision for this pair.`);
  const w = pairs[0];
  return {
    method: "two_way_balance",
    pairs,
    worst: w ? { a: w.a, b: w.b, min: w.min, max: w.max, ratio: w.ratio, emptyCells: w.emptyCells } : null,
    balanced: warnings.length === 0,
    warnings,
  };
}
