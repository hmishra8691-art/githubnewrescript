/**
 * GENERATION AS A DURABLE TASK (ported from K2 onto the base engine, 2026-10-29 — docs/EXECUTION-ENGINE-2026-10-29.md).
 *
 * Planners and step handlers for:
 *   - a new survey of 30–1000 questions ("planner: generation")
 *   - a large edit of an existing survey ("add explanations to every question", "rewrite all options", "add display
 *     logic to Q20–Q80") — per-range batches
 *   - a MaxDiff / conjoint study ("design a CBC study for …") — validated by design criteria, not question counts
 *   - the content batches of an exam paper, for K4's assessment planner (`buildGenerationSteps`)
 *
 * The pure logic (request reading, outline, skeleton, batch sizing, action normalisation, batch and deliverable
 * validation) lives in @rescript/engine (generationPlan.ts, deliverableValidation.ts); this file is the glue:
 * prompts, model calls through `ctx.ai`, and the mapping of each outcome onto the task engine's StepResult.
 *
 * Handlers are pure with respect to persistence: they read `ctx.draft` (the survey with every completed step
 * replayed), call `ctx.ai` at most once, validate deterministically with the engine's own gate, and return
 * actions. Codes, variables, blocks and order are decided by the skeleton before any model call, so a batch that is
 * retried, split or repaired writes the same ids.
 */
import type { SurveyDefinition } from "@rescript/schema";
import {
  readGenerationRequest, normalizeOutline, fallbackOutline, buildSkeleton, planBatches, splitSlots, planEditBatches, generationPolicyFrom,
  normalizeBatchActions, checkBatch, questionDigest, orderMoves, slotPlacement, validateSurveyDeliverable, parseCompletionCriteria, compactCodes, isRespondentQuestion,
  coerceSurveyActions, applySurveyActions, seededIds, autoFixMethodAction, explainMethodRefusal, designProblems, designKindOf, formatCondition, listBlocks,
  TASK_MIN_QUESTIONS,
  type GenerationOutline, type GenerationRequest, type SkeletonSlot, type GenerationBatchPolicy, type SurveyAction, type DeliverableError, type DeliverableExtraChecks, type DeliverableCriteria,
} from "@rescript/engine";
import * as EngineNS from "@rescript/engine";
import { registerBuiltinDesignGenerators } from "@rescript/designs";
import { registerPlanReadinessGate } from "@rescript/analytics";
import type { FailureKind, StepContext, StepHandler, StepResult, TaskPlanner, TaskStepSpec, TaskSummary } from "../types.ts";
import { registerStepHandler, registerTaskPlanner } from "../registry.ts";
import { registerFakeResponder } from "../fakeResponders.ts";
import { COPILOT_SYSTEM_PROMPT, quotaIntent } from "../../copilot/prompt.ts";
import { COPILOT_REPLY_SCHEMA } from "../../copilot/replySchema.ts";
import { itemGuideSelection, type GuideFlags, type GuideId } from "../../copilot/guideSelect.ts";
import { OUTLINE_SCHEMA, batchPrompt, designPrompt, editPrompt, logicPrompt, methodsPrompt, outlinePrompt, quotaPrompt, repairPrompt } from "./generationPrompts.ts";
import { generationFakeResponder } from "./generationFake.ts";

type Def = SurveyDefinition;
type Ai = StepContext["ai"];
type AiFailure = { ok: false; kind: FailureKind; message: string; retryAfterMs?: number };

/** repairs per batch / logic step / final check before the task stops and says what is still wrong */
export const MAX_REPAIR_ROUNDS = 2;
const policy = (): GenerationBatchPolicy => generationPolicyFrom(process.env);

/* ------------------------------------------------------------ cost estimates (for the plan's ETA / budget, never billed) */

const TIER_PRICE: Record<string, [number, number]> = { small: [0.8, 4], standard: [3, 15], strong: [15, 75] };
function estimateOf(promptChars: number, outputTokens: number, tier: "small" | "standard" | "strong" = "standard", cachedChars = COPILOT_SYSTEM_PROMPT.length): TaskStepSpec["estimate"] {
  const fresh = Math.ceil(promptChars / 4), cached = Math.ceil(cachedChars / 4);
  const [pin, pout] = TIER_PRICE[tier];
  return { inputTokens: fresh + cached, outputTokens, usd: Math.round(((fresh * pin + cached * pin * 0.1 + outputTokens * pout) / 1e6) * 10000) / 10000 };
}
const PER_Q_TOKENS = { simple: 190, complex: 420, exam: 380 };
function batchMaxTokens(slots: readonly SkeletonSlot[], exam: boolean): number {
  const t = slots.reduce((n, s) => n + (exam ? PER_Q_TOKENS.exam : PER_Q_TOKENS[s.complexity]), 0);
  return Math.min(16000, Math.max(1200, Math.round(t * 1.35) + 500));
}

/* ------------------------------------------------------------ outcomes */

/**
 * A model failure → what the engine does with this step. Output / context limits SPLIT the step (never a retry of
 * the same size); transient failures retry (Retry-After honoured by the engine); auth / config / budget stop with
 * the reason, progress kept.
 */
function onAiFailure(ctx: StepContext, f: AiFailure, split?: () => StepResult | null): StepResult {
  const timedOut = f.kind === "network" && /time[sd]? ?out|timeout|deadline|did not answer in time/i.test(f.message);
  switch (f.kind) {
    case "output_limit": case "context_limit": {
      const s = split?.();
      return s ?? { status: "failed", reason: `${f.message} — this step is already a single unit and cannot be made smaller`, permanent: true };
    }
    case "rate_limit": case "provider_outage": case "unknown": case "network": {
      if (timedOut && ctx.attempt >= 1) { const s = split?.(); if (s) return s; }
      return { status: "retry", reason: f.message, ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}) };
    }
    case "invalid_output": return ctx.attempt < 2 ? { status: "retry", reason: f.message } : { status: "failed", reason: `the model's answer could not be read twice: ${f.message}`, permanent: false };
    case "auth": return { status: "blocked", reason: f.message, needs: "auth" };
    case "config": return { status: "blocked", reason: f.message, needs: "config" };
    case "budget": return { status: "blocked", reason: f.message, needs: "budget" };
    case "cancelled": return { status: "failed", reason: "cancelled", permanent: false };
    default: return { status: "failed", reason: f.message, permanent: false };
  }
}

const ok = (actions: unknown[], data: unknown, warnings: string[] = []): StepResult => ({ status: "completed", output: { actions, data, validation: { ok: true, errors: [], warnings: [...new Set(warnings)].slice(0, 20) } } });
const actionsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { actions?: unknown }).actions) ? (v as { actions: unknown[] }).actions : []);
const up = (s: string) => s.toUpperCase();
/** the execution panel's hints: how many units a step covers and its range of codes */
/** "Q21".."Q40" → every code between (same prefix) */
function expandRange(from: string, to: string): string[] {
  const a = /^([A-Za-z_]*)(\d+)$/.exec(from), b = /^([A-Za-z_]*)(\d+)$/.exec(to);
  if (!a || !b || a[1] !== b[1]) return [from, to];
  const out: string[] = [];
  for (let i = Number(a[2]); i <= Number(b[2]) && out.length < 2000; i++) out.push(`${a[1]}${i}`);
  return out;
}
const unitsOf = (codes: readonly string[]) => {
  const num = (c: string | undefined) => { const m = /(\d+)$/.exec(c ?? ""); return m ? Number(m[1]) : null; };
  const from = num(codes[0]), to = num(codes[codes.length - 1]);
  return { units: codes.length, ...(from !== null && to !== null ? { range: { from, to } } : {}), rangeCodes: { from: codes[0] ?? "", to: codes[codes.length - 1] ?? "" } };
};

/** K4's assessment validator when its module is in the engine build (no hard dependency either way) */
function assessmentCheck(): DeliverableExtraChecks["assessment"] | undefined {
  const fn = (EngineNS as unknown as Record<string, unknown>).validateAssessment;
  return typeof fn === "function" ? (fn as DeliverableExtraChecks["assessment"]) : undefined;
}

/** does this action create, target or read one of these codes? */
function touchesCodes(a: SurveyAction, codes: Set<string>): boolean {
  const o = a as unknown as Record<string, unknown>;
  for (const k of ["code", "target", "from", "to", "variable"]) if (typeof o[k] === "string" && codes.has(up(o[k] as string))) return true;
  for (const k of ["expression", "when"]) {
    const v = o[k];
    const text = typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : "";
    for (const w of text.match(/[A-Za-z_][\w]*/g) ?? []) if (codes.has(up(w))) return true;
  }
  return false;
}

/* ------------------------------------------------------------ the request → summary */

export function summaryFor(message: string, req: GenerationRequest, prev?: TaskSummary): TaskSummary {
  const goal = message.length > 1500 ? `${message.slice(0, 1500)}…` : message;
  const deliverables = [
    req.kind === "generate" && req.count ? `${req.count} ${req.assessment ? "exam questions with answer keys and explanations" : "questions"}` : "",
    req.kind === "bulk_edit" ? `${req.targets.length} existing questions changed as asked (${req.editKind})` : "",
    req.kind === "methods" ? `a validated ${req.method === "maxdiff" ? "MaxDiff" : (req.method ?? "cbc").toUpperCase()} design, its survey question and its analysis plan` : "",
    req.hints.logic ? "display / skip logic" : "", req.hints.quotas ? "quotas" : "", req.hints.randomization ? "randomization" : "",
  ].filter(Boolean);
  const constraints = ["question codes, variables and blocks are fixed by the plan's skeleton", "every step's actions are checked by the survey engine before they are kept"];
  return { goal, deliverables, constraints, decisions: prev?.decisions ?? [], ...(req.language ? { language: req.language } : prev?.language ? { language: prev.language } : {}), sourceTurnIds: prev?.sourceTurnIds ?? [] };
}

/** the build's guide switches, read from the request (the same guides a single turn would send) */
function buildFlags(message: string, req: GenerationRequest): GuideFlags {
  return { analysis: !req.assessment, quota: req.hints.quotas || quotaIntent(message), methods: !!req.method, ux: req.hints.scripts };
}

/** the guides one section needs (engine #11 per-item selection), decided at plan time so the step input is stable */
function sectionGuides(message: string, req: GenerationRequest, section: { title: string; purpose?: string; logic?: string }, codes: string[]): GuideId[] {
  if (req.assessment) return [];
  const sel = itemGuideSelection({ item: { id: "s", title: `Write the “${section.title}” questions`, kind: "create", objects: codes.slice(0, 20), reason: section.purpose ?? "", ...(section.logic ? { detail: section.logic } : {}) }, build: buildFlags(message, req), mode: "generate" });
  return sel.all;
}

/** criteria that the survey as it is NOW already passes (a pre-existing problem is not this task's to fix) */
function criteriaKeptFor(def: Def, lines: string[]): { keep: string[]; dropped: string[] } {
  const keep: string[] = [], dropped: string[] = [];
  const empty = !(def?.questions?.length);
  for (const l of lines) {
    if (empty || /^(questions|codes:|quotas|randomizers|design_valid|assessment)/i.test(l)) { keep.push(l); continue; }
    const c = parseCompletionCriteria([l]);
    const base: DeliverableCriteria = { unique: false, logic: false, scripts: false, runtime: false, noDuplicateText: false, ...c };
    (validateSurveyDeliverable(def, base).ok ? keep : dropped).push(l);
  }
  return { keep, dropped };
}

/* ------------------------------------------------------------ planning: a new survey */

export interface GenerationStepsInput {
  message: string;
  survey: unknown;
  count?: number;
  assessment?: { perQuestion: true; optionsCount: number } | null;
  ai?: Ai;
  idPrefix?: string;
  summary?: TaskSummary;
  req?: GenerationRequest;
}

/**
 * The steps of a new survey (or exam paper) — design, skeleton, content batches, randomization, logic, quotas,
 * validation — with the outline from ONE small model call (or the deterministic fallback when it fails).
 * K4's assessment planner calls this for a paper's content (assessment set: exam batches, no research design).
 */
export async function buildGenerationSteps(input: GenerationStepsInput): Promise<{ steps: TaskStepSpec[]; completion: string[]; summary: TaskSummary; outline: GenerationOutline }> {
  const def = (input.survey ?? { questions: [], flow: [] }) as Def;
  const req = input.req ?? readGenerationRequest(input.message, def);
  const exam = input.assessment ?? (req.assessment ? { perQuestion: true as const, optionsCount: 4 } : null);
  const total = Math.max(1, Math.min(1000, input.count ?? req.count ?? TASK_MIN_QUESTIONS));
  const P = input.idPrefix ?? "";
  const pol = policy();
  /* an exam question carries an explanation per option: about twice the output of a simple question */
  const batchPol = exam ? { ...pol, simpleBatch: Math.max(5, Math.round(pol.simpleBatch / 2)), complexBatch: Math.max(3, Math.round(pol.complexBatch / 2)) } : pol;

  /* 1. the outline: one small call, else the fallback (planning never fails for want of a model) */
  let outline: GenerationOutline | null = null;
  const decisions: string[] = [];
  if (input.ai) {
    const r = await input.ai({ purpose: "gen.outline", prompt: outlinePrompt(input.message, total, { hints: req.hints, assessment: !!exam }), schema: OUTLINE_SCHEMA, maxTokens: 2500, tier: "small" });
    if (r.ok) outline = normalizeOutline(r.value, total, { hints: req.hints, assessment: !!exam });
    if (!outline) decisions.push(r.ok ? "the proposed sections were unusable; a standard outline was used" : `the outline call failed (${r.kind}); a standard outline was used`);
  }
  outline ??= fallbackOutline(total, { hints: req.hints, assessment: !!exam });

  /* 2. the skeleton — codes, variables, blocks — and the batches */
  const sk = buildSkeleton(outline, def);
  const batches = planBatches(sk.slots, batchPol);
  const summary = input.summary ? { ...input.summary } : summaryFor(input.message, req);
  summary.decisions = [...summary.decisions, ...decisions, `Sections: ${outline.sections.map((s) => `${s.title} (${s.count}${s.complexity === "complex" ? ", complex" : ""})`).join(" · ")}`, `Codes ${sk.slots[0]?.code}–${sk.slots[sk.slots.length - 1]?.code} assigned up front`].slice(-20);

  const steps: TaskStepSpec[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  if (!exam) steps.push({ id: `${P}design`, kind: "gen.design", title: "Research design", dependsOn: [], input: { outlineTitles: outline.sections.map((s) => s.title) }, modelTier: "small", estimate: estimateOf(2500, 900, "small") });
  steps.push({ id: `${P}skeleton`, kind: "gen.skeleton", title: `Structure: ${sk.blocks.length} blocks, codes ${sk.slots[0]?.code}–${sk.slots[sk.slots.length - 1]?.code}`, dependsOn: [], input: { blocks: sk.blocks.map((b) => b.title), codes: sk.slots.map((s) => s.code) }, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } });
  const batchIds: string[] = [];
  const batchOfCode = new Map<string, string>();
  batches.forEach((b, i) => {
    const id = `${P}b${pad(i + 1)}`;
    batchIds.push(id);
    for (const s of b) batchOfCode.set(s.code, id);
    const secIdx = [...new Set(b.map((s) => s.section))];
    const sections = secIdx.map((k) => ({ index: k, title: sk.blocks[k].title, ...sectionSpan(sk.slots, k), ...(outline!.sections[k].purpose ? { purpose: outline!.sections[k].purpose } : {}), ...(outline!.sections[k].types ? { types: outline!.sections[k].types } : {}), ...(outline!.sections[k].logic ? { logic: outline!.sections[k].logic } : {}), ...(outline!.sections[k].topic ? { topic: outline!.sections[k].topic } : {}) }));
    const guides = [...new Set(sections.flatMap((s) => sectionGuides(input.message, req, s, b.map((x) => x.code))))];
    const complex = b.some((s) => s.complexity === "complex");
    const maxTokens = batchMaxTokens(b, !!exam);
    steps.push({ id, kind: "gen.batch", title: `Questions ${b[0].code}–${b[b.length - 1].code}`, dependsOn: [`${P}skeleton`], parallelGroup: "content", modelTier: "standard", input: { slots: b, sections, total, guides, maxTokens, assessment: exam, round: 0, ...unitsOf(b.map((x) => x.code)) }, estimate: estimateOf(2200 + 120 * b.length, Math.round(maxTokens * 0.7), "standard") });
    void complex;
  });

  /* 3. randomization (deterministic), logic per range, quotas */
  const after = [...batchIds];
  if (outline.randomize.length >= 2) {
    const titles = outline.randomize.map((t) => sk.blocks[outline!.sections.findIndex((s) => s.title === t)]?.title).filter(Boolean);
    if (titles.length >= 2) steps.push({ id: `${P}randomize`, kind: "gen.randomization", title: `Rotate ${titles.length} sections`, dependsOn: [...batchIds], input: { blocks: titles }, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } });
  }
  const logicSections = outline.sections.map((s, i) => ({ s, i })).filter(({ s }) => !exam && (req.hints.logic || !!s.logic));
  if (logicSections.length || (!exam && outline.logic.length)) {
    const codes = sk.slots.filter((x) => logicSections.some((l) => l.i === x.section) || (!logicSections.length && outline!.logic.length)).map((x) => x.code);
    const chunks: string[][] = [];
    for (let i = 0; i < codes.length; i += pol.logicBatch) chunks.push(codes.slice(i, i + pol.logicBatch));
    chunks.forEach((c, i) => {
      const lastIdx = sk.slots.findIndex((x) => x.code === c[c.length - 1]);
      const deps = [...new Set(sk.slots.slice(0, lastIdx + 1).map((x) => batchOfCode.get(x.code)!))];
      const notes = [...new Set(sk.slots.filter((x) => c.includes(x.code)).map((x) => outline!.sections[x.section].logic).filter((x): x is string => !!x)), ...outline!.logic];
      const id = `${P}logic${pad(i + 1)}`;
      after.push(id);
      steps.push({ id, kind: "gen.logic", title: `Logic ${c[0]}–${c[c.length - 1]}`, dependsOn: [...deps, ...(steps.some((s) => s.id === `${P}randomize`) ? [`${P}randomize`] : [])], modelTier: "standard", input: { codes: c, notes, round: 0, ...unitsOf(c) }, estimate: estimateOf(3000 + 110 * Math.min(lastIdx + 1, 120), 2500, "standard") });
    });
  }
  if (!exam && (req.hints.quotas || outline.quotas.length)) {
    steps.push({ id: `${P}quotas`, kind: "gen.quotas", title: "Quotas", dependsOn: [...batchIds], modelTier: "standard", input: { notes: outline.quotas, round: 0, guides: ["quota"] }, estimate: estimateOf(4000, 1500, "standard") });
    after.push(`${P}quotas`);
  }
  if (steps.some((s) => s.id === `${P}randomize`)) after.push(`${P}randomize`);
  if (steps.some((s) => s.id === `${P}design`)) after.push(`${P}design`);

  /* 4. the final check */
  const startCount = (def.questions ?? []).filter(isRespondentQuestion).length;
  const wanted = [
    `questions>=${startCount + total}`, `codes:${compactCodes(sk.slots.map((s) => s.code))}`, "unique_codes", "logic_refs", "runtime_compatible", "scripts_valid", "no_duplicate_text",
    ...(steps.some((s) => s.id === `${P}quotas`) ? ["quotas>=1"] : []),
    ...(steps.some((s) => s.id === `${P}randomize`) ? ["randomizers>=1"] : []),
    ...(exam ? [`assessment:${total}`] : []),
  ];
  const { keep, dropped } = criteriaKeptFor(def, wanted);
  if (dropped.length) summary.decisions.push(`Not judged (the survey already fails them): ${dropped.join(", ")}`);
  const slotBlocks: Record<string, string> = Object.fromEntries(sk.slots.map((s) => [s.code, s.block]));
  steps.push({ id: `${P}validate`, kind: "gen.validate", title: "Final check", dependsOn: after, input: { criteria: keep, slotBlocks, assessment: !!exam }, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } });
  return { steps, completion: keep, summary, outline };
}

/** a section's first and last code and size — so a batch knows its place without reading its siblings' output */
function sectionSpan(slots: readonly SkeletonSlot[], k: number): { from: string; to: string; count: number } {
  const xs = slots.filter((s) => s.section === k);
  return { from: xs[0]?.code ?? "", to: xs[xs.length - 1]?.code ?? "", count: xs.length };
}

/* ------------------------------------------------------------ planning: a large edit */

export function buildEditSteps(message: string, survey: unknown, req: GenerationRequest, summary: TaskSummary): { steps: TaskStepSpec[]; completion: string[]; summary: TaskSummary } {
  const def = survey as Def;
  const groups = planEditBatches(def, req.targets, policy(), req.editKind);
  const every = /\b(?:every|all|each)\b|सभी|हर|सारे|प्रत्येक/i.test(message) || /\bQ\d+\s*(?:-|–|—|to|through)\s*Q?\d+/i.test(message);
  const exam = req.assessment || def.questions.some((q) => !!(q as { assessment?: unknown }).assessment);
  const guides: GuideId[] = [...(req.editKind === "logic" ? [] : exam ? [] : ["analysis" as GuideId]), ...(req.hints.quotas ? ["quota" as GuideId] : [])];
  const steps: TaskStepSpec[] = groups.map((g, i) => ({
    id: `e${String(i + 1).padStart(2, "0")}`, kind: "gen.edit_batch", title: `Edit ${g[0]}–${g[g.length - 1]}`, dependsOn: [], parallelGroup: "edits", modelTier: "standard",
    input: { codes: g, instruction: message.slice(0, 1500), editKind: req.editKind ?? "general", every, round: 0, guides, assessment: exam, ...unitsOf(g) },
    estimate: estimateOf(1800 + 160 * g.length, 140 * g.length + 400, "standard"),
  }));
  const respondent = def.questions.filter(isRespondentQuestion).length;
  const { keep, dropped } = criteriaKeptFor(def, [`questions>=${respondent}`, `questions<=${respondent}`, "unique_codes", "logic_refs", "runtime_compatible", "scripts_valid"]);
  const s = { ...summary, decisions: [...summary.decisions, `${req.targets.length} questions in ${groups.length} batches (${req.editKind})`, ...(dropped.length ? [`Not judged (the survey already fails them): ${dropped.join(", ")}`] : [])] };
  steps.push({ id: "validate", kind: "gen.validate", title: "Final check", dependsOn: steps.map((x) => x.id), input: { criteria: keep, slotBlocks: {}, assessment: false, baseline: validateSurveyDeliverable(def, parseCompletionCriteria(keep)).errors.map((e) => e.message).slice(0, 200) }, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } });
  return { steps, completion: keep, summary: s };
}

/* ------------------------------------------------------------ planning: MaxDiff / conjoint */

export function buildMethodsSteps(message: string, survey: unknown, req: GenerationRequest, summary: TaskSummary): { steps: TaskStepSpec[]; completion: string[]; summary: TaskSummary } {
  const def = (survey ?? { questions: [], flow: [] }) as Def;
  const method = req.method ?? "cbc";
  const support = Math.min(12, Math.max(0, (req.count ?? 0) > 0 && (req.count ?? 0) <= 40 && method !== "maxdiff" ? req.count! - 1 : 8));
  const screener = Math.max(1, Math.round(support / 2));
  const outline: GenerationOutline = { sections: [
    { title: "Screening", count: screener, complexity: "simple", purpose: "Qualify the respondent for the category" },
    { title: method === "maxdiff" ? "Priorities" : "Choice exercise", count: 1, complexity: "complex", purpose: "The design question" },
    { title: "Profile", count: Math.max(1, support - screener), complexity: "simple", purpose: "Category usage and demographics for the analysis" },
  ], quotas: [], randomize: [], logic: [], source: "fallback" };
  const sk = buildSkeleton(outline, def);
  const designSlot = sk.slots.find((s) => s.section === 1)!;
  const content = sk.slots.filter((s) => s.section !== 1);
  const batches = planBatches(content, policy());
  const steps: TaskStepSpec[] = [
    { id: "design", kind: "gen.design", title: "Research design", dependsOn: [], input: { outlineTitles: outline.sections.map((s) => s.title) }, modelTier: "small", estimate: estimateOf(2500, 900, "small") },
    { id: "skeleton", kind: "gen.skeleton", title: `Structure: ${sk.blocks.length} blocks`, dependsOn: [], input: { blocks: sk.blocks.map((b) => b.title), codes: sk.slots.map((s) => s.code) }, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } },
  ];
  const batchIds: string[] = [];
  batches.forEach((b, i) => {
    const id = `b${String(i + 1).padStart(2, "0")}`;
    batchIds.push(id);
    const secs = [...new Set(b.map((s) => s.section))].map((k) => ({ index: k, title: sk.blocks[k].title, ...sectionSpan(sk.slots, k), purpose: outline.sections[k].purpose }));
    const maxTokens = batchMaxTokens(b, false);
    steps.push({ id, kind: "gen.batch", title: `Questions ${b[0].code}–${b[b.length - 1].code}`, dependsOn: ["skeleton"], parallelGroup: "content", modelTier: "standard", input: { slots: b, sections: secs, total: content.length, guides: ["analysis"], maxTokens, assessment: null, round: 0, ...unitsOf(b.map((x) => x.code)) }, estimate: estimateOf(2200 + 120 * b.length, Math.round(maxTokens * 0.7), "standard") });
  });
  steps.push({ id: "method", kind: "gen.methods_design", title: `${method === "maxdiff" ? "MaxDiff" : method.toUpperCase()} design`, dependsOn: ["skeleton"], modelTier: "standard", input: { method, code: designSlot.code, block: designSlot.block, round: 0 }, estimate: estimateOf(9000, 2000, "standard") });
  steps.push({ id: "analysis", kind: "gen.analysis_plan", title: "Analysis plan", dependsOn: ["method", ...batchIds, "design"], input: {}, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } });
  const kindWord = method === "maxdiff" ? "maxdiff" : method;
  const wanted = [`design_valid:${designSlot.code}`, `design_valid:${kindWord}`, `codes:${compactCodes(sk.slots.map((s) => s.code))}`, "unique_codes", "logic_refs", "runtime_compatible"];
  const { keep, dropped } = criteriaKeptFor(def, wanted);
  steps.push({ id: "validate", kind: "gen.validate", title: "Final check (design validity)", dependsOn: ["analysis", ...batchIds, "method", "design"], input: { criteria: keep, slotBlocks: Object.fromEntries(content.map((s) => [s.code, s.block])), assessment: false }, estimate: { inputTokens: 0, outputTokens: 0, usd: 0 } });
  const s = { ...summary, decisions: [...summary.decisions, `${method.toUpperCase()} design question ${designSlot.code} in “${designSlot.block}”; ${content.length} supporting questions`, ...(dropped.length ? [`Not judged (the survey already fails them): ${dropped.join(", ")}`] : [])] };
  return { steps, completion: keep, summary: s };
}

/* ------------------------------------------------------------ the planners */

export const generationPlanner: TaskPlanner = {
  id: "generation",
  matches({ message, survey }) {
    const req = readGenerationRequest(message, survey);
    if (req.translation) return 0;                                   // K3's
    /* "design a CBC study for …" is a workflow (design → generation → validation → integration → analysis): forced into a task; "add a MaxDiff question" stays a single turn unless the size says otherwise */
    if (req.kind === "methods") return /\b(?:stud(?:y|ies)|design (?:a|an|the|my)|workflow|experiment)\b/i.test(message) ? 0.9 : 0.6;
    /* an exam is the assessment planner's (E3, ≥ 0.9, it calls buildGenerationSteps); until it is registered the generation planner builds the paper's questions without a key, at a score the assessment planner beats */
    if (req.kind === "generate") return (req.count ?? 0) >= TASK_MIN_QUESTIONS ? (req.assessment ? 0.7 : (req.count ?? 0) >= 100 ? 0.9 : 0.8) : 0;
    if (req.kind === "bulk_edit") return req.targets.length >= 15 ? (req.assessment ? 0.5 : 0.75) : 0;
    return 0;
  },
  async plan({ message, survey, summary, ai }) {
    const req = readGenerationRequest(message, survey);
    const base = summaryFor(message, req, summary);
    if (req.kind === "bulk_edit") return buildEditSteps(message, survey, req, base);
    if (req.kind === "methods") return buildMethodsSteps(message, survey, req, base);
    const r = await buildGenerationSteps({ message, survey, ai, summary: base, req });
    return { summary: r.summary, steps: r.steps, completion: r.completion };
  },
};

/* ------------------------------------------------------------ handlers */

/** gen.design — the research design, once (small model) */
async function runDesign(ctx: StepContext): Promise<StepResult> {
  const draft = ctx.draft as Def;
  const titles = (ctx.step.input.outlineTitles as string[] | undefined) ?? [];
  const r = await ctx.ai({ purpose: "gen.design", system: COPILOT_SYSTEM_PROMPT, prompt: designPrompt(ctx.summary, titles.length ? { sections: titles.map((t) => ({ title: t, count: 0, complexity: "simple" })), quotas: [], randomize: [], logic: [], source: "fallback" } : null), schema: COPILOT_REPLY_SCHEMA, maxTokens: 1500, tier: "small", guides: ["research"] });
  if (!r.ok) {
    /* the design is context, not content: a failure that is not transient leaves it out, said */
    if (["auth", "config", "budget", "rate_limit", "network", "provider_outage"].includes(r.kind)) return onAiFailure(ctx, r);
    return ok([], { skipped: true }, [`The research design was not written (${r.message}).`]);
  }
  const acts = coerceSurveyActions(actionsOf(r.value)).actions.filter((a) => a.op === "set_research").slice(0, 1).map((a) => ({ ...a, constructs: undefined }) as SurveyAction);
  const chk = checkBatch(draft, acts, [], { seed: `${ctx.taskId}:${ctx.step.id}` });
  if (!chk.ok) return ok([], { skipped: true }, [`The research design was refused (${chk.errors[0]}) and left out.`]);
  return ok(chk.accepted, { research: true });
}

/** gen.skeleton — deterministic: the blocks, the codes checked free */
async function runSkeleton(ctx: StepContext): Promise<StepResult> {
  const draft = ctx.draft as Def;
  const blocks = (ctx.step.input.blocks as string[]) ?? [];
  const codes = (ctx.step.input.codes as string[]) ?? [];
  const taken = new Set((draft.questions ?? []).flatMap((q) => [up(String(q.code)), up(q.variableName)]));
  const clash = codes.filter((c) => taken.has(up(c)));
  if (clash.length) return { status: "failed", permanent: true, reason: `The survey changed since the plan was made: ${clash.slice(0, 5).join(", ")}${clash.length > 5 ? ` and ${clash.length - 5} more` : ""} already exist. Ask again to re-plan.` };
  const have = new Set(listBlocks((draft.flow ?? []) as unknown[]).map((b) => (b.title ?? "").toLowerCase()));
  const acts: SurveyAction[] = blocks.filter((t) => !have.has(t.toLowerCase())).map((title) => ({ op: "create_block", title }) as SurveyAction);
  const chk = checkBatch(draft, acts, [], { seed: `${ctx.taskId}:${ctx.step.id}` });
  if (!chk.ok) return { status: "failed", permanent: true, reason: `The blocks could not be created: ${chk.errors.slice(0, 3).join("; ")}` };
  return ok(chk.accepted, { blocks: blocks.length, codes: codes.length, first: codes[0], last: codes[codes.length - 1] });
}

interface BatchInput { slots: SkeletonSlot[]; sections: { index: number; title: string; from?: string; to?: string; count?: number; purpose?: string; types?: string[]; logic?: string; topic?: string }[]; kept?: string[]; total: number; guides?: GuideId[]; maxTokens?: number; assessment?: { perQuestion: true; optionsCount: number } | null; round?: number; errors?: string[] }

function childSpec(ctx: StepContext, id: string, title: string, input: Record<string, unknown>, kind = ctx.step.kind): TaskStepSpec {
  return { id, kind, title, dependsOn: ctx.step.dependsOn.filter((d) => d !== ctx.step.id), input, ...(ctx.step.parallelGroup ? { parallelGroup: ctx.step.parallelGroup } : {}), ...(ctx.step.modelTier ? { modelTier: ctx.step.modelTier } : {}) };
}
const repairKind = (k: string) => (/repair$/.test(k) ? k : `${k}_repair`);

/** gen.batch — one batch of new questions on the skeleton's slots */
async function runBatch(ctx: StepContext): Promise<StepResult> {
  const input = ctx.step.input as unknown as BatchInput;
  const slots = input.slots ?? [];
  const draft = ctx.draft as Def;
  if (!slots.length) return ok([], { codes: [] });
  const exists = slots.filter((s) => draft.questions.some((q) => up(String(q.code)) === up(s.code)));
  if (exists.length) return { status: "failed", permanent: true, reason: `${exists.map((s) => s.code).join(", ")} already exist${exists.length === 1 ? "s" : ""} in the survey (it changed since the plan was made) — ask again to re-plan.` };
  /*
   * What this batch must not repeat: the questions of its blocks that are NOT written by this plan's batches
   * (they existed before the task) plus, on a repair round, what this batch itself kept. Never a sibling batch's
   * output — siblings run in parallel, and a prompt that depended on which of them had committed would differ
   * between a crashed attempt and its re-run (the call cache would miss and the provider be paid twice).
   * Overlap between siblings is caught by the duplicate-wording check instead.
   */
  const blockTitles = new Set(slots.map((s) => s.block.toLowerCase()));
  const planned = new Set((input.sections ?? []).flatMap((sec) => (sec.from ? expandRange(sec.from, sec.to ?? sec.from) : [])).map(up));
  const kept = new Set((input.kept ?? []).map(up));
  const sameCodes = listBlocks((draft.flow ?? []) as unknown[]).filter((b) => blockTitles.has((b.title ?? "").toLowerCase())).flatMap((b) => b.pages.flatMap((p) => p.node.questionIds)).map((id) => draft.questions.find((q) => q.id === id)?.code).filter((c): c is string => !!c && (!planned.has(up(c)) || kept.has(up(c))));
  const sameSection = questionDigest(draft, sameCodes.slice(-30), 30);
  const exam = input.assessment ?? null;
  const prompt = batchPrompt(ctx.summary, { slots, sections: input.sections ?? [], total: input.total ?? slots.length, assessment: exam, sameSection, round: input.round ?? 0, errors: input.errors });
  const r = await ctx.ai({ purpose: "gen.batch", system: COPILOT_SYSTEM_PROMPT, prompt, schema: COPILOT_REPLY_SCHEMA, maxTokens: input.maxTokens ?? batchMaxTokens(slots, !!exam), tier: ctx.step.modelTier ?? "standard", guides: input.guides ?? [] });
  const split = (): StepResult | null => {
    const halves = splitSlots(slots);
    if (!halves) return null;
    return { status: "split", reason: `${slots.length} questions were too many for one answer — two batches of ${halves[0].length} and ${halves[1].length}`, replaceWith: halves.map((h, i) => childSpec(ctx, `${ctx.step.id}${i === 0 ? "a" : "b"}`, `Questions ${h[0].code}–${h[h.length - 1].code}`, { ...input, slots: h, maxTokens: batchMaxTokens(h, !!exam), ...unitsOf(h.map((x) => x.code)) })) };
  };
  if (!r.ok) return onAiFailure(ctx, r, split);
  /*
   * Each question goes to its planned place: after the nearest planned question of its block that will exist when
   * this step is replayed — one this batch kept on an earlier round (its dependency) — else before the nearest kept
   * one after it; on a first round, at the end of its block (in order). A sibling batch's questions are never named
   * (they may replay later); the final check restores any order this leaves (orderMoves).
   */
  const blockPlan = new Map((input.sections ?? []).filter((sec) => sec.from).map((sec) => [sec.title.toLowerCase(), expandRange(sec.from!, sec.to ?? sec.from!)]));
  /* only codes that exist for sure: a question created earlier in this same batch may still be refused, and naming it would refuse this one too */
  const place = (slot: SkeletonSlot) => slotPlacement(slot.code, blockPlan.get(slot.block.toLowerCase()) ?? [], kept);
  const n = normalizeBatchActions(r.value, slots, { place });
  const assess = exam ? assessmentCheck() : undefined;
  const chk = checkBatch(draft, n.actions, slots, { seed: `${ctx.taskId}:${ctx.step.id}`, ...(assess ? { assessment: assess, requireAssessment: true } : {}) });
  const notes = [...n.notes, ...n.rejected];
  if (chk.ok) return ok(chk.accepted, { codes: slots.map((s) => s.code), notes }, [...notes, ...chk.warnings]);
  return repairOrFail(ctx, {
    bad: new Set([...chk.problems.map((p) => p.code).filter((c): c is string => !!c && slots.some((s) => up(s.code) === up(c))).map(up), ...n.missing.map(up)]),
    all: slots.map((s) => up(s.code)),
    actions: n.actions,
    errors: [...chk.errors, ...n.rejected],
    recheck: (keep, goodCodes) => checkBatch(draft, keep, slots.filter((s) => goodCodes.has(up(s.code))), { seed: `${ctx.taskId}:${ctx.step.id}:keep`, ...(assess ? { assessment: assess, requireAssessment: true } : {}) }),
    repairInput: (badCodes, errs) => ({ ...input, kept: slots.map((s) => s.code).filter((c) => !badCodes.has(up(c))), slots: slots.filter((s) => badCodes.has(up(s.code))), maxTokens: batchMaxTokens(slots.filter((s) => badCodes.has(up(s.code))), !!exam), errors: errs, ...unitsOf(slots.filter((s) => badCodes.has(up(s.code))).map((s) => s.code)) }),
    titleOf: (badCodes) => `Repair questions ${[...badCodes].slice(0, 3).join(", ")}${badCodes.size > 3 ? ` (+${badCodes.size - 3})` : ""}`,
    data: { codes: slots.map((s) => s.code), notes },
  });
}

/**
 * INVALID OUTPUT → ONE TARGETED REPAIR. What validated is kept (the batch minus everything that creates, targets or
 * reads a bad code, re-checked on its own); a repair step is asked for exactly the bad codes with exactly the
 * errors. After MAX_REPAIR_ROUNDS the step fails with the errors — never a false success.
 */
function repairOrFail(ctx: StepContext, o: {
  bad: Set<string>; all: string[]; actions: SurveyAction[]; errors: string[];
  recheck: (keep: SurveyAction[], good: Set<string>) => { ok: boolean; accepted: SurveyAction[]; errors: string[] };
  repairInput: (bad: Set<string>, errors: string[]) => Record<string, unknown>;
  titleOf: (bad: Set<string>) => string;
  data: Record<string, unknown>;
}): StepResult {
  const round = Number((ctx.step.input as { round?: number }).round ?? 0);
  let bad = o.bad.size ? o.bad : new Set(o.all);
  let keep = o.actions.filter((a) => !touchesCodes(a, bad));
  let good = new Set(o.all.filter((c) => !bad.has(c)));
  let re = keep.length ? o.recheck(keep, good) : { ok: true, accepted: [] as SurveyAction[], errors: [] as string[] };
  if (!re.ok) { bad = new Set(o.all); keep = []; good = new Set(); re = { ok: true, accepted: [], errors: [] }; }
  const errs = [...new Set(o.errors)].slice(0, 30);
  if (round >= MAX_REPAIR_ROUNDS) return { status: "failed", permanent: true, reason: `Still invalid after ${round} repair${round === 1 ? "" : "s"}: ${errs.slice(0, 4).join("; ")}${errs.length > 4 ? ` (+${errs.length - 4} more)` : ""}` };
  const id = `${ctx.step.id}r${round + 1}`;
  return {
    status: "repair",
    output: { actions: re.accepted, data: { ...o.data, kept: [...good], repairing: [...bad] }, validation: { ok: false, errors: errs, warnings: [] } },
    repair: { ...childSpec(ctx, id, o.titleOf(bad), { ...o.repairInput(bad, errs), round: round + 1 }, repairKind(ctx.step.kind)), dependsOn: [ctx.step.id] },
  };
}

/** gen.logic — display / skip logic for a range of questions, after the content it reads */
async function runLogic(ctx: StepContext): Promise<StepResult> {
  const input = ctx.step.input as { codes: string[]; notes?: string[]; round?: number; errors?: string[] };
  const draft = ctx.draft as Def;
  const codes = input.codes ?? [];
  /* each line says the display logic a question already has: a rule written here REPLACES it (the researcher is asked to confirm a replacement) */
  const all = questionDigest(draft, undefined, 2000).map((line) => {
    const q = draft.questions.find((x) => up(String(x.code)) === up(line.split(" ")[0]));
    let logic = "";
    try { logic = q?.displayLogic ? ` · shown when ${formatCondition(draft, q.displayLogic)}` : ""; } catch { /* unformattable: left out */ }
    return `${line}${logic}`;
  });
  const lastIdx = all.findIndex((l) => up(l.split(" ")[0]) === up(codes[codes.length - 1] ?? ""));
  let digest = all.slice(0, lastIdx >= 0 ? lastIdx + 1 : all.length);
  if (digest.length > 120) digest = [...digest.slice(0, 15), ...digest.slice(-105)];
  const r = await ctx.ai({ purpose: "gen.logic", system: COPILOT_SYSTEM_PROMPT, prompt: logicPrompt(ctx.summary, { codes, digest, notes: input.notes ?? [], round: input.round ?? 0, errors: input.errors }), schema: COPILOT_REPLY_SCHEMA, maxTokens: Math.min(8000, 900 + 90 * codes.length), tier: "standard", guides: [] });
  const split = (): StepResult | null => { const h = splitSlots(codes); return h ? { status: "split", reason: "the logic was too long for one answer", replaceWith: h.map((c, i) => childSpec(ctx, `${ctx.step.id}${i ? "b" : "a"}`, `Logic ${c[0]}–${c[c.length - 1]}`, { ...input, codes: c, ...unitsOf(c) })) } : null; };
  if (!r.ok) return onAiFailure(ctx, r, split);
  const ALLOWED = new Set(["set_display_logic", "add_skip", "clear_skips", "create_calculation", "create_embedded", "page_break", "set_validation"]);
  const co = coerceSurveyActions(actionsOf(r.value), 600);
  const dropped = co.actions.filter((a) => !ALLOWED.has(a.op)).map((a) => `dropped ${a.op}: not part of a logic step`);
  const acts = co.actions.filter((a) => ALLOWED.has(a.op));
  const chk = checkBatch(draft, acts, [], { seed: `${ctx.taskId}:${ctx.step.id}`, touchOnly: codes });
  if (chk.ok) return ok(chk.accepted, { rules: chk.accepted.length, codes: [codes[0], codes[codes.length - 1]] }, [...dropped, ...chk.warnings]);
  const targetOf = (a: SurveyAction) => { const x = a as unknown as Record<string, unknown>; return up(String(x.target ?? x.from ?? "")); };
  const badTargets = new Set([...chk.problems.map((p) => p.code).filter((c): c is string => !!c).map(up), ...acts.filter((a) => !chk.accepted.includes(a)).map(targetOf)].filter((c) => codes.some((x) => up(x) === c)));
  return repairOrFail(ctx, {
    bad: badTargets, all: codes.map(up), actions: acts, errors: chk.errors,
    recheck: (keep) => checkBatch(draft, keep.filter((a) => !badTargets.has(targetOf(a))), [], { seed: `${ctx.taskId}:${ctx.step.id}:keep`, touchOnly: codes }),
    repairInput: (bad, errs) => ({ ...input, codes: codes.filter((c) => bad.has(up(c))), errors: errs, ...unitsOf(codes.filter((c) => bad.has(up(c)))) }),
    titleOf: (bad) => `Repair logic ${[...bad].slice(0, 3).join(", ")}${bad.size > 3 ? ` (+${bad.size - 3})` : ""}`,
    data: { rules: acts.length },
  });
}

/** gen.quotas — the quotas, after the questions they read */
async function runQuotas(ctx: StepContext): Promise<StepResult> {
  const input = ctx.step.input as { notes?: string[]; round?: number; errors?: string[]; guides?: GuideId[] };
  const draft = ctx.draft as Def;
  const blocks = listBlocks((draft.flow ?? []) as unknown[]);
  const pick = [blocks[0], blocks[blocks.length - 1]].filter(Boolean).flatMap((b) => b!.pages.flatMap((p) => p.node.questionIds)).map((id) => draft.questions.find((q) => q.id === id)?.code).filter((c): c is string => !!c);
  const digest = questionDigest(draft, pick.slice(0, 40), 40);
  const r = await ctx.ai({ purpose: "gen.quotas", system: COPILOT_SYSTEM_PROMPT, prompt: quotaPrompt(ctx.summary, { digest, notes: input.notes ?? [], round: input.round ?? 0, errors: input.errors }), schema: COPILOT_REPLY_SCHEMA, maxTokens: 2500, tier: "standard", guides: input.guides ?? ["quota"] });
  if (!r.ok) return onAiFailure(ctx, r);
  const ALLOWED = new Set(["create_quota", "set_quota_check", "update_quota", "add_quota_cells"]);
  const acts = coerceSurveyActions(actionsOf(r.value), 50).actions.filter((a) => ALLOWED.has(a.op));
  const chk = checkBatch(draft, acts, [], { seed: `${ctx.taskId}:${ctx.step.id}` });
  const made = chk.accepted.filter((a) => a.op === "create_quota").length;
  if (chk.ok && made) return ok(chk.accepted, { quotas: made }, chk.warnings);
  const round = input.round ?? 0;
  const errs = [...chk.errors, ...(made ? [] : ["no quota was written (create_quota with cells on the screening questions)"])];
  if (round >= MAX_REPAIR_ROUNDS) return { status: "failed", permanent: true, reason: `The quotas are still invalid: ${errs.slice(0, 3).join("; ")}` };
  return { status: "repair", output: { actions: [], data: { quotas: 0 }, validation: { ok: false, errors: errs.slice(0, 20), warnings: [] } }, repair: { ...childSpec(ctx, `${ctx.step.id}r${round + 1}`, "Repair the quotas", { ...input, round: round + 1, errors: errs.slice(0, 20) }, repairKind(ctx.step.kind)), dependsOn: [ctx.step.id] } };
}

/** gen.randomization — deterministic: the planned sections in one randomizer */
async function runRandomization(ctx: StepContext): Promise<StepResult> {
  const draft = ctx.draft as Def;
  const want = ((ctx.step.input.blocks as string[]) ?? []);
  const have = new Set(listBlocks((draft.flow ?? []) as unknown[]).map((b) => b.title ?? ""));
  const blocks = want.filter((t) => have.has(t));
  if (blocks.length < 2) return { status: "failed", permanent: true, reason: `Only ${blocks.length} of the sections to rotate exist (${want.join(", ")}).` };
  const acts = [{ op: "create_randomizer", blocks, title: "Rotate sections" } as SurveyAction];
  const chk = checkBatch(draft, acts, [], { seed: `${ctx.taskId}:${ctx.step.id}` });
  if (!chk.ok) return { status: "failed", permanent: true, reason: `The randomizer was refused: ${chk.errors.slice(0, 2).join("; ")}` };
  return ok(chk.accepted, { randomized: blocks });
}

/** gen.edit_batch — one range of a large edit of existing questions */
async function runEdit(ctx: StepContext): Promise<StepResult> {
  const input = ctx.step.input as { codes: string[]; instruction: string; editKind: string; every: boolean; round?: number; errors?: string[]; guides?: GuideId[]; assessment?: boolean };
  const draft = ctx.draft as Def;
  const codes = (input.codes ?? []).filter((c) => draft.questions.some((q) => up(String(q.code)) === up(c)));
  if (!codes.length) return ok([], { codes: [] }, ["None of these questions exists any more."]);
  const digest = questionDigest(draft, codes, codes.length).map((line) => {
    const q = draft.questions.find((x) => up(String(x.code)) === up(line.split(" ")[0]));
    let logic = "";
    try { logic = q?.displayLogic ? ` · shown when ${formatCondition(draft, q.displayLogic)}` : ""; } catch { /* unformattable: left out */ }
    const instr = q?.instruction ? ` · instruction: ${String(q.instruction).replace(/<[^>]+>/g, " ").slice(0, 120)}` : "";
    return `${line}${logic}${instr}`;
  });
  const r = await ctx.ai({ purpose: "gen.edit", system: COPILOT_SYSTEM_PROMPT, prompt: editPrompt(ctx.summary, { codes, digest, instruction: input.instruction, editKind: input.editKind, every: input.every, round: input.round ?? 0, errors: input.errors, assessment: input.assessment }), schema: COPILOT_REPLY_SCHEMA, maxTokens: Math.min(12000, 600 + 260 * codes.length), tier: "standard", guides: input.guides ?? [] });
  const split = (): StepResult | null => { const h = splitSlots(codes); return h ? { status: "split", reason: "the edit was too long for one answer", replaceWith: h.map((c, i) => childSpec(ctx, `${ctx.step.id}${i ? "b" : "a"}`, `Edit ${c[0]}–${c[c.length - 1]}`, { ...input, codes: c, ...unitsOf(c) })) } : null; };
  if (!r.ok) return onAiFailure(ctx, r, split);
  const FORBIDDEN = new Set(["create_question", "delete_question", "delete_block", "create_block", "rename_block", "move_question", "create_randomizer", "create_branch", "create_loop", "create_quota", "delete_quota", "set_research", "propose_analysis_plan", "set_analysis_plan", "set_assessment"]);
  const n = normalizeBatchActions(r.value, [], { forbidden: FORBIDDEN });
  const assess = input.assessment ? assessmentCheck() : undefined;
  const chk = checkBatch(draft, n.actions, [], { seed: `${ctx.taskId}:${ctx.step.id}`, touchOnly: codes });
  const touched = new Set(chk.accepted.flatMap((a) => { const x = a as unknown as Record<string, unknown>; return [x.target, x.from].filter((v): v is string => typeof v === "string").map(up); }));
  const hasOptions = (c: string) => (draft.questions.find((q) => up(String(q.code)) === up(c))?.options?.length ?? 0) > 0;
  const untouched = input.every && input.editKind !== "logic" ? codes.filter((c) => !touched.has(up(c)) && (input.editKind !== "options" || hasOptions(c))) : [];
  const problems = [...chk.errors, ...untouched.map((c) => `${c} was not changed — the request applies to every question in this range`)];
  if (assess && chk.ok) {
    const res = assess(chk.def, { requireExplanations: /explanation|व्याख्या|समझा/i.test(input.instruction), requireTopics: false });
    for (const e of res.errors) { const c = e.questionCode ?? ""; if (codes.some((x) => up(x) === up(c))) problems.push(`${c}: ${e.message}`); }
  }
  if (chk.ok && !problems.length) return ok(chk.accepted, { codes: [codes[0], codes[codes.length - 1]], changed: touched.size }, [...n.notes, ...chk.warnings]);
  const bad = new Set([...chk.problems.map((p) => p.code).filter((c): c is string => !!c).map(up), ...untouched.map(up), ...problems.map((p) => up(p.split(":")[0].trim())).filter((c) => codes.some((x) => up(x) === c))]);
  return repairOrFail(ctx, {
    bad, all: codes.map(up), actions: n.actions, errors: problems,
    recheck: (keep) => checkBatch(draft, keep, [], { seed: `${ctx.taskId}:${ctx.step.id}:keep`, touchOnly: codes }),
    repairInput: (b, errs) => ({ ...input, codes: codes.filter((c) => b.has(up(c))), errors: errs, ...unitsOf(codes.filter((c) => b.has(up(c)))) }),
    titleOf: (b) => `Repair edits ${[...b].slice(0, 3).join(", ")}${b.size > 3 ? ` (+${b.size - 3})` : ""}`,
    data: { codes: [codes[0], codes[codes.length - 1]] },
  });
}

/** gen.methods_design — the MaxDiff / conjoint design: generated by the Studio's generators, validated by design criteria */
async function runMethods(ctx: StepContext): Promise<StepResult> {
  registerDesignSupport();
  const input = ctx.step.input as { method: string; code: string; block: string; round?: number; errors?: string[]; minEfficiency?: number };
  const draft = ctx.draft as Def;
  const r = await ctx.ai({ purpose: "gen.methods", system: COPILOT_SYSTEM_PROMPT, prompt: methodsPrompt(ctx.summary, { method: input.method, code: input.code, block: input.block, round: input.round ?? 0, errors: input.errors }), schema: COPILOT_REPLY_SCHEMA, maxTokens: 3000, tier: "standard", guides: ["methods", "research"] });
  if (!r.ok) return onAiFailure(ctx, r);
  const wantOp = input.method === "maxdiff" ? "create_maxdiff" : "create_conjoint";
  const raw = actionsOf(r.value).find((a) => a && typeof a === "object" && ["create_maxdiff", "create_conjoint"].includes(String((a as Record<string, unknown>).op))) as Record<string, unknown> | undefined;
  const errs: string[] = [];
  let accepted: SurveyAction[] = [];
  let fixNote = "";
  if (!raw) errs.push(`no ${wantOp} action was written`);
  else {
    let obj: Record<string, unknown> = { ...raw, op: wantOp, code: input.code, block: input.block, ...(wantOp === "create_conjoint" && input.method !== "cbc" && !raw.method ? { method: input.method } : {}) };
    delete obj.ref; delete obj.after;
    for (let pass = 0; pass < 2; pass++) {
      const acts = coerceSurveyActions([obj]).actions;
      if (!acts.length) { errs.push(coerceSurveyActions([obj]).rejected[0]?.reason ?? "the design action could not be read"); break; }
      const chk = checkBatch(draft, acts, [{ code: input.code, block: input.block }], { seed: `${ctx.taskId}:${ctx.step.id}` });
      const q = chk.def.questions.find((x) => up(String(x.code)) === up(input.code));
      const design = q ? designProblems(chk.def, q, input.minEfficiency ?? 0) : [];
      const kind = q ? designKindOf(chk.def, q) : null;
      const kindOk = !!q && (input.method === "maxdiff" ? kind === "maxdiff" : kind === input.method || (input.method === "cbc" && kind === "cbc"));
      const problems = [...chk.errors, ...design.filter((d) => d.error).map((d) => d.message), ...(q && !kindOk ? [`${input.code} is a ${kind ?? "?"} design, not ${input.method}`] : [])];
      if (!problems.length) { accepted = chk.accepted; errs.length = 0; fixNote = fixNote || ""; return ok(accepted, { code: input.code, method: input.method, kind, notes: [...design.filter((d) => !d.error).map((d) => d.message), ...(fixNote ? [fixNote] : [])] }, design.filter((d) => !d.error).map((d) => d.message)); }
      /* one deterministic correction where exactly one exists (engine #13) — no model call */
      const reason = problems[0];
      const fix = pass === 0 ? autoFixMethodAction(obj, reason, draft) : null;
      if (!fix) { errs.push(...problems.map((p) => explainMethodRefusal(obj, p))); break; }
      obj = { ...fix.action, code: input.code, block: input.block };
      fixNote = `Corrected by the Studio: ${fix.note}`;
    }
  }
  const round = input.round ?? 0;
  if (round >= MAX_REPAIR_ROUNDS) return { status: "failed", permanent: true, reason: `The design is still not valid: ${[...new Set(errs)].slice(0, 3).join("; ")}` };
  return { status: "repair", output: { actions: [], data: { code: input.code }, validation: { ok: false, errors: [...new Set(errs)].slice(0, 20), warnings: [] } }, repair: { ...childSpec(ctx, `${ctx.step.id}r${round + 1}`, "Repair the design", { ...input, round: round + 1, errors: [...new Set(errs)].slice(0, 20) }, repairKind(ctx.step.kind)), dependsOn: [ctx.step.id] } };
}

/** gen.analysis_plan — deterministic: the engine's own analysis plan for what was built (design estimators included) */
async function runAnalysisPlan(ctx: StepContext): Promise<StepResult> {
  registerDesignSupport();
  const draft = ctx.draft as Def;
  const acts = [{ op: "propose_analysis_plan", merge: true } as SurveyAction];
  const chk = checkBatch(draft, acts, [], { seed: `${ctx.taskId}:${ctx.step.id}` });
  if (!chk.accepted.length) return ok([], { planned: 0 }, [`The analysis plan was not added: ${chk.errors[0] ?? "nothing to plan"}`]);
  const plan = (chk.def.research as { analysisPlan?: { tests?: unknown[]; crosstabs?: unknown[] } } | undefined)?.analysisPlan;
  return ok(chk.accepted, { tests: plan?.tests?.length ?? 0, crosstabs: plan?.crosstabs?.length ?? 0 }, chk.warnings.slice(0, 5));
}

/** gen.validate — deterministic: the deliverable check; a targeted repair for what can be repaired */
async function runValidate(ctx: StepContext): Promise<StepResult> {
  registerDesignSupport();
  const input = ctx.step.input as { criteria: string[]; slotBlocks?: Record<string, string>; assessment?: boolean; baseline?: string[] };
  /* the skeleton's order first, deterministically (a repaired question was created at the end of its block) */
  const ordered = restoreOrder(ctx, ctx.draft as Def, Object.keys(input.slotBlocks ?? {}));
  const draft = ordered.def;
  const assess = assessmentCheck();
  const rep = validateSurveyDeliverable(draft, parseCompletionCriteria(input.criteria ?? []), assess ? { assessment: assess } : {});
  const baseline = new Set(input.baseline ?? []);
  const errors = rep.errors.filter((e) => !baseline.has(e.message));
  if (!errors.length) return ok(ordered.actions, { report: rep.stats, criteria: input.criteria, ...(ordered.actions.length ? { reordered: ordered.actions.length } : {}) }, rep.warnings.slice(0, 15));
  const r = validationRepair(ctx, errors, { criteria: input.criteria ?? [], slotBlocks: input.slotBlocks ?? {}, baseline: input.baseline ?? [], round: 1 }, rep.stats);
  return r.status === "repair" ? { ...r, output: { ...r.output, actions: ordered.actions } } : r;
}

/** move the planned questions back into the skeleton's order (no model call); the moves are this step's actions */
function restoreOrder(ctx: StepContext, draft: Def, planned: string[]): { def: Def; actions: SurveyAction[] } {
  if (!planned.length) return { def: draft, actions: [] };
  const moves = orderMoves(draft, planned);
  if (!moves.length) return { def: draft, actions: [] };
  const chk = checkBatch(draft, moves, [], { seed: `${ctx.taskId}:${ctx.step.id}:order` });
  return chk.accepted.length ? { def: chk.def, actions: chk.accepted } : { def: draft, actions: [] };
}

function validationRepair(ctx: StepContext, errors: DeliverableError[], base: { criteria: string[]; slotBlocks: Record<string, string>; baseline: string[]; round: number }, stats: unknown): StepResult {
  const repairable = errors.filter((e) => e.repair !== "none");
  const msgs = errors.map((e) => e.message);
  if (!repairable.length || base.round > MAX_REPAIR_ROUNDS) return { status: "failed", permanent: true, reason: `The result did not pass the final check: ${msgs.slice(0, 4).join("; ")}${msgs.length > 4 ? ` (+${msgs.length - 4} more)` : ""}` };
  const id = `${ctx.step.id.replace(/r\d+$/, "")}r${base.round}`;
  return {
    status: "repair",
    output: { actions: [], data: { report: stats }, validation: { ok: false, errors: msgs.slice(0, 30), warnings: [] } },
    repair: { id, kind: "gen.repair", title: `Repair ${repairable.length} problem${repairable.length === 1 ? "" : "s"} found by the final check`, dependsOn: [ctx.step.id], modelTier: "standard", input: { ...base, problems: repairable.slice(0, 40) } },
  };
}

/** gen.repair — the final check's targeted repair: only the named questions, re-checked whole */
async function runRepair(ctx: StepContext): Promise<StepResult> {
  registerDesignSupport();
  const input = ctx.step.input as { problems: DeliverableError[]; criteria: string[]; slotBlocks: Record<string, string>; baseline?: string[]; round: number };
  const draft = ctx.draft as Def;
  const problems = input.problems ?? [];
  const missing = problems.filter((p) => p.kind === "missing_code" && p.code && input.slotBlocks?.[p.code]).map((p) => ({ code: p.code!, block: input.slotBlocks[p.code!] }));
  const involved = [...new Set(problems.map((p) => p.code).filter((c): c is string => !!c))];
  const existing = involved.filter((c) => draft.questions.some((q) => up(String(q.code)) === up(c)));
  const digest = questionDigest(draft, existing, 60);
  const guides: GuideId[] = [...(problems.some((p) => p.kind === "design") ? ["methods" as GuideId] : []), ...(problems.some((p) => p.kind === "quota") ? ["quota" as GuideId] : [])];
  const r = await ctx.ai({ purpose: "gen.repair", system: COPILOT_SYSTEM_PROMPT, prompt: repairPrompt(ctx.summary, { problems, digest, missing, round: input.round }), schema: COPILOT_REPLY_SCHEMA, maxTokens: Math.min(12000, 800 + 320 * Math.max(1, involved.length)), tier: "standard", guides });
  if (!r.ok) return onAiFailure(ctx, r);
  const slots: SkeletonSlot[] = missing.map((m, i) => ({ n: i + 1, code: m.code, variable: m.code, block: m.block, section: 0, complexity: "simple" }));
  const FORBIDDEN = new Set(["delete_question", "delete_block", "create_block", "move_question", "create_randomizer", "create_branch", "create_loop", "set_research", "set_assessment"]);
  /* after every step (this repair depends on the final check), every existing question is known at replay */
  const plannedOrder = Object.keys(input.slotBlocks ?? {});
  const known = new Set(draft.questions.map((q) => up(String(q.code))));
  const place = (slot: SkeletonSlot) => slotPlacement(slot.code, plannedOrder.filter((c) => input.slotBlocks[c] === slot.block), known);
  const n = normalizeBatchActions(r.value, slots, { forbidden: FORBIDDEN, place });
  const chk = checkBatch(draft, n.actions, slots, { seed: `${ctx.taskId}:${ctx.step.id}`, touchOnly: [...involved, ...missing.map((m) => m.code)] });
  const assess = assessmentCheck();
  const criteria = parseCompletionCriteria(input.criteria ?? []);
  const baseline = new Set(input.baseline ?? []);
  const ordered = restoreOrder(ctx, chk.def, Object.keys(input.slotBlocks ?? {}));
  const after = validateSurveyDeliverable(ordered.def, criteria, assess ? { assessment: assess } : {});
  const left = after.errors.filter((e) => !baseline.has(e.message));
  const beforeCount = problems.length;
  const kept = left.length < beforeCount ? [...chk.accepted, ...ordered.actions] : [];
  if (!left.length) return ok(kept, { fixed: beforeCount }, [...n.notes, ...chk.warnings]);
  if (input.round < MAX_REPAIR_ROUNDS) {
    const res = validationRepair(ctx, left, { criteria: input.criteria, slotBlocks: input.slotBlocks, baseline: input.baseline ?? [], round: input.round + 1 }, after.stats);
    if (res.status === "repair") return { ...res, output: { ...res.output, actions: kept } };
    return res;
  }
  /* last resort, deterministic: a broken display / skip rule on a named question is removed (said), never left broken */
  const base = kept.length ? applySurveyActions(draft, kept, { ids: seededIds(`${ctx.taskId}:${ctx.step.id}:k`), now: "2026-01-01T00:00:00.000Z" }).def : draft;
  const drop: SurveyAction[] = [];
  for (const e of left) {
    if (e.repair !== "logic" || !e.code || !base.questions.some((q) => up(String(q.code)) === up(e.code!))) continue;
    if (/skip/i.test(e.path ?? "") || /skip/i.test(e.message)) drop.push({ op: "clear_skips", target: e.code } as SurveyAction);
    else if (/display/i.test(e.path ?? "") || /displayLogic/i.test(e.path ?? "")) drop.push({ op: "set_display_logic", target: e.code, expression: null } as SurveyAction);
  }
  if (drop.length) {
    const c2 = checkBatch(base, drop, [], { seed: `${ctx.taskId}:${ctx.step.id}:drop` });
    const fin = validateSurveyDeliverable(c2.def, criteria, assess ? { assessment: assess } : {}).errors.filter((e) => !baseline.has(e.message));
    if (!fin.length) return ok([...kept, ...c2.accepted], { fixed: beforeCount, removed: c2.accepted.length }, c2.accepted.map((a) => `Removed a broken ${a.op === "clear_skips" ? "skip" : "display"} rule on ${(a as { target: string }).target} that could not be repaired — please review it.`));
  }
  return { status: "failed", permanent: true, reason: `Still not valid after ${input.round} repairs: ${left.slice(0, 4).map((e) => e.message).join("; ")}${left.length > 4 ? ` (+${left.length - 4} more)` : ""}` };
}

/* ------------------------------------------------------------ registration */

let designSupport = false;
/** the Studio's design generators and the analysis-plan readiness rule (as the copilot route registers them) */
function registerDesignSupport(): void {
  if (designSupport) return;
  designSupport = true;
  try { registerBuiltinDesignGenerators(); } catch { /* already registered */ }
  try { registerPlanReadinessGate(); } catch { /* already registered */ }
}

const handler = (kind: string, run: (ctx: StepContext) => Promise<StepResult>): StepHandler => ({ kind, run });
export const GENERATION_HANDLERS: StepHandler[] = [
  handler("gen.design", runDesign), handler("gen.skeleton", runSkeleton),
  handler("gen.batch", runBatch), handler("gen.batch_repair", runBatch),
  handler("gen.logic", runLogic), handler("gen.logic_repair", runLogic),
  handler("gen.quotas", runQuotas), handler("gen.quotas_repair", runQuotas),
  handler("gen.randomization", runRandomization),
  handler("gen.edit_batch", runEdit), handler("gen.edit_batch_repair", runEdit),
  handler("gen.methods_design", runMethods), handler("gen.methods_design_repair", runMethods),
  handler("gen.analysis_plan", runAnalysisPlan),
  handler("gen.validate", runValidate), handler("gen.repair", runRepair),
];

/** idempotent: the generation planner, its step handlers and its fake-provider responder (read only under AI_API_URL=fake:) */
export function registerGenerationTasks(): void {
  registerDesignSupport();
  for (const h of GENERATION_HANDLERS) registerStepHandler(h);
  registerTaskPlanner(generationPlanner);
  registerFakeResponder("gen.", generationFakeResponder);
}
