import type { FlowNode, SurveyDefinition, Question, SkipRule } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import type { LoopContext, ResponseState } from "./state.js";
import { getQuestion, answerKey } from "./state.js";
import { seededShuffle, subSeed } from "./random.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { checkQuotas, type QuotaCounts } from "./quotas.js";
import { applyEmbeddedField, type EmbeddedField } from "./embedded.js";
import { prefillQuestions } from "./setExpression.js";
import { resolveUrlTemplate } from "./redirect.js";

/**
 * Survey Flow interpreter (requirement §7).
 *
 * The flow tree is compiled into a linear list of runtime steps given the
 * CURRENT response state — branches are resolved, randomizers use the
 * session seed, loops expand into iterations. Recompiling after every answer
 * keeps navigation correct even when the respondent goes back and changes
 * an earlier answer.
 */

export type RuntimeStep =
  | {
      kind: "page";
      pageId: string;
      title?: string;
      questionIds: string[];
      loop?: LoopContext | null;
      sectionPath: string[];
    }
  | { kind: "embedded_data"; nodeId: string; fields: EmbeddedField[] }
  | { kind: "quota_check"; nodeId: string; quotaIds: string[]; onFull: { kind: string; url?: string } }
  | { kind: "redirect"; nodeId: string; url: string; newWindow?: boolean }
  | { kind: "end"; nodeId: string; status: "complete" | "screened" | "quota_full" | "terminated"; message?: string; redirectUrl?: string };

export function compileFlow(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts?: QuotaCounts,
): RuntimeStep[] {
  const steps: RuntimeStep[] = [];
  const ctxFor = (loop: LoopContext | null): EvalContext => ({
    def,
    state,
    loop,
    quotaCounts,
  });

  /**
   * `blockTitle` is the name of the enclosing block, if any.
   *
   * A block can hold several pages — that is how a page break inside a block
   * is expressed — and a named block shows its name as the respondent-facing
   * heading. Rather than copying that name onto every child page (state that
   * would drift the moment someone edits the JSON), an untitled page inherits
   * it here. A page with its own title still wins, so a block can name its
   * pages individually.
   */
  const walk = (
    nodes: FlowNode[],
    loop: LoopContext | null,
    sectionPath: string[],
    blockTitle?: string,
  ): void => {
    for (const node of nodes) {
      switch (node.type) {
        case "page": {
          if (!evaluateCondition(node.visibleIf, ctxFor(loop))) break;
          steps.push({
            kind: "page",
            pageId: loop ? `${node.id}@${loop.code}` : node.id,
            title: node.title ?? blockTitle,
            questionIds: node.questionIds,
            loop,
            sectionPath,
          });
          break;
        }
        case "section":
        case "block": {
          if (!evaluateCondition(node.visibleIf, ctxFor(loop))) break;
          walk(
            node.children,
            loop,
            [...sectionPath, node.title ?? node.id],
            // a section groups pages for reporting; a block also names them
            node.type === "block" ? (node.title ?? blockTitle) : blockTitle,
          );
          break;
        }
        case "randomizer": {
          const seed = subSeed(state.seed, `flow:${node.id}`);
          let children = seededShuffle(node.children, seed);
          if (node.show != null) children = children.slice(0, node.show);
          walk(children, loop, sectionPath, blockTitle);
          break;
        }
        case "branch": {
          let matched = false;
          for (const b of node.branches) {
            if (evaluateCondition(b.when, ctxFor(loop))) {
              walk(b.children, loop, sectionPath, blockTitle);
              matched = true;
              break;
            }
          }
          if (!matched && node.otherwise) walk(node.otherwise, loop, sectionPath, blockTitle);
          break;
        }
        case "loop": {
          let items: { code: string; label: string }[] = [];
          if (node.source.kind === "static") {
            items = node.source.items;
          } else if (node.source.kind === "question") {
            const src = getQuestion(def, node.source.questionId);
            const answer = state.answers[node.source.questionId];
            const codes = Array.isArray(answer)
              ? answer
              : answer == null
                ? []
                : typeof answer === "object"
                  ? Object.keys(answer)
                  : [answer];
            if (node.source.filter === "all" && src) {
              items = src.options.map((o) => ({ code: String(o.code), label: o.label }));
            } else {
              items = codes.map((c) => {
                const opt = src?.options.find((o) => String(o.code) === String(c));
                return { code: String(c), label: opt?.label ?? String(c) };
              });
            }
          } else if (node.source.kind === "design") {
            const design = def.designs.find((d) => d.id === node.source.kind);
            const rows = design?.file?.rows ?? [];
            items = rows.map((r, i) => ({
              code: String((r as any).task ?? i + 1),
              label: `Task ${i + 1}`,
            }));
          }
          if (node.randomizeIterations) {
            items = seededShuffle(items, subSeed(state.seed, `loop:${node.id}`));
          }
          if (node.maxIterations != null) items = items.slice(0, node.maxIterations);
          items.forEach((item, i) => {
            const iterLoop: LoopContext = {
              loopVar: node.loopVar,
              code: item.code,
              label: item.label,
              index: i + 1,
            };
            walk(node.children, iterLoop, sectionPath, blockTitle);
          });
          break;
        }
        case "embedded_data":
          steps.push({ kind: "embedded_data", nodeId: node.id, fields: node.fields });
          break;
        case "quota_check":
          steps.push({ kind: "quota_check", nodeId: node.id, quotaIds: node.quotaIds, onFull: node.onFull });
          break;
        case "redirect":
          if (evaluateCondition(node.when, ctxFor(loop))) {
            steps.push({
              kind: "redirect",
              nodeId: node.id,
              // tokens in the URL are resolved against the state that exists
              // when the respondent actually reaches this step
              url: resolveUrlTemplate(node.url, ctxFor(loop)),
              newWindow: node.newWindow,
            });
          }
          break;
        case "end":
          steps.push({
            kind: "end",
            nodeId: node.id,
            status: node.status,
            message: node.message,
            redirectUrl: node.redirectUrl,
          });
          break;
      }
    }
  };

  walk(def.flow, null, []);
  // guarantee a final end step
  if (!steps.some((s) => s.kind === "end")) {
    steps.push({ kind: "end", nodeId: "__auto_end", status: "complete" });
  }
  return steps;
}

/** Questions actually visible on a page step (display logic + displayRules). */
export function visibleQuestions(
  def: SurveyDefinition,
  step: Extract<RuntimeStep, { kind: "page" }>,
  state: ResponseState,
  quotaCounts?: QuotaCounts,
): Question[] {
  const ctx: EvalContext = { def, state, loop: step.loop, quotaCounts };
  const hiddenByRules = new Set<string>();
  const shownByRules = new Map<string, boolean>();
  for (const rule of def.displayRules) {
    if (rule.target.kind !== "question") continue;
    const holds = evaluateCondition(rule.when, ctx);
    if (rule.action === "show") shownByRules.set(rule.target.ref, holds);
    else if (holds) hiddenByRules.add(rule.target.ref);
  }
  return step.questionIds
    .map((id) => getQuestion(def, id))
    .filter((q): q is Question => !!q)
    .filter((q) => q.type !== "hidden" && q.type !== "calculated" && q.type !== "embedded_data" && !q.settings.hidden)
    .filter((q) => evaluateCondition(q.displayLogic, ctx))
    .filter((q) => !hiddenByRules.has(q.id))
    .filter((q) => (shownByRules.has(q.id) ? shownByRules.get(q.id)! : true));
}

/** Run calculations whose trigger matches; write into state.calculated. */
export function runCalculations(
  def: SurveyDefinition,
  state: ResponseState,
  trigger: "on_change" | "on_page_submit" | "on_complete",
): void {
  const flat = flattenVariables(def, state);
  const resolver = (n: string) => (n in flat ? flat[n] : state.calculated[n]);
  const names = () => [...Object.keys(flat), ...Object.keys(state.calculated)];
  for (const calc of def.calculations) {
    if (calc.trigger !== trigger && !(trigger === "on_page_submit" && calc.trigger === "on_change")) continue;
    if (!evaluateCondition(calc.when, { def, state })) continue;
    try {
      const v = evaluateExpression(calc.expression, { resolver, names });
      state.calculated[calc.targetVariable] = Array.isArray(v) ? v.length : (v as any);
      flat[calc.targetVariable] = state.calculated[calc.targetVariable];
    } catch {
      state.calculated[calc.targetVariable] = null;
    }
  }
  // calculated-type questions with expressions
  for (const q of def.questions) {
    if (q.type === "calculated" && q.settings.expression) {
      try {
        const v = evaluateExpression(q.settings.expression, { resolver, names });
        state.answers[q.id] = Array.isArray(v) ? (v as any) : (v as any);
      } catch {
        /* leave unset */
      }
    }
  }
}

export interface NavigationResult {
  steps: RuntimeStep[];
  stepIndex: number;
  done: boolean;
  endStatus?: "complete" | "screened" | "quota_full" | "terminated";
  redirectUrl?: string;
  /** The redirect asked to open in a new tab rather than replace the survey. */
  redirectNewWindow?: boolean;
  triggeredSkips: { questionId: string; ruleId: string }[];
  quotaFull?: string[];
}

/** Evaluate skip logic for questions on the submitted page. */
function firstTriggeredSkip(
  def: SurveyDefinition,
  step: Extract<RuntimeStep, { kind: "page" }>,
  state: ResponseState,
): { rule: SkipRule; questionId: string } | null {
  const ctx: EvalContext = { def, state, loop: step.loop };
  for (const qid of step.questionIds) {
    const q = getQuestion(def, qid);
    if (!q) continue;
    for (const rule of q.skipLogic) {
      if (evaluateCondition(rule.when, ctx)) return { rule, questionId: qid };
    }
  }
  return null;
}

function findStepIndexForTarget(
  steps: RuntimeStep[],
  target: SkipRule["target"],
  fromIndex: number,
): number {
  if (target.kind === "question") {
    for (let i = fromIndex + 1; i < steps.length; i++) {
      const s = steps[i];
      if (s.kind === "page" && s.questionIds.includes(target.ref ?? "")) return i;
    }
  }
  if (target.kind === "page") {
    for (let i = fromIndex + 1; i < steps.length; i++) {
      const s = steps[i];
      if (s.kind === "page" && (s.pageId === target.ref || s.pageId.split("@")[0] === target.ref)) return i;
    }
  }
  if (target.kind === "block" || target.kind === "section") {
    for (let i = fromIndex + 1; i < steps.length; i++) {
      const s = steps[i];
      if (s.kind === "page" && s.sectionPath.includes(target.ref ?? "")) return i;
    }
  }
  if (target.kind === "end" || target.kind === "terminate") {
    for (let i = fromIndex + 1; i < steps.length; i++) {
      if (steps[i].kind === "end") return i;
    }
  }
  return -1;
}

/**
 * Advance from the current page. Handles: calculations, skip logic, quota
 * checks, embedded data capture, redirects, terminal steps.
 */
export function advance(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts = {},
): NavigationResult {
  runCalculations(def, state, "on_page_submit");
  let steps = compileFlow(def, state, quotaCounts);
  let idx = Math.min(state.stepIndex, steps.length - 1);
  const triggeredSkips: NavigationResult["triggeredSkips"] = [];

  const current = steps[idx];
  if (current?.kind === "page") {
    const skip = firstTriggeredSkip(def, current, state);
    if (skip) {
      triggeredSkips.push({ questionId: skip.questionId, ruleId: skip.rule.id });
      if (skip.rule.target.kind === "url") {
        state.status = "complete";
        return { steps, stepIndex: idx, done: true, endStatus: "complete", redirectUrl: skip.rule.target.ref, triggeredSkips, quotaFull: [] };
      }
      if (skip.rule.target.kind === "end" || skip.rule.target.kind === "terminate") {
        const status = skip.rule.target.status ?? (skip.rule.target.kind === "terminate" ? "terminated" : "complete");
        state.status = status;
        return { steps, stepIndex: steps.length - 1, done: true, endStatus: status, triggeredSkips, quotaFull: [] };
      }
      const j = findStepIndexForTarget(steps, skip.rule.target, idx);
      if (j >= 0) {
        idx = j - 1; // will ++ below
      }
    }
  }

  // move forward through non-page steps
  let guard = 0;
  idx++;
  while (guard++ < 10000) {
    steps = compileFlow(def, state, quotaCounts); // re-resolve (answers/embedded may change)
    if (idx >= steps.length) {
      state.status = "complete";
      return { steps, stepIndex: steps.length - 1, done: true, endStatus: "complete", triggeredSkips, quotaFull: [] };
    }
    const s = steps[idx];
    if (s.kind === "page") {
      const visible = visibleQuestions(def, s, state, quotaCounts);
      if (visible.length === 0) { idx++; continue; }
      state.stepIndex = idx;
      /*
       * Auto-selection runs here — once per navigation, on the questions the
       * respondent is about to see, from state that already exists. Doing it
       * during render would recompute on every keystroke and fight the
       * respondent for control of the answer.
       */
      prefillQuestions(visible, { def, state, loop: s.loop, quotaCounts },
        (q) => answerKey(q.id, s.loop));
      return { steps, stepIndex: idx, done: false, triggeredSkips, quotaFull: [] };
    }
    if (s.kind === "embedded_data") {
      // one typed capture per field: source → default → declared type
      for (const f of s.fields) applyEmbeddedField(def, state, f);
      idx++; continue;
    }
    if (s.kind === "quota_check") {
      const full = checkQuotas(def, state, quotaCounts, s.quotaIds);
      if (full.length > 0) {
        if (s.onFull.kind === "terminate") {
          state.status = "quota_full";
          return { steps, stepIndex: idx, done: true, endStatus: "quota_full", triggeredSkips, quotaFull: full };
        }
        if (s.onFull.kind === "redirect") {
          state.status = "quota_full";
          return { steps, stepIndex: idx, done: true, endStatus: "quota_full", redirectUrl: s.onFull.url, triggeredSkips, quotaFull: full };
        }
        if (s.onFull.kind === "flag") state.flags.push(...full.map((f) => `quota_full:${f}`));
      }
      idx++; continue;
    }
    if (s.kind === "redirect") {
      state.status = "complete";
      return {
        steps, stepIndex: idx, done: true, endStatus: "complete",
        redirectUrl: s.url, redirectNewWindow: s.newWindow, triggeredSkips, quotaFull: [],
      };
    }
    if (s.kind === "end") {
      state.status = s.status;
      runCalculations(def, state, "on_complete");
      return {
        steps, stepIndex: idx, done: true, endStatus: s.status,
        // an end-of-survey URL takes tokens too, so a completion can carry the
        // respondent id or a score back to the panel
        redirectUrl: s.redirectUrl
          ? resolveUrlTemplate(s.redirectUrl, { def, state, loop: null, quotaCounts })
          : undefined,
        triggeredSkips, quotaFull: [],
      };
    }
    idx++;
  }
  throw new Error("Flow did not terminate (guard exceeded)");
}

/** Step backwards to the previous visible page. */
export function goBack(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts = {},
): NavigationResult {
  const steps = compileFlow(def, state, quotaCounts);
  let idx = Math.min(state.stepIndex, steps.length - 1) - 1;
  while (idx >= 0) {
    const s = steps[idx];
    if (s.kind === "page" && visibleQuestions(def, s, state, quotaCounts).length > 0) {
      state.stepIndex = idx;
      return { steps, stepIndex: idx, done: false, triggeredSkips: [], quotaFull: [] };
    }
    idx--;
  }
  state.stepIndex = 0;
  return { steps, stepIndex: 0, done: false, triggeredSkips: [], quotaFull: [] };
}

/** First visible page for a fresh session. */
export function start(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts = {},
): NavigationResult {
  state.stepIndex = -1;
  const res = advanceFrom(def, state, quotaCounts, -1);
  return res;
}

function advanceFrom(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts,
  fromIndex: number,
): NavigationResult {
  state.stepIndex = fromIndex;
  return advance(def, state, quotaCounts);
}

export function setAnswer(
  def: SurveyDefinition,
  state: ResponseState,
  questionId: string,
  value: unknown,
  loop?: LoopContext | null,
): void {
  state.answers[answerKey(questionId, loop ?? null)] = value as any;
  runCalculations(def, state, "on_change");
}
