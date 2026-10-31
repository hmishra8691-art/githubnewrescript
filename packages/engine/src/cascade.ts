import type { Option, Question } from "@rescript/schema";

/**
 * AQ-08 (2026-10-31) — THE CASCADING DROPDOWN (variant `single_select.cascading_dropdown`).
 *
 * Data model (chosen to fit the schema without a new answer shape):
 *   - the PARENT list is `settings.cascadeParents` [{code, label}];
 *   - the CHILD list is the question's own `options`, each naming its parent in `meta.parent`;
 *   - the stored answer is the CHILD code — every reader of a single choice (validation, piping, quotas, logic,
 *     exports, analytics) keeps working on it unchanged;
 *   - the parent is DERIVED: written beside the answer as `<answer key>__parent` while the respondent picks (so a
 *     page script or piping can read it), and re-derived from the definition on export (VAR_PARENT) so the column
 *     never depends on what a browser posted.
 * Validation: a child whose parent is not in the list, or that does not belong to the parent posted beside it, is
 * refused ("child must belong to parent").
 */
export const CASCADING_VARIANT = "single_select.cascading_dropdown";
export const CASCADE_PARENT_SUFFIX = "__parent";

export function isCascading(q: Pick<Question, "variant">): boolean {
  return q.variant === CASCADING_VARIANT;
}

export function cascadeParents(q: Question): { code: string | number; label: string }[] {
  const raw = (q.settings as { cascadeParents?: { code: string | number; label: string }[] }).cascadeParents;
  return Array.isArray(raw) ? raw.filter((p) => p && (typeof p.code === "string" || typeof p.code === "number")) : [];
}

/** the parent code an option names, as a string, or null */
export function optionParent(o: Pick<Option, "meta"> | undefined): string | null {
  const p = o?.meta?.parent;
  return p === undefined || p === null || p === "" ? null : String(p);
}

/** the derived parent of a stored child code, or null (not an option, or an option with no parent) */
export function cascadeParentOf(q: Question, childCode: unknown): string | number | null {
  if (childCode === undefined || childCode === null || childCode === "") return null;
  const o = (q.options ?? []).find((x) => String(x.code) === String(childCode));
  const p = optionParent(o);
  if (p === null) return null;
  return cascadeParents(q).find((x) => String(x.code) === p)?.code ?? p;
}

/** the children of one parent, in the order given (the shown, already filtered/ordered options) */
export function cascadeChildren<T extends Pick<Option, "meta">>(options: T[], parentCode: unknown): T[] {
  if (parentCode === undefined || parentCode === null || parentCode === "") return [];
  return options.filter((o) => optionParent(o) === String(parentCode));
}

/**
 * The problems with a cascading answer, as sentences ([] when fine or unanswered — "required" is the ordinary rule's).
 * `postedParent` is the `__parent` side value when there is one.
 */
export function cascadeProblems(q: Question, child: unknown, postedParent: unknown): string[] {
  if (child === undefined || child === null || child === "") return [];
  const o = (q.options ?? []).find((x) => String(x.code) === String(child));
  if (!o) return [`“${String(child)}” is not one of the choices.`];
  const p = optionParent(o);
  const parents = cascadeParents(q);
  if (p === null || !parents.some((x) => String(x.code) === p)) return [`“${String(child)}” does not belong to any of the first list's choices.`];
  if (postedParent !== undefined && postedParent !== null && postedParent !== "" && String(postedParent) !== p) {
    const pl = parents.find((x) => String(x.code) === String(postedParent))?.label ?? String(postedParent);
    return [`That choice does not belong to “${pl}”.`];
  }
  return [];
}

/** authoring checks (the gate and the editor): parents present, unique, every child names one of them */
export function lintCascade(q: Question): string[] {
  if (!isCascading(q)) return [];
  const out: string[] = [];
  const parents = cascadeParents(q);
  if (!parents.length) out.push(`${q.code}: a cascading dropdown needs its first list (settings.cascadeParents [{code, label}])`);
  const seen = new Set<string>();
  for (const p of parents) { if (seen.has(String(p.code))) out.push(`${q.code}: parent code ${p.code} appears twice`); seen.add(String(p.code)); }
  const orphans = (q.options ?? []).filter((o) => { const p = optionParent(o); return p === null || !seen.has(p); });
  if (parents.length && orphans.length) out.push(`${q.code}: ${orphans.length} option${orphans.length === 1 ? "" : "s"} (${orphans.slice(0, 5).map((o) => o.code).join(", ")}) name no parent from the first list (option meta.parent) — respondents can never reach ${orphans.length === 1 ? "it" : "them"}`);
  const empty = parents.filter((p) => !(q.options ?? []).some((o) => optionParent(o) === String(p.code)));
  if (empty.length) out.push(`${q.code}: ${empty.map((p) => p.label).join(", ")} ha${empty.length === 1 ? "s" : "ve"} no options in the second list`);
  return out;
}
