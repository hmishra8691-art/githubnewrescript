import type { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, diffSurveys, listBlocks, renumberNewQuestions, type SurveyAction, type ApplyActionsOutcome, type SurveyDiff } from "@rescript/engine";
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

export interface ProposalStep { request: string; actions: SurveyAction[] }
export interface Proposal { base: SurveyDefinition; steps: ProposalStep[] }
export interface ProposalState {
  after: SurveyDefinition;
  outcome: ApplyActionsOutcome;
  diff: SurveyDiff;
  /** every step's refused actions, with the step they came from */
  errors: string[];
  destructive: string[];
  warnings: string[];
}

export function evaluateProposal(p: Proposal): ProposalState {
  let cur = p.base;
  const errors: string[] = [], destructive: string[] = [], warnings: string[] = [];
  let last: ApplyActionsOutcome | null = null;
  for (const step of p.steps) {
    const r = applySurveyActions(cur, step.actions);
    last = r;
    errors.push(...r.errors);
    destructive.push(...r.destructive);
    // the questions this proposal made are numbered in order after every step, so the next step (and the
    // model, which is shown this state) sees the same codes a replay produces
    if (r.valid) cur = renumberNewQuestions(p.base, r.def);
  }
  // warnings are about the END state: what the whole proposal newly breaks
  const whole = applySurveyActions(p.base, p.steps.flatMap((s) => s.actions));
  warnings.push(...whole.warnings);
  const outcome = last ?? whole;
  return { after: cur, outcome, diff: diffSurveys(p.base, cur), errors, destructive: [...new Set(destructive)], warnings };
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
}
export function changeRecord(n: number, request: string, state: ProposalState, before: SurveyDefinition, at = new Date().toISOString()): ChangeRecord {
  const d = state.diff;
  const label = `AI change #${String(n).padStart(3, "0")}: ${d.summary[0] ?? request.slice(0, 60)}`;
  return {
    n, at, request, summary: d.summary, before, after: state.after, label,
    created: [...d.blocksAdded.map((b) => `block “${b.title}”`), ...d.questionsAdded.map((q) => q.code), ...d.embeddedAdded.map((e) => `embedded ${e}`), ...d.calculationsAdded.map((c) => `calculation ${c}`), ...d.quotasAdded.map((q) => `quota “${q}”`)],
    modified: [...d.questionsModified.map((q) => q.code), ...d.blocksRenamed.map((b) => `block “${b.to}”`)],
    removed: [...d.questionsRemoved.map((q) => q.code), ...d.blocksRemoved.map((b) => `block “${b.title}”`)],
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
  ].filter((c) => c.value > 0);
}
