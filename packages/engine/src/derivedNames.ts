/**
 * THE ONE PLACE A DERIVED COLUMN NAME IS COMPOSED (§44).
 *
 * A question produces more columns than itself: `Q5_1` per option, `Q5_R2`
 * per matrix row, `Q5_R2_C1` per cell, `Q7_3` per loop iteration. Those
 * suffixes used to be spelled out inline in TWO files — `variables.ts`, which
 * DECLARES the columns, and `flatten.ts`, which WRITES them at interview time
 * — with nothing checking that the two agreed.
 *
 * They did not. A multiple-choice image question wrote a 0/1 flag per option
 * that the dictionary never declared, so the answers were collected and then
 * absent from every delivered file. `namingParity.test.ts` found it, and this
 * module exists so the next one cannot happen: both files compose their names
 * here, and a pattern change reaches both at once.
 *
 * ## Why the patterns are locked once fieldwork starts
 *
 * Changing a suffix pattern renames hundreds of columns. Unlike renaming one
 * variable — which `variableUsage.ts` can rewrite references for — there is
 * nothing to rewrite here: saved analyses name dictionary columns directly,
 * and `state.calculated` on every stored response is keyed by them. A study
 * that changes its suffix scheme mid-field has analyses pointing at columns
 * that no longer exist and no way to repair them automatically.
 *
 * So the Studio offers this only while a survey has no responses. It is a
 * decision made at the start of a study, which is also when a research team
 * actually makes it.
 */

export interface SuffixPatterns {
  /** one column per option: `{base}_{code}` */
  option?: string;
  /** one column per matrix row: `{base}_{row}` */
  row?: string;
  /** one column per grid cell: `{base}_{row}_{column}` */
  cell?: string;
  /** one column per position — loop iterations, list entries: `{base}_{n}` */
  index?: string;
}

export const DEFAULT_SUFFIXES: Required<SuffixPatterns> = {
  option: "{base}_{code}",
  row: "{base}_{row}",
  cell: "{base}_{row}_{column}",
  index: "{base}_{n}",
};

/**
 * Patterns a research team might realistically want, as a starting point.
 * `Q1r1c2` is the SPSS-ish house style a lot of data-processing teams use;
 * the default is the underscore form this platform has always produced.
 */
export const SUFFIX_PRESETS: { name: string; patterns: Required<SuffixPatterns> }[] = [
  { name: "Underscores (default)", patterns: DEFAULT_SUFFIXES },
  {
    name: "Compact — Q1r1c2",
    patterns: { option: "{base}r{code}", row: "{base}r{row}", cell: "{base}r{row}c{column}", index: "{base}_{n}" },
  },
  {
    name: "Dotted — Q1.1",
    patterns: { option: "{base}.{code}", row: "{base}.{row}", cell: "{base}.{row}.{column}", index: "{base}.{n}" },
  },
];

const fill = (pattern: string, parts: Record<string, string | number>): string =>
  pattern.replace(/\{([a-z]+)\}/gi, (whole, key: string) => {
    const v = parts[key.toLowerCase()];
    // an unknown token stays visible rather than blanking, so a typo in a
    // pattern fails validation loudly instead of collapsing every column name
    return v === undefined ? whole : String(v);
  });

/** `Q5_1` — one column per option, and per allocation / ranking entry. */
export function optionColumn(base: string, code: string | number, p?: SuffixPatterns): string {
  return fill(p?.option || DEFAULT_SUFFIXES.option, { base, code });
}

/** `Q5_R2` — one column per matrix row. */
export function rowColumn(base: string, row: string | number, p?: SuffixPatterns): string {
  return fill(p?.row || DEFAULT_SUFFIXES.row, { base, row });
}

/** `Q5_R2_C1` — one column per grid cell. */
export function cellColumn(base: string, row: string | number, column: string | number, p?: SuffixPatterns): string {
  return fill(p?.cell || DEFAULT_SUFFIXES.cell, { base, row, column });
}

/** `Q7_3` — one column per position: loop iterations, list entries. */
export function indexColumn(base: string, n: number, p?: SuffixPatterns): string {
  return fill(p?.index || DEFAULT_SUFFIXES.index, { base, n });
}

/**
 * Is this set of patterns usable at all?
 *
 * Each has to contain `{base}` and its own part, or two different columns
 * collapse onto one name — `{base}` alone for the option pattern would give
 * every option of a question the same column, which no test of the resulting
 * file would obviously catch, because the file looks fine and simply has one
 * column where it should have eight.
 */
export function validateSuffixes(p: SuffixPatterns): string[] {
  const problems: string[] = [];
  const need: [keyof SuffixPatterns, string, string][] = [
    ["option", "{code}", "one column per option"],
    ["row", "{row}", "one column per row"],
    ["cell", "{row}", "one column per cell"],
    ["index", "{n}", "one column per position"],
  ];
  for (const [key, token, what] of need) {
    const pattern = p[key];
    if (pattern === undefined || pattern === "") continue;
    if (!pattern.includes("{base}")) {
      problems.push(`The ${key} pattern must contain {base}, or every question's columns would share one name.`);
    }
    if (!pattern.includes(token)) {
      problems.push(`The ${key} pattern must contain ${token} — it makes ${what}, and without it they would all be called the same thing.`);
    }
    if (key === "cell" && pattern && !pattern.includes("{column}")) {
      problems.push("The cell pattern must contain {column} as well as {row}.");
    }
    if (pattern && !/^[A-Za-z_{]/.test(pattern)) {
      problems.push(`The ${key} pattern has to start with a letter, an underscore or {base}.`);
    }
  }
  return problems;
}
