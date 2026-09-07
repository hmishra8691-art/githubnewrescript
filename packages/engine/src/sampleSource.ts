import type { SurveyDefinition } from "@rescript/schema";

/**
 * WHERE A RESPONDENT CAME FROM.
 *
 * A study is almost never fielded to one audience. It is bought from two or
 * three panels, sent to a client's own list, and posted in an app — and the
 * only question anyone asks about the resulting data is "how did each of them
 * do". Incidence by supplier decides who gets the next order; completion rate
 * by supplier decides who is sending bots; a screen-out rate that is fine
 * overall and catastrophic for one source is the single most common reason
 * fieldwork gets paused.
 *
 * None of that was answerable here, because the fact was never captured.
 * `responses.source` exists but means "runtime | import | manual" — how the
 * ROW arrived, not who supplied the person — so migration 0012 added
 * `responses.sample_source` and this file decides what goes in it.
 *
 * THE RULE. A supplier appends their own parameter to the link they are given:
 * one panel sends `?src=`, another `?source=`, a client's mail merge sends
 * `?panel=`. Rather than make the programmer configure that before the first
 * respondent arrives — which is the moment the value is unrecoverable — a
 * short list of the conventional names is accepted, and `deployment.sample`
 * overrides it when a supplier insists on something else.
 *
 * The value is recorded whether or not it was declared in `sample_sources`.
 * A typo in one supplier's link is a real interview with a provenance problem
 * and it must be visible as exactly that; rejecting it, or quietly dropping
 * the value, is how a fieldwork report comes out looking clean and wrong.
 */

/** Conventional parameter names for the supplier, most specific first. */
export const SOURCE_PARAM_ALIASES = [
  "src",
  "source",
  "sample_source",
  "supplier",
  "panel",
  "utm_source",
] as const;

/**
 * Conventional parameter names for the SUPPLIER'S OWN id for the person.
 *
 * This is what a reconciliation file is keyed on: a panel sends a list of the
 * respondent ids they billed for and asks which of them completed. Without it
 * the answer involves matching on timestamps.
 */
export const RESPONDENT_PARAM_ALIASES = [
  "pid",
  "rid",
  "psid",
  "respondent_id",
  "panelist_id",
  "uid",
] as const;

/** Storage is text, but an unbounded URL parameter is not a supplier name. */
export const SOURCE_MAX_LENGTH = 64;
export const RESPONDENT_ID_MAX_LENGTH = 128;

/**
 * Tidy a captured value without changing what it says.
 *
 * Whitespace is collapsed (a supplier's link with `?src=Cint%20UK` and one
 * with `?src=Cint+UK` must not become two suppliers) and the length is
 * capped. The CASE is kept: the join in `rescript_source_stats` is
 * case-insensitive, so "Cint" and "cint" already report as one source, and
 * lowercasing here would only make the fieldwork report uglier than the label
 * the supplier chose.
 */
function tidy(raw: unknown, max: number): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.slice(0, max);
}

export interface SampleCapture {
  /** which supplier this respondent came from, or null if the link carried none */
  source: string | null;
  /** the supplier's own id for this person */
  respondent: string | null;
  /** the parameter the value was actually read from, for the inspector */
  sourceParam?: string;
  respondentParam?: string;
}

/**
 * What to record for a respondent arriving with these URL parameters.
 *
 * The survey's own configuration wins, then the conventional names in order.
 * A configured parameter that is absent from the URL falls through to the
 * conventions rather than yielding nothing — a link that was already in the
 * field before someone set the option must keep working.
 */
export function resolveSampleSource(
  def: Pick<SurveyDefinition, "deployment"> | null | undefined,
  params: Record<string, string | string[] | undefined> | null | undefined,
): SampleCapture {
  if (!params) return { source: null, respondent: null };

  const cfg = def?.deployment?.sample;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const sourceNames = [
    ...(cfg?.sourceParam ? [cfg.sourceParam] : []),
    ...SOURCE_PARAM_ALIASES,
  ];
  const respondentNames = [
    ...(cfg?.respondentParam ? [cfg.respondentParam] : []),
    ...RESPONDENT_PARAM_ALIASES,
  ];

  const out: SampleCapture = { source: null, respondent: null };
  for (const name of sourceNames) {
    const v = tidy(first(params[name]), SOURCE_MAX_LENGTH);
    if (v) { out.source = v; out.sourceParam = name; break; }
  }
  for (const name of respondentNames) {
    const v = tidy(first(params[name]), RESPONDENT_ID_MAX_LENGTH);
    if (v) { out.respondent = v; out.respondentParam = name; break; }
  }
  return out;
}

/**
 * The invitation link for one supplier.
 *
 * The supplier substitutes their own macro for the respondent id — `[%pid%]`,
 * `${RID}`, whatever their platform uses — so the placeholder is theirs to
 * choose and is passed through untouched.
 */
export function sampleSourceLink(
  base: string,
  code: string,
  opts?: { respondentPlaceholder?: string; sourceParam?: string; respondentParam?: string },
): string {
  const sourceParam = opts?.sourceParam || SOURCE_PARAM_ALIASES[0];
  const respondentParam = opts?.respondentParam || RESPONDENT_PARAM_ALIASES[0];
  try {
    const u = new URL(base);
    u.searchParams.set(sourceParam, code);
    if (opts?.respondentPlaceholder) u.searchParams.set(respondentParam, opts.respondentPlaceholder);
    /*
     * A supplier macro must reach them unencoded — `%5B%25pid%25%5D` is not
     * substituted by any panel platform, it is just pasted into the URL.
     */
    return opts?.respondentPlaceholder
      ? u.toString().replace(
          `${respondentParam}=${encodeURIComponent(opts.respondentPlaceholder)}`,
          `${respondentParam}=${opts.respondentPlaceholder}`,
        )
      : u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    const tail = opts?.respondentPlaceholder
      ? `&${respondentParam}=${opts.respondentPlaceholder}`
      : "";
    return `${base}${sep}${sourceParam}=${encodeURIComponent(code)}${tail}`;
  }
}
