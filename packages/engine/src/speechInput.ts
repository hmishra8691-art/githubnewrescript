import type { Question, QuestionRow, SurveyDefinition } from "@rescript/schema";

/**
 * DICTATION ON EVERY OPEN TEXT FIELD — which field takes it, and who turned
 * it off.
 *
 * The renderer's microphone (`SpeechInputButton`, Web Speech API) used to
 * appear only where an author ticked "allow dictation" on a single- or
 * multi-line text question. It is now ON BY DEFAULT for every editable
 * free-text answer field, so the decision has two halves, both here so the
 * renderer and the Studio ask the same function:
 *
 *   OPT-OUT   `def.deployment.speechInput === false` turns it off for the
 *             whole survey; `q.settings.speechInput === false` for one
 *             question. Absent (or the legacy opt-in `true`) means on.
 *   FIELD     a field takes dictation only when what it collects is prose:
 *             never a formatted value (email, phone, URL, ZIP, number, date, a
 *             regex mask), never a read-only or hidden question.
 *
 * Nothing about the answer changes: the transcript goes through the field's
 * ordinary onChange, under the field's ordinary key.
 */

/** Validation kinds that make a text box a FORMATTED value, not prose. */
export const SPEECH_FORMATTED_RULES: readonly string[] = [
  "email", "phone", "url", "zip", "pattern", "integer", "min_value", "max_value", "date_min", "date_max",
];
/** Text presets that collect a formatted value even with their rule removed. */
export const SPEECH_FORMATTED_VARIANTS: readonly string[] = ["text.email", "text.phone", "text.url", "text.zip", "text.regex"];
/** Form / list field types that are prose. */
export const SPEECH_TEXT_FIELD_TYPES: readonly string[] = ["text", "longtext"];
/** Question types whose own answer is a free-text string drawn by the text inputs. */
const TEXT_ANSWER_TYPES = new Set(["open_text", "long_text"]);
/** Question types whose labelled fields are drawn by the shared form / list inputs. */
const FIELD_LIST_TYPES = new Set(["text_list", "numeric_list", "repeating_group"]);

/** Which field of a question the microphone would sit beside. */
export type SpeechField =
  /** the question's own text answer (single- / multi-line text) */
  | { kind: "answer" }
  /** an "Other, please specify" box — an option's or a grid row's */
  | { kind: "other" }
  /** a labelled field of a form / list / repeating-group question */
  | { kind: "field"; fieldType?: string | null; row?: Pick<QuestionRow, "validation"> | null };

type DefLike = Pick<SurveyDefinition, "deployment"> | { deployment?: { speechInput?: boolean } | null } | null | undefined;
type QLike = Pick<Question, "type" | "settings"> & { variant?: string | null; validation?: Question["validation"] };

/** The survey-wide switch: on unless the survey says `false`. */
export function speechInputSurveyOn(def: DefLike): boolean {
  return (def as { deployment?: { speechInput?: boolean } | null } | null | undefined)?.deployment?.speechInput !== false;
}

/** Both opt-outs and the question's own state: on unless someone turned it off, and never on a field nobody can edit. */
export function speechInputQuestionOn(def: DefLike, q: Pick<Question, "settings">): boolean {
  if (!speechInputSurveyOn(def)) return false;
  const s = (q.settings ?? {}) as { speechInput?: boolean; readOnly?: boolean; hidden?: boolean };
  return s.speechInput !== false && !s.readOnly && !s.hidden;
}

const formatted = (rules: readonly { kind: string }[] | null | undefined) => (rules ?? []).some((r) => SPEECH_FORMATTED_RULES.includes(r.kind));

/** Whether a field is prose — the eligibility half, without the opt-outs. */
export function speechFieldIsProse(q: QLike, field: SpeechField): boolean {
  if (field.kind === "answer") {
    if (!TEXT_ANSWER_TYPES.has(q.type)) return false;
    if (q.variant && SPEECH_FORMATTED_VARIANTS.includes(q.variant)) return false;
    return !formatted(q.validation);
  }
  if (field.kind === "other") return (q.settings as { otherSpecifyFormat?: string } | undefined)?.otherSpecifyFormat !== "numeric";
  const ft = field.fieldType ?? "text";
  return SPEECH_TEXT_FIELD_TYPES.includes(ft) && !formatted(field.row?.validation);
}

/** THE question the renderer asks: does this field of this question show a microphone (when the browser can recognise speech)? */
export function speechInputFor(def: DefLike, q: QLike, field: SpeechField): boolean {
  return speechInputQuestionOn(def, q) && speechFieldIsProse(q, field);
}

/**
 * Does any field of this question take dictation, opt-outs aside? The Studio
 * offers the per-question switch exactly where this is true — so a numeric,
 * an email or a date question never shows a switch that does nothing.
 */
export function questionOffersSpeechInput(q: QLike & Pick<Question, "options" | "rows">): boolean {
  if (speechFieldIsProse(q, { kind: "answer" })) return true;
  const hasOther = (q.options ?? []).some((o) => o.flags?.includes("other_specify")) || (q.rows ?? []).some((r) => r.flags?.includes("other_specify"));
  if (hasOther && speechFieldIsProse(q, { kind: "other" })) return true;
  if (FIELD_LIST_TYPES.has(q.type)) {
    const dflt = q.type === "numeric_list" ? "number" : "text";
    return (q.rows ?? []).some((r) => speechFieldIsProse(q, { kind: "field", fieldType: r.fieldType ?? dflt, row: r }));
  }
  return false;
}

/**
 * A spoken phrase joins what is already in the field with exactly one space.
 * What the respondent typed is left exactly as typed; only the transcript is
 * trimmed. Dictation APPENDS — it never replaces what is there.
 */
export function appendSpoken(current: string, spoken: string): string {
  const add = spoken.trim();
  if (!add) return current;
  if (!current) return add;
  return /\s$/.test(current) ? current + add : `${current} ${add}`;
}

/** The recogniser's language:the question's, the voice mode's, the survey's, then the browser's. */
export function speechInputLang(def: Partial<Pick<SurveyDefinition, "branding" | "deployment">> | null | undefined, q: Pick<Question, "settings">, browser = "en"): string {
  const meta = (def as { meta?: { language?: string } } | null | undefined)?.meta?.language;
  return (q.settings as { speechLang?: string } | undefined)?.speechLang
    || def?.branding?.layout?.voice?.lang
    || meta
    || def?.deployment?.languages?.[0]
    || browser;
}
