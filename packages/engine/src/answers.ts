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
