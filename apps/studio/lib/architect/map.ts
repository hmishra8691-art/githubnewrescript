import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import {
  objectKey, stripHtmlText, conditionSummary,
  type ObjectKey, type ObjectStatusMap, type DependencyIndex, type StatusLevel,
} from "@rescript/engine";

/**
 * THE SURVEY MAP — the architecture of a survey as a tree.
 *
 * The Architect environment's left pane. Where the Questions panel shows
 * blocks of cards and the Grid shows rows, the map shows STRUCTURE: the flow
 * as nested containers (blocks, groups, branches with their arms, loops,
 * randomizers), pages inside them, questions inside those — and beneath the
 * flow, the survey's other programmable objects: named display rules,
 * calculations, quotas. Everything selectable, everything an engine
 * ObjectKey, so selecting a branch here and selecting a branch on the Flow
 * canvas (Phase 3) are the same event.
 *
 * Every node carries its status and its dependency counts, so the map is
 * also where a programmer sees at a glance which parts of a 600-question
 * survey are healthy and which are wired to many others.
 *
 * Pure: no React, tested directly, cheap to memoise on the definition.
 */

export type MapKind =
  | "root" | "block" | "group" | "page" | "question"
  | "branch" | "arm" | "otherwise" | "loop" | "randomizer"
  | "embedded" | "quotaCheck" | "redirect" | "end"
  | "rules" | "rule" | "calculations" | "calculation" | "quotas" | "quota";

export interface MapNode {
  /** the engine key when the node is an addressable object; a synthetic key otherwise */
  key: ObjectKey | `${string}:${string}`;
  kind: MapKind;
  id: string;
  /** what the row shows: "Q14", "Block 3 · Brands", "IF Q3 = 1", "TOTAL" */
  label: string;
  /** the mono code, when the object has one */
  code?: string;
  /** a secondary line: question text, condition summary, expression */
  detail?: string;
  children: MapNode[];
  /** true when this container has a condition (visibleIf, arm.when, loop filters) */
  conditional: boolean;
  status: StatusLevel;
  issueCount: number;
  /** distinct objects this reads / that read this — from the dependency index */
  dependsOn: number;
  usedBy: number;
  /** true when the node can be selected and inspected */
  selectable: boolean;
}

export interface FlatMapRow extends MapNode {
  /**
   * Unique per ROW, not per object: a question placed on two pages (both
   * arms of a branch showing it) is one object at two positions, and the
   * pane needs a key for each position.
   */
  rowId: string;
  depth: number;
  /** true when the node has children and is expanded */
  expanded: boolean;
  /** the parent's key, for collapsing "up" */
  parentKey: string | null;
}

type Deco = { status?: ObjectStatusMap; index?: DependencyIndex };

function deco(key: ObjectKey, d: Deco): Pick<MapNode, "status" | "issueCount" | "dependsOn" | "usedBy"> {
  const st = d.status?.statusOf(key);
  const dependsOn = d.index ? new Set(d.index.dependsOn(key).map((e) => e.to)).size : 0;
  const usedBy = d.index ? new Set(d.index.usedBy(key).map((e) => e.from)).size : 0;
  return { status: st?.level ?? "ok", issueCount: st?.issues.length ?? 0, dependsOn, usedBy };
}

const NONE = { status: "ok" as StatusLevel, issueCount: 0, dependsOn: 0, usedBy: 0 };

/** a container's status is its worst child's, so a collapsed block still shows a red dot */
function rollUp(node: MapNode): MapNode {
  let status = node.status;
  let issues = node.issueCount;
  for (const c of node.children) {
    if (c.status === "error" || (c.status === "warning" && status === "ok")) status = c.status;
    issues += c.issueCount;
  }
  return status === node.status && issues === node.issueCount ? node : { ...node, status, issueCount: issues };
}

export function buildSurveyMap(def: SurveyDefinition, d: Deco = {}): MapNode {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  let blockNo = 0;

  const question = (qid: string): MapNode | null => {
    const q = byId.get(qid);
    if (!q) return null;
    const key = objectKey("question", q.id);
    return {
      key, kind: "question", id: q.id, label: q.code, code: q.code,
      detail: stripHtmlText(q.text ?? "").trim() || q.variableName,
      children: [], conditional: !!q.displayLogic, selectable: true, ...deco(key, d),
    };
  };

  const page = (n: Extract<FlowNode, { type: "page" }>, asBlock: boolean): MapNode => {
    const key = objectKey("flowNode", n.id);
    const kids = n.questionIds.map(question).filter((x): x is MapNode => !!x);
    const label = asBlock ? `Block ${++blockNo}${n.title ? ` · ${n.title}` : ""}` : (n.title ?? "Page");
    return rollUp({
      key, kind: asBlock ? "block" : "page", id: n.id, label,
      detail: n.visibleIf ? `shown when ${conditionSummary(def, n.visibleIf)}` : undefined,
      children: kids, conditional: !!n.visibleIf, selectable: true, ...(d.index || d.status ? deco(key, d) : NONE),
    });
  };

  const walk = (nodes: FlowNode[]): MapNode[] => nodes.map((n): MapNode => {
    switch (n.type) {
      case "page": return page(n, true);
      case "block": {
        const key = objectKey("flowNode", n.id);
        const no = ++blockNo;
        const pages = n.children.map((c) => c.type === "page" ? page(c, false) : walk([c])[0]);
        // a block with one page shows that page's questions directly — one level, not two
        const children = pages.length === 1 && pages[0].kind === "page" ? pages[0].children : pages;
        return rollUp({
          key, kind: "block", id: n.id, label: `Block ${no}${n.title ? ` · ${n.title}` : ""}`,
          detail: n.visibleIf ? `shown when ${conditionSummary(def, n.visibleIf)}` : undefined,
          children, conditional: !!n.visibleIf, selectable: true, ...deco(key, d),
        });
      }
      case "section": {
        const key = objectKey("flowNode", n.id);
        return rollUp({
          key, kind: "group", id: n.id, label: n.title ?? "Group",
          detail: n.visibleIf ? `shown when ${conditionSummary(def, n.visibleIf)}` : undefined,
          children: walk(n.children), conditional: !!n.visibleIf, selectable: true, ...deco(key, d),
        });
      }
      case "randomizer": {
        const key = objectKey("flowNode", n.id);
        return rollUp({
          key, kind: "randomizer", id: n.id, label: n.title ?? "Randomizer",
          detail: n.show ? `show ${n.show} of ${n.children.length}` : `shuffle ${n.children.length}`,
          children: walk(n.children), conditional: false, selectable: true, ...deco(key, d),
        });
      }
      case "branch": {
        const key = objectKey("flowNode", n.id);
        const arms: MapNode[] = n.branches.map((arm, i) => rollUp({
          key: `arm:${arm.id}`, kind: "arm", id: arm.id,
          label: arm.label ?? `Path ${i + 1}`, detail: `IF ${conditionSummary(def, arm.when)}`,
          children: walk(arm.children), conditional: true, selectable: false, ...NONE,
        }));
        if (n.otherwise?.length) {
          arms.push(rollUp({
            key: `otherwise:${n.id}`, kind: "otherwise", id: `${n.id}:otherwise`, label: "Otherwise",
            children: walk(n.otherwise), conditional: true, selectable: false, ...NONE,
          }));
        }
        return rollUp({
          key, kind: "branch", id: n.id, label: n.title ?? "Branch",
          detail: `${n.branches.length} path${n.branches.length === 1 ? "" : "s"}${n.otherwise?.length ? " + otherwise" : ""}`,
          children: arms, conditional: true, selectable: true, ...deco(key, d),
        });
      }
      case "loop": {
        const key = objectKey("flowNode", n.id);
        const src = n.source as { kind: string; questionId?: string; listFillId?: string };
        const over = src.kind === "question" ? `over ${byId.get(src.questionId ?? "")?.code ?? "?"}`
          : src.kind === "listFill" ? "over a list fill" : `over ${src.kind}`;
        return rollUp({
          key, kind: "loop", id: n.id, label: n.title ?? `Loop ${n.loopVar}`, code: n.loopVar,
          detail: over, children: walk(n.children), conditional: !!(n.eligibleIf || n.skipIf || n.breakIf), selectable: true, ...deco(key, d),
        });
      }
      case "embedded_data": {
        const key = objectKey("flowNode", n.id);
        return { key, kind: "embedded", id: n.id, label: n.title ?? "Embedded data", detail: n.fields.map((f) => f.name).filter(Boolean).join(", "), children: [], conditional: false, selectable: true, ...NONE };
      }
      case "quota_check": {
        const key = objectKey("flowNode", n.id);
        return { key, kind: "quotaCheck", id: n.id, label: "Quota check", detail: `${n.quotaIds.length} quota${n.quotaIds.length === 1 ? "" : "s"}`, children: [], conditional: false, selectable: true, ...deco(key, d) };
      }
      case "redirect": {
        const key = objectKey("flowNode", n.id);
        return { key, kind: "redirect", id: n.id, label: n.title ?? "Redirect", detail: n.url, children: [], conditional: !!n.when, selectable: true, ...deco(key, d) };
      }
      case "end": {
        const key = objectKey("flowNode", n.id);
        return { key, kind: "end", id: n.id, label: `End · ${n.status}`, detail: n.message ? stripHtmlText(n.message) : undefined, children: [], conditional: false, selectable: true, ...deco(key, d) };
      }
    }
  });

  const flow = walk(def.flow);

  // questions on no page still exist and must be reachable from the map
  const placed = new Set<string>();
  const collect = (nodes: MapNode[]) => { for (const n of nodes) { if (n.kind === "question") placed.add(n.id); collect(n.children); } };
  collect(flow);
  const unplaced = def.questions.filter((q) => !placed.has(q.id)).map((q) => question(q.id)!).filter(Boolean);
  if (unplaced.length) {
    flow.push(rollUp({ key: "section:unplaced", kind: "group", id: "unplaced", label: "Not on any page", detail: "respondents never see these", children: unplaced, conditional: false, selectable: false, ...NONE }));
  }

  const rules: MapNode = rollUp({
    key: "section:rules", kind: "rules", id: "rules", label: "Display rules", children: def.displayRules.map((r, i) => {
      const key = objectKey("displayRule", r.id);
      const target = r.target.kind === "question" ? (byId.get(r.target.ref)?.code ?? r.target.ref) : `${r.target.kind} ${r.target.ref}`;
      return { key, kind: "rule" as MapKind, id: r.id, label: r.label || `Rule ${i + 1}`, detail: `${r.action.toUpperCase()} ${target} when ${conditionSummary(def, r.when)}`, children: [], conditional: true, selectable: true, ...deco(key, d) };
    }), conditional: false, selectable: false, ...NONE,
  });
  const calcs: MapNode = rollUp({
    key: "section:calculations", kind: "calculations", id: "calculations", label: "Calculations", children: def.calculations.map((c) => {
      const key = objectKey("calculation", c.id);
      return { key, kind: "calculation" as MapKind, id: c.id, label: c.targetVariable, code: c.targetVariable, detail: c.expression, children: [], conditional: !!c.when, selectable: true, ...deco(key, d) };
    }), conditional: false, selectable: false, ...NONE,
  });
  const quotas: MapNode = rollUp({
    key: "section:quotas", kind: "quotas", id: "quotas", label: "Quotas", children: def.quotas.map((q) => {
      const key = objectKey("quota", q.id);
      return { key, kind: "quota" as MapKind, id: q.id, label: q.name, detail: `${q.cells.length} cell${q.cells.length === 1 ? "" : "s"} · ${q.mode}`, children: [], conditional: false, selectable: true, ...deco(key, d) };
    }), conditional: false, selectable: false, ...NONE,
  });

  return rollUp({ key: "section:root", kind: "root", id: "root", label: def.meta.title, children: [...flow, rules, calcs, quotas], conditional: false, selectable: false, ...NONE });
}

/**
 * The tree as the rows the pane draws, honouring collapse state. Section
 * headers (rules / calculations / quotas) and containers are rows too.
 */
export function flattenMap(root: MapNode, collapsed: ReadonlySet<string>): FlatMapRow[] {
  const out: FlatMapRow[] = [];
  const visit = (n: MapNode, depth: number, parentKey: string | null, prefix: string) => {
    const expanded = n.children.length > 0 && !collapsed.has(n.key);
    const rowId = `${prefix}/${n.key}`;
    out.push({ ...n, rowId, depth, expanded, parentKey });
    if (expanded) for (const c of n.children) visit(c, depth + 1, n.key, rowId);
  };
  for (const c of root.children) visit(c, 0, null, "");
  return out;
}

/** every ancestor key of `key`, outermost first — the path to expand to reach a selection */
export function ancestorKeys(root: MapNode, key: string): string[] {
  const path: string[] = [];
  const find = (n: MapNode, trail: string[]): boolean => {
    if (n.key === key) { path.push(...trail); return true; }
    for (const c of n.children) if (find(c, [...trail, n.key])) return true;
    return false;
  };
  find(root, []);
  return path.filter((k) => k !== root.key);
}

/** the keys of every container, for "collapse all" */
export function containerKeys(root: MapNode): string[] {
  const out: string[] = [];
  const visit = (n: MapNode) => { if (n.children.length && n.kind !== "root") out.push(n.key); n.children.forEach(visit); };
  visit(root);
  return out;
}

/** find a node by key */
export function findMapNode(root: MapNode, key: string): MapNode | null {
  if (root.key === key) return root;
  for (const c of root.children) { const hit = findMapNode(c, key); if (hit) return hit; }
  return null;
}
