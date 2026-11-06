/**
 * WHAT BACK TAKES BACK (2026-11-05).
 *
 * A respondent on page 7 presses Back. Everything the survey DERIVED while they were on page 7 — and on any page
 * Back has just put in front of them again — was derived from answers they are now free to change, so it must
 * not survive the trip:
 *
 *   • a hidden / calculated / set-hidden question's PUNCHED answer, when its rules read anything on a page from
 *     the landing page onward (`questionDependencies`), or when the question itself sits on one of those pages.
 *     Before this, a `once` rule (the default) filled the hidden question on the first forward pass and never
 *     looked at it again: Q32 = 2 punched SEGMENT = Medium, the respondent went back and typed 9, and SEGMENT
 *     stayed Medium for the rest of the interview — with every display rule, quota and export reading the
 *     opposite of the answers on the page. `withdrawStalePunches` only takes back `always` rules.
 *
 *   • every value a SCRIPT wrote from one of those pages — `rs.setAnswer`, `setEmbedded`, `setCalc`, `flag` —
 *     which `state.scriptWrites` records with the page it was written on (`page`, since this change). A page's
 *     on_load runs again when the page is shown again, and `get` used to tell it an answer already existed, so a
 *     script written as "set the default" never set it twice; now it starts from nothing, exactly as it did the
 *     first time. Writes from the survey-level on_load (no page) and from pages still behind the respondent are
 *     kept: a value page 2's script set is page 2's to set, and page 2 is not being revisited.
 *
 * The respondent's OWN answers on the pages ahead are kept, as every survey tool keeps them: Back is for changing
 * one thing, not for retyping everything. What was computed FROM them is recomputed on the way forward —
 * `punchDerivedQuestions` runs on every forward move and now finds the question empty, and the page's on_load
 * runs in a fresh logic frame.
 *
 * A programmed `defaultValue` on a derived question is the programmer's, not a punch's, and is left alone (the
 * same rule `withdrawStalePunches` follows).
 */
import type { Question, SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import { answerKey, getQuestionByCodeOrVar } from "./state.js";
import type { RuntimeStep } from "./flow.js";
import { questionDependencies } from "./dependencies.js";

const isDerived = (q: Question) => q.type === "hidden" || q.type === "calculated" || !!q.settings?.hidden;

function hasProgrammedDefault(q: Question): boolean {
  const dv = (q.settings as { defaultValue?: unknown } | undefined)?.defaultValue;
  return dv !== undefined && dv !== null && dv !== "";
}

/** every answer key that belongs to `q` — the bare key and every loop iteration's */
function keysOf(state: ResponseState, q: Question): string[] {
  const bare = answerKey(q.id, null);
  return Object.keys(state.answers).filter((k) => k === bare || k.startsWith(bare + "@"));
}

export interface BackClearResult {
  /** derived questions whose punched answer was cleared */
  punched: string[];
  /** script-written targets cleared, as `kind:target` */
  scripted: string[];
}

/**
 * Clear what was derived on or after `fromIndex` (the page Back lands on) and on `leavingPageId` (the page Back
 * leaves — which, after a skip, may compile AFTER the landing index or not at all). Mutates `state`.
 */
export function clearDerivedOnBack(
  def: SurveyDefinition,
  state: ResponseState,
  steps: RuntimeStep[],
  fromIndex: number,
  leavingPageId: string | null,
): BackClearResult {
  const aheadPages = new Set<string>();
  const aheadQuestions = new Set<string>();
  for (let i = Math.max(0, fromIndex); i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "page") continue;
    aheadPages.add(s.pageId);
    for (const id of s.questionIds) aheadQuestions.add(id);
  }
  if (leavingPageId) {
    aheadPages.add(leavingPageId);
    const leaving = steps.find((s) => s.kind === "page" && s.pageId === leavingPageId);
    if (leaving?.kind === "page") for (const id of leaving.questionIds) aheadQuestions.add(id);
  }
  const out: BackClearResult = { punched: [], scripted: [] };

  /* 1. punched derived questions */
  for (const q of def.questions) {
    if (!isDerived(q) || !q.punches?.length || hasProgrammedDefault(q)) continue;
    const deps = questionDependencies(def, q);
    const reads = aheadQuestions.has(q.id) || [...deps].some((d) => aheadQuestions.has(d));
    if (!reads) continue;
    const keys = keysOf(state, q);
    if (!keys.length) continue;
    for (const k of keys) delete state.answers[k];
    out.punched.push(q.id);
  }

  /* 2. script writes made from the pages ahead */
  const writes = state.scriptWrites ?? [];
  if (writes.length) {
    const keep: typeof writes = [];
    for (const w of writes) {
      const page = (w as { page?: string }).page;
      if (!page || !aheadPages.has(page.split("@")[0]!) && !aheadPages.has(page)) { keep.push(w); continue; }
      if (w.kind === "answer") {
        if (w.target in state.answers) delete state.answers[w.target];
        else {
          /* the target was recorded as a key; a code / variable name resolves to its question's keys */
          const q = getQuestionByCodeOrVar(def, w.target);
          if (q) for (const k of keysOf(state, q)) delete state.answers[k];
        }
      } else if (w.kind === "embedded") {
        delete state.embedded[w.target];
      } else if (w.kind === "calculated") {
        delete state.calculated[w.target];
      } else if (w.kind === "flag") {
        state.flags = state.flags.filter((f) => f !== w.target);
      }
      out.scripted.push(`${w.kind}:${w.target}`);
    }
    if (keep.length !== writes.length) state.scriptWrites = keep;
  }
  return out;
}
