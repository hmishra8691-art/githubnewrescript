import { AudienceSpecification, type SurveyDefinition } from "@rescript/schema";

/**
 * RECRUITMENT ACTIONS (2026-11-03) — what Intelligent Mode may do to a study's AUDIENCE.
 *
 *   define_audience   "US adults 25–45 who have bought a car in the last year, half men half women"
 *                     → a structured `definition.audience` the researcher can read, correct and price against
 *   clear_audience    removes it (destructive: it is confirmed)
 *
 * The audience is the one part of recruitment that belongs on the definition rather than in the exchange's own
 * tables, because it is a property of the STUDY: it is versioned with it, cloned with it, and undone with it.
 * Everything else about recruitment — what a vendor costs, what was ordered, what was spent — belongs to the
 * organisation and lives in migrations 0081/0082.
 *
 * ## Why this is a structured action and not a prompt
 *
 * A model asked for an audience in prose will happily produce one. The problem is that nobody can check it: "US
 * adults 25–45" and "US adults 25–44" differ by a year that costs real money, and prose hides the difference.
 * So the model's output is coerced into `AudienceSpecification`, every field is validated, anything that cannot
 * be mapped is REPORTED rather than dropped, and the result goes through the existing gate and preview diff like
 * any other change. The researcher approves a specification, not a sentence.
 *
 * Nothing here calls a model. `coerceRecruitmentAction` takes whatever the copilot produced and turns it into a
 * typed action or an error string; the model call itself is the copilot's, through the usual guard and budget.
 */

export const RECRUITMENT_ACTION_OPS = ["define_audience", "clear_audience"] as const;
export const isRecruitmentOp = (op: string): boolean => (RECRUITMENT_ACTION_OPS as readonly string[]).includes(op);

export interface DefineAudienceAction {
  op: "define_audience";
  audience: AudienceSpecification;
  /** what the researcher actually typed, kept so the structured form stays checkable against its source */
  from?: string;
  /** true to replace the existing audience outright rather than merge into it */
  replace?: boolean;
}
export interface ClearAudienceAction { op: "clear_audience" }
export type RecruitmentAction = DefineAudienceAction | ClearAudienceAction;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** ISO-3166 alpha-2, plus the handful of names a researcher actually types. Unknown names are reported, not guessed. */
const COUNTRY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "united states": "US", usa: "US", "u.s.": "US", "u.s.a.": "US", america: "US",
  "united kingdom": "GB", uk: "GB", britain: "GB", "great britain": "GB", england: "GB",
  germany: "DE", deutschland: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL",
  canada: "CA", australia: "AU", "new zealand": "NZ", ireland: "IE",
  india: "IN", japan: "JP", china: "CN", singapore: "SG", "hong kong": "HK",
  brazil: "BR", mexico: "MX", "south africa": "ZA", nigeria: "NG",
  sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", poland: "PL", "united arab emirates": "AE",
});

/**
 * A country as its alpha-2 code, or null when it is not recognised — never a guess.
 *
 * The word table is consulted BEFORE the two-letter shape, because "uk" is both. It looks like a code and it is
 * not one: the ISO alpha-2 for the United Kingdom is GB, and a rate card keyed on "UK" matches nothing, prices
 * nothing, and sends a researcher looking for a vendor problem that does not exist.
 */
export function countryCode(v: unknown): string | null {
  const s = str(v, 60);
  if (!s) return null;
  const word = COUNTRY_WORDS[s.toLowerCase()];
  if (word) return word;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return null;
}

/**
 * Coerce whatever the copilot produced into a typed action.
 *
 * Returns the action, or a string naming what is wrong, or null when the op is not one of ours. Unrecognised
 * countries come back as an error listing them: an audience quietly missing a market is an audience that
 * under-buys, and the researcher finds out when the field report is short.
 */
export function coerceRecruitmentAction(op: string, o: Record<string, unknown>): RecruitmentAction | string | null {
  if (!isRecruitmentOp(op)) return null;
  if (op === "clear_audience") return { op: "clear_audience" };

  const raw = (o.audience ?? o.spec ?? o) as Record<string, unknown>;
  const demographics = (raw.demographics ?? {}) as Record<string, unknown>;

  // countries may arrive as codes, names, or a comma-separated string
  const given = Array.isArray(demographics.countries) ? demographics.countries
    : typeof demographics.countries === "string" ? demographics.countries.split(",")
    : Array.isArray(o.countries) ? o.countries
    : typeof o.countries === "string" ? (o.countries as string).split(",")
    : [];
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const c of given) {
    const code = countryCode(c);
    if (code) { if (!codes.includes(code)) codes.push(code); }
    else { const s = str(c, 60); if (s) unknown.push(s); }
  }
  if (unknown.length) {
    return `define_audience: I do not recognise ${unknown.map((u) => `“${u}”`).join(", ")} as a country. Use the two-letter code (US, GB, DE).`;
  }

  const parsed = AudienceSpecification.safeParse({
    ...raw,
    demographics: { ...demographics, countries: codes },
    ...(typeof o.from === "string" ? { naturalLanguage: str(o.from, 4000) } : {}),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return `define_audience: ${first ? `${first.path.join(".") || "audience"} — ${first.message}` : "the audience specification is not valid"}`;
  }
  if (!parsed.data.demographics.countries.length) {
    return "define_audience: which country or countries should this study recruit in?";
  }

  return {
    op: "define_audience",
    audience: parsed.data,
    ...(typeof o.from === "string" && o.from ? { from: str(o.from, 4000) } : {}),
    ...(o.replace === true ? { replace: true } : {}),
  };
}

/**
 * Merge one section of an audience, keeping a filter the incoming spec did not mention.
 *
 * A plain spread cannot do this. `AudienceSpecification` gives every list a default of `[]`, so by the time the
 * model's output has been parsed, "the researcher did not mention income" and "the researcher wants no income
 * filter" are the same empty array — and spreading it over the existing audience silently removes a filter they
 * are still paying for. So an empty list never overwrites a populated one, and an absent scalar never overwrites
 * a set one. Removing a filter is what `replace` is for, and it is asked for explicitly.
 */
function mergeSection<T extends Record<string, unknown>>(before: T, after: T): T {
  const out: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(after)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) { if (v.length) out[k] = v; continue; }
    out[k] = v;
  }
  return out as T;
}

export interface RecruitmentApplied { description: string; warnings: string[]; touched: string[]; destructive?: string }

export function applyRecruitmentAction(def: SurveyDefinition, a: RecruitmentAction): RecruitmentApplied {
  if (a.op === "clear_audience") {
    if (!def.audience) throw new Error("this study has no audience to clear");
    delete def.audience;
    return {
      description: "Clear the study's audience",
      warnings: ["Recruitment projects already created keep the audience they were created with."],
      touched: [],
      destructive: "removes the audience specification this study recruits against",
    };
  }

  const before = def.audience;
  /*
   * Merge rather than replace by default. A researcher refining an audience ("also make it 50/50 men and women")
   * means to ADD a constraint, and a model that silently dropped their income band because this turn did not
   * mention it would be removing a filter they are still paying for.
   */
  const merged: AudienceSpecification = a.replace || !before ? a.audience : {
    ...before,
    ...a.audience,
    version: (before.version ?? 1) + 1,
    demographics: mergeSection(before.demographics, a.audience.demographics),
    advanced: mergeSection(before.advanced, a.audience.advanced),
    screeners: a.audience.screeners.length ? a.audience.screeners : before.screeners,
    quotas: a.audience.quotas.length ? a.audience.quotas : before.quotas,
  };
  def.audience = merged;

  const warnings: string[] = [];
  if (before && !a.replace) warnings.push("This was merged into the existing audience. Say “replace the audience” to start from scratch.");
  if (merged.quotas.length) {
    const pct = merged.quotas.filter((q) => q.mode === "percent").reduce((s, q) => s + q.target, 0);
    if (pct > 100.001) warnings.push(`The quota shares add up to ${Math.round(pct)}%, which cannot be filled.`);
  }
  if (merged.demographics.countries.length > 1) {
    warnings.push(`${merged.demographics.countries.length} markets: set a completes target for each in Fieldwork → Recruitment, or the whole study is priced against ${merged.demographics.countries[0]}.`);
  }

  return { description: `${before ? "Refine" : "Define"} the audience: ${audienceWords(merged)}`, warnings, touched: [] };
}

export function describeRecruitmentAction(a: RecruitmentAction): string {
  return a.op === "clear_audience" ? "Clear the study's audience" : `Define the audience: ${audienceWords(a.audience)}`;
}

/** The audience as a short phrase, for a diff line or a change list. Deliberately the facts, in order. */
export function audienceWords(a: AudienceSpecification | undefined): string {
  if (!a) return "none";
  const d = a.demographics;
  const bits: string[] = [];
  if (d.countries.length) bits.push(d.countries.join(", "));
  if (d.ageMin !== undefined || d.ageMax !== undefined) bits.push(`aged ${d.ageMin ?? "any"}–${d.ageMax ?? "any"}`);
  const genders = d.genders.filter((g) => g !== "any");
  if (genders.length) bits.push(genders.join(" and "));
  for (const [label, list] of [["income", d.incomeBands], ["education", d.education], ["employment", d.employment]] as const) {
    if (list.length) bits.push(`${label}: ${list.slice(0, 3).join(", ")}${list.length > 3 ? "…" : ""}`);
  }
  const adv = a.advanced;
  for (const [label, list] of [["industry", adv.industries], ["job title", adv.jobTitles], ["owns", adv.productOwnership], ["uses", adv.brandUsage]] as const) {
    if (list.length) bits.push(`${label}: ${list.slice(0, 3).join(", ")}${list.length > 3 ? "…" : ""}`);
  }
  if (a.screeners.length) bits.push(`${a.screeners.length} screener${a.screeners.length === 1 ? "" : "s"}`);
  if (a.quotas.length) bits.push(`${a.quotas.length} quota cell${a.quotas.length === 1 ? "" : "s"}`);
  return bits.length ? bits.join("; ") : "no criteria yet";
}

export function recruitmentDiff(before: SurveyDefinition, after: SurveyDefinition): string[] {
  const b = JSON.stringify(before.audience ?? null);
  const a = JSON.stringify(after.audience ?? null);
  if (b === a) return [];
  if (!after.audience) return ["Clear the study's audience"];
  return [`${before.audience ? "Refine" : "Define"} the audience (${audienceWords(after.audience)})`];
}
