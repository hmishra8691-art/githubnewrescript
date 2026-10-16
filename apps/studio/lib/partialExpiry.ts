/**
 * WHEN AN UNFINISHED RESPONSE COUNTS AS ABANDONED (RUNTIME-07, audit 2026-10-16).
 *
 * The selection half of `/api/cron/expire-partials`, kept pure so it can be
 * tested without a database. The route reads each survey's definition JSON
 * RAW (not through the Zod schema), so the setting is found wherever it is
 * written — first match wins:
 *
 *   deployment.partialExpiryDays   ← the natural home once the schema names it
 *   settings.partialExpiryDays
 *   meta_extensions.partialExpiryDays   ← survives a Zod round-trip today
 *
 * A positive number is the window in days (fractions allowed, clamped to
 * [1, 3650]); `0` or `false` means NEVER expire this survey's partials;
 * anything else (absent, negative, a string) is the 30-day default — the same
 * age at which the respondent's browser forgets its resume pointer
 * (`RESUME_MAX_AGE_DAYS` in apps/runtime/lib/resume.ts), so a row is never
 * expired while its owner's device could still resume it by default.
 */

export const DEFAULT_PARTIAL_EXPIRY_DAYS = 30;
export const MIN_PARTIAL_EXPIRY_DAYS = 1;
export const MAX_PARTIAL_EXPIRY_DAYS = 3650;

const DAY_MS = 86_400_000;

type Json = Record<string, unknown> | null | undefined;

function pick(obj: unknown): unknown {
  return obj && typeof obj === "object" && !Array.isArray(obj)
    ? (obj as Record<string, unknown>).partialExpiryDays
    : undefined;
}

/** Days after last activity at which an in-progress response is abandoned; null = never. */
export function partialExpiryDays(def: { deployment?: unknown; settings?: unknown; meta_extensions?: unknown } | Json): number | null {
  const d = (def ?? {}) as Record<string, unknown>;
  for (const raw of [pick(d.deployment), pick(d.settings), pick(d.meta_extensions)]) {
    if (raw === undefined || raw === null) continue;
    if (raw === false || raw === 0) return null;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.min(MAX_PARTIAL_EXPIRY_DAYS, Math.max(MIN_PARTIAL_EXPIRY_DAYS, raw));
    }
    // a malformed value is not "never": fall through to the default rather than keep rows for ever
    return DEFAULT_PARTIAL_EXPIRY_DAYS;
  }
  return DEFAULT_PARTIAL_EXPIRY_DAYS;
}

/** The instant before which a survey's in-progress responses are abandoned; null = never. */
export function partialExpiryCutoff(def: Parameters<typeof partialExpiryDays>[0], now: Date): Date | null {
  const days = partialExpiryDays(def);
  return days === null ? null : new Date(now.getTime() - days * DAY_MS);
}

export interface PartialRow {
  status: string;
  started_at: string | null;
  last_saved_at: string | null;
  deleted_at?: string | null;
}

/** The moment the respondent last did anything: the last save, else the start. */
export function lastActivity(row: Pick<PartialRow, "started_at" | "last_saved_at">): number | null {
  for (const v of [row.last_saved_at, row.started_at]) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Whether one row should be marked abandoned. Only live (not deleted)
 * `in_progress` rows; a row with no readable timestamp is never touched —
 * we do not expire what we cannot date.
 */
export function shouldAbandon(row: PartialRow, cutoff: Date | null): boolean {
  if (!cutoff) return false;
  if (row.status !== "in_progress") return false;
  if (row.deleted_at) return false;
  const t = lastActivity(row);
  return t !== null && t < cutoff.getTime();
}

/**
 * Per-survey plan for one sweep: which surveys to look at and with what
 * cutoff. Surveys that never expire are dropped here so the route issues no
 * query for them.
 */
export function planPartialExpiry(
  surveys: { id: string; definition: Parameters<typeof partialExpiryDays>[0] }[],
  now: Date,
): { surveyId: string; cutoff: string; days: number }[] {
  const out: { surveyId: string; cutoff: string; days: number }[] = [];
  for (const s of surveys) {
    const days = partialExpiryDays(s.definition);
    if (days === null) continue;
    out.push({ surveyId: s.id, days, cutoff: new Date(now.getTime() - days * DAY_MS).toISOString() });
  }
  return out;
}

/**
 * The PostgREST filter that selects rows whose last activity is before the
 * cutoff — `shouldAbandon` in SQL terms, for `.or(...)`.
 */
export function inactiveSinceFilter(cutoffIso: string): string {
  return `last_saved_at.lt."${cutoffIso}",and(last_saved_at.is.null,started_at.lt."${cutoffIso}")`;
}
