import type { Condition, FlowNode, Question, SurveyDefinition, ValidationRule, OptionLogic, ListOperation } from "@rescript/schema";
import { isQuestionValueRef } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
import { pipeTokensIn } from "./pipingTokens.js";
import { referencedNames } from "./embedded.js";
import { setExprSources } from "./setExpression.js";

/**
 * THE DEPENDENCY INDEX — every "reads from" relationship in a survey, typed.
 *
 * `dependencies.ts` already knows which QUESTIONS read which questions; it is
 * what the runtime uses for targeted recalculation and what the linter uses
 * for cycles. It is deliberately lossy: an edge says "Q7 depends on Q3" and
 * nothing about why, and everything that is not a question — a named display
 * rule, a branch, a calculation, a quota — is folded into the questions
 * around it.
 *
 * A programming environment needs the other thing. When a programmer selects
 * Q3 and asks "what uses this?", the honest answer is "display rule R2, the
 * branch after page 4, calculation TOTAL, and the piping in Q9's text" — each
 * one a place they can click. When they select rule R2 the answer is "it
 * reads Q3 and Q5 and it shows Q7". So this index has a node for each of
 * those object kinds and an edge for each reference, with the field path the
 * reference lives at and a label a person can read.
 *
 * Direction is always READER → READ. A display rule reads its condition's
 * questions, so `displayRule → question`. The rule's target reads the rule
 * (its visibility is decided by it), so `question(target) → displayRule`. One
 * direction, one meaning, and the two questions a programmer asks are the two
 * traversals: `reach` follows edges forward (what does this depend on, all
 * the way down); `affects` follows them backward (what would notice if this
 * changed).
 *
 * The index does not evaluate anything and does not decide reachability at
 * runtime — `buildLogicFlow` draws routing, `compileFlow` decides it. This is
 * the static "who mentions whom", for inspectors, badges, focus mode and the
 * Flow canvas's dependency overlay.
 */

export type ObjectKind =
  | "question"
  | "displayRule"
  | "skipRule"
  | "calculation"
  | "quota"
  | "flowNode"
  | "namedExpression"
  | "listFill"
  | "embedded";

/** `kind:id` — stable across renames because it is built on ids, not names. */
export type ObjectKey = `${ObjectKind}:${string}`;

export type EdgeKind =
  | "display"          // displayLogic / displayRule.when / visibleIf
  | "skip"             // skipLogic[].when
  | "validation"
  | "randomization"
  | "carryForward"
  | "listLogic"
  | "listOperation"
  | "mask"
  | "punch"
  | "optionLogic"
  | "piping"
  | "calculation"      // a calc expression naming a question or another calc
  | "quotaCell"
  | "flowCondition"    // branch arm, section/block/page visibleIf, loop filters, redirect.when
  | "loopSource"
  | "listFillSource"
  | "listFillGate"
  | "namedExpression"  // a condition using a named expression by id
  | "target"           // the object a rule / list fill acts on reads the rule
  | "placement";       // a question placed under a conditional container reads that container

export interface DependencyEdge {
  /** the reader — the object whose behaviour changes when `to` changes */
  from: ObjectKey;
  /** what it reads */
  to: ObjectKey;
  kind: EdgeKind;
  /** dotted path into the definition where the reference lives */
  path: string;
  /** what a person sees in a "used by" list: "Q7 — display logic" */
  label: string;
}

export interface ObjectInfo {
  key: ObjectKey;
  kind: ObjectKind;
  id: string;
  /** the short programmer-facing name: question code, rule label, calc variable, flow node title */
  code: string;
  label: string;
}

export interface DependencyIndex {
  edges: DependencyEdge[];
  nodes: Map<ObjectKey, ObjectInfo>;
  /** edges leaving `key`: what it reads */
  dependsOn(key: ObjectKey): DependencyEdge[];
  /** edges arriving at `key`: what reads it */
  usedBy(key: ObjectKey): DependencyEdge[];
  /** everything `key` reads, transitively, nearest first; never includes `key` */
  reach(key: ObjectKey): ObjectKey[];
  /** everything that reads `key`, transitively, nearest first; never includes `key` */
  affects(key: ObjectKey): ObjectKey[];
  /** the object a variable name or question code resolves to, or null */
  forName(name: string): ObjectKey | null;
}

export const objectKey = (kind: ObjectKind, id: string): ObjectKey => `${kind}:${id}`;

export function parseObjectKey(key: ObjectKey): { kind: ObjectKind; id: string } {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at) as ObjectKind, id: key.slice(at + 1) };
}

/* ------------------------------------------------------------ building */

type Emit = (to: ObjectKey, kind: EdgeKind, path: string) => void;

class Builder {
  readonly edges: DependencyEdge[] = [];
  readonly nodes = new Map<ObjectKey, ObjectInfo>();
  private readonly seen = new Set<string>();
  private readonly calcByVar = new Map<string, string>();
  private readonly exprByName = new Map<string, string>();
  private readonly quotaIds = new Set<string>();

  constructor(private readonly def: SurveyDefinition) {
    for (const c of def.calculations ?? []) this.calcByVar.set(c.targetVariable, c.id);
    for (const e of def.namedExpressions ?? []) this.exprByName.set(e.name, e.id);
    for (const q of def.quotas ?? []) this.quotaIds.add(q.id);
  }

  node(kind: ObjectKind, id: string, code: string, label: string): ObjectKey {
    const key = objectKey(kind, id);
    if (!this.nodes.has(key)) this.nodes.set(key, { key, kind, id, code, label });
    return key;
  }

  /** an edge is recorded once per (from, to, kind, path) — the same rule
   *  walked twice by two callers must not show twice in a "used by" list */
  edge(from: ObjectKey, to: ObjectKey, kind: EdgeKind, path: string, label: string): void {
    if (from === to) return;
    const sig = `${from}→${to}|${kind}|${path}`;
    if (this.seen.has(sig)) return;
    this.seen.add(sig);
    this.edges.push({ from, to, kind, path, label });
  }

  /** the node a question code / variable name / calc variable / named-expression name refers to */
  resolveName(name: string): ObjectKey | null {
    const q = getQuestionByCodeOrVar(this.def, name);
    if (q) return objectKey("question", q.id);
    const calc = this.calcByVar.get(name);
    if (calc) return objectKey("calculation", calc);
    const ex = this.exprByName.get(name);
    if (ex) return objectKey("namedExpression", ex);
    return null;
  }

  private questionKey(idOrName: string): ObjectKey | null {
    const q = getQuestionByCodeOrVar(this.def, idOrName);
    return q ? objectKey("question", q.id) : null;
  }

  /** every object a condition tree reads, each reported through `emit` */
  condition(c: Condition | undefined | null, kind: EdgeKind, path: string, emit: Emit): void {
    if (!c) return;
    if (c.type === "group") {
      c.children.forEach((ch, i) => this.condition(ch, kind, `${path}.children[${i}]`, emit));
      return;
    }
    const { source } = c;
    // the right-hand side can be another question
    for (const v of Array.isArray(c.value) ? c.value : [c.value]) {
      if (isQuestionValueRef(v)) {
        const k = this.questionKey(v.$question);
        if (k) emit(k, kind, `${path}.value`);
      }
    }
    switch (source.kind) {
      case "question":
      case "variable":
      case "option": {
        const k = this.resolveName(source.ref);
        if (k) emit(k, kind, `${path}.source.ref`);
        break;
      }
      case "calculation": {
        const id = this.calcByVar.get(source.ref);
        if (id) emit(objectKey("calculation", id), kind, `${path}.source.ref`);
        else { const k = this.resolveName(source.ref); if (k) emit(k, kind, `${path}.source.ref`); }
        break;
      }
      case "rule": {
        // a named expression, referenced by id (or by name in older surveys)
        const byId = (this.def.namedExpressions ?? []).find((e) => e.id === source.ref);
        const id = byId?.id ?? this.exprByName.get(source.ref);
        if (id) emit(objectKey("namedExpression", id), "namedExpression", `${path}.source.ref`);
        break;
      }
      case "quota": {
        if (this.quotaIds.has(source.ref)) emit(objectKey("quota", source.ref), kind, `${path}.source.ref`);
        break;
      }
      case "expr": {
        this.exprString(source.ref, kind, `${path}.source.ref`, emit);
        break;
      }
      case "embedded": {
        emit(objectKey("embedded", source.ref), kind, `${path}.source.ref`);
        break;
      }
      default:
        break;
    }
    if (source.count?.where) this.condition(source.count.where, kind, `${path}.source.count.where`, emit);
  }

  /** identifiers inside a calc-DSL string */
  exprString(expr: string | undefined, kind: EdgeKind, path: string, emit: Emit): void {
    if (!expr) return;
    for (const name of new Set(referencedNames(expr))) {
      const k = this.resolveName(name);
      if (k) emit(k, kind, path);
    }
  }

  /** `{{Q3}}`, `{{calc:TOTAL}}`, `{{ed.PANEL_ID}}` inside text */
  piping(text: string | undefined, path: string, emit: Emit): void {
    if (!text || !text.includes("{{")) return;
    for (const t of pipeTokensIn(text)) {
      if (t.kind === "question") {
        const k = this.questionKey(t.ref);
        if (k) emit(k, "piping", path);
      } else if (t.kind === "calc") {
        const id = this.calcByVar.get(t.ref);
        if (id) emit(objectKey("calculation", id), "piping", path);
      } else if (t.kind === "embedded") {
        emit(objectKey("embedded", t.ref), "piping", path);
      } else if (t.kind === "expr") {
        this.exprString(t.ref, "piping", path, emit);
      }
    }
  }

  private validation(rules: ValidationRule[] | undefined, path: string, emit: Emit): void {
    (rules ?? []).forEach((v, i) => {
      const p = `${path}[${i}]`;
      this.condition(v.when, "validation", `${p}.when`, emit);
      this.condition(v.check, "validation", `${p}.check`, emit);
      if ((v.kind === "custom_expression" || v.kind === "custom_script") && typeof v.value === "string") {
        this.exprString(v.value, "validation", `${p}.value`, emit);
      }
      this.piping(v.message, `${p}.message`, emit);
    });
  }

  private optionLogic(l: OptionLogic | undefined, path: string, emit: Emit): void {
    if (!l) return;
    const conds: [Condition | undefined, string][] = [
      [l.when, "when"], [l.eligibleWhen, "eligibleWhen"], [l.excludeWhen, "excludeWhen"],
      [l.prioritizeWhen, "prioritizeWhen"], [l.deprioritizeWhen, "deprioritizeWhen"], [l.randomizeWhen, "randomizeWhen"],
    ];
    for (const [c, f] of conds) this.condition(c, "optionLogic", `${path}.${f}`, emit);
    for (const [r, f] of [[l.carryForward, "carryForward"], [l.carryBack, "carryBack"]] as const) {
      if (r?.sourceQuestionId) {
        const k = this.questionKey(r.sourceQuestionId);
        if (k) emit(k, "carryForward", `${path}.${f}.sourceQuestionId`);
      }
    }
  }

  private listOps(ops: ListOperation[] | undefined, path: string, emit: Emit): void {
    (ops ?? []).forEach((op, i) => {
      const p = `${path}[${i}]`;
      this.condition(op.when, "listOperation", `${p}.when`, emit);
      this.condition(op.where, "listOperation", `${p}.where`, emit);
      (op.sources ?? []).forEach((s, j) => {
        if (s.questionId) { const k = this.questionKey(s.questionId); if (k) emit(k, "listOperation", `${p}.sources[${j}].questionId`); }
      });
    });
  }

  private setExpr(expr: unknown, kind: EdgeKind, path: string, emit: Emit): void {
    for (const id of setExprSources(expr as never, undefined, this.def)) {
      const k = this.questionKey(id);
      if (k) emit(k, kind, path);
    }
  }

  question(q: Question, index: number): void {
    const me = this.node("question", q.id, q.code, q.text ?? q.code);
    const base = `questions[${index}]`;
    const label = (what: string) => `${q.code} — ${what}`;
    const emit = (what: string): Emit => (to, kind, path) => this.edge(me, to, kind, path, label(what));

    this.condition(q.displayLogic, "display", `${base}.displayLogic`, emit("display logic"));

    (q.skipLogic ?? []).forEach((r, i) => {
      const sk = this.node("skipRule", `${q.id}/${r.id}`, `${q.code} skip ${i + 1}`, r.label ?? `Skip from ${q.code}`);
      const p = `${base}.skipLogic[${i}]`;
      this.condition(r.when, "skip", `${p}.when`, (to, kind, path) => this.edge(sk, to, kind, path, `${q.code} — skip logic`));
      // where the respondent goes after this question is decided by the skip,
      // so the question reads it — the same shape as a display rule's target
      this.edge(me, sk, "skip", `${p}`, `${q.code} — skip logic`);
      // the target's routing is decided by the skip
      if (r.target.ref && (r.target.kind === "question")) {
        const tk = this.questionKey(r.target.ref);
        if (tk) this.edge(tk, sk, "target", `${p}.target.ref`, `${q.code} skip ${i + 1} — jumps here`);
      } else if (r.target.ref) {
        this.edge(objectKey("flowNode", r.target.ref), sk, "target", `${p}.target.ref`, `${q.code} skip ${i + 1} — jumps here`);
      }
    });

    this.validation(q.validation, `${base}.validation`, emit("validation"));
    (q.randomization?.rules ?? []).forEach((r, i) =>
      this.condition(r.when, "randomization", `${base}.randomization.rules[${i}].when`, emit("randomization")));

    if (q.carryForward) {
      const k = this.questionKey(q.carryForward.sourceQuestionId);
      if (k) this.edge(me, k, "carryForward", `${base}.carryForward.sourceQuestionId`, label("carry-forward"));
      this.condition(q.carryForward.where, "carryForward", `${base}.carryForward.where`, emit("carry-forward"));
    }
    (q.listLogic ?? []).forEach((r, i) => {
      const k = this.questionKey(r.sourceQuestionId);
      if (k) this.edge(me, k, "listLogic", `${base}.listLogic[${i}].sourceQuestionId`, label("list logic"));
      this.condition(r.when, "listLogic", `${base}.listLogic[${i}].when`, emit("list logic"));
    });
    this.listOps(q.optionPipeline, `${base}.optionPipeline`, emit("list operation"));

    for (const [m, f] of [[q.mask, "mask"], [q.rowMask, "rowMask"], [q.columnMask, "columnMask"]] as const) {
      if (!m) continue;
      this.setExpr(m.expr, "mask", `${base}.${f}.expr`, emit("masking"));
      this.condition(m.when, "mask", `${base}.${f}.when`, emit("masking"));
    }
    (q.punches ?? []).forEach((rule, i) => {
      this.setExpr(rule.source, "punch", `${base}.punches[${i}].source`, emit("auto punch"));
      this.condition(rule.when, "punch", `${base}.punches[${i}].when`, emit("auto punch"));
    });

    (q.options ?? []).forEach((o, i) => {
      const p = `${base}.options[${i}]`;
      this.condition(o.visibleIf, "optionLogic", `${p}.visibleIf`, emit(`option ${o.code}`));
      this.optionLogic(o.logic, `${p}.logic`, emit(`option ${o.code}`));
      this.piping(o.label, `${p}.label`, emit(`option ${o.code} label`));
    });
    (q.rows ?? []).forEach((r, i) => {
      const p = `${base}.rows[${i}]`;
      this.condition(r.visibleIf, "optionLogic", `${p}.visibleIf`, emit(`row ${r.code}`));
      this.optionLogic(r.logic, `${p}.logic`, emit(`row ${r.code}`));
      this.piping(r.label, `${p}.label`, emit(`row ${r.code} label`));
      this.validation(r.validation, `${p}.validation`, emit(`row ${r.code} validation`));
    });
    (q.columns ?? []).forEach((c, i) => {
      const p = `${base}.columns[${i}]`;
      this.condition(c.visibleIf, "optionLogic", `${p}.visibleIf`, emit(`column ${c.id}`));
      this.optionLogic(c.logic, `${p}.logic`, emit(`column ${c.id}`));
      if (c.carryForward) {
        const k = this.questionKey(c.carryForward.sourceQuestionId);
        if (k) this.edge(me, k, "carryForward", `${p}.carryForward.sourceQuestionId`, label(`column ${c.id} carry-forward`));
        this.condition(c.carryForward.where, "carryForward", `${p}.carryForward.where`, emit(`column ${c.id}`));
      }
      (c.options ?? []).forEach((o, j) => {
        this.condition(o.visibleIf, "optionLogic", `${p}.options[${j}].visibleIf`, emit(`column ${c.id} option ${o.code}`));
        this.optionLogic(o.logic, `${p}.options[${j}].logic`, emit(`column ${c.id} option ${o.code}`));
      });
      this.validation(c.validation, `${p}.validation`, emit(`column ${c.id} validation`));
    });

    for (const [t, f] of [[q.text, "text"], [q.instruction, "instruction"], [q.description, "description"], [q.customHtml, "customHtml"]] as const) {
      this.piping(t, `${base}.${f}`, emit(f === "text" ? "question text" : f));
    }
  }

  displayRules(): void {
    (this.def.displayRules ?? []).forEach((r, i) => {
      const code = r.label || `Rule ${i + 1}`;
      const me = this.node("displayRule", r.id, code, `${r.action === "hide" ? "Hide" : "Show"} ${r.target.ref}`);
      const p = `displayRules[${i}]`;
      this.condition(r.when, "display", `${p}.when`, (to, kind, path) => this.edge(me, to, kind, path, `${code} — condition`));
      // the target's visibility is decided by the rule
      const target = r.target.kind === "question"
        ? this.questionKey(r.target.ref)
        : objectKey("flowNode", r.target.ref);
      if (target) this.edge(target, me, "target", `${p}.target`, `${code} — ${r.action === "hide" ? "hides" : "shows"} this`);
    });
  }

  calculations(): void {
    (this.def.calculations ?? []).forEach((c, i) => {
      const me = this.node("calculation", c.id, c.targetVariable, c.label ?? c.targetVariable);
      const p = `calculations[${i}]`;
      this.exprString(c.expression, "calculation", `${p}.expression`, (to, kind, path) =>
        this.edge(me, to, kind, path, `${c.targetVariable} — expression`));
      this.condition(c.when, "calculation", `${p}.when`, (to, kind, path) =>
        this.edge(me, to, kind, path, `${c.targetVariable} — runs when`));
    });
  }

  namedExpressions(): void {
    (this.def.namedExpressions ?? []).forEach((e, i) => {
      const me = this.node("namedExpression", e.id, e.name, e.description ?? e.name);
      this.condition(e.when, "namedExpression", `namedExpressions[${i}].when`, (to, kind, path) =>
        this.edge(me, to, kind, path, `${e.name} — definition`));
    });
  }

  quotas(): void {
    (this.def.quotas ?? []).forEach((q, i) => {
      const me = this.node("quota", q.id, q.name, q.name);
      q.cells.forEach((cell, j) => {
        this.condition(cell.when, "quotaCell", `quotas[${i}].cells[${j}].when`, (to, kind, path) =>
          this.edge(me, to, kind, path, `${q.name} — cell ${cell.label}`));
      });
    });
  }

  listFills(): void {
    (this.def.listFills ?? []).forEach((lf, i) => {
      const code = lf.name ?? lf.id;
      const me = this.node("listFill", lf.id, code, lf.label ?? code);
      const p = `listFills[${i}]`;
      if (lf.source.kind === "question") {
        const k = this.questionKey(lf.source.questionId);
        if (k) this.edge(me, k, "listFillSource", `${p}.source.questionId`, `${code} — source`);
      }
      this.condition(lf.runWhen, "listFillGate", `${p}.runWhen`, (to, kind, path) =>
        this.edge(me, to, kind, path, `${code} — runs when`));
      (lf.destinations ?? []).forEach((d, j) => {
        const k = this.questionKey(d.questionId);
        if (k) this.edge(k, me, "target", `${p}.destinations[${j}].questionId`, `${code} — fills this`);
      });
      if (lf.repeatBlockId) this.edge(objectKey("flowNode", lf.repeatBlockId), me, "target", `${p}.repeatBlockId`, `${code} — repeats this`);
    });
  }

  /**
   * Flow: a container with a condition is a node; the pages under it read it.
   * An unconditional block is grouping, not dependency, and gets no edges —
   * otherwise every question in a 600-question survey would "depend on" its
   * block and the affects list would be the whole survey.
   */
  flow(): void {
    const walk = (nodes: FlowNode[], path: string, enclosing: ObjectKey[]): void => {
      nodes.forEach((n, i) => {
        const p = `${path}[${i}]`;
        const title = (n as { title?: string }).title;
        const code = title || `${n.type} ${n.id}`;
        const emitFor = (me: ObjectKey, what: string): Emit => (to, kind, ep) => this.edge(me, to, kind, ep, `${code} — ${what}`);

        switch (n.type) {
          case "page": {
            let inner = enclosing;
            if (n.visibleIf) {
              const me = this.node("flowNode", n.id, code, "Page");
              this.condition(n.visibleIf, "flowCondition", `${p}.visibleIf`, emitFor(me, "shown when"));
              inner = [...enclosing, me];
            }
            for (const qid of n.questionIds) {
              const qk = this.questionKey(qid);
              if (!qk) continue;
              for (const container of inner) {
                this.edge(qk, container, "placement", `${p}.questionIds`, `${this.nodes.get(container)?.code ?? container} — placed inside`);
              }
            }
            break;
          }
          case "section":
          case "block": {
            let inner = enclosing;
            if (n.visibleIf) {
              const me = this.node("flowNode", n.id, code, n.type === "block" ? "Block" : "Section");
              this.condition(n.visibleIf, "flowCondition", `${p}.visibleIf`, emitFor(me, "shown when"));
              inner = [...enclosing, me];
            }
            walk(n.children, `${p}.children`, inner);
            break;
          }
          case "randomizer":
            walk(n.children, `${p}.children`, enclosing);
            break;
          case "branch": {
            const me = this.node("flowNode", n.id, code, "Branch");
            n.branches.forEach((arm, j) => {
              this.condition(arm.when, "flowCondition", `${p}.branches[${j}].when`, emitFor(me, arm.label ? `arm "${arm.label}"` : `arm ${j + 1}`));
              walk(arm.children, `${p}.branches[${j}].children`, [...enclosing, me]);
            });
            if (n.otherwise) walk(n.otherwise, `${p}.otherwise`, [...enclosing, me]);
            break;
          }
          case "loop": {
            const me = this.node("flowNode", n.id, n.loopVar || code, "Loop");
            const src = n.source as { kind: string; questionId?: string; listFillId?: string; ref?: string; expr?: unknown };
            if (src.kind === "question" && src.questionId) {
              const k = this.questionKey(src.questionId);
              if (k) this.edge(me, k, "loopSource", `${p}.source.questionId`, `${code} — iterates over`);
            } else if (src.kind === "listFill" && src.listFillId) {
              this.edge(me, objectKey("listFill", src.listFillId), "loopSource", `${p}.source.listFillId`, `${code} — iterates over`);
            } else if (src.kind === "variable" && src.ref) {
              const k = this.resolveName(src.ref);
              if (k) this.edge(me, k, "loopSource", `${p}.source.ref`, `${code} — iterates over`);
            } else if (src.kind === "setExpression") {
              this.setExpr(src.expr, "loopSource", `${p}.source.expr`, emitFor(me, "iterates over"));
            }
            for (const [c, f] of [[n.eligibleIf, "eligibleIf"], [n.invalidIf, "invalidIf"], [n.skipIf, "skipIf"], [n.breakIf, "breakIf"]] as const) {
              this.condition(c, "flowCondition", `${p}.${f}`, emitFor(me, f));
            }
            walk(n.children, `${p}.children`, [...enclosing, me]);
            break;
          }
          case "embedded_data": {
            n.fields.forEach((f, j) => {
              const me = this.node("embedded", f.name, f.name, "Embedded data");
              if (f.source === "expression" && f.value) {
                this.exprString(f.value, "calculation", `${p}.fields[${j}].value`, emitFor(me, "expression"));
              }
            });
            break;
          }
          case "quota_check": {
            const me = this.node("flowNode", n.id, code, "Quota check");
            n.quotaIds.forEach((qid, j) => {
              if (this.quotaIds.has(qid)) this.edge(me, objectKey("quota", qid), "quotaCell", `${p}.quotaIds[${j}]`, `${code} — checks`);
            });
            break;
          }
          case "redirect": {
            const me = this.node("flowNode", n.id, code, "Redirect");
            this.condition(n.when, "flowCondition", `${p}.when`, emitFor(me, "when"));
            this.piping(n.url, `${p}.url`, emitFor(me, "url"));
            break;
          }
          default:
            break;
        }
      });
    };
    walk(this.def.flow ?? [], "flow", []);
  }
}

/* ------------------------------------------------------------ public */

export function buildDependencyIndex(def: SurveyDefinition): DependencyIndex {
  const b = new Builder(def);
  def.questions.forEach((q, i) => b.question(q, i));
  b.displayRules();
  b.calculations();
  b.namedExpressions();
  b.quotas();
  b.listFills();
  b.flow();

  // referenced-but-undeclared targets (a dangling flow id) still get a node so the edge is inspectable
  for (const e of b.edges) {
    for (const k of [e.from, e.to]) {
      if (!b.nodes.has(k)) {
        const { kind, id } = parseObjectKey(k);
        b.nodes.set(k, { key: k, kind, id, code: id, label: `${kind} ${id}` });
      }
    }
  }

  const out = new Map<ObjectKey, DependencyEdge[]>();
  const inn = new Map<ObjectKey, DependencyEdge[]>();
  for (const e of b.edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
  }

  const walk = (start: ObjectKey, next: (k: ObjectKey) => DependencyEdge[], pick: (e: DependencyEdge) => ObjectKey): ObjectKey[] => {
    const seen = new Set<ObjectKey>([start]);
    const order: ObjectKey[] = [];
    const queue: ObjectKey[] = [start];
    while (queue.length) {
      const k = queue.shift()!;
      for (const e of next(k)) {
        const n = pick(e);
        if (seen.has(n)) continue;
        seen.add(n);
        order.push(n);
        queue.push(n);
      }
    }
    return order;
  };

  const dependsOn = (k: ObjectKey) => out.get(k) ?? [];
  const usedBy = (k: ObjectKey) => inn.get(k) ?? [];

  return {
    edges: b.edges,
    nodes: b.nodes,
    dependsOn,
    usedBy,
    reach: (k) => walk(k, dependsOn, (e) => e.to),
    affects: (k) => walk(k, usedBy, (e) => e.from),
    forName: (name) => b.resolveName(name),
  };
}

/**
 * The index, grouped the way an inspector shows it: each neighbour once,
 * with every reason it is a neighbour.
 */
export function neighbours(
  ix: DependencyIndex,
  key: ObjectKey,
  direction: "dependsOn" | "usedBy",
): { key: ObjectKey; info: ObjectInfo; reasons: DependencyEdge[] }[] {
  const grouped = new Map<ObjectKey, DependencyEdge[]>();
  for (const e of ix[direction](key)) {
    const other = direction === "dependsOn" ? e.to : e.from;
    (grouped.get(other) ?? grouped.set(other, []).get(other)!).push(e);
  }
  return [...grouped.entries()].map(([k, reasons]) => ({
    key: k,
    info: ix.nodes.get(k) ?? { key: k, ...parseObjectKey(k), code: k, label: k },
    reasons,
  }));
}
