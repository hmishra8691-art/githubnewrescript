import type { VariableDef } from "@rescript/schema";

/**
 * HOW A CATEGORICAL VALUE IS WRITTEN OUT (§44).
 *
 * A survey stores a code. What the recipient wants in the file depends
 * entirely on who they are: a data processor wants `2`, a client opening the
 * spreadsheet wants `Male`, and somebody reconciling one against the other
 * wants `2 - Male`. Until now every export wrote the code, and a client
 * reading a column of integers had to keep the questionnaire open beside it.
 *
 * This is deliberately confined to the TEXT-ISH formats — CSV, Excel, JSON.
 * SPSS and SAS carry codes plus value-label metadata instead, because that is
 * what makes a statistical file a statistical file: turning `2` into the
 * string "Male" in a .sav would destroy the very thing the format exists to
 * preserve. See `spss.ts`.
 */

export type ValueMode = "code" | "label" | "code_label";

export const VALUE_MODES: { mode: ValueMode; label: string; hint: string }[] = [
  { mode: "code", label: "Codes only", hint: "1, 2 — what the survey stored. The default, and what data processing expects." },
  { mode: "label", label: "Labels only", hint: "Male, Female — readable without the questionnaire beside it." },
  { mode: "code_label", label: "Codes + labels", hint: "2 - Male — both, for reconciling one against the other." },
];

/** The separator between a code and its label. Kept in one place so every format agrees. */
export const CODE_LABEL_SEPARATOR = " - ";

/**
 * The label for one code, if the dictionary has one.
 *
 * Codes are matched as STRINGS. A code may be stored as the number 2 and
 * labelled under the key "2", and a lookup that missed on that would silently
 * fall back to the bare code — a label export that quietly stopped labelling.
 */
export function labelForCode(v: VariableDef | undefined, raw: unknown): string | undefined {
  if (!v || raw == null || raw === "") return undefined;
  const labels = v.valueLabels ?? {};
  const key = String(raw);
  if (Object.prototype.hasOwnProperty.call(labels, key)) return labels[key];
  // a numeric code stored as 2.0, or a label keyed "02"
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const alt = String(Math.trunc(raw));
    if (Object.prototype.hasOwnProperty.call(labels, alt)) return labels[alt];
  }
  return undefined;
}

/**
 * One exported cell, in the chosen representation.
 *
 * A value with no label in the dictionary is written as it is, in every mode:
 * an open text answer, a number, a date. "Labels only" does not mean "blank
 * where there is no label", and a numeric measure must not become a string
 * just because the file is in label mode — Excel would left-align it and stop
 * summing it.
 */
export function renderValue(raw: unknown, v: VariableDef | undefined, mode: ValueMode): unknown {
  if (raw == null || raw === "") return raw ?? "";
  if (mode === "code") return raw;

  /*
   * A multi-select's own column holds the list of codes it was given. The
   * ARRAY is returned, not a joined string: each format already has its own
   * convention for a multiple response — CSV joins with "|", Excel with ", ",
   * JSON keeps it a list — and joining here would silently impose CSV's
   * convention on all three, but only in label mode.
   */
  if (Array.isArray(raw)) return raw.map((item) => renderValue(item, v, mode));

  const label = labelForCode(v, raw);
  if (label == null) return raw;
  return mode === "label" ? label : `${raw}${CODE_LABEL_SEPARATOR}${label}`;
}

/**
 * The header a column is written under.
 *
 * The variable NAME is the identifier — it is what logic, crosstabs and every
 * downstream script refer to — so it stays the header by default. A client
 * spreadsheet often wants the question instead, which is what `headerMode`
 * offers, and "both" keeps the name findable while saying what it means.
 */
export type HeaderMode = "name" | "label" | "name_label";

export function renderHeader(v: VariableDef | undefined, name: string, mode: HeaderMode): string {
  if (!v || mode === "name") return name;
  const label = (v.label ?? "").trim();
  if (!label) return name;
  return mode === "label" ? label : `${name}${CODE_LABEL_SEPARATOR}${label}`;
}

/**
 * Look-up from variable name to its definition, built once per export rather
 * than searched per cell: a 400-response survey with 300 variables is 120,000
 * lookups, and a linear scan through the dictionary for each one is the
 * difference between an export that returns and one that times out.
 */
export function dictionaryIndex(dict: VariableDef[]): Map<string, VariableDef> {
  const m = new Map<string, VariableDef>();
  for (const v of dict) if (!m.has(v.name)) m.set(v.name, v);
  return m;
}
