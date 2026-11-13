import type { SurveyDefinition, ListFill } from "@rescript/schema";

/**
 * LIST FILL, IN A RESEARCHER'S WORDS (2026-11-13) — the loop card's treatment (loopGuide.ts) for List Fill.
 *
 * The panel opened on a ten-column grid and a strategy menu of twelve entries, and never said what the list would
 * do for a respondent. `listFillPlainSummary` says it in sentences; `listFillChecks` says what is unfinished, with what
 * to do. The structural problems — a missing source question, a duplicate name, a destination written twice — stay
 * with `lintListFills` (listFillLint.ts), which the panel already shows; nothing here repeats them. Both functions only
 * READ the list.
 */
export interface ListFillCheck { level: "problem" | "warning" | "tip"; message: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const codeOf = (def: SurveyDefinition, id: string) => def.questions.find((q) => q.id === id)?.code ?? id;
const nameOf = (lf: ListFill) => lf.name?.trim() || lf.id;

/** how the list picks, as the end of a sentence — keyed by the stored method */
export const LIST_FILL_METHOD_WORDS: Record<string, string> = {
  highest_priority: "lowest priority number first",
  lowest_priority: "highest priority number first",
  priority_quota: "lowest priority number first, skipping anything a hard quota has closed",
  priority_random: "by priority, at random between items that share a number",
  first_selected: "in the order the items are listed",
  selection_order: "in the order the respondent chose them",
  random: "at random",
  weighted_random: "at random, more often for items with a higher weight",
  least_filled: "whichever has been given to the fewest respondents so far",
  balanced_random: "whichever is furthest below its target",
  quota_aware_random: "whichever has the most room left",
  custom: "by a custom script",
};

/** which methods are offered first in the menu; the others are under "Less common" (values unchanged) */
export const LIST_FILL_COMMON_METHODS = ["highest_priority", "random", "least_filled", "balanced_random", "first_selected"] as const;

export function listFillSourceWords(def: SurveyDefinition, lf: ListFill): string | null {
  const s = lf.source;
  switch (s.kind) {
    case "question": {
      const c = codeOf(def, s.questionId);
      return s.take === "all" ? `every answer listed at ${c}` : s.take === "displayed" ? `the answers the respondent was shown at ${c}` : `the answers the respondent chose at ${c}`;
    }
    case "static": return s.items.length ? `a list of ${plural(s.items.length, "item")}` : null;
    case "listFill": {
      const other = def.listFills.find((l) => l.id === s.listFillId);
      return `what List Fill ${other ? nameOf(other) : s.listFillId} gave the respondent`;
    }
    case "calculation": return `the list held in ${s.ref}`;
    case "embedded": return `the list held in ${s.ref}`;
    case "script": return "the items a script returns";
    default: return null;
  }
}

function countWords(def: SurveyDefinition, lf: ListFill): string {
  const c = lf.selection.count;
  switch (c.kind) {
    case "fixed": return `${plural(c.n, "item")}${c.allUpTo != null ? ` (all of them when ${c.allUpTo} or fewer qualify)` : ""}`;
    case "all": return "every item that qualifies";
    case "question": return `as many items as the number given at ${codeOf(def, c.questionId)}`;
    case "calculation": return `as many items as ${c.ref}`;
    case "expression": return "a calculated number of items";
    default: return "items";
  }
}

/** what this List Fill does, as sentences */
export function listFillPlainSummary(def: SurveyDefinition, lf: ListFill): string[] {
  const lines: string[] = [];
  if (!lf.enabled) lines.push("Switched off — nobody is given anything until it is turned back on.");
  const from = listFillSourceWords(def, lf);
  if (!from) { lines.push("Choose what it picks from: a question whose answers feed it."); return lines; }
  const how = LIST_FILL_METHOD_WORDS[lf.selection.method] ?? "by its strategy";
  lines.push(`Gives each respondent ${countWords(def, lf)} from ${from}, ${how}.`);
  const capped = lf.options.filter((o) => o.maximum != null).length;
  const targeted = lf.options.filter((o) => o.target != null).length;
  if (capped || targeted) {
    const parts: string[] = [];
    if (capped) parts.push(`${capped === lf.options.length ? "every item" : plural(capped, "item")} stops once it reaches its maximum`);
    if (targeted && lf.selection.afterTarget !== "continue") parts.push(`${targeted === lf.options.length ? "every item" : plural(targeted, "item")} with a target ${lf.selection.afterTarget === "stop" ? "stops" : "steps back behind the others"} once it reaches it`);
    if (parts.length) lines.push(`${parts.join("; ").replace(/^./, (x) => x.toUpperCase())}${lf.tracking.countOnCompleteOnly ? " (counting completed interviews only)" : ""}.`);
  }
  const off = lf.options.filter((o) => o.eligible === false).length;
  if (off) lines.push(`${plural(off, "item")} ${off === 1 ? "is" : "are"} switched off and never given.`);
  const dests = lf.destinations.filter((d) => d.questionId).map((d) => codeOf(def, d.questionId));
  lines.push(dests.length ? `Writes the result into ${dests.join(", ")}.` : "The result is not written into a question; later questions can pipe it.");
  if (lf.runWhen) lines.push("Only runs for respondents who meet its condition.");
  return lines;
}

/** what is unfinished or probably not intended — beyond what lintListFills already reports */
export function listFillChecks(def: SurveyDefinition, lf: ListFill): ListFillCheck[] {
  const out: ListFillCheck[] = [];
  const s = lf.source;
  if (s.kind === "static" && !s.items.length) out.push({ level: "problem", message: "Nothing feeds this list yet. Choose the question whose answers it picks from." });
  if (s.kind === "question" && def.questions.some((q) => q.id === s.questionId) && !lf.options.length) {
    out.push({ level: "tip", message: "No item has its own settings yet, so every answer is treated alike with no limit. Use “+ add every option from the source” to set priorities or maximums." });
  }
  const m = lf.selection.method;
  if (m === "weighted_random" && lf.options.length && !lf.options.some((o) => o.weight != null && o.weight !== 1)) {
    out.push({ level: "warning", message: "“Weighted random” is chosen but no item has a weight, so it behaves like plain random. Set a weight on the items that should come up more often." });
  }
  if (m === "balanced_random" && !lf.options.some((o) => o.target != null)) {
    out.push({ level: "warning", message: "“Balanced to target” needs a target on the items — without one it is plain random. Set targets, or choose “Least filled” to even out the counts." });
  }
  if ((m === "highest_priority" || m === "lowest_priority" || m === "priority_random" || m === "priority_quota") && lf.options.length > 1 && !lf.options.some((o) => o.priority != null)) {
    out.push({ level: "tip", message: "No item has a priority number, so they are all tried as equals. Give the items you want first a lower number." });
  }
  if (m === "custom" && !lf.selection.scriptId) out.push({ level: "problem", message: "Choose the script that writes the selection, or pick another way of choosing." });
  const c = lf.selection.count;
  if (c.kind === "fixed" && c.n === 0) out.push({ level: "problem", message: "It is set to give 0 items. Set how many each respondent should get." });
  if (c.kind === "fixed" && s.kind === "static" && s.items.length && c.n > s.items.length) {
    out.push({ level: "warning", message: `It asks for ${c.n} items but the list has only ${s.items.length} — respondents will get at most ${s.items.length}.` });
  }
  if (lf.destinations.some((d) => !d.questionId)) out.push({ level: "problem", message: "A destination has no question chosen. Choose one, or remove it." });
  return out;
}
