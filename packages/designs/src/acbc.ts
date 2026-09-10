/**
 * Adaptive CBC (ACBC) — the design generator.
 *
 * ACBC has no pre-generated task table: the concepts a respondent sees are
 * built around THEIR build-your-own answer at interview time, by the engine's
 * state machine (`@rescript/engine` acbc.ts), deterministically from the
 * respondent's seed. So this plugin does what a generator can do for an
 * adaptive method — hold and validate the configuration (attributes, levels,
 * prohibitions, stage sizes), and emit a STAGE PLAN as the design file: one
 * row per stage with its counts, so the Studio's design preview, the CSV
 * download and the analysis can see what every respondent will go through
 * even though no two see the same concepts.
 */
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { normalizeAcbc, type AcbcConfig } from "@rescript/engine";

export type { AcbcConfig } from "@rescript/engine";

export const acbcPlugin: DesignGeneratorPlugin<AcbcConfig> = {
  kind: "acbc",
  label: "Adaptive CBC (ACBC)",
  description:
    "Build-your-own → screening (concepts near the BYO, with unacceptable and must-have rules put to the respondent) → choice tournament among the concepts they kept. Adaptive per respondent; this design holds the configuration and the stage plan.",
  configFields: [
    { name: "attributes", label: "Attributes & levels", type: "attributes", help: "Each attribute needs at least 2 levels. Price is an ordinary attribute here." },
    { name: "prohibitions", label: "Prohibitions", type: "prohibitions", help: "Level pairs that may never appear together in one concept." },
    { name: "screeningTasks", label: "Screening screens", type: "number", default: 6 },
    { name: "conceptsPerScreen", label: "Concepts per screen", type: "number", default: 4 },
    { name: "maxAttributesVaried", label: "Most attributes a concept differs from the BYO in", type: "number", default: 2 },
    { name: "unacceptableThreshold", label: "Rejections before a level is asked as unacceptable", type: "number", default: 3 },
    { name: "mustHaveThreshold", label: "Accepted concepts before a shared level is asked as must-have", type: "number", default: 3 },
    { name: "tournamentAlternatives", label: "Concepts per tournament set", type: "number", default: 3 },
    { name: "minTournamentConcepts", label: "Minimum concepts in the tournament (padded if fewer were accepted)", type: "number", default: 6 },
  ],

  validateConfig(config: AcbcConfig): string[] {
    const errors: string[] = [];
    const c = normalizeAcbc(config);
    if (c.attributes.length < 2) errors.push("ACBC requires at least 2 attributes.");
    for (const a of c.attributes) {
      if (!a.name) errors.push("Every attribute needs a name.");
      if (!a.levels || a.levels.length < 2) errors.push(`Attribute "${a.name ?? "?"}" needs at least 2 levels.`);
    }
    const names = c.attributes.map((a) => a.name);
    if (new Set(names).size !== names.length) errors.push("Attribute names must be unique.");
    const levelsOf = new Map(c.attributes.map((a) => [a.name, new Set(a.levels)]));
    for (const p of c.prohibitions) {
      for (const side of [p.a, p.b]) {
        const known = levelsOf.get(side.attribute);
        if (!known) errors.push(`Prohibition names attribute "${side.attribute}", which is not in this design.`);
        else if (!known.has(side.level)) errors.push(`Prohibition names level "${side.level}" of "${side.attribute}", which is not one of its levels.`);
      }
      if (p.a.attribute === p.b.attribute) errors.push(`A prohibition cannot pair two levels of the same attribute ("${p.a.attribute}").`);
    }
    if ((config.screeningTasks ?? 6) < 1) errors.push("At least one screening screen is needed.");
    if ((config.conceptsPerScreen ?? 4) < 2) errors.push("At least 2 concepts per screen.");
    if ((config.tournamentAlternatives ?? 3) < 2) errors.push("A tournament set needs at least 2 concepts.");
    const space = c.attributes.reduce((n, a) => n * Math.max(1, a.levels.length), 1) - 1;
    if (errors.length === 0 && space < c.conceptsPerScreen) errors.push(`Only ${space} concepts other than the BYO exist; each screen needs ${c.conceptsPerScreen}.`);
    return errors;
  },

  generate(config: AcbcConfig, _seed: number) {
    const problems = acbcPlugin.validateConfig!(config);
    if (problems.length) throw new Error(problems[0]);
    const c = normalizeAcbc(config);
    const columns = ["stage", "step", "items", "note"];
    const rows: Record<string, unknown>[] = [
      { stage: "byo", step: 1, items: c.attributes.length, note: "One level per attribute — the respondent's ideal" },
      ...Array.from({ length: c.screeningTasks }, (_, i) => ({ stage: "screen", step: i + 1, items: c.conceptsPerScreen, note: `Concepts differing from the BYO in up to ${c.maxAttributesVaried} attribute${c.maxAttributesVaried === 1 ? "" : "s"}; a possibility / won't work` })),
      { stage: "rules", step: 1, items: 0, note: `Unacceptable after ${c.unacceptableThreshold} rejections and no acceptance; must-have after ${c.mustHaveThreshold} accepted concepts sharing a level` },
      { stage: "tournament", step: 1, items: c.tournamentAlternatives, note: `Sets of ${c.tournamentAlternatives} from at least ${c.minTournamentConcepts} concepts plus the BYO, until one remains` },
    ];
    const summary = {
      attributes: c.attributes.length,
      levels: c.attributes.reduce((n, a) => n + a.levels.length, 0),
      conceptSpace: c.attributes.reduce((n, a) => n * a.levels.length, 1),
      screeningTasks: c.screeningTasks, conceptsPerScreen: c.conceptsPerScreen,
      adaptive: "concepts are generated per respondent at interview time from this configuration and the respondent's seed",
    };
    return { columns, rows, summary };
  },
};
