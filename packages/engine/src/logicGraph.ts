import type {
  Condition,
  FlowNode,
  LogicFlow,
  LogicFlowEdge,
  LogicFlowNode,
  SurveyDefinition,
} from "@rescript/schema";
import { conditionSummary } from "./logicSummary.js";
import { hasDisplayRulesFor } from "./displayRules.js";

/**
 * THE LOGIC FLOW, DERIVED FROM THE PROGRAMMING (§8).
 *
 * `def.logicFlow` has been in the schema since the first commit, described as
 * "a standalone decision graph, independent of the visual layout,
 * exportable / inspectable". It was stored, it was exported, and it was
 * interpreted by nothing: the string `logicFlow` appears nowhere in the
 * engine or the runtime. Exactly one thing ever wrote it — the Master Demo,
 * by hand — and a test asserted the hand-written graph was present.
 *
 * WHY IT IS DERIVED AND NOT INTERPRETED.
 *
 * The obvious reading of "not interpreted" is that the engine should start
 * obeying the graph. That would be a mistake, and it is worth saying why
 * plainly, because the schema's own comment invites it.
 *
 * Navigation in this platform is already decided by three things that compose:
 * the flow tree, skip rules on questions, and display rules. All three are
 * tested, all three are what the Studio edits, and all three are what a
 * respondent actually experiences. A second graph with authority over
 * navigation would make two sources of truth for one question — "why did this
 * respondent skip Q7" would have two possible answers, and the bug that
 * produces is undiagnosable, because the two systems would agree in every
 * case anybody thought to test.
 *
 * A hand-maintained graph has the same defect in slower motion: it drifts
 * from the programming, silently, and then a client signs off a decision map
 * that no longer describes the survey. The Master Demo's stored graph is
 * exactly that risk with 15 nodes in it.
 *
 * So the graph becomes a VIEW. It is generated from the real programming, so
 * it cannot drift; anything stored in `def.logicFlow` is treated as layout —
 * the canvas positions a person arranged, which are the one part of a graph a
 * generator has no opinion about. Truth from the definition, arrangement from
 * the editor, and no way for the two to disagree about behaviour.
 */

export interface LogicGraphOptions {
  /**
   * Merge `x` / `y` (and a person's edited label) from a stored graph, so a
   * hand-arranged canvas survives a regeneration. Defaults to `def.logicFlow`.
   */
  layout?: LogicFlow | null;
  /**
   * Include one node per question. Off gives the page-level map, which is the
   * one a client reads; on gives the map a programmer debugs a skip rule in.
   */
  questions?: boolean;
}

const clean = (s: string | undefined): string =>
  (s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const truncate = (s: string, n = 56): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A condition rendered for an edge label, or undefined when there is none. */
function edgeLabel(when: Condition | undefined, def: SurveyDefinition): string | undefined {
  if (!when) return undefined;
  const text = clean(conditionSummary(def, when));
  if (!text || text.toLowerCase() === "always") return undefined;
  return truncate(text, 72);
}

/**
 * The graph.
 *
 * Built in one walk that returns, for each flow node, the set of nodes an
 * incoming edge should attach to (its "entries") and the set a following node
 * should be reached from (its "exits"). That pair is what makes containers
 * work without special cases: a branch's exits are the exits of every one of
 * its arms, so whatever follows the branch is reached from all of them, and a
 * randomizer's are its children's — which is the truthful picture, since the
 * order is not knowable in advance.
 */
export function buildLogicFlow(def: SurveyDefinition, opts: LogicGraphOptions = {}): LogicFlow {
  const withQuestions = opts.questions ?? true;
  const nodes: LogicFlowNode[] = [];
  const edges: LogicFlowEdge[] = [];
  const seen = new Set<string>();

  const add = (n: LogicFlowNode): string => {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      nodes.push(n);
    }
    return n.id;
  };
  const link = (from: string, to: string, when?: Condition | undefined, label?: string): void => {
    const id = `e_${from}__${to}${label ? `_${edges.length}` : ""}`;
    edges.push({
      id,
      from,
      to,
      ...(when ? { when } : {}),
      ...(label ?? edgeLabel(when, def) ? { label: label ?? edgeLabel(when, def) } : {}),
    });
  };

  /*
   * Where a jump lands.
   *
   * `{ kind: "terminate", status: "screened" }` reaches the End node CARRYING
   * that status — by status, not by id, which is how the flow interpreter
   * resolves it and what `runQualityCheck` already relies on. So the End the
   * survey declares is found first, and a synthetic node is invented only when
   * the flow has none. Inventing one unconditionally drew two "Screened out"
   * boxes for one destination, which is the exact class of untruth a derived
   * graph exists to remove.
   */
  const declaredEnds = new Map<string, string>();
  {
    const walkEnds = (list: FlowNode[]): void => {
      for (const n of list) {
        if (n.type === "end" && !declaredEnds.has(n.status)) declaredEnds.set(n.status, n.id);
        const kids = (n as { children?: FlowNode[] }).children;
        if (kids) walkEnds(kids);
        const branches = (n as { branches?: { children: FlowNode[] }[] }).branches;
        if (branches) for (const b of branches) walkEnds(b.children);
        const other = (n as { otherwise?: FlowNode[] }).otherwise;
        if (other) walkEnds(other);
      }
    };
    walkEnds(def.flow ?? []);
  }
  const endNodeFor = (status: string): string => {
    const declared = declaredEnds.get(status);
    if (declared && seen.has(declared)) return declared;
    return add({
      id: declared ?? `end_${status}`,
      kind: status === "complete" ? "end" : "terminate",
      label: END_LABELS[status] ?? status,
    });
  };

  interface Span {
    /** nodes an edge from the preceding element should point at */
    entries: string[];
    /** nodes a following element should be reached from */
    exits: string[];
  }
  const EMPTY: Span = { entries: [], exits: [] };

  const walk = (list: FlowNode[]): Span => {
    let first: string[] | null = null;
    let carry: string[] = [];
    for (const node of list) {
      const span = spanOf(node);
      if (!span.entries.length && !span.exits.length) continue;
      if (first === null) first = span.entries;
      for (const from of carry) for (const to of span.entries) link(from, to);
      carry = span.exits;
    }
    return { entries: first ?? [], exits: carry };
  };

  const spanOf = (node: FlowNode): Span => {
    switch (node.type) {
      case "page": {
        const qs = node.questionIds
          .map((id) => def.questions.find((q) => q.id === id))
          .filter((q): q is NonNullable<typeof q> => !!q);
        const codes = qs.map((q) => q.code);
        const conditional =
          !!node.visibleIf || (hasDisplayRulesFor(def, "page") && namesTarget(def, "page", node.id));

        if (!withQuestions || qs.length === 0) {
          const id = add({
            id: node.id,
            kind: "question",
            ref: node.id,
            label: `${clean(node.title) || codes.join(", ") || "page"}${conditional ? " (conditional)" : ""}`,
          });
          return { entries: [id], exits: [id] };
        }

        /*
         * One node per question, chained. The chain is what makes a skip rule
         * legible: an edge that leaves Q3 and lands on Q9 is visibly a jump
         * over Q4–Q8, which is the thing a programmer is checking.
         */
        const ids = qs.map((q) => {
          const marks: string[] = [];
          if (q.displayLogic) marks.push("conditional");
          if (q.skipLogic?.length) marks.push(`${q.skipLogic.length} skip`);
          return add({
            id: q.id,
            kind: "question",
            ref: q.id,
            label: `${q.code} ${truncate(clean(q.text) || q.variableName, 40)}${marks.length ? ` (${marks.join(", ")})` : ""}`,
          });
        });
        for (let i = 0; i < ids.length - 1; i++) link(ids[i], ids[i + 1]);
        return { entries: [ids[0]], exits: [ids[ids.length - 1]] };
      }

      case "section":
      case "block": {
        /*
         * A container is not a decision, so it gets no node of its own — its
         * children stand in for it. Its `visibleIf` becomes the condition on
         * the edges INTO it, which is what it actually is.
         */
        const inner = walk(node.children);
        if (!inner.entries.length) return EMPTY;
        const when = node.visibleIf;
        if (when) {
          const gate = add({
            id: node.id,
            kind: "decision",
            ref: node.id,
            label: `${clean(node.title) || node.type} — shown when ${edgeLabel(when, def) ?? "condition holds"}`,
          });
          for (const to of inner.entries) link(gate, to, when);
          return { entries: [gate], exits: [...inner.exits, gate] };
        }
        return inner;
      }

      case "branch": {
        const gate = add({
          id: node.id,
          kind: "decision",
          ref: node.id,
          label: clean(node.title) || "branch",
        });
        const exits: string[] = [];
        let everyArmClosed = true;
        for (const arm of node.branches) {
          const inner = walk(arm.children);
          if (!inner.entries.length) {
            /* an empty arm falls straight through — worth seeing */
            everyArmClosed = false;
            continue;
          }
          for (const to of inner.entries) {
            link(gate, to, arm.when, clean(arm.label) || edgeLabel(arm.when, def));
          }
          exits.push(...inner.exits);
        }
        const other = node.otherwise?.length ? walk(node.otherwise) : EMPTY;
        if (other.entries.length) {
          for (const to of other.entries) link(gate, to, undefined, "otherwise");
          exits.push(...other.exits);
        } else {
          everyArmClosed = false;
        }
        /*
         * With no `otherwise`, or with an empty arm, a respondent who matches
         * nothing continues past the branch — so the branch itself is an exit.
         */
        return { entries: [gate], exits: everyArmClosed ? exits : [...exits, gate] };
      }

      case "randomizer": {
        const gate = add({
          id: node.id,
          kind: "decision",
          ref: node.id,
          label: `${clean(node.title) || "randomizer"} — ${
            node.show ? `shows ${node.show} of ${node.children.length}` : "shuffles"
          }${node.evenPresentation ? ", even presentation" : ""}`,
        });
        const exits: string[] = [];
        /*
         * Each child is drawn from the randomizer, not from its sibling: the
         * order is decided per respondent, so a chain between them would be
         * one arbitrary ordering presented as fact.
         */
        for (const child of node.children) {
          const inner = spanOf(child);
          for (const to of inner.entries) link(gate, to);
          exits.push(...inner.exits);
        }
        return { entries: [gate], exits: exits.length ? exits : [gate] };
      }

      case "loop": {
        const gate = add({
          id: node.id,
          kind: "decision",
          ref: node.id,
          label: `${clean(node.title) || "loop"} — once per ${node.loopVar}${
            node.maxIterations ? `, up to ${node.maxIterations}` : ""
          }`,
        });
        const inner = walk(node.children);
        for (const to of inner.entries) link(gate, to);
        /* the edge back is what makes it a loop rather than a list */
        for (const from of inner.exits) link(from, gate, undefined, "next iteration");
        return { entries: [gate], exits: [gate] };
      }

      case "embedded_data": {
        const id = add({
          id: node.id,
          kind: "action",
          ref: node.id,
          label: `capture ${node.fields.map((f) => f.name).slice(0, 4).join(", ")}${
            node.fields.length > 4 ? `, +${node.fields.length - 4}` : ""
          }`,
        });
        return { entries: [id], exits: [id] };
      }

      case "quota_check": {
        const id = add({
          id: node.id,
          kind: "decision",
          ref: node.id,
          label: `quota check (${node.quotaIds.length} quota${node.quotaIds.length === 1 ? "" : "s"})`,
        });
        if (node.onFull.kind === "terminate") link(id, endNodeFor("quota_full"), undefined, "full");
        if (node.onFull.kind === "redirect") {
          const away = add({ id: `${node.id}_redirect`, kind: "action", label: `redirect: ${node.onFull.url ?? ""}` });
          link(id, away, undefined, "full");
        }
        return { entries: [id], exits: [id] };
      }

      case "redirect": {
        const id = add({
          id: node.id,
          kind: "action",
          ref: node.id,
          label: `redirect to ${truncate(node.url, 40)}`,
        });
        return { entries: [id], exits: node.when ? [id] : [] };
      }

      case "end": {
        const id = add({
          id: node.id,
          kind: node.status === "complete" ? "end" : "terminate",
          ref: node.id,
          label: END_LABELS[node.status] ?? node.status,
        });
        /* nothing follows an End by falling through */
        return { entries: [id], exits: [] };
      }

      default:
        return EMPTY;
    }
  };

  walk(def.flow ?? []);

  /*
   * Skip rules last, so every node they might land on already exists. These
   * are the edges the flow tree cannot show — a jump out of the middle of a
   * page to somewhere else entirely — and they are the reason a graph is
   * worth having at all.
   */
  for (const q of def.questions ?? []) {
    for (const rule of q.skipLogic ?? []) {
      const from = seen.has(q.id) ? q.id : pageOf(def, q.id);
      if (!from) continue;
      const t = rule.target;
      let to: string | null = null;
      if (t.kind === "terminate") to = endNodeFor(t.status ?? "terminated");
      else if (t.kind === "end") to = t.ref && seen.has(t.ref) ? t.ref : endNodeFor("complete");
      else if (t.kind === "url") {
        to = add({ id: `url_${rule.id}`, kind: "action", label: `leave for ${truncate(t.ref ?? "", 36)}` });
      } else if (t.ref) {
        /*
         * A skip to a page, block or section lands on whatever the graph put
         * first inside it. When that container produced no nodes — an empty
         * block — the rule has nowhere to land and is left off rather than
         * drawn to something arbitrary; `runQualityCheck` reports it.
         */
        to = seen.has(t.ref) ? t.ref : firstInside(def, t.ref, seen);
      }
      if (!to) continue;
      link(from, to, rule.when, clean(rule.label) || `skip: ${edgeLabel(rule.when, def) ?? "condition"}`);
    }
  }

  /* the layout a person arranged, merged back on by id */
  const layout = opts.layout === undefined ? def.logicFlow : opts.layout;
  if (layout?.nodes?.length) {
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const stored = byId.get(n.id);
      if (!stored) continue;
      if (typeof stored.x === "number") n.x = stored.x;
      if (typeof stored.y === "number") n.y = stored.y;
    }
  }

  return { nodes, edges };
}

const END_LABELS: Record<string, string> = {
  complete: "Complete",
  screened: "Screened out",
  quota_full: "Quota full",
  terminated: "Terminated",
};

/** Does any display rule name this target? Used only to mark a node. */
function namesTarget(def: SurveyDefinition, kind: string, ref: string): boolean {
  return (def.displayRules ?? []).some((r) => r.target.kind === kind && r.target.ref === ref);
}

/** The page a question sits on, for a skip rule whose source is not a node. */
function pageOf(def: SurveyDefinition, questionId: string): string | null {
  let found: string | null = null;
  const walk = (nodes: FlowNode[]): void => {
    for (const n of nodes) {
      if (found) return;
      if (n.type === "page" && n.questionIds.includes(questionId)) { found = n.id; return; }
      const kids = (n as { children?: FlowNode[] }).children;
      if (kids) walk(kids);
      const branches = (n as { branches?: { children: FlowNode[] }[] }).branches;
      if (branches) for (const b of branches) walk(b.children);
      const other = (n as { otherwise?: FlowNode[] }).otherwise;
      if (other) walk(other);
    }
  };
  walk(def.flow ?? []);
  return found;
}

/** The first graph node inside a container, for a skip that targets it. */
function firstInside(def: SurveyDefinition, containerId: string, seen: Set<string>): string | null {
  let node: FlowNode | null = null;
  const find = (nodes: FlowNode[]): void => {
    for (const n of nodes) {
      if (node) return;
      if (n.id === containerId) { node = n; return; }
      const kids = (n as { children?: FlowNode[] }).children;
      if (kids) find(kids);
      const branches = (n as { branches?: { children: FlowNode[] }[] }).branches;
      if (branches) for (const b of branches) find(b.children);
      const other = (n as { otherwise?: FlowNode[] }).otherwise;
      if (other) find(other);
    }
  };
  find(def.flow ?? []);
  if (!node) return null;
  const first = (n: FlowNode): string | null => {
    if (seen.has(n.id)) return n.id;
    if (n.type === "page") {
      for (const qid of n.questionIds) if (seen.has(qid)) return qid;
      return null;
    }
    const kids = (n as { children?: FlowNode[] }).children ?? [];
    for (const k of kids) {
      const hit = first(k);
      if (hit) return hit;
    }
    return null;
  };
  return first(node);
}

/**
 * The graph as lines of text.
 *
 * The same content as the diagram, for the places a picture cannot go: a spec
 * sheet, a clipboard, a code review, a diff between two versions of a survey.
 * Generated from the graph rather than from the flow a second time, so the
 * text and the picture cannot disagree.
 */
export function logicFlowText(graph: LogicFlow): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  const KIND_MARK: Record<string, string> = {
    question: "▢", decision: "◆", action: "▷", terminate: "■", end: "●",
  };
  for (const n of graph.nodes) {
    out.push(`${KIND_MARK[n.kind] ?? "·"} ${n.label ?? n.id}`);
    for (const e of graph.edges.filter((x) => x.from === n.id)) {
      const target = byId.get(e.to);
      out.push(`      → ${target?.label ?? e.to}${e.label ? `   [${e.label}]` : ""}`);
    }
  }
  return out.join("\n");
}

/**
 * Nodes nothing reaches.
 *
 * Distinct from `validateFlowStructure`'s reachability, which walks the flow
 * in document order: this walks the EDGES, so a page reached only by a skip
 * rule counts as reached — which is the whole point of drawing the jumps.
 */
export function unreachableLogicNodes(graph: LogicFlow): LogicFlowNode[] {
  if (!graph.nodes.length) return [];
  const reached = new Set<string>([graph.nodes[0].id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of graph.edges) {
      if (reached.has(e.from) && !reached.has(e.to)) {
        reached.add(e.to);
        grew = true;
      }
    }
  }
  return graph.nodes.filter((n) => !reached.has(n.id));
}
