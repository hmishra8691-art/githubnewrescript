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
import { normalizeAcbc, parsePriceIncrements, type AcbcConfig } from "@rescript/engine";
import { effectiveProhibition, type ConjointLevelCondition, type ConjointProhibition } from "./conjoint.js";

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
    /* F4 2026-10-22: summed price (optional; absent → no price shown, as before) */
    { name: "priceBase", label: "Summed price: base price (blank = no summed price)", type: "number", help: "The price of a concept with every attribute at its cheapest level, before the increments below." },
    { name: "priceIncrements", label: "Summed price: increment per level", type: "list", help: "One line per attribute that adds to the price, one number per level in level order: Brand: 0, 50, 120" },
    { name: "priceVariation", label: "Summed price: random variation ± %", type: "number", default: 30, help: "Every screened and tournament concept's price is varied by up to this percentage, so price is not confounded with the levels (Sawtooth's default is about 30%)." },
    { name: "priceRound", label: "Summed price: round to", type: "number", default: 1 },
    { name: "priceCurrency", label: "Summed price: currency symbol", type: "text" },
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
      /*
       * Every level the prohibition names — the pair, its `also` levels, or
       * the leaves of a `when` tree (conjoint audit 2026-10-17: a `when`-only
       * rule used to crash here on the missing pair).
       */
      const leaves: { attribute: string; level: string }[] = [];
      const walk = (x: ConjointLevelCondition, d = 0) => { if (d > 64 || !x) return; if ("attribute" in x) leaves.push(x); else (x.children ?? []).forEach((k) => walk(k, d + 1)); };
      walk(effectiveProhibition(p as ConjointProhibition));
      for (const side of leaves) {
        const known = levelsOf.get(side.attribute);
        if (!known) errors.push(`Prohibition names attribute "${side.attribute}", which is not in this design.`);
        else if (!known.has(side.level)) errors.push(`Prohibition names level "${side.level}" of "${side.attribute}", which is not one of its levels.`);
      }
      if (!p.when && p.a && p.b && p.a.attribute === p.b.attribute) errors.push(`A prohibition cannot pair two levels of the same attribute ("${p.a.attribute}").`);
    }
    if ((config.screeningTasks ?? 6) < 1) errors.push("At least one screening screen is needed.");
    if ((config.conceptsPerScreen ?? 4) < 2) errors.push("At least 2 concepts per screen.");
    if ((config.tournamentAlternatives ?? 3) < 2) errors.push("A tournament set needs at least 2 concepts.");
    /* F4 2026-10-22: a summed price names real attributes, one finite increment per level */
    if (config.priceBase != null || config.priceIncrements?.length) {
      if (config.priceBase != null && !Number.isFinite(Number(config.priceBase))) errors.push("The base price must be a number.");
      const incs = parsePriceIncrements(config.priceIncrements);
      if (!Object.keys(incs).length) errors.push("A summed price needs at least one attribute's increments — e.g. “Brand: 0, 50, 120”.");
      for (const [k, v] of Object.entries(incs)) {
        const a = c.attributes.find((x) => x.name === k || x.name.toLowerCase() === k.toLowerCase());
        if (!a) { errors.push(`Price increments name “${k}”, which is not an attribute.`); continue; }
        if (v.length !== a.levels.length) errors.push(`“${a.name}” has ${a.levels.length} levels but ${v.length} price increments — give one per level, in level order.`);
        if (v.some((x) => !Number.isFinite(x))) errors.push(`A price increment of “${a.name}” is not a number.`);
      }
      const priceAttr = c.attributes.find((a) => /^(price|cost|fee)s?$/i.test(a.name));
      if (priceAttr) errors.push(`With a summed price, “${priceAttr.name}” should not also be an attribute — the price comes from the base price and the increments.`);
      const pv = Number(config.priceVariation ?? 30);
      if (!(pv >= 0 && pv <= 50)) errors.push("Price variation is a percentage between 0 and 50.");
    }
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
      ...(c.summedPrice ? { summedPrice: { base: c.summedPrice.base, increments: c.summedPrice.increments, variationPct: Math.round(c.summedPrice.variation * 100), currency: c.summedPrice.currency } } : {}),
    };
    return { columns, rows, summary };
  },
};
