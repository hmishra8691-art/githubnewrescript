import type { DesignReference, Question, SurveyDefinition } from "@rescript/schema";
import { designGeneratorRegistry } from "@rescript/schema";
import type { IdMinter } from "./questionOps.js";
import { hashString } from "./random.js";
import { stripHtmlText } from "./html.js";

/*
 * RESEARCH METHODS AS COPILOT ACTIONS (Priority 5, 2026-10-17).
 *
 * MaxDiff and conjoint are research DESIGNS, not question texts: a design is
 * configured, checked for feasibility, generated once from (config, seed),
 * pinned on the survey (`def.designs[]`) and rendered by a question that
 * points at it (`settings.designRef`) — exactly what the Studio's Design
 * Generators panel does. Intelligent Mode could only write
 * `create_question type:"maxdiff"`, which made a question with NO design (the
 * quality check's "no design is selected"), or describe a MaxDiff as a matrix.
 *
 *   create_maxdiff   items (or itemsFrom a question), perTask, tasks, versions,
 *                    responseMode, prohibitedPairs, labels, instructions, practice …
 *   update_maxdiff   the same fields, as a PATCH: only what is named changes
 *   create_conjoint  method cbc | menu | acbc, attributes & levels (menu: items
 *                    & prices), alternatives, tasks, versions, none, prohibitions …
 *   update_conjoint  the same fields, as a patch
 *
 * The generators live in @rescript/designs, which depends on this package, so
 * they are reached through the schema's `designGeneratorRegistry` — the same
 * registry the Studio panel uses (`registerBuiltinDesignGenerators()` fills
 * it; the Studio's copilot route and its browser replay import the package).
 * The engine never imports @rescript/designs (dependency-boundaries R3).
 *
 * DETERMINISTIC: the seed is the action's `seed`, else the stored design's
 * seed (an update), else a hash of the configuration — so the server's
 * preview and the browser's replay on Apply produce identical rows.
 *
 * NOTHING SILENTLY SUBSTITUTED: rating/ranking-based conjoint, HB estimation,
 * linear (numeric) attributes, labelled designs, dual-response None and
 * worst-only MaxDiff are refused with the reason and the supported
 * alternative; an infeasible configuration is refused with the generator's
 * own words (the same refusals the panel shows).
 */

/* ------------------------------------------------------------ the shapes */

export interface MethodPlacement {
  ref?: string; block?: string; after?: string; newPage?: boolean; code?: string;
  /** question text; a neutral default for the method when absent */
  text?: string; required?: boolean;
}
export type MaxDiffPair = [string, string];
export interface MaxDiffSpec {
  items?: string[];
  /** take the items from this question's options (or a grid's rows); None / Other excluded */
  itemsFrom?: string;
  addItems?: string[]; removeItems?: string[];
  perTask?: number; tasks?: number | null; appearances?: number | null; versions?: number;
  responseMode?: "best_worst" | "best_only";
  anchored?: boolean; anchorPrompt?: string | null;
  prohibitedPairs?: MaxDiffPair[]; addProhibitedPairs?: MaxDiffPair[]; removeProhibitedPairs?: MaxDiffPair[];
  bestLabel?: string | null; worstLabel?: string | null; instructions?: string | null;
  practice?: boolean; itemsPerVersion?: number | null; balance?: "optimized" | "greedy";
  seed?: number; name?: string;
}
export type ConjointMethodName = "cbc" | "menu" | "acbc" | "cva";
export interface LevelRef { attribute: string; level: string }
export interface ConjointProhibitionInput { a: LevelRef; b: LevelRef; also?: LevelRef[]; alsoOp?: "and" | "or" }
export interface MenuItemInput { name: string; prices: string[]; required?: boolean }
export interface ConjointSpec {
  method?: ConjointMethodName;
  attributes?: { name: string; levels: string[] }[];
  addAttributes?: { name: string; levels: string[] }[];
  removeAttributes?: string[];
  /** replaces the levels of the named attributes */
  levels?: Record<string, string[]>;
  alternatives?: number; tasks?: number | null; versions?: number; holdouts?: number;
  none?: boolean; noneLabel?: string | null;
  prohibitions?: ConjointProhibitionInput[]; addProhibitions?: ConjointProhibitionInput[]; removeProhibitions?: ConjointProhibitionInput[];
  design?: "efficient" | "balanced";
  /* menu-based */
  items?: MenuItemInput[]; requiredItems?: string[]; minSelections?: number; maxSelections?: number; currency?: string;
  /* adaptive (ACBC) */
  screeningTasks?: number; conceptsPerScreen?: number; tournamentAlternatives?: number; maxAttributesVaried?: number; minTournamentConcepts?: number;
  /* F4 2026-10-22 — ACBC summed price: base + per-level increments ({"Brand":[0,50,120]}), ± variation % */
  priceBase?: number | null; priceIncrements?: Record<string, number[]> | null; priceVariation?: number; priceCurrency?: string;
  /* F4 2026-10-22 — CBC dual-response None, alternative-specific / labelled designs */
  dualResponse?: boolean; dualResponsePrompt?: string | null;
  labelled?: boolean; brandAttribute?: string | null; alternativeSpecific?: { attribute: string; appliesTo: string[] }[] | null;
  /* F4 2026-10-22 — menu: mutually exclusive sections */
  exclusiveGroups?: { name: string; items: string[] }[] | null;
  /* F4 2026-10-22 — rating-based (CVA) */
  mode?: "single" | "paired"; profiles?: number | null; scaleMin?: number | null; scaleMax?: number | null; minLabel?: string | null; maxLabel?: string | null; monotone?: Record<string, "increasing" | "decreasing"> | null;
  seed?: number; name?: string;
}

/**
 * A SIMULATOR SCENARIO saved on a conjoint design (F4 2026-10-22): "run the menu simulator with the
 * premium bundle at ₹499". The engine has no respondent data, so the action checks the scenario
 * against the design (items, levels, prices that parse) and stores it on the design's
 * `config.simulations` (never a generation key — the tasks do not change); the Conjoint analysis of
 * the question (Data Analytics) simulates every saved scenario: shares or take rates, revenue, and
 * for a menu the bundle's take rate.
 */
export interface SimulationScenarioInput {
  name: string;
  /** CBC / ACBC / CVA: the products in the market (attribute → level; `price` for a summed or linear price) */
  products?: { name: string; levels: Record<string, string>; price?: number; cost?: number }[];
  /** menu: item → price (as shown, "₹499" or a number); items not named keep their middle price */
  prices?: Record<string, string | number>;
  /** menu: bundles offered at one price */
  bundles?: { name: string; items: string[]; price: string | number }[];
  rule?: "logit" | "first_choice" | "rfc" | "btl";
  none?: boolean;
}

export type MethodAction =
  | ({ op: "create_maxdiff" } & MethodPlacement & MaxDiffSpec)
  | ({ op: "update_maxdiff"; target: string; text?: string; required?: boolean } & MaxDiffSpec)
  | ({ op: "create_conjoint" } & MethodPlacement & ConjointSpec)
  | ({ op: "update_conjoint"; target: string; text?: string; required?: boolean } & ConjointSpec)
  | { op: "simulate_conjoint"; target: string; scenario: SimulationScenarioInput; remove?: boolean };

export const METHOD_ACTION_OPS = ["create_maxdiff", "update_maxdiff", "create_conjoint", "update_conjoint", "simulate_conjoint"] as const;
const OPS = new Set<string>(METHOD_ACTION_OPS);
export const isMethodOp = (op: string): boolean => OPS.has(op);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.trim())) ? Number(v.trim()) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strList = (v: unknown, max = 200): string[] | undefined => (Array.isArray(v) ? v.map((x) => str(typeof x === "object" && x ? (x as Record<string, unknown>).label ?? (x as Record<string, unknown>).name : x)).filter((x): x is string => !!x).slice(0, max) : undefined);
const norm = (s: string) => stripHtmlText(s).trim().toLowerCase().replace(/\s+/g, " ");

/** a whole number ≥ min, or the reason it is refused; undefined when absent; null when cleared (nullable fields) */
function whole(o: Record<string, unknown>, keys: string[], what: string, min: number, nullable = false): number | null | undefined | { error: string } {
  const k = keys.find((x) => o[x] !== undefined);
  if (!k) return undefined;
  if (o[k] === null) return nullable ? null : { error: `${what} cannot be cleared` };
  const n = num(o[k]);
  if (n === undefined || !Number.isInteger(n) || n < min) return { error: `${what} must be a whole number of ${min} or more (got ${JSON.stringify(o[k])})` };
  return n;
}
const isErr = (x: unknown): x is { error: string } => !!x && typeof x === "object" && "error" in (x as object);

function pairsOf(v: unknown, what: string): MaxDiffPair[] | string | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return `${what} is a list of item pairs, e.g. [["Brand A","Brand B"]]`;
  const out: MaxDiffPair[] = [];
  for (const p of v) {
    const pair = Array.isArray(p) ? p : p && typeof p === "object" ? [(p as Record<string, unknown>).a, (p as Record<string, unknown>).b] : null;
    const a = str(pair?.[0]), b = str(pair?.[1]);
    if (!pair || pair.length !== 2 || !a || !b) return `each of ${what} names two items, e.g. ["Brand A","Brand B"]`;
    out.push([a, b]);
  }
  return out;
}

/** "Brand: Alpha" / "Brand=Alpha" / {attribute, level} → a level reference */
function levelRef(v: unknown): LevelRef | null {
  if (typeof v === "string") {
    const m = /^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/.exec(v);
    return m ? { attribute: m[1], level: m[2] } : null;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const attribute = str(o.attribute ?? o.attr), level = str(o.level);
    return attribute && level ? { attribute, level } : null;
  }
  return null;
}
/** a prohibition: {a, b, also?, alsoOp?}, ["Brand: Alpha", "Price: $399"], or {"Brand": "Alpha", "Price": "$399"} */
function prohibitionsOf(v: unknown, what: string): ConjointProhibitionInput[] | string | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return `${what} is a list, e.g. [{"Brand":"Alpha","Price":"$399"}]`;
  const out: ConjointProhibitionInput[] = [];
  for (const p of v) {
    let refs: LevelRef[] = [];
    let alsoOp: "and" | "or" | undefined;
    if (Array.isArray(p)) refs = p.map(levelRef).filter((x): x is LevelRef => !!x);
    else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      if (o.a !== undefined || o.b !== undefined) {
        const a = levelRef(o.a), b = levelRef(o.b);
        refs = [a, b, ...(Array.isArray(o.also) ? o.also.map(levelRef) : [])].filter((x): x is LevelRef => !!x);
        if (!a || !b) refs = [];
        if (o.alsoOp === "or") alsoOp = "or";
      } else if (o.when !== undefined) return "a nested prohibition tree (when) is edited in the Design Generators panel — give pairs (or a pair plus further levels) here";
      else refs = Object.entries(o).filter(([k]) => k !== "note").map(([attribute, level]) => (str(level) ? { attribute, level: str(level)! } : null)).filter((x): x is LevelRef => !!x);
    }
    if (refs.length < 2) return `each of ${what} names two levels of different attributes, e.g. {"Brand":"Alpha","Price":"$399"}`;
    out.push({ a: refs[0], b: refs[1], ...(refs.length > 2 ? { also: refs.slice(2), ...(alsoOp ? { alsoOp } : {}) } : {}) });
  }
  return out;
}
function attributesOf(v: unknown, what: string): { name: string; levels: string[] }[] | string | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return `${what} is a list of {name, levels}`;
  const out: { name: string; levels: string[] }[] = [];
  for (const x of v) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = str(o.name ?? o.attribute, 80);
    const levels = strList(o.levels ?? o.values, 40);
    if (!name || !levels) return `each of ${what} is {"name":"Brand","levels":["A","B","C"]}`;
    const t = str(o.type)?.toLowerCase();
    if (t && /^(numeric|linear|continuous|quantitative|interval)$/.test(t)) {
      return `attribute “${name}” as a ${t} (linear) term is not implemented — every attribute is estimated as categorical part-worths (one per level). Give its levels as ordinary levels; the analysis reads willingness to pay from the price levels`;
    }
    if (t && !/^(categorical|nominal|ordinal|price|text)$/.test(t)) return `attribute type “${t}” is not supported — levels are categorical`;
    if (o.image !== undefined || o.images !== undefined || o.description !== undefined) return "level images and descriptions are not supported in conjoint designs yet — give the levels as text";
    out.push({ name, levels });
  }
  return out;
}

/** brand-specific rules: [{attribute, appliesTo}] or ["Storage: Alpha, Beta"] or {"Storage": ["Alpha","Beta"]} */
function altSpecOf(v: unknown): { attribute: string; appliesTo: string[] }[] | string {
  const out: { attribute: string; appliesTo: string[] }[] = [];
  const bad = "alternativeSpecific lists the attributes that apply only to some brands, e.g. [{\"attribute\":\"5G\",\"appliesTo\":[\"Alpha\",\"Beta\"]}]";
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { const l = strList(x, 40); if (!l?.length) return bad; out.push({ attribute: k, appliesTo: l }); }
    return out;
  }
  if (!Array.isArray(v)) return bad;
  for (const x of v) {
    if (typeof x === "string") { const m = /^\s*([^:=]+?)\s*[:=]\s*(.+)$/.exec(x); if (!m) return bad; out.push({ attribute: m[1], appliesTo: m[2].split(/\s*[,|;]\s*/).filter(Boolean) }); continue; }
    const r = (x ?? {}) as Record<string, unknown>;
    const attribute = str(r.attribute ?? r.name, 80), appliesTo = strList(r.appliesTo ?? r.brands ?? r.levels, 40);
    if (!attribute || !appliesTo?.length) return bad;
    out.push({ attribute, appliesTo });
  }
  return out;
}

const CONJOINT_METHODS: Record<string, ConjointMethodName> = {
  cbc: "cbc", choice: "cbc", choice_based: "cbc", choice_based_conjoint: "cbc", discrete_choice: "cbc", dce: "cbc", conjoint: "cbc",
  menu: "menu", menu_based: "menu", mbc: "menu", configurator: "menu", pricing_configurator: "menu", build_your_own_menu: "menu",
  acbc: "acbc", adaptive: "acbc", adaptive_cbc: "acbc", adaptive_choice_based: "acbc",
  /* F4 2026-10-22: rating-based (CVA) and the CBC variants are implemented */
  cva: "cva", rating: "cva", ratings: "cva", rating_based: "cva", ratings_based: "cva", full_profile: "cva", full_profile_rating: "cva", traditional: "cva", likelihood_to_buy: "cva",
  labelled: "cbc", labeled: "cbc", alternative_specific: "cbc", brand_specific: "cbc", dual_response: "cbc",
};
/** method words that imply a CBC option */
const IMPLIED: Record<string, Partial<ConjointSpec>> = { labelled: { labelled: true }, labeled: { labelled: true }, dual_response: { dualResponse: true } };
const NOT_IMPLEMENTED: Record<string, string> = {
  ranking: "ranking-based conjoint is not implemented",
  ranking_based: "ranking-based conjoint is not implemented",
  aca: "ACA (adaptive conjoint analysis, self-explicated) is not implemented",
  self_explicated: "self-explicated conjoint is not implemented",
};
const SUPPORTED = "Rescript runs choice-based (cbc — with dual-response None and brand-specific / labelled designs), menu-based (menu), adaptive (acbc) and rating-based (cva) conjoint";

/** shared by create and update: every field checked, or the reason it is refused */
function maxdiffSpecOf(o: Record<string, unknown>, partial: boolean): MaxDiffSpec | string {
  const spec: MaxDiffSpec = {};
  if (o.method !== undefined || o.estimation !== undefined) {
    const e = str(o.estimation ?? o.method)?.toLowerCase().replace(/[\s-]+/g, "_");
    if (e && /hb|hierarchical|individual|latent/.test(e)) return "HB / individual-level estimation is not a design setting and is not available here — it runs after fielding in Data Analytics (Hierarchical Bayes); the MaxDiff analysis is the pooled logit with B−W counts. Create the MaxDiff without an estimation field";
  }
  const items = strList(o.items, 200);
  if (o.items !== undefined && !items) return "items is a list of the items to scale";
  if (items) spec.items = items;
  const from = str(o.itemsFrom ?? o.items_from ?? o.source, 80);
  if (from) spec.itemsFrom = from;
  if (items && from) return "give items or itemsFrom, not both";
  if (!partial && !items && !from) return "create_maxdiff needs the items (items: [...]) or the question that lists them (itemsFrom: \"Q5\") — ask the researcher for the items rather than inventing them";
  for (const k of ["addItems", "removeItems"] as const) { if (o[k] !== undefined) { const l = strList(o[k]); if (!l?.length) return `${k} is a list of item labels`; spec[k] = l; } }
  const fields: [keyof MaxDiffSpec, string[], string, number, boolean][] = [
    ["perTask", ["perTask", "itemsPerTask", "items_per_task"], "perTask (items per task)", 3, false],
    ["tasks", ["tasks", "tasksPerVersion"], "tasks", 1, true],
    ["appearances", ["appearances", "appearancesPerItem"], "appearances (per item, per respondent)", 1, true],
    ["versions", ["versions", "blocks"], "versions", 1, false],
    ["itemsPerVersion", ["itemsPerVersion", "express"], "itemsPerVersion (express MaxDiff)", 2, true],
    ["seed", ["seed"], "seed", 0, false],
  ];
  for (const [key, keys, what, min, nullable] of fields) {
    const v = whole(o, keys, what, min, nullable);
    if (isErr(v)) return v.error;
    if (v !== undefined) (spec as Record<string, unknown>)[key] = v;
  }
  const rm = str(o.responseMode ?? o.response ?? o.mode)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (rm) {
    const m: Record<string, "best_worst" | "best_only"> = { best_worst: "best_worst", most_least: "best_worst", best_and_worst: "best_worst", bws: "best_worst", best_only: "best_only", best: "best_only", most_only: "best_only" };
    if (/worst_only|least_only/.test(rm)) return "worst-only MaxDiff is not supported — use best_only or best_worst";
    if (!m[rm]) return `responseMode is best_worst or best_only — not “${rm}”`;
    spec.responseMode = m[rm];
  }
  if (bool(o.anchored) !== undefined) spec.anchored = bool(o.anchored);
  if (o.balance !== undefined) { const b = str(o.balance)?.toLowerCase(); if (b !== "optimized" && b !== "greedy") return "balance is optimized (recommended) or greedy"; spec.balance = b; }
  if (bool(o.practice ?? o.practiceTask) !== undefined) spec.practice = bool(o.practice ?? o.practiceTask);
  for (const k of ["anchorPrompt", "bestLabel", "worstLabel", "instructions"] as const) {
    if (o[k] === null || o[k] === "") spec[k] = null;
    else if (o[k] !== undefined) { const s = str(o[k], k === "instructions" ? 1000 : 200); if (!s) return `${k} is text`; spec[k] = s; }
  }
  for (const k of ["prohibitedPairs", "addProhibitedPairs", "removeProhibitedPairs"] as const) {
    const p = pairsOf(o[k] ?? (k === "prohibitedPairs" ? o.prohibitions : undefined), k); if (typeof p === "string") return p; if (p) spec[k] = p;
  }
  if (!partial && (spec.addItems || spec.removeItems || spec.addProhibitedPairs || spec.removeProhibitedPairs)) return "addItems / removeItems / addProhibitedPairs / removeProhibitedPairs belong to update_maxdiff — give the whole list to create_maxdiff";
  const name = str(o.name ?? o.designName, 120); if (name) spec.name = name;
  return spec;
}

function conjointSpecOf(o: Record<string, unknown>, partial: boolean): ConjointSpec | string {
  const spec: ConjointSpec = {};
  const rawMethod = str(o.method ?? o.type ?? o.kind)?.toLowerCase().replace(/[\s-]+/g, "_").replace(/_conjoint$/, "");
  if (rawMethod) {
    if (NOT_IMPLEMENTED[rawMethod]) return `${NOT_IMPLEMENTED[rawMethod]}. ${SUPPORTED} — say so and propose cbc instead (only if the researcher agrees)`;
    if (!CONJOINT_METHODS[rawMethod]) return `“${rawMethod}” is not a conjoint method here — ${SUPPORTED}`;
    spec.method = CONJOINT_METHODS[rawMethod];
    Object.assign(spec, IMPLIED[rawMethod] ?? {});
  }
  const est = str(o.estimation ?? o.estimator ?? o.analysis)?.toLowerCase();
  if (est && /hb|hierarchical|individual|latent|mixed/.test(est)) return "estimation is not a design setting — individual-level (hierarchical Bayes) utilities are estimated after fielding in Data Analytics (kind hb, CBC / ACBC / menu); latent-class choice models are not available. Create the design without an estimation field";
  /* F4 2026-10-22: dual-response None — none:"dual", dualResponse / dualResponseNone / dualNone: true */
  const dualRaw = o.dualResponse ?? o.dualResponseNone ?? o.dualNone;
  if (dualRaw !== undefined) { if (typeof dualRaw !== "boolean") return "dualResponse is true or false"; spec.dualResponse = dualRaw; }
  if (typeof o.none === "string" && /dual/i.test(o.none)) { spec.dualResponse = true; }
  if (o.dualResponsePrompt === null || o.dualResponsePrompt === "") spec.dualResponsePrompt = null;
  else if (str(o.dualResponsePrompt)) spec.dualResponsePrompt = str(o.dualResponsePrompt, 300);
  /* F4 2026-10-22: labelled / brand-specific designs */
  if (o.labels !== undefined || o.alternativeNames !== undefined) return "alternatives are named by the brand attribute in a labelled design — give labelled: true (and brandAttribute if it is not called Brand), not a list of names";
  if (bool(o.labelled ?? o.labeled) !== undefined) spec.labelled = bool(o.labelled ?? o.labeled);
  if (o.brandAttribute === null) spec.brandAttribute = null; else if (str(o.brandAttribute, 80)) spec.brandAttribute = str(o.brandAttribute, 80);
  if (o.alternativeSpecific !== undefined || o.brandSpecific !== undefined) {
    const v = o.alternativeSpecific ?? o.brandSpecific;
    if (v === null) spec.alternativeSpecific = null;
    else {
      const rules = altSpecOf(v);
      if (typeof rules === "string") return rules;
      spec.alternativeSpecific = rules;
    }
  }
  /* F4 2026-10-22: menu sections */
  if (o.exclusiveGroups !== undefined || o.sections !== undefined) {
    const v = o.exclusiveGroups ?? o.sections;
    if (v === null) spec.exclusiveGroups = null;
    else {
      if (!Array.isArray(v)) return "exclusiveGroups is a list of {name, items} — the respondent picks at most one item of each";
      const gs: { name: string; items: string[] }[] = [];
      for (const g of v) {
        const r = (g ?? {}) as Record<string, unknown>;
        const items = strList(Array.isArray(g) ? g : r.items, 40);
        if (!items || items.length < 2) return "each exclusive section is {\"name\":\"Plan\",\"items\":[\"Basic\",\"Plus\"]} with at least two items";
        gs.push({ name: str(r.name, 80) ?? `Section ${gs.length + 1}`, items });
      }
      spec.exclusiveGroups = gs;
    }
  }
  /* F4 2026-10-22: ACBC summed price */
  if (o.priceBase !== undefined || o.basePrice !== undefined) { const v = o.priceBase ?? o.basePrice; if (v === null) spec.priceBase = null; else { const n = num(typeof v === "string" ? v.replace(/[^\d.-]/g, "") : v); if (n === undefined) return "priceBase is a number (the price before the level increments)"; spec.priceBase = n; } }
  if (o.priceIncrements !== undefined) {
    if (o.priceIncrements === null) spec.priceIncrements = null;
    else {
      if (!o.priceIncrements || typeof o.priceIncrements !== "object" || Array.isArray(o.priceIncrements)) return "priceIncrements maps an attribute to one price increment per level, e.g. {\"Brand\":[0,50,120]}";
      const m: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(o.priceIncrements as Record<string, unknown>)) {
        if (!Array.isArray(v)) return `priceIncrements of “${k}” is a list of numbers, one per level`;
        const xs = v.map((x) => num(typeof x === "string" ? x.replace(/[^\d.-]/g, "") : x));
        if (xs.some((x) => x === undefined)) return `priceIncrements of “${k}” must be numbers`;
        m[k] = xs as number[];
      }
      spec.priceIncrements = m;
    }
  }
  if (o.priceVariation !== undefined) { const n = num(o.priceVariation); if (n === undefined || n < 0 || n > 50) return "priceVariation is a percentage from 0 to 50"; spec.priceVariation = n; }
  if (str(o.priceCurrency, 8)) spec.priceCurrency = str(o.priceCurrency, 8);
  /* F4 2026-10-22: rating-based (CVA) */
  if (o.mode !== undefined || o.task !== undefined || o.cvaMode !== undefined) {
    const m = str(o.mode ?? o.cvaMode ?? o.task)?.toLowerCase().replace(/[\s-]+/g, "_");
    const M: Record<string, "single" | "paired"> = { single: "single", profile: "single", profiles: "single", single_profile: "single", rate: "single", paired: "paired", pairs: "paired", pairwise: "paired", paired_comparison: "paired" };
    if (!m || !M[m]) return "mode is single (rate each profile) or paired (rate a pair on a preference scale)";
    spec.mode = M[m];
  }
  if (o.scale !== undefined) {
    const sc = Array.isArray(o.scale) ? o.scale.map(num) : typeof o.scale === "string" ? (/(-?\d+)\s*(?:-|–|to)\s*(-?\d+)/.exec(o.scale) ?? []).slice(1).map(num) : [];
    if (sc.length !== 2 || sc.some((x) => x === undefined)) return "scale is [min, max] or \"0-10\"";
    spec.scaleMin = sc[0]!; spec.scaleMax = sc[1]!;
  }
  for (const k of ["minLabel", "maxLabel"] as const) { if (o[k] === null || o[k] === "") spec[k] = null; else if (str(o[k])) spec[k] = str(o[k], 120); }
  if (o.monotone !== undefined) {
    if (o.monotone === null) spec.monotone = null;
    else {
      if (!o.monotone || typeof o.monotone !== "object" || Array.isArray(o.monotone)) return "monotone maps an attribute to increasing or decreasing, e.g. {\"Price\":\"decreasing\"}";
      const m: Record<string, "increasing" | "decreasing"> = {};
      for (const [k, v] of Object.entries(o.monotone as Record<string, unknown>)) { const d = str(v)?.toLowerCase(); if (d !== "increasing" && d !== "decreasing") return `monotone “${k}” is increasing or decreasing`; m[k] = d; }
      spec.monotone = m;
    }
  }
  for (const k of ["attributes", "addAttributes"] as const) { const a = attributesOf(o[k], k); if (typeof a === "string") return a; if (a) spec[k] = a; }
  if (o.removeAttributes !== undefined) { const l = strList(o.removeAttributes); if (!l?.length) return "removeAttributes is a list of attribute names"; spec.removeAttributes = l; }
  if (o.levels !== undefined) {
    if (!o.levels || typeof o.levels !== "object" || Array.isArray(o.levels)) return "levels is a map of attribute → its new levels, e.g. {\"Price\":[\"$199\",\"$299\"]}";
    const m: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(o.levels as Record<string, unknown>)) { const l = strList(v, 40); if (!l?.length) return `levels of “${k}” is a list`; m[k] = l; }
    spec.levels = m;
  }
  const fields: [keyof ConjointSpec, string[], string, number, boolean][] = [
    ["alternatives", ["alternatives", "alternativesPerTask", "concepts", "conceptsPerTask"], "alternatives (concepts per task)", 2, false],
    ["tasks", ["tasks", "tasksPerVersion"], "tasks", 1, true],
    ["versions", ["versions", "blocks"], "versions", 1, false],
    ["holdouts", ["holdouts", "holdoutTasks"], "holdouts", 0, false],
    ["minSelections", ["minSelections"], "minSelections", 0, false],
    ["maxSelections", ["maxSelections"], "maxSelections", 0, false],
    ["screeningTasks", ["screeningTasks", "screens"], "screeningTasks", 1, false],
    ["conceptsPerScreen", ["conceptsPerScreen"], "conceptsPerScreen", 2, false],
    ["tournamentAlternatives", ["tournamentAlternatives"], "tournamentAlternatives", 2, false],
    ["maxAttributesVaried", ["maxAttributesVaried"], "maxAttributesVaried", 1, false],
    ["minTournamentConcepts", ["minTournamentConcepts"], "minTournamentConcepts", 2, false],
    ["profiles", ["profiles", "profilesPerVersion", "pairs"], "profiles (per version)", 2, true],
    ["scaleMin", ["scaleMin"], "scaleMin", 0, true],
    ["scaleMax", ["scaleMax"], "scaleMax", 1, true],
    ["seed", ["seed"], "seed", 0, false],
  ];
  for (const [key, keys, what, min, nullable] of fields) {
    const v = whole(o, keys, what, min, nullable);
    if (isErr(v)) return v.error;
    if (v !== undefined) (spec as Record<string, unknown>)[key] = v;
  }
  const none = o.none ?? o.noneOption;
  if (typeof none === "boolean") spec.none = none;
  else if (typeof none === "string" && none.trim() && !/dual/i.test(none)) { spec.none = true; spec.noneLabel = none.trim().slice(0, 200); }
  if (o.noneLabel === null || o.noneLabel === "") spec.noneLabel = null;
  else if (str(o.noneLabel)) { spec.noneLabel = str(o.noneLabel, 200); if (spec.none === undefined && !partial) spec.none = true; }
  for (const k of ["prohibitions", "addProhibitions", "removeProhibitions"] as const) { const p = prohibitionsOf(o[k], k); if (typeof p === "string") return p; if (p) spec[k] = p; }
  if (o.design !== undefined || o.designMethod !== undefined) {
    const d = str(o.design ?? o.designMethod)?.toLowerCase().replace(/[\s-]+/g, "_");
    const m: Record<string, "efficient" | "balanced"> = { efficient: "efficient", d_efficient: "efficient", optimal: "efficient", optimised: "efficient", optimized: "efficient", balanced: "balanced", balanced_overlap: "balanced", random: "balanced", complete_enumeration: "balanced", shortcut: "balanced" };
    if (!d || !m[d]) return "design is efficient (level-balanced, then swapped for D-efficiency) or balanced (level-balanced, minimal overlap)";
    spec.design = m[d];
  }
  if (o.items !== undefined) {
    if (!Array.isArray(o.items)) return "items (menu) is a list of {name, prices}";
    const items: MenuItemInput[] = [];
    for (const x of o.items) {
      const r = (x ?? {}) as Record<string, unknown>;
      const name = str(r.name ?? r.label, 120); const prices = strList(r.prices ?? r.levels ?? r.pricePoints, 20);
      if (!name || !prices?.length) return "each menu item is {\"name\":\"Extra storage\",\"prices\":[\"$2\",\"$4\"]}";
      items.push({ name, prices, ...(r.required === true ? { required: true } : {}) });
    }
    spec.items = items;
  }
  if (o.requiredItems !== undefined) { const l = strList(o.requiredItems); if (!l) return "requiredItems is a list of item names"; spec.requiredItems = l; }
  const cur = str(o.currency, 8); if (cur) spec.currency = cur;
  const name = str(o.name ?? o.designName, 120); if (name) spec.name = name;
  if (!partial) {
    const m = spec.method ?? "cbc";
    if (m === "menu" && !spec.items?.length) return "a menu-based conjoint needs the menu: items with their price points (items: [{name, prices}]) — ask the researcher for them rather than inventing them";
    if (spec.dualResponse && spec.none) return "dual-response None replaces the None alternative inside the task — give dualResponse: true without none: true";
    if (m !== "menu" && !spec.attributes?.length) return `create_conjoint (${m}) needs the attributes and their levels (attributes: [{name, levels}]) — ask the researcher for them rather than inventing them`;
    if (spec.addAttributes || spec.removeAttributes || spec.levels || spec.addProhibitions || spec.removeProhibitions) return "addAttributes / removeAttributes / levels / addProhibitions / removeProhibitions belong to update_conjoint — give the whole list to create_conjoint";
  }
  return spec;
}

function placementOf(o: Record<string, unknown>): MethodPlacement {
  return {
    ...(str(o.ref, 60) ? { ref: str(o.ref, 60) } : {}), ...(str(o.block, 160) ? { block: str(o.block, 160) } : {}), ...(str(o.after, 80) ? { after: str(o.after, 80) } : {}),
    ...(bool(o.newPage) !== undefined ? { newPage: bool(o.newPage) } : {}), ...(str(o.code, 40) ? { code: str(o.code, 40) } : {}),
    ...(str(o.text, 4000) ? { text: str(o.text, 4000) } : {}), ...(bool(o.required) !== undefined ? { required: bool(o.required) } : {}),
  };
}

/** a simulator scenario: named, and either products (CBC/ACBC/CVA) or menu prices / bundles */
function scenarioOf(v: unknown): SimulationScenarioInput | string {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "scenario is {name, products} (CBC / ACBC / CVA) or {name, prices, bundles} (menu)";
  const name = str(o.name, 120) ?? "Scenario";
  const sc: SimulationScenarioInput = { name };
  if (o.products !== undefined) {
    if (!Array.isArray(o.products) || !o.products.length) return "products is a list of {name, levels: {attribute: level}, price?, cost?}";
    sc.products = [];
    for (const p of o.products) {
      const r = (p ?? {}) as Record<string, unknown>;
      const pname = str(r.name, 120) ?? `Product ${sc.products.length + 1}`;
      const lv = r.levels && typeof r.levels === "object" && !Array.isArray(r.levels) ? Object.fromEntries(Object.entries(r.levels as Record<string, unknown>).map(([k, x]) => [k, str(x, 120) ?? ""]).filter(([, x]) => x)) : {};
      const price = r.price === undefined ? undefined : num(typeof r.price === "string" ? r.price.replace(/[^\d.-]/g, "") : r.price);
      const cost = r.cost === undefined ? undefined : num(typeof r.cost === "string" ? r.cost.replace(/[^\d.-]/g, "") : r.cost);
      if (r.price !== undefined && price === undefined) return `the price of ${pname} is not a number`;
      sc.products.push({ name: pname, levels: lv as Record<string, string>, ...(price !== undefined ? { price } : {}), ...(cost !== undefined ? { cost } : {}) });
    }
  }
  if (o.prices !== undefined) {
    if (!o.prices || typeof o.prices !== "object" || Array.isArray(o.prices)) return "prices maps a menu item to its price, e.g. {\"Insurance\":\"₹99\"}";
    sc.prices = Object.fromEntries(Object.entries(o.prices as Record<string, unknown>).map(([k, x]) => [k, typeof x === "number" ? x : String(x ?? "")]));
  }
  if (o.bundles !== undefined) {
    if (!Array.isArray(o.bundles)) return "bundles is a list of {name, items, price}";
    sc.bundles = [];
    for (const b of o.bundles) {
      const r = (b ?? {}) as Record<string, unknown>;
      const items = strList(r.items, 40);
      if (!items || items.length < 2 || r.price === undefined) return "each bundle is {\"name\":\"Premium\",\"items\":[\"A\",\"B\"],\"price\":\"₹499\"} with at least two items";
      sc.bundles.push({ name: str(r.name, 120) ?? `Bundle ${sc.bundles.length + 1}`, items, price: typeof r.price === "number" ? r.price : String(r.price) });
    }
  }
  const rule = str(o.rule)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (rule) {
    const R: Record<string, SimulationScenarioInput["rule"]> = { logit: "logit", share_of_preference: "logit", first_choice: "first_choice", max_utility: "first_choice", maximum_utility: "first_choice", rfc: "rfc", randomized_first_choice: "rfc", randomised_first_choice: "rfc", btl: "btl" };
    if (!R[rule]) return "rule is logit (share of preference), first_choice, rfc (randomized first choice) or btl";
    sc.rule = R[rule];
  }
  if (bool(o.none) !== undefined) sc.none = bool(o.none);
  if (!sc.products && !sc.prices && !sc.bundles) return "a scenario needs products (CBC / ACBC / CVA) or menu prices / bundles";
  return sc;
}

export function coerceMethodAction(op: string, o: Record<string, unknown>): MethodAction | string | null {
  if (!isMethodOp(op)) return null;
  switch (op) {
    case "simulate_conjoint": {
      const target = str(o.target ?? o.question, 80); if (!target) return "simulate_conjoint needs the target question (its code)";
      if (o.remove === true) { const name = str((o.scenario as Record<string, unknown> | undefined)?.name ?? o.name, 120); if (!name) return "removing a scenario needs its name"; return { op, target, scenario: { name }, remove: true }; }
      const sc = scenarioOf(o.scenario ?? o);
      return typeof sc === "string" ? sc : { op, target, scenario: sc };
    }
    case "create_maxdiff": { const s = maxdiffSpecOf(o, false); return typeof s === "string" ? s : { op, ...placementOf(o), ...s }; }
    case "create_conjoint": { const s = conjointSpecOf(o, false); return typeof s === "string" ? s : { op, ...placementOf(o), ...s }; }
    case "update_maxdiff": case "update_conjoint": {
      const target = str(o.target ?? o.question, 80); if (!target) return `${op} needs the target question (its code)`;
      const s = op === "update_maxdiff" ? maxdiffSpecOf(o, true) : conjointSpecOf(o, true);
      if (typeof s === "string") return s;
      const extra = { ...(str(o.text, 4000) ? { text: str(o.text, 4000) } : {}), ...(bool(o.required) !== undefined ? { required: bool(o.required) } : {}) };
      if (!Object.keys(s).length && !Object.keys(extra).length) return `${op} changes nothing`;
      return { op, target, ...s, ...extra } as MethodAction;
    }
  }
  return null;
}

/* ------------------------------------------------------------ applying */

export interface MethodEnv {
  question(ref: string): Question | undefined;
  /** make the respondent-facing question through the survey actions' own maker (placement, naming, refs) */
  createQuestion(input: MethodPlacement & { variant: string; text: string }): Question;
  ids: IdMinter;
  now: string;
}
export interface MethodApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const pct = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 1000) / 10}%` : "—");
type Cfg = Record<string, unknown>;
type DesignFile = { columns: string[]; rows: Record<string, unknown>[]; summary?: Record<string, unknown> };

const KIND_OF: Record<ConjointMethodName, string> = { cbc: "conjoint", menu: "menu", acbc: "acbc", cva: "cva" };
const METHOD_OF_KIND: Record<string, ConjointMethodName> = { conjoint: "cbc", menu: "menu", acbc: "acbc", cva: "cva" };
const LABEL: Record<string, string> = { maxdiff: "MaxDiff", conjoint: "choice-based conjoint (CBC)", menu: "menu-based conjoint", acbc: "adaptive CBC (ACBC)", cva: "rating-based conjoint (CVA)" };
/** the config keys whose change changes the generated rows (others — labels, instructions, the None text — are read at render time) */
const GENERATION_KEYS: Record<string, string[]> = {
  maxdiff: ["items", "itemsPerTask", "tasks", "versions", "appearancesPerItem", "itemsPerVersion", "balance", "prohibitedPairs", "practiceTask"],
  conjoint: ["attributes", "prohibitions", "tasks", "alternativesPerTask", "noneOption", "holdoutTasks", "versions", "method", "dualResponseNone", "brandAttribute", "labelled", "alternativeSpecific"],
  menu: ["items", "requiredItems", "tasks", "versions", "noneOption", "exclusiveGroups"],
  acbc: ["attributes", "prohibitions", "screeningTasks", "conceptsPerScreen", "maxAttributesVaried", "unacceptableThreshold", "mustHaveThreshold", "tournamentAlternatives", "minTournamentConcepts", "priceBase", "priceIncrements", "priceVariation", "priceRound"],
  cva: ["attributes", "prohibitions", "mode", "profiles", "versions", "holdouts"],
};

/** MaxDiff items per task when the request does not say: about a third of the list, 3–5 (never more than items − 1) */
export function inferMaxDiffPerTask(items: number): number {
  return Math.max(3, Math.min(items - 1, items <= 7 ? 3 : items <= 15 ? 4 : 5));
}
/** CBC tasks when the request does not say: 12, or enough for one version to identify the main effects */
export function inferConjointTasks(attributes: { levels: string[] }[], alternatives: number): number {
  const params = attributes.reduce((n, a) => n + Math.max(0, a.levels.length - 1), 0);
  return Math.max(12, Math.ceil(params / Math.max(1, alternatives - 1)));
}

function generator(kind: string) {
  return designGeneratorRegistry.get(kind) ?? fail(`the ${LABEL[kind] ?? kind} design generator is not loaded here, so the design cannot be generated and checked — nothing was changed (the Studio loads @rescript/designs)`);
}
function seedFor(kind: string, config: Cfg): number {
  const gen: Cfg = {};
  for (const k of GENERATION_KEYS[kind] ?? Object.keys(config)) if (config[k] !== undefined) gen[k] = config[k];
  return hashString(`${kind}:${JSON.stringify(gen)}`) % 100_000;
}
/** validate with the generator's own checks (the panel's refusals), then generate */
function generate(kind: string, config: Cfg, seed: number): DesignFile {
  const plugin = generator(kind);
  const errors = plugin.validateConfig?.(config) ?? [];
  if (errors.length) fail(`this ${LABEL[kind] ?? kind} design is not feasible — ${errors.join(" ")}`);
  try { return plugin.generate(config, seed); }
  catch (e) { return fail(`this ${LABEL[kind] ?? kind} design could not be generated — ${(e as Error).message}`); }
}

/** the items a question offers: its options (a grid's rows), without None / Other / exclusive answers */
function itemsOfQuestion(q: Question): string[] {
  const grid = /matrix|grid/.test(q.type) || (q.rows?.length ?? 0) > 0 && (q.options?.length ?? 0) > 0 && /matrix/.test(q.variant ?? "");
  const list = (grid && q.rows?.length ? q.rows : q.options ?? []) as { label: string; flags?: string[] }[];
  return list.filter((o) => !(o.flags ?? []).some((f) => ["exclusive", "other_specify", "none_of_above", "dont_know", "refused"].includes(f)))
    .map((o) => stripHtmlText(o.label).trim()).filter(Boolean);
}

/** an item named in a pair / removeItems, resolved to the list's own spelling */
function resolveItem(items: string[], ref: string, what: string): string {
  return items.find((i) => i === ref) ?? items.find((i) => norm(i) === norm(ref)) ?? fail(`${what}: “${ref}” is not one of the items (${items.slice(0, 15).join(", ")}${items.length > 15 ? ", …" : ""})`);
}
const samePair = (a: MaxDiffPair, b: MaxDiffPair) => (norm(a[0]) === norm(b[0]) && norm(a[1]) === norm(b[1])) || (norm(a[0]) === norm(b[1]) && norm(a[1]) === norm(b[0]));

/* ---------------- MaxDiff ---------------- */

function maxdiffConfig(def: SurveyDefinition, env: MethodEnv, s: MaxDiffSpec, prev?: Cfg): { config: Cfg; assumed: string[] } {
  const assumed: string[] = [];
  const c: Cfg = prev ? structuredClone(prev) : { balance: "optimized" };
  let items = (c.items as string[] | undefined) ?? [];
  if (s.items) items = s.items;
  if (s.itemsFrom) {
    const q = env.question(s.itemsFrom) ?? fail(`there is no question “${s.itemsFrom}” to take the items from`);
    items = itemsOfQuestion(q);
    if (!items.length) fail(`${q.code} has no options to scale (None / Other answers are left out)`);
  }
  if (s.removeItems) { const drop = new Set(s.removeItems.map((r) => resolveItem(items, r, "removeItems"))); items = items.filter((i) => !drop.has(i)); }
  if (s.addItems) for (const it of s.addItems) { if (items.some((i) => norm(i) === norm(it))) fail(`“${it}” is already an item`); items = [...items, it]; }
  const dup = items.find((it, i) => items.findIndex((x) => norm(x) === norm(it)) !== i);
  if (dup) fail(`the items list “${dup}” twice — every item must be different`);
  if (items.length < 4) fail(`MaxDiff needs at least 4 items (it shows at least 3 per task and needs one more to compare) — this list has ${items.length}`);
  const itemsChanged = JSON.stringify(items) !== JSON.stringify(c.items);
  c.items = items;
  /* prohibited pairs: replaced, added to, removed from — each item resolved to the list's spelling */
  let pairs = ((c.prohibitedPairs as MaxDiffPair[] | undefined) ?? []).map((p) => (Array.isArray(p) ? p : [(p as { a: string }).a, (p as { b: string }).b]) as MaxDiffPair);
  if (s.prohibitedPairs) pairs = [];
  for (const p of [...(s.prohibitedPairs ?? []), ...(s.addProhibitedPairs ?? [])]) {
    const pair: MaxDiffPair = [resolveItem(items, p[0], "prohibited pair"), resolveItem(items, p[1], "prohibited pair")];
    if (pair[0] === pair[1]) fail(`a prohibited pair needs two different items (“${pair[0]}” is paired with itself)`);
    if (!pairs.some((x) => samePair(x, pair))) pairs.push(pair);
  }
  for (const p of s.removeProhibitedPairs ?? []) {
    const before = pairs.length;
    pairs = pairs.filter((x) => !samePair(x, p));
    if (pairs.length === before) fail(`“${p[0]}” and “${p[1]}” are not a prohibited pair`);
  }
  // a pair naming an item the list no longer has is dropped and said
  const stale = pairs.filter((p) => !items.includes(p[0]) || !items.includes(p[1]));
  if (stale.length) { pairs = pairs.filter((p) => !stale.includes(p)); assumed.push(`dropped the prohibited pair${stale.length === 1 ? "" : "s"} ${stale.map((p) => `${p[0]} / ${p[1]}`).join(", ")} (no longer both in the list)`); }
  if (pairs.length) c.prohibitedPairs = pairs; else delete c.prohibitedPairs;
  if (s.perTask !== undefined) c.itemsPerTask = s.perTask;
  else if ((!prev && c.itemsPerTask === undefined) || (itemsChanged && prev && Number(c.itemsPerTask ?? 5) >= items.length)) { c.itemsPerTask = inferMaxDiffPerTask(items.length); assumed.push(prev ? `${c.itemsPerTask} items per task (the list is now ${items.length} items)` : `${c.itemsPerTask} items per task`); }
  if (s.appearances !== undefined) { if (s.appearances === null) delete c.appearancesPerItem; else c.appearancesPerItem = s.appearances; }
  if (s.tasks !== undefined) { if (s.tasks === null) delete c.tasks; else c.tasks = s.tasks; }
  if (s.itemsPerVersion !== undefined) { if (s.itemsPerVersion === null) delete c.itemsPerVersion; else c.itemsPerVersion = s.itemsPerVersion; }
  /*
   * TASKS: inferred only when nothing sets them (no tasks, no appearances target) — about 3 shows per
   * item per respondent. An update never re-derives them: "make it 5 items per task" changes that one
   * setting, and the measured balance in the description says what it did to the shows per item.
   */
  if (!prev && c.tasks === undefined && c.appearancesPerItem === undefined) {
    const pool = Number(c.itemsPerVersion) > 0 && Number(c.itemsPerVersion) < items.length ? Number(c.itemsPerVersion) : items.length;
    c.tasks = Math.ceil((3 * pool) / Math.max(1, c.itemsPerTask as number));
    assumed.push(`${c.tasks} tasks (each item about 3 times per respondent)`);
  }
  if (s.versions !== undefined) c.versions = s.versions;
  else if (!prev && c.versions === undefined) { c.versions = 10; assumed.push("10 versions"); }
  if (s.responseMode) c.responseMode = s.responseMode;
  if (s.anchored !== undefined) c.anchored = s.anchored;
  if (s.practice !== undefined) c.practiceTask = s.practice;
  if (s.balance) c.balance = s.balance;
  for (const k2 of ["anchorPrompt", "bestLabel", "worstLabel", "instructions"] as const) {
    if (s[k2] === null) delete c[k2]; else if (s[k2] !== undefined) c[k2] = s[k2];
  }
  void def;
  return { config: c, assumed };
}

/** the generator's config: the action bookkeeping (`_autoTasks`) is not the generator's */
const genConfig = (c: Cfg): Cfg => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith("_")));

const STATUS_WORDS: Record<string, string> = { exact: "exactly balanced", best_possible: "balanced — as even as the counts allow", near: "near-balanced", uneven: "uneven" };

/** MaxDiff diagnostics in words, MEASURED on the rows (per version = what one respondent sees) */
export function maxdiffDesignWords(config: Cfg, file: DesignFile): string {
  const items = (config.items as string[]) ?? [];
  const n = items.length;
  const rows = file.rows.filter((r) => Number(r.practice) !== 1);
  const forbidden = new Set(((config.prohibitedPairs as MaxDiffPair[] | undefined) ?? []).map(([a, b]) => { const x = items.indexOf(a) + 1, y = items.indexOf(b) + 1; return x < y ? `${x}:${y}` : `${y}:${x}`; }));
  const byVersion = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    const v = String(r.version ?? 1), t = String(r.task);
    if (!byVersion.has(v)) byVersion.set(v, new Map());
    const tasks = byVersion.get(v)!;
    if (!tasks.has(t)) tasks.set(t, []);
    tasks.get(t)!.push(Number(r.item_index));
  }
  let showLo = Infinity, showHi = 0, pairLo = Infinity, pairHi = 0, k = 0, T = 0;
  for (const tasks of byVersion.values()) {
    T = Math.max(T, tasks.size);
    const show = new Map<number, number>(), pair = new Map<string, number>();
    const pool = new Set<number>();
    for (const ids of tasks.values()) {
      k = Math.max(k, ids.length);
      for (const i of ids) { show.set(i, (show.get(i) ?? 0) + 1); pool.add(i); }
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) { const key = ids[a] < ids[b] ? `${ids[a]}:${ids[b]}` : `${ids[b]}:${ids[a]}`; pair.set(key, (pair.get(key) ?? 0) + 1); }
    }
    for (const c of show.values()) { showLo = Math.min(showLo, c); showHi = Math.max(showHi, c); }
    const ids = [...pool].sort((a, b) => a - b);
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const key = `${ids[a]}:${ids[b]}`; if (forbidden.has(key)) continue;
      const c = pair.get(key) ?? 0; pairLo = Math.min(pairLo, c); pairHi = Math.max(pairHi, c);
    }
  }
  const V = byVersion.size;
  const d = (file.summary?.diagnostics ?? {}) as { balanced?: boolean; pairs?: { min: number; max: number; status: string }; items?: { status: string }; prohibited?: { pairs: number; violations: number }; warnings?: string[] };
  const range = (lo: number, hi: number, unit: string) => (lo === hi ? `${lo} ${unit}${lo === 1 ? "" : "s"}` : `${lo}–${hi} ${unit}s`);
  const express = Number(config.itemsPerVersion) > 0 && Number(config.itemsPerVersion) < n;
  const parts = [
    `${n} items, ${k} per task, ${T} tasks, ${plural(V, "version")}`,
    express ? `each respondent sees ${config.itemsPerVersion} of the items, each ${range(showLo, showHi, "time")}` : `each respondent sees every item ${range(showLo, showHi, "time")}`,
    Number.isFinite(pairLo) ? `within a version every pair shares a task ${range(pairLo, pairHi, "time")}` : "",
    V > 1 && d.pairs ? `across the ${V} versions ${d.pairs.min}–${d.pairs.max} times (${STATUS_WORDS[d.pairs.status] ?? d.pairs.status})` : !d.pairs ? "" : `(${STATUS_WORDS[d.pairs.status] ?? d.pairs.status})`,
    d.prohibited?.pairs ? `${plural(d.prohibited.pairs, "prohibited pair")} ${d.prohibited.violations ? `VIOLATED ${d.prohibited.violations} times` : "never shown together (checked on the rows)"}` : "",
    config.practiceTask ? "plus a practice task (not counted)" : "",
  ].filter(Boolean);
  // the measured verdict: "balanced" only when the generator's measurement earned it (items AND pairs as even as the counts allow)
  const verdict = d.balanced ? "balanced (as even as the counts allow)" : d.items && d.items.status !== "exact" && d.items.status !== "best_possible" ? `items ${STATUS_WORDS[d.items.status] ?? d.items.status}` : "";
  return `${parts.join("; ")}${verdict ? ` — ${verdict}` : ""}.${d.warnings?.length ? ` Warnings: ${d.warnings.join(" ")}` : ""}`;
}

/* ---------------- conjoint ---------------- */

function resolveAttribute(attrs: { name: string; levels: string[] }[], name: string, what: string) {
  return attrs.find((a) => a.name === name) ?? attrs.find((a) => norm(a.name) === norm(name)) ?? fail(`${what}: there is no attribute “${name}” — the attributes are ${attrs.map((a) => a.name).join(", ")}`);
}
function resolveLevel(attrs: { name: string; levels: string[] }[], r: LevelRef, what: string): LevelRef {
  const a = resolveAttribute(attrs, r.attribute, what);
  const level = a.levels.find((l) => l === r.level) ?? a.levels.find((l) => norm(l) === norm(r.level)) ?? fail(`${what}: “${r.level}” is not a level of ${a.name} (${a.levels.join(", ")})`);
  return { attribute: a.name, level };
}
const proKey = (p: ConjointProhibitionInput) => [p.a, p.b, ...(p.also ?? [])].map((x) => `${norm(x.attribute)}=${norm(x.level)}`).sort().join("&");

/* F4 2026-10-22: fields that belong to one method only */
const CBC_ONLY = ["dualResponse", "dualResponsePrompt", "labelled", "brandAttribute", "alternativeSpecific"] as const;
const CVA_ONLY = ["mode", "profiles", "scaleMin", "scaleMax", "minLabel", "maxLabel", "monotone"] as const;
const ACBC_PRICE = ["priceBase", "priceIncrements", "priceVariation", "priceCurrency"] as const;
const MENU_ONLY = ["exclusiveGroups"] as const;
const lineOf = (name: string, xs: (string | number)[], sep = ", ") => `${name}: ${xs.join(sep)}`;

function conjointConfig(method: ConjointMethodName, s: ConjointSpec, prev?: Cfg): { config: Cfg; assumed: string[] } {
  const assumed: string[] = [];
  const c: Cfg = prev ? structuredClone(prev) : {};
  if (method === "menu") {
    for (const k of ["attributes", "addAttributes", "removeAttributes", "levels", "prohibitions", "addProhibitions", "removeProhibitions", "alternatives", "holdouts", "design", "screeningTasks", "conceptsPerScreen", "tournamentAlternatives", "maxAttributesVaried", "minTournamentConcepts", ...CBC_ONLY, ...CVA_ONLY, ...ACBC_PRICE] as const) {
      if (s[k] !== undefined) fail(`“${k}” does not apply to a menu-based conjoint (every task shows the whole menu at varying prices) — use items, requiredItems, exclusiveGroups, tasks, versions, none, minSelections, maxSelections`);
    }
    if (s.items) c.items = s.items.map((i) => ({ name: i.name, levels: i.prices, ...(i.required ? { required: true } : {}) }));
    if (s.requiredItems) {
      const names = ((c.items as { name: string }[]) ?? []).map((i) => i.name);
      c.requiredItems = s.requiredItems.map((r) => names.find((x) => norm(x) === norm(r)) ?? fail(`requiredItems: “${r}” is not a menu item (${names.join(", ")})`));
    }
    if (s.tasks !== undefined) { if (s.tasks === null) delete c.tasks; else c.tasks = s.tasks; }
    if (!prev && c.tasks === undefined) { c.tasks = 8; assumed.push("8 menu tasks"); }
    if (s.versions !== undefined) c.versions = s.versions; else if (!prev && c.versions === undefined) { c.versions = 10; assumed.push("10 versions"); }
    if (s.none !== undefined) c.noneOption = s.none;
    for (const k of ["minSelections", "maxSelections", "currency"] as const) if (s[k] !== undefined) c[k] = s[k];
    if (s.noneLabel !== undefined) { if (s.noneLabel === null) delete c.noneLabel; else c.noneLabel = s.noneLabel; }
    if (s.exclusiveGroups !== undefined) {
      if (s.exclusiveGroups === null || !s.exclusiveGroups.length) delete c.exclusiveGroups;
      else {
        const names = ((c.items as { name: string }[]) ?? []).map((i) => i.name);
        c.exclusiveGroups = s.exclusiveGroups.map((g) => lineOf(g.name, g.items.map((it) => names.find((x) => norm(x) === norm(it)) ?? fail(`exclusiveGroups: “${it}” is not a menu item (${names.join(", ")})`)), " | "));
      }
    }
    return { config: c, assumed };
  }
  let attrs = ((c.attributes as { name: string; levels: string[] }[] | undefined) ?? []).map((a) => ({ name: a.name, levels: [...a.levels] }));
  if (s.attributes) attrs = s.attributes.map((a) => ({ name: a.name, levels: [...a.levels] }));
  for (const r of s.removeAttributes ?? []) { const a = resolveAttribute(attrs, r, "removeAttributes"); attrs = attrs.filter((x) => x !== a); }
  for (const a of s.addAttributes ?? []) { if (attrs.some((x) => norm(x.name) === norm(a.name))) fail(`there is already an attribute “${a.name}” — change its levels with levels: {"${a.name}": [...]}`); attrs.push({ name: a.name, levels: [...a.levels] }); }
  for (const [name, levels] of Object.entries(s.levels ?? {})) resolveAttribute(attrs, name, "levels").levels = levels;
  c.attributes = attrs;
  /* prohibitions: every level resolved; those naming a level that is gone are dropped and said */
  type P = { a: LevelRef; b: LevelRef; also?: LevelRef[]; alsoOp?: "and" | "or"; when?: unknown };
  let pros = ((c.prohibitions as P[] | undefined) ?? []).map((p) => structuredClone(p));
  if (s.prohibitions) pros = [];
  for (const p of [...(s.prohibitions ?? []), ...(s.addProhibitions ?? [])]) {
    const r: P = { a: resolveLevel(attrs, p.a, "prohibition"), b: resolveLevel(attrs, p.b, "prohibition"), ...(p.also?.length ? { also: p.also.map((x) => resolveLevel(attrs, x, "prohibition")), ...(p.alsoOp ? { alsoOp: p.alsoOp } : {}) } : {}) };
    if (norm(r.a.attribute) === norm(r.b.attribute)) fail(`a prohibition pairs levels of two different attributes (both are ${r.a.attribute})`);
    if (!pros.some((x) => !x.when && proKey(x as ConjointProhibitionInput) === proKey(r as ConjointProhibitionInput))) pros.push(r);
  }
  for (const p of s.removeProhibitions ?? []) {
    const before = pros.length;
    pros = pros.filter((x) => x.when || proKey(x as ConjointProhibitionInput) !== proKey(p));
    if (before === pros.length) fail(`there is no prohibition ${[p.a, p.b, ...(p.also ?? [])].map((x) => `${x.attribute} ${x.level}`).join(" with ")}`);
  }
  const has = (x: LevelRef) => attrs.some((a) => a.name === x.attribute && a.levels.includes(x.level));
  const gone = pros.filter((p) => !p.when && ![p.a, p.b, ...(p.also ?? [])].every(has));
  if (gone.length) { pros = pros.filter((p) => !gone.includes(p)); assumed.push(`dropped ${plural(gone.length, "prohibition")} naming a level that is no longer in the design`); }
  if (pros.length) c.prohibitions = pros; else delete c.prohibitions;
  if (method === "acbc") {
    for (const k of ["alternatives", "tasks", "versions", "holdouts", "none", "noneLabel", "design", "items", "requiredItems", "minSelections", "maxSelections", "currency", ...CBC_ONLY, ...CVA_ONLY, ...MENU_ONLY] as const) {
      if (s[k] !== undefined) fail(`“${k}” does not apply to ACBC — its concepts are built around each respondent's build-your-own answer at interview time (no fixed tasks or versions). Use screeningTasks, conceptsPerScreen, tournamentAlternatives, maxAttributesVaried, minTournamentConcepts, priceBase / priceIncrements (summed price)`);
    }
    for (const k of ["screeningTasks", "conceptsPerScreen", "tournamentAlternatives", "maxAttributesVaried", "minTournamentConcepts"] as const) if (s[k] !== undefined) c[k] = s[k];
    /* F4 2026-10-22: summed price — increments stored as the panel's lines, attribute names resolved */
    if (s.priceBase !== undefined) { if (s.priceBase === null) delete c.priceBase; else c.priceBase = s.priceBase; }
    if (s.priceIncrements !== undefined) {
      if (s.priceIncrements === null) delete c.priceIncrements;
      else c.priceIncrements = Object.entries(s.priceIncrements).map(([k, xs]) => { const a = resolveAttribute(attrs, k, "priceIncrements"); if (xs.length !== a.levels.length) fail(`priceIncrements: ${a.name} has ${a.levels.length} levels (${a.levels.join(", ")}) but ${xs.length} increments — give one per level`); return lineOf(a.name, xs); });
    }
    if (s.priceVariation !== undefined) c.priceVariation = s.priceVariation;
    if (s.priceCurrency !== undefined) c.priceCurrency = s.priceCurrency;
    if ((c.priceIncrements || c.priceBase != null) && c.priceBase == null) { c.priceBase = 0; assumed.push("base price 0 (the increments are the whole price)"); }
    if ((c.priceIncrements || c.priceBase != null) && c.priceVariation === undefined && !prev) { c.priceVariation = 30; assumed.push("price variation ±30%"); }
    return { config: c, assumed };
  }
  if (method === "cva") {
    for (const k of ["alternatives", "tasks", "none", "noneLabel", "design", "items", "requiredItems", "minSelections", "maxSelections", "currency", "screeningTasks", "conceptsPerScreen", "tournamentAlternatives", "maxAttributesVaried", "minTournamentConcepts", ...CBC_ONLY, ...ACBC_PRICE, ...MENU_ONLY] as const) {
      if (s[k] !== undefined) fail(`“${k}” does not apply to a rating-based conjoint (CVA) — respondents rate full profiles (or pairs). Use attributes, prohibitions, mode (single | paired), profiles, versions, holdouts, scale, minLabel, maxLabel, monotone`);
    }
    if (s.mode) c.mode = s.mode; else if (!prev && c.mode === undefined) { c.mode = "single"; assumed.push("single profiles rated 0–10"); }
    if (s.profiles !== undefined) { if (s.profiles === null) delete c.profiles; else c.profiles = s.profiles; }
    if (!prev && c.profiles === undefined) {
      const params = attrs.reduce((t, a) => t + a.levels.length - 1, 0) + (c.mode === "paired" ? 0 : 1);
      assumed.push(`${Math.max(params + 3, Math.ceil(1.5 * params))} ${c.mode === "paired" ? "pairs" : "profiles"} per version (1.5 × the ${params} parameters)`);
    }
    if (s.versions !== undefined) c.versions = s.versions; else if (!prev && c.versions === undefined) { c.versions = 4; assumed.push("4 versions"); }
    if (s.holdouts !== undefined) c.holdouts = s.holdouts;
    for (const k of ["scaleMin", "scaleMax", "minLabel", "maxLabel"] as const) { if (s[k] === null) delete c[k]; else if (s[k] !== undefined) c[k] = s[k]; }
    if (s.monotone !== undefined) {
      if (s.monotone === null) delete c.monotone;
      else c.monotone = Object.entries(s.monotone).map(([k, d]) => `${resolveAttribute(attrs, k, "monotone").name}: ${d}`);
    }
    return { config: c, assumed };
  }
  for (const k of ["items", "requiredItems", "minSelections", "maxSelections", "currency", "screeningTasks", "conceptsPerScreen", "tournamentAlternatives", "maxAttributesVaried", "minTournamentConcepts", ...CVA_ONLY, ...ACBC_PRICE, ...MENU_ONLY] as const) {
    if (s[k] !== undefined) fail(`“${k}” does not apply to a choice-based conjoint (CBC)${k === "items" || k === "requiredItems" || k === "exclusiveGroups" ? " — a menu of priced items is method menu" : (CVA_ONLY as readonly string[]).includes(k) ? " — rated profiles are method cva" : " — those are ACBC settings"}`);
  }
  /* F4 2026-10-22: brand-specific / labelled designs — names resolved to the attributes' spellings */
  if (s.brandAttribute !== undefined) { if (s.brandAttribute === null) delete c.brandAttribute; else c.brandAttribute = resolveAttribute(attrs, s.brandAttribute, "brandAttribute").name; }
  const brandName = (c.brandAttribute as string | undefined) ?? attrs.find((a) => /^brand|^make|^label|^provider|^operator/i.test(a.name))?.name ?? attrs[0]?.name;
  if (s.labelled !== undefined) c.labelled = s.labelled;
  if (s.alternativeSpecific !== undefined) {
    if (s.alternativeSpecific === null || !s.alternativeSpecific.length) delete c.alternativeSpecific;
    else {
      const brand = resolveAttribute(attrs, brandName ?? "", "alternativeSpecific (brand attribute)");
      c.alternativeSpecific = s.alternativeSpecific.map((r) => lineOf(resolveAttribute(attrs, r.attribute, "alternativeSpecific").name, r.appliesTo.map((b) => resolveLevel(attrs, { attribute: brand.name, level: b }, "alternativeSpecific").level)));
    }
  }
  if ((c.labelled === true || c.alternativeSpecific) && !c.brandAttribute && brandName) { c.brandAttribute = brandName; if (!prev || s.labelled !== undefined || s.alternativeSpecific !== undefined) assumed.push(`${brandName} is the brand attribute`); }
  if (c.labelled === true && s.alternatives === undefined) {
    const nb = attrs.find((a) => a.name === c.brandAttribute)?.levels.length;
    if (nb && c.alternativesPerTask !== nb) { c.alternativesPerTask = nb; assumed.push(`${nb} alternatives per task (one per ${c.brandAttribute} level — labelled)`); }
  }
  /* F4 2026-10-22: dual-response None replaces the None alternative */
  if (s.dualResponse !== undefined) {
    if (s.dualResponse) { c.dualResponseNone = true; if (c.noneOption && s.none === undefined) { c.noneOption = false; assumed.push("the None alternative is replaced by the dual-response question"); } }
    else delete c.dualResponseNone;
  }
  if (s.dualResponsePrompt !== undefined) { if (s.dualResponsePrompt === null) delete c.dualResponsePrompt; else c.dualResponsePrompt = s.dualResponsePrompt; }
  if (s.none === true && c.dualResponseNone === true && s.dualResponse === undefined) { delete c.dualResponseNone; assumed.push("dual-response None turned off (a None alternative is shown in the task instead)"); }
  if (s.alternatives !== undefined) c.alternativesPerTask = s.alternatives;
  else if (!prev && c.alternativesPerTask === undefined) { c.alternativesPerTask = 3; assumed.push("3 alternatives per task"); }
  if (s.tasks !== undefined) { if (s.tasks === null) delete c.tasks; else c.tasks = s.tasks; }
  if (!prev && c.tasks === undefined) { c.tasks = inferConjointTasks(attrs, c.alternativesPerTask as number); assumed.push(`${c.tasks} tasks`); }
  if (s.versions !== undefined) c.versions = s.versions; else if (!prev && c.versions === undefined) { c.versions = 10; assumed.push("10 versions"); }
  if (s.holdouts !== undefined) c.holdoutTasks = s.holdouts;
  if (s.none !== undefined) c.noneOption = s.none;
  if (s.noneLabel !== undefined) { if (s.noneLabel === null) delete c.noneLabel; else c.noneLabel = s.noneLabel; }
  if (s.design) c.method = s.design; else if (c.method === undefined && !prev) c.method = "efficient";
  return { config: c, assumed };
}

/** conjoint diagnostics in words, from the summary the generator measured */
export function conjointDesignWords(kind: string, config: Cfg, file: DesignFile): string {
  const s = (file.summary ?? {}) as Record<string, any>;
  if (kind === "acbc") {
    const attrs = (config.attributes as { name: string; levels: string[] }[]) ?? [];
    const sp = s.summedPrice as { base: number; variationPct: number; currency: string } | undefined;
    return `${attrs.length} attributes (${attrs.map((a) => a.levels.length).join("×")} levels, ${s.conceptSpace ?? "?"} possible concepts)${sp ? `, summed price from ${sp.currency}${sp.base} plus level increments, varied ±${sp.variationPct}%` : ""}; build-your-own → ${s.screeningTasks ?? 6} screens of ${s.conceptsPerScreen ?? 4} concepts → unacceptable / must-have questions → a choice tournament in sets of ${(config.tournamentAlternatives as number) ?? 3}. Adaptive: each respondent's concepts are generated at interview time from their own answers, so there is no fixed task table. The analysis estimates utilities from BYO, screening and tournament together (Conjoint: aggregate logit and counts; Hierarchical Bayes: individual utilities)${sp ? " with price as a linear term" : ""}.`;
  }
  if (kind === "cva") {
    const attrs = (config.attributes as { name: string; levels: string[] }[]) ?? [];
    const e = (s.efficiency as { perVersion?: { mean?: number; min?: number } } | undefined)?.perVersion;
    const sc = s.scale as { min: number; max: number } | undefined;
    return `${attrs.length} attributes (${attrs.map((a) => `${a.name} ${a.levels.length}`).join(", ")} levels); ${s.mode === "paired" ? `${s.profilesPerVersion} pairs rated on a ${sc?.min ?? 1}–${sc?.max ?? 9} preference scale` : `${s.profilesPerVersion} profiles rated ${sc?.min ?? 0}–${sc?.max ?? 10}`} per version, ${plural(Number(s.versions ?? 1), "version")}${s.holdouts ? ` + ${s.holdouts} holdout${s.holdouts === 1 ? "" : "s"}` : ""}; D-optimal (exchange): D-efficiency ${pct(e?.mean)} per version (worst ${pct(e?.min)}); ${s.degreesOfFreedom} degrees of freedom per respondent for ${s.parameters} part-worths${s.mode === "paired" ? "" : " and an intercept"}. Utilities are estimated per respondent by least squares (fit R² per respondent; flat raters flagged).${Array.isArray(s.warnings) && s.warnings.length ? ` Warnings: ${s.warnings.join(" ")}` : ""}`;
  }
  if (kind === "menu") {
    const items = (config.items as { name: string; levels: string[]; required?: boolean }[]) ?? [];
    const req = new Set([...(config.requiredItems as string[] | undefined) ?? [], ...items.filter((i) => i.required).map((i) => i.name)]);
    const groups = (s.exclusiveGroups as { name: string; items: string[] }[] | undefined) ?? [];
    return `${items.length} menu items (${items.map((i) => `${i.name} ${i.levels.length} price${i.levels.length === 1 ? "" : "s"}`).join(", ")})${req.size ? `, always included: ${[...req].join(", ")}` : ""}${groups.length ? `; one-of sections: ${groups.map((g) => `${g.name} (${g.items.join(" / ")})`).join(", ")}` : ""}; ${s.tasksPerVersion ?? config.tasks} tasks, ${plural(Number(s.versions ?? config.versions ?? 1), "version")}${config.noneOption === false ? "" : ", “buy nothing” offered"}. The analysis reports take rates by item and price (counts) and fits per-item logits on own and cross prices${groups.length ? " (a multinomial choice per section)" : ""}, with a menu simulator (take rates, revenue, bundles).${Array.isArray(s.warnings) && s.warnings.length ? ` Warnings: ${s.warnings.join(" ")}` : ""}`;
  }
  const attrs = (config.attributes as { name: string; levels: string[] }[]) ?? [];
  const e = s.efficiency as Record<string, any> | undefined;
  const freq = (s.levelFrequencies ?? {}) as Record<string, Record<string, number>>;
  const counts = Object.values(freq).flatMap((m) => Object.values(m));
  const parts = [
    `${attrs.length} attributes (${attrs.map((a) => `${a.name} ${a.levels.length}`).join(", ")} levels)`,
    `${s.alternativesPerTask ?? config.alternativesPerTask} alternatives${s.noneOption ? " + None" : ""} per task, ${s.tasksPerVersion ?? config.tasks} tasks${s.holdoutTasksPerVersion ? ` + ${s.holdoutTasksPerVersion} holdout` : ""}, ${plural(Number(s.versions ?? 1), "version")}, ${s.method === "efficient" ? "efficient (D-efficiency swapping)" : "level-balanced"}`,
    e ? (typeof e.parameters === "number" && e.minVersionDegreesOfFreedom < e.parameters
      ? `D-efficiency ${pct(e.pooled)} pooled (one version alone is too short to identify the model)`
      : `D-efficiency ${pct(e.perVersion?.mean)} per version (worst ${pct(e.perVersion?.min)}), ${pct(e.pooled)} pooled`) : "",
    counts.length ? `each level shown ${Math.min(...counts)}–${Math.max(...counts)} times` : "",
    e && typeof e.avoidableOverlapPct === "number" ? `avoidable overlap ${e.avoidableOverlapPct}%` : "",
    e && typeof e.duplicateConceptTasks === "number" ? `${e.duplicateConceptTasks} tasks with a duplicate concept` : "",
    s.legalConcepts != null ? `the prohibitions leave ${s.legalConcepts} of ${s.totalConcepts} concepts (${s.spaceRemaining}%)` : "",
    /* F4 2026-10-22 */
    s.dualResponseNone ? `dual-response None: a forced choice, then “${(config.dualResponsePrompt as string | undefined) ?? "Would you actually buy the option you chose?"}”` : "",
    s.alternativeSpecific ? `${(s.alternativeSpecific as { labelled?: boolean }).labelled ? "labelled (each " + (s.alternativeSpecific as { brandAttribute: string }).brandAttribute + " once per task)" : "brand-specific"}${((s.alternativeSpecific as { rules?: { attribute: string; appliesTo: string[] }[] }).rules ?? []).map((r) => `; ${r.attribute} only for ${r.appliesTo.join("/")}`).join("")}` : "",
  ].filter(Boolean);
  return `${parts.join("; ")}.${Array.isArray(s.warnings) && s.warnings.length ? ` Warnings: ${s.warnings.join(" ")}` : ""}`;
}

const designWords = (kind: string, config: Cfg, file: DesignFile) => (kind === "maxdiff" ? maxdiffDesignWords(config, file) : conjointDesignWords(kind, config, file));

/** the respondent-facing question's variant for a design kind */
function variantFor(kind: string, config: Cfg): string {
  if (kind === "maxdiff") return "maxdiff.best_worst";
  if (kind === "menu") return ((config.requiredItems as string[] | undefined)?.length || ((config.items as { required?: boolean }[]) ?? []).some((i) => i.required)) ? "conjoint.pricing_configurator" : "conjoint.menu";
  if (kind === "acbc") return "conjoint.acbc";
  if (kind === "cva") return "conjoint.cva";
  return "conjoint.cbc";
}
function defaultText(kind: string, config: Cfg): string {
  if (kind === "maxdiff") return config.responseMode === "best_only" ? "In each set, which item is the most important to you?" : "In each set, which item is the most important to you, and which is the least important?";
  if (kind === "menu") return "Which of these would you buy at these prices?";
  if (kind === "acbc") return "First build the product you would most like. Then tell us which of the alternatives could work for you.";
  if (kind === "cva") return config.mode === "paired" ? "Which of these two would you prefer, and how strongly?" : "How likely would you be to buy this product?";
  return "If these were your only options, which would you choose?";
}
/** what the respondent sees and what is recorded, in words */
function dataWords(kind: string, q: Question, config: Cfg): string {
  const v = q.variableName;
  if (kind === "maxdiff") return `${q.code} shows the tasks on its own page${q.required ? ", every task required" : ""}; item order is shuffled per respondent and task (recorded in _ORDER); data: ${v}_VERSION, ${v}_T<n>_BEST${config.responseMode === "best_only" ? "" : `, ${v}_T<n>_WORST`}${config.anchored ? `, ${v}_T<n>_ANCHOR` : ""}, ${v}_T<n>_ORDER`;
  if (kind === "conjoint") return `${q.code} shows the tasks on its own page${q.required ? ", every task required" : ""}; alternatives are shown in a per-respondent random order (${config.labelled ? "labelled by brand" : "Option A/B/C by position"}${config.noneOption ? ", None last" : ""}${config.dualResponseNone ? ", then “would you buy it?”" : ""}); data: ${v}_VERSION, ${v}_T<n> (the chosen design alternative), ${v}_T<n>_ORDER${config.dualResponseNone ? `, ${v}_T<n>_BUY` : ""}, and the stacked CBC file`;
  if (kind === "menu") return `${q.code} shows each menu on its own task; data: ${v}_VERSION and the items chosen per task`;
  if (kind === "cva") return `${q.code} shows each ${config.mode === "paired" ? "pair" : "profile"} with a rating scale${q.required ? ", every rating required" : ""}; data: ${v}_VERSION, ${v}_T<n> (the rating)`;
  return `${q.code} runs the adaptive stages; the full transcript is stored (${v}_JSON)`;
}

function designOf(def: SurveyDefinition, q: Question): DesignReference | undefined {
  const ref = (q.settings as { designRef?: string } | undefined)?.designRef;
  return ref ? (def.designs ?? []).find((d) => d.id === ref) : undefined;
}
/** the question an update names — by code / variable, or by its design's name */
function targetQuestion(def: SurveyDefinition, env: MethodEnv, ref: string): Question {
  const q = env.question(ref);
  if (q) return q;
  const d = (def.designs ?? []).find((x) => x.id === ref || norm(x.name) === norm(ref));
  const byDesign = d ? def.questions.find((x) => (x.settings as { designRef?: string } | undefined)?.designRef === d.id) : undefined;
  return byDesign ?? fail(`there is no question “${ref}”`);
}

function changedKeys(before: Cfg, after: Cfg, keys: string[]): string[] {
  return keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}
const FIELD_WORDS: Record<string, string> = { itemsPerTask: "items per task", alternativesPerTask: "alternatives per task", appearancesPerItem: "appearances per item", itemsPerVersion: "items per version", prohibitedPairs: "prohibited pairs", practiceTask: "practice task", noneOption: "None option", noneLabel: "None text", holdoutTasks: "holdout tasks", method: "design method", responseMode: "response method", bestLabel: "best label", worstLabel: "worst label", requiredItems: "required items" };
const valueWords = (v: unknown): string => (v === undefined || v === null ? "not set" : typeof v === "boolean" ? (v ? "on" : "off") : Array.isArray(v) ? `${v.length}` : typeof v === "object" ? "…" : String(v));

export function applyMethodAction(def: SurveyDefinition, a: MethodAction, env: MethodEnv): MethodApplied {
  def.designs = def.designs ?? [];
  const warnings: string[] = [];
  switch (a.op) {
    case "simulate_conjoint": return applySimulation(def, a, env);
    case "create_maxdiff": case "create_conjoint": {
      const kind = a.op === "create_maxdiff" ? "maxdiff" : KIND_OF[(a as ConjointSpec).method ?? "cbc"];
      const built = a.op === "create_maxdiff" ? maxdiffConfig(def, env, a) : conjointConfig((a as ConjointSpec).method ?? "cbc", a as ConjointSpec);
      const config = built.config;
      const seed = a.seed ?? seedFor(kind, genConfig(config));
      const file = generate(kind, genConfig(config), seed);
      const variant = variantFor(kind, config);
      const q = env.createQuestion({ variant, text: a.text ?? defaultText(kind, config), ref: a.ref, block: a.block, after: a.after, newPage: a.newPage ?? true, code: a.code, required: a.required ?? true });
      const id = env.ids("design");
      def.designs.push({ id, kind, name: a.name ?? `${q.code} ${LABEL[kind] ?? kind} design`, version: 1, seed, config, file: { format: "json", columns: file.columns, rows: file.rows, ...(file.summary ? { summary: file.summary } : {}), generatedAt: env.now } } as DesignReference);
      (q.settings as Record<string, unknown>).designRef = id;
      const what = LABEL[kind] ?? kind;
      return {
        description: `Created ${q.code} — ${what} (seed ${seed}): ${designWords(kind, config, file)}${built.assumed.length ? ` Assumed (not stated): ${built.assumed.join(", ")}.` : ""} ${dataWords(kind, q, config)}.`,
        warnings, touched: [q.id],
      };
    }
    case "update_maxdiff": case "update_conjoint": {
      const q = targetQuestion(def, env, a.target);
      const d = designOf(def, q) ?? fail(`${q.code} is not a MaxDiff or conjoint question with a design (${q.type.replace(/_/g, " ")})`);
      if (d.kind === "imported") fail(`${q.code}'s design was imported from a file — there is no configuration to regenerate from. Create a new design (create_${a.op === "update_maxdiff" ? "maxdiff" : "conjoint"}) or import a new file`);
      if (a.op === "update_maxdiff" && d.kind !== "maxdiff") fail(`${q.code} is a ${LABEL[d.kind] ?? d.kind} question — use update_conjoint`);
      if (a.op === "update_conjoint" && !METHOD_OF_KIND[d.kind]) fail(`${q.code} is a ${LABEL[d.kind] ?? d.kind} question — use update_maxdiff`);
      if (a.op === "update_conjoint" && (a as ConjointSpec).method && (a as ConjointSpec).method !== METHOD_OF_KIND[d.kind]) {
        fail(`${q.code} is a ${LABEL[d.kind]}; changing it to ${LABEL[KIND_OF[(a as ConjointSpec).method!]]} is a different question and design — create one with create_conjoint (and remove ${q.code} if it is no longer wanted)`);
      }
      const prev = (d.config ?? {}) as Cfg;
      const built = a.op === "update_maxdiff" ? maxdiffConfig(def, env, a, prev) : conjointConfig(METHOD_OF_KIND[d.kind], a as ConjointSpec, prev);
      const config = built.config;
      const genKeys = GENERATION_KEYS[d.kind] ?? Object.keys(config);
      const regen = changedKeys(prev, config, genKeys).length > 0 || (a.seed !== undefined && a.seed !== d.seed) || !d.file?.rows?.length;
      const changed = changedKeys(prev, config, [...new Set([...Object.keys(prev), ...Object.keys(config)])].filter((k) => !k.startsWith("_")));
      const seed = a.seed ?? d.seed ?? seedFor(d.kind, genConfig(config));
      const lines: string[] = [];
      let destructive: string | undefined;
      let file: DesignFile = { columns: d.file?.columns ?? [], rows: (d.file?.rows ?? []) as Record<string, unknown>[], ...(d.file?.summary ? { summary: d.file.summary as Record<string, unknown> } : {}) };
      if (regen) {
        file = generate(d.kind, genConfig(config), seed);
        const same = JSON.stringify(file.rows) === JSON.stringify(d.file?.rows ?? []);
        Object.assign(d, { config, seed, ...(same ? {} : { version: (d.version ?? 1) + 1 }), file: { format: "json", columns: file.columns, rows: file.rows, ...(file.summary ? { summary: file.summary } : {}), generatedAt: env.now } });
        if (!same) {
          const status = def.meta?.status;
          destructive = `Regenerates the ${LABEL[d.kind] ?? d.kind} design of ${q.code} (v${d.version})${status === "live" || status === "closed" ? ` while the survey is ${status}: respondents who already answered saw the previous tasks` : ""}`;
          if (status === "live" || status === "closed") warnings.push(`${q.code}'s design changes on a ${status} survey — answers collected so far belong to the previous design; analysing old and new answers together needs care (a new question keeps them apart).`);
        }
        lines.push(same ? "the tasks are unchanged (same rows)" : `design regenerated (v${d.version}): ${designWords(d.kind, config, file)}`);
      } else {
        d.config = config;
        lines.push(`the tasks are unchanged (${d.file?.rows?.length ?? 0} rows kept)`);
      }
      const qWhat: string[] = [];
      if (a.text) { q.text = a.text; qWhat.push("wording"); }
      if (a.required !== undefined) { q.required = a.required; qWhat.push(a.required ? "required" : "optional"); }
      const variant = variantFor(d.kind, config);
      if (variant !== q.variant && d.kind === "menu") { q.variant = variant; qWhat.push(variant === "conjoint.pricing_configurator" ? "now a pricing configurator" : "now a plain menu"); }
      const changes = changed.map((k) => `${FIELD_WORDS[k] ?? k} ${valueWords(prev[k])} → ${valueWords(config[k])}`);
      return {
        description: `${q.code} ${LABEL[d.kind] ?? d.kind} now: ${[...changes, ...qWhat].join(", ") || "no setting changed"} — ${lines.join("; ")}${built.assumed.length ? ` Assumed (not stated): ${built.assumed.join(", ")}.` : ""} Everything else on ${q.code} (logic, text, other settings) is unchanged.`,
        ...(destructive ? { destructive } : {}), warnings, touched: [q.id],
      };
    }
  }
}

/**
 * SAVE A SIMULATOR SCENARIO on the design (F4 2026-10-22). Checked against the design — a menu's items
 * and prices that parse, a product's attributes and levels — and stored in `config.simulations` by name
 * (replacing a scenario of the same name). Never regenerates the tasks.
 */
function applySimulation(def: SurveyDefinition, a: Extract<MethodAction, { op: "simulate_conjoint" }>, env: MethodEnv): MethodApplied {
  const q = targetQuestion(def, env, a.target);
  const d = designOf(def, q) ?? fail(`${q.code} is not a conjoint question with a design`);
  if (!METHOD_OF_KIND[d.kind]) fail(`${q.code} is a ${LABEL[d.kind] ?? d.kind} question — the simulator runs on conjoint designs (CBC, ACBC, menu, CVA)`);
  const c = (d.config ?? {}) as Cfg;
  const list = ((c.simulations as SimulationScenarioInput[] | undefined) ?? []).filter((x) => norm(x.name) !== norm(a.scenario.name));
  if (a.remove) {
    if (list.length === ((c.simulations as unknown[] | undefined) ?? []).length) fail(`${q.code} has no simulator scenario “${a.scenario.name}”`);
    d.config = { ...c, simulations: list };
    if (!list.length) delete (d.config as Cfg).simulations;
    return { description: `Removed simulator scenario “${a.scenario.name}” from ${q.code}; the design and its tasks are unchanged.`, warnings: [], touched: [q.id] };
  }
  const sc = structuredClone(a.scenario);
  const parts: string[] = [];
  const warnings: string[] = [];
  if (d.kind === "menu") {
    if (sc.products) fail("a menu scenario sets item prices and bundles (prices, bundles), not products");
    const items = ((c.items as { name: string; levels: string[] }[]) ?? []);
    const item = (n: string) => items.find((i) => norm(i.name) === norm(n)) ?? fail(`“${n}” is not on the menu (${items.map((i) => i.name).join(", ")})`);
    const money = (v: string | number, what: string) => { const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0]); if (!Number.isFinite(n)) fail(`${what}: “${v}” is not a price`); return n; };
    if (sc.prices) sc.prices = Object.fromEntries(Object.entries(sc.prices).map(([k, v]) => { const it = item(k); const n = money(v, it.name); const tested = it.levels.map((l) => Number(String(l).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0])).filter(Number.isFinite); if (tested.length && (n < Math.min(...tested) || n > Math.max(...tested))) warnings.push(`${it.name} at ${v} is outside the tested prices (${it.levels.join(", ")}) — the simulator extrapolates the price slope, which is less reliable.`); return [it.name, n]; }));
    if (sc.bundles) sc.bundles = sc.bundles.map((b) => ({ name: b.name, items: b.items.map((x) => item(x).name), price: money(b.price, b.name) }));
    if (sc.prices) parts.push(`prices ${Object.entries(sc.prices).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (sc.bundles) parts.push(sc.bundles.map((b) => `bundle “${b.name}” (${b.items.join(" + ")}) at ${b.price}`).join("; "));
  } else {
    if (sc.prices || sc.bundles) fail("prices and bundles belong to a menu scenario — give products: [{name, levels}]");
    const attrs = ((c.attributes as { name: string; levels: string[] }[]) ?? []);
    sc.products = (sc.products ?? []).map((p) => ({ ...p, levels: Object.fromEntries(Object.entries(p.levels).map(([k, v]) => { const r = resolveLevel(attrs, { attribute: k, level: v }, `product ${p.name}`); return [r.attribute, r.level]; })) }));
    const missing = sc.products.flatMap((p) => attrs.filter((x) => !(x.name in p.levels)).map((x) => `${p.name}: ${x.name}`));
    if (missing.length) warnings.push(`Not every product names every attribute (${missing.slice(0, 4).join("; ")}${missing.length > 4 ? "; …" : ""}) — the simulator uses the attribute's first level for those.`);
    if (d.kind === "acbc" && c.priceBase == null && sc.products.some((p) => p.price !== undefined)) warnings.push("This ACBC design has no summed price, so a product's price is ignored (price is one of its attributes, if any).");
    parts.push(sc.products.map((p) => `${p.name} (${Object.values(p.levels).join(", ")}${p.price !== undefined ? `, price ${p.price}` : ""})`).join(" vs "));
  }
  d.config = { ...c, simulations: [...list, sc] };
  return {
    description: `Simulator scenario “${sc.name}” saved on ${q.code} (${LABEL[d.kind] ?? d.kind}): ${parts.join("; ")}${sc.rule ? `; rule ${sc.rule}` : ""}. The tasks are unchanged. Data Analytics → Conjoint on ${q.code} simulates it from the respondents' utilities (${d.kind === "menu" ? "take rate per item and of each bundle, revenue per respondent" : "share of preference, revenue where products carry prices"}); results appear once responses are in.`,
    warnings, touched: [q.id],
  };
}

export function describeMethodAction(a: MethodAction): string {
  switch (a.op) {
    case "create_maxdiff": return `Create a MaxDiff${a.items ? ` of ${a.items.length} items` : a.itemsFrom ? ` of ${a.itemsFrom}'s items` : ""}`;
    case "create_conjoint": return `Create a ${LABEL[KIND_OF[a.method ?? "cbc"]]}`;
    case "update_maxdiff": return `Change the MaxDiff ${a.target}`;
    case "update_conjoint": return `Change the conjoint ${a.target}`;
    case "simulate_conjoint": return a.remove ? `Remove simulator scenario “${a.scenario.name}” from ${a.target}` : `Simulator scenario “${a.scenario.name}” on ${a.target}`;
  }
}

/** a design question's configuration in one line, for the copilot's outline (what update_* can change) */
export function describeDesignQuestion(def: SurveyDefinition, q: Question): string | null {
  const d = designOf(def, q);
  if (!d) return null;
  const c = (d.config ?? {}) as Cfg;
  if (d.kind === "maxdiff") {
    const pairs = (c.prohibitedPairs as MaxDiffPair[] | undefined) ?? [];
    return `${q.code} MaxDiff [design ${d.name}, v${d.version}, seed ${d.seed}]: ${(c.items as string[] ?? []).length} items (${(c.items as string[] ?? []).slice(0, 25).join(" | ")}), ${c.itemsPerTask ?? "?"} per task, ${c.tasks ?? "auto"} tasks, ${c.versions ?? 1} versions, ${c.responseMode ?? "best_worst"}${c.anchored ? ", anchored" : ""}${c.practiceTask ? ", practice task" : ""}${pairs.length ? `, prohibited ${pairs.map((p) => `${p[0]}/${p[1]}`).join(", ")}` : ""}${c.bestLabel || c.worstLabel ? `, labels ${c.bestLabel ?? "Most"}/${c.worstLabel ?? "Least"}` : ""}`;
  }
  if (d.kind === "menu") return `${q.code} menu-based conjoint [design ${d.name}, v${d.version}]: ${((c.items as { name: string; levels: string[] }[]) ?? []).map((i) => `${i.name} (${i.levels.join("/")})`).join("; ")}, ${c.tasks ?? 8} tasks, ${c.versions ?? 1} versions${c.noneOption === false ? "" : ", buy-nothing offered"}${Array.isArray(c.exclusiveGroups) && c.exclusiveGroups.length ? `; one-of sections ${(c.exclusiveGroups as string[]).join("; ")}` : ""}${((c.simulations as { name: string }[] | undefined) ?? []).length ? `; simulator scenarios: ${((c.simulations as { name: string }[]) ?? []).map((x) => x.name).join(", ")}` : ""}`;
  if (d.kind === "conjoint" || d.kind === "acbc" || d.kind === "cva") {
    const attrs = ((c.attributes as { name: string; levels: string[] }[]) ?? []).map((x) => `${x.name} (${x.levels.join("/")})`).join("; ");
    const pros = ((c.prohibitions as { a: LevelRef; b: LevelRef; when?: unknown }[] | undefined) ?? []).map((p) => (p.when ? "a combination rule" : `${p.a.attribute} ${p.a.level} × ${p.b.attribute} ${p.b.level}`));
    const sims = ((c.simulations as { name: string }[] | undefined) ?? []).map((x) => x.name);
    const simTail = sims.length ? `; simulator scenarios: ${sims.join(", ")}` : "";
    if (d.kind === "cva") return `${q.code} rating-based conjoint (CVA) [design ${d.name}, v${d.version}, seed ${d.seed}]: ${attrs}; ${c.mode === "paired" ? "pairs" : "profiles"} ${c.profiles ?? "auto"}, ${c.versions ?? 1} versions, scale ${c.scaleMin ?? (c.mode === "paired" ? 1 : 0)}–${c.scaleMax ?? (c.mode === "paired" ? 9 : 10)}${pros.length ? `; prohibited ${pros.join(", ")}` : ""}${simTail}`;
    return d.kind === "acbc"
      ? `${q.code} ACBC [design ${d.name}, v${d.version}]: ${attrs}${c.priceBase != null ? `; summed price base ${c.priceBase}, increments ${((c.priceIncrements as string[]) ?? []).join(" / ")}` : ""}${pros.length ? `; prohibited ${pros.join(", ")}` : ""}${simTail}`
      : `${q.code} CBC [design ${d.name}, v${d.version}, seed ${d.seed}]: ${attrs}; ${c.alternativesPerTask ?? 3} alternatives${c.noneOption ? " + None" : ""}${c.dualResponseNone ? " + dual-response None" : ""}, ${c.tasks ?? 10} tasks, ${c.versions ?? 1} versions, ${c.method ?? "balanced"}${c.labelled ? `, labelled by ${c.brandAttribute ?? "brand"}` : ""}${Array.isArray(c.alternativeSpecific) && c.alternativeSpecific.length ? `, brand-specific ${(c.alternativeSpecific as string[]).join("; ")}` : ""}${pros.length ? `; prohibited ${pros.join(", ")}` : ""}${simTail}`;
  }
  return `${q.code} [design ${d.name}, ${d.kind}]`;
}

/** Changes-panel lines for the designs */
export function designDiff(before: SurveyDefinition, after: SurveyDefinition): string[] {
  const out: string[] = [];
  const b = new Map((before.designs ?? []).map((d) => [d.id, d]));
  const a = new Map((after.designs ?? []).map((d) => [d.id, d]));
  for (const d of after.designs ?? []) if (!b.has(d.id)) out.push(`Add design “${d.name}” (${LABEL[d.kind] ?? d.kind}, ${d.file?.rows?.length ?? 0} rows)`);
  for (const d of before.designs ?? []) if (!a.has(d.id)) out.push(`Remove design “${d.name}”`);
  for (const d of after.designs ?? []) {
    const p = b.get(d.id);
    if (!p) continue;
    if (JSON.stringify(p.file?.rows ?? []) !== JSON.stringify(d.file?.rows ?? [])) out.push(`Regenerate design “${d.name}” (v${d.version})`);
    else if (JSON.stringify(p.config) !== JSON.stringify(d.config)) out.push(`Change design “${d.name}” settings`);
  }
  return out;
}
