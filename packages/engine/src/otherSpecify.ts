import type { Option, Question, QuestionRow, SurveyDefinition } from "@rescript/schema";
import { resolveVariant } from "@rescript/schema";
import { answerKey, answerLookupKeys, type LoopContext, type ResponseState } from "./state.js";

/**
 * "OTHER, SPECIFY" — ONE IDENTITY PER BOX.
 *
 * Every other-specify box belongs to exactly one OPTION, of one question, in
 * one loop iteration, and its text is stored under exactly one key:
 *
 *     `${answerKey(questionId, loop)}__other__${code}`
 *      q_abc__other__97 · q_abc@apple__other__99
 *
 * ## Why this changed
 *
 * It used to be one key per QUESTION — `q_abc__other` — and the file said so
 * on purpose: "a question shows one box, whichever flagged option is chosen".
 * That is true of a single-select, and false of everything else. A ten-option
 * multi-select with three "Other" options shows three boxes, and all three
 * were bound to the same string: typing Apple into the first put Apple into
 * the other two, on screen and in the data. The respondent saw their answer
 * changed under them, and the export recorded one brand where three were
 * named.
 *
 * The fix is not a rendering fix. Three boxes need three identities, so the
 * key grew the one dimension it was missing — the option code — and every
 * layer above it (renderer props, validation, flattening, the dictionary,
 * piping) carries that code through instead of assuming there can only be one.
 *
 * ## Old responses still read correctly
 *
 * A response collected before this change has `q_abc__other` and no
 * per-option key. `otherTextFor` falls back to it for the question's FIRST
 * flagged option, which is the only option that box could have belonged to.
 * Nothing rewrites stored data; the fallback is read-only and permanent.
 * `VAR_other` also stays the column name of that first option, so an export
 * opened next to last month's export still lines up.
 *
 * ## The housekeeping
 *
 * Text typed into a box and then abandoned — the respondent unticks "Other"
 * and picks "Blue" — used to stay in the response for ever. `syncOtherText`
 * removes the text of every flagged option that is no longer selected, and
 * `setAnswer` calls it, so every surface that answers through the engine gets
 * it for free. Per option, now: unticking one "Other" must not take another
 * one's text with it.
 */

/** The flag that makes an option carry an other-specify box. */
export const OTHER_SPECIFY_FLAG = "other_specify";

export function isOtherOption(o: Option): boolean {
  return !!o.flags?.includes(OTHER_SPECIFY_FLAG);
}

/** The flagged options of a question, in their programmed order. */
export function otherOptions(q: Question): Option[] {
  return (q.options ?? []).filter(isOtherOption);
}

/* ------------------------------------------------------------- grid rows */

/**
 * "OTHER, PLEASE SPECIFY" ON A GRID ROW (07-10-2026 review, Suraj #1 and
 * Oweas #1).
 *
 * The Studio has offered `other_specify` on a matrix ROW for months — it is in
 * `allowedRowFlagsFor` — and nothing downstream knew a row could carry it:
 * `otherOptions` reads options only, so the renderer drew no box, the
 * validator asked for nothing, and the export had no column. A grid row
 * labelled "Other, please describe" was rated or given a number with no way to
 * say what it was.
 *
 * A row's box is the same kind of box as an option's, so it is stored the same
 * way — one key per box, under the question's own iteration — with a code in
 * a namespace of its own: `row:<rowCode>`. The prefix is what keeps row 3's box
 * apart from column option 3's box on a grid that flags both. Every function in
 * this file that takes a code takes a row-box code unchanged.
 *
 * Unlike an option's, a row's box is ALWAYS shown: the respondent names the
 * "other" thing and rates it, in either order. So its text is not housekeeping
 * to drop when the row is cleared — it is visible on screen — and the rules
 * are about the PAIR: an answered row needs its text (unless the question
 * says Other text is optional), text needs its row answered, and a row with
 * neither is simply not used — a required grid does not force a respondent to
 * rate an "other" they do not have.
 */
export const ROW_OTHER_PREFIX = "row:";

/** The box code of a flagged row. */
export function rowOtherCode(rowCode: string | number): string {
  return `${ROW_OTHER_PREFIX}${String(rowCode)}`;
}

/** The row code a row-box code names, or null for an option's box. */
export function rowCodeOfOtherCode(code: string | number): string | null {
  const s = String(code);
  return s.startsWith(ROW_OTHER_PREFIX) ? s.slice(ROW_OTHER_PREFIX.length) : null;
}

export function isOtherRow(r: { flags?: readonly string[] | null }): boolean {
  return !!r.flags?.includes(OTHER_SPECIFY_FLAG);
}

/** The flagged rows of a question, in their programmed order. */
export function otherRows(q: Question): QuestionRow[] {
  return (q.rows ?? []).filter(isOtherRow);
}

/** Every box a question can have — options first, then rows — as box codes. */
export function otherBoxCodes(q: Question): string[] {
  return [
    ...otherOptions(q).map((o) => String(o.code)),
    ...otherRows(q).map((r) => rowOtherCode(r.code)),
  ];
}

/** The label of the option or row a box belongs to. */
export function otherBoxLabel(q: Question, code: string | number): string {
  const rc = rowCodeOfOtherCode(code);
  const owner = rc != null
    ? (q.rows ?? []).find((r) => String(r.code) === rc)
    : (q.options ?? []).find((o) => String(o.code) === String(code));
  return owner ? String(owner.label ?? "") : "";
}

/**
 * WHERE A ROW CAN CARRY A BOX: the grids that draw their row labels through
 * the renderer's `RowLabel` — the plain matrix and mixed table (no renderer
 * of their own), Likert, Rating, Star, Slider and Constant-Sum matrices, and
 * the editable table. A swipe card, a drag chip or a bipolar pair has no row
 * label to put a box beside, so the Studio does not offer the flag there:
 * offering what the respondent will never see is how this bug began.
 */
const ROW_BOX_RENDERERS = new Set(["likert", "ratingmatrix", "starmatrix", "slidermatrix", "summatrix", "spreadsheet"]);
const ROW_BOX_TYPES = new Set(["matrix_single", "matrix_multi", "matrix_numeric", "matrix_text", "matrix_dropdown", "composite", "custom_table"]);

export function rowOtherBoxSupported(q: { type: string; variant?: string | null }): boolean {
  if (!ROW_BOX_TYPES.has(q.type)) return false;
  const renderer = resolveVariant(q.variant ?? undefined)?.renderer;
  return !renderer || ROW_BOX_RENDERERS.has(renderer);
}

/** Is a grid row's answer present? A cell map counts when any cell is filled. */
export function rowHasAnswer(v: unknown): boolean {
  if (v == null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).some(rowHasAnswer);
  return true;
}

/**
 * THE key one box's text is stored under. Nothing else may spell it.
 *
 * The code is part of the key because it is part of the identity. Position
 * would not do: reordering the options in the Studio must not move a
 * respondent's text from one box to another, and a code is the one thing
 * about an option that is promised to be stable.
 */
export function otherKeyFor(
  questionId: string,
  code: string | number,
  loop?: LoopContext | null,
): string {
  return `${answerKey(questionId, loop ?? null)}__other__${String(code)}`;
}

/**
 * The pre-per-option key, still read and never written.
 *
 * Exported because the flattener and the validator both have to recognise it
 * in old data, and a magic string in three files is how the last bug got in.
 */
export function legacyOtherKey(questionId: string, loop?: LoopContext | null): string {
  return `${answerKey(questionId, loop ?? null)}__other`;
}

/** True for any key that holds an other-specify text, new shape or old. */
export function isOtherAnswerKey(key: string): boolean {
  return key.includes("__other");
}

/**
 * The text in one option's box.
 *
 * Two rules, and the difference between them is the whole of §3 of the
 * brief — the value contract.
 *
 * ## An empty box is an answer, not a missing one
 *
 * This used to read `if (own != null && own !== "") return String(own)`,
 * which folded three different states together: no box, an empty box, and a
 * box that was never reached. An empty string then fell through to the
 * legacy key and RESURRECTED text from a response collected months earlier —
 * a respondent who cleared their answer saw the old one come back, in the
 * data if not on the screen. So presence decides: if the key exists, its
 * value is the answer, `""` included. Only an ABSENT key consults the legacy
 * one, which is exactly what the fallback was for.
 *
 * ## It is read from an iteration, like every other answer
 *
 * The key is built exactly, while `lookupAnswer` walks outward through the
 * enclosing iterations. So a question answered outside a loop had an Other
 * text that ordinary piping could see and `{{Q1.other}}` could not: inside
 * the loop it returned "" and the sentence lost the respondent's own words.
 * `answerLookupKeys` is the one statement of that walk, and this now uses it —
 * deepest iteration first, then each enclosing one, then the survey level.
 */
export function otherTextFor(
  state: ResponseState,
  q: Question,
  code: string | number,
  loop?: LoopContext | null,
): string {
  const suffix = `__other__${String(code)}`;
  for (const base of answerLookupKeys(q.id, loop ?? null)) {
    const k = `${base}${suffix}`;
    if (k in state.answers) {
      const own = state.answers[k];
      return own == null ? "" : String(own);
    }
  }

  const flagged = otherOptions(q);
  if (flagged.length && String(flagged[0]!.code) === String(code)) {
    for (const base of answerLookupKeys(q.id, loop ?? null)) {
      const k = `${base}__other`;
      if (k in state.answers) {
        const legacy = state.answers[k];
        return legacy == null ? "" : String(legacy);
      }
    }
  }
  return "";
}

/** Every box of this question that has text, keyed by option code. */
export function otherTextsOf(
  state: ResponseState,
  q: Question,
  loop?: LoopContext | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const code of otherBoxCodes(q)) {
    const text = otherTextFor(state, q, code, loop);
    if (text) out[code] = text;
  }
  return out;
}

/**
 * Store one box's text. An empty string removes the key rather than storing
 * "" — an absent answer, not a blank one.
 *
 * Clearing also removes the legacy key when this is the first flagged option,
 * so a respondent who empties a box carried over from an old response sees it
 * stay empty instead of the fallback putting the old text straight back.
 */
export function setOtherTextFor(
  state: ResponseState,
  q: Question,
  code: string | number,
  text: string,
  loop?: LoopContext | null,
): void {
  const key = otherKeyFor(q.id, code, loop);
  if (text === "") {
    /*
     * INSIDE AN ITERATION, EMPTY IS STORED — IT IS NOT AN ABSENCE.
     *
     * `otherTextFor` walks outward through the enclosing iterations to the
     * survey level, which is right for a box that was never filled in this
     * iteration and wrong for one that was emptied: deleting the key made the
     * read fall through, so clearing a box inside a loop put the OUTER
     * iteration's text back on the screen and into the data. A respondent who
     * typed "Tesla" at brand 1 and then cleared the box at brand 2 was
     * recorded as having said "Tesla" twice.
     *
     * Presence decides, and it can only decide if the presence is written. At
     * the survey level there is nothing to inherit from, so the key goes — and
     * the legacy key with it, which is what stops text from an older response
     * coming back.
     */
    if (loop) { state.answers[key] = "" as never; return; }
    delete state.answers[key];
    const flagged = otherOptions(q);
    if (flagged.length && String(flagged[0]!.code) === String(code)) {
      delete state.answers[legacyOtherKey(q.id, loop)];
    }
    return;
  }
  state.answers[key] = text as never;
}

/* ------------------------------------------------------------ single-box */

/**
 * The question's other text when there is only one box to mean.
 *
 * Kept because a great deal of calling code — the voice console, the Studio
 * simulator, older tests — has one flagged option and no way to name it.
 * With several flagged options it reads the first, which is the same thing it
 * did before and is now clearly a narrowing rather than the whole story.
 */
export function otherTextOf(state: ResponseState, q: Question, loop?: LoopContext | null): string {
  const first = otherOptions(q)[0];
  return first ? otherTextFor(state, q, first.code, loop) : "";
}

export function setOtherText(state: ResponseState, q: Question, text: string, loop?: LoopContext | null): void {
  const first = otherOptions(q)[0];
  if (first) setOtherTextFor(state, q, first.code, text, loop);
}

/* ------------------------------------------------------------- selection */

/** The flagged option codes this answer selects. */
export function selectedOtherCodes(q: Question, answer: unknown): string[] {
  const flagged = otherOptions(q);
  if (!flagged.length || answer == null || answer === "") return [];
  const codes = new Set(flagged.map((o) => String(o.code)));

  const hit = new Set<string>();
  const take = (v: unknown) => { const s = String(v); if (codes.has(s)) hit.add(s); };

  if (Array.isArray(answer)) answer.forEach(take);
  else if (typeof answer === "object") {
    // per-row grids: a row's value, or each of its values
    for (const v of Object.values(answer as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach(take); else take(v);
    }
  } else take(answer);

  // programmed order, so "the first one" means the same thing everywhere
  return flagged.map((o) => String(o.code)).filter((c) => hit.has(c));
}

/** Does this answer select any option flagged `other_specify`? */
export function otherIsSelected(q: Question, answer: unknown): boolean {
  return selectedOtherCodes(q, answer).length > 0;
}

/**
 * Drop abandoned other text, per box.
 *
 * Called by `setAnswer` for the question just answered. Unticking one "Other"
 * must take its own text and nothing else: with three boxes on one question,
 * clearing them all would delete two answers the respondent still means.
 * Returns true when something was removed.
 */
export function syncOtherText(state: ResponseState, q: Question, loop?: LoopContext | null): boolean {
  const flagged = otherOptions(q);
  if (!flagged.length) return false;

  const still = new Set(selectedOtherCodes(q, state.answers[answerKey(q.id, loop ?? null)]));
  let removed = false;

  for (const o of flagged) {
    if (still.has(String(o.code))) continue;
    const key = otherKeyFor(q.id, o.code, loop);
    if (state.answers[key] !== undefined) { delete state.answers[key]; removed = true; }
  }

  // and the legacy key, which belonged to the first flagged option
  const legacy = legacyOtherKey(q.id, loop);
  if (state.answers[legacy] !== undefined && !still.has(String(flagged[0]!.code))) {
    delete state.answers[legacy];
    removed = true;
  }
  return removed;
}

/** Remove every box's text for this question — used when the question itself goes away. */
export function clearOtherText(state: ResponseState, q: Question, loop?: LoopContext | null): void {
  for (const code of otherBoxCodes(q)) delete state.answers[otherKeyFor(q.id, code, loop)];
  delete state.answers[legacyOtherKey(q.id, loop)];
}

/* ------------------------------------------------------- export / analysis */

/**
 * Every other-specify text in a response, one entry per BOX — for storage,
 * export and analysis, where "which box was this typed into" is the whole
 * question. Loop iterations are reported separately, with the iteration path,
 * because they are separate answers.
 */
export interface OtherSpecifyEntry {
  questionId: string;
  /** the variable this question writes, for the column name */
  variableName: string;
  /** the option whose box this is — or `row:<code>` for a grid row's box */
  optionCode: string;
  optionLabel: string;
  /** the column this text is exported under */
  column: string;
  /** the loop suffix, "" outside a loop (e.g. "@apple") */
  iteration: string;
  text: string;
}

/**
 * The export column for one box.
 *
 * The FIRST flagged option keeps `VAR_other`, unchanged, because that is the
 * column every existing export, syntax file and analysis script already
 * knows. Additional boxes are new, so they get a new, unambiguous name rather
 * than renaming the one that was already right.
 */
export function otherColumnFor(q: Question, code: string | number): string {
  /* a row's box sits beside the row's own column: VAR_<row>_other */
  const rc = rowCodeOfOtherCode(code);
  if (rc != null) return `${q.variableName}_${rc}_other`;
  const flagged = otherOptions(q);
  const first = flagged[0];
  return first && String(first.code) === String(code)
    ? `${q.variableName}_other`
    : `${q.variableName}_other_${String(code)}`;
}

export function otherSpecifyEntries(def: SurveyDefinition, state: ResponseState): OtherSpecifyEntry[] {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const out: OtherSpecifyEntry[] = [];
  const seen = new Set<string>();

  const push = (q: Question, code: string, iteration: string, text: string) => {
    const dedupe = `${q.id}${iteration}__${code}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({
      questionId: q.id,
      variableName: q.variableName,
      optionCode: code,
      optionLabel: otherBoxLabel(q, code),
      column: otherColumnFor(q, code),
      iteration,
      text,
    });
  };

  for (const [key, value] of Object.entries(state.answers)) {
    if (typeof value !== "string" || !value) continue;

    const at = key.indexOf("__other__");
    if (at >= 0) {
      const base = key.slice(0, at);
      const code = key.slice(at + "__other__".length);
      const loopAt = base.indexOf("@");
      const q = byId.get(loopAt < 0 ? base : base.slice(0, loopAt));
      if (!q) continue;
      push(q, code, loopAt < 0 ? "" : base.slice(loopAt), value);
      continue;
    }

    /* the legacy shape, which belonged to the first flagged option */
    if (!key.endsWith("__other")) continue;
    const base = key.slice(0, -"__other".length);
    const loopAt = base.indexOf("@");
    const q = byId.get(loopAt < 0 ? base : base.slice(0, loopAt));
    if (!q) continue;
    const first = otherOptions(q)[0];
    if (!first) continue;
    push(q, String(first.code), loopAt < 0 ? "" : base.slice(loopAt), value);
  }
  return out;
}

/**
 * WHAT AN "OTHER (SPECIFY)" BOX WILL ACCEPT.
 *
 * Nothing checked this text before: the box took whatever was typed, and the
 * only rule was that it must not be empty when the option was selected. The
 * review asked for the three formats a research team actually wants — text
 * only, numbers only, or both — so a box asking "which other brand?" cannot
 * come back holding a phone number.
 *
 * Returns null when the text is acceptable, or the reason it is not. A
 * question that names no format accepts anything, exactly as before.
 */
export function checkOtherText(
  format: "text" | "numeric" | "alphanumeric" | undefined,
  text: string,
): string | null {
  const t = text.trim();
  if (!format || !t) return null;
  switch (format) {
    case "text":
      /* letters, spaces and the punctuation names actually contain */
      return /^[\p{L}\p{M}\s.,'’&()\/-]+$/u.test(t) ? null : "Please use letters only.";
    case "numeric":
      return /^-?\d+(\.\d+)?$/.test(t) ? null : "Please enter a number.";
    case "alphanumeric":
      return /^[\p{L}\p{M}\p{N}\s.,'’&()\/-]+$/u.test(t) ? null : "Please use letters and numbers only.";
    default:
      return null;
  }
}
