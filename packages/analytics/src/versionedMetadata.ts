import type { SurveyDefinition } from "@rescript/schema";
import { buildUnionDictionary, type VersionedDefinition } from "@rescript/engine";
import { variableMetadata, type VariableMeta } from "./dataset.js";

/**
 * R7, the analytics half — ONE VARIABLE LIST ACROSS THE VERSIONS A STUDY SPANS.
 *
 * The export was fixed first, and fixing it alone left the platform
 * disagreeing with itself: the delivered CSV read each response through the
 * questionnaire it was collected under, while the crosstab beside it on the
 * same screen still read every response through the current one. Same study,
 * two different answers, depending on which tab you were looking at — which
 * is worse than either being wrong on its own, because whichever number a
 * researcher quotes, the other one contradicts it.
 *
 * ## Why this is not just `buildUnionDictionary`
 *
 * `VariableMeta` is not the dictionary. It carries things the dictionary does
 * not — the analysis ROLE (categorical, scale, multi, complex), the item
 * label a grid cell shows, and the question-level "head" entries that let a
 * researcher crosstab a whole multi-select battery by its question name
 * rather than by 40 flag columns. All of that is derived by
 * `variableMetadata` from `def.questions`, so it has to be computed PER
 * VERSION and merged, not rebuilt from a merged dictionary.
 *
 * What IS taken from the engine's union is the part that must not be decided
 * twice: which codes a variable has, and what a code means when two versions
 * disagree. A code relabelled mid-field reads the same way in the crosstab as
 * it does in the delivered file, because both get it from the same place.
 */

/** The merged variable list, plus which versions it spans. */
export interface UnionMetadata {
  variables: VariableMeta[];
  versions: string[];
  mixed: boolean;
  /** names that not every version declared — a base built on one is not the full sample */
  partial: Set<string>;
}

/** Newest first, numerically — "10.0" must not sort below "2.0". */
function byNewest(a: { version: string }, b: { version: string }): number {
  const parse = (v: string): [number, number] => {
    const m = /^(\d+)(?:\.(\d+))?/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2] ?? 0)] : [-1, -1];
  };
  const [am, an] = parse(a.version);
  const [bm, bn] = parse(b.version);
  return bm - am || bn - an;
}

export function unionVariableMetadata(input: VersionedDefinition[]): UnionMetadata {
  const versions = [...input].sort(byNewest);
  if (versions.length === 0) return { variables: [], versions: [], mixed: false, partial: new Set() };
  if (versions.length === 1) {
    return {
      variables: variableMetadata(versions[0].def),
      versions: [versions[0].version],
      mixed: false,
      partial: new Set(),
    };
  }

  /* the engine decides codes and their labels, so the crosstab and the
   * delivered file cannot disagree about what a 3 means */
  const dict = buildUnionDictionary(versions);
  const byName = new Map(dict.variables.map((v) => [v.name, v]));

  const perVersion = versions.map((v) => ({
    v,
    metas: new Map(variableMetadata(v.def).map((m) => [m.name, m])),
    order: variableMetadata(v.def).map((m) => m.name),
  }));

  /*
   * Order: the newest version's list is the spine; anything only an older
   * version had is inserted after whatever preceded it THERE. Same rule as
   * the dictionary, for the same reason — a variable picker that lists a
   * deleted question after the last section reads as if it belonged there.
   */
  const order: string[] = [...perVersion[0].order];
  const seen = new Set(order);
  for (const { order: names } of perVersion.slice(1)) {
    names.forEach((name, i) => {
      if (seen.has(name)) return;
      seen.add(name);
      let anchor = -1;
      for (let back = i - 1; back >= 0; back--) {
        const at = order.indexOf(names[back]);
        if (at >= 0) { anchor = at; break; }
      }
      if (anchor >= 0) order.splice(anchor + 1, 0, name);
      else order.push(name);
    });
  }

  const partial = new Set<string>();
  const variables: VariableMeta[] = [];
  for (const name of order) {
    const present = perVersion.filter((p) => p.metas.has(name));
    if (!present.length) continue;
    if (present.length !== versions.length) partial.add(name);

    /* the newest version that HAS it describes it: its role, its labels, its
     * section — the researcher's most recent intent for the variable */
    const base = { ...(present[0].metas.get(name) as VariableMeta) };

    /*
     * Categories come from the engine's union when it knows this name, so a
     * code added in v2 appears in the banner and a code whose meaning changed
     * carries the same combined label the export gives it. A question-level
     * head (a multi-select battery) has no dictionary entry of its own, so it
     * keeps the categories `variableMetadata` derived.
     */
    const merged = byName.get(name);
    if (merged && merged.valueCodes.length) {
      base.categories = merged.valueCodes.map((c) => ({
        code: String(c),
        label: merged.valueLabels[String(c)] ?? String(c),
      }));
    }
    variables.push(base);
  }

  return {
    variables,
    versions: versions.map((v) => v.version),
    mixed: true,
    partial,
  };
}

/**
 * The definition to read one response through, by its `version_id`.
 *
 * Falls back to `current` for a row whose version cannot be resolved, exactly
 * as the export does: a response read through a slightly wrong questionnaire
 * is bad, and dropping it from every base and every banner without saying so
 * is worse.
 */
export function definitionResolver(
  versions: VersionedDefinition[],
  current: SurveyDefinition,
): (versionId: string | null | undefined) => SurveyDefinition {
  const byId = new Map(versions.map((v) => [v.versionId, v.def]));
  return (versionId) => (versionId ? byId.get(versionId) ?? current : current);
}
