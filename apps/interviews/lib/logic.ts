import "server-only";
import { Condition, SkipRule } from "@rescript/schema";

/**
 * LOGIC ARRIVES AS JSON AND IS CHECKED BY THE SCHEMA THAT OWNS IT.
 *
 * `interview_questions.visible_if` and `skip_logic` hold a `Condition` and a
 * `SkipRule[]` from `@rescript/schema`, verbatim. The database checks only that
 * they are an object and an array; the grammar is checked here with the zod
 * schemas the survey side already maintains — so a malformed condition is
 * refused at save time with the schema's own message, rather than being stored
 * and met by `evaluateCondition` in front of a candidate.
 *
 * `undefined` means "not mentioned in this patch"; `null` means "clear it".
 * The two are different and both are preserved.
 */
export function readCondition(raw: unknown): { ok: true; value: Condition | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  const parsed = Condition.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `That show-if rule is not valid: ${parsed.error.issues[0]?.message ?? "malformed"}` };
  return { ok: true, value: parsed.data };
}

export function readSkipRules(raw: unknown): { ok: true; value: SkipRule[] | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Skip rules have to be a list." };
  const out: SkipRule[] = [];
  for (const r of raw) {
    const parsed = SkipRule.safeParse(r);
    if (!parsed.success) return { ok: false, error: `That skip rule is not valid: ${parsed.error.issues[0]?.message ?? "malformed"}` };
    out.push(parsed.data);
  }
  return { ok: true, value: out };
}
