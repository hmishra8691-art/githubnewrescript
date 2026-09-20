/**
 * ONE CSV CELL WRITER, FOR EVERY CSV THIS PLATFORM PRODUCES.
 *
 * There were four copies of this function — `csv.ts`, `invitations.ts`,
 * `designs/export.ts` and one inline in the localization panel — and they had
 * already drifted: only the invitations one guarded against formula
 * injection, and that is the smallest of the four files by a wide margin.
 * The response export, the file that actually goes to the client, had none.
 */

/**
 * A cell that is nothing but a number is data, never a formula.
 *
 * This matters because the naive guard (`/^[=+\-@\t\r]/`) fires on every
 * negative number, and survey data is full of them: -5..+5 scales, deltas,
 * temperatures, a numeric open end. Prefixing those turns a numeric column
 * into a text column in Excel — a self-inflicted version of the corruption
 * the guard exists to prevent. So a value that parses whole as a number is
 * left alone, and everything else beginning with a trigger character is
 * prefixed. Note this is a check on the WHOLE string: the classic bypass
 * `-1+1+cmd|' /C calc'!A0` starts out looking numeric and is not a number,
 * so it is still guarded.
 */
const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Does this value need the anti-formula prefix? Exported for the tests. */
export function needsFormulaGuard(s: string): boolean {
  if (!/^[=+\-@\t\r]/.test(s)) return false;
  return !PLAIN_NUMBER.test(s);
}

/**
 * RFC-4180 quoting, plus a guard against FORMULA INJECTION.
 *
 * Excel, Sheets and Numbers evaluate a cell beginning `=`, `+`, `-` or `@`
 * as a formula. Survey data is respondent-supplied, so that is not a
 * curiosity: an open end typed `=cmd|…`, an external id beginning `@`, a
 * name like `-Ann`. RFC-4180 quoting does NOT help — the parser consumes the
 * quotes and the formula runs. A leading tab stops evaluation and keeps the
 * value readable.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = Array.isArray(value) ? value.join("|") : String(value);
  const s = needsFormulaGuard(raw) ? `\t${raw}` : raw;
  return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV record, terminator excluded. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",");
}
