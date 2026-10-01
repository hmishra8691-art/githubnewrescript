import type { Condition, ConditionRule, FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { orderIndex } from "./dependencies.js";
import { stripVacuous } from "./conditionWalk.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { formatCondition } from "./logicExpression.js";
import { buildLogicFlow, unreachableLogicNodes } from "./logicGraph.js";
import { runQualityCheck } from "./qualityCheck.js";
import { listBlocks, listPages } from "./blocks.js";

/**
 * WHY IS THIS QUESTION NOT SHOWING? — answered from the survey alone.
 *
 * `explainQuestionVisibility` answers the runtime question — given THESE
 * answers, is Q25 on screen — and `traceCondition` shows the working. What a
 * programmer asks in the Studio ("Why is Q25 not showing?", "Why is Q20
 * unreachable?") has no answers behind it: they want every reason the
 * question could be missed, in the order the runtime meets them, and which of
 * those reasons are certain. So this is a static pass over the definition:
 *
 *   1. is it a question that is asked at all?     type, settings.hidden
 *   2. is it on a page?                           not placed → never asked
 *   3. can the flow reach its page?               the derived logic graph
 *   4. what does the path to it depend on?        branches (and the branches
 *                                                 before it that win instead),
 *                                                 randomizer subsets, loop
 *                                                 eligibility, block/page
 *                                                 visibleIf
 *   5. its own display logic, and survey rules    — with the conditions that
 *                                                 can never be true named:
 *                                                 an answer read before it
 *                                                 exists, a question that is
 *                                                 not there, a constant false
 *   6. earlier skip rules that jump past it
 *   7. what the quality check says about it
 *
 * Each finding is `blocking` (the question can never be shown for this
 * reason), `conditional` (it is shown only sometimes) or `info`. The verdict
 * follows: never / sometimes / always. Nothing is changed; the Intelligent
 * mode prints this as its answer.
 */

export type DiagnosisSeverity = "blocking" | "conditional" | "info";
export interface DiagnosisFinding {
  kind:
    | "hidden_type" | "hidden_setting" | "not_placed" | "unreachable"
    | "branch" | "branch_shadowed" | "otherwise" | "randomizer" | "loop" | "container_logic"
    | "display_logic" | "display_rule" | "never_true" | "skipped_by" | "quality";
  severity: DiagnosisSeverity;
  message: string;
  /** flow node or question ids involved */
  refs?: string[];
}
export interface Diagnosis {
  questionId: string;
  code: string;
  verdict: "never" | "sometimes" | "always";
  summary: string;
  findings: DiagnosisFinding[];
}

/** operators that are FALSE when the question they read has no answer */
const NEEDS_ANSWER = new Set(["eq", "gt", "lt", "gte", "lte", "in", "contains", "selected", "answered", "between", "matches", "startsWith", "endsWith", "rankedAbove", "rankedAt"]);

interface Gate { kind: "branch" | "branch_shadowed" | "otherwise" | "randomizer" | "loop" | "container_logic"; text: string; when?: Condition; id: string }

/** what a caller diagnosing many questions computes once (the survey review does) */
export interface DiagnoseContext { quality?: ReturnType<typeof runQualityCheck>; dead?: ReturnType<typeof unreachableLogicNodes> }

export function diagnoseQuestion(def: SurveyDefinition, questionId: string, pre: DiagnoseContext = {}): Diagnosis | null {
  const q = def.questions.find((x) => x.id === questionId) ?? getQuestionByCodeOrVar(def, questionId);
  if (!q) return null;
  const code = q.code || q.variableName;
  const findings: DiagnosisFinding[] = [];
  const fc = (c: Condition | undefined) => (c ? formatCondition(def, c, { width: 400 }).replace(/\s+/g, " ").trim() : "");
  const order = orderIndex(def);
  const at = order[q.id] ?? Infinity;

  /* 1. asked at all? */
  if (q.type === "hidden" || q.type === "calculated" || q.type === "embedded_data") {
    findings.push({ kind: "hidden_type", severity: "blocking", message: `${code} is a ${q.type.replace(/_/g, " ")} question — the engine fills it; respondents never see it.` });
  }
  if ((q.settings as { hidden?: boolean } | undefined)?.hidden) findings.push({ kind: "hidden_setting", severity: "blocking", message: `${code} is set to hidden in its settings.` });

  /* 2–4. placed, reachable, and what the path to it depends on */
  const gates: Gate[] = [];
  let pageId: string | null = null;
  const walk = (nodes: FlowNode[], trail: Gate[]): boolean => {
    for (const n of nodes) {
      const k = n as FlowNode & { visibleIf?: Condition; children?: FlowNode[] };
      if (n.type === "page" && n.questionIds.includes(q.id)) {
        pageId = n.id;
        gates.push(...trail);
        if (k.visibleIf) gates.push({ kind: "container_logic", id: n.id, when: k.visibleIf, text: `its page ${n.title ? `“${n.title}” ` : ""}is shown only when ${fc(k.visibleIf)}` });
        return true;
      }
      if (n.type === "branch") {
        for (let i = 0; i < n.branches.length; i++) {
          const b = n.branches[i];
          const before = n.branches.slice(0, i).map((x) => ({ kind: "branch_shadowed" as const, id: x.id, when: x.when, text: `an earlier path of the same branch wins when ${fc(x.when)}` }));
          if (walk(b.children, [...trail, ...before, { kind: "branch", id: b.id, when: b.when, text: `it is inside ${n.title ? `branch “${n.title}”` : "a branch"}${b.label ? ` (${b.label})` : ""} taken only when ${fc(b.when) || "(no condition)"}` }])) return true;
        }
        if (n.otherwise && walk(n.otherwise, [...trail, { kind: "otherwise", id: n.id, text: `it is on the “otherwise” path of ${n.title ? `branch “${n.title}”` : "a branch"}: taken only when none of ${n.branches.map((b) => fc(b.when) || "?").join(" / ")} is true` }])) return true;
        continue;
      }
      if (!k.children) continue;
      const extra: Gate[] = [];
      if (n.type === "randomizer" && typeof n.show === "number" && n.show < n.children.length) extra.push({ kind: "randomizer", id: n.id, text: `it is in a randomizer that shows ${n.show} of ${n.children.length} elements, so only some respondents get it` });
      if (n.type === "loop" && n.eligibleIf) extra.push({ kind: "loop", id: n.id, when: n.eligibleIf, text: `it is inside loop ${n.title ? `“${n.title}”` : n.id}, asked only for items where ${fc(n.eligibleIf)}` });
      if (n.type === "loop" && !n.eligibleIf) extra.push({ kind: "loop", id: n.id, text: `it is inside loop ${n.title ? `“${n.title}”` : n.id}: asked once per item — never when the loop has no items` });
      if ((n.type === "block" || n.type === "section") && k.visibleIf) extra.push({ kind: "container_logic", id: n.id, when: k.visibleIf, text: `its ${n.type} ${n.title ? `“${n.title}” ` : ""}is shown only when ${fc(k.visibleIf)}` });
      if (walk(k.children, [...trail, ...extra])) return true;
    }
    return false;
  };
  const placed = walk(def.flow as FlowNode[], []);
  if (!placed) findings.push({ kind: "not_placed", severity: "blocking", message: `${code} is not on any page of the survey flow, so no respondent can reach it.` });
  else {
    const dead = pre.dead ?? unreachableLogicNodes(buildLogicFlow(def));
    if (dead.some((n) => n.ref === q.id || n.id === q.id || (pageId && n.page === pageId && n.ref === q.id))) {
      findings.push({ kind: "unreachable", severity: "blocking", message: `No path through the flow reaches ${code}: every route before it ends the survey or jumps past it.` });
    }
    for (const g of gates) {
      const never = g.when ? neverTrue(def, g.when, at, order) : null;
      if (never && g.kind !== "branch_shadowed") findings.push({ kind: "never_true", severity: "blocking", message: `${cap(g.text)} — and that can never be true: ${never}.`, refs: [g.id] });
      else if (g.kind === "branch_shadowed") { if (!g.when || !neverTrue(def, g.when, at, order)) findings.push({ kind: g.kind, severity: alwaysTrue(g.when) ? "blocking" : "conditional", message: `${cap(g.text)}${alwaysTrue(g.when) ? " — always, so this path is never taken" : ""}.`, refs: [g.id] }); }
      else findings.push({ kind: g.kind, severity: g.when && alwaysTrue(g.when) ? "info" : "conditional", message: `${cap(g.text)}.`, refs: [g.id] });
    }
  }

  /* 5. its own display logic and the survey's rules */
  if (q.displayLogic && !alwaysTrue(q.displayLogic)) {
    const never = neverTrue(def, q.displayLogic, at, order);
    findings.push(never
      ? { kind: "never_true", severity: "blocking", message: `Its display logic (${fc(q.displayLogic)}) can never be true: ${never}.` }
      : { kind: "display_logic", severity: "conditional", message: `It is shown only when ${fc(q.displayLogic)}.` });
  }
  for (const r of def.displayRules ?? []) {
    const aimed = r.target.kind === "question" ? r.target.ref === q.id : pageId !== null && (r.target.kind === "page" || r.target.kind === "block" || r.target.kind === "section") && containerHolds(def, r.target.ref, q.id);
    if (!aimed || r.target.subRef) continue;
    const never = neverTrue(def, r.when, at, order);
    const what = r.target.kind === "question" ? "" : ` (on its ${r.target.kind})`;
    if (r.action === "hide") findings.push({ kind: "display_rule", severity: alwaysTrue(r.when) ? "blocking" : "conditional", message: `Display rule ${r.label ? `“${r.label}” ` : ""}${what}hides it when ${fc(r.when) || "always"}.` });
    else findings.push(never ? { kind: "never_true", severity: "blocking", message: `Display rule ${r.label ? `“${r.label}” ` : ""}${what}shows it only when ${fc(r.when)}, which can never be true: ${never}.` } : { kind: "display_rule", severity: "conditional", message: `Display rule ${r.label ? `“${r.label}” ` : ""}${what}shows it only when ${fc(r.when)}.` });
  }

  /* 6. skip rules before it that jump past it */
  if (placed) {
    const firstOf = targetResolver(def);
    for (const from of def.questions) {
      const i = order[from.id];
      if (i === undefined || i >= at) continue;
      for (const s of from.skipLogic ?? []) {
        const t = s.target as { kind: string; ref?: string; status?: string };
        const j = t.kind === "end" || t.kind === "terminate" || t.kind === "url" ? Infinity : firstOf(t.kind, t.ref);
        if (j === null || j <= at) continue;
        const where = t.kind === "end" ? "the end" : t.kind === "terminate" ? `out of the survey (${t.status ?? "terminated"})` : t.kind === "url" ? "an external link" : labelAt(def, order, j);
        const always = alwaysTrue(s.when);
        findings.push({ kind: "skipped_by", severity: always ? "blocking" : "conditional", message: always ? `${from.code} always skips to ${where}, past ${code}.` : `${from.code} skips to ${where}, past ${code}, when ${fc(s.when)}.`, refs: [from.id] });
      }
    }
  }

  /* 7. what the quality check says */
  const qc = pre.quality ?? runQualityCheck(def);
  for (const issue of qc.areas.flatMap((a) => a.issues)) {
    if (issue.questionId !== q.id) continue;
    if (findings.some((f) => f.message === issue.message)) continue;
    findings.push({ kind: "quality", severity: "info", message: `Quality check (${issue.level}): ${issue.message}` });
  }

  const blocking = findings.filter((f) => f.severity === "blocking");
  const conditional = findings.filter((f) => f.severity === "conditional");
  const verdict: Diagnosis["verdict"] = blocking.length ? "never" : conditional.length ? "sometimes" : "always";
  const summary = verdict === "never"
    ? `${code} can never be shown: ${lower(blocking[0].message)}`
    : verdict === "sometimes"
      ? `${code} is shown only to some respondents — ${plural(conditional.length, "condition")} decide${conditional.length === 1 ? "s" : ""} it.`
      : `Nothing in the survey stops ${code} from being shown; every respondent who reaches its page sees it.`;
  return { questionId: q.id, code, verdict, summary, findings };
}

/* ------------------------------------------------------------ helpers */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * ALWAYS TRUE, READ THE WAY THE EVALUATOR READS IT: an absent condition, and
 * any tree made only of empty groups (an empty AND, an empty OR, NOT of
 * nothing — `isVacuousCondition`). Only a top-level empty AND used to count,
 * so a skip whose `when` was an empty OR — which fires for everybody — was
 * reported as conditional, and the diagnosis disagreed with the survey.
 */
function alwaysTrue(c: Condition | undefined): boolean {
  return stripVacuous(c) === null;
}

/**
 * A reason the condition can never be true, or null when it might be.
 * Deliberately conservative: it names only what is certain from the survey —
 * a positive test on an answer that does not exist yet when the condition is
 * read, on a question that is not in the survey, or an AND (at any depth of
 * nested ANDs) that asks one single-choice question for two different answers.
 *
 * It reads the tree with its empty groups taken out, exactly as the evaluator
 * does: an empty OR is no constraint (not "never"), and NOT of an empty group
 * is no constraint either (not "constant false"). Both used to be reported
 * as "can never be shown" for questions every respondent saw.
 */
function neverTrue(def: SurveyDefinition, raw: Condition, at: number, order: Record<string, number>): string | null {
  const c = stripVacuous(raw);
  if (!c) return null;
  if (c.type === "group") {
    if (c.op === "not") return null;
    if (c.op === "or") {
      const rs = c.children.map((k) => neverTrue(def, k, at, order));
      return rs.every(Boolean) ? rs.join("; and ") : null;
    }
    for (const k of c.children) { const r = neverTrue(def, k, at, order); if (r) return r; }
    /* every rule this AND requires, through nested ANDs */
    const required: ConditionRule[] = [];
    const collect = (g: Condition) => {
      if (g.type === "rule") { required.push(g); return; }
      if (g.op === "and") g.children.forEach(collect);
    };
    collect(c);
    const eqs = new Map<string, Set<string>>();
    for (const k of required) {
      if (k.source.kind !== "question" || (k.operator !== "eq" && k.operator !== "selected") || k.source.count) continue;
      const q = getQuestionByCodeOrVar(def, k.source.ref);
      if (!q || !isSingle(q) || k.source.rowCode) continue;
      const set = eqs.get(q.id) ?? new Set<string>(); set.add(String(k.value)); eqs.set(q.id, set);
      if (set.size > 1) return `${q.code} is a single choice and cannot be both ${[...set].join(" and ")}`;
    }
    return null;
  }
  const r = c as ConditionRule;
  if (r.source.kind !== "question") return null;
  const src = getQuestionByCodeOrVar(def, r.source.ref);
  if (!src) return NEEDS_ANSWER.has(r.operator) ? `${r.source.ref} is not a question in this survey` : null;
  const i = order[src.id];
  if (i !== undefined && i >= at && NEEDS_ANSWER.has(r.operator) && src.type !== "hidden" && src.type !== "calculated") {
    return i === at ? `it reads ${src.code} itself, which has no answer before it is shown` : `it reads ${src.code}, which comes after it — there is no answer to ${src.code} yet`;
  }
  return null;
}

function isSingle(q: Question): boolean {
  return q.type === "single_select" || q.type === "dropdown" || q.type === "nps";
}

function containerHolds(def: SurveyDefinition, containerId: string, questionId: string): boolean {
  const page = listPages(def.flow as unknown[]).find((p) => p.node.id === containerId);
  if (page) return page.node.questionIds.includes(questionId);
  const block = listBlocks(def.flow as unknown[]).find((b) => b.id === containerId);
  return !!block?.pages.some((p) => p.node.questionIds.includes(questionId));
}

/** a skip target → the order index of the first question it lands on */
function targetResolver(def: SurveyDefinition): (kind: string, ref?: string) => number | null {
  const order = orderIndex(def);
  const pages = listPages(def.flow as unknown[]);
  const blocks = listBlocks(def.flow as unknown[]);
  const first = (ids: string[]) => { const xs = ids.map((id) => order[id]).filter((x) => x !== undefined); return xs.length ? Math.min(...xs) : null; };
  return (kind, ref) => {
    if (!ref) return null;
    if (kind === "question") return order[getQuestionByCodeOrVar(def, ref)?.id ?? ref] ?? null;
    if (kind === "page") { const p = pages.find((x) => x.node.id === ref); return p ? first(p.node.questionIds) : null; }
    if (kind === "block" || kind === "section") { const b = blocks.find((x) => x.id === ref); return b ? first(b.pages.flatMap((p) => p.node.questionIds)) : null; }
    return null;
  };
}

function labelAt(def: SurveyDefinition, order: Record<string, number>, j: number): string {
  const id = Object.keys(order).find((k) => order[k] === j);
  const q = id ? def.questions.find((x) => x.id === id) : null;
  return q ? q.code : "a later question";
}
