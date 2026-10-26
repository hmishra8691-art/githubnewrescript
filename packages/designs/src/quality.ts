/**
 * IS THIS DESIGN SOUND ENOUGH TO FIELD? (2026-10-26)
 *
 * The generators have always measured design quality — `measureMaxDiffDesign`
 * and `measureConjointDesign` read the stored rows, and the Studio's Designs
 * panel shows the numbers. Nothing ever acted on them. The publish gate's
 * only design rule was "every conjoint or MaxDiff question points at a design
 * this survey holds": whether that design was any good was not asked. A
 * MaxDiff with an item nobody is ever shown, or a CBC whose rows break the
 * researcher's own prohibitions, passed the gate, went to field, and showed
 * up as unusable utilities after the sample had been paid for.
 *
 * This turns the existing measurements into publish-gate verdicts. It
 * introduces NO second definition of quality: every number here comes from
 * the same function the panel already displays, measured on the rows the
 * survey actually holds rather than on `summary`, which a generator wrote
 * once and an import or a hand edit can leave stale or absent.
 *
 * WHAT REFUSES A PUBLISH, and why so little does. A live deploy is refused
 * with no override, so an error is a hard block, and a gate people learn to
 * override stops being a gate. Only what no amount of sample can rescue is
 * an error:
 *
 *   · an item or level that is never shown to anyone — there is nothing to
 *     estimate a utility from, so the study cannot answer the question it
 *     was fielded to answer;
 *   · rows that break a prohibited pair the researcher set — that is not the
 *     design they asked for;
 *   · a design with no rows, or rows that contradict their own config.
 *
 * Everything else — show-count spread, pair co-occurrence, positional skew,
 * D-efficiency, two-way balance — is a warning carrying the measured numbers,
 * because an imperfect design is usually a usable one and the researcher is
 * the person who should weigh it.
 */
import type { DesignQualityIssue, DesignReference } from "@rescript/schema";
import { measureMaxDiffDesign, type MaxDiffItemPair } from "./maxdiff.js";
import { measureConjointDesign } from "./conjointEfficiency.js";

const rowsOf = (d: DesignReference): Record<string, unknown>[] => d.file?.rows ?? [];
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);
const n2 = (x: number): number => Math.round(x * 100) / 100;

/** the few words that name the design in a sentence a researcher reads */
const named = (d: DesignReference): string => (d.name ? `“${d.name}”` : "this design");

/* ------------------------------------------------------------- MaxDiff */

export function inspectMaxDiffDesign(design: DesignReference): DesignQualityIssue[] {
  const out: DesignQualityIssue[] = [];
  const rows = rowsOf(design);
  const cfg = (design.config ?? {}) as { items?: unknown; prohibitedPairs?: unknown; balance?: unknown };
  const items = list(cfg.items);

  if (!rows.length) {
    out.push({ level: "error", message: `${named(design)} has no generated rows, so there is nothing to show a respondent. Generate the design before publishing.` });
    return out;
  }
  if (!items.length) {
    out.push({ level: "error", message: `${named(design)} has rows but no items in its configuration, so what the rows refer to cannot be checked.` });
    return out;
  }

  let d: ReturnType<typeof measureMaxDiffDesign>;
  try {
    d = measureMaxDiffDesign(rows, items, { prohibitedPairs: cfg.prohibitedPairs as MaxDiffItemPair[] | undefined });
  } catch (e) {
    /* a measurement that throws must not become a design that passes */
    out.push({ level: "error", message: `${named(design)} could not be checked: ${e instanceof Error ? e.message : String(e)}.` });
    return out;
  }

  /* ERROR — an item nobody sees has no utility to estimate */
  if (d.items.min === 0) {
    const shown = new Set<string>();
    for (const r of rows) { if (Number(r.practice) !== 1) shown.add(str(r.item_label)); }
    const never = items.filter((i) => !shown.has(i));
    const names = never.slice(0, 6).join(", ") + (never.length > 6 ? `, and ${never.length - 6} more` : "");
    out.push({
      level: "error",
      message: `${named(design)} never shows ${never.length === 1 ? "one item" : `${never.length} items`} to anyone (${names}). An item nobody sees has no utility to estimate, so the study cannot rank it. Add tasks or versions, or remove the ${never.length === 1 ? "item" : "items"}.`,
    });
  }

  /* ERROR — the rows break a rule the researcher set */
  if (d.prohibited.violations > 0) {
    out.push({
      level: "error",
      message: `${named(design)} breaks a prohibited-pair rule in ${d.prohibited.violations} task${d.prohibited.violations === 1 ? "" : "s"}: items the researcher said must never share a task do. Regenerate the design, or relax the rule.`,
    });
  }

  /* ERROR — the same item twice in one task is not a choice task */
  if (d.duplicatesWithinTask > 0) {
    out.push({
      level: "error",
      message: `${named(design)} shows the same item twice in ${d.duplicatesWithinTask} task${d.duplicatesWithinTask === 1 ? "" : "s"}, which a respondent cannot answer meaningfully.`,
    });
  }

  /* WARNING — usable, and worth knowing, with the real numbers */
  if (d.items.status === "uneven") {
    out.push({
      level: "warning",
      message: `${named(design)} shows its items between ${d.items.min} and ${d.items.max} times (ideal ${n2(d.items.ideal)}). The least-shown items will have the least precise utilities. Adding tasks or versions evens this out.`,
    });
  }
  if (d.pairs.status === "uneven" && d.pairs.ideal >= 1) {
    out.push({
      level: "warning",
      message: `${named(design)} pairs its items unevenly: a pair shares a task between ${d.pairs.min} and ${d.pairs.max} times (ideal ${n2(d.pairs.ideal)}). Comparisons between rarely-paired items rest on less evidence.`,
    });
  }
  if (d.pairs.never > 0 && d.pairs.ideal >= 2) {
    out.push({
      level: "warning",
      message: `${named(design)} never puts ${d.pairs.never} pair${d.pairs.never === 1 ? "" : "s"} of items in the same task, although each pair would be expected about ${n2(d.pairs.ideal)} times. Those items are compared only indirectly.`,
    });
  }
  if (d.positions.status === "uneven") {
    out.push({
      level: "warning",
      message: `${named(design)} places its items unevenly across positions (${d.positions.min} to ${d.positions.max} times, ideal ${n2(d.positions.ideal)}). Respondents favour the top of a list, so an item shown there more often can score higher for that reason alone.`,
    });
  }
  if (d.perVersion.minItemsShown === 0 && d.perVersion.versions > 1) {
    out.push({
      level: "warning",
      message: `${named(design)} has a version in which some items never appear. That is normal for a sparse (express) design and a problem for a standard one — check which you intended.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------ conjoint */

interface Attr { name: string; levels: string[] }

function attributesOf(config: Record<string, unknown>): Attr[] {
  const raw = Array.isArray(config.attributes) ? config.attributes : [];
  return raw.map((a) => {
    const o = (a ?? {}) as { name?: unknown; levels?: unknown };
    return { name: str(o.name), levels: list(o.levels) };
  }).filter((a) => a.name && a.levels.length);
}

export function inspectConjointDesign(design: DesignReference): DesignQualityIssue[] {
  const out: DesignQualityIssue[] = [];
  const rows = rowsOf(design);
  const cfg = (design.config ?? {}) as Record<string, unknown>;
  const attributes = attributesOf(cfg);

  if (!rows.length) {
    out.push({ level: "error", message: `${named(design)} has no generated rows, so there is nothing to show a respondent. Generate the design before publishing.` });
    return out;
  }
  if (!attributes.length) {
    out.push({ level: "error", message: `${named(design)} has rows but no attributes in its configuration, so what the rows refer to cannot be checked.` });
    return out;
  }

  /*
   * ERROR — a level nobody is ever shown. Counted on the rows, per attribute,
   * because that is what a respondent actually sees; a level present only in
   * the configuration is a level with no data behind it.
   */
  const unseen: string[] = [];
  for (const a of attributes) {
    const seen = new Set<string>();
    for (const r of rows) { const v = str(r[a.name]); if (v) seen.add(v); }
    for (const l of a.levels) if (!seen.has(l)) unseen.push(`${a.name}: ${l}`);
  }
  if (unseen.length) {
    const names = unseen.slice(0, 6).join(", ") + (unseen.length > 6 ? `, and ${unseen.length - 6} more` : "");
    out.push({
      level: "error",
      message: `${named(design)} never shows ${unseen.length === 1 ? "one level" : `${unseen.length} levels`} to anyone (${names}). A level nobody sees has no utility to estimate, so it cannot be compared with the others. Add tasks or versions, or remove the ${unseen.length === 1 ? "level" : "levels"}.`,
    });
  }

  let eff: ReturnType<typeof measureConjointDesign> | null = null;
  try {
    eff = measureConjointDesign(attributes.map((a) => ({ name: a.name, levels: a.levels })), rows);
  } catch (e) {
    out.push({ level: "warning", message: `${named(design)}'s efficiency could not be measured: ${e instanceof Error ? e.message : String(e)}.` });
  }

  /* WARNING — one-way imbalance, measured on the rows */
  for (const a of attributes) {
    const counts = new Map<string, number>();
    for (const l of a.levels) counts.set(l, 0);
    for (const r of rows) { const v = str(r[a.name]); if (counts.has(v)) counts.set(v, counts.get(v)! + 1); }
    const vals = [...counts.values()].filter((v) => v > 0);
    if (vals.length < 2) continue;
    const min = Math.min(...vals), max = Math.max(...vals);
    /* a fifth off level is the point at which the imbalance is worth a sentence rather than noise */
    if (min > 0 && max / min > 1.2) {
      out.push({
        level: "warning",
        message: `${named(design)} shows the levels of “${a.name}” unevenly (${min} to ${max} times). The least-shown level will have the least precise utility.`,
      });
    }
  }

  if (eff) {
    /* ERROR — the same concept twice in one task is not a choice */
    if (eff.duplicateConceptTasks > 0) {
      out.push({
        level: "error",
        message: `${named(design)} shows the same concept twice in ${eff.duplicateConceptTasks} task${eff.duplicateConceptTasks === 1 ? "" : "s"}, which a respondent cannot answer meaningfully.`,
      });
    }
    /*
     * WARNING, and the sharpest one — a version that gives fewer choice
     * degrees of freedom than the model has parameters cannot identify that
     * model from ONE respondent's answers. It is not an error because an
     * aggregate model pools across respondents and is unaffected; it is
     * fatal only if individual utilities (HB) are the point, which the
     * design cannot know.
     */
    if (eff.minVersionDegreesOfFreedom < eff.parameters) {
      out.push({
        level: "warning",
        message: `${named(design)} gives one respondent ${eff.minVersionDegreesOfFreedom} choice degrees of freedom for ${eff.parameters} parameters, so individual-level utilities (Hierarchical Bayes) cannot be identified from a single respondent's answers — an aggregate model is unaffected. Add tasks per version if you intend HB.`,
      });
    }
    if (typeof eff.pooled === "number" && eff.pooled > 0 && eff.pooled < 0.7) {
      out.push({
        level: "warning",
        message: `${named(design)} has a D-efficiency of ${n2(eff.pooled)} against a balanced ideal of 1. More tasks or versions, or fewer prohibitions, would estimate the same utilities from less sample.`,
      });
    }
    if (eff.avoidableOverlapPct >= 10) {
      out.push({
        level: "warning",
        message: `${named(design)} repeats a level within a task in ${n2(eff.avoidableOverlapPct)}% of cells where it had room for distinct levels. Those cells tell the model nothing about that attribute.`,
      });
    }
  }
  return out;
}
