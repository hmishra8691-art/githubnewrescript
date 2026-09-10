/**
 * Menu-Based Conjoint (MBC) design generator.
 *
 * ## What a menu task is
 *
 * Instead of choosing ONE concept from a set (CBC), the respondent builds
 * their own bundle: every item on the menu carries a price that varies from
 * task to task, and they tick whichever items they would buy at those
 * prices — including none. The data are per-item purchase decisions under
 * varying own- and cross-prices, which is what a pricing study of a
 * configurable product actually needs (base + add-ons, à-la-carte menus,
 * subscription tiers with extras).
 *
 * ## The design
 *
 * A design row is one ITEM on one TASK with one PRICE: `version, task, item,
 * item_label, price, price_index, price_value, required`. Every item appears
 * on every task (a menu is a menu); what varies is the price level, chosen
 * by the same one-way frequency balancing CBC uses so every price point of
 * every item is shown equally often across the design, with seeded-RNG
 * tie-breaking. Two tasks in one version never show the identical price
 * vector (bounded redraws, then a forced perturbation).
 *
 * `required` items (a base product) appear pre-selected and cannot be
 * un-ticked; their price still varies, so the total varies, and the
 * respondent's decision is about the add-ons at each base price.
 *
 * ## Pricing configurator
 *
 * The "Pricing / Configurator Choice" exercise is this generator with one
 * required item and add-ons — a preset in the variant catalogue, not a second
 * generator. Deterministic given (config, seed), like every design here.
 */
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { mulberry32, subSeed } from "@rescript/engine";

export interface MenuItem {
  /** shown to the respondent */
  name: string;
  /** price points, as shown ("$4.99", "₹199", "free") — the numeric part is parsed for totals */
  levels: string[];
  /** always in the bundle (a base product) — pre-selected, cannot be removed */
  required?: boolean;
}

export interface MenuConfig {
  /** the menu: items with their price points (edited with the attributes editor) */
  items: MenuItem[];
  /** names of items that are always included — the configurator's base product */
  requiredItems?: string[];
  /** tasks per version; default 8 */
  tasks?: number;
  /** design versions (blocks); default 1 */
  versions?: number;
  /** offer "I would buy nothing from this menu"; default true */
  noneOption?: boolean;
  /** fewest items a respondent must pick per task (0 = none); default 0 */
  minSelections?: number;
  /** most items a respondent may pick per task (0 = no cap); default 0 */
  maxSelections?: number;
  /** currency symbol shown before the running total; default from the first price with a symbol, else "" */
  currency?: string;
}

interface Normalized {
  items: MenuItem[];
  tasks: number;
  versions: number;
  noneOption: boolean;
  minSelections: number;
  maxSelections: number;
  currency: string;
}

const MAX_REDRAWS = 40;

function normalize(config: MenuConfig): Normalized {
  const required = new Set(config.requiredItems ?? []);
  const items = (config.items ?? []).map((it) => ({ ...it, required: it.required || required.has(it.name) }));
  return {
    items,
    tasks: config.tasks ?? 8,
    versions: config.versions ?? 1,
    noneOption: config.noneOption ?? true,
    minSelections: config.minSelections ?? 0,
    maxSelections: config.maxSelections ?? 0,
    currency: config.currency ?? detectCurrency(items),
  };
}

/** The numeric part of a price label: "$4.99" → 4.99, "₹1,299" → 1299, "free" → 0, "n/a" → NaN. */
export function priceValue(label: string): number {
  const s = String(label ?? "").trim().toLowerCase();
  if (!s) return NaN;
  if (/^(free|included|incl\.?|0)$/.test(s)) return 0;
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function detectCurrency(items: MenuItem[]): string {
  for (const it of items) for (const l of it.levels) {
    const m = String(l).trim().match(/^([^\d\s.,-]+)/);
    if (m) return m[1];
  }
  return "";
}

function pickBalanced(levels: string[], counts: Map<string, number>, rng: () => number): string {
  let min = Infinity;
  for (const l of levels) min = Math.min(min, counts.get(l) ?? 0);
  const cands = levels.filter((l) => (counts.get(l) ?? 0) === min);
  return cands[Math.floor(rng() * cands.length)];
}

export const menuPlugin: DesignGeneratorPlugin<MenuConfig> = {
  kind: "menu",
  label: "Menu-Based Conjoint (MBC)",
  description:
    "Every task shows the whole menu with prices that vary; respondents tick what they would buy. Price points are frequency-balanced per item; no two tasks in a version repeat the same price vector. Required items make it a pricing configurator.",
  configFields: [
    {
      name: "items",
      label: "Menu items & price points",
      type: "attributes",
      help: "Each item needs at least 2 price points, written as shown to respondents ($4.99, ₹199, free). The number is parsed for the running total.",
    },
    {
      name: "requiredItems",
      label: "Always-included items (base product)",
      type: "list",
      help: "Item names, one per line. Pre-selected and cannot be removed; their price still varies. This is what makes a pricing configurator.",
    },
    { name: "tasks", label: "Tasks per version", type: "number", default: 8 },
    { name: "versions", label: "Versions (blocks)", type: "number", default: 1 },
    { name: "noneOption", label: "Offer “I would buy nothing”", type: "boolean", default: true },
    { name: "minSelections", label: "Minimum items per task (0 = none)", type: "number", default: 0 },
    { name: "maxSelections", label: "Maximum items per task (0 = no cap)", type: "number", default: 0 },
    { name: "currency", label: "Currency symbol for the total (blank = detect)", type: "text" },
  ],

  validateConfig(config: MenuConfig): string[] {
    const errors: string[] = [];
    const c = normalize(config);
    if (c.items.length < 2) errors.push("A menu needs at least 2 items.");
    for (const it of c.items) {
      if (!it.name?.trim()) errors.push("Every item needs a name.");
      if (!it.levels || it.levels.length < 2) errors.push(`Item "${it.name ?? "?"}" needs at least 2 price points (a single price cannot be estimated).`);
      for (const l of it.levels ?? []) {
        if (Number.isNaN(priceValue(l))) errors.push(`Price "${l}" (${it.name}) has no number in it — write it as $4.99, 199 or free.`);
      }
    }
    const names = c.items.map((i) => i.name);
    if (new Set(names).size !== names.length) errors.push("Item names must be unique.");
    for (const r of config.requiredItems ?? []) {
      if (!names.includes(r)) errors.push(`Always-included item "${r}" is not on the menu.`);
    }
    if (c.items.length && c.items.every((i) => i.required)) errors.push("Every item is always included — there is nothing left to choose.");
    if (c.tasks < 1) errors.push("tasks must be at least 1.");
    if (c.versions < 1) errors.push("versions must be at least 1.");
    if (c.minSelections < 0 || c.maxSelections < 0) errors.push("Selection limits cannot be negative.");
    if (c.maxSelections && c.minSelections > c.maxSelections) errors.push("Minimum items is above the maximum.");
    const optional = c.items.filter((i) => !i.required).length;
    if (c.maxSelections && c.maxSelections < c.items.filter((i) => i.required).length) errors.push("The maximum is below the number of always-included items.");
    if (c.minSelections > c.items.length) errors.push(`Minimum items (${c.minSelections}) is more than the menu has (${c.items.length}).`);
    void optional;
    /* the design must be able to avoid repeating a price vector */
    const vectors = c.items.reduce((n, i) => n * Math.max(1, (i.levels ?? []).length), 1);
    if (errors.length === 0 && vectors < c.tasks) {
      errors.push(`Only ${vectors} distinct price combinations exist, but each version has ${c.tasks} tasks that must differ. Add price points or reduce tasks.`);
    }
    return errors;
  },

  generate(config: MenuConfig, seed: number) {
    const problems = menuPlugin.validateConfig!(config);
    if (problems.length) throw new Error(problems[0]);
    const c = normalize(config);
    const columns = ["version", "task", "item", "item_label", "price", "price_index", "price_value", "required"];
    const rows: Record<string, unknown>[] = [];
    const counts = new Map<string, Map<string, number>>();
    for (const it of c.items) counts.set(it.name, new Map(it.levels.map((l) => [l, 0])));

    for (let version = 1; version <= c.versions; version++) {
      const seen = new Set<string>();
      for (let task = 1; task <= c.tasks; task++) {
        const rng = mulberry32(subSeed(seed, `menu:v${version}:t${task}`));
        let prices: string[] = [];
        let key = "";
        let ok = false;
        for (let attempt = 0; attempt <= MAX_REDRAWS; attempt++) {
          prices = c.items.map((it) => pickBalanced(it.levels, counts.get(it.name)!, rng));
          key = prices.join("");
          if (!seen.has(key)) { ok = true; break; }
        }
        if (!ok) {
          // force a different vector: bump one item's price to its next level
          outer: for (let i = 0; i < c.items.length; i++) {
            for (const l of c.items[i].levels) {
              if (l === prices[i]) continue;
              const trial = [...prices]; trial[i] = l;
              const k = trial.join("");
              if (!seen.has(k)) { prices = trial; key = k; ok = true; break outer; }
            }
          }
        }
        seen.add(key);
        c.items.forEach((it, i) => {
          const price = prices[i];
          counts.get(it.name)!.set(price, (counts.get(it.name)!.get(price) ?? 0) + 1);
          rows.push({
            version, task, item: i + 1, item_label: it.name, price,
            price_index: it.levels.indexOf(price) + 1,
            price_value: priceValue(price),
            required: it.required ? 1 : 0,
          });
        });
      }
    }

    const summary: Record<string, unknown> = {
      items: c.items.length,
      tasks: c.tasks,
      versions: c.versions,
      noneOption: c.noneOption,
      minSelections: c.minSelections,
      maxSelections: c.maxSelections,
      currency: c.currency,
      requiredItems: c.items.filter((i) => i.required).map((i) => i.name),
      priceFrequencies: Object.fromEntries(c.items.map((it) => [it.name, Object.fromEntries(counts.get(it.name)!)])),
    };
    return { columns, rows, summary };
  },
};

/** The menu for one task of one version, in item order, from design rows. */
export function menuTaskItems(rows: Record<string, unknown>[], version: string, task: string) {
  return rows
    .filter((r) => String(r.version ?? "1") === version && String(r.task) === task)
    .sort((a, b) => Number(a.item) - Number(b.item))
    .map((r) => ({
      item: String(r.item),
      label: String(r.item_label ?? r.item),
      price: String(r.price ?? ""),
      priceValue: Number(r.price_value),
      required: Number(r.required) === 1,
    }));
}

/** The bundle total for a set of chosen item indices (required items always count). */
export function menuTotal(items: ReturnType<typeof menuTaskItems>, chosen: string[]): number {
  return items.reduce((sum, it) => (it.required || chosen.includes(it.item)) && Number.isFinite(it.priceValue) ? sum + it.priceValue : sum, 0);
}
