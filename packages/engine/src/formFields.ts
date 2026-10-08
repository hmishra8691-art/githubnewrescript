import type { Question, QuestionRow } from "@rescript/schema";
import { uiText } from "./localization.js";

/**
 * WHICH FIELDS OF A FORM-STYLE LIST MUST BE FILLED — said once, read by the
 * validator and by the respondent's screen (07-10-2026 review, Suraj #3/#4).
 *
 * A field is required when it says so (Required / Optional on the field
 * itself). A question marked required whose fields say nothing means every
 * field — the rule the validator has always applied — so a question can be
 * made "all required" in one click and one field can be singled out by
 * marking just that one.
 *
 * The review asked for the rule to be written out rather than marked with a
 * star beside each label: "do not show the star; show a clear instruction".
 * `requiredFieldsNote` is that instruction, built from exactly the fields the
 * validator will hold the respondent to, so the two cannot disagree.
 */
export function fieldIsRequired(q: Pick<Question, "required" | "rows">, row: Pick<QuestionRow, "required">): boolean {
  return !!row.required || (!!q.required && !(q.rows ?? []).some((r) => r.required));
}

const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/**
 * The sentence above the fields, or null when nothing is required.
 * `rows` is the list the respondent sees (masked / conditional fields out).
 */
export function requiredFieldsNote(
  q: Pick<Question, "required" | "rows">,
  rows: readonly Pick<QuestionRow, "required" | "label" | "code">[],
  ui?: Record<string, string>,
): string | null {
  const req = rows.filter((r) => fieldIsRequired(q, r));
  if (!req.length) return null;
  if (rows.length > 1 && req.length === rows.length) return uiText(ui, "fields_required_all");
  if (req.length === 1) return uiText(ui, "fields_required_one", { field: plain(req[0]!.label) || String(req[0]!.code) });
  return uiText(ui, "fields_required_some", { fields: req.map((r) => plain(r.label) || String(r.code)).join(", ") });
}
