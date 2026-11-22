import type { SurveyDefinition } from "@rescript/schema";
import type { AnalysisResult, ResultTable } from "./types.js";
import { baseCaptionParts } from "./baseCaption.js";

/**
 * "WHY THIS NUMBER" (Level 5 roadmap M4 — 2026-11-29).
 *
 * Any cell of a table, explained: what the number is (a column percentage, a count, a mean), the count and the base
 * it comes from, who is in that base (filter, scope, weighting), what it was tested against and how (the test, the
 * level, the correction for multiple comparisons, which columns it differs from), whether the base is too small to
 * read, and which computation produced it (engine version, data version, the hash of every input). Everything is
 * read from the result and its provenance record; nothing is recomputed, so the explanation describes exactly the
 * number on the screen.
 */
export interface CellRef { table?: string; row: number | string; column: string }
export interface CellExplanation {
  value: number | null;
  shown: string;
  /** what kind of figure it is */
  measure: string;
  /** "97 of 360" — when the figure is a share of a base */
  fromCount?: number; ofBase?: number;
  /** one sentence a non-statistician reads */
  sentence: string;
  base: { n: string; scope: string[]; answered: string | null };
  significance?: { test: string; level: string; correction: string | null; higherThan: string[]; note: string };
  caution: string[];
  computedBy: { engineVersion?: string; dataVersion?: string | null; surveyVersion?: string | null; inputHash?: string; computedAt?: string; definitionHash?: string };
}

const SMALL = 30, TINY = 10;

function findRow(t: ResultTable, row: number | string): Record<string, unknown> | undefined {
  const rows = t.rows as Record<string, unknown>[];
  if (typeof row === "number") return rows[row];
  return rows.find((r) => r.__code === row || r.row === row || r[t.columns[0]?.key ?? "row"] === row);
}

export function whyThisNumber(result: AnalysisResult, ref: CellRef, opts: { survey?: SurveyDefinition | null; labelOf?: (v: string) => string } = {}): CellExplanation | { error: string } {
  const t = (ref.table ? result.tables.find((x) => x.id === ref.table) : result.tables[0]) as ResultTable | undefined;
  if (!t) return { error: `The result has no table${ref.table ? ` ${ref.table}` : ""}.` };
  const col = t.columns.find((c) => c.key === ref.column);
  if (!col) return { error: `The table has no column ${ref.column}.` };
  const r = findRow(t, ref.row);
  if (!r) return { error: `The table has no row ${String(ref.row)}.` };
  const raw = r[ref.column];
  const value = typeof raw === "number" ? raw : null;
  const rowLabel = String(r[t.columns[0]?.key ?? "row"] ?? ref.row);
  const colLabel = col.label.replace(/\s*\([a-z]\)$/, "");
  const nHere = typeof r[`${ref.column}__n`] === "number" ? (r[`${ref.column}__n`] as number) : undefined;
  const colBase = (t as { columnBases?: Record<string, number> }).columnBases?.[ref.column];
  const kind = r.__kind as string | undefined;
  const fmt = kind === "base" ? String(value ?? "—") : col.type === "pct" ? `${value?.toFixed(col.decimals ?? 1)}%` : value == null ? "—" : String(value);
  const pctMeasure = result.provenance?.definition?.measure ?? "pct_col";
  const isPct = col.type === "pct";
  const measure = kind === "base" ? "the base (respondents in this column)" : isPct ? (pctMeasure === "pct_row" ? "a row percentage" : pctMeasure === "pct_total" ? "a percentage of the whole table" : "a column percentage") : col.type === "number" || /mean/i.test(rowLabel) ? "a mean" : "a count";
  const parts = baseCaptionParts({ base: result.base, variablesUsed: result.variablesUsed, definition: result.provenance?.definition ?? null, survey: opts.survey ?? null, ...(opts.labelOf ? { labelOf: opts.labelOf } : {}) });
  const isTotal = ref.column === "__total";
  const who = isTotal ? "respondents in the base" : `respondents in “${colLabel}”`;
  let sentence: string;
  if (kind === "base") sentence = `${fmt} respondents are in “${colLabel}”: they are the base every percentage in this column is out of.`;
  else if (value == null) sentence = `No figure: ${colBase === 0 ? `nobody is in “${colLabel}”` : "the cell has no data"}.`;
  else if (isPct && nHere !== undefined && colBase) sentence = `${nHere} of the ${colBase} ${who} ${pctMeasure === "pct_row" ? "are in this row's group" : `chose “${rowLabel}”`} — ${fmt}${result.provenance?.definition?.weighting ? " (weighted)" : ""}.`;
  else sentence = `${fmt} is ${measure} for “${rowLabel}” among ${isTotal ? "all " : "the "}${who}.`;
  const caution: string[] = [];
  if (colBase !== undefined && colBase > 0 && colBase < TINY) caution.push(`Only ${colBase} respondents in this column: the percentage moves ${Math.round(100 / colBase)} points with each person. Do not report it.`);
  else if (colBase !== undefined && colBase > 0 && colBase < SMALL) caution.push(`A small base (${colBase}): read the figure as indicative; its margin of error is about ±${Math.round(98 / Math.sqrt(colBase))} points.`);
  if (kind !== "base" && value !== null && nHere !== undefined && nHere < 5 && isPct) caution.push(`The figure rests on ${nHere} respondent${nHere === 1 ? "" : "s"}.`);
  /* significance: the cell's letters name the columns it is significantly higher than */
  const letters = String(r[`${ref.column}__sig`] ?? "");
  const notes = (t as { notes?: string[] }).notes ?? [];
  const testNote = notes.find((n) => /significan|letters|test/i.test(n)) ?? "";
  let significance: CellExplanation["significance"];
  if (kind !== "base" && (testNote || letters)) {
    const higherThan = [...letters].map((l) => t.columns.find((c) => (c as { letter?: string }).letter === l)?.label.replace(/\s*\([a-z]\)$/, "") ?? l);
    const level = /(\d{2})\s?%/.exec(testNote)?.[1] ?? "95";
    const test = /column proportion z-test/i.test(testNote) ? "column proportion z-test" : /t-test/i.test(testNote) ? "t-test on the column means" : /chi/i.test(testNote) ? "chi-square" : "the table's significance test";
    const correction = /holm/i.test(testNote) ? "Holm adjustment for the number of columns compared in each row" : /bonferroni/i.test(testNote) ? "Bonferroni adjustment" : null;
    significance = { test, level: `${level}%`, correction, higherThan, note: !isTotal && colBase !== undefined && colBase < SMALL && notes.some((n) => /below 30 carry no significance/i.test(n)) ? `Not tested: only ${colBase} respondents in this column, below the 30 needed to test.` : higherThan.length ? `${fmt} is significantly higher than ${higherThan.map((h) => `“${h}”`).join(" and ")} at the ${level}% level${correction ? `, after the ${correction}` : ""}.` : isTotal ? "The total is not tested; columns are tested against each other." : `Not significantly higher than any other column at the ${level}% level.` };
  }
  const p = result.provenance;
  return {
    value, shown: fmt, measure, ...(nHere !== undefined ? { fromCount: nHere } : {}), ...(colBase !== undefined ? { ofBase: colBase } : {}),
    sentence, base: { n: parts.n, scope: parts.scope, answered: parts.answered }, ...(significance ? { significance } : {}), caution,
    computedBy: { engineVersion: p?.engineVersion, dataVersion: p?.dataVersion ?? null, surveyVersion: p?.surveyVersion ?? null, inputHash: p?.inputHash, computedAt: p?.computedAt ?? result.computedAt, definitionHash: p?.definitionHash ?? result.definitionHash },
  };
}

/** the explanation as lines, for a tooltip, a side panel or a footnote */
export function whyLines(x: CellExplanation): string[] {
  return [
    x.sentence,
    `Base: ${x.base.n}${x.base.answered ? `, ${x.base.answered}` : ""}${x.base.scope.length ? `; ${x.base.scope.join("; ")}` : ""}.`,
    ...(x.significance ? [x.significance.note, `Test: ${x.significance.test} at ${x.significance.level}${x.significance.correction ? `, ${x.significance.correction}` : ", no correction for multiple comparisons"}.`] : []),
    ...x.caution,
    `Computed by engine ${x.computedBy.engineVersion ?? "unknown"} from data version ${x.computedBy.dataVersion ?? "not recorded"}, inputs ${x.computedBy.inputHash ?? "not recorded"}, at ${x.computedBy.computedAt ?? "an unknown time"}.`,
  ];
}
