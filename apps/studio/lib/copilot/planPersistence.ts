/**
 * THE PLAN, KEPT (Persistent Plan-First Execution Engine §1 and §6) — Owner: R2.
 *
 * `loadOrCreatePlan` is the route's first act on a non-trivial turn: an open
 * task for this survey whose request the new instruction CONTINUES loads its
 * persisted plan; anything else mints a new task.
 *
 * ---------------------------------------------------------------- not a new classifier
 *
 * "Non-trivial" is NOT a new classifier and nothing here reads the request a
 * second time with rules of its own. It is the work that already exists:
 *
 *   `interpretRequest` (packages/engine/src/nlIntent.ts)  an edit the ENGINE
 *        resolves — "Remove Q2", "Add a page break after Q1", a refusal, a
 *        question answered from the survey graph, a greeting — returns
 *        anything but `kind: "model"`. Such a turn is answered without a
 *        model and MUST NOT grow a task row.
 *   `requestScope` / `isLongBrief` (packages/engine/src/requestScope.ts)
 *        a pasted brief is large by construction.
 *   `classifyRequest` (lib/copilot/prompt.ts), already computed by the route
 *        as `mode`: a generation is large by construction — that is what the
 *        plan-first path exists for.
 *   the plan itself: a ChangePlan with two or more items is large.
 *
 * ---------------------------------------------------------------- reconciliation rules
 *
 * These three rules are the whole of §6, and `reconcilePlan` implements them:
 *
 *   1. A step that is COMPLETED AND VALIDATED (`validation.status === "valid"`)
 *      and whose plan item did not change is REUSED: its row, its output and
 *      its usage are carried into plan version n+1 untouched. A completed step
 *      that was never validated, or that failed validation, is not reused —
 *      "completed" alone is not evidence that the work is good.
 *   2. A step whose INPUTS CHANGED is invalidated and re-run. Its inputs are
 *      its own plan item (compared by `itemFingerprint`) and every step it
 *      depends on. A step whose own item changed becomes `pending` — it is the
 *      new work, immediately runnable. A step that only inherited the change
 *      from a dependency becomes `blocked`, exactly as `StepStatus` defines it
 *      ("a step whose inputs a re-plan invalidated"); it becomes runnable when
 *      its dependencies complete (`dependenciesMet`).
 *   3. A step the new instruction DELETES is TOMBSTONED, never dropped
 *      silently: the row stays, it is never run, and `describeReconciliation`
 *      says it was dropped. Losing it quietly would let a reply imply work
 *      that no longer exists.
 *
 * The result is persisted with `store.revise(taskId, planVersion, steps,
 * tombstoned)`: `steps` is the LIVE set for version n+1 (reused + blocked +
 * pending + new), `tombstoned` the ids whose rows are to be marked
 * `tombstoned` rather than deleted.
 *
 * ---------------------------------------------------------------- dependency edges
 *
 * Dependency edges come from `ChangePlanItem.objects` and nothing else: two
 * items that name the same object are dependent, IN PLAN ORDER — the later
 * item depends on the earlier one. `planDependencies` is pure and separately
 * tested; `dependentsOf` is its transitive downstream closure.
 *
 * ---------------------------------------------------------------- flag discipline
 *
 * Writing is UNCONDITIONAL (dual-write): every non-trivial turn creates or
 * revises its task rows, so the table is populated before anything reads it.
 * READING the persisted plan back sits behind `COPILOT_PLAN_RESUME`, which
 * DEFAULTS OFF and is read from the environment on every call — so it can be
 * turned on, and turned off again in production, without a deploy. With the
 * flag off every turn is `fresh`, exactly as before this feature existed.
 *
 * ---------------------------------------------------------------- what is NOT here
 *
 * No table name, no Supabase client, no claim: the store is INJECTED
 * (`TaskStore`, lib/copilot/taskStore.ts, owner R1) so this module is pure
 * policy and is tested without a database. Nothing here calls `taskStoreFor`.
 *
 * `ExecStep.inputRef` carries this module's own envelope — the plan item's
 * objects and fingerprint as compact JSON (`encodeItemRef` / `decodeItemRef`)
 * — because `ExecStep` has no field for either and `packages/engine` is not
 * ours to change. A step whose `inputRef` is not one of our envelopes is read
 * as "no objects, unknown fingerprint" and is therefore never silently
 * reused.
 */
import type { SurveyDefinition } from "@rescript/schema";
import { taskResumeEnabled } from "./resume.ts";
import { contentWords, interpretRequest, isLongBrief, scopeCategories } from "@rescript/engine";
import type { DeliverableSpec, ExecStep, ExecTask, TaskKind } from "@rescript/engine";
import type { ChangePlan, ChangePlanItem } from "./changePlan.ts";
import type { TaskStore } from "./taskStore.ts";

/* ------------------------------------------------------------- the flag */

/** the one environment variable this module reads */
export const PLAN_RESUME_ENV = "COPILOT_PLAN_RESUME";

/**
 * `COPILOT_PLAN_RESUME=on` turns READING a persisted plan back on. DEFAULT
 * OFF: anything else — unset, empty, "off", "0", "false", "no" — means every
 * turn mints a fresh task and no persisted plan is ever loaded. Writing is
 * not affected. Read per call, never cached, so the operator can turn it off
 * in production without a deploy.
 */
/*
 * ONE SWITCH, NOT TWO (consolidation, 2026-10-24). Reading a persisted plan
 * back while ignoring what its steps already built is the worst of both, so
 * the plan read and the step read move together: this delegates to
 * `taskResumeEnabled`, which honours COPILOT_TASK_RESUME first and
 * COPILOT_PLAN_RESUME as the older name. Both still default OFF.
 */
export function planResumeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return taskResumeEnabled(env);
}

/* ------------------------------------------------- the step <-> item envelope */

/** this module's envelope in `ExecStep.inputRef`: the item's objects and its fingerprint */
interface ItemRef { v: 1; objects: string[]; fp: string }

const norm = (s: string): string => String(s ?? "").normalize("NFC").trim().replace(/\s+/g, " ").replace(/^["'“”‘’]+|["'“”‘’.,;:]+$/g, "").toLowerCase();

/** the objects of an item, normalised and de-duplicated — the only thing an edge is drawn from */
export function itemObjects(item: Pick<ChangePlanItem, "objects">): string[] {
  const out: string[] = [];
  for (const o of item.objects ?? []) { const n = norm(o); if (n && !out.includes(n)) out.push(n); }
  return out;
}

/**
 * WHAT MAKES AN ITEM THE SAME ITEM. Everything the model is asked to build
 * from — title, kind, objects, reason, detail — and nothing else (not the
 * item's position, so moving an item does not reprice it). A change to any of
 * these is a changed input, and the step is re-run.
 */
export function itemFingerprint(item: ChangePlanItem): string {
  const parts = [norm(item.title), String(item.kind ?? ""), itemObjects(item).join("|"), norm(item.reason ?? ""), norm(item.detail ?? "")];
  let h = 2166136261;
  const s = parts.join("\u0001");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}.${s.length.toString(36)}`;
}

export function encodeItemRef(item: ChangePlanItem): string {
  return JSON.stringify({ v: 1, objects: itemObjects(item), fp: itemFingerprint(item) } satisfies ItemRef);
}

/** the envelope back, or nothing when the step was written by something else */
export function decodeItemRef(step: Pick<ExecStep, "inputRef">): { objects: string[]; fp: string | null } {
  const raw = step.inputRef;
  if (typeof raw !== "string" || !raw.startsWith("{")) return { objects: [], fp: null };
  try {
    const o = JSON.parse(raw) as Partial<ItemRef>;
    if (!o || o.v !== 1) return { objects: [], fp: null };
    return { objects: Array.isArray(o.objects) ? o.objects.map((x) => norm(String(x))).filter(Boolean) : [], fp: typeof o.fp === "string" ? o.fp : null };
  } catch { return { objects: [], fp: null }; }
}

/* --------------------------------------------------------- the dependency edges */

/**
 * THE EDGE RULE, pure and separately tested: item B depends on item A when A
 * comes BEFORE B in plan order and they name at least one object in common
 * (case- and whitespace-insensitive). Nothing else draws an edge — not the
 * kind, not the wording, not the reason. The result maps each item id to the
 * ids it depends on, in plan order; the first item never depends on anything.
 */
export function planDependencies(items: readonly ChangePlanItem[]): Map<string, string[]> {
  const objects = items.map((it) => new Set(itemObjects(it)));
  const edges = new Map<string, string[]>();
  items.forEach((item, i) => {
    const mine = objects[i]!;
    const on: string[] = [];
    for (let j = 0; j < i; j++) {
      const theirs = objects[j]!;
      for (const o of mine) if (theirs.has(o)) { on.push(items[j]!.id); break; }
    }
    edges.set(item.id, on);
  });
  return edges;
}

/**
 * Everything DOWNSTREAM of `seeds`, transitively, in plan order — the steps
 * whose inputs a change to `seeds` invalidates. The seeds themselves are not
 * in the result: the caller knows what it changed.
 */
export function dependentsOf(items: readonly ChangePlanItem[], seeds: Iterable<string>): string[] {
  const edges = planDependencies(items);
  const hit = new Set(seeds);
  const out: string[] = [];
  for (const item of items) {
    if (hit.has(item.id)) continue;
    if ((edges.get(item.id) ?? []).some((d) => hit.has(d))) { hit.add(item.id); out.push(item.id); }
  }
  return out;
}

/* ----------------------------------------------------- is this turn a task at all */

export type TaskDecision =
  /** no row: the engine answered it, or it is one small turn */
  | { task: false; why: "engine_resolved" | "small" }
  /** a row: the work is large enough to outlive the request */
  | { task: true; why: "plan" | "long_brief" | "generation"; kind: TaskKind };

/** a ChangePlan with this many items is large enough to be worth a row of its own */
export const LARGE_PLAN_ITEMS = 2;

export interface TaskDecisionInput {
  request: string;
  /** the plan this turn's plan stage produced, when it ran */
  plan?: ChangePlan | null;
  /** the route's `mode` (lib/copilot/prompt.ts `classifyRequest`) — "generate" is large by construction */
  mode?: string | null;
  /** the open survey, so `interpretRequest` can say whether the engine already resolved this */
  definition?: SurveyDefinition | null;
  selectedId?: string | null;
}

/**
 * Does this turn get a task row? Read in this order, and never re-read the
 * request with rules of this module's own:
 *
 *   1. the ENGINE already resolved it (`interpretRequest(...).kind !== "model"`)
 *      — an edit, an answer, a refusal, a clarification: no model call, no
 *      row. This is the gate the brief calls "an engine-resolved edit stays a
 *      single turn and must not grow a task row".
 *   2. a plan with `LARGE_PLAN_ITEMS` or more items → a row.
 *   3. a pasted brief (`isLongBrief`) → a row, with or without a plan.
 *   4. the route's own mode is "generate" → a row. THIS IS WHAT KEEPS THE
 *      PLAN FIRST TOGGLE HONEST: Plan First off means a single-turn REPLY,
 *      not a lost task. It never appears in this function.
 *   5. anything else → no row.
 */
export function taskDecision(input: TaskDecisionInput): TaskDecision {
  const request = String(input.request ?? "");
  if (input.definition) {
    try {
      const interp = interpretRequest(input.definition, request, input.selectedId ? { selectedId: input.selectedId } : {});
      if (interp.kind !== "model") return { task: false, why: "engine_resolved" };
    } catch { /* the interpreter threw: fall through and decide on size alone — never a reason to lose the work */ }
  }
  const items = input.plan?.items?.length ?? 0;
  const kind = taskKindFor(request, input.plan ?? null);
  if (items >= LARGE_PLAN_ITEMS) return { task: true, why: "plan", kind };
  if (isLongBrief(request)) return { task: true, why: "long_brief", kind };
  if (input.mode === "generate") return { task: true, why: "generation", kind };
  return { task: false, why: "small" };
}

/** the task kind, from the engine's own scope categories — never a new classifier */
export function taskKindFor(request: string, plan: ChangePlan | null = null): TaskKind {
  const text = `${request}\n${plan?.summary ?? ""}\n${(plan?.items ?? []).map((i) => `${i.title} ${i.reason}`).join("\n")}`;
  const cats = new Set(scopeCategories(text));
  if (/\bmax[-\s]?diff|best[-\s]?worst\b/i.test(text)) return "maxdiff";
  if (/\bconjoint|cbc|acbc|discrete choice\b/i.test(text)) return "conjoint";
  if (cats.has("translation") && /\btranslat\w*|locali[sz]\w*|multilingual\b|अनुवाद/i.test(text)) return "translation";
  if (cats.has("analysis") && !cats.has("survey")) return "analysis";
  if (cats.has("survey") || cats.has("research_planning") || cats.has("hypotheses")) return "survey_build";
  return "other";
}

/** what "done" means for this task, asserting only what the request actually promised */
export function deliverableFor(request: string, kind: TaskKind, plan: ChangePlan | null = null): DeliverableSpec {
  const spec: DeliverableSpec = { kind };
  const count = /(\d{1,3})\s*(?:-|\s)?(?:question|सवाल|प्रश्न)/i.exec(request);
  if (count && Number(count[1]) > 0 && Number(count[1]) <= 500) spec.questionCount = Number(count[1]);
  if (kind === "translation") {
    const lang = /\b(?:into|in|to)\s+([A-Z][a-z]{2,14})\b/.exec(request);
    if (lang) spec.language = lang[1]!;
  }
  if (plan?.items.length) spec.invariants = ["every approved plan item built"];
  return spec;
}

/* ------------------------------------------------------- does it continue? */

/** a task older than this is never continued by a new instruction, whatever it says */
export const CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;
/** the share of content words a new instruction must share with the task's request to be a continuation */
export const CONTINUATION_OVERLAP = 0.4;
/** a targeted edit to work in flight is short; a new brief is not */
export const CONTINUATION_EDIT_CHARS = 240;

/** "continue", "resume", "go on", "build the rest", "yes please", and the same in Hinglish / Devanagari */
/* `\w` is ASCII-only in JavaScript, so the Devanagari endings are spelled out as a Devanagari range */
const CONTINUATION_PHRASE = /^(?:ok(?:ay)?[,\s]*)?(?:yes[,\s]*)?(?:please\s+)?(?:go (?:on|ahead)|carry on|continue|resume|keep going|finish (?:it|the rest)?|build (?:the )?rest|do the rest|next|aage badh\w*|jari rakh\w*|continue karo|aage karo|जारी रख[\u0900-\u097F]*|आगे बढ़?[\u0900-\u097F]*|बाकी बना[\u0900-\u097F]*)[\s!.।]*$/i;

/** words too generic to count as shared subject matter, on top of the engine's own stop list */
const GENERIC = new Set(["survey", "surveys", "questionnair", "questionnaire", "question", "questions", "studi", "study", "project", "respond", "respondent", "respondents", "add", "ad", "make", "creat", "create", "build", "chang", "change", "updat", "update", "pleas", "please", "need", "want", "new", "plan", "plans", "item", "items", "block", "blocks", "page", "pages", "section", "sections", "design", "logic", "analysis", "report", "data"]);

const subject = (s: string): Set<string> => new Set(contentWords(s).filter((w) => w.length >= 3 && !GENERIC.has(w)));

/**
 * What it takes for an instruction to NAME an object of the open task. A
 * one-word object ("Q5", "NPS", "Screener") must appear as a whole word; a
 * multi-word object ("Analysis plan", "Purchase intent block") must appear
 * whole, as a phrase — otherwise "…banner plan for the pricing deck" would
 * count as naming "Analysis plan", which is how the wrong plan gets loaded.
 * Generic platform nouns never match on their own.
 */
function namesAnObject(objects: readonly string[], request: string): boolean {
  const hay = ` ${request.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  for (const o of objects) {
    const words = o.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!words.length) continue;
    if (words.length === 1) {
      const w = words[0]!;
      if (w.length < 2 || /^\d+$/.test(w) || GENERIC.has(w) || GENERIC.has(w.replace(/e?s$/, ""))) continue;
      if (hay.includes(` ${w} `)) return true;
      continue;
    }
    if (hay.includes(` ${words.join(" ")} `)) return true;
  }
  return false;
}

export interface ContinuationVerdict { continues: boolean; why: "phrase" | "overlap" | "named_object" | "not_open" | "expired" | "other_survey" | "unrelated"; overlap: number }

/**
 * DOES THIS INSTRUCTION CONTINUE THAT TASK? Conservative on purpose: loading
 * the wrong plan would reuse work the researcher never asked for, which is
 * worse than planning a second task. All of:
 *
 *   - the task is for THIS survey and is still open (`pending` or `running`), and
 *   - it was touched within `CONTINUATION_TTL_MS`, and
 *   - one of:
 *       (a) the instruction is a bare continuation phrase ("continue",
 *           "build the rest", "आगे बढ़ाओ"), or
 *       (b) its subject words overlap the task's request by at least
 *           `CONTINUATION_OVERLAP` (Jaccard, the engine's own `contentWords`
 *           with the platform's generic nouns removed), or
 *       (c) it is short (<= `CONTINUATION_EDIT_CHARS`) AND names, as a whole
 *           word, an object of one of the task's steps — a targeted edit to
 *           work in flight.
 *
 * Anything else is a new request: a new task, and the old plan is not read.
 */
export function continuesTask(task: Pick<ExecTask, "surveyId" | "status" | "request" | "steps" | "createdAt" | "updatedAt">, surveyId: string, request: string, now: number = Date.now()): ContinuationVerdict {
  const text = String(request ?? "").trim();
  if (task.surveyId !== surveyId) return { continues: false, why: "other_survey", overlap: 0 };
  if (task.status !== "pending" && task.status !== "running") return { continues: false, why: "not_open", overlap: 0 };
  const touched = task.updatedAt ?? task.createdAt ?? now;
  if (now - touched > CONTINUATION_TTL_MS) return { continues: false, why: "expired", overlap: 0 };

  const a = subject(task.request ?? "");
  const b = subject(text);
  let shared = 0;
  for (const w of b) if (a.has(w)) shared++;
  const union = new Set([...a, ...b]).size;
  const overlap = union ? shared / union : 0;

  if (CONTINUATION_PHRASE.test(text)) return { continues: true, why: "phrase", overlap };
  if (a.size && b.size && overlap >= CONTINUATION_OVERLAP) return { continues: true, why: "overlap", overlap };
  if (text.length <= CONTINUATION_EDIT_CHARS && namesAnObject(task.steps.flatMap((s) => decodeItemRef(s).objects), text)) {
    return { continues: true, why: "named_object", overlap };
  }
  return { continues: false, why: "unrelated", overlap };
}

/* ------------------------------------------------------------ reconciliation */

export type StepSeed = Omit<ExecStep, "taskId" | "retryCount">;

export interface Reconciliation {
  planVersion: number;
  /** the LIVE step set for the new version: reused + blocked + pending + new, in plan order */
  steps: StepSeed[];
  /** completed AND validated, carried over untouched */
  reused: string[];
  /** invalidated: the items this instruction changed, plus everything downstream of them */
  redone: string[];
  /** unchanged by this instruction and still to do: never run, failed, or completed without a valid check */
  outstanding: string[];
  /** in the task, gone from the plan: kept as a record, never run */
  tombstoned: string[];
  /** in the plan, not in the task */
  added: string[];
  /** nothing to write: no step changed status, none added, none dropped */
  unchanged: boolean;
}

const idemOf = (surveyId: string, itemId: string, fp: string): string => `${surveyId}:${itemId}:${fp}`;

/** a step is reusable only when it COMPLETED and a deterministic check said the output is good */
export function isReusable(step: Pick<ExecStep, "status" | "validation">): boolean {
  return step.status === "completed" && step.validation?.status === "valid";
}

/**
 * The three rules of §6 applied to one task and one new plan. Pure: it reads
 * the task and the plan, decides, and hands the caller exactly what
 * `store.revise` wants. It never writes.
 */
export function reconcilePlan(task: ExecTask, next: ChangePlan): Reconciliation {
  const planVersion = (task.planVersion ?? 1) + 1;
  const byId = new Map(task.steps.map((s) => [s.stepId, s]));
  const edges = planDependencies(next.items);
  const nextIds = new Set(next.items.map((i) => i.id));

  /*
   * Rule 2, first half: the items whose OWN inputs changed. An item the task
   * has never seen is ADDED, not "changed" — nothing about it is being built
   * AGAIN, and the reply must not say so. Both seed the downstream closure.
   */
  const changed = new Set<string>();
  const addedSet = new Set<string>();
  const added: string[] = [];
  for (const item of next.items) {
    const prev = byId.get(item.id);
    if (!prev) { added.push(item.id); addedSet.add(item.id); continue; }
    if (decodeItemRef(prev).fp !== itemFingerprint(item)) changed.add(item.id);
  }
  /* rule 2, second half: everything downstream of a change or an addition, transitively */
  const inherited = new Set(dependentsOf(next.items, [...changed, ...addedSet]));

  const reused: string[] = [];
  const redone: string[] = [];
  const outstanding: string[] = [];
  const steps: StepSeed[] = next.items.map((item) => {
    const prev = byId.get(item.id);
    const fp = itemFingerprint(item);
    const dependsOn = edges.get(item.id) ?? [];
    const base: StepSeed = {
      stepId: item.id,
      planVersion,
      dependsOn,
      status: "pending",
      title: item.title,
      inputRef: encodeItemRef(item),
      idempotencyKey: idemOf(task.surveyId, item.id, fp),
      ...(prev?.batchSize !== undefined ? { batchSize: prev.batchSize } : {}),
    };
    if (addedSet.has(item.id)) return base; /* new work, not work done again */
    if (changed.has(item.id)) { redone.push(item.id); return base; }
    if (inherited.has(item.id)) {
      /* the item itself did not change; its inputs did. Keep what it cost and what it said, mark it blocked. */
      redone.push(item.id);
      return { ...base, status: "blocked", ...(prev?.output !== undefined ? { output: prev.output } : {}), ...(prev?.usage ? { usage: prev.usage } : {}) };
    }
    /*
     * Rule 1, the other half: the item did not change and nothing it depends
     * on moved, but the step is not completed-and-validated — it never ran,
     * it failed, or its output did not check out. There is nothing to reuse
     * and nothing to claim: it is simply still to do, and it is NOT reported
     * as redone (this instruction changed nothing about it).
     */
    if (!prev || !isReusable(prev)) { outstanding.push(item.id); return base; }
    /* rule 1: completed and validated, and nothing it depends on moved — reused as it stands */
    reused.push(item.id);
    return {
      ...base,
      status: "completed",
      idempotencyKey: prev.idempotencyKey,
      ...(prev.output !== undefined ? { output: prev.output } : {}),
      ...(prev.validation ? { validation: prev.validation } : {}),
      ...(prev.usage ? { usage: prev.usage } : {}),
      ...(prev.batchSizeUsed !== undefined ? { batchSizeUsed: prev.batchSizeUsed } : {}),
      ...(prev.startedAt !== undefined ? { startedAt: prev.startedAt } : {}),
      ...(prev.finishedAt !== undefined ? { finishedAt: prev.finishedAt } : {}),
    };
  });

  /* rule 3: in the task, gone from the plan — kept, never run, and said out loud */
  const tombstoned = task.steps.filter((s) => !nextIds.has(s.stepId) && s.status !== "tombstoned").map((s) => s.stepId);

  /* nothing to write: no item's inputs moved, none was added, none was dropped */
  const unchanged = !redone.length && !tombstoned.length && !added.length;
  return { planVersion, steps, reused, redone, outstanding, tombstoned, added, unchanged };
}

/* -------------------------------------------------------- load or create */

/** what the route needs back: the task, the plan to run, and what to tell the researcher */
export interface LoadedPlan {
  task: ExecTask;
  plan: ChangePlan;
  /** true when this turn minted the task rather than continuing one */
  fresh: boolean;
  /** step ids whose completed output is being reused */
  reused: string[];
  /** step ids this instruction invalidated and will re-run */
  redone: string[];
  /** step ids this instruction deleted */
  tombstoned: string[];
  /** step ids this instruction added */
  added: string[];
  /** the version the steps now carry */
  planVersion: number;
  /** whether `COPILOT_PLAN_RESUME` let this turn look for an open task at all */
  resumeRead: boolean;
  /** why a task exists for this turn */
  why: "plan" | "long_brief" | "generation";
}

export interface LoadOrCreateInput extends TaskDecisionInput {
  surveyId: string;
  memory?: string;
  customerId?: string;
  createdBy?: string;
  /**
   * The Plan First toggle, accepted so the route can pass its body through
   * unchanged — and DELIBERATELY UNUSED. Off means a single-turn reply for a
   * simple request; it has never meant "lose a large task".
   */
  planFirst?: boolean;
  env?: Record<string, string | undefined>;
  now?: number;
}

/** a ChangePlan read back out of a task's steps, for a resume that brought no new plan */
export function planFromTask(task: ExecTask): ChangePlan {
  const items: ChangePlanItem[] = task.steps.filter((s) => s.status !== "tombstoned").map((s) => ({
    id: s.stepId,
    title: s.title ?? s.stepId,
    kind: "other" as const,
    objects: decodeItemRef(s).objects,
    reason: "",
  }));
  return { summary: `${items.length} step${items.length === 1 ? "" : "s"} from the open task`, items, questions: [], assumptions: [] };
}

const seedsFromPlan = (surveyId: string, plan: ChangePlan, planVersion: number): StepSeed[] => {
  const edges = planDependencies(plan.items);
  return plan.items.map((item) => ({
    stepId: item.id,
    planVersion,
    dependsOn: edges.get(item.id) ?? [],
    status: "pending" as const,
    title: item.title,
    inputRef: encodeItemRef(item),
    idempotencyKey: idemOf(surveyId, item.id, itemFingerprint(item)),
  }));
};

/** the one step a large turn with no plan yet gets, so the work has a row before the plan exists */
const seedWithoutPlan = (surveyId: string, request: string): StepSeed[] => {
  const item: ChangePlanItem = { id: "p1", title: request.trim().slice(0, 160) || "Build the request", kind: "other", objects: [], reason: "the whole request, not yet planned into items" };
  return seedsFromPlan(surveyId, { summary: item.title, items: [item], questions: [], assumptions: [] }, 1);
};

/**
 * THE ROUTE'S FIRST ACT ON A NON-TRIVIAL TURN.
 *
 * Returns `null` when this turn gets no task at all — an engine-resolved
 * edit, or one small request. Otherwise: with `COPILOT_PLAN_RESUME` on, an
 * open task for this survey that the instruction continues is loaded and
 * reconciled against the new plan; anything else mints a new task. Writing is
 * unconditional either way.
 *
 * The store is injected. This function never calls `taskStoreFor`.
 */
export async function loadOrCreatePlan(input: LoadOrCreateInput, store: TaskStore): Promise<LoadedPlan | null> {
  const decision = taskDecision(input);
  if (!decision.task) return null;
  const now = input.now ?? Date.now();
  const resumeRead = planResumeEnabled(input.env ?? process.env);
  const request = String(input.request ?? "");

  if (resumeRead) {
    const open = await store.openFor(input.surveyId).catch(() => null);
    if (open && continuesTask(open, input.surveyId, request, now).continues) {
      if (input.plan?.items.length) {
        const r = reconcilePlan(open, input.plan);
        const task = r.unchanged ? open : await store.revise(open.id, r.planVersion, r.steps, r.tombstoned);
        return { task, plan: input.plan, fresh: false, reused: r.reused, redone: r.redone, tombstoned: r.tombstoned, added: r.added, planVersion: task.planVersion, resumeRead, why: decision.why };
      }
      /* a resume with no new plan: nothing is invalidated, nothing is dropped — the open steps simply carry on */
      return {
        task: open, plan: planFromTask(open), fresh: false,
        reused: open.steps.filter(isReusable).map((s) => s.stepId),
        redone: [], tombstoned: open.steps.filter((s) => s.status === "tombstoned").map((s) => s.stepId), added: [],
        planVersion: open.planVersion, resumeRead, why: decision.why,
      };
    }
  }

  const plan = input.plan?.items.length ? input.plan : null;
  const steps = plan ? seedsFromPlan(input.surveyId, plan, 1) : seedWithoutPlan(input.surveyId, request);
  const task = await store.create({
    surveyId: input.surveyId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    kind: decision.kind,
    request,
    deliverable: deliverableFor(request, decision.kind, plan),
    steps,
  });
  return {
    task, plan: plan ?? planFromTask(task), fresh: true,
    reused: [], redone: [], tombstoned: [], added: steps.map((s) => s.stepId),
    planVersion: task.planVersion, resumeRead, why: decision.why,
  };
}

/* --------------------------------------------------------- what the reply says */

const list = (ids: readonly string[], max = 6): string => (ids.length <= max ? ids.join(", ") : `${ids.slice(0, max).join(", ")} and ${ids.length - max} more`);
const n = (c: number, one: string, many: string): string => `${c} ${c === 1 ? one : many}`;

/**
 * THE SENTENCE THE REPLY USES, in the honest-reply style of
 * lib/copilot/prompt.ts `honestReply`: it says what is being REUSED and what
 * is being REDONE, it names what was dropped, and it NEVER claims a change
 * that did not happen. Every clause is generated from a non-empty array, so
 * there is no wording for work that does not exist.
 */
export function describeReconciliation(r: Pick<LoadedPlan, "reused" | "redone" | "tombstoned"> & Partial<Pick<LoadedPlan, "fresh" | "added">>): string {
  const reused = r.reused ?? [], redone = r.redone ?? [], tombstoned = r.tombstoned ?? [], added = r.added ?? [];
  if (r.fresh) {
    const head = added.length ? `A new task with ${n(added.length, "step", "steps")}.` : "A new task.";
    return `${head} Nothing from an earlier plan was reused — this is the first version of this plan.`;
  }
  const parts: string[] = [];
  parts.push(reused.length
    ? `${n(reused.length, "completed step is", "completed steps are")} reused as ${reused.length === 1 ? "it stands" : "they stand"} (${list(reused)}) — ${reused.length === 1 ? "it is" : "they are"} not being built again.`
    : "No completed step could be reused.");
  if (redone.length) parts.push(`${n(redone.length, "step is", "steps are")} being built again because this instruction changed ${redone.length === 1 ? "its inputs" : "their inputs"} (${list(redone)}).`);
  else parts.push("Nothing is being built again.");
  if (added.length) parts.push(`${n(added.length, "step is", "steps are")} new (${list(added)}).`);
  if (tombstoned.length) parts.push(`${n(tombstoned.length, "step is", "steps are")} no longer in the plan and will not be built (${list(tombstoned)}); ${tombstoned.length === 1 ? "it is" : "they are"} kept on the task as a record, not deleted.`);
  return parts.join(" ");
}
