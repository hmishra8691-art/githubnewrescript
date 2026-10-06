import type { Option, Question } from "@rescript/schema";

/**
 * PAIRWISE CHOICE — the pure half of the pair builder
 * (`components/studio/variantConfig/pairwise.tsx`). A pair is a row naming
 * two options in `meta.left` / `meta.right`; these add and remove whole pairs
 * so the builder can never leave a pair with one side, or an option nobody
 * compares.
 */

/** "A", "B", … "Z", "AA" — the letter of the n-th option across all pairs. */
export function optionLetter(n: number): string {
  let s = "";
  let i = n;
  do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return s;
}

/** The next integer code not yet used by an option. */
export function nextOptionCode(options: Option[]): number {
  const nums = options.map((o) => Number(o.code)).filter(Number.isFinite);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

/** The next pair code (`p1`, `p2` …) not yet used by a row. */
function nextPairCode(q: Question): string {
  const used = new Set(q.rows.map((r) => String(r.code)));
  let n = q.rows.length + 1;
  while (used.has(`p${n}`)) n++;
  return `p${n}`;
}

/**
 * Add a complete pair: two new options and the row that pits them against
 * each other. Pure, so the unit test can hold it to the review's wording.
 */
export function addPair(q: Question): Pick<Question, "options" | "rows"> {
  const a = nextOptionCode(q.options);
  const b = a + 1;
  const letterA = optionLetter(q.rows.length * 2);
  const letterB = optionLetter(q.rows.length * 2 + 1);
  return {
    options: [
      ...q.options,
      { code: a, label: `Option ${letterA}`, flags: [] } as Option,
      { code: b, label: `Option ${letterB}`, flags: [] } as Option,
    ],
    rows: [
      ...q.rows,
      {
        code: nextPairCode(q), label: `Pair ${q.rows.length + 1}`,
        flags: [], validation: [], required: false,
        meta: { left: String(a), right: String(b) },
      } as Question["rows"][number],
    ],
  };
}

/**
 * Remove a pair, and with it the options only it used — an option another
 * pair still names stays, so removing one comparison never breaks another.
 */
export function removePair(q: Question, index: number): Pick<Question, "options" | "rows"> {
  const row = q.rows[index];
  const rows = q.rows.filter((_, i) => i !== index);
  if (!row) return { options: q.options, rows };
  const stillUsed = new Set(rows.flatMap((r) => [String(r.meta?.left ?? ""), String(r.meta?.right ?? "")]));
  const mine = [String(row.meta?.left ?? ""), String(row.meta?.right ?? "")];
  return {
    rows,
    options: q.options.filter((o) => !mine.includes(String(o.code)) || stillUsed.has(String(o.code))),
  };
}


/**
 * Pairs for a question converted INTO Pairwise Choice — the older
 * single-comparison form, or any choice question: its options are paired in
 * order (first with second, third with fourth). An odd one out stays in the
 * option list and the builder says it is unpaired, rather than being dropped.
 */
export function pairsFromOptions(options: Option[]): Question["rows"] {
  const rows: Question["rows"] = [];
  for (let i = 0; i + 1 < options.length; i += 2) {
    rows.push({
      code: `p${rows.length + 1}`, label: `Pair ${rows.length + 1}`,
      flags: [], validation: [], required: false,
      meta: { left: String(options[i].code), right: String(options[i + 1].code) },
    } as Question["rows"][number]);
  }
  return rows;
}

/** Options no pair names — left over from a conversion or an older editor. */
export function unpairedOptions(q: Pick<Question, "options" | "rows">): Option[] {
  const named = new Set(q.rows.flatMap((r) => [String(r.meta?.left ?? ""), String(r.meta?.right ?? "")]));
  return q.options.filter((o) => !named.has(String(o.code)));
}
