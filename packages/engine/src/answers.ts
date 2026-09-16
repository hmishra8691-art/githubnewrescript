import type { Option } from "@rescript/schema";

/**
 * Exclusive-option semantics (req §2), shared by every multi-select surface:
 * standard multi-select, multi-select dropdown, matrix-multi cells and
 * composite multi columns — one implementation, identical behaviour.
 */

export function isExclusiveOption(o: Pick<Option, "flags"> | undefined): boolean {
  return !!o?.flags?.some((f) =>
    ["exclusive", "none_of_above", "dont_know", "refused"].includes(f),
  );
}

/**
 * Toggle `code` within a multi-select answer.
 * - selecting an exclusive option clears everything else;
 * - selecting a normal option removes any exclusive ones;
 * - `maxSelections` blocks adding beyond the cap (deselects always allowed).
 */
export function toggleMultiValue(
  current: ReadonlyArray<string | number> | null | undefined,
  code: string | number,
  options: ReadonlyArray<Pick<Option, "code" | "flags">>,
  maxSelections?: number,
): (string | number)[] {
  const vals = [...(current ?? [])];
  const findOpt = (c: string | number) =>
    options.find((o) => String(o.code) === String(c));
  const already = vals.some((v) => String(v) === String(code));

  if (already) return vals.filter((v) => String(v) !== String(code));

  if (isExclusiveOption(findOpt(code))) return [code];

  const next = vals.filter((v) => !isExclusiveOption(findOpt(v)));
  if (maxSelections != null && next.length >= maxSelections) return next;
  return [...next, code];
}

/** Replace a whole multi-select value (e.g. "select all"), respecting exclusives. */
export function normalizeMultiValue(
  values: ReadonlyArray<string | number>,
  options: ReadonlyArray<Pick<Option, "code" | "flags">>,
  maxSelections?: number,
): (string | number)[] {
  const nonExclusive = values.filter(
    (v) => !isExclusiveOption(options.find((o) => String(o.code) === String(v))),
  );
  const capped =
    maxSelections != null ? nonExclusive.slice(0, maxSelections) : nonExclusive;
  return capped;
}

/**
 * ONE DEFINITION OF "NOT ANSWERED".
 *
 * There were three, and they disagreed on the two cases that matter most:
 *
 *   ·  `"   "`      validate said empty (it trimmed); evaluate said answered
 *   ·  `{ r1: null }`  countCondition said empty; evaluate said answered
 *
 * Both disagreements were reachable inside a single AND. A grid with no cell
 * filled in was simultaneously answered (the `isNotEmpty` rule passed) and
 * not answered (the count rule beside it returned 0), and a required open end
 * containing one space was blank to the validator and answered to the logic —
 * so the respondent was stopped by a message about a question their own
 * survey's logic had already routed past.
 *
 * This is the definition all three now use, and it is `validate`'s, which was
 * the strict one:
 *
 *   ·  null / undefined                       — never answered
 *   ·  a string of nothing but whitespace     — nothing was said
 *   ·  an empty array                         — nothing selected
 *   ·  an object whose every value is empty   — a grid with no cell filled
 *
 * `0` and `false` are ANSWERS. They are the values a scale of zero and a
 * "No" produce, and treating them as blank is the single most damaging
 * coercion a survey engine can make.
 */
export function isEmptyAnswer(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as object).every((x) => isEmptyAnswer(x));
  return false;
}
