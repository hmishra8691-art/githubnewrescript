import type { FieldType } from "@rescript/schema";
import { checkPhone, checkPostal, checkUrl, affixFor } from "./formats.js";

/**
 * Field-type primitives for form-style list questions (req §4–5).
 * One place defines how each field type is rendered and validated, so the
 * editor, runtime and validation never disagree.
 */

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "longtext", label: "Long text" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "number", label: "Number" },
  { value: "decimal", label: "Decimal" },
  { value: "integer", label: "Integer" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time" },
  { value: "hours", label: "Hours (duration)" },
  { value: "url", label: "URL" },
  { value: "zip", label: "ZIP / Postal code" },
];

/**
 * HTML input attributes for a field type.
 *
 * `settings` is the owning question's, because two of these depend on it: a
 * currency field's symbol and which side it sits. It used to be a hard-coded
 * "$" prefix with no way to change it — a dollar sign shown to studies not
 * priced in dollars, which the review reported.
 */
export function fieldInputProps(t: FieldType | undefined, settings?: {
  currencyCode?: string; currencySymbol?: string; symbolSide?: "left" | "right";
}): {
  inputType: string;
  inputMode?: string;
  multiline?: boolean;
  prefix?: string;
  suffix?: string;
} {
  switch (t) {
    case "longtext": return { inputType: "text", multiline: true };
    case "email": return { inputType: "email" };
    case "phone": return { inputType: "tel", inputMode: "tel" };
    case "number":
    case "decimal": return { inputType: "number", inputMode: "decimal" };
    case "integer": return { inputType: "number", inputMode: "numeric" };
    case "currency": {
      const affix = affixFor(settings ?? {}, "$");
      return {
        inputType: "number", inputMode: "decimal",
        ...(affix?.side === "right" ? { suffix: affix.text } : { prefix: affix?.text ?? "$" }),
      };
    }
    case "date": return { inputType: "date" };
    case "time": return { inputType: "time" };
    /* a duration is typed, not picked — `7`, `7.5` and `7:30` all mean the same */
    case "hours": return { inputType: "text", inputMode: "decimal", suffix: "hrs" };
    case "url": return { inputType: "url" };
    case "zip": return { inputType: "text", inputMode: "numeric" };
    case "text":
    default: return { inputType: "text" };
  }
}

export function fieldDataType(t: FieldType | undefined): "text" | "numeric" | "date" | "time" {
  switch (t) {
    case "number": case "decimal": case "integer": case "currency": case "hours": return "numeric";
    case "date": return "date";
    case "time": return "time";
    default: return "text";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Validate a single value against a field type. Returns an error message or
 * null. Empty values are valid here — required-ness is checked separately.
 *
 * `settings` is the owning question's: a phone or postal field is checked
 * against the country the question names, and against nothing in particular
 * when it names none. That is the same country selection the review asked for
 * on the scalar Phone and ZIP questions — one setting, both places, because
 * they are the same request about the same data.
 */
export function validateFieldValue(
  t: FieldType | undefined,
  value: unknown,
  settings?: { phoneCountry?: string; postalCountry?: string },
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  switch (t) {
    case "email":
      return EMAIL_RE.test(s) ? null : "Please enter a valid email address.";
    case "phone":
      return checkPhone(s, settings?.phoneCountry);
    case "url":
      return checkUrl(s);
    case "zip":
      return checkPostal(s, settings?.postalCountry);
    case "integer":
      return /^-?\d+$/.test(s) ? null : "Please enter a whole number.";
    case "number":
    case "decimal":
    case "currency":
      return Number.isFinite(Number(s)) ? null : "Please enter a number.";
    case "date":
      return !Number.isNaN(Date.parse(s)) ? null : "Please enter a valid date.";
    case "time":
      return TIME_RE.test(s) ? null : "Please enter a valid time.";
    case "hours":
      return parseHours(s) == null
        ? "Please enter a number of hours — for example 7, 7.5 or 7:30."
        : null;
    default:
      return null;
  }
}

/**
 * HOURS, however they were written.
 *
 * `7`, `7.5` and `7:30` all mean seven and a half hours, and a respondent
 * will use whichever is natural to them. Returns the duration in hours, or
 * null when it cannot be read. Negative durations and minutes past 59 are
 * refused — a "7:75" is a typo, not an hour and a quarter.
 */
export function parseHours(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const clock = /^(\d{1,4}):([0-5]\d)$/.exec(s);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
