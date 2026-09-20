import type { SurveyDefinition, VariableDef } from "@rescript/schema";
import { buildVariableDictionary } from "@rescript/engine";

/**
 * R7, the exporters' half — WHICH DEFINITION DESCRIBES THIS ROW.
 *
 * Every exporter here is built the same way, because every one of them has
 * to be: take a dictionary, derive the column list from it, then walk the
 * rows flattening each one. Both halves assumed ONE definition for the whole
 * file, which is true only while a study has never been versioned.
 *
 * Rather than teach four exporters about versions, they each ask this for
 * the two things that actually differ: the column list, and the definition
 * to read a given row through. A caller that passes nothing gets exactly
 * what it got before — the same dictionary from the same definition, and
 * every row read through it — so nothing that exists today changes shape.
 *
 * The union dictionary and the per-row definitions are built in
 * @rescript/engine (`versionedDictionary.ts`); this is only the seam through
 * which an exporter receives them.
 */
export interface VersionedSource {
  /** the column list, already unioned across versions and in file order */
  dictionary: VariableDef[];
  /**
   * The definition row `index` was collected under.
   *
   * A column the row's own version did not declare simply will not be in its
   * flattened output, and every exporter already renders an absent key as
   * its own kind of empty — a blank cell, a system-missing. That is why
   * nothing here has to invent a placeholder: inventing one is how an empty
   * string ends up in a numeric column and is read as an answer.
   */
  defFor(index: number): SurveyDefinition;
}

/** The dictionary to build columns from: the union when there is one. */
export function dictionaryFor(def: SurveyDefinition, versioned?: VersionedSource): VariableDef[] {
  return versioned?.dictionary ?? buildVariableDictionary(def);
}

/** The definition to flatten one row through. */
export function defForRow(def: SurveyDefinition, index: number, versioned?: VersionedSource): SurveyDefinition {
  return versioned ? versioned.defFor(index) : def;
}
