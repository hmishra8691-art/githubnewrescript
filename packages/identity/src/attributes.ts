/**
 * WHO THIS RESPONDENT IS, AND WHEN WE KNOW IT.
 *
 * A quota cell can only count somebody if it knows their attributes, and those arrive twice:
 *
 *   CLAIMED   at the door, from the vendor's URL parameters. It is all there is at admission, and admission
 *             is the only moment at which turning somebody away is cheap — thirty seconds against the twenty
 *             minutes of a survey they will be owed an incentive for either way.
 *   OBSERVED  during the survey, from the screener answers. This is the truth, and it is what the completion
 *             is counted against.
 *
 * ## Why this lives in `identity` and not in `recruitment`
 *
 * The runtime is what respondents touch, and it has to resolve these attributes at the door. If it reached
 * for them in `recruitment` it would take a dependency on the package that also holds CPI, margins, vendor
 * adapters and commercial terms — putting the supply chain one import away from the code that decides whether
 * to let somebody in. That is the boundary dependency-boundaries.mjs exists to hold: this package resolves
 * WHO a respondent is and must not be able to see what they are WORTH. Resolving a demographic from a URL
 * parameter is squarely the first thing and squarely not the second, so it belongs here, and like the rest of
 * this package it imports nothing from the repository at all.
 *
 * ## The mapping is declared, never guessed
 *
 * One vendor sends `?gender=m`, another `?g=1`, another `?sex=Male`. There is no rule that reads all three,
 * and inventing one is how a project counts every man as a woman for a week before anybody notices. The
 * mapping from a vendor's parameter names and values is configuration; a parameter nobody has mapped produces
 * no attribute at all.
 *
 * ## An unknown attribute ADMITS
 *
 * If the mapping cannot tell which cell somebody belongs to, they are let in. The alternative is refusing
 * people a full cell cannot be proven to contain, which turns away valid respondents on a configuration gap
 * — and the quota is still protected, because the completion is counted against what the survey observed.
 *
 * ## What is NOT here, and where it went
 *
 * The merge, the disagreement and the hold correction used to live in this file. They are arithmetic over a
 * claim and an observation, and at the moment that arithmetic matters — a respondent finishing — the claim is
 * on the hold row in the database and the observation has just arrived there. Doing it here would mean
 * reading the hold back across the wire on the save path to recompute what one statement can already see, and
 * doing it in both places would mean two implementations of the same judgement, drifting. So it is done once,
 * in `rescript_quota_complete_session` (migration 0089), under the lock that makes it correct when two people
 * finish at the same instant. This file resolves vocabulary; the database does the arithmetic.
 */

export type Attributes = Record<string, string>;

export interface ParamMapping {
  /** the quota criterion this parameter feeds — "gender", "ageBand", … */
  criterion: string;
  /**
   * Vendor value → criterion value, lower-cased on both sides when matched. A value absent from here is
   * UNMAPPED and produces nothing, rather than being passed through: `?gender=1` passed through would create
   * an attribute of "1" that matches no cell and silently looks like a respondent with no gender.
   */
  values?: Record<string, string>;
  /** when the vendor sends a number — age 29 — the band it falls into */
  bands?: Array<{ min?: number; max?: number; value: string }>;
}

/** Keyed by the vendor's parameter name, as it arrives in the URL. */
export type QuotaMapping = Record<string, ParamMapping>;

export interface ResolvedAttributes {
  attributes: Attributes;
  /** parameters that arrived with no mapping — worth surfacing, because somebody configured a link for them */
  unmapped: string[];
  /** parameters that are mapped but whose VALUE is not — the configuration gap that admits people silently */
  unknownValues: Array<{ param: string; value: string }>;
}

const clean = (v: string) => v.trim().toLowerCase();

function bandFor(raw: string, bands: ParamMapping["bands"]): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || !bands?.length) return null;
  for (const b of bands) {
    if ((b.min === undefined || n >= b.min) && (b.max === undefined || n <= b.max)) return b.value;
  }
  return null;
}

/**
 * What the vendor claims, read through the declared mapping.
 *
 * Nothing is inferred. A parameter with no mapping, or a mapped parameter with an unlisted value, contributes
 * no attribute — and is reported, because both are configuration somebody needs to finish.
 */
export function claimedAttributes(params: Readonly<Record<string, string>>, mapping: QuotaMapping): ResolvedAttributes {
  const attributes: Attributes = {};
  const unmapped: string[] = [];
  const unknownValues: Array<{ param: string; value: string }> = [];

  for (const [param, raw] of Object.entries(params ?? {})) {
    const map = mapping?.[param] ?? mapping?.[param.toLowerCase()];
    if (!map) {
      /* pid, session and the redirect machinery are not demographics; only report what looks like targeting */
      if (!/^(pid|rid|sid|session|uid|tid|status|hash|sig|ts|token)$/i.test(param)) unmapped.push(param);
      continue;
    }
    const value = clean(String(raw));
    const banded = map.bands ? bandFor(value, map.bands) : null;
    const mapped = banded ?? map.values?.[value] ?? map.values?.[String(raw)] ?? null;
    if (mapped === null) { unknownValues.push({ param, value: String(raw).slice(0, 60) }); continue; }
    attributes[map.criterion] = mapped;
  }

  return { attributes, unmapped: unmapped.sort(), unknownValues };
}

export interface ScreenerAnswer {
  /** the screener's id, which the mapping keys on */
  id: string;
  answer: string;
}

/**
 * What the survey observed. The same declared mapping, keyed on the screener id rather than a URL parameter.
 *
 * This is the authoritative version: a respondent who answered the question is better evidence about
 * themselves than the panel's record of them.
 */
export function observedAttributes(answers: readonly ScreenerAnswer[], mapping: QuotaMapping): ResolvedAttributes {
  const asParams: Record<string, string> = {};
  for (const a of answers ?? []) if (a?.id) asParams[a.id] = String(a.answer ?? "");
  return claimedAttributes(asParams, mapping);
}

export interface MappingCheck {
  ok: boolean;
  mapping: QuotaMapping;
  /** what is wrong, in words an administrator can act on. Every problem, not the first. */
  problems: string[];
}

/**
 * Validate a mapping somebody has typed or pasted.
 *
 * Rejects rather than repairs. A mapping is the single declaration standing between a vendor's shorthand and
 * a quota cell, so a half-understood one is worse than none: it resolves some respondents and silently drops
 * the rest. Every problem is reported together, because an administrator fixing one at a time through a form
 * is how a mapping takes four attempts to save.
 */
export function parseQuotaMapping(raw: unknown): MappingCheck {
  const problems: string[] = [];
  const mapping: QuotaMapping = {};

  if (raw === null || raw === undefined) return { ok: true, mapping, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, mapping, problems: ["The mapping must be an object keyed by the vendor's parameter name."] };
  }

  for (const [param, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/.test(param)) {
      problems.push(`"${param.slice(0, 40)}" is not a URL parameter name.`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`"${param}" must map to { criterion, values?, bands? }.`);
      continue;
    }
    const v = value as Record<string, unknown>;
    const criterion = typeof v.criterion === "string" ? v.criterion.trim() : "";
    if (!criterion) { problems.push(`"${param}" does not say which quota criterion it feeds.`); continue; }

    const entry: ParamMapping = { criterion };

    if (v.values !== undefined) {
      if (!v.values || typeof v.values !== "object" || Array.isArray(v.values)) {
        problems.push(`"${param}".values must be an object of vendor value → criterion value.`);
        continue;
      }
      const values: Record<string, string> = {};
      for (const [from, to] of Object.entries(v.values as Record<string, unknown>)) {
        if (typeof to !== "string" || !to.trim()) { problems.push(`"${param}".values["${from}"] has no criterion value.`); continue; }
        values[clean(from)] = to.trim();
      }
      entry.values = values;
    }

    if (v.bands !== undefined) {
      if (!Array.isArray(v.bands)) { problems.push(`"${param}".bands must be a list.`); continue; }
      const bands: NonNullable<ParamMapping["bands"]> = [];
      for (const b of v.bands as unknown[]) {
        const o = (b ?? {}) as Record<string, unknown>;
        const band: { min?: number; max?: number; value: string } = { value: typeof o.value === "string" ? o.value.trim() : "" };
        if (!band.value) { problems.push(`"${param}" has a band with no value.`); continue; }
        if (o.min !== undefined) { if (typeof o.min !== "number" || !Number.isFinite(o.min)) { problems.push(`"${param}" band "${band.value}" has a min that is not a number.`); continue; } band.min = o.min; }
        if (o.max !== undefined) { if (typeof o.max !== "number" || !Number.isFinite(o.max)) { problems.push(`"${param}" band "${band.value}" has a max that is not a number.`); continue; } band.max = o.max; }
        if (band.min === undefined && band.max === undefined) { problems.push(`"${param}" band "${band.value}" is unbounded at both ends and would swallow every age.`); continue; }
        if (band.min !== undefined && band.max !== undefined && band.min > band.max) { problems.push(`"${param}" band "${band.value}" runs from ${band.min} to ${band.max}.`); continue; }
        bands.push(band);
      }
      entry.bands = bands;
    }

    if (!entry.values && !entry.bands) {
      problems.push(`"${param}" declares a criterion but no values or bands, so it can never resolve anything.`);
      continue;
    }
    mapping[param] = entry;
  }

  return { ok: problems.length === 0, mapping, problems };
}
