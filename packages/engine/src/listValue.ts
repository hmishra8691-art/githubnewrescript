/**
 * LIST VALUES AND VALUE-TYPE DETECTION (October 2026 review, documents 15/10 and 16/10).
 *
 * One definition, shared by the Survey Flow's Embedded Data editor (automatic
 * data type, the "stored as" preview) and by condition evaluation (`contains`
 * on a comma-separated Embedded Data list matches whole ITEMS — "10001" never
 * matches "110001"). Pure and dependency-free.
 *
 *   "90210, 10001, 30301"  → a list of three text items
 *   "02108"                → an identifier (text): a leading zero is never dropped
 *   "25" / "25.75"         → integer / decimal
 *   "true" / "false"       → boolean
 */

export type DetectedValueType = "empty" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "url" | "list" | "string";

/** The separators a list may use. A comma is the documented one; semicolons and new lines are accepted as typed. */
const SEPARATOR = /\s*(?:,|;|\r?\n)\s*/;

/**
 * The items of a list value, trimmed, empty items dropped. An array is taken
 * as it is (each member stringified and trimmed). A scalar with no separator
 * is a one-item list. `null` / `undefined` / "" give [].
 */
export function listItems(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter((v) => v !== "");
  const s = String(value).trim();
  if (s === "") return [];
  return s.split(SEPARATOR).map((v) => v.trim()).filter((v) => v !== "");
}

/** Does the text hold more than one item (a comma-, semicolon- or line-separated list)? */
export function isListText(value: unknown): boolean {
  return typeof value === "string" && listItems(value).length > 1;
}

const INTEGER = /^[+-]?(?:0|[1-9]\d*)$/;
const DECIMAL = /^[+-]?(?:0|[1-9]\d*)?\.\d+$|^[+-]?(?:0|[1-9]\d*)\.\d*$/;
const LEADING_ZERO_ID = /^0\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const URL_RE = /^https?:\/\/\S+$/i;

/**
 * What a typed value is. Conservative on purpose: a number with a leading zero
 * ("02108") is an IDENTIFIER (string), because converting it would lose the
 * zero; a piped reference ("{{ed.X}}") is a string until it is resolved.
 */
export function detectValueType(raw: unknown): DetectedValueType {
  if (raw === null || raw === undefined) return "empty";
  if (typeof raw === "number") return Number.isInteger(raw) ? "integer" : "decimal";
  if (typeof raw === "boolean") return "boolean";
  if (Array.isArray(raw)) return "list";
  const s = String(raw).trim();
  if (s === "") return "empty";
  if (/\{\{[^}]+\}\}/.test(s)) return "string";
  if (isListText(s)) return "list";
  if (/^(?:true|false)$/i.test(s)) return "boolean";
  if (LEADING_ZERO_ID.test(s)) return "string";
  if (INTEGER.test(s)) return Number.isSafeInteger(Number(s)) ? "integer" : "string";
  if (DECIMAL.test(s)) return "decimal";
  if (DATE.test(s) && !Number.isNaN(Date.parse(s))) return "date";
  if (DATETIME.test(s) && !Number.isNaN(Date.parse(s))) return "datetime";
  if (URL_RE.test(s)) return "url";
  return "string";
}

/** Case-insensitive, trimmed comparison of two list items. */
const sameItem = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Does the list hold the needle as a WHOLE item? A needle that is itself a
 * list ("10001, 10003") matches when ANY of its items is in the list.
 * Whole-item: "10001" does not match "110001".
 */
export function listContainsItem(list: unknown, needle: unknown): boolean {
  const items = listItems(list);
  const wanted = listItems(needle);
  if (!items.length || !wanted.length) return false;
  return wanted.some((w) => items.some((i) => sameItem(i, w)));
}
