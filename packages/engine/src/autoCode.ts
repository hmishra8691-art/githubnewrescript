/**
 * AUTOMATIC SEQUENTIAL QUESTION CODES (2026-11-13).
 *
 * A block switched to automatic coding (`autoCode: true` on its flow node) keeps its question codes in sequence:
 * the FIRST question's code sets the prefix (its letters), the run counts from 1 in the block's own order — or on
 * from an earlier automatic block with the same prefix — and every add, delete or move renumbers. Change the first code from S1 to Q1 and the block
 * becomes Q1, Q2, Q3.
 *
 *   which codes   only codes of the pattern <letters><number> that use the block's prefix (the first question's;
 *                 when the first code is retyped with a new prefix, the run that used the old one follows). A code written another way
 *                 (AGE, Q3a, PSM_CHEAP, a hidden H1 beside S-questions) is the programmer's and is left alone;
 *                 it does not take a number.
 *   references    each change goes through the engine's own rename (renameQuestionCode / renameVariable): display
 *                 logic, skips, branches, auto-punch, piping, calculations, embedded data, validation and flow
 *                 conditions follow. Answers are stored by the question's internal id, which never changes.
 *   variable      when a question's variable name was its code (Q2 / Q2), it follows the code; a variable named
 *                 separately is not touched.
 *   no clashes    a code already used by something outside the block is skipped (the sequence takes the next
 *                 free number), and codes are moved through temporary names so a swap (S1 ↔ S2) never collides.
 *   opt-in        blocks made before this have no `autoCode` and are never renumbered.
 */
import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import { listBlocks } from "./blocks.js";
import { renameQuestionCode } from "./renameCode.js";
import { renameVariable } from "./variableUsage.js";

const PATTERN = /^([A-Za-z_]+?)(\d+)$/;

export interface AutoCodeChange { questionId: string; from: string; to: string }
export interface AutoCodePlan { blockId: string; prefix: string; start: number; changes: AutoCodeChange[] }

const fold = (s: string) => s.toLowerCase();

/** every name a code could clash with, outside the given question ids */
function namesOutside(def: SurveyDefinition, inside: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const q of def.questions) {
    if (inside.has(q.id)) continue;
    if (q.code) out.add(fold(String(q.code)));
    if (q.variableName) out.add(fold(String(q.variableName)));
  }
  for (const c of def.calculations ?? []) if (c.targetVariable) out.add(fold(String(c.targetVariable)));
  for (const e of (def.embeddedData ?? []) as { name?: string }[]) if (e.name) out.add(fold(String(e.name)));
  const walk = (nodes: FlowNode[]) => { for (const n of nodes ?? []) { if (n.type === "embedded_data") for (const f of n.fields) out.add(fold(f.name)); const k = (n as { children?: FlowNode[] }).children; if (k) walk(k); for (const b of (n as { branches?: { children: FlowNode[] }[] }).branches ?? []) walk(b.children); const o = (n as { otherwise?: FlowNode[] }).otherwise; if (o) walk(o); } };
  walk(def.flow as FlowNode[]);
  return out;
}

export interface AutoCodeOptions {
  /** number this block even when it is not switched to automatic coding (the "renumber now" button) */
  force?: boolean;
  /** the prefix the block used before its first code was retyped (S, when S1 became Q1): that run follows the new prefix */
  adoptPrefix?: string;
  /** only this block (others keep their codes, which then count as taken) */
  only?: string;
  /** only these blocks — the ones an edit actually touched; every other block keeps its codes */
  onlyIds?: string[];
}

interface Member { questionId: string; code: string }

/** the questions of a block that belong to its run, and the run's prefix */
function membersOf(def: SurveyDefinition, blockId: string, adoptPrefix?: string): { prefix: string; members: Member[] } | null {
  const block = listBlocks(def.flow as unknown[]).find((b) => b.id === blockId);
  if (!block) return null;
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const qs = block.pages.flatMap((p) => p.node.questionIds as string[]).map((id) => byId.get(id)).filter((q): q is NonNullable<typeof q> => !!q);
  const patterned = qs.map((q) => ({ q, m: PATTERN.exec(String(q.code ?? "")) })).filter((x) => x.m);
  if (!patterned.length) return null;
  const prefix = patterned[0].m![1];
  /*
   * members: the first question's prefix — and, when the programmer has just retyped the first code with a new
   * prefix (S1 → Q1), the prefix it had (`adoptPrefix`), so the whole run follows. Never inferred: a hidden H1 beside
   * S-questions is not part of the S run.
   */
  const members = patterned.filter((x) => x.m![1] === prefix || (adoptPrefix !== undefined && x.m![1] === adoptPrefix)).map((x) => ({ questionId: x.q.id, code: String(x.q.code) }));
  return { prefix, members };
}

/**
 * What every automatic block's codes should be. Blocks are numbered in survey order and each prefix is ONE run
 * across the survey: a block starts at 1, or after the last number an earlier block gave the same prefix (a
 * screener in two blocks reads S1–S4, S5–S8), and a number something else already uses is passed over.
 */
export function autoCodePlans(def: SurveyDefinition, opts: AutoCodeOptions = {}): AutoCodePlan[] {
  const blocks = listBlocks(def.flow as unknown[]).filter((b) => (opts.only ? b.id === opts.only : true) && (!opts.onlyIds || opts.onlyIds.includes(b.id)) && (opts.force || (b.node as { autoCode?: boolean }).autoCode === true));
  const runs = blocks.map((b) => ({ id: b.id, run: membersOf(def, b.id, opts.only === b.id || !opts.only ? opts.adoptPrefix : undefined) })).filter((x): x is { id: string; run: NonNullable<ReturnType<typeof membersOf>> } => !!x.run);
  const inside = new Set(runs.flatMap((x) => x.run.members.map((m) => m.questionId)));
  const taken = namesOutside(def, inside);
  const next = new Map<string, number>();
  const plans: AutoCodePlan[] = [];
  for (const { id, run } of runs) {
    let n = next.get(fold(run.prefix)) ?? 1;
    const start = n;
    const changes: AutoCodeChange[] = [];
    for (const m of run.members) {
      while (taken.has(fold(`${run.prefix}${n}`))) n++;
      const to = `${run.prefix}${n}`;
      taken.add(fold(to));
      if (m.code !== to) changes.push({ questionId: m.questionId, from: m.code, to });
      n++;
    }
    next.set(fold(run.prefix), n);
    plans.push({ blockId: id, prefix: run.prefix, start, changes });
  }
  return plans;
}

/** one block's plan, or null when it has no pattern to follow (or is not automatic) */
export function blockAutoCodePlan(def: SurveyDefinition, blockId: string, opts: AutoCodeOptions = {}): AutoCodePlan | null {
  return autoCodePlans(def, { ...opts, only: blockId })[0] ?? null;
}

function rename(def: SurveyDefinition, questionId: string, to: string): SurveyDefinition | null {
  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return null;
  const from = String(q.code);
  if (from === to) return def;
  if (q.variableName === from) {
    const r = renameVariable(def, from, to, { alsoCode: true });
    if (r.ok) return r.def;
  }
  const r = renameQuestionCode(def, from, to);
  return (r as { problem?: string }).problem ? null : r.def;
}

export interface AutoCodeResult { def: SurveyDefinition; changes: AutoCodeChange[]; problems: string[] }

function applyPlans(input: SurveyDefinition, plans: AutoCodePlan[]): AutoCodeResult {
  const all = plans.flatMap((p) => p.changes);
  if (!all.length) return { def: input, changes: [], problems: [] };
  let def = input;
  const problems: string[] = [];
  const done: AutoCodeChange[] = [];
  /* through temporary names first, so S1 → S2 while S2 → S1 never meets itself */
  const taken = namesOutside(def, new Set());
  let t = 0;
  const temp = new Set<string>();
  for (const c of all) {
    let name = "";
    do { name = `ZZAUTO${++t}`; } while (taken.has(fold(name)));
    const next = rename(def, c.questionId, name);
    if (!next) { problems.push(`${c.from} could not be renumbered to ${c.to}`); continue; }
    def = next; temp.add(c.questionId);
  }
  for (const c of all) {
    if (!temp.has(c.questionId)) continue;
    const next = rename(def, c.questionId, c.to);
    if (!next) {
      /* never leave a temporary name behind: put the old code back */
      const back = rename(def, c.questionId, c.from);
      if (back) def = back;
      problems.push(`${c.from} could not be renumbered to ${c.to}`);
      continue;
    }
    def = next; done.push(c);
  }
  return { def, changes: done, problems };
}

/** renumber one block now (the input is not modified) */
export function applyBlockAutoCodes(input: SurveyDefinition, blockId: string, opts: AutoCodeOptions = {}): AutoCodeResult {
  return applyPlans(input, autoCodePlans(input, { ...opts, only: blockId }));
}

/** renumber every automatic block of the survey (the input is not modified; returned as it was when nothing moves) */
export function applyAutoCodes(input: SurveyDefinition, opts: Pick<AutoCodeOptions, "adoptPrefix"> = {}): AutoCodeResult {
  return applyPlans(input, autoCodePlans(input, opts));
}

/** the code a new question gets at the end of an automatic block: the next in its run (null when the block has no pattern yet) */
export function nextAutoCode(def: SurveyDefinition, blockId: string): string | null {
  const run = membersOf(def, blockId);
  if (!run) return null;
  const taken = namesOutside(def, new Set());
  const nums = run.members.map((m) => Number(PATTERN.exec(m.code)![2]));
  let n = Math.max(0, ...nums) + 1;
  while (taken.has(fold(`${run.prefix}${n}`))) n++;
  return `${run.prefix}${n}`;
}

/** the letters of a patterned code (S12 → "S"), or null */
export function codePrefix(code: string): string | null {
  const m = PATTERN.exec(String(code ?? ""));
  return m ? m[1] : null;
}

/**
 * AFTER AN EDIT IN THE BUILDER: renumber when the questions of an automatic block were added, removed or reordered
 * (or the block has just been switched to automatic) — not while a code is being typed, which changes no order.
 * Returns `next` itself when there is nothing to do.
 */
export function autoCodeAfterEdit(prev: SurveyDefinition, next: SurveyDefinition): AutoCodeResult {
  const sig = (def: SurveyDefinition) => new Map(listBlocks(def.flow as unknown[]).map((b) => [b.id, `${(b.node as { autoCode?: boolean }).autoCode === true ? "A" : "M"}|${b.pages.flatMap((p) => p.node.questionIds as string[]).join(",")}`]));
  const before = sig(prev);
  /*
   * ONLY THE BLOCKS THE EDIT TOUCHED (2026-11-14). Moving a block changes no block's own questions, so it renumbers
   * nothing; adding a question to one block renumbers that block and leaves every other block's codes as they are
   * (a number another block holds is passed over). A code never changes because of an edit somewhere else.
   */
  const touched: string[] = [];
  for (const [id, s] of sig(next)) if (s.startsWith("A") && before.get(id) !== s) touched.push(id);
  return touched.length ? applyPlans(next, autoCodePlans(next, { onlyIds: touched })) : { def: next, changes: [], problems: [] };
}
