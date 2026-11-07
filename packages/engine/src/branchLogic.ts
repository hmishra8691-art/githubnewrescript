import type { Condition, FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { listBlocks, type BlockRef } from "./blocks.js";
import { canDropFlowNode, findNode, locateNode, moveFlowNode, type MoveResult } from "./flowTree.js";
import { formatCondition } from "./logicExpression.js";

/**
 * BRANCHES THAT NAME THEMSELVES, AND PATHS THAT TAKE EXISTING BLOCKS (2026-11-07).
 *
 * One module for the Studio's flow card, the import, and Intelligent Mode — each of
 * them names, splits and fills a branch through these functions, so a branch made
 * by hand and one made by the copilot read alike and obey the same rules.
 *
 *   NAMING     a branch gets "Branch N" (unique in the survey) when it is created;
 *              a path gets a label from its condition ("Q1 = Product A") while the
 *              label is still the generated one, and keeps whatever a person typed.
 *              Labels are unique within the branch.
 *   SPLITTING  one path per answer option of a question ("split by Q1"), each named
 *              after its option, the branch named after the question.
 *   EXISTING   a path can take a block already in the survey — the WHOLE block,
 *              moved there with its pages, questions and logic (a node lives in one
 *              place in the flow; nothing is copied, so no answer is ever stored twice).
 *              A question inside a block is never taken on its own: the block is the
 *              unit of the flow. A block whose questions the branch's own conditions
 *              read, or that holds the branch, cannot go in.
 */

type BranchNode = Extract<FlowNode, { type: "branch" }>;
type Path = BranchNode["branches"][number];

const GENERIC_PATH = /^\s*path\s*\d+\s*$/i;
const GENERIC_BRANCH = /^\s*branch\s*\d*\s*$/i;

/** a label nobody chose — empty, or the "Path N" a new path is born with */
export function isGenericPathLabel(label: string | undefined | null): boolean {
  return !label || !label.trim() || GENERIC_PATH.test(label);
}
export function isGenericBranchTitle(title: string | undefined | null): boolean {
  return !title || !title.trim() || GENERIC_BRANCH.test(title);
}

function allBranches(flow: FlowNode[]): BranchNode[] {
  const out: BranchNode[] = [];
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes ?? []) {
      if (n.type === "branch") {
        out.push(n);
        for (const b of n.branches) walk(b.children);
        walk(n.otherwise ?? []);
      } else if ((n as { children?: FlowNode[] }).children) walk((n as { children: FlowNode[] }).children);
    }
  };
  walk(flow);
  return out;
}

/** `base`, or `base (2)`, `base (3)` … — the first spelling not in `taken` (case-insensitive) */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const t = new Set([...taken].map((x) => x.trim().toLowerCase()));
  if (!t.has(base.trim().toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const c = `${base} (${i})`;
    if (!t.has(c.toLowerCase())) return c;
  }
  return `${base} (${Date.now()})`;
}

/** "Branch N": one more than the highest number any branch in the flow already carries, never reused */
export function nextBranchTitle(flow: FlowNode[], exceptId?: string): string {
  const titles = allBranches(flow).filter((b) => b.id !== exceptId).map((b) => b.title ?? "");
  let max = 0;
  for (const t of titles) { const m = /^\s*branch\s*(\d+)\s*$/i.exec(t); if (m) max = Math.max(max, Number(m[1])); }
  return uniqueName(`Branch ${Math.max(max, titles.length) + 1}`, titles);
}

/** what a path's condition says, short enough for a label; "" when there is no condition yet */
export function pathLabelFromCondition(def: SurveyDefinition, when: Condition | undefined): string {
  if (!when) return "";
  let text = "";
  try { text = formatCondition(def, when, { width: 200 }).replace(/\s+/g, " ").trim(); } catch { text = ""; }
  if (!text) return "";
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
}

/** the label a path gets when nobody named it: its condition, else "Path N"; unique within the branch */
export function autoPathLabel(def: SurveyDefinition, node: BranchNode, index: number): string {
  const others = node.branches.filter((_, j) => j !== index).map((b) => b.label ?? "");
  const fromCond = pathLabelFromCondition(def, node.branches[index]?.when);
  return uniqueName(fromCond || `Path ${index + 1}`, others);
}

/**
 * Name a branch in place: a title when it has none, and every path whose label is still
 * generated (empty / "Path N" / the label its PREVIOUS condition generated) relabelled from
 * its condition. A label a person typed is never touched. Returns what was named.
 */
export function nameBranch(def: SurveyDefinition, node: BranchNode, opts: { previous?: BranchNode; flow?: FlowNode[] } = {}): { title?: string; paths: string[] } {
  const named: { title?: string; paths: string[] } = { paths: [] };
  if (!node.title || !node.title.trim()) {
    node.title = nextBranchTitle(opts.flow ?? (def.flow as FlowNode[]), node.id);
    named.title = node.title;
  }
  node.branches.forEach((b, i) => {
    const prev = opts.previous?.branches.find((x) => x.id === b.id);
    const prevAuto = prev ? pathLabelFromCondition(def, prev.when) : "";
    const wasAuto = isGenericPathLabel(b.label) || (prevAuto && b.label?.replace(/\s\(\d+\)$/, "") === prevAuto);
    if (!wasAuto) return;
    const next = autoPathLabel(def, node, i);
    if (next !== b.label) { b.label = next; named.paths.push(next); }
  });
  return named;
}

/** a fresh path's label: "Path N", unique in the branch */
export function newPathLabel(node: BranchNode): string {
  return uniqueName(`Path ${node.branches.length + 1}`, node.branches.map((b) => b.label ?? ""));
}

/** Name every branch in the flow that has no name (import, old surveys). Returns how many were touched. */
export function ensureBranchNames(def: SurveyDefinition): number {
  let n = 0;
  for (const b of allBranches(def.flow as FlowNode[])) {
    const r = nameBranch(def, b);
    if (r.title || r.paths.length) n++;
  }
  return n;
}

const CHOICE_TYPES = new Set(["single_choice", "multi_select", "dropdown", "rating", "nps", "likert", "yes_no", "image_choice", "button_choice", "single_select", "multiple_choice"]);

/**
 * SPLIT BY A QUESTION: one path per answer option, in option order, each testing "selected"
 * (one of them for a multi-select — first match wins, so order matters and is said so),
 * labelled with the option, and an OTHERWISE for "none of these / not answered".
 */
export function splitBranchByQuestion(
  def: SurveyDefinition, q: Question, ids: (prefix: string) => string,
  opts: { codes?: (string | number)[]; title?: string; flow?: FlowNode[] } = {},
): BranchNode | string {
  const options = (q.options ?? []).filter((o) => !opts.codes || opts.codes.map(String).includes(String(o.code)));
  if (!options.length) return `${q.code} has no answer options to split by — split by a choice question, or write each path's condition`;
  if (options.length > 30) return `${q.code} has ${options.length} options — a branch of more than 30 paths is not a branch; group the options first`;
  if (!CHOICE_TYPES.has(q.type) && !(q.options?.length)) return `${q.code} is ${q.type.replace(/_/g, " ")} — split by a question with options`;
  const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const taken: string[] = [];
  const branches: Path[] = options.map((o) => {
    const label = uniqueName(`${q.code} = ${plain(o.label).slice(0, 48) || o.code}`, taken);
    taken.push(label);
    return { id: ids("br"), label, when: { type: "rule", source: { kind: "question", ref: q.id }, operator: "selected", value: o.code } as unknown as Condition, children: [] };
  });
  const flow = opts.flow ?? (def.flow as FlowNode[]);
  const titles = allBranches(flow).map((b) => b.title ?? "");
  return { type: "branch", id: ids("branch"), title: uniqueName(opts.title?.trim() || `By ${q.code}`, titles), branches, otherwise: [] };
}

/* ------------------------------------------------------------------ existing blocks */

export interface BlockChoice {
  id: string;
  kind: "block";
  title: string;
  /** "Block 3" — the number the Studio shows */
  number: number;
  questionCodes: string[];
  selectable: boolean;
  /** why it cannot go into this path */
  reason?: string;
  /** where it is now, in words */
  where: string;
}
export interface QuestionChoice {
  id: string;
  kind: "question";
  code: string;
  text: string;
  blockId: string;
  blockTitle: string;
  /** a question is never taken on its own when it belongs to a block — always false, with the reason */
  selectable: false;
  reason: string;
}

/** the condition's question ids (every rule source of kind question / option) */
function readsOf(c: Condition | undefined, out: Set<string>): Set<string> {
  if (!c) return out;
  if (c.type === "group") { for (const k of c.children) readsOf(k, out); return out; }
  const src = c.source as { kind?: string; ref?: string };
  if (src && (src.kind === "question" || src.kind === undefined) && src.ref) out.add(src.ref);
  return out;
}

function blockQuestionIds(b: BlockRef): string[] {
  return b.pages.flatMap((p) => p.node.questionIds);
}

/**
 * What a path of `branchId` may take from the survey: every block, selectable or not with its
 * reason, and every question listed under its block — never selectable on its own.
 */
export function branchBlockChoices(def: SurveyDefinition, branchId: string, slot?: string): { blocks: BlockChoice[]; questions: QuestionChoice[]; note: string } {
  const flow = def.flow as FlowNode[];
  const branch = findNode(flow, branchId) as BranchNode | null;
  const blocks = listBlocks(flow as unknown[]);
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const reads = new Set<string>();
  if (branch) { for (const p of branch.branches) readsOf(p.when, reads); }
  const codeOf = (id: string) => String(qById.get(id)?.code ?? id);
  const out: BlockChoice[] = [];
  const questions: QuestionChoice[] = [];
  blocks.forEach((b, i) => {
    const title = b.title?.trim() || `Block ${i + 1}`;
    const qids = blockQuestionIds(b);
    const loc = locateNode(flow, b.id);
    let where = "top level of the flow";
    if (loc?.container.ownerId) {
      const owner = findNode(flow, loc.container.ownerId) as (FlowNode & { title?: string }) | null;
      const ownerName = owner ? (owner.title || owner.type) : "a container";
      if (loc.container.ownerId === branchId) {
        const path = branch?.branches.find((p) => `branch:${p.id}` === loc.container.slot);
        where = loc.container.slot === "otherwise" ? "this branch's OTHERWISE" : `this branch's path “${path?.label ?? "?"}”`;
      } else where = `inside ${ownerName}`;
    }
    let reason: string | undefined;
    const readHere = qids.filter((id) => reads.has(id));
    if (!branch) reason = "the branch is gone";
    else if (loc?.container.ownerId === branchId && (!slot || loc.container.slot === slot)) reason = "already in this path";
    else if (readHere.length) reason = `this branch's conditions read ${readHere.map(codeOf).join(", ")} — a block cannot be routed by its own answers`;
    else {
      const v = canDropFlowNode(flow, b.id, { kind: "inside", ownerId: branchId, slot: slot ?? `branch:${branch.branches[0]?.id}` });
      if (!v.ok) reason = v.reason;
    }
    out.push({ id: b.id, kind: "block", title, number: i + 1, questionCodes: qids.map(codeOf), selectable: !reason, ...(reason ? { reason } : {}), where });
    for (const qid of qids) {
      const q = qById.get(qid);
      if (!q) continue;
      questions.push({ id: q.id, kind: "question", code: String(q.code), text: String(q.text ?? "").replace(/<[^>]*>/g, "").slice(0, 80), blockId: b.id, blockTitle: title, selectable: false, reason: `part of ${title} — select the whole block; a question is not taken out of its block` });
    }
  });
  return { blocks: out, questions, note: "Blocks can be selected; individual questions are not — a branch path routes whole blocks." };
}

/**
 * Move an existing block into a branch path (or OTHERWISE) — the same move the drag does,
 * with the branch's own rule added: a block whose answers the branch reads stays out.
 */
export function moveBlockIntoBranch(def: SurveyDefinition, blockId: string, branchId: string, slot: string, index?: number): MoveResult {
  const flow = def.flow as FlowNode[];
  const choice = branchBlockChoices(def, branchId, slot).blocks.find((b) => b.id === blockId);
  if (!choice) {
    const q = def.questions.find((x) => x.id === blockId || String(x.code) === blockId);
    return { flow, moved: false, reason: q ? `${q.code} is a question — select the block it belongs to` : "there is no such block" };
  }
  if (!choice.selectable) return { flow, moved: false, reason: choice.reason };
  return moveFlowNode(flow, blockId, { kind: "inside", ownerId: branchId, slot, ...(index != null ? { index } : {}) });
}

