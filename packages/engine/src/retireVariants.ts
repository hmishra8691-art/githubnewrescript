import { resolveVariant, variantRegistry, type SurveyDefinition } from "@rescript/schema";

/**
 * REWRITE A RETIRED VARIANT ID TO THE ONE THAT SURVIVED IT.
 *
 * The September 2026 review said "remove one of these" seven times: Tile
 * Select is Card Select with three columns, Pick Exactly N is Checkbox with
 * min = max = N, Rank All and Rank Top N are Click-to-Rank with and without a
 * limit, Percentage Slider and Discrete Slider are Single Slider with
 * different defaults. Each of those is true — they share a base type, a
 * renderer and a response model, and the registry already describes them as
 * presets rather than types.
 *
 * Removing a definition outright is not an option. A survey in field stores
 * the variant id, and an id that resolves to nothing loses its renderer: a
 * Tile Select would stop being drawn as cards at all. What `supersededBy`
 * already does is keep the id resolving while hiding it from the picker, and
 * that is how this works at READ time.
 *
 * This is the other half, at WRITE time. When the Studio opens a survey, a
 * question still carrying a retired id is rewritten to the survivor's, so the
 * id disappears from the data rather than merely from the menus. It is safe
 * because a preset's defaults were applied to the question when it was
 * created — a Tile Select already holds `columnsLayout: 3` on itself, a Pick
 * Exactly N already holds its min and max — so the survivor renders it
 * identically. Nothing about the question changes except the name of the
 * variant it claims to be.
 *
 * Idempotent, and a no-op for every survey that holds no retired id, which is
 * what makes it safe to run on every read.
 */

export interface RetirementResult {
  def: SurveyDefinition;
  /** questionId -> [old variant id, new variant id] */
  rewritten: Record<string, [string, string]>;
  /** nothing to do — the caller can skip the write */
  clean: boolean;
}

export function migrateRetiredVariants(input: SurveyDefinition): RetirementResult {
  const rewritten: Record<string, [string, string]> = {};
  let def = input;

  for (const q of input.questions ?? []) {
    const id = q.variant;
    if (!id) continue;
    const stored = variantRegistry.get(id);
    if (!stored?.supersededBy) continue;
    const survivor = resolveVariant(id);
    if (!survivor || survivor.id === id) continue;
    /*
     * Only when the survivor stores the same way. A retirement that changed
     * the response model would change what every stored answer means, and the
     * registry's own test forbids it — but this code would be the one acting
     * on it, so it checks rather than trusting.
     */
    if (survivor.responseModel !== stored.responseModel || survivor.baseType !== stored.baseType) continue;
    rewritten[q.id] = [id, survivor.id];
  }

  if (Object.keys(rewritten).length) {
    def = {
      ...input,
      questions: input.questions.map((q) =>
        rewritten[q.id] ? { ...q, variant: rewritten[q.id][1] } : q),
    };
  }

  return { def, rewritten, clean: Object.keys(rewritten).length === 0 };
}
