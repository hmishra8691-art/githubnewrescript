import type { FlowNode, SurveyDefinition, Question } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import { getQuestion, lookupAnswer } from "./state.js";
import { isEmptyAnswer } from "./answers.js";
import { evaluateCondition } from "./evaluate.js";
import { applyEmbeddedFieldInFlow } from "./embeddedPiping.js";
import type { QuotaCounts } from "./quotas.js";
import { blockingErrors, validatePage } from "./validate.js";
import { assessmentSettings } from "./assessment.js";
import {
  advance, arriveAt, compileFlow, markSeen, runCalculations, seenPages, setVisitedPages, start, visibleQuestions, visitedPages,
  type NavigationResult, type RuntimeStep, type VisibilityOptions,
} from "./flow.js";

/**
 * NATIVE SECTION NAVIGATION (2026-10-30, docs/SECTION-NAVIGATION-2026-10-30.md).
 *
 * An exam-style paper (History, Geography, … ) wants a bar that jumps between
 * sections. Survey scripts cannot press Next or Back (they run in a sandboxed
 * iframe, by design), so the jump is native and has exactly ONE rule, here,
 * which the Runner's navigator, the script API (`rs.goToPage` /
 * `rs.goToSection`, checked by the host) and the save route's replay all use.
 *
 *   BACKWARD   to a page earlier in the compiled flow that still has something
 *              to show — Back's semantics: logic re-evaluated, the visited
 *              stack trimmed so Back afterwards returns to the page before the
 *              target in the respondent's own trail. Allowed in every mode
 *              unless the survey has no navigator and hides Back.
 *   VISITED    forward to a page the respondent has already seen (in the trail
 *              or with an answer on it): exactly as if Next were pressed until
 *              it is reached — every page in between validates, skip logic and
 *              quota checks run. Mode "visited" and "free".
 *   FREE       forward to any page reachable in the compiled flow from the
 *              current answers, skipping pages unvalidated — never a page
 *              hidden by logic, never past an end / redirect / quota check,
 *              never past a page whose skip logic fires, never into a loop
 *              iteration that does not exist (it is not in the compiled flow).
 *              Mode "free" only. Skipped required questions are checked at
 *              Submit (`submitGate`).
 *
 * Pure and deterministic: everything is a function of the definition, the
 * state and the quota counts.
 */

export type SectionNavMode = "off" | "visited" | "free";

export function sectionNavMode(def: SurveyDefinition): SectionNavMode {
  const m = (def as { navigation?: { sectionNav?: unknown } }).navigation?.sectionNav;
  return m === "visited" || m === "free" ? m : "off";
}

export type GoToRefusal =
  | "not_found"
  | "hidden"
  | "same_page"
  | "back_disabled"
  | "forward_locked"
  | "blocked_by_end"
  | "blocked_by_quota"
  | "skip_logic"
  | "incomplete"
  | "not_on_path"
  | "no_current_page";

export interface GoToResult extends NavigationResult {
  ok: boolean;
  /** how the jump was made, when it was */
  via?: "back" | "visited" | "free";
  refusal?: GoToRefusal;
  /** respondent-readable reason when refused */
  reason?: string;
  /** the page / question that refused it (an "incomplete" page in between) */
  pageId?: string;
  questionId?: string;
}

export interface GoToOptions extends VisibilityOptions {
  /** overrides the survey's setting (tests, the Studio preview) */
  mode?: SectionNavMode;
  /** how `target` is read: a page id (or a question id / code on it), a section (flow block / section id or title), or either */
  as?: "page" | "section" | "auto";
}

type PageStep = Extract<RuntimeStep, { kind: "page" }>;
const isPage = (s: RuntimeStep | undefined): s is PageStep => s?.kind === "page";
const DISPLAY_ONLY = new Set(["html", "hidden", "calculated", "embedded_data", "experiment"]);

/* ------------------------------------------------------------ sections */

interface ContainerInfo { id: string; type: "block" | "section"; title?: string }

function containerIndex(def: SurveyDefinition): Map<string, ContainerInfo> {
  const out = new Map<string, ContainerInfo>();
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "block" || n.type === "section") out.set(n.id, { id: n.id, type: n.type, title: n.title });
      if ("children" in n && Array.isArray((n as { children?: FlowNode[] }).children)) walk((n as { children: FlowNode[] }).children);
      if (n.type === "branch") { for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); }
    }
  };
  walk(def.flow);
  return out;
}

/** The section a page belongs to: its OUTERMOST enclosing block / section (null when it sits in none). */
function sectionOf(step: PageStep, containers: Map<string, ContainerInfo>): ContainerInfo | null {
  for (const id of step.nodePath) { const c = containers.get(id); if (c) return c; }
  return null;
}

function pagesInDef(def: SurveyDefinition): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "page") out.set(n.id, n.questionIds);
      if ("children" in n && Array.isArray((n as { children?: FlowNode[] }).children)) walk((n as { children: FlowNode[] }).children);
      if (n.type === "branch") { for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); }
    }
  };
  walk(def.flow);
  return out;
}

const shows = (def: SurveyDefinition, s: PageStep, state: ResponseState, counts: QuotaCounts, view: VisibilityOptions) =>
  visibleQuestions(def, s, state, counts, view).length > 0;

const answerable = (qs: Question[]) => qs.filter((q) => !DISPLAY_ONLY.has(q.type));

function pageAnswered(def: SurveyDefinition, s: PageStep, state: ResponseState, counts: QuotaCounts): boolean {
  return answerable(visibleQuestions(def, s, state, counts)).some((q) => !isEmptyAnswer(lookupAnswer(state.answers, q.id, s.loop ?? null)));
}

/** Has the respondent seen this page? In the trail, before the current page, or holding an answer. */
function isVisited(def: SurveyDefinition, steps: RuntimeStep[], idx: number, state: ResponseState, counts: QuotaCounts, trail: Set<string>): boolean {
  const s = steps[idx];
  if (!isPage(s)) return false;
  return idx === state.stepIndex || trail.has(s.pageId) || idx < state.stepIndex || pageAnswered(def, s, state, counts);
}

export interface SectionEntry {
  /** the block / section id (the key `goToSection` takes) */
  id: string;
  title: string;
  /** first page step of the section with something to show */
  firstStepIndex: number;
  pageIds: string[];
  current: boolean;
  visited: boolean;
  answered: number;
  total: number;
  /** a click would not be accepted (cheap check — `goToPage` has the final word and says why) */
  locked: boolean;
}

/**
 * The sections the navigator shows: the outermost blocks / sections with at
 * least one page that has something to show, in flow order, each with its
 * state. Pages outside any block are not a section (nothing to name them by).
 */
export function sectionOutline(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts = {},
  opts: GoToOptions = {},
): SectionEntry[] {
  const mode = opts.mode ?? sectionNavMode(def);
  const view: VisibilityOptions = { revealHidden: opts.revealHidden };
  const steps = compileFlow(def, state, quotaCounts);
  const containers = containerIndex(def);
  const trail = new Set([...visitedPages(state), ...seenPages(state)]);
  const out: SectionEntry[] = [];
  const byId = new Map<string, SectionEntry>();
  const cur = state.stepIndex;
  const backOk = mode !== "off" || def.branding?.buttons?.showBack !== false;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!isPage(s)) continue;
    const sec = sectionOf(s, containers);
    if (!sec) continue;
    const vis = visibleQuestions(def, s, state, quotaCounts, view);
    if (!vis.length) continue;
    let e = byId.get(sec.id);
    if (!e) {
      e = { id: sec.id, title: sec.title ?? sec.id, firstStepIndex: i, pageIds: [], current: false, visited: false, answered: 0, total: 0, locked: true };
      byId.set(sec.id, e); out.push(e);
    }
    e.pageIds.push(s.pageId);
    if (i === cur) e.current = true;
    if (isVisited(def, steps, i, state, quotaCounts, trail)) e.visited = true;
    for (const q of answerable(vis)) {
      e.total++;
      if (!isEmptyAnswer(lookupAnswer(state.answers, q.id, s.loop ?? null))) e.answered++;
    }
  }
  for (const e of out) {
    const i = e.firstStepIndex;
    if (e.current) e.locked = false;
    else if (i < cur) e.locked = !backOk;
    else if (mode === "off") e.locked = true;
    else if (e.visited) e.locked = false;
    else if (mode === "visited") e.locked = true;
    else e.locked = !!freeBlocker(def, steps, cur, i, state, quotaCounts);
  }
  return out;
}

/* ------------------------------------------------------------ targets */

/**
 * Where `target` lands in the compiled flow: the index of a page step, or -1.
 * A page target is a page id (`p3`, or one iteration `p3@apple`; a bare id
 * inside a loop is its first iteration), or the id / code / variable name of a
 * question on the page. A section target is a block / section id or title.
 */
export function resolveNavTarget(
  def: SurveyDefinition,
  steps: RuntimeStep[],
  target: string,
  as: "page" | "section" | "auto" = "auto",
  ok: (s: PageStep) => boolean = () => true,
): number {
  const t = String(target ?? "").trim();
  if (!t) return -1;
  const find = (pred: (s: PageStep) => boolean) => steps.findIndex((s) => isPage(s) && pred(s) && ok(s));
  if (as !== "section") {
    let i = find((s) => s.pageId === t);
    if (i < 0) i = find((s) => s.pageId.split("@")[0] === t);
    if (i < 0) {
      const lower = t.toLowerCase();
      const q = def.questions.find((x) => x.id === t || x.code?.toLowerCase() === lower || x.variableName?.toLowerCase() === lower);
      if (q) i = find((s) => s.questionIds.includes(q.id));
    }
    if (i >= 0 || as === "page") return i;
  }
  const containers = containerIndex(def);
  const lower = t.toLowerCase();
  const ids = new Set<string>();
  if (containers.has(t)) ids.add(t);
  else for (const c of containers.values()) if ((c.title ?? "").trim().toLowerCase() === lower) ids.add(c.id);
  if (!ids.size) return -1;
  return find((s) => s.nodePath.some((id) => ids.has(id)));
}

/** Does the target exist in the definition at all (so "hidden" and "not found" can be told apart)? */
function existsInDef(def: SurveyDefinition, target: string): boolean {
  const t = target.trim();
  const base = t.split("@")[0];
  if (pagesInDef(def).has(base)) return true;
  const lower = t.toLowerCase();
  if (def.questions.some((x) => x.id === t || x.code?.toLowerCase() === lower)) return true;
  for (const c of containerIndex(def).values()) if (c.id === t || (c.title ?? "").trim().toLowerCase() === lower) return true;
  return false;
}

/* ------------------------------------------------------------ the jump */

const refuse = (steps: RuntimeStep[], state: ResponseState, refusal: GoToRefusal, reason: string, extra: Partial<GoToResult> = {}): GoToResult => ({
  steps, stepIndex: state.stepIndex, done: false, triggeredSkips: [], quotaFull: [], ok: false, refusal, reason, ...extra,
});

/**
 * What stands between the current step and a FREE forward jump to `to`, if
 * anything: an end / redirect / quota check, or a page whose skip logic fires
 * with the current answers (the flow would route elsewhere).
 */
function freeBlocker(
  def: SurveyDefinition, steps: RuntimeStep[], from: number, to: number, state: ResponseState, counts: QuotaCounts,
): { refusal: GoToRefusal; reason: string; pageId?: string; questionId?: string } | null {
  for (let i = Math.max(0, from); i < to; i++) {
    const s = steps[i];
    if (s.kind === "end" || s.kind === "redirect")
      return { refusal: "blocked_by_end", reason: "The survey ends before that section with the current answers." };
    if (s.kind === "quota_check" && i > from)
      return { refusal: "blocked_by_quota", reason: "A quota check stands before that section — continue with Next." };
    if (s.kind === "page") {
      for (const q of visibleQuestions(def, s, state, counts)) {
        for (const rule of q.skipLogic ?? []) {
          if (evaluateCondition(rule.when, { def, state, loop: s.loop ?? null, quotaCounts: counts }))
            return { refusal: "skip_logic", reason: "Your answers route the survey another way — continue with Next.", pageId: s.pageId, questionId: q.id };
        }
      }
    }
  }
  return null;
}

/**
 * Press Next, on a copy, until `targetPageId` is the page shown. Succeeds only
 * when every page passed validates and the path really reaches the target.
 */
function simulateNext(
  def: SurveyDefinition, state: ResponseState, counts: QuotaCounts, targetPageId: string, view: VisibilityOptions,
): { ok: true; sim: ResponseState; nav: NavigationResult } | { ok: false; refusal: GoToRefusal; reason: string; pageId?: string; questionId?: string } {
  const sim = structuredClone(state) as ResponseState;
  let steps = compileFlow(def, sim, counts);
  for (let guard = 0; guard < 2000; guard++) {
    const cur = steps[sim.stepIndex];
    if (!isPage(cur)) return { ok: false, refusal: "not_on_path", reason: "That page is not on your path through the survey." };
    if (cur.pageId === targetPageId) return { ok: true, sim, nav: { steps, stepIndex: sim.stepIndex, done: false, triggeredSkips: [], quotaFull: [] } };
    const vis = visibleQuestions(def, cur, sim, counts);
    const errs = blockingErrors(validatePage(def, vis, { def, state: sim, loop: cur.loop ?? null, quotaCounts: counts }));
    if (errs.length) {
      return { ok: false, refusal: "incomplete", reason: `Please complete "${pageLabel(def, cur)}" first: ${errs[0].message}`, pageId: cur.pageId, questionId: errs[0].questionId };
    }
    const nav = advance(def, sim, counts, { fromPageId: cur.pageId, ...view });
    if (nav.done) return { ok: false, refusal: "blocked_by_end", reason: "The survey ends before that page with the current answers." };
    steps = nav.steps;
    const t = steps.findIndex((s) => isPage(s) && s.pageId === targetPageId);
    if (t < 0 || nav.stepIndex > t) return { ok: false, refusal: "not_on_path", reason: "Your answers route the survey past that page." };
  }
  return { ok: false, refusal: "not_on_path", reason: "That page could not be reached." };
}

function pageLabel(def: SurveyDefinition, s: PageStep): string {
  const sec = sectionOf(s, containerIndex(def));
  return sec?.title ?? s.title ?? s.pageId;
}

/**
 * Jump to a page or a section. Mutates `state` only when the jump is made;
 * a refusal leaves it untouched and says why.
 */
export function goToPage(
  def: SurveyDefinition,
  state: ResponseState,
  target: string,
  quotaCounts: QuotaCounts = {},
  view: VisibilityOptions = {},
  opts: GoToOptions = {},
): GoToResult {
  const mode = opts.mode ?? sectionNavMode(def);
  const v: VisibilityOptions = { revealHidden: opts.revealHidden ?? view.revealHidden };
  const steps = compileFlow(def, state, quotaCounts);
  const cur = state.stepIndex;
  const here = steps[cur];
  if (!isPage(here)) return refuse(steps, state, "no_current_page", "There is no page to navigate from.");
  const idx = resolveNavTarget(def, steps, target, opts.as ?? "auto", (s) => shows(def, s, state, quotaCounts, v));
  if (idx < 0) {
    return existsInDef(def, String(target ?? ""))
      ? refuse(steps, state, "hidden", "That part of the survey is not shown with your current answers.")
      : refuse(steps, state, "not_found", `There is no page or section "${String(target ?? "")}".`);
  }
  const dest = steps[idx] as PageStep;
  if (idx === cur) return { ...refuse(steps, state, "same_page", "You are already there."), ok: true, refusal: undefined, reason: undefined };

  /* BACKWARD — Back's semantics */
  if (idx < cur) {
    if (mode === "off" && def.branding?.buttons?.showBack === false)
      return refuse(steps, state, "back_disabled", "Going back is not allowed in this survey.");
    const trail = visitedPages(state);
    const at = trail.lastIndexOf(dest.pageId);
    let kept: string[];
    if (at >= 0) kept = trail.slice(0, at);
    else kept = trail.filter((p) => { const j = steps.findIndex((s) => isPage(s) && s.pageId === p); return j >= 0 && j < idx; });
    setVisitedPages(state, kept);
    markSeen(state, here.pageId);
    state.stepIndex = idx;
    return { steps, stepIndex: idx, done: false, triggeredSkips: [], quotaFull: [], ok: true, via: "back" };
  }

  /* FORWARD */
  if (mode === "off") return refuse(steps, state, "forward_locked", "Use Next to move forward.");
  const visited = isVisited(def, steps, idx, state, quotaCounts, new Set([...visitedPages(state), ...seenPages(state)]));
  if (mode === "visited" && !visited) return refuse(steps, state, "forward_locked", "You can only jump to sections you have already visited.");

  // as if Next were pressed until the target is reached — nothing skipped, nothing unvalidated
  const walk = simulateNext(def, state, quotaCounts, dest.pageId, v);
  if (walk.ok) {
    for (const k of Object.keys(state) as (keyof ResponseState)[]) if (!(k in walk.sim)) delete (state as unknown as Record<string, unknown>)[k];
    Object.assign(state, walk.sim);
    markSeen(state, here.pageId);
    return { ...walk.nav, steps: compileFlow(def, state, quotaCounts), ok: true, via: "visited" };
  }
  if (mode === "visited") return refuse(steps, state, walk.refusal, walk.reason, { pageId: walk.pageId, questionId: walk.questionId });

  // FREE: skip the pages in between, unvalidated
  const block = freeBlocker(def, steps, cur, idx, state, quotaCounts);
  if (block) return refuse(steps, state, block.refusal, block.reason, { pageId: block.pageId, questionId: block.questionId });
  const snapshot = structuredClone(state) as ResponseState;
  const leaving = here.pageId;
  runCalculations(def, state, "on_page_submit");
  let now = compileFlow(def, state, quotaCounts);
  const from = now.findIndex((s) => isPage(s) && s.pageId === leaving);
  let to = now.findIndex((s) => isPage(s) && s.pageId === dest.pageId);
  if (from < 0 || to < 0 || to <= from) { restore(state, snapshot); return refuse(steps, state, "not_on_path", "That page is no longer on your path."); }
  // the embedded data passed on the way is captured, as Next would
  for (let i = from + 1; i < to; i++) {
    const s = now[i];
    if (s.kind !== "embedded_data") continue;
    for (const f of s.fields) {
      if (f.when && !evaluateCondition(f.when, { def, state, loop: null, quotaCounts })) continue;
      applyEmbeddedFieldInFlow(def, state, f, { loop: s.loop ?? null, quotaCounts });
    }
  }
  now = compileFlow(def, state, quotaCounts);
  to = now.findIndex((s) => isPage(s) && s.pageId === dest.pageId);
  if (to < 0) { restore(state, snapshot); return refuse(steps, state, "not_on_path", "That page is no longer on your path."); }
  const nav = arriveAt(def, state, quotaCounts, to, v);
  const landed = nav.steps[nav.stepIndex];
  if (nav.done || !isPage(landed) || landed.pageId !== dest.pageId) {
    restore(state, snapshot);
    return refuse(steps, state, "not_on_path", "That page could not be reached.");
  }
  setVisitedPages(state, [...visitedPages(state).filter((p) => p !== leaving), leaving]);
  markSeen(state, leaving);
  return { ...nav, ok: true, via: "free" };
}

function restore(state: ResponseState, snapshot: ResponseState): void {
  for (const k of Object.keys(state) as (keyof ResponseState)[]) if (!(k in snapshot)) delete (state as unknown as Record<string, unknown>)[k];
  Object.assign(state, snapshot);
}

/* ------------------------------------------------------------ submit */

export interface MissingEntry {
  sectionId: string | null;
  sectionTitle: string;
  pageId: string;
  stepIndex: number;
  questionId: string;
  code?: string;
  message: string;
}

export interface SubmitGate {
  /** pressing Next on this page would end the survey */
  finishing: boolean;
  /** Submit may go ahead (an assessment with unanswered questions still asks `needsConfirm`) */
  ok: boolean;
  assessment: boolean;
  /** required questions left unanswered on the way (skipped by a free jump) */
  missing: MissingEntry[];
  /** answers given that fail their rules */
  invalid: MissingEntry[];
  /** assessment only: unanswered = unattempted; ask "N questions unanswered — submit anyway?" */
  needsConfirm: boolean;
  /** assessment only: every visible answerable question with no answer */
  unanswered: number;
  /** the missing entries grouped for the "go to" list */
  bySection: { sectionId: string | null; sectionTitle: string; firstPageId: string; count: number }[];
  message?: string;
}

/**
 * THE SUBMIT GATE (free navigation). Run when Next is pressed on a page: if
 * that Next would end the survey, the interview is replayed from the start on
 * a copy — the same walk the save route's replay makes — and every page on the
 * path is validated. Unanswered required questions refuse Submit and are
 * listed per section; an assessment treats unanswered as unattempted and only
 * asks for confirmation. Answers that fail their rules always refuse.
 */
export function submitGate(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts: QuotaCounts = {},
  view: VisibilityOptions = {},
): SubmitGate {
  const assessment = !!assessmentSettings(def);
  const base: SubmitGate = { finishing: false, ok: true, assessment, missing: [], invalid: [], needsConfirm: false, unanswered: 0, bySection: [] };
  const steps = compileFlow(def, state, quotaCounts);
  const here = steps[state.stepIndex];
  if (!isPage(here)) return base;
  const probe = structuredClone(state) as ResponseState;
  const next = advance(def, probe, quotaCounts, { fromPageId: here.pageId, ...view });
  if (!next.done) return base;
  base.finishing = true;
  if (next.endStatus && next.endStatus !== "complete") return base; // a screen-out is not a submission

  const sim = structuredClone(state) as ResponseState;
  const containers = containerIndex(def);
  let nav = start(def, sim, quotaCounts);
  for (let guard = 0; !nav.done && guard < 2000; guard++) {
    const s = nav.steps[nav.stepIndex];
    if (!isPage(s)) break;
    const vis = visibleQuestions(def, s, sim, quotaCounts);
    const sec = sectionOf(s, containers);
    const errs = blockingErrors(validatePage(def, vis, { def, state: sim, loop: s.loop ?? null, quotaCounts }));
    const seen = new Set<string>();
    for (const e of errs) {
      if (seen.has(e.questionId)) continue;
      seen.add(e.questionId);
      const q = getQuestion(def, e.questionId);
      const empty = isEmptyAnswer(lookupAnswer(sim.answers, e.questionId, s.loop ?? null));
      const entry: MissingEntry = { sectionId: sec?.id ?? null, sectionTitle: sec?.title ?? s.title ?? s.pageId, pageId: s.pageId, stepIndex: nav.stepIndex, questionId: e.questionId, ...(q?.code ? { code: q.code } : {}), message: e.message };
      (empty ? base.missing : base.invalid).push(entry);
    }
    if (assessment) for (const q of answerable(vis)) if (isEmptyAnswer(lookupAnswer(sim.answers, q.id, s.loop ?? null))) base.unanswered++;
    nav = advance(def, sim, quotaCounts, { fromPageId: s.pageId, ...view });
  }
  const groups = new Map<string, SubmitGate["bySection"][number]>();
  for (const m of base.missing) {
    const k = m.sectionId ?? `page:${m.pageId}`;
    const g = groups.get(k);
    if (g) g.count++;
    else groups.set(k, { sectionId: m.sectionId, sectionTitle: m.sectionTitle, firstPageId: m.pageId, count: 1 });
  }
  base.bySection = [...groups.values()];
  if (base.invalid.length) {
    base.ok = false;
    base.message = `${base.invalid.length} answer${base.invalid.length === 1 ? "" : "s"} need${base.invalid.length === 1 ? "s" : ""} correcting before you submit.`;
  } else if (assessment) {
    base.needsConfirm = base.unanswered > 0;
    if (base.needsConfirm) base.message = `${base.unanswered} question${base.unanswered === 1 ? "" : "s"} unanswered — submit anyway?`;
  } else if (base.missing.length) {
    base.ok = false;
    base.message = `${base.missing.length} required question${base.missing.length === 1 ? " is" : "s are"} unanswered.`;
  }
  return base;
}

/* ------------------------------------------------------------ the trail in the response row (0077) */

/**
 * THE TRAIL AS STORED (migration 0077, `responses.nav`): the Back trail
 * (`stack`, oldest first), every page seen (`visited`) and the page the
 * respondent is on (`at`). Paradata — never an answer, never exported, never
 * trusted to MOVE anyone: resume still positions by the saved step and the
 * save route's replay still decides what is valid. It only restores what Back
 * and the navigator know, so a second device behaves like the first.
 */
export interface NavTrail { v: 1; stack: string[]; visited: string[]; at?: string }
export const NAV_TRAIL_MAX_IDS = 2000;
export const NAV_TRAIL_MAX_ID_LENGTH = 128;

/** The trail as the save posts it, from the state (null when there is nothing to keep). */
export function navTrailOf(state: ResponseState, currentPageId?: string | null): NavTrail | null {
  const stack = visitedPages(state);
  const visited = seenPages(state);
  if (!stack.length && !visited.length && !currentPageId) return null;
  return { v: 1, stack: stack.slice(-NAV_TRAIL_MAX_IDS), visited: visited.slice(-NAV_TRAIL_MAX_IDS), ...(currentPageId ? { at: currentPageId } : {}) };
}

/**
 * A posted (or stored) trail, checked against THIS definition: the shape, the
 * bounds, and every id a page of this survey (`p3`, or a loop iteration
 * `p3@apple` whose page is `p3`). Unknown ids — a tampered payload, a page the
 * new version deleted — are dropped and counted, never stored, never refused
 * (a stale trail must not cost a respondent their save).
 */
export function sanitizeNavTrail(def: SurveyDefinition, raw: unknown): { trail: NavTrail | null; dropped: number; invalid?: string } {
  if (raw === null || raw === undefined) return { trail: null, dropped: 0 };
  if (typeof raw !== "object" || Array.isArray(raw)) return { trail: null, dropped: 0, invalid: "nav must be an object" };
  const o = raw as Record<string, unknown>;
  if (o.v !== undefined && o.v !== 1) return { trail: null, dropped: 0, invalid: `nav version ${String(o.v)} is not 1` };
  const pages = new Set(pagesInDef(def).keys());
  let dropped = 0;
  const ok = (x: unknown): x is string =>
    typeof x === "string" && x.length > 0 && x.length <= NAV_TRAIL_MAX_ID_LENGTH && pages.has(x.split("@")[0]);
  const list = (v: unknown, dedupe: "all" | "consecutive"): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { dropped++; return []; }
    const out: string[] = [];
    for (const x of v.slice(-NAV_TRAIL_MAX_IDS * 2)) {
      if (!ok(x)) { dropped++; continue; }
      if (dedupe === "all" ? out.includes(x) : out[out.length - 1] === x) continue;
      out.push(x);
    }
    return out.slice(-NAV_TRAIL_MAX_IDS);
  };
  const stack = list(o.stack, "consecutive");
  const visited = list(o.visited, "all");
  let at: string | undefined;
  if (o.at !== undefined) { if (ok(o.at)) at = o.at; else dropped++; }
  if (!stack.length && !visited.length && !at) return { trail: null, dropped };
  return { trail: { v: 1, stack, visited, ...(at ? { at } : {}) }, dropped };
}

/** Put a trail back into the state (after `resumeAt`): Back and the navigator read it from there. */
export function restoreNavTrail(state: ResponseState, trail: Pick<NavTrail, "stack" | "visited"> | null): void {
  if (!trail) return;
  setVisitedPages(state, trail.stack);
  for (const p of trail.visited) markSeen(state, p);
}

/**
 * WHICH TRAIL A RESUME USES — the server's (the response row, any device) or
 * this browser's copy. Both are checked against the definition first (stale
 * ids dropped). The server's wins when the browser has none (another device)
 * or when it was saved at or after the browser copy; a browser copy written
 * later — a save that never reached the server — wins, the same rule the
 * pending answers follow. `savedAt` is the row's last save (ISO), `at` the
 * browser copy's time (ms).
 */
export function chooseNavTrail(
  def: SurveyDefinition,
  server: { nav: unknown; savedAt?: string | null } | null | undefined,
  browser: { visited: unknown; seen: unknown; at?: number } | null | undefined,
): { source: "server" | "browser" | null; trail: NavTrail | null; dropped: number } {
  const s = server ? sanitizeNavTrail(def, server.nav) : { trail: null, dropped: 0 };
  const b = browser ? sanitizeNavTrail(def, { v: 1, stack: browser.visited, visited: browser.seen }) : { trail: null, dropped: 0 };
  const dropped = s.dropped + b.dropped;
  if (s.trail && !b.trail) return { source: "server", trail: s.trail, dropped };
  if (!s.trail && b.trail) return { source: "browser", trail: b.trail, dropped };
  if (!s.trail || !b.trail) return { source: null, trail: null, dropped };
  const serverMs = server?.savedAt ? Date.parse(server.savedAt) : NaN;
  const browserMs = typeof browser?.at === "number" ? browser.at : NaN;
  const serverNewer = !Number.isFinite(browserMs) || (Number.isFinite(serverMs) && serverMs >= browserMs);
  return serverNewer ? { source: "server", trail: s.trail, dropped } : { source: "browser", trail: b.trail, dropped };
}
