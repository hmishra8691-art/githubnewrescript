import type { FlowNode, SurveyDefinition, Question, SkipRule } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import type { LoopContext, ResponseState } from "./state.js";
import { getQuestion, answerKey, loopKeySuffix } from "./state.js";
import { loopContexts, loopVariables } from "./loops.js";
import { seededShuffle, subSeed } from "./random.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { checkQuotas, type QuotaCounts } from "./quotas.js";
import { applyEmbeddedField, type EmbeddedField } from "./embedded.js";
import { prefillQuestions } from "./setExpression.js";
import { resolveUrlTemplate } from "./redirect.js";
import { listFillHiddenDestinations } from "./listFill.js";

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
      /** resolved: page → enclosing block → branding.layout.showBlockTitles */
      showTitle: boolean;
      /** block media, resolved page → enclosing block */
      mediaUrl?: string;
      questionIds: string[];
      loop?: LoopContext | null;
      sectionPath: string[];
      /** ids of every enclosing flow node — block, section, branch, loop … — outermost first */
      nodePath: string[];
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
  const surveyDefault = def.branding?.layout?.showBlockTitles ?? true;
  // the container nodes around the node being walked (see RuntimeStep.nodePath)
  const nodePath: string[] = [];
  const walk = (
    nodes: FlowNode[],
    loop: LoopContext | null,
    sectionPath: string[],
    blockTitle?: string,
    blockShowTitle?: boolean,
    blockMedia?: string,
  ): void => {
    for (const node of nodes) {
      if (node.type !== "page") nodePath.push(node.id);
      try {
      switch (node.type) {
        case "page": {
          if (!evaluateCondition(node.visibleIf, ctxFor(loop))) break;
          steps.push({
            kind: "page",
            pageId: `${node.id}${loopKeySuffix(loop)}`,
            title: node.title ?? blockTitle,
            showTitle: node.showTitle ?? blockShowTitle ?? surveyDefault,
            mediaUrl: node.mediaUrl ?? blockMedia,
            questionIds: node.questionIds,
            loop,
            sectionPath,
            nodePath: [...nodePath],
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
            node.type === "block" ? (node.showTitle ?? blockShowTitle) : blockShowTitle,
            node.type === "block" ? (node.mediaUrl ?? blockMedia) : blockMedia,
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
          /*
           * Which items, in what order, how many, and what each knows about
           * itself is decided in ONE place — `loopContexts` in loops.ts — and
           * the Studio's simulator and the runtime inspector call the same
           * function. `loop` (the enclosing iteration, if this loop is nested)
           * becomes each context's `parent`, so the children below are walked
           * with the full stack rather than with the innermost item alone.
           *
           * Before this, an inner loop's context simply REPLACED the outer
           * one: every outer iteration wrote the inner loop's answers to the
           * same `q@<innerCode>` key and the last one won. The keys are now
           * the whole path, `q@<outer>@<inner>` (see `loopKeySuffix`), which a
           * single loop still spells `q@<code>` — so nothing already stored
           * moves.
           */
          const contexts = loopContexts(def, state, node, loop, quotaCounts);
          for (const iterLoop of contexts) {
            walk(node.children, iterLoop, sectionPath, blockTitle, blockShowTitle, blockMedia);
          }
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
      } finally {
        if (node.type !== "page") nodePath.pop();
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
  // a List Fill destination that received no item, configured to disappear
  // (§17). Only the rules that REMOVE the question act here; `disable` and
  // `blank` leave it on the page and are the renderer's business.
  const unusedDestinations = listFillHiddenDestinations(def, state);
  return step.questionIds
    .map((id) => getQuestion(def, id))
    .filter((q): q is Question => !!q)
    .filter((q) => q.type !== "hidden" && q.type !== "calculated" && q.type !== "embedded_data" && !q.settings.hidden)
    .filter((q) => evaluateCondition(q.displayLogic, ctx))
    .filter((q) => !hiddenByRules.has(q.id))
    .filter((q) => !unusedDestinations.has(q.id))
    .filter((q) => (shownByRules.has(q.id) ? shownByRules.get(q.id)! : true));
}

/** Run calculations whose trigger matches; write into state.calculated. */
export function runCalculations(
  def: SurveyDefinition,
  state: ResponseState,
  trigger: "on_change" | "on_page_submit" | "on_complete",
): void {
  /*
   * The loop variables first (§24): LOOP_<VAR>_COUNT, _ITEM_<n>, _ITEM_<n>_CODE
   * and one per reference column. They are a pure function of the answers and
   * the definition, recomputed here on every trigger so a calculation, a
   * condition or a script can read `LOOP_BRAND_COUNT` the moment Q2 is
   * answered — and so `flattenVariables` below can place each iteration's
   * answers in their positional export columns.
   */
  Object.assign(state.calculated, loopVariables(def, state));
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
  /** set when `start()` was asked to begin at a block */
  startAt?: { blockId: string; found: boolean };
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
      // a block / section is addressed by id (nodePath); the title match is kept for rules written against it
      if (s.kind === "page" && (s.nodePath.includes(target.ref ?? "") || s.sectionPath.includes(target.ref ?? ""))) return i;
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
  opts: { /** the pageId of the page being submitted, when the caller knows it */ fromPageId?: string } = {},
): NavigationResult {
  /*
   * Know WHICH page is being left, not just its index. Submitting a page can
   * change the steps in front of it — a List Fill decided on this submit gives
   * a listFill-sourced loop its items, a calculation changes a loop's count —
   * and after that the old index points at a different page. The Runner passes
   * the page it showed; otherwise the page at the stored index is taken, which
   * is right whenever nothing has shifted yet. Either way the page is found
   * again by id, so "next" keeps meaning the page after THIS one.
   */
  const leaving = compileFlow(def, state, quotaCounts)[state.stepIndex];
  const leavingPageId = opts.fromPageId ?? (leaving?.kind === "page" ? leaving.pageId : null);
  runCalculations(def, state, "on_page_submit");
  let steps = compileFlow(def, state, quotaCounts);
  const relocated = leavingPageId ? steps.findIndex((s) => s.kind === "page" && s.pageId === leavingPageId) : -1;
  let idx = relocated >= 0 ? relocated : Math.min(state.stepIndex, steps.length - 1);
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

  return moveForward(def, state, quotaCounts, idx + 1, triggeredSkips);
}

/**
 * Walk forward from `idx` to the next page with something to show, executing
 * every non-page step on the way (embedded data, quota checks, redirects,
 * ends). Shared by `advance` and `start`.
 */
function moveForward(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts,
  idx: number,
  triggeredSkips: NavigationResult["triggeredSkips"],
): NavigationResult {
  let steps = compileFlow(def, state, quotaCounts);
  let guard = 0;
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
  opts: StartOptions = {},
): NavigationResult {
  state.stepIndex = -1;
  if (opts.startAt) {
    // seeded answers stand for pages already submitted, so the values those
    // submits would have derived (calculations, loop variables) exist too
    runCalculations(def, state, "on_page_submit");
    const at = findBlockStart(def, state, quotaCounts, opts.startAt);
    if (at < 0) {
      return {
        ...moveForward(def, state, quotaCounts, 0, []),
        startAt: { blockId: opts.startAt, found: false },
      };
    }
    // no page precedes the start: nothing to run skip logic for, so step
    // straight into the block's first page, running whatever embedded-data or
    // quota steps sit inside the block before it
    return { ...moveForward(def, state, quotaCounts, at, []), startAt: { blockId: opts.startAt, found: true } };
  }
  return advanceFrom(def, state, quotaCounts, -1);
}

export interface StartOptions {
  /**
   * Begin at the first page of this block / section (a flow node id) instead
   * of the survey's first page — "Preview block". The rest of the survey runs
   * exactly as it would have: the same compiled flow, the same logic, piping,
   * masking, page breaks and punching, just entered later. Answers to earlier
   * questions may be seeded into `state.answers` beforehand.
   */
  startAt?: string;
}

/**
 * Index of the first step inside `blockId`, with the flow compiled against the
 * current answers; -1 when the block is not reachable — hidden by its own
 * display logic, inside a branch that does not match, or simply not a node.
 */
export function findBlockStart(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts,
  blockId: string,
): number {
  const steps = compileFlow(def, state, quotaCounts);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "page" && (s.nodePath.includes(blockId) || s.pageId === blockId || s.pageId.startsWith(`${blockId}@`))) return i;
  }
  return -1;
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
