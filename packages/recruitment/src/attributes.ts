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
 * ## Disagreement is a vendor quality signal
 *
 * The vendor said male 25–34; the screener says female 55+. One of them is wrong, and which one matters
 * commercially: a vendor whose demographic claims do not survive contact with the questions is selling sample
 * it has mis-described. `attributeConflicts` names each disagreement so it can be counted against them.
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

/**
 * The attributes to count a completion against: observed where the survey asked, claimed where it did not.
 *
 * The survey wins every contest. It asked the person directly; the vendor is repeating what its own records
 * said, possibly from a profile filled in three years ago.
 */
export function mergeAttributes(claimed: Attributes, observed: Attributes): Attributes {
  return { ...claimed, ...observed };
}

export interface AttributeConflict {
  criterion: string;
  claimed: string;
  observed: string;
}

/**
 * Where the vendor's claim and the survey's answer disagree.
 *
 * Only where BOTH have a value: a criterion the survey did not ask about is not a disagreement, and counting
 * it as one would make every vendor look like a liar for the questions nobody asked.
 */
export function attributeConflicts(claimed: Attributes, observed: Attributes): AttributeConflict[] {
  const out: AttributeConflict[] = [];
  for (const [criterion, observedValue] of Object.entries(observed)) {
    const claimedValue = claimed[criterion];
    if (claimedValue !== undefined && claimedValue !== observedValue) {
      out.push({ criterion, claimed: claimedValue, observed: observedValue });
    }
  }
  return out.sort((a, b) => a.criterion.localeCompare(b.criterion));
}

/**
 * The slots to release and the slots to fill, when a completion's observed attributes differ from the claimed
 * ones it was admitted on.
 *
 * Without this a mismatch leaks a held slot for ever: the hold was taken on `{gender: male}` at the door, the
 * completion counts into `{gender: female}`, and the male cell holds a slot for somebody who finished as
 * somebody else. Over a long field period that quietly closes a cell that is not full.
 */
export function holdCorrection(claimed: Attributes, observed: Attributes): { release: Attributes; count: Attributes } {
  return { release: claimed, count: mergeAttributes(claimed, observed) };
}
