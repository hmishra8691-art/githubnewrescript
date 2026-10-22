/**
 * ALTERNATIVE-SPECIFIC (BRAND-SPECIFIC) AND LABELLED CBC — F4, 2026-10-22.
 *
 * A generic CBC gives every concept every attribute. Real categories are not
 * like that: a "5G" attribute applies to the phone brands that sell 5G models,
 * a "subscription length" only to the subscription plan, and a premium brand's
 * prices live in a different range from a value brand's. Conjointly calls this
 * brand-specific conjoint, Sawtooth alternative-specific designs.
 *
 *   brandAttribute       the attribute whose level decides what a concept carries (usually Brand)
 *   alternativeSpecific  rules "Attribute: BrandLevel, BrandLevel" — the attribute applies ONLY to
 *                        concepts of those brands; elsewhere its cell is "" (not applicable), shown
 *                        as "—", coded as zeros (it adds no utility) in every model
 *   labelled             every task shows each brand exactly once, in brand order (alternative k is
 *                        brand level k): a LABELLED design. Alternatives per task = brand levels.
 *
 * Brand-specific level ranges (a premium brand's prices) are separate attributes, each applying to
 * one brand ("Price (Alpha)", "Price (Beta)"); the respondent sees the brand's own price under its
 * own heading. Prohibitions, None, holdouts and versions work as in a generic design.
 *
 * A configuration without these settings never reaches this module, so every existing design
 * regenerates byte-identically (the conjoint-suite compat snapshot test).
 */
import { mulberry32, subSeed } from "@rescript/engine";

export interface AltSpecRule { attribute: string; appliesTo: string[] }
type Attr = { name: string; levels: string[] };
type Profile = Record<string, string>;

/** "Storage: Alpha, Beta" / "Storage = Alpha | Beta" / {attribute, appliesTo} → rules (blank lines ignored) */
export function parseAlternativeSpecific(v: unknown): AltSpecRule[] {
  if (!Array.isArray(v)) return [];
  const out: AltSpecRule[] = [];
  for (const x of v) {
    if (typeof x === "string") {
      const m = /^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/.exec(x);
      if (!m) continue;
      out.push({ attribute: m[1], appliesTo: m[2].split(/\s*[,|;]\s*/).map((s) => s.trim()).filter(Boolean) });
    } else if (x && typeof x === "object") {
      const o = x as { attribute?: unknown; appliesTo?: unknown };
      if (typeof o.attribute === "string" && Array.isArray(o.appliesTo)) out.push({ attribute: o.attribute, appliesTo: o.appliesTo.map(String) });
    }
  }
  return out;
}

export interface AltSpecConfig {
  brandAttribute?: string;
  labelled?: boolean;
  alternativeSpecific?: unknown[];
}

/** is this an alternative-specific or labelled design? (false for every generic configuration) */
export function isAlternativeSpecific(c: AltSpecConfig): boolean {
  return c.labelled === true || parseAlternativeSpecific(c.alternativeSpecific).length > 0;
}

/** the brand attribute: named, else the attribute called brand, else the first */
export function brandAttributeOf(c: AltSpecConfig & { attributes?: Attr[] }): string | undefined {
  const attrs = c.attributes ?? [];
  if (c.brandAttribute) return attrs.find((a) => a.name === c.brandAttribute)?.name ?? attrs.find((a) => a.name.toLowerCase() === c.brandAttribute!.toLowerCase())?.name ?? c.brandAttribute;
  return attrs.find((a) => /^brand|^make|^label|^provider|^operator/i.test(a.name))?.name ?? attrs[0]?.name;
}

/** attribute → the brand levels it applies to (absent = every brand) */
export function applicabilityOf(c: AltSpecConfig & { attributes?: Attr[] }): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of parseAlternativeSpecific(c.alternativeSpecific)) {
    const attr = (c.attributes ?? []).find((a) => a.name === r.attribute || a.name.toLowerCase() === r.attribute.toLowerCase());
    m.set(attr?.name ?? r.attribute, new Set(r.appliesTo));
  }
  return m;
}

/** does `attribute` apply to a concept of brand `brand`? */
export const appliesTo = (rules: Map<string, Set<string>>, attribute: string, brand: string): boolean => !rules.has(attribute) || rules.get(attribute)!.has(brand);

export function validateAltSpecific(c: AltSpecConfig & { attributes?: Attr[]; alternativesPerTask?: number }): string[] {
  if (!isAlternativeSpecific(c)) return [];
  const errors: string[] = [];
  const attrs = c.attributes ?? [];
  const brand = brandAttributeOf(c);
  const B = attrs.find((a) => a.name === brand);
  if (!B) return [`The brand attribute “${c.brandAttribute ?? "?"}” is not one of the attributes — alternative-specific and labelled designs need it.`];
  const rules = parseAlternativeSpecific(c.alternativeSpecific);
  for (const r of rules) {
    const a = attrs.find((x) => x.name === r.attribute || x.name.toLowerCase() === r.attribute.toLowerCase());
    if (!a) { errors.push(`Alternative-specific rule names “${r.attribute}”, which is not an attribute.`); continue; }
    if (a.name === B.name) errors.push(`The brand attribute (${B.name}) applies to every concept — it cannot be alternative-specific.`);
    if (!r.appliesTo.length) errors.push(`“${a.name}” applies to no brand — list the ${B.name} levels it applies to.`);
    for (const l of r.appliesTo) if (!B.levels.includes(l)) errors.push(`“${a.name}” applies to “${l}”, which is not a level of ${B.name} (${B.levels.join(", ")}).`);
  }
  const m = c.alternativesPerTask ?? 3;
  if (c.labelled === true && m !== B.levels.length) errors.push(`A labelled design shows each ${B.name} once per task, so alternatives per task must be ${B.levels.length} (it is ${m}).`);
  if (!errors.length) {
    const applic = applicabilityOf(c);
    const space = B.levels.reduce((t, b) => t + attrs.filter((a) => a.name !== B.name && appliesTo(applic, a.name, b)).reduce((n, a) => n * Math.max(1, a.levels.length), 1), 0);
    if (c.labelled !== true && space < m) errors.push(`These brand-specific attributes allow only ${space} different concepts, and each task needs ${m}.`);
  }
  return errors;
}

/** every legal alternative-specific concept (non-applicable cells ""), when the space is small enough */
export function enumerateAltSpecific(attrs: Attr[], brand: string, rules: Map<string, Set<string>>, violates: (p: Profile) => boolean, cap = 200_000): Profile[] | null {
  const B = attrs.find((a) => a.name === brand)!;
  const out: Profile[] = [];
  for (const b of B.levels) {
    let partial: Profile[] = [{ [brand]: b }];
    for (const a of attrs) {
      if (a.name === brand) continue;
      if (!appliesTo(rules, a.name, b)) { partial = partial.map((p) => ({ ...p, [a.name]: "" })); continue; }
      const next: Profile[] = [];
      for (const p of partial) for (const l of a.levels) next.push({ ...p, [a.name]: l });
      partial = next;
      if (partial.length + out.length > cap) return null;
    }
    out.push(...partial);
  }
  return out.filter((p) => !violates(p));
}

const SEP = "\u0001";

/**
 * Rows of an alternative-specific / labelled design, level-balanced over the concepts each level
 * can appear in. The same row shape as a generic design; a not-applicable cell is "".
 */
export function generateAltSpecificRows(
  c: { attributes: Attr[]; tasks: number; holdoutTasks: number; versions: number; alternativesPerTask: number; noneOption: boolean } & AltSpecConfig,
  seed: number,
  violates: (p: Profile) => boolean,
): { rows: Record<string, unknown>[]; levelCounts: Map<string, Map<string, number>>; legal: Profile[] | null } {
  const brand = brandAttributeOf(c)!;
  const B = c.attributes.find((a) => a.name === brand)!;
  const rules = applicabilityOf(c);
  const legal = enumerateAltSpecific(c.attributes, brand, rules, violates);
  const levelCounts = new Map<string, Map<string, number>>();
  for (const a of c.attributes) levelCounts.set(a.name, new Map(a.levels.map((l) => [l, 0])));
  const pick = (levels: string[], counts: Map<string, number>, rng: () => number) => {
    let min = Infinity;
    for (const l of levels) min = Math.min(min, counts.get(l) ?? 0);
    const cands = levels.filter((l) => (counts.get(l) ?? 0) === min);
    return cands[Math.floor(rng() * cands.length)];
  };
  const keyOf = (p: Profile) => c.attributes.map((a) => p[a.name] ?? "").join(SEP);
  const rows: Record<string, unknown>[] = [];
  const totalTasks = c.tasks + c.holdoutTasks;
  for (let version = 1; version <= c.versions; version++) {
    for (let task = 1; task <= totalTasks; task++) {
      const isHoldout = task > c.tasks;
      const rng = mulberry32(subSeed(seed, `conjoint:as:v${version}:t${task}`));
      const seen = new Set<string>();
      for (let alt = 1; alt <= c.alternativesPerTask; alt++) {
        let profile: Profile | null = null;
        for (let attempt = 0; attempt < 60 && !profile; attempt++) {
          const b = c.labelled ? B.levels[alt - 1] : pick(B.levels, levelCounts.get(brand)!, rng);
          const p: Profile = { [brand]: b };
          for (const a of c.attributes) {
            if (a.name === brand) continue;
            p[a.name] = appliesTo(rules, a.name, b) ? pick(a.levels, levelCounts.get(a.name)!, rng) : "";
          }
          if (!seen.has(keyOf(p)) && !violates(p)) profile = p;
        }
        if (!profile && legal) {
          const pool = c.labelled ? legal.filter((p) => p[brand] === B.levels[alt - 1]) : legal;
          const start = Math.floor(rng() * Math.max(1, pool.length));
          for (let k = 0; k < pool.length && !profile; k++) { const cand = pool[(start + k) % pool.length]; if (!seen.has(keyOf(cand))) profile = { ...cand }; }
        }
        if (!profile) throw new Error(`Task ${task} of version ${version} needs ${c.alternativesPerTask} different legal concepts, and these brand-specific attributes and prohibitions do not allow that many.`);
        seen.add(keyOf(profile));
        for (const a of c.attributes) { const v = profile[a.name]; if (v) levelCounts.get(a.name)!.set(v, (levelCounts.get(a.name)!.get(v) ?? 0) + 1); }
        rows.push({ version, task, alt, is_holdout: isHoldout ? 1 : 0, ...profile, none_option: 0 });
      }
      if (c.noneOption) {
        const noneRow: Record<string, unknown> = { version, task, alt: c.alternativesPerTask + 1, is_holdout: isHoldout ? 1 : 0, none_option: 1 };
        for (const a of c.attributes) noneRow[a.name] = "";
        rows.push(noneRow);
      }
    }
  }
  return { rows, levelCounts, legal };
}
