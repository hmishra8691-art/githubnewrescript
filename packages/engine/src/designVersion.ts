import type { Question, SurveyDefinition } from "@rescript/schema";
import { subSeed } from "./random.js";

/**
 * WHICH VERSION OF A DESIGN THIS RESPONDENT SEES.
 *
 * A conjoint or MaxDiff design is usually generated in several VERSIONS (also
 * called blocks): each respondent answers one of them, and pooling the
 * versions is what gives the design its coverage. The generators have taken a
 * `versions` count since they were written, the design file carries a
 * `version` column, and the analysis reads the respondent's version back to
 * know which rows they were shown.
 *
 * Between those two ends, nothing assigned one. The renderer filtered the
 * design with
 *
 *     String(r.version ?? "1") === "1"
 *
 * — hardcoded — so every respondent saw version 1, the other versions were
 * generated and never fielded, and the analysis's version lookup always fell
 * back to "1". A four-version design was silently a one-version design, and
 * nothing anywhere said so. That is the bug this file exists to fix.
 *
 * The assignment is DERIVED, not stored: the response's seed already
 * identifies the respondent and is already persisted with their answers, so
 * `version = 1 + hash(seed, question) mod versions` is stable for a
 * respondent across pages, resumes and re-exports, reproducible from the
 * stored response alone, and needs no migration or extra write. It is even
 * across the sample for the same reason any hash is: the seeds are random.
 *
 * (A cross-respondent COUNTER — "give the least-used version next" — would be
 * more evenly balanced on small samples, and would need the same atomic
 * server-side claim List Fill uses. That is a deliberate next step, not what
 * this is; see `docs/CHOICE-MODELLING.md`.)
 */

/** How many versions a design file actually contains. */
export function designVersionCount(rows: Record<string, unknown>[]): number {
  const seen = new Set<string>();
  for (const r of rows) seen.add(String(r.version ?? "1"));
  return Math.max(1, seen.size);
}

/**
 * The version a respondent with this seed gets for this question.
 *
 * Keyed on the question as well as the seed so a survey with two design
 * questions does not hand the same respondent the same block number in both
 * — which would correlate the two designs for no reason.
 */
export function designVersionFor(
  q: Pick<Question, "id" | "settings">,
  rows: Record<string, unknown>[],
  seed: number,
): string {
  const versions = [...new Set(rows.map((r) => String(r.version ?? "1")))].sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b),
  );
  if (versions.length <= 1) return versions[0] ?? "1";
  const h = subSeed(seed, `designversion:${q.id}`);
  return versions[Math.abs(h) % versions.length];
}

/** The rows this respondent is actually shown, in design order. */
export function designRowsFor(
  q: Pick<Question, "id" | "settings">,
  rows: Record<string, unknown>[],
  seed: number,
): Record<string, unknown>[] {
  const version = designVersionFor(q, rows, seed);
  return rows.filter((r) => String(r.version ?? "1") === version);
}

/**
 * The design a question renders, resolved from the survey.
 *
 * Returns null rather than throwing: a question pointing at a design that has
 * not been generated is a programming state the Studio has to be able to
 * show, and the quality check reports it (§53).
 */
export function designFor(
  def: SurveyDefinition,
  q: Pick<Question, "settings">,
): { rows: Record<string, unknown>[]; columns: string[] } | null {
  const ref = q.settings?.designRef;
  if (!ref) return null;
  const design = (def.designs ?? []).find((d) => d.id === ref);
  const rows = design?.file?.rows as Record<string, unknown>[] | undefined;
  if (!rows?.length) return null;
  return { rows, columns: (design!.file!.columns ?? []) as string[] };
}

/**
 * The order alternatives are shown in, within one task.
 *
 * Position effects are real — the first concept in a task is chosen more
 * often than it should be — and the design does not control for them: it
 * fixes which concepts appear together, not which order they appear in. The
 * order is therefore rolled per respondent per task, and the None option
 * stays last, where a respondent expects it and where every screenshot of a
 * conjoint task in the literature puts it.
 */
export function shuffleAlternatives<T extends Record<string, unknown>>(
  alts: T[],
  seed: number,
  key: string,
): T[] {
  const none = alts.filter((a) => Number(a.none_option) === 1);
  const real = alts.filter((a) => Number(a.none_option) !== 1);
  let h = subSeed(seed, `altorder:${key}`);
  const out = [...real];
  // Fisher-Yates on a small deterministic stream — the same respondent and
  // task always produce the same order, so Back does not reshuffle the task
  for (let i = out.length - 1; i > 0; i--) {
    h = subSeed(h, String(i));
    const j = Math.abs(h) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return [...out, ...none];
}
