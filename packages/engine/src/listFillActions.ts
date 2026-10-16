import type {
  Condition, ListFillDestination, ListFillMethod, ListFillOption, OptionMask, Question, SurveyDefinition, UnusedDestinationRule,
} from "@rescript/schema";
import { ListFill, UnusedDestinationRule as UnusedRule } from "@rescript/schema";
import type { IdMinter } from "./questionOps.js";
import type { CondInput } from "./surveyActions.js";
import { questionOrder } from "./dependencies.js";
import { listPages } from "./blocks.js";
import { listFillItemsAreRows } from "./listFill.js";
import { lintLoops } from "./lintLogic.js";
import { stripHtmlText } from "./html.js";

/*
 * LIST FILL AS COPILOT ACTIONS (P0, 2026-10-16).
 *
 * Intelligent Mode had no way to create a List Fill, so "show the brands
 * rated 3–5 in Q38, four of them at random, Apple first" became a mask with
 * an invented expression. These three ops write `def.listFills[]` — the same
 * object the List Fill panel edits, the runtime allocates and the exports
 * declare — from a friendly shape the ENGINE resolves: question codes,
 * variable names and labels become ids and option codes here, never in the
 * model. Anything that cannot be resolved, or that the engine cannot do, is
 * refused with the reason; nothing is approximated silently.
 *
 *   create_list_fill  name, source, eligible, count, method, priority,
 *                     always, destinations, whenUnused, runWhen …
 *   update_list_fill  the same fields, partially; `newName` renames
 *   remove_list_fill  removes the list and what it set up on its destinations
 *
 * A destination is one of three things, decided by what the question can hold:
 *
 *   show     the question's own options (or a grid's rows) are masked to the
 *            allocated items — "Q38 ranks the four brands" — and the question
 *            is hidden when nothing qualifies (`whenUnused`, default hide)
 *   answer   position n's code is written as the question's answer
 *   piping   position n is only piped ({{LISTFILL_<NAME>_n}})
 */

/* ------------------------------------------------------------ the shapes */

export type ListFillSourceInput =
  | string
  | { question: string; take?: "selected" | "displayed" | "all" }
  | { items: (string | { label: string; code?: string | number })[] }
  | { listFill: string }
  | { calculation: string }
  | { embedded: string };

/** A grid's per-row rule: rows whose answer is ≥ minValue / ≤ maxValue / one of `answers` (scale codes or labels). */
export interface ListFillEligibleInput { minValue?: number; maxValue?: number; answers?: (string | number)[] }
export interface ListFillDestinationInput { question: string; as?: "show" | "answer" | "piping"; position?: number; whenUnused?: UnusedDestinationRule }

export interface ListFillSpec {
  label?: string;
  enabled?: boolean;
  source?: ListFillSourceInput;
  eligible?: ListFillEligibleInput | null;
  /** per item (label or code) → a condition the item additionally needs */
  eligibleWhen?: Record<string, CondInput>;
  count?: number | "all" | { question: string };
  allIfAtMost?: number | null;
  method?: ListFillMethod;
  priority?: Record<string, number> | null;
  always?: string[];
  maximum?: Record<string, number>;
  target?: Record<string, number>;
  weight?: Record<string, number>;
  trackSample?: boolean;
  destinations?: (string | ListFillDestinationInput)[];
  whenUnused?: UnusedDestinationRule;
  runWhen?: CondInput | null;
}

export type ListFillAction =
  | ({ op: "create_list_fill"; name: string } & ListFillSpec)
  | ({ op: "update_list_fill"; listFill: string; newName?: string } & ListFillSpec)
  | { op: "remove_list_fill"; listFill: string };

export const LIST_FILL_ACTION_OPS = ["create_list_fill", "update_list_fill", "remove_list_fill"] as const;
const OPS = new Set<string>(LIST_FILL_ACTION_OPS);
export const isListFillOp = (op: string): boolean => OPS.has(op);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.trim())) ? Number(v.trim()) : undefined);
const cond = (v: unknown): CondInput | undefined => (typeof v === "string" && v.trim() ? v.trim() : v && typeof v === "object" && !Array.isArray(v) ? (v as Condition) : undefined);
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** the methods this action accepts, with the words people use for them */
const METHOD_ALIASES: Record<string, ListFillMethod> = {
  random: "random", randomly: "random", random_n: "random",
  priority: "highest_priority", priority_order: "highest_priority", highest_priority: "highest_priority", lowest_priority: "lowest_priority",
  priority_random: "priority_random", random_with_priority: "priority_random", priority_then_random: "priority_random",
  least_fill: "balanced_random", least_filled: "balanced_random", least_fills: "balanced_random", balanced: "balanced_random", balanced_random: "balanced_random",
  priority_quota: "priority_quota", quota_aware_random: "quota_aware_random", most_remaining: "quota_aware_random",
  selection_order: "selection_order", in_order: "selection_order", first_selected: "first_selected", rank_order: "selection_order",
  weighted_random: "weighted_random", weighted: "weighted_random",
};
/** methods that ignore per-item priority — a priority given with one of these would be silently dead */
const IGNORES_PRIORITY = new Set<ListFillMethod>(["random", "weighted_random", "balanced_random", "quota_aware_random", "selection_order", "first_selected"]);
/** methods that read the sample-level counters */
const NEEDS_COUNTS = new Set<ListFillMethod>(["balanced_random", "quota_aware_random", "priority_quota"]);
const UNUSED = new Set<string>(UnusedRule.options);

function numMap(v: unknown, what: string): Record<string, number> | string | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return `${what} is a map of item (label or code) → number, e.g. {"Apple": 1}`;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const n = num(x);
    if (n === undefined || !Number.isInteger(n) || n < 0) return `${what} of “${k}” must be a whole number of 0 or more`;
    out[k] = n;
  }
  return out;
}

function sourceOf(v: unknown): ListFillSourceInput | { error: string } | undefined {
  if (v === undefined) return undefined;
  const err = (error: string) => ({ error });
  if (typeof v === "string" || typeof v === "number") return str(v) ?? err("source names the question the list comes from");
  if (!v || typeof v !== "object" || Array.isArray(v)) return err("source is a question code, {question, take}, {items: [...]}, {listFill}, {calculation} or {embedded}");
  const o = v as Record<string, unknown>;
  if (o.question !== undefined || o.ref !== undefined) {
    const question = str(o.question ?? o.ref, 80);
    if (!question) return err("source.question names the question the list comes from");
    const take = str(o.take ?? o.which)?.toLowerCase();
    if (take && !["selected", "displayed", "all"].includes(take)) return err(`source.take is selected, displayed or all — not “${take}”`);
    return { question, ...(take ? { take: take as "selected" | "displayed" | "all" } : {}) };
  }
  if (Array.isArray(o.items)) {
    const items: (string | { label: string; code?: string | number })[] = [];
    for (const x of o.items) {
      if (typeof x === "string" && x.trim()) items.push(x.trim());
      else if (x && typeof x === "object" && str((x as Record<string, unknown>).label)) {
        const code = (x as Record<string, unknown>).code;
        items.push({ label: str((x as Record<string, unknown>).label)!, ...(typeof code === "string" || typeof code === "number" ? { code } : {}) });
      } else return err("each source item is a label or {label, code}");
    }
    if (!items.length) return err("a static source needs at least one item");
    return { items };
  }
  if (str(o.listFill)) return { listFill: str(o.listFill)! };
  if (str(o.calculation)) return { calculation: str(o.calculation)! };
  if (str(o.embedded)) return { embedded: str(o.embedded)! };
  if (o.script !== undefined) return err("a script source is not supported here: nothing in the engine runs the script (it reads a calculated variable of the same name) — use a calculation source");
  return err("source is a question code, {question, take}, {items: [...]}, {listFill}, {calculation} or {embedded}");
}

function eligibleOf(v: unknown): ListFillEligibleInput | null | string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "eligible is {minValue}, {maxValue} or {answers: [...]} — the per-row rule of a grid source";
  const o = v as Record<string, unknown>;
  if (o.when !== undefined || o.condition !== undefined) {
    return "eligible.when is not a per-item rule (a condition cannot say “this row”) — for a grid source write {minValue: 3} or {answers: [3, 4, 5]}; for one item give eligibleWhen: {\"Apple\": \"<condition>\"}";
  }
  const minValue = num(o.minValue ?? o.min ?? o.atLeast), maxValue = num(o.maxValue ?? o.max ?? o.atMost);
  const raw = o.answers ?? o.values ?? o.codes ?? o.rowsAnswered ?? o.ratedAs;
  const answers = Array.isArray(raw) ? raw.filter((x): x is string | number => typeof x === "string" || typeof x === "number") : undefined;
  if (minValue === undefined && maxValue === undefined && !answers?.length) return "eligible needs minValue, maxValue or answers (the scale points that qualify a row)";
  if (answers?.length && (minValue !== undefined || maxValue !== undefined)) return "give eligible either answers or a minValue/maxValue range, not both";
  if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) return `eligible.minValue ${minValue} is above maxValue ${maxValue}`;
  return { ...(minValue !== undefined ? { minValue } : {}), ...(maxValue !== undefined ? { maxValue } : {}), ...(answers?.length ? { answers } : {}) };
}

function destinationsOf(v: unknown, whenUnusedDefault?: UnusedDestinationRule): (string | ListFillDestinationInput)[] | string | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  const out: (string | ListFillDestinationInput)[] = [];
  for (const x of list) {
    if (typeof x === "string" || typeof x === "number") { out.push(str(x)!); continue; }
    if (!x || typeof x !== "object") return "each destination is a question code or {question, as, position, whenUnused}";
    const o = x as Record<string, unknown>;
    const question = str(o.question ?? o.target ?? o.ref, 80);
    if (!question) return "each destination names its question";
    const as = str(o.as ?? o.write ?? o.mode)?.toLowerCase().replace(/^piping_only$|^pipe$/, "piping").replace(/^display$|^options$|^mask$/, "show");
    if (as && !["show", "answer", "piping"].includes(as)) return `a destination is shown (show), answered (answer) or piped (piping) — not “${as}”`;
    const position = num(o.position);
    if (position !== undefined && (!Number.isInteger(position) || position < 1)) return "a destination's position is 1 or more";
    const wu = str(o.whenUnused ?? o.when_unused)?.toLowerCase() ?? whenUnusedDefault;
    if (wu && !UNUSED.has(wu)) return `whenUnused is one of ${[...UNUSED].join(", ")} — not “${wu}”`;
    out.push({ question, ...(as ? { as: as as "show" | "answer" | "piping" } : {}), ...(position !== undefined ? { position } : {}), ...(wu ? { whenUnused: wu as UnusedDestinationRule } : {}) });
  }
  return out;
}

/** shared by create and update: every field, checked, or the reason it is refused */
function specOf(o: Record<string, unknown>, partial: boolean): ListFillSpec | string {
  // the settings the engine stores and never reads (METHOD-11/12) are refused rather than written
  if (o.allowDuplicates === true) return "allowDuplicates is not supported: the engine never gives one respondent the same item twice";
  if (o.fillToCount === false) return "fillToCount: false has no effect in the engine (it always fills to the count from what is eligible) — leave it out";
  if (o.afterMaximum !== undefined || o.fallback !== undefined) return "afterMaximum and fallback are not settable here: the engine does not act on them yet — leave them out";
  if (o.repeatBlock !== undefined || o.repeatBlockId !== undefined) return "repeating a block per item is a loop over the List Fill, not a List Fill setting (repeatBlockId is not read by the flow) — create the list, then loop over LISTFILL(<name>)";
  if (o.scriptId !== undefined) return "a custom script method is not supported: nothing runs the script in the engine";
  const spec: ListFillSpec = {};
  const label = str(o.label ?? o.title, 200); if (label) spec.label = label;
  if (typeof o.enabled === "boolean") spec.enabled = o.enabled;
  const src = sourceOf(o.source ?? o.from);
  if (src && typeof src === "object" && "error" in src) return src.error;
  if (src !== undefined) spec.source = src;
  if (!partial && spec.source === undefined) return "create_list_fill needs a source (a question code, {question, take}, or {items: [...]})";
  const el = eligibleOf(o.eligible ?? o.eligibility); if (typeof el === "string") return el; if (el !== undefined) spec.eligible = el;
  if (o.eligibleWhen !== undefined) {
    if (!o.eligibleWhen || typeof o.eligibleWhen !== "object" || Array.isArray(o.eligibleWhen)) return "eligibleWhen is a map of item → condition";
    const m: Record<string, CondInput> = {};
    for (const [k, c] of Object.entries(o.eligibleWhen as Record<string, unknown>)) { const cc = cond(c); if (!cc) return `eligibleWhen of “${k}” is not a condition`; m[k] = cc; }
    spec.eligibleWhen = m;
  }
  const rawCount = o.count ?? o.n ?? o.take_n;
  if (rawCount !== undefined) {
    if (typeof rawCount === "string" && /^all$/i.test(rawCount.trim())) spec.count = "all";
    else if (rawCount && typeof rawCount === "object" && !Array.isArray(rawCount) && str((rawCount as Record<string, unknown>).question)) spec.count = { question: str((rawCount as Record<string, unknown>).question)! };
    else {
      const n = num(rawCount);
      if (n === undefined) return `count is a number, "all", or {question} — not ${JSON.stringify(rawCount)} (an expression count is not evaluated by the engine)`;
      if (!Number.isInteger(n) || n < 1) return "count must be a whole number of 1 or more";
      spec.count = n;
    }
  }
  if (o.allIfAtMost === null) spec.allIfAtMost = null;
  else if (o.allIfAtMost !== undefined || o.allUpTo !== undefined) {
    const n = num(o.allIfAtMost ?? o.allUpTo);
    if (n === undefined || !Number.isInteger(n) || n < 1) return "allIfAtMost is a whole number: when that many or fewer items qualify, all of them are taken";
    spec.allIfAtMost = n;
  }
  const m = str(o.method ?? o.strategy)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (m) {
    if (m === "custom") return "method custom needs a script and nothing in the engine runs one — choose priority_random, random, highest_priority or least_fill";
    const method = METHOD_ALIASES[m];
    if (!method) return `“${m}” is not a List Fill method — random, priority_random, highest_priority, lowest_priority, least_fill (balanced), selection_order, weighted_random`;
    spec.method = method;
  }
  if (o.priority === null) spec.priority = null;
  else { const p = numMap(o.priority ?? o.priorities, "priority"); if (typeof p === "string") return p; if (p) spec.priority = p; }
  if (o.always === null) return "always cannot be cleared on its own — give the item's eligibility and priority again (eligible / priority)";
  else if (o.always !== undefined) {
    const list = Array.isArray(o.always) ? o.always : [o.always];
    const items = list.map((x) => str(x, 120)).filter((x): x is string => !!x);
    if (!items.length) return "always lists the items (labels or codes) that are always included";
    spec.always = items;
  }
  for (const k of ["maximum", "target", "weight"] as const) {
    const v = numMap(o[k] ?? (k === "maximum" ? o.caps ?? o.max_per_item : undefined), k); if (typeof v === "string") return v; if (v) spec[k] = v;
  }
  if (typeof o.trackSample === "boolean") spec.trackSample = o.trackSample;
  const wu = str(o.whenUnused ?? o.when_unused)?.toLowerCase();
  if (wu) { if (!UNUSED.has(wu)) return `whenUnused is one of ${[...UNUSED].join(", ")} — not “${wu}”`; spec.whenUnused = wu as UnusedDestinationRule; }
  const d = destinationsOf(o.destinations ?? o.destination ?? o.into ?? o.to); if (typeof d === "string") return d; if (d) spec.destinations = d;
  if (o.runWhen === null) spec.runWhen = null; else { const rw = cond(o.runWhen ?? o.when); if (rw) spec.runWhen = rw; }
  return spec;
}

export function coerceListFillAction(op: string, o: Record<string, unknown>): ListFillAction | string | null {
  if (!isListFillOp(op)) return null;
  switch (op) {
    case "create_list_fill": {
      const name = str(o.name ?? o.listFill ?? o.id, 40);
      if (!name) return "create_list_fill needs a name (used in LISTFILL_<NAME>_1 …)";
      if (!NAME_RE.test(name)) return `“${name}” is not a List Fill name — letters, digits and underscores, starting with a letter`;
      const spec = specOf(o, false); if (typeof spec === "string") return spec;
      return { op, name, ...spec };
    }
    case "update_list_fill": {
      const listFill = str(o.listFill ?? o.target ?? o.name, 80);
      if (!listFill) return "update_list_fill needs the List Fill (by name or id)";
      const newName = str(o.newName ?? o.rename, 40);
      if (newName && !NAME_RE.test(newName)) return `“${newName}” is not a List Fill name — letters, digits and underscores, starting with a letter`;
      const spec = specOf(o, true); if (typeof spec === "string") return spec;
      if (!newName && !Object.keys(spec).length) return "update_list_fill changes nothing";
      return { op, listFill, ...(newName ? { newName } : {}), ...spec };
    }
    case "remove_list_fill": {
      const listFill = str(o.listFill ?? o.target ?? o.name, 80);
      if (!listFill) return "remove_list_fill needs the List Fill (by name or id)";
      return { op, listFill };
    }
  }
  return null;
}

/* ------------------------------------------------------------ applying */

export interface ListFillEnv {
  question(ref: string): Question | undefined;
  condition(input: CondInput): Condition;
  ids: IdMinter;
}
export interface ListFillApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const words = (s: string) => stripHtmlText(s).trim();
const norm = (s: string) => words(s).toLowerCase().replace(/\s+/g, " ");
const keyOf = (name: string) => `LISTFILL_${name.toUpperCase()}`;

type LF = ListFill;
interface Item { code: string; label: string }

export function findListFill(def: SurveyDefinition, ref: string): LF | undefined {
  const r = ref.trim().toLowerCase().replace(/^listfill\(|\)$/g, "").replace(/^listfill_/, "");
  return (def.listFills ?? []).find((l) => l.id.toLowerCase() === r) ?? (def.listFills ?? []).find((l) => (l.name ?? "").toLowerCase() === r);
}
const listFillOrFail = (def: SurveyDefinition, ref: string): LF =>
  findListFill(def, ref) ?? fail(`there is no List Fill “${ref}”${def.listFills?.length ? ` — the List Fills are ${def.listFills.map((l) => l.name ?? l.id).join(", ")}` : ""}`);

/** a question's list items: a grid's rows, otherwise its options (through a carry-forward chain when it has none of its own) */
function questionItems(def: SurveyDefinition, q: Question, seen = new Set<string>()): Item[] {
  if (listFillItemsAreRows(q)) return q.rows.map((r) => ({ code: String(r.code), label: words(r.label) }));
  if (q.options.length) return q.options.map((o) => ({ code: String(o.code), label: words(o.label) }));
  const cf = q.carryForward;
  if (cf && !seen.has(q.id)) {
    seen.add(q.id);
    const src = def.questions.find((x) => x.id === cf.sourceQuestionId);
    if (src) return questionItems(def, src, seen);
  }
  return [];
}

interface ResolvedSource { source: LF["source"]; items: Item[]; question?: Question; grid: boolean; words: string; itemsKnown: boolean }

function resolveSource(def: SurveyDefinition, input: ListFillSourceInput, env: ListFillEnv, hasRule: boolean, self?: LF): ResolvedSource {
  if (typeof input === "string" || "question" in input) {
    const ref = typeof input === "string" ? input : input.question;
    const q = env.question(ref) ?? fail(`there is no question “${ref}” to take the list from`);
    const grid = listFillItemsAreRows(q);
    const items = questionItems(def, q);
    if (!items.length) fail(`${q.code} is a ${q.type.replace(/_/g, " ")} question with no options or rows — a List Fill needs a list to choose from`);
    const asked = typeof input === "string" ? undefined : input.take;
    // a grid with a per-row rule reads every row (an unanswered row simply fails the rule); otherwise what was answered
    const take = asked ?? (grid && hasRule ? "all" : "selected");
    const what = grid ? (take === "all" ? "rows" : take === "displayed" ? "displayed rows" : "answered rows") : take === "all" ? "options" : take === "displayed" ? "displayed options" : "selected options";
    return { source: { kind: "question", questionId: q.id, take }, items, question: q, grid, words: `${q.code} ${what}`, itemsKnown: true };
  }
  if ("items" in input) {
    const used = new Set<string>();
    const items = input.items.map((x, i) => {
      const label = typeof x === "string" ? x : x.label;
      const code = typeof x === "string" || x.code === undefined ? String(i + 1) : String(x.code);
      if (used.has(code)) fail(`the static list has the code ${code} twice`);
      used.add(code);
      return { code, label };
    });
    return { source: { kind: "static", items }, items, grid: false, words: `a list of ${plural(items.length, "item")}`, itemsKnown: true };
  }
  if ("listFill" in input) {
    const other = listFillOrFail(def, input.listFill);
    if (self && other.id === self.id) fail("a List Fill cannot take its list from itself");
    const os = other.source;
    const srcQ = os.kind === "question" ? def.questions.find((x) => x.id === os.questionId) : undefined;
    const items: Item[] = other.options.length
      ? other.options.map((o) => ({ code: String(o.code), label: o.label ?? String(o.code) }))
      : srcQ ? questionItems(def, srcQ)
        : os.kind === "static" ? os.items.map((x) => ({ code: String(x.code), label: x.label })) : [];
    return { source: { kind: "listFill", listFillId: other.id }, items, grid: false, words: `what ${other.name ?? other.id} allocated`, itemsKnown: items.length > 0 };
  }
  if ("calculation" in input) {
    const name = input.calculation;
    if (!(def.calculations ?? []).some((c) => c.targetVariable === name || c.id === name)) fail(`there is no calculation “${name}”`);
    return { source: { kind: "calculation", ref: name }, items: [], grid: false, words: `calculation ${name}`, itemsKnown: false };
  }
  const name = (input as { embedded: string }).embedded;
  return { source: { kind: "embedded", ref: name }, items: [], grid: false, words: `embedded field ${name}`, itemsKnown: false };
}

function resolveItem(src: ResolvedSource, ref: string, what: string): Item {
  const r = norm(ref);
  if (!src.itemsKnown) return { code: ref, label: ref };
  const hit = src.items.find((i) => i.code.toLowerCase() === r) ?? src.items.find((i) => norm(i.label) === r);
  return hit ?? fail(`${what}: “${ref}” is not an item of ${src.words.split(" ")[0]} — the items are ${src.items.slice(0, 20).map((i) => `${i.code}=${i.label}`).join(", ")}${src.items.length > 20 ? ", …" : ""}`);
}

/** the per-row rule of a grid source, as one condition per row */
function rowRule(src: ResolvedSource, rule: ListFillEligibleInput): { make: (rowCode: string) => Condition; words: string } {
  const q = src.question;
  if (!q || !src.grid) fail(`minValue / maxValue / answers qualify the ROWS of a grid by their answer — ${q ? `${q.code} is a ${q.type.replace(/_/g, " ")} question, and what was selected is its list already` : "this source is not a question"}; use eligibleWhen for a per-item condition`);
  const g = q!;
  const scale = g.options.map((o) => ({ code: String(o.code), label: words(o.label) }));
  const multi = /multi/.test(g.type);
  const ref = { kind: "question" as const, ref: g.id };
  if (rule.answers?.length) {
    const codes = rule.answers.map((a) => {
      const r = norm(String(a));
      const hit = scale.find((s) => s.code.toLowerCase() === r) ?? scale.find((s) => norm(s.label) === r);
      return hit ?? fail(`${g.code}'s scale has no point “${a}” — its points are ${scale.map((s) => `${s.code}=${s.label}`).join(", ")}`);
    });
    const values = codes.map((c) => (Number.isFinite(Number(c.code)) ? Number(c.code) : c.code));
    return {
      make: (rowCode) => ({ type: "rule", source: { ...ref, rowCode }, operator: multi ? "containsAny" : "in", value: values } as Condition),
      words: `rated ${codes.map((c) => c.label).join(" / ")}`,
    };
  }
  if (multi) fail(`${g.code} lets a row hold several answers, so “at least ${rule.minValue ?? rule.maxValue}” has no single value to compare — list the qualifying answers instead (answers: [...])`);
  const numeric = scale.filter((s) => Number.isFinite(Number(s.code)));
  if (scale.length && numeric.length !== scale.length) fail(`${g.code}'s scale is not coded with numbers (${scale.map((s) => s.code).join(", ")}) — list the qualifying answers instead (answers: [...])`);
  const within = (n: number) => (rule.minValue === undefined || n >= rule.minValue) && (rule.maxValue === undefined || n <= rule.maxValue);
  const qualifying = numeric.filter((s) => within(Number(s.code)));
  if (scale.length && !qualifying.length) fail(`no point of ${g.code}'s scale (${scale.map((s) => s.code).join(", ")}) is ${rule.minValue !== undefined ? `≥ ${rule.minValue}` : ""}${rule.minValue !== undefined && rule.maxValue !== undefined ? " and " : ""}${rule.maxValue !== undefined ? `≤ ${rule.maxValue}` : ""} — no row could ever qualify`);
  const make = (rowCode: string): Condition =>
    rule.minValue !== undefined && rule.maxValue !== undefined
      ? ({ type: "rule", source: { ...ref, rowCode }, operator: "between", value: rule.minValue, value2: rule.maxValue } as Condition)
      : rule.minValue !== undefined
        ? ({ type: "rule", source: { ...ref, rowCode }, operator: "gte", value: rule.minValue } as Condition)
        : ({ type: "rule", source: { ...ref, rowCode }, operator: "lte", value: rule.maxValue } as Condition);
  const lo = qualifying[0], hi = qualifying[qualifying.length - 1];
  const range = lo && hi ? (lo === hi ? `${lo.code} (${lo.label})` : `${lo.code}–${hi.code} (${lo.label} … ${hi.label})`) : rule.minValue !== undefined ? `${rule.minValue} or more` : `${rule.maxValue} or less`;
  return { make, words: `rated ${range}` };
}

/** where a question sits: its top-level order index and its page */
function pageOf(def: SurveyDefinition, qid: string): string | undefined {
  return listPages(def.flow as never[]).find((p) => (p.node as { questionIds?: string[] }).questionIds?.includes(qid))?.node.id as string | undefined;
}

/** the destinations' "show" artefacts this list set up: masks on LISTFILL(<id>) and option logic reading LISTFILL_<NAME>_1_CODE */
function clearShowArtefacts(def: SurveyDefinition, lf: LF): string[] {
  const cleared: string[] = [];
  const first = `${keyOf(lf.name ?? lf.id)}_1_CODE`;
  for (const q of def.questions) {
    let touched = false;
    for (const k of ["mask", "rowMask"] as const) {
      const m = q[k] as OptionMask | undefined;
      if (m && m.expr.kind === "listFill" && (m.expr as { listFillId: string }).listFillId === lf.id) { delete (q as unknown as Record<string, unknown>)[k]; touched = true; }
    }
    for (const item of [...q.options, ...q.rows] as { logic?: Record<string, unknown> }[]) {
      if (!item.logic) continue;
      for (const k of ["prioritizeWhen", "randomizeWhen"]) {
        if (item.logic[k] && JSON.stringify(item.logic[k]).includes(`"${first}"`)) { delete item.logic[k]; touched = true; }
      }
    }
    if (touched) cleared.push(q.code);
  }
  return cleared;
}

/** is anything other than the question itself (and the flow that places it) reading this question? */
function questionIsReferenced(def: SurveyDefinition, q: Question, exceptListFill?: string): boolean {
  const rest = { ...def, questions: def.questions.filter((x) => x.id !== q.id), flow: [], listFills: (def.listFills ?? []).filter((l) => l.id !== exceptListFill) };
  return JSON.stringify(rest).includes(`"${q.id}"`);
}

/**
 * The destination must carry the list's codes. A grid's rows are coded r1…r10
 * and a ranking created from the same brand names is coded 1…10, so the
 * engine aligns them BY LABEL — recoding the destination's items to the
 * source's codes — but only when nothing else reads the destination yet.
 */
function alignCodes(def: SurveyDefinition, dest: Question, src: ResolvedSource, lfId: string | undefined): string | null {
  if (!src.itemsKnown) return null;
  // a destination that carries its items forward has the codes of whatever it carries
  if (dest.carryForward && !dest.options.length) return null;
  const rows = listFillItemsAreRows(dest);
  const items = (rows ? dest.rows : dest.options) as { code: string | number; label: string }[];
  const have = new Set(items.map((i) => String(i.code)));
  const missing = src.items.filter((i) => !have.has(i.code));
  if (!missing.length) return null;
  const map = new Map<{ code: string | number; label: string }, string>();
  for (const m of missing) {
    const hit = items.find((i) => norm(i.label) === norm(m.label) && !src.items.some((s) => s.code === String(i.code) && s !== m));
    if (!hit) fail(`${dest.code} has no ${rows ? "row" : "option"} for “${m.label}” (${m.code}) — a List Fill passes the source's items, so ${dest.code} must offer every one of them`);
    map.set(hit!, m.code);
  }
  if (questionIsReferenced(def, dest, lfId)) {
    fail(`${dest.code}'s ${rows ? "rows" : "options"} are coded ${[...map.keys()].slice(0, 3).map((i) => String(i.code)).join(", ")}… and the list's items ${[...map.values()].slice(0, 3).join(", ")}… — a List Fill passes the source's codes. ${dest.code} is already read by other logic, so it is not recoded here: recode its ${rows ? "rows" : "options"} to ${[...map.values()].slice(0, 3).join(", ")}… first (update_option)`);
  }
  const after = new Set(items.map((i) => (map.has(i) ? map.get(i)! : String(i.code))));
  if (after.size !== items.length) fail(`recoding ${dest.code} to the list's codes would give two ${rows ? "rows" : "options"} the same code`);
  for (const [i, c] of map) i.code = c;
  return `Recodes ${dest.code}'s ${rows ? "rows" : "options"} to ${src.words.split(" ")[0]}'s codes (${[...map.entries()].slice(0, 4).map(([i, c]) => `${i.label} → ${c}`).join(", ")}${map.size > 4 ? ", …" : ""}) so the allocated items match`;
}

interface Built { lf: LF; description: string; destructive: string[]; warnings: string[]; touched: string[] }

const SHOWABLE = (q: Question) => listFillItemsAreRows(q) || q.options.length > 0 || !!q.carryForward;

function build(def: SurveyDefinition, env: ListFillEnv, name: string, spec: ListFillSpec, prev?: LF): Built {
  const warnings: string[] = [], destructive: string[] = [], touched = new Set<string>();
  const id = prev?.id ?? env.ids("lf");
  /* -- source ------------------------------------------------------- */
  const hasRule = spec.eligible != null;
  const sourceChanged = spec.source !== undefined;
  let src: ResolvedSource;
  if (spec.source !== undefined) src = resolveSource(def, spec.source, env, hasRule, prev);
  else {
    // the list keeps its source: resolved again from the stored ids, its `take` unchanged
    const s = prev!.source;
    const byId: ListFillEnv = { ...env, question: (r) => def.questions.find((x) => x.id === r) ?? env.question(r) };
    const input: ListFillSourceInput = s.kind === "question" ? { question: s.questionId, take: s.take }
      : s.kind === "static" ? { items: s.items.map((i) => ({ label: i.label, code: i.code })) }
        : s.kind === "listFill" ? { listFill: s.listFillId }
          : s.kind === "calculation" ? { calculation: s.ref }
            : s.kind === "embedded" ? { embedded: s.ref }
              : fail("this List Fill's source (a script) cannot be edited here");
    src = resolveSource(def, input, byId, hasRule, prev);
  }
  if (src.question) touched.add(src.question.id);
  /* -- options: one entry per item ---------------------------------- */
  const prevOptions = !sourceChanged && prev ? prev.options.map((o) => ({ ...o })) : [];
  const options: ListFillOption[] = src.itemsKnown
    ? src.items.map((i) => ({ ...(prevOptions.find((o) => String(o.code) === i.code) ?? { code: i.code, eligible: true }), code: i.code, label: i.label }))
    : prevOptions;
  const optFor = (it: Item): ListFillOption => {
    let o = options.find((x) => String(x.code) === it.code);
    if (!o) { o = { code: it.code, label: it.label, eligible: true }; options.push(o); }
    return o;
  };
  if (sourceChanged && prev && prev.options.some((o) => o.eligibleWhen) && spec.eligible === undefined && !spec.eligibleWhen) {
    fail("the new source drops the old per-item eligibility — give eligible (or eligibleWhen) again for the new source");
  }
  /* -- eligibility --------------------------------------------------- */
  let ruleWords = "";
  if (spec.eligible === null) for (const o of options) delete o.eligibleWhen;
  else if (spec.eligible) {
    const r = rowRule(src, spec.eligible);
    ruleWords = r.words;
    for (const o of options) o.eligibleWhen = r.make(String(o.code));
  }
  for (const [ref, c] of Object.entries(spec.eligibleWhen ?? {})) optFor(resolveItem(src, ref, "eligibleWhen")).eligibleWhen = env.condition(c);
  /* -- caps, targets, weights ---------------------------------------- */
  for (const k of ["maximum", "target", "weight"] as const) {
    for (const [ref, n] of Object.entries(spec[k] ?? {})) optFor(resolveItem(src, ref, k))[k] = n;
  }
  /* -- priority and the always-included items ------------------------ */
  if (spec.priority !== undefined) for (const o of options) delete o.priority;
  for (const [ref, n] of Object.entries(spec.priority ?? {})) optFor(resolveItem(src, ref, "priority")).priority = n;
  const always = (spec.always ?? []).map((r) => resolveItem(src, r, "always"));
  if (always.length) {
    const take = src.source.kind === "question" ? src.source.take : "all";
    if (src.source.kind === "question" && !src.grid && take === "selected") {
      fail(`“always” items must be candidates whatever the respondent chose, but the list is ${src.words} — an unselected ${always[0].label} is not on it. Use source {question: "${src.question!.code}", take: "all"} with eligibleWhen per item, or leave “always” out and give ${always[0].label} priority 1`);
    }
    const min = Math.min(0, ...options.map((o) => o.priority ?? Number.MAX_SAFE_INTEGER).filter((p) => p !== Number.MAX_SAFE_INTEGER));
    for (const a of always) { const o = optFor(a); delete o.eligibleWhen; o.priority = Math.min(o.priority ?? min, min); }
  }
  /* -- selection ----------------------------------------------------- */
  const prevSel = prev?.selection;
  let count: LF["selection"]["count"] = prevSel?.count ?? { kind: "fixed", n: 1 };
  if (spec.count !== undefined) {
    if (spec.count === "all") count = { kind: "all" };
    else if (typeof spec.count === "object") {
      const q = env.question(spec.count.question) ?? fail(`there is no question “${spec.count.question}” to read the count from`);
      count = { kind: "question", questionId: q.id };
    } else count = { kind: "fixed", n: spec.count };
  } else if (!prev) count = { kind: "all" };
  if (spec.allIfAtMost !== undefined) {
    if (count.kind !== "fixed") fail("allIfAtMost goes with a fixed count (“if more than 5 qualify, take 4”)");
    const c = count as { kind: "fixed"; n: number; allUpTo?: number };
    if (spec.allIfAtMost === null) delete c.allUpTo;
    else {
      if (spec.allIfAtMost < c.n) fail(`allIfAtMost ${spec.allIfAtMost} is below the count ${c.n} — “take all when at most ${spec.allIfAtMost} qualify” would take fewer than ${c.n} when more qualify`);
      if (spec.allIfAtMost === c.n) { /* the same as a plain count */ } else c.allUpTo = spec.allIfAtMost;
    }
  }
  if (count.kind === "fixed" && src.itemsKnown && count.n > src.items.length) warnings.push(`List Fill ${name} asks for ${count.n} items but ${src.words.split(" ")[0]} has only ${src.items.length}.`);
  const prioritised = options.some((o) => o.priority != null);
  let method: ListFillMethod = spec.method ?? prevSel?.method ?? (prioritised ? "priority_random" : "random");
  // a priority given now, on a list whose method ignores it, means "priority first, random among the rest"
  if (!spec.method && prioritised && IGNORES_PRIORITY.has(method) && (spec.priority || spec.always)) method = "priority_random";
  if (prioritised && IGNORES_PRIORITY.has(method)) fail(`method ${method} ignores priority, so the priority given would do nothing — use priority_random (priority first, random among the rest) or highest_priority`);
  if (method === "weighted_random" && !options.some((o) => o.weight != null)) fail("weighted_random needs weights (weight: {item: n})");
  const caps = options.some((o) => o.maximum != null || o.target != null || o.minimum != null);
  // a per-respondent selector needs no counters; caps, targets and least-fill do
  const sampleLevel = spec.trackSample ?? (caps || NEEDS_COUNTS.has(method) || (prev?.tracking.sampleLevel ?? false));
  if (!sampleLevel && caps) fail("maximum / target per item count across the whole sample — they need trackSample: true");
  if (!sampleLevel && NEEDS_COUNTS.has(method)) fail(`method ${method} balances against the sample-level counts — it needs trackSample: true`);
  /* -- destinations -------------------------------------------------- */
  let destinations: ListFillDestination[] = prev?.destinations.map((d) => ({ ...d })) ?? [];
  const destWords: string[] = [];
  const nm = name;
  if (spec.destinations !== undefined) {
    if (prev) { const c = clearShowArtefacts(def, prev); if (c.length) destructive.push(`Replaces what List Fill ${prev.name ?? prev.id} set up on ${c.join(", ")}`); }
    destinations = [];
    const order = questionOrder(def);
    const srcAt = src.question ? order.indexOf(src.question.id) : -1;
    const srcPage = src.question ? pageOf(def, src.question.id) : undefined;
    let nextPos = 1;
    for (const raw of spec.destinations) {
      const d: ListFillDestinationInput = typeof raw === "string" ? { question: raw } : raw;
      const q = env.question(d.question) ?? fail(`there is no question “${d.question}” to put the list into`);
      if (src.question && q.id === src.question.id) fail(`${q.code} is the list's own source — the destination is the question that shows the result`);
      if (src.question && order.indexOf(q.id) <= srcAt) fail(`${q.code} is asked before ${src.question.code}, so the list is not decided yet when ${q.code} is shown — put the destination after the source`);
      if (srcPage && pageOf(def, q.id) === srcPage) fail(`${q.code} is on the same page as ${src.question!.code}; a List Fill runs when that page is submitted, so ${q.code} must be on a later page (page_break after ${src.question!.code})`);
      const as = d.as ?? (SHOWABLE(q) ? "show" : "piping");
      const whenUnused = d.whenUnused ?? spec.whenUnused;
      touched.add(q.id);
      if (as === "show") {
        if (!SHOWABLE(q)) fail(`${q.code} is a ${q.type.replace(/_/g, " ")} question with no options or rows to show the items as — pipe them instead ({question: "${q.code}", as: "piping"})`);
        if (d.position !== undefined) fail(`a “show” destination shows the whole list — position is for answer/piping destinations`);
        const recode = alignCodes(def, q, src, prev?.id);
        if (recode) destructive.push(recode);
        const key = listFillItemsAreRows(q) ? "rowMask" : "mask";
        const had = q[key] as OptionMask | undefined;
        if (had && !(had.expr.kind === "listFill" && (had.expr as { listFillId: string }).listFillId === id)) destructive.push(`Replaces the ${key === "rowMask" ? "row mask" : "mask"} of ${q.code}`);
        (q as unknown as Record<string, unknown>)[key] = { expr: { kind: "listFill", listFillId: id }, action: "display", keepAlwaysShow: true } as OptionMask;
        // hidden (or whatever was asked) when nothing qualifies: an empty ranking is not a question
        destinations.push({ questionId: q.id, position: 1, write: "piping_only", whenUnused: whenUnused ?? "hide" });
        // the top-priority items on top of the destination when they are allocated first
        const items = (key === "rowMask" ? q.rows : q.options) as { code: string | number; logic?: Record<string, unknown> }[];
        const firstItems = options.filter((o) => o.priority != null).sort((a, b) => a.priority! - b.priority!);
        const top = firstItems.length && (firstItems.length === 1 || firstItems[0].priority! < firstItems[1].priority!) ? firstItems[0] : undefined;
        if (top) {
          const at = items.findIndex((i) => String(i.code) === String(top.code));
          if (at > 0) {
            const it = items[at];
            if (it.logic?.prioritizeWhen) fail(`${q.code}'s “${top.label}” already has a move-to-top rule; it is not replaced here`);
            it.logic = { visibility: "default", ...(it.logic ?? {}), prioritizeWhen: { type: "rule", source: { kind: "variable", ref: `${keyOf(nm)}_1_CODE` }, operator: "eq", value: String(top.code) } };
          }
          const rnd = q.randomization as { enabled?: boolean } | undefined;
          if (rnd?.enabled) warnings.push(`${q.code} shuffles its ${key === "rowMask" ? "rows" : "options"}, so ${top.label} will not stay on top — anchor it or turn the randomization off if it must.`);
        }
        destWords.push(`${q.code} (shown as its ${key === "rowMask" ? "rows" : "options"}${(whenUnused ?? "hide") === "hide" ? "; hidden when nothing qualifies" : `; ${whenUnused} when nothing qualifies`})`);
      } else {
        if (as === "answer" && !SHOWABLE(q) && !/text|numeric|hidden|calculated/.test(q.type)) fail(`${q.code} cannot hold an item code as its answer`);
        if (as === "answer" && SHOWABLE(q)) { const recode = alignCodes(def, q, src, prev?.id); if (recode) destructive.push(recode); }
        const position = d.position ?? nextPos;
        if (d.position === undefined) nextPos++;
        destinations.push({ questionId: q.id, position, write: as === "answer" ? "answer" : "piping_only", ...(whenUnused ? { whenUnused } : {}) });
        if (as === "piping" && !JSON.stringify([q.text, q.instruction ?? ""]).includes(`${keyOf(nm)}_${position}`)) {
          warnings.push(`${q.code} does not pipe {{${keyOf(nm)}_${position}}} yet — add it to its text so the item shows.`);
        }
        destWords.push(`${q.code} (item ${position}${as === "answer" ? " as its answer" : " piped"}${whenUnused ? `; ${whenUnused} when unused` : ""})`);
      }
    }
  } else if (spec.whenUnused && prev) {
    for (const d of destinations) d.whenUnused = spec.whenUnused;
  }
  /* -- runWhen ------------------------------------------------------- */
  let runWhen = prev?.runWhen;
  if (spec.runWhen === null) runWhen = undefined;
  else if (spec.runWhen !== undefined) runWhen = env.condition(spec.runWhen);
  /* -- the object, through the schema -------------------------------- */
  const candidate = {
    id, name, ...(spec.label ?? prev?.label ? { label: spec.label ?? prev?.label } : {}),
    enabled: spec.enabled ?? prev?.enabled ?? true,
    source: src.source,
    selection: {
      ...(prevSel ?? {}),
      count, method,
      equalPriority: prevSel?.equalPriority ?? "random",
    },
    tracking: { ...(prev?.tracking ?? {}), sampleLevel, respectQuotas: sampleLevel ? prev?.tracking.respectQuotas ?? true : false },
    options,
    ...(runWhen ? { runWhen } : {}),
    destinations,
    storeTrace: prev?.storeTrace ?? true,
    ...(prev?.notes ? { notes: prev.notes } : {}),
  };
  const parsed = ListFill.safeParse(candidate);
  if (!parsed.success) fail(`the List Fill does not pass the schema at ${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`);
  const lf = parsed.data!;
  /* -- in words ------------------------------------------------------ */
  const itemsOf = (o: ListFillOption) => o.label ?? String(o.code);
  const tops = options.filter((o) => o.priority != null).sort((a, b) => a.priority! - b.priority!);
  const alwaysWords = always.length ? `${always.map((a) => a.label).join(", ")} always included${always.length === 1 ? " and first" : ""}` : "";
  const ranked = tops.filter((t) => !always.some((a) => a.code === String(t.code)));
  const prioWords = ranked.length ? `${always.length ? "then " : ""}${ranked.map(itemsOf).join(" > ")} first when eligible` : "";
  const countWords = count.kind === "fixed" ? `${plural(count.n, "item")}${(count as { allUpTo?: number }).allUpTo ? ` (all of them when ${(count as { allUpTo?: number }).allUpTo} or fewer qualify)` : ""}` : count.kind === "all" ? "every eligible item" : "as many items as the answer says";
  const methodWords = method === "priority_random" ? (tops.length ? "random among the rest" : "at random") : method === "random" ? "at random" : method === "balanced_random" ? "least-filled first" : method.replace(/_/g, " ");
  const parts = [
    `from ${src.words}${ruleWords ? ` ${ruleWords}` : ""}`,
    countWords,
    [alwaysWords, prioWords].filter(Boolean).join(", "),
    methodWords,
  ].filter(Boolean);
  const description = `List Fill ${name}: ${parts.join(", ")}${destWords.length ? `, into ${destWords.join(", ")}` : destinations.length ? "" : " — no destination yet (its items are LISTFILL_" + name.toUpperCase() + "_1 …)"}${runWhen ? ", only when its condition holds" : ""}${sampleLevel ? ", counted across the sample" : ""}`;
  return { lf, description, destructive, warnings, touched: [...touched] };
}

export function applyListFillAction(def: SurveyDefinition, a: ListFillAction, env: ListFillEnv): ListFillApplied {
  def.listFills = def.listFills ?? [];
  const loopBefore = new Set(lintLoops(def).map((i) => i.message));
  const finish = (r: { description: string; destructive?: string; warnings: string[]; touched: string[] }, name: string): ListFillApplied => {
    for (const i of lintLoops(def)) if (!loopBefore.has(i.message) && i.message.includes(`"${name}"`)) (i.level === "error" ? fail : (m: string) => r.warnings.push(m))(i.message);
    return r;
  };
  switch (a.op) {
    case "create_list_fill": {
      if (findListFill(def, a.name)) fail(`there is already a List Fill named ${a.name} — update_list_fill changes it`);
      const { op: _op, name, ...spec } = a;
      void _op;
      const b = build(def, env, name, spec);
      def.listFills = [...def.listFills, b.lf];
      return finish({ description: b.description, ...(b.destructive.length ? { destructive: b.destructive.join("; ") } : {}), warnings: b.warnings, touched: b.touched }, name);
    }
    case "update_list_fill": {
      const prev = listFillOrFail(def, a.listFill);
      const { op: _op, listFill: _lf, newName, ...spec } = a;
      void _op; void _lf;
      const oldName = prev.name ?? prev.id;
      let name = oldName;
      const destructive: string[] = [];
      if (newName && newName !== oldName) {
        if (findListFill(def, newName)) fail(`there is already a List Fill named ${newName}`);
        // every reference to the variables follows the rename: piping, conditions, the destinations' move-to-top rules
        const from = `${keyOf(oldName)}_`, to = `${keyOf(newName)}_`;
        const rewritten = JSON.parse(JSON.stringify({ ...def, listFills: [] }).split(from).join(to)) as SurveyDefinition;
        Object.assign(def, rewritten, { listFills: def.listFills });
        name = newName;
        destructive.push(`Renames the variables LISTFILL_${oldName.toUpperCase()}_* to LISTFILL_${newName.toUpperCase()}_* everywhere they are read`);
      }
      const b = build(def, env, name, spec, prev);
      def.listFills = def.listFills.map((l) => (l.id === prev.id ? b.lf : l));
      return finish({ description: b.description.replace(/^List Fill /, "List Fill now "), ...([...destructive, ...b.destructive].length ? { destructive: [...destructive, ...b.destructive].join("; ") } : {}), warnings: b.warnings, touched: b.touched }, name);
    }
    case "remove_list_fill": {
      const lf = listFillOrFail(def, a.listFill);
      const name = lf.name ?? lf.id;
      const cleared = clearShowArtefacts(def, lf);
      def.listFills = def.listFills.filter((l) => l.id !== lf.id);
      // what still reads it would silently go empty: refuse, naming it
      const readers: string[] = [];
      for (const q of def.questions) { const s = JSON.stringify(q); if (s.includes(`${keyOf(name)}_`) || s.includes(`"${lf.id}"`)) readers.push(q.code); }
      if (JSON.stringify(def.flow).includes(`"${lf.id}"`)) readers.push("a loop");
      for (const l of def.listFills) if (l.source.kind === "listFill" && l.source.listFillId === lf.id) readers.push(`List Fill ${l.name ?? l.id}`);
      if (JSON.stringify([def.calculations ?? [], def.quotas ?? [], def.displayRules ?? []]).includes(`${keyOf(name)}_`)) readers.push("calculations, quotas or display rules");
      if (readers.length) fail(`List Fill ${name} is still read by ${readers.join(", ")} — remove those references first`);
      return { description: `List Fill ${name} removed${cleared.length ? ` (and its mask on ${cleared.join(", ")})` : ""}`, destructive: `Removes List Fill ${name}${cleared.length ? ` and what it showed in ${cleared.join(", ")}` : ""}`, warnings: [], touched: [] };
    }
  }
}

export function describeListFillAction(a: ListFillAction): string {
  switch (a.op) {
    case "create_list_fill": return `Create List Fill ${a.name}`;
    case "update_list_fill": return `Change List Fill ${a.listFill}`;
    case "remove_list_fill": return `Remove List Fill ${a.listFill}`;
  }
}

/** Changes-panel lines for the List Fills */
export function listFillDiff(before: SurveyDefinition, after: SurveyDefinition): string[] {
  const out: string[] = [];
  const b = new Map((before.listFills ?? []).map((l) => [l.id, l]));
  const a = new Map((after.listFills ?? []).map((l) => [l.id, l]));
  for (const l of after.listFills ?? []) if (!b.has(l.id)) out.push(`Add List Fill ${l.name ?? l.id}`);
  for (const l of before.listFills ?? []) if (!a.has(l.id)) out.push(`Remove List Fill ${l.name ?? l.id}`);
  for (const l of after.listFills ?? []) { const p = b.get(l.id); if (p && JSON.stringify(p) !== JSON.stringify(l)) out.push(`Change List Fill ${l.name ?? l.id}`); }
  return out;
}
