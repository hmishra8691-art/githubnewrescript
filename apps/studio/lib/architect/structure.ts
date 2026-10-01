import type { FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { resolveVariant, variantRegistry, variantForLegacyType, isEmptyConditionTree } from "@rescript/schema";
import {
  objectKey, stripHtmlText, conditionSummary, listBlocks, formatSetExpression, ruleLabel, summarizeFlowNode,
  type ObjectKey, type DependencyIndex,
} from "@rescript/engine";
import { decodeEntities } from "../grid/model.ts";

/**
 * THE SURVEY'S STRUCTURE, AS A PROGRAMMER READS IT (UI upgrade §4–§8).
 *
 *   survey → groups → blocks → pages → questions → their logic
 *
 * The map (map.ts) is a tree for navigating; this is the OUTLINE the
 * Architect workspace draws: blocks in flow order, each block's pages with
 * the PAGE BREAK between them made explicit, each question with the
 * badges that say what kind of object it is (a hidden variable, a conjoint
 * task, an embedded-data capture…) and the chips that say what logic is on
 * it — display, skip, validation, mask, calculation, quota, named rules —
 * each chip pointing at the panel section or object that holds it.
 *
 * Pure: reads the definition and the dependency index, builds nothing but
 * data, is tested directly.
 */

export type ObjectTag = "hidden" | "embedded" | "conjoint" | "maxdiff" | "calculated" | "loop" | "quota" | "screening";

export interface LogicChip {
  kind: "display" | "skip" | "validation" | "mask" | "calculation" | "quota" | "rule" | "loop" | "embedded" | "required";
  /** what the chip says: "DL", "SKIP ×2", "VAL", … */
  label: string;
  /** the full sentence, for a tooltip and for the inspector */
  detail: string;
  /** the Properties panel section that holds it, when it is a property of the question */
  section?: string;
  /** the object that holds it, when it is elsewhere (a rule, a calculation, a quota) */
  key?: ObjectKey;
}

export interface StructureQuestion {
  kind: "question";
  key: ObjectKey;
  id: string;
  code: string;
  variableName: string;
  text: string;
  typeLabel: string;
  tags: ObjectTag[];
  chips: LogicChip[];
  required: boolean;
  /** what follows this question: nothing, a page break, or the end of the block */
  boundary: "none" | "page" | "block";
}

export interface StructurePage {
  key: ObjectKey;
  id: string;
  /** 1-based, within the block */
  n: number;
  title?: string;
  questions: StructureQuestion[];
}

export interface StructureBlock {
  kind: "block";
  key: ObjectKey;
  id: string;
  /** "Block 3" */
  label: string;
  title?: string;
  /** "shown when …", from the block's visibleIf */
  condition?: string;
  pages: StructurePage[];
  questionCount: number;
}

export interface StructureElement {
  kind: "element";
  key: ObjectKey;
  id: string;
  type: FlowNode["type"];
  label: string;
  detail?: string;
  /** the element's children, for branches (per arm), loops, randomizers */
  children: StructureArm[];
}

export interface StructureArm {
  label: string;
  condition?: string;
  entries: StructureEntry[];
}

export interface StructureGroup {
  kind: "group";
  key: ObjectKey;
  id: string;
  label: string;
  condition?: string;
  entries: StructureEntry[];
}

export type StructureEntry = StructureBlock | StructureElement | StructureGroup;

export interface Structure {
  entries: StructureEntry[];
  /** questions on no page */
  unplaced: StructureQuestion[];
  blockCount: number;
  pageCount: number;
  breakCount: number;
}

const clean = (s: string | undefined) => decodeEntities(stripHtmlText(String(s ?? ""))).replace(/\s+/g, " ").trim();
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function variantOf(q: Question) {
  return resolveVariant(q.variant ?? undefined)
    ?? (variantForLegacyType(q.type) ? variantRegistry.get(variantForLegacyType(q.type)!) : undefined);
}

/** what kind of object a question is, beyond its type — the badges the outline and the Flow canvas show */
export function objectTags(q: Question): ObjectTag[] {
  const tags: ObjectTag[] = [];
  if (q.type === "hidden") tags.push("hidden");
  if (q.type === "calculated") tags.push("calculated");
  if (q.type === "conjoint_task") tags.push("conjoint");
  if (q.type === "maxdiff_task") tags.push("maxdiff");
  if (q.skipLogic?.some((r) => r.target.kind === "terminate" || (r.target.kind === "end" && r.target.status && r.target.status !== "complete"))) tags.push("screening");
  return tags;
}

/** the logic on a question, as chips — each with the panel section or object that holds it */
export function logicChips(def: SurveyDefinition, q: Question, index?: DependencyIndex): LogicChip[] {
  const chips: LogicChip[] = [];
  if (!isEmptyConditionTree(q.displayLogic)) chips.push({ kind: "display", label: "DL", detail: `Shown when ${conditionSummary(def, q.displayLogic)}`, section: "display-logic" });
  const rules = (def.displayRules ?? []).filter((r) => r.target.kind === "question" && r.target.ref === q.id);
  for (const r of rules) chips.push({ kind: "rule", label: r.action === "hide" ? "HIDE" : "SHOW", detail: `Rule${r.label ? ` “${r.label}”` : ""}: ${r.action} when ${conditionSummary(def, r.when)}`, key: objectKey("displayRule", r.id) });
  if (q.skipLogic?.length) {
    const first = q.skipLogic[0];
    const where = first.target.kind === "question" ? (def.questions.find((x) => x.id === first.target.ref)?.code ?? "?") : first.target.kind === "terminate" ? `out (${first.target.status ?? "terminated"})` : first.target.kind === "end" ? "the end" : `${first.target.kind} ${first.target.ref ?? ""}`;
    chips.push({ kind: "skip", label: q.skipLogic.length > 1 ? `SKIP ×${q.skipLogic.length}` : "SKIP", detail: `Skip to ${where} when ${conditionSummary(def, first.when)}${q.skipLogic.length > 1 ? ` (+${q.skipLogic.length - 1} more)` : ""}`, section: "skip-logic" });
  }
  if (q.validation?.length) chips.push({ kind: "validation", label: "VAL", detail: `Validation: ${q.validation.map((v) => `${ruleLabel(v.kind)}${v.value !== undefined && v.value !== null && typeof v.value !== "object" ? ` ${v.value}` : ""}`).join(", ")}`, section: "validation-rules" });
  if (q.mask) chips.push({ kind: "mask", label: "MASK", detail: `Options ${q.mask.action}: ${formatSetExpression(def, q.mask.expr)}`, section: "masking" });
  const calc = (def.calculations ?? []).find((c) => c.targetVariable === q.variableName);
  if (calc) chips.push({ kind: "calculation", label: "CALC", detail: `${calc.targetVariable} = ${calc.expression}`, key: objectKey("calculation", calc.id) });
  if (index) {
    const key = objectKey("question", q.id);
    const quotas = new Set(index.usedBy(key).filter((e) => e.kind === "quotaCell").map((e) => e.from));
    for (const k of quotas) {
      const id = k.slice(k.indexOf(":") + 1);
      const quota = (def.quotas ?? []).find((x) => x.id === id);
      chips.push({ kind: "quota", label: "QUOTA", detail: `Counted by quota ${quota?.name ?? id}`, key: k as ObjectKey });
    }
  }
  return chips;
}

/** a block in a group / at the top level, with its pages, from the engine's own reading of the flow */
function blockEntry(def: SurveyDefinition, node: FlowNode, index: DependencyIndex | undefined, byId: Map<string, Question>, no: number, blocksById: Map<string, ReturnType<typeof listBlocks>[number]>): StructureBlock | null {
  const b = blocksById.get(node.id);
  if (!b) return null;
  const pages: StructurePage[] = b.pages.map((p, pi) => ({
    key: objectKey("flowNode", p.node.id), id: p.node.id, n: pi + 1, title: p.node.title,
    questions: p.node.questionIds.map((qid, qi): StructureQuestion | null => {
      const q = byId.get(qid);
      if (!q) return null;
      const last = qi === p.node.questionIds.length - 1;
      return {
        kind: "question", key: objectKey("question", q.id), id: q.id, code: q.code, variableName: q.variableName,
        text: trunc(clean(q.text) || q.variableName, 120), typeLabel: variantOf(q)?.name ?? q.type.replace(/_/g, " "),
        tags: objectTags(q), chips: logicChips(def, q, index), required: !!q.required,
        boundary: !last ? "none" : pi < b.pages.length - 1 ? "page" : "block",
      };
    }).filter((x): x is StructureQuestion => !!x),
  }));
  const vis = (b.node as { visibleIf?: unknown }).visibleIf;
  return {
    kind: "block", key: objectKey("flowNode", b.id), id: b.id, label: `Block ${no}`, title: b.title,
    condition: vis ? conditionSummary(def, vis as never) : undefined,
    pages, questionCount: pages.reduce((n, p) => n + p.questions.length, 0),
  };
}

export function buildStructure(def: SurveyDefinition, opts: { index?: DependencyIndex } = {}): Structure {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const blocksById = new Map(listBlocks(def.flow as unknown[]).map((b) => [b.id, b]));
  let blockNo = 0;
  let pageCount = 0, breakCount = 0;

  const walk = (nodes: FlowNode[]): StructureEntry[] => nodes.flatMap((n): StructureEntry[] => {
    if (n.type === "page" || n.type === "block") {
      const b = blockEntry(def, n, opts.index, byId, ++blockNo, blocksById);
      if (!b) { blockNo--; return element(n); }
      pageCount += b.pages.length; breakCount += Math.max(0, b.pages.length - 1);
      return [b];
    }
    if (n.type === "section") {
      return [{ kind: "group", key: objectKey("flowNode", n.id), id: n.id, label: n.title ?? "Group", condition: !isEmptyConditionTree(n.visibleIf) ? conditionSummary(def, n.visibleIf!) : undefined, entries: walk(n.children) }];
    }
    return element(n);
  });

  const element = (n: FlowNode): StructureEntry[] => {
    const sum = summarizeFlowNode(n);
    const children: StructureArm[] = [];
    let detail: string | undefined;
    switch (n.type) {
      case "branch":
        for (const [i, arm] of n.branches.entries()) children.push({ label: arm.label ?? `Path ${i + 1}`, condition: conditionSummary(def, arm.when), entries: walk(arm.children) });
        if (n.otherwise?.length) children.push({ label: "Otherwise", entries: walk(n.otherwise) });
        detail = `${n.branches.length} path${n.branches.length === 1 ? "" : "s"}${n.otherwise?.length ? " + otherwise" : ""}`;
        break;
      case "loop": {
        const src = n.source as { kind: string; questionId?: string };
        detail = `once per ${n.loopVar}${src.kind === "question" ? ` — over ${byId.get(src.questionId ?? "")?.code ?? "?"}` : ""}${n.maxIterations ? `, up to ${n.maxIterations}` : ""}`;
        children.push({ label: "Each iteration", entries: walk(n.children) });
        break;
      }
      case "randomizer":
        detail = n.show ? `shows ${n.show} of ${n.children.length}` : `shuffles ${n.children.length}`;
        children.push({ label: "In random order", entries: walk(n.children) });
        break;
      case "embedded_data":
        detail = n.fields.map((f) => `${f.name || "?"} ← ${f.source}`).join(", ");
        break;
      case "quota_check":
        detail = `${n.quotaIds.map((id) => (def.quotas ?? []).find((q) => q.id === id)?.name ?? id).join(", ") || "no quotas"} · when full: ${n.onFull.kind}`;
        break;
      case "redirect": detail = n.url; break;
      case "end": detail = n.status; break;
      default: break;
    }
    return [{ kind: "element", key: objectKey("flowNode", n.id), id: n.id, type: n.type, label: sum.label, detail, children }];
  };

  const entries = walk(def.flow as FlowNode[]);
  const placed = new Set<string>();
  for (const b of blocksById.values()) for (const p of b.pages) for (const id of p.node.questionIds) placed.add(id);
  const unplaced = def.questions.filter((q) => !placed.has(q.id)).map((q): StructureQuestion => ({
    kind: "question", key: objectKey("question", q.id), id: q.id, code: q.code, variableName: q.variableName,
    text: trunc(clean(q.text) || q.variableName, 120), typeLabel: variantOf(q)?.name ?? q.type.replace(/_/g, " "),
    tags: objectTags(q), chips: logicChips(def, q, opts.index), required: !!q.required, boundary: "none",
  }));
  return { entries, unplaced, blockCount: blockNo, pageCount, breakCount };
}

/** the block, page and position of a question — the crumb over its editor */
export function positionCrumb(structure: Structure, questionId: string): { block: StructureBlock; page: StructurePage; index: number } | null {
  const visit = (entries: StructureEntry[]): { block: StructureBlock; page: StructurePage; index: number } | null => {
    for (const e of entries) {
      if (e.kind === "block") {
        for (const p of e.pages) { const i = p.questions.findIndex((q) => q.id === questionId); if (i >= 0) return { block: e, page: p, index: i }; }
      } else if (e.kind === "group") { const hit = visit(e.entries); if (hit) return hit; }
      else for (const arm of e.children) { const hit = visit(arm.entries); if (hit) return hit; }
    }
    return null;
  };
  return visit(structure.entries);
}

/** the entries under a container, so the workspace can scope the outline to a selected block or group */
export function scopeStructure(structure: Structure, key: ObjectKey | null): StructureEntry[] {
  if (!key) return structure.entries;
  const find = (entries: StructureEntry[]): StructureEntry | null => {
    for (const e of entries) {
      if (e.key === key) return e;
      if (e.kind === "group") { const hit = find(e.entries); if (hit) return hit; }
      else if (e.kind === "element") for (const arm of e.children) { const hit = find(arm.entries); if (hit) return hit; }
      else for (const p of e.pages) if (p.key === key) return e;
    }
    return null;
  };
  const hit = find(structure.entries);
  return hit ? [hit] : structure.entries;
}

export const TAG_LABEL: Record<ObjectTag, string> = {
  hidden: "H · Hidden variable", embedded: "Embedded data", conjoint: "Conjoint", maxdiff: "MaxDiff",
  calculated: "Calculated", loop: "Loop", quota: "Quota", screening: "Screening",
};
