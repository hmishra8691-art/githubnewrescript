import { applyPasteInstructions, type PasteInstruction } from "@rescript/engine";
import type { StudioState } from "./store";

/**
 * A paste carried notes to the programmer ("[RANDOMIZE]", "[ASK ONLY IF Q1 = 1]", "(SPECIFY)"). The paste engine
 * has already taken them out of the wording; this applies the ones that can be read with confidence to the question
 * they were pasted into, writes the others to its Notes for review, and tells the person which is which.
 *
 * `optionIndex` is where the paste landed when it was pasted into ONE option's label: a note with no line of its
 * own ("Other (SPECIFY)" pasted into option 3) belongs to that option.
 */
export function applyPasteNotes(s: Pick<StudioState, "update" | "labelNextEdit" | "notePaste">, questionId: string | undefined, instructions: PasteInstruction[], optionIndex?: number): void {
  if (!instructions.length) return;
  if (!questionId) { s.notePaste({ applied: [], review: instructions.map((i) => i.raw) }); return; }
  let applied: string[] = [], review: string[] = [];
  s.labelNextEdit("apply pasted programmer notes");
  s.update((d) => {
    const q = d.questions.find((x) => x.id === questionId);
    if (!q) return;
    const r = applyPasteInstructions(d, q, instructions, (ins) => (ins.line != null && ins.line >= 0 && optionIndex == null ? ins.line : optionIndex != null ? optionIndex + Math.max(0, ins.line ?? 0) : -1));
    applied = r.applied; review = r.review.map((x) => x.raw);
  });
  s.notePaste({ applied, review });
}
