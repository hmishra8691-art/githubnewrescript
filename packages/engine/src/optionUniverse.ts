import type { Question } from "@rescript/schema";

/**
 * EVERY OPTION A QUESTION CAN SHOW, FOR THE DATA (2026-11-02).
 *
 * A question whose list is carried forward ("show the brands selected at Q1") may have no options of its own — a
 * Qualtrics pure carry-forward and an imported "[CARRY FORWARD …]" both look like that. Its answers are the SOURCE's
 * codes. The data dictionary declared, and the flattener wrote, the per-option 0/1 columns from `q.options` alone,
 * so a carried multi-select had no column at all in CSV / SPSS / Stata / SAS, and a carried single-select had no
 * value labels: the answers were collected and never delivered.
 *
 * The universe is the question's own options followed by the carried source's universe (through a chain of carries,
 * each code once, the first label kept). It is the same for every respondent — what one respondent was SHOWN is a
 * subset — so the columns are stable across the file. Rows carried into a grid are `dictionaryRows`' job; this is
 * options only.
 */
export function optionUniverse(q: Question, all: readonly Question[] | undefined): Question["options"] {
  const cf = q.carryForward;
  if (!cf || cf.into === "rows" || !all?.length) return q.options;
  const byId = new Map(all.map((x) => [x.id, x]));
  const seen = new Set<string>();
  const out: Question["options"] = [];
  const add = (opts: Question["options"]) => { for (const o of opts ?? []) { const k = String(o.code); if (!seen.has(k)) { seen.add(k); out.push(o); } } };
  add(q.options);
  const visited = new Set<string>([q.id]);
  for (let src = byId.get(cf.sourceQuestionId); src && !visited.has(src.id); src = src.carryForward && src.carryForward.into !== "rows" ? byId.get(src.carryForward.sourceQuestionId) : undefined) {
    visited.add(src.id);
    add(src.options);
  }
  return out;
}

/** the question with its option universe in place of its own options — what the dictionary and the flattener read */
export const withOptionUniverse = (q: Question, all: readonly Question[] | undefined): Question => {
  if (!q.carryForward || q.carryForward.into === "rows" || !all?.length) return q;
  const options = optionUniverse(q, all);
  return options.length === (q.options ?? []).length ? q : { ...q, options };
};
