import type { SurveyDefinition } from "@rescript/schema";
import { SurveyDefinition as SurveyDefinitionSchema } from "@rescript/schema";
import { applySurveyActions, diffSurveys, listBlocks, renumberNewQuestions, isUxOp, withoutPresentation, type SurveyAction, type ApplyActionsOutcome, type ActionResult, type SurveyDiff } from "@rescript/engine";
import type { CopilotReply, TurnMemory } from "./prompt.ts";

/**
 * THE COPILOT IN THE BROWSER — the pure part: proposals as chains of action
 * batches, the change history, memory, and linking survey objects in text.
 *
 * A PROPOSAL is the survey as it was (`base`) plus the action batches the
 * researcher has asked for since, not yet applied. "Reduce this to 20
 * questions" while a proposal is open REVISES the proposal — the next batch
 * is written against the proposed survey — so Review → Modify → Approve →
 * Apply is one conversation, and Apply is one edit. If the survey changed
 * underneath (an edit in another mode), the chain is replayed onto the
 * current survey: actions name objects by code, so they re-resolve, and
 * anything that no longer resolves is reported rather than guessed.
 */

/** `uxOnly`: the request was about the look and behaviour only — replays refuse structure exactly as the first run did */
export interface ProposalStep { request: string; actions: SurveyAction[]; uxOnly?: boolean }
export interface Proposal { base: SurveyDefinition; steps: ProposalStep[] }
/**
 * Where a FLAT action index sits: step `step`, action `action` of that step.
 * The review excludes actions by flat index — one number per action across
 * the whole chain — because that is what `changeItems` hands back in
 * `actionIndexes` when it is given results indexed the same way.
 */
export interface ActionRef { flat: number; step: number; action: number; op: string }
/** every action of the chain, numbered in order across the steps */
export function actionMap(p: Proposal): ActionRef[] {
  const out: ActionRef[] = [];
  p.steps.forEach((s, step) => s.actions.forEach((a, action) => out.push({ flat: out.length, step, action, op: a.op })));
  return out;
}
export interface ProposalState {
  after: SurveyDefinition;
  outcome: ApplyActionsOutcome;
  diff: SurveyDiff;
  /** every step's refused actions, with the step they came from */
  errors: string[];
  destructive: string[];
  warnings: string[];
  /** every step asked for look-and-behaviour only */
  uxOnly: boolean;
  /** only `ux` differs between the base and the result */
  structureUnchanged: boolean;
  /** what each applied UX action does, in words */
  uxNotes: string[];
  /**
   * Every evaluated action's result, its `index` rewritten to the action's
   * FLAT index in the chain (see `actionMap`). These come from the step-by-
   * step run that produced `after`, not from a separate whole-chain run: ids
   * are minted afresh on every apply, so only these results' `touched` ids
   * are the ids `after` actually holds — which is what `changeItems` matches
   * on to say which action made which change.
   */
  results: ActionResult[];
  /** the flat indexes left out of this evaluation (the review's unticked changes) */
  excluded: number[];
}

/**
 * The proposal applied to its base, step by step. `excluded` leaves actions
 * out by flat index — the after-state, the diff, the destructive list and the
 * end-state warnings are all of the INCLUDED actions only, and an included
 * action that needed an excluded one (a skip to a question no longer
 * created) is refused with the engine's reason, never guessed around.
 */
export function evaluateProposal(p: Proposal, opts: { excluded?: Iterable<number> } = {}): ProposalState {
  const excluded = new Set(opts.excluded ?? []);
  let cur = p.base;
  const errors: string[] = [], destructive: string[] = [], warnings: string[] = [];
  let last: ApplyActionsOutcome | null = null;
  const uxNotes: string[] = [];
  const results: ActionResult[] = [];
  const included: SurveyAction[] = [];
  let flat = 0;
  for (const step of p.steps) {
    // the step's included actions, and the flat index each one had in the whole chain
    const flats: number[] = [], actions: SurveyAction[] = [];
    for (const a of step.actions) { if (!excluded.has(flat)) { flats.push(flat); actions.push(a); } flat++; }
    if (!actions.length) continue;
    included.push(...actions);
    const r = applySurveyActions(cur, actions, { uxOnly: step.uxOnly });
    results.push(...r.results.map((x) => ({ ...x, index: flats[x.index] ?? x.index })));
    uxNotes.push(...r.results.filter((x) => x.ok && isUxOp(x.op)).map((x) => x.description));
    last = r;
    errors.push(...r.errors);
    destructive.push(...r.destructive);
    // the questions this proposal made are numbered in order after every step, so the next step (and the
    // model, which is shown this state) sees the same codes a replay produces
    if (r.valid) cur = renumberNewQuestions(p.base, r.def);
  }
  // warnings are about the END state: what the whole proposal newly breaks
  const uxOnly = p.steps.length > 0 && p.steps.every((s) => s.uxOnly);
  const whole = applySurveyActions(p.base, included, { uxOnly });
  warnings.push(...whole.warnings);
  const outcome = last ?? whole;
  const parsedBase = SurveyDefinitionSchema.safeParse(p.base);
  const structureUnchanged = sameSurvey(withoutPresentation(parsedBase.success ? parsedBase.data : p.base), withoutPresentation(cur));
  return { after: cur, outcome, diff: diffSurveys(p.base, cur), errors, destructive: [...new Set(destructive)], warnings: [...new Set(warnings)], uxOnly, structureUnchanged, uxNotes, results, excluded: [...excluded].sort((a, b) => a - b) };
}

/** the same chain on a different starting survey (the survey changed underneath the proposal) */
export function rebaseProposal(p: Proposal, current: SurveyDefinition): Proposal {
  return { base: current, steps: p.steps };
}

export const sameSurvey = (a: SurveyDefinition, b: SurveyDefinition) => a === b || JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------ history */

export interface ChangeRecord {
  n: number;
  at: string;
  request: string;
  summary: string[];
  created: string[];
  modified: string[];
  removed: string[];
  before: SurveyDefinition;
  after: SurveyDefinition;
  /** the store's undo label, so "Undo" knows whether this is still the last edit */
  label: string;
  reverted?: boolean;
  /** the proposed changes the researcher left out of this apply, in words ("Removed option 3 “None” from Q5") — absent when nothing was */
  excluded?: string[];
}
export function changeRecord(n: number, request: string, state: ProposalState, before: SurveyDefinition, at = new Date().toISOString(), excluded: string[] = []): ChangeRecord {
  const d = state.diff;
  const label = `AI change #${String(n).padStart(3, "0")}: ${d.summary[0] ?? request.slice(0, 60)}`;
  return {
    n, at, request, summary: d.summary, before, after: state.after, label, ...(excluded.length ? { excluded } : {}),
    created: [...d.blocksAdded.map((b) => `block “${b.title}”`), ...d.questionsAdded.map((q) => q.code), ...d.embeddedAdded.map((e) => `embedded ${e}`), ...d.calculationsAdded.map((c) => `calculation ${c}`), ...d.quotasAdded.map((q) => `quota “${q}”`), ...d.ux.added.map((x) => `${x.kind} “${x.label}” (${x.target})`)],
    modified: [...d.questionsModified.map((q) => q.code), ...d.blocksRenamed.map((b) => `block “${b.to}”`), ...d.ux.changed.map((x) => `${x.kind} “${x.label}”`), ...(d.theme.length ? [`theme (${d.theme.length} setting${d.theme.length === 1 ? "" : "s"})`] : [])],
    removed: [...d.questionsRemoved.map((q) => q.code), ...d.blocksRemoved.map((b) => `block “${b.title}”`), ...d.ux.removed.map((x) => `${x.kind} “${x.label}”`)],
  };
}
export const changeLabel = (n: number) => `AI Change #${String(n).padStart(3, "0")}`;

/* ------------------------------------------------------------ memory */

export interface MemoryTurn { user: string; reply?: CopilotReply | null }
/** what the next turn is told about this conversation: the model's own running memory, and the last six lines */
export function memoryFrom(turns: MemoryTurn[]): TurnMemory {
  const withMemory = [...turns].reverse().find((t) => t.reply?.memory);
  const history: TurnMemory["history"] = [];
  for (const t of turns.slice(-3)) {
    history.push({ role: "user", text: t.user.slice(0, 500) });
    if (t.reply) history.push({ role: "copilot", text: `${t.reply.reply}${t.reply.actions.length ? ` [proposed ${t.reply.actions.length} actions]` : ""}`.slice(0, 500) });
  }
  return { ...(withMemory?.reply?.memory ? { memory: withMemory.reply.memory } : {}), history };
}

/* ------------------------------------------------------------ links */

export type Segment = { text: string } | { text: string; questionId: string };
/**
 * Text with the survey's questions made clickable: "I found an issue in
 * Q14" — Q14 becomes a link to the question. Codes and variables are
 * matched as whole words; a word that is a code of no question stays text.
 */
export function linkify(text: string, def: SurveyDefinition): Segment[] {
  const byCode = new Map<string, string>(), byVar = new Map<string, string>();
  for (const q of def.questions) { byCode.set(String(q.code).toLowerCase(), q.id); byVar.set(q.variableName, q.id); }
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    // a code with a digit ("Q14", any case), or a variable written exactly as it is named and shaped like one ("PI", "BUY_6M") —
    // not every word that happens to be a variable ("buy")
    const w = m[0];
    const id = (/\d/.test(w) ? byCode.get(w.toLowerCase()) : undefined) ?? (/^[A-Z][A-Z0-9_]+$|_/.test(w) ? byVar.get(w) : undefined);
    if (!id) continue;
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], questionId: id });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/* ------------------------------------------------------------ structure, before and after */

export interface OutlineRow { kind: "block" | "question"; id: string; label: string; mark?: "added" | "modified" | "removed" | "moved" }
/** blocks and their questions, marked against a diff — the before/after picture */
export function structureRows(def: SurveyDefinition, diff?: SurveyDiff, side: "before" | "after" = "after"): OutlineRow[] {
  const added = new Set(diff?.questionsAdded.map((q) => q.id));
  const removed = new Set(diff?.questionsRemoved.map((q) => q.id));
  const modified = new Map(diff?.questionsModified.map((q) => [q.id, q]) ?? []);
  const blocksAdded = new Set(diff?.blocksAdded.map((b) => b.id));
  const blocksRemoved = new Set(diff?.blocksRemoved.map((b) => b.id));
  const rows: OutlineRow[] = [];
  const qOf = (id: string) => def.questions.find((q) => q.id === id);
  const placed = new Set<string>();
  for (const b of listBlocks(def.flow as unknown[])) {
    rows.push({ kind: "block", id: b.id, label: b.title ?? "Untitled block", ...(side === "after" && blocksAdded.has(b.id) ? { mark: "added" as const } : side === "before" && blocksRemoved.has(b.id) ? { mark: "removed" as const } : {}) });
    for (const p of b.pages) for (const id of p.node.questionIds) {
      const q = qOf(id); if (!q) continue;
      placed.add(id);
      const m = modified.get(id);
      const mark = side === "after" ? (added.has(id) ? "added" : m ? (m.changes.every((c) => c.field === "block") ? "moved" : "modified") : undefined) : removed.has(id) ? "removed" : m ? "modified" : undefined;
      rows.push({ kind: "question", id, label: `${q.code} ${plainText(q.text).slice(0, 70)}`, ...(mark ? { mark } : {}) });
    }
  }
  return rows;
}
const ENT: Record<string, string> = { amp: "&", nbsp: " ", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'" };
/** question text as a reader sees it: markup removed, entities decoded */
export const plainText = (s: string) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&(amp|nbsp|lt|gt|quot|#39|apos);/g, (_m, e: string) => ENT[e]).replace(/\s+/g, " ").trim();

/** the proposal's headline for the review card: "3 blocks · 12 questions · 2 skip conditions …" */
export function proposalCounts(diff: SurveyDiff, after: SurveyDefinition): { label: string; value: number }[] {
  const qs = diff.questionsAdded.map((x) => after.questions.find((q) => q.id === x.id)!).filter(Boolean);
  const inBlock = (re: RegExp) => diff.questionsAdded.filter((q) => q.block && re.test(q.block)).length;
  const scales = qs.filter((q) => /single_select|matrix/.test(q.type) && (q.options?.length ?? 0) >= 4 && q.options.every((o) => /^\d+$/.test(String(o.code)))).length;
  return [
    { label: "blocks", value: diff.blocksAdded.length },
    { label: "questions", value: diff.questionsAdded.length },
    { label: "screening questions", value: inBlock(/screen/i) },
    { label: "demographic questions", value: inBlock(/demograph|about you|profile/i) },
    { label: "scales", value: scales },
    { label: "display conditions", value: diff.displayLogic.added },
    { label: "skip conditions", value: diff.skips.added },
    { label: "randomizations", value: diff.randomizers + qs.filter((q) => q.randomization?.enabled).length },
    { label: "calculations", value: diff.calculationsAdded.length },
    { label: "quotas", value: diff.quotasAdded.length },
    { label: "questions changed", value: diff.questionsModified.length },
    { label: "questions removed", value: diff.questionsRemoved.length },
    { label: "styles", value: diff.ux.added.filter((x) => x.kind === "style").length },
    { label: "animations", value: diff.ux.added.filter((x) => x.kind === "animation").length },
    { label: "behaviours", value: diff.ux.added.filter((x) => x.kind === "behaviour").length },
    { label: "UX changes", value: diff.ux.changed.length + diff.ux.removed.length },
    { label: "theme settings", value: diff.theme.length },
  ].filter((c) => c.value > 0);
}

/* ------------------------------------------------------------ the UX preview */

export interface UxPreviewScope { questionIds: string[]; blockId?: string; pageId?: string; chrome: boolean }
/**
 * What the UX preview renders for a proposal: the questions its styles,
 * animations and behaviours touch (at most three), the block or page they
 * are scoped to — so a "Block 3" style shows on Block 3's questions — and the
 * survey chrome (buttons, progress) when an item targets it.
 */
export function uxPreviewScope(after: SurveyDefinition, diff: SurveyDiff): UxPreviewScope {
  const ids = new Set([...diff.ux.added, ...diff.ux.changed].map((x) => x.id));
  const ux = after.ux ?? { styles: [], animations: [], behaviors: [] };
  const targets = [...ux.styles, ...ux.animations, ...ux.behaviors].filter((x) => ids.has(x.id)).flatMap((x) => [x.target, ...("effects" in x ? x.effects.map((e) => e.target).filter((t): t is NonNullable<typeof t> => !!t) : [])]);
  const out: UxPreviewScope = { questionIds: [], chrome: false };
  const add = (id: string) => { if (!out.questionIds.includes(id) && out.questionIds.length < 3) out.questionIds.push(id); };
  const pages = listBlocks(after.flow as unknown[]);
  for (const t of targets) {
    if (t.questionId) add(t.questionId);
    if (t.blockId && !out.blockId) out.blockId = t.blockId;
    if (t.pageId && !out.pageId) out.pageId = t.pageId;
    if (["survey", "button", "progress", "navigation", "page", "block"].includes(t.kind)) out.chrome = true;
  }
  if (out.pageId && !out.questionIds.length) {
    for (const b of pages) for (const p of b.pages) if (p.node.id === out.pageId) { p.node.questionIds.forEach(add); if (!out.blockId) out.blockId = b.id; }
  }
  if (out.blockId && !out.questionIds.length) {
    const b = pages.find((x) => x.id === out.blockId);
    if (b) { b.pages[0]?.node.questionIds.forEach(add); if (!out.pageId) out.pageId = b.pages[0]?.node.id; }
  }
  if (diff.theme.length) out.chrome = true;
  if (!out.questionIds.length) after.questions.filter((q) => q.type !== "html").slice(0, 2).forEach((q) => add(q.id));
  // the block and page the first question lives on, so block- and page-scoped rules match as they will in the survey
  if (!out.blockId || !out.pageId) {
    const first = out.questionIds[0];
    for (const b of pages) for (const p of b.pages) if (first && p.node.questionIds.includes(first)) { out.blockId ??= b.id; out.pageId ??= p.node.id; }
  }
  return out;
}
