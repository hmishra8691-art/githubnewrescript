import type { FieldType } from "@rescript/schema";

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
  { value: "url", label: "URL" },
  { value: "zip", label: "ZIP / Postal code" },
];

/** HTML input attributes for a field type. */
export function fieldInputProps(t: FieldType | undefined): {
  inputType: string;
  inputMode?: string;
  multiline?: boolean;
  prefix?: string;
} {
  switch (t) {
    case "longtext": return { inputType: "text", multiline: true };
    case "email": return { inputType: "email" };
    case "phone": return { inputType: "tel", inputMode: "tel" };
    case "number":
    case "decimal": return { inputType: "number", inputMode: "decimal" };
    case "integer": return { inputType: "number", inputMode: "numeric" };
    case "currency": return { inputType: "number", inputMode: "decimal", prefix: "$" };
    case "date": return { inputType: "date" };
    case "time": return { inputType: "time" };
    case "url": return { inputType: "url" };
    case "zip": return { inputType: "text", inputMode: "numeric" };
    case "text":
    default: return { inputType: "text" };
  }
}

export function fieldDataType(t: FieldType | undefined): "text" | "numeric" | "date" | "time" {
  switch (t) {
    case "number": case "decimal": case "integer": case "currency": return "numeric";
    case "date": return "date";
    case "time": return "time";
    default: return "text";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9()\-.\s]{7,20}$/;
const ZIP_RE = /^[A-Za-z0-9][A-Za-z0-9\- ]{2,9}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Validate a single value against a field type. Returns an error message or null.
 *  Empty values are valid here — required-ness is checked separately. */
export function validateFieldValue(t: FieldType | undefined, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  switch (t) {
    case "email":
      return EMAIL_RE.test(s) ? null : "Please enter a valid email address.";
    case "phone":
      return PHONE_RE.test(s) ? null : "Please enter a valid phone number.";
    case "url":
      try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        return u.hostname.includes(".") ? null : "Please enter a valid URL.";
      } catch {
        return "Please enter a valid URL.";
      }
    case "zip":
      return ZIP_RE.test(s) ? null : "Please enter a valid ZIP / postal code.";
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
    default:
      return null;
  }
}
