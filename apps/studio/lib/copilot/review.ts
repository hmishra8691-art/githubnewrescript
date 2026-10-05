import type { Option, Question, SurveyDefinition } from "@rescript/schema";
import {
  changeItems, impactOf, impactPhrase, objectKey, formatCondition, setExpressionSummary,
  type ChangeCategory, type ChangeItem, type ChangeTree, type ContextAction, type SurveyAction, type ContextGroup, type DependencyIndex, type ImpactItem, type ImpactSeverity,
} from "@rescript/engine";
import { actionMap, type Proposal, type ProposalState } from "./client.ts";

/**
 * THE CHANGE REVIEW, the pure part (Intelligent Mode upgrade, Phase 4).
 *
 * The Changes panel renders the engine's change tree (`changeItems`): one
 * row per change, grouped survey → block → question, each row knowing the
 * ACTIONS that made it (`actionIndexes`, flat across the proposal's steps).
 * Selective apply is decided here, not in the component:
 *
 *   - the tree is built from the WHOLE proposal (nothing excluded), so an
 *     unticked row stays on screen to be ticked again — the after-state of
 *     the included actions alone would not contain it
 *   - unticking a row excludes its actions; every other row those actions
 *     made goes with it, and the row says so before you untick ("also
 *     excludes …") — an action is the unit the engine can leave out, a row is
 *     only what the researcher sees
 *   - a row's status is read off the exclusions and the EFFECTIVE run's
 *     refusals: an included action can be refused because something it
 *     needed was excluded (a skip to a question no longer created)
 *
 * Also here: the option facts the hover preview shows, the type words of a
 * card's header, and the order of the context-action groups.
 */

/* ------------------------------------------------------------ the tree */

/**
 * The review's tree: `changeItems` of the whole proposal, with the action
 * indexes the engine could not attribute filled in when the answer is not in
 * doubt — a one-action proposal made every change.
 */
export function reviewTree(p: Proposal, full: ProposalState): ChangeTree {
  const tree = changeItems(p.base, full.after, { results: full.results, destructive: full.destructive });
  const acts = p.steps.flatMap((s) => s.actions);
  // the items are this call's own objects (and the groups hold the same ones), so refining in place is safe
  for (const it of tree.items) {
    if (!it.actionIndexes.length && acts.length === 1) { it.actionIndexes = [0]; continue; }
    if (it.actionIndexes.length < 2) continue;
    // the engine attributes a row to every action that touched its QUESTION; keep the ones whose op can make this kind of change
    const keep = it.actionIndexes.filter((i) => { const c = acts[i] ? actionCategories(acts[i]) : null; return !c || c.has(it.category); });
    if (keep.length) it.actionIndexes = keep;
  }
  return tree;
}

const OPTION_ROWS: ChangeCategory[] = ["Options", "Option label", "Option code", "Option value", "Option flags", "Option visibility", "Option order", "Randomization"];
/**
 * What kinds of change an action can make, read off the action itself —
 * `update_question { required }` makes a Required row and nothing else.
 * null: anything (a rename or a recode rewrites conditions everywhere; an op
 * this list does not know is never narrowed). The engine's `touched` says
 * which QUESTION an action reached; this says which of that question's rows,
 * so unticking the skip on Q7 does not also untick Q7's relabelled option.
 */
export function actionCategories(a: SurveyAction): Set<ChangeCategory> | null {
  const x = a as { op: string } & Record<string, unknown>;
  const has = (k: string) => x[k] !== undefined;
  const out = new Set<ChangeCategory>();
  switch (x.op) {
    case "update_question":
      if (has("code") || has("variable")) return null;
      if (has("text") || has("instruction")) out.add("Wording");
      if (has("type")) { out.add("Question type"); for (const c of [...OPTION_ROWS, "Rows", "Columns", "Validation"] as ChangeCategory[]) out.add(c); }
      if (has("required")) out.add("Required");
      if (has("options") || has("addOptions") || has("removeOptions") || has("scale")) for (const c of OPTION_ROWS) out.add(c);
      if (has("rows")) out.add("Rows");
      if (has("randomize")) out.add("Randomization");
      return out;
    case "update_option":
      if (has("code")) return null;
      if (has("label")) out.add("Option label");
      if (has("value")) out.add("Option value");
      if (has("exclusive") || has("other") || has("anchor")) { out.add("Option flags"); out.add("Randomization"); }
      if (has("visibleIf")) out.add("Option visibility");
      if (has("position")) out.add("Option order");
      return out;
    case "reorder_options": return new Set(["Option order"]);
    case "set_option_randomization": return new Set(["Randomization", "Option flags", "Option order"]);
    case "set_mask": case "clear_mask": return new Set(["Masking"]);
    case "set_display_logic": return new Set(["Display logic"]);
    case "add_skip": case "clear_skips": return new Set(["Skip logic"]);
    case "set_validation": return new Set(["Validation", "Required"]);
    case "add_punch": case "remove_punches": return new Set(["Punching"]);
    case "set_custom_code": return new Set(["Custom code"]);
    case "move_question": return new Set(["Placement"]);
    case "page_break": return new Set(["Page break"]);
    default: return null;
  }
}

export type ItemStatus = "proposed" | "excluded" | "partial" | "refused";

/**
 * What happens to one row on Apply, and — refused — the engine's reason.
 * `present`: the row ids of the EFFECTIVE run's tree (the included actions
 * only), when something is excluded. A row the engine could not attribute to
 * an action (Q12's display logic, pruned because Q11 is deleted) has no tick
 * of its own; whether it still happens is read off that tree — unticking the
 * deletion leaves Q12's logic alone, and its row says so. Only such rows are
 * judged this way: a created object's id is minted afresh on every run, so
 * its row id differs between the two trees by construction.
 */
export function itemStatus(item: Pick<ChangeItem, "actionIndexes" | "id">, excluded: ReadonlySet<number>, refused: ReadonlyMap<number, string>, present?: ReadonlySet<string> | null): { status: ItemStatus; reason?: string } {
  const idx = item.actionIndexes;
  if (idx.length && idx.every((i) => excluded.has(i))) return { status: "excluded" };
  const r = idx.find((i) => !excluded.has(i) && refused.has(i));
  if (r !== undefined) return { status: "refused", reason: refused.get(r) };
  if (idx.some((i) => excluded.has(i))) return { status: "partial" };
  if (!idx.length && excluded.size && present && !present.has(item.id)) return { status: "excluded", reason: "It followed from a change you excluded." };
  return { status: "proposed" };
}

/** the refusals of an evaluation, by flat action index */
export function refusals(state: Pick<ProposalState, "results">): Map<number, string> {
  return new Map(state.results.filter((r) => !r.ok).map((r) => [r.index, r.error ?? "refused"]));
}

/** the exclusion set after ticking (include) or unticking one row or a whole card */
export function toggleItems(excluded: readonly number[], items: Pick<ChangeItem, "actionIndexes">[], include: boolean): number[] {
  const set = new Set(excluded);
  for (const it of items) for (const i of it.actionIndexes) { if (include) set.delete(i); else set.add(i); }
  return [...set].sort((a, b) => a - b);
}

/** the OTHER rows made by any action behind this one — they are excluded with it */
export function siblings(tree: Pick<ChangeTree, "items">, item: ChangeItem): ChangeItem[] {
  const mine = new Set(item.actionIndexes);
  if (!mine.size) return [];
  return tree.items.filter((x) => x !== item && x.actionIndexes.some((i) => mine.has(i)));
}

/** a row as a short name, for "also excludes …": "Q7 option 4 label", "block “Cars” title", "quota “Region”" */
export function itemName(item: ChangeItem): string {
  const where = item.question?.code ?? (item.block ? `block “${item.block.title}”` : "");
  return `${where}${where ? " " : ""}${item.field}`.trim();
}

/** "Apply 7 of 9 changes": the rows that will go in (a partly excluded row still does), and all of them */
export function applyCount(tree: Pick<ChangeTree, "items">, excluded: readonly number[], present?: ReadonlySet<string> | null): { included: number; total: number } {
  const set = new Set(excluded);
  const total = tree.items.length;
  const out = tree.items.filter((it) => itemStatus(it, set, new Map(), present).status !== "excluded").length;
  return { included: out, total };
}

/** the row ids of the tree the included actions alone would make — null when nothing is excluded (then every row happens) */
export function presentIds(p: Proposal, effective: ProposalState): Set<string> | null {
  if (!effective.excluded.length) return null;
  try { return new Set(changeItems(p.base, effective.after).items.map((i) => i.id)); } catch { return null; }
}

/** what the history says was left out: each excluded action as the engine described it when it was proposed */
export function excludedLabels(p: Proposal, full: Pick<ProposalState, "results">, excluded: readonly number[]): string[] {
  const acts = actionMap(p);
  return [...excluded].sort((a, b) => a - b).map((i) => full.results.find((r) => r.index === i)?.description || `${acts[i]?.op.replace(/_/g, " ") ?? "action"} (step ${(acts[i]?.step ?? 0) + 1})`);
}

/** exclusions that still name an action of this proposal (a stale index after a revision is dropped) */
export function validExclusions(p: Proposal, excluded: readonly number[]): number[] {
  const n = actionMap(p).length;
  return [...new Set(excluded)].filter((i) => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b);
}

/** a question card starts open when there are few — a long proposal reads better as headers first */
export const CARDS_OPEN_UP_TO = 4;

/* ------------------------------------------------------------ words */

const TYPE_WORDS: Record<string, string> = {
  single_select: "Single choice", multi_select: "Multiple choice", dropdown: "Dropdown", multi_dropdown: "Multi-select dropdown",
  numeric: "Number", open_text: "Open text", long_text: "Long text", text: "Text", numeric_list: "Number list", text_list: "Text list",
  date: "Date", time: "Time", ranking: "Ranking", slider: "Slider", nps: "NPS", matrix_single: "Grid (single)", matrix_multi: "Grid (multiple)",
  matrix_numeric: "Grid (numbers)", matrix_text: "Grid (text)", matrix_dropdown: "Grid (dropdowns)", image_select: "Image choice", allocation: "Constant sum",
  hidden: "Hidden variable", calculated: "Calculated", html: "Text block", upload: "File upload", geo: "Location", maxdiff_task: "MaxDiff", conjoint_task: "Conjoint",
};
/** a question's type as a researcher says it — "Single choice", "Number" — not the storage name */
export function typeName(q: Pick<Question, "type"> | { type: string } | undefined, fallback = ""): string {
  if (!q) return fallback;
  const t = String(q.type);
  return TYPE_WORDS[t] ?? (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ") : fallback);
}

const ENT: Record<string, string> = { amp: "&", nbsp: " ", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'" };
const plain = (s: string | undefined | null) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&(amp|nbsp|lt|gt|quot|#39|apos);/g, (_m, e: string) => ENT[e]).replace(/\s+/g, " ").trim();

/** "Q7 · Single choice · Do you own a car?" — the type from the survey the question lives in, else the tree's words */
export function questionHeader(q: NonNullable<ChangeItem["question"]>, defs: SurveyDefinition[]): { code: string; type: string; text: string } {
  const found = defs.map((d) => d.questions.find((x) => x.id === q.id)).find(Boolean);
  return { code: q.code, type: typeName(found, q.type.charAt(0).toUpperCase() + q.type.slice(1)), text: found ? plain(found.text) || q.text : q.text };
}

/** "Option 4 — United States" */
export const optionTitle = (o: NonNullable<ChangeItem["option"]>, axis = "Option") => `${axis} ${o.index} — ${o.label}`;

/* ------------------------------------------------------------ impact */

/** where a dependent lives, as a selection key (an option is its question; a block or page its flow node) */
export function impactKey(o: ImpactItem["object"]): string {
  if (o.kind === "option") return objectKey("question", o.questionId ?? o.id);
  if (o.kind === "block" || o.kind === "page") return objectKey("flowNode", o.id);
  return `${o.kind}:${o.id}`;
}
export const SEVERITY_WORDS: Record<ImpactSeverity, string> = { breaks: "breaks", changes: "changes", informs: "to review" };

/* ------------------------------------------------------------ an option, for the hover preview */

export interface OptionFacts {
  code: string;
  label: string;
  /** the export value when it differs from the code */
  value: string | null;
  flags: string[];
  /** its own display condition, in words, or null when always shown */
  condition: string | null;
  /** the question's randomization, in words ("shuffled, keeps “None” last"), or null */
  randomization: string | null;
  /** the question's option mask, in words, or null */
  mask: string | null;
  /** what reads this option: "Q9 display logic", "quota “Region”" — each with its severity if it went */
  dependents: { phrase: string; text: string; severity: ImpactSeverity; key: string }[];
}

/**
 * Everything the preview shows about one option, from the survey given —
 * no network, nothing evaluated. `dependents` are what a removal of the
 * option would reach (the engine's own impact report), so the preview
 * answers "what depends on this option?" in the same words as the review.
 */
export function optionFacts(def: SurveyDefinition, questionId: string, code: string | number, index?: DependencyIndex): OptionFacts | null {
  const q = def.questions.find((x) => x.id === questionId);
  const o = (q?.options as Option[] | undefined)?.find((x) => String(x.code) === String(code));
  if (!q || !o) return null;
  const f = o.flags ?? [];
  const flags = [
    f.includes("exclusive") ? "exclusive" : "", f.includes("other_specify") ? "other — specify" : "",
    f.includes("anchor_top") ? "anchored first" : f.includes("anchor_bottom") ? "anchored last" : "",
    ...f.filter((x) => !["exclusive", "other_specify", "anchor_top", "anchor_bottom"].includes(x)).map((x) => x.replace(/_/g, " ")),
  ].filter(Boolean);
  const words = (c: unknown) => { try { return formatCondition(def, c as never, { width: 400 }).replace(/\s+/g, " ").trim(); } catch { return "a condition"; } };
  const conds = [o.visibleIf ? words(o.visibleIf) : "", o.logic?.when ? words(o.logic.when) : ""].filter(Boolean);
  const r = q.randomization;
  const randomization = r?.enabled ? `${r.method === "shuffle" ? "shuffled" : String(r.method).replace(/_/g, " ")}${r.pick ? `, ${r.pick} shown` : ""}${(q.options ?? []).some((x) => x.flags?.includes("anchor_bottom") || x.flags?.includes("anchor_top")) ? ", with anchored options" : ""}` : null;
  let mask: string | null = null;
  if (q.mask) { try { mask = `${q.mask.action.replace(/_/g, " ")} ${setExpressionSummary(def, q.mask.expr)}`; } catch { mask = q.mask.action; } }
  let dependents: OptionFacts["dependents"] = [];
  try {
    dependents = impactOf(def, { options: [{ questionId: q.id, codes: [o.code] }] }, { change: "delete", ...(index ? { index } : {}) }).items
      .filter((i) => !i.indirect).map((i) => ({ phrase: impactPhrase(i), text: i.text, severity: i.severity, key: impactKey(i.object) }));
  } catch { /* a half-formed definition must not take the preview down */ }
  return {
    code: String(o.code), label: plain(o.label),
    value: o.value !== undefined && o.value !== null && String(o.value) !== String(o.code) ? String(o.value) : null,
    flags, condition: conds.length ? conds.join(" and ") : null, randomization, mask, dependents,
  };
}

/* ------------------------------------------------------------ context actions */

/** the groups in the order the Inspector shows them; a group with no action is not shown at all */
export const CONTEXT_GROUP_ORDER: ContextGroup[] = ["Logic", "Options", "Validation", "Data", "Structure", "Inspect", "Research"];
export function groupContextActions(actions: ContextAction[]): { group: ContextGroup; actions: ContextAction[] }[] {
  return CONTEXT_GROUP_ORDER.map((group) => ({ group, actions: actions.filter((a) => a.group === group) })).filter((g) => g.actions.length > 0);
}
