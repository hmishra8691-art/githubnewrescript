import type { Question, SurveyDefinition } from "@rescript/schema";
import { coerceSurveyActions, applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { listBlocks } from "./blocks.js";
import { hashString } from "./random.js";
import { validateSurveyDeliverable, normText, isRespondentQuestion, type DeliverableError, type DeliverableExtraChecks } from "./deliverableValidation.js";
import { conditionRefs } from "./dependencies.js";
import { requestedQuestionCount } from "./taskEstimate.js";

/**
 * LARGE GENERATION AS A PLAN OF SMALL STEPS (durable tasks, K2 2026-10-25) — the pure part.
 *
 * Production evidence (2026-10-24): "100 questions, General Studies" ran as ONE generate call and timed out twice
 * at 163 s; follow-ups on a 104-question survey ("add explanations to every question") timed out the same way.
 * The size of the OUTPUT was never considered. Here it is the first thing read:
 *
 *   readGenerationRequest   how many questions, which kind of work (a new survey, a bulk edit of existing
 *                           questions, a MaxDiff / conjoint design, an exam), which complexity signals
 *   normalizeOutline        the sections the model proposed (or the deterministic fallback), counts made to add
 *                           up EXACTLY to the number asked for
 *   buildSkeleton           every question's CODE, VARIABLE and BLOCK assigned up front, in order, against the
 *                           survey as it is — so batches written in any order, retried or split, produce the same
 *                           ids, and logic written later can name questions that do not exist yet
 *   planBatches             adaptive batch sizes: ~20 simple questions or ~6 complex ones (grids, logic,
 *                           scripts) per model call, packed across section boundaries only when it fits
 *   splitSlots              an output-limit failure halves the batch — never a retry of the same size
 *   normalizeBatchActions   the model's actions made to fit the skeleton: the i-th created question takes the
 *                           i-th slot's code, variable and block (the model never chooses ids), blocks and
 *                           deletions are not its to write, extra questions are dropped
 *   checkBatch              the batch through the engine's own gate (applySurveyActions) on the current draft,
 *                           then the deliverable check scoped to the batch's codes; errors are structured so the
 *                           repair step can name them
 *
 * Nothing here calls a model.
 */

/* ------------------------------------------------------------ reading the request */

export type Complexity = "simple" | "complex";
export type GenerationKind = "generate" | "bulk_edit" | "methods" | "none";
export type EditKind = "text" | "options" | "logic" | "general";

export interface GenerationRequest {
  kind: GenerationKind;
  /** questions asked for (a new survey), or null when none is said */
  count: number | null;
  /** an exam / quiz / test paper */
  assessment: boolean;
  /** the request names logic, grids, scripts, quotas, randomization, piping */
  hints: { logic: boolean; grids: boolean; scripts: boolean; quotas: boolean; randomization: boolean; piping: boolean; calculations: boolean };
  /** bulk edit: the codes in scope (a range or every question) */
  targets: string[];
  editKind: EditKind | null;
  /** MaxDiff / conjoint */
  method: "maxdiff" | "cbc" | "acbc" | "cva" | "menu" | null;
  /** a language named for the content ("in Hindi") — never a translation request, which K3's planner owns */
  language: string | null;
  translation: boolean;
}

const ASSESSMENT = /\b(?:exam|exams|quiz|quizzes|test paper|mock test|practice test|practice paper|question paper|mcqs?|upsc|ssc|cbse|neet|jee|gate exam|prelims|mains|answer key|marking scheme|negative marking|marks? (?:for|per)|score (?:the|my|each)|scoring)\b|प्रश्नपत्र|परीक्षा|टेस्ट|उत्तर कुंजी|अंक/i;
const METHOD = /\b(max[- ]?diff|best[- ]worst|conjoint|cbc|acbc|cva|discrete choice|choice[- ]based|menu[- ]based)\b/i;
const TRANSLATE = /\b(?:translat\w*|locali[sz]e)\b|अनुवाद|ट्रांसलेट|ट्रांस्लेट|tarjuma|anuvad/i;
const EVERY = /\b(?:every|all(?: the)?|each|whole|entire)\s+(?:of\s+the\s+)?(?:survey'?s?\s+)?(?:questions?|options?|answers?|items?|statements?|choices?|answer options?)\b|(?:सभी|हर|सारे|प्रत्येक)\s*(?:प्रश्न|सवाल|ऑप्शन|विकल्प|क्वेश्चन)/i;
const RANGE = /\bQ(\d+)\s*(?:-|–|—|to|through|thru|until|till)\s*Q?(\d+)\b/i;
const EDIT_VERB = /\b(?:add|rewrite|reword|rephrase|change|update|improve|shorten|simplify|replace|set|apply|make|give|insert|include|put|attach)\b|जोड़|बदल|लिख|सुधार/i;

export function readGenerationRequest(message: string, survey?: unknown): GenerationRequest {
  const m = String(message ?? "");
  const def = (survey && typeof survey === "object" ? survey : null) as SurveyDefinition | null;
  const questions = Array.isArray(def?.questions) ? def!.questions : [];
  const hints = {
    logic: /\b(?:display logic|skip(?:s| logic)?|branch\w*|show (?:only )?(?:if|when)|routing|conditional|terminat\w*|screen ?outs?|loops?)\b/i.test(m),
    grids: /\b(?:grids?|matri(?:x|ces)|likert|batter(?:y|ies))\b/i.test(m),
    scripts: /\b(?:javascript|js|scripts?|custom code)\b/i.test(m),
    quotas: /\bquotas?\b|कोटा/i.test(m),
    randomization: /\brandomi[sz]\w*|\brotat\w*/i.test(m),
    piping: /\bpip(?:e|ed|ing)\b/i.test(m),
    calculations: /\b(?:calculat\w*|computed|derived|scor(?:e|ing) (?:index|variable))\b/i.test(m),
  };
  const count = requestedQuestionCount(m) ?? null;
  const assessment = ASSESSMENT.test(m);
  const translation = TRANSLATE.test(m);
  const lang = /\bin (hindi|english|urdu|tamil|telugu|bengali|marathi|gujarati|spanish|french|german|arabic)\b/i.exec(m)?.[1] ?? (/[ऀ-ॿ]/.test(m) ? "hindi" : null);
  const methodWord = METHOD.exec(m)?.[1]?.toLowerCase().replace(/[\s-]/g, "") ?? null;
  const method = methodWord ? (/maxdiff|bestworst/.test(methodWord) ? "maxdiff" : methodWord === "acbc" ? "acbc" : methodWord === "cva" ? "cva" : /menu/.test(methodWord) ? "menu" : "cbc") : null;
  const base = { count, assessment, hints, language: lang ? lang.toLowerCase() : null, translation, method } as const;
  /* a range ("Q20–Q80") or "every question" on a survey that has questions, with an edit verb: a bulk edit */
  const range = RANGE.exec(m);
  if (!translation && questions.length && (range || EVERY.test(m)) && EDIT_VERB.test(m) && !(count && count > questions.length && /\b(?:create|build|generate|make|design|write)\b.{0,40}\b(?:survey|questionnaire|exam|quiz|paper)\b/i.test(m))) {
    const ordered = questionsInOrder(def!);
    let targets = ordered.filter(isRespondentQuestion).map((q) => String(q.code));
    if (range) {
      const lo = Math.min(Number(range[1]), Number(range[2])), hi = Math.max(Number(range[1]), Number(range[2]));
      const inRange = ordered.filter((q) => { const n = /^Q(\d+)$/i.exec(String(q.code)); return n && Number(n[1]) >= lo && Number(n[1]) <= hi; }).map((q) => String(q.code));
      if (inRange.length) targets = inRange;
    }
    const editKind: EditKind = /\b(?:display logic|skip|show (?:only )?(?:if|when)|branch|condition)\b/i.test(m) ? "logic" : /\b(?:options?|answers?|choices?|answer options?)\b|ऑप्शन|विकल्प/i.test(m) && !/\bexplanation/i.test(m) ? "options" : /\b(?:explanations?|instructions?|help text|notes?|wording|text|rewrite|reword|rephrase|shorten|simplify)\b/i.test(m) ? "text" : "general";
    return { kind: "bulk_edit", ...base, targets, editKind };
  }
  if (method && /\b(?:design|study|create|build|set up|setup|add|make|run|generate|plan)\b/i.test(m)) return { kind: "methods", ...base, targets: [], editKind: null };
  if (count !== null && /\b(?:create|build|generate|make|design|write|draft|prepare|program|give me|need)\b|\b(?:survey|questionnaire|exam|quiz|paper|test)\b|बना|तैयार|सर्वे|प्रश्नपत्र/i.test(m)) return { kind: "generate", ...base, targets: [], editKind: null };
  return { kind: "none", ...base, targets: [], editKind: null };
}

function questionsInOrder(def: SurveyDefinition): Question[] {
  const out: Question[] = [];
  const seen = new Set<string>();
  for (const b of listBlocks(def.flow as unknown[])) for (const p of b.pages) for (const id of p.node.questionIds) {
    const q = def.questions.find((x) => x.id === id);
    if (q && !seen.has(q.id)) { seen.add(q.id); out.push(q); }
  }
  for (const q of def.questions) if (!seen.has(q.id)) out.push(q);
  return out;
}

/* ------------------------------------------------------------ the outline */

export interface OutlineSection {
  title: string;
  count: number;
  complexity: Complexity;
  /** what the section measures, one sentence */
  purpose?: string;
  /** question types it uses ("single", "matrix", …) */
  types?: string[];
  /** the logic the section needs, in words ("ask Q only of users", "screen out under 18") */
  logic?: string;
  /** exam: the subject ("Polity") */
  topic?: string;
}
export interface GenerationOutline {
  sections: OutlineSection[];
  /** quotas wanted, in words ("gender 50/50", "age bands") */
  quotas: string[];
  /** section titles to put in a randomizer together */
  randomize: string[];
  /** logic across sections, in words */
  logic: string[];
  /** where the outline came from */
  source: "model" | "fallback";
}

const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const strs = (v: unknown, max = 20, len = 200): string[] => (Array.isArray(v) ? v.map((x) => str(x, len)).filter((x): x is string => !!x).slice(0, max) : []);

/** the model's outline made exact: counts sum to `total`, titles unique, at most 40 sections; null when nothing usable came back */
export function normalizeOutline(raw: unknown, total: number, req?: Pick<GenerationRequest, "hints" | "assessment">): GenerationOutline | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.sections) ? o.sections : [];
  let sections: OutlineSection[] = list.map((s) => {
    const x = (s ?? {}) as Record<string, unknown>;
    const title = str(x.title, 120) ?? str(x.name, 120);
    if (!title) return null;
    const count = Math.max(0, Math.round(Number(x.count ?? x.questions ?? 0)) || 0);
    const complexity: Complexity = x.complexity === "complex" ? "complex" : "simple";
    return { title, count, complexity, ...(str(x.purpose, 300) ? { purpose: str(x.purpose, 300) } : {}), ...(strs(x.types, 8, 30).length ? { types: strs(x.types, 8, 30) } : {}), ...(str(x.logic, 400) ? { logic: str(x.logic, 400) } : {}), ...(str(x.topic, 80) ? { topic: str(x.topic, 80) } : {}) } as OutlineSection;
  }).filter((x): x is OutlineSection => !!x).slice(0, 40);
  if (!sections.length || total < 1) return null;
  /* unique titles */
  const seen = new Map<string, number>();
  sections = sections.map((s) => { const k = s.title.toLowerCase(); const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return n > 1 ? { ...s, title: `${s.title} (${n})` } : s; });
  if (sections.length > total) sections = sections.slice(0, total);
  sections = apportion(sections, total);
  void req;
  const titles = new Set(sections.map((s) => s.title.toLowerCase()));
  return { sections, quotas: strs(o.quotas, 10, 200), randomize: strs(o.randomize, 20, 120).filter((t) => titles.has(t.toLowerCase())).map((t) => sections.find((s) => s.title.toLowerCase() === t.toLowerCase())!.title), logic: strs(o.logic, 30, 300), source: "model" };
}

/** counts made to add up to `total` exactly (largest remainder; every section ≥ 1) */
function apportion(sections: OutlineSection[], total: number): OutlineSection[] {
  const given = sections.reduce((n, s) => n + s.count, 0);
  const weights = sections.map((s) => (given > 0 ? Math.max(s.count, 0) : 1));
  const wsum = weights.reduce((a, b) => a + b, 0) || sections.length;
  const free = total - sections.length;            // each section gets 1 first
  const raw = weights.map((w) => (w / wsum) * free);
  const base = raw.map((x) => Math.floor(x));
  let left = free - base.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) base[order[k % order.length].i]++;
  return sections.map((s, i) => ({ ...s, count: base[i] + 1 }));
}

/** an outline without a model: screener, ~25-question sections, profile — or exam parts by topic */
export function fallbackOutline(total: number, req: Pick<GenerationRequest, "hints" | "assessment">): GenerationOutline {
  const complex: Complexity = req.hints.grids || req.hints.scripts ? "complex" : "simple";
  const sections: OutlineSection[] = [];
  if (req.assessment) {
    const parts = Math.max(1, Math.ceil(total / 25));
    for (let i = 0; i < parts; i++) sections.push({ title: `Part ${i + 1}`, count: 0, complexity: "simple", purpose: "Exam questions" });
    return { sections: apportionEven(sections, total), quotas: [], randomize: [], logic: [], source: "fallback" };
  }
  if (total <= 12) return { sections: [{ title: "Questions", count: total, complexity: complex }], quotas: [], randomize: [], logic: [], source: "fallback" };
  const screener = Math.min(10, Math.max(2, Math.round(total * 0.06)));
  const profile = Math.min(10, Math.max(2, Math.round(total * 0.05)));
  const middle = total - screener - profile;
  const parts = Math.max(1, Math.ceil(middle / 25));
  sections.push({ title: "Screening", count: screener, complexity: "simple", purpose: "Qualify the respondent", ...(req.hints.logic ? { logic: "screen out respondents who do not qualify" } : {}) });
  const mid: OutlineSection[] = [];
  for (let i = 0; i < parts; i++) mid.push({ title: `Section ${i + 1}`, count: 0, complexity: complex });
  sections.push(...apportionEven(mid, middle));
  sections.push({ title: "Profile", count: profile, complexity: "simple", purpose: "Demographics" });
  return { sections, quotas: req.hints.quotas ? ["the main screening characteristics"] : [], randomize: req.hints.randomization && parts >= 2 ? mid.map((s) => s.title) : [], logic: [], source: "fallback" };
}
function apportionEven(sections: OutlineSection[], total: number): OutlineSection[] {
  const n = sections.length;
  return sections.map((s, i) => ({ ...s, count: Math.floor(total / n) + (i < total % n ? 1 : 0) }));
}

/* ------------------------------------------------------------ the skeleton */

export interface SkeletonSlot {
  /** 1-based position in this generation */
  n: number;
  code: string;
  variable: string;
  /** the block's title (blocks are named, not id'd: titles survive replay) */
  block: string;
  /** index into the outline's sections */
  section: number;
  complexity: Complexity;
}
export interface GenerationSkeleton { blocks: { title: string; section: number }[]; slots: SkeletonSlot[] }

/**
 * Codes Q<n> continue after the survey's highest Q-number and skip anything already taken (a code, a variable or a
 * calculation of the same name). Block titles never collide with an existing block's.
 */
export function buildSkeleton(outline: GenerationOutline, survey: unknown, opts: { prefix?: string } = {}): GenerationSkeleton {
  const def = (survey && typeof survey === "object" ? survey : { questions: [], flow: [] }) as SurveyDefinition;
  const prefix = opts.prefix ?? "Q";
  const taken = new Set<string>();
  let top = 0;
  for (const q of def.questions ?? []) {
    taken.add(String(q.code).toUpperCase()); taken.add(String(q.variableName).toUpperCase());
    const m = new RegExp(`^${prefix}(\\d+)$`, "i").exec(String(q.code));
    if (m) top = Math.max(top, Number(m[1]));
  }
  for (const c of def.calculations ?? []) taken.add(c.targetVariable.toUpperCase());
  for (const e of (def as { embeddedData?: { name?: string }[] }).embeddedData ?? []) if (e?.name) taken.add(e.name.toUpperCase());
  const existingBlocks = new Set(listBlocks((def.flow ?? []) as unknown[]).map((b) => (b.title ?? "").toLowerCase()));
  const blocks = outline.sections.map((s, i) => {
    let title = s.title, k = 2;
    while (existingBlocks.has(title.toLowerCase())) title = `${s.title} (${k++})`;
    existingBlocks.add(title.toLowerCase());
    return { title, section: i };
  });
  const slots: SkeletonSlot[] = [];
  let next = top + 1;
  outline.sections.forEach((s, si) => {
    for (let k = 0; k < s.count; k++) {
      while (taken.has(`${prefix}${next}`.toUpperCase())) next++;
      const code = `${prefix}${next++}`;
      taken.add(code.toUpperCase());
      slots.push({ n: slots.length + 1, code, variable: code, block: blocks[si].title, section: si, complexity: s.complexity });
    }
  });
  return { blocks, slots };
}

/* ------------------------------------------------------------ batches */

export interface GenerationBatchPolicy {
  /** simple questions per model call (15–25) */
  simpleBatch: number;
  /** complex questions per model call (5–8: grids, logic, scripts) */
  complexBatch: number;
  /** a batch at least this full is closed at a section boundary rather than mixing two sections */
  closeAtSectionFill: number;
  /** existing questions per bulk-edit call */
  editBatch: number;
  /** existing questions per logic call */
  logicBatch: number;
}
export const DEFAULT_GENERATION_POLICY: GenerationBatchPolicy = { simpleBatch: 20, complexBatch: 6, closeAtSectionFill: 0.6, editBatch: 20, logicBatch: 40 };

/** the policy from env (TASK_BATCH_SIMPLE, TASK_BATCH_COMPLEX, TASK_BATCH_EDIT, TASK_BATCH_LOGIC), clamped to sane ranges */
export function generationPolicyFrom(env: Record<string, string | undefined> = {}): GenerationBatchPolicy {
  const num = (k: string, d: number, lo: number, hi: number) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
  return { ...DEFAULT_GENERATION_POLICY, simpleBatch: num("TASK_BATCH_SIMPLE", DEFAULT_GENERATION_POLICY.simpleBatch, 5, 40), complexBatch: num("TASK_BATCH_COMPLEX", DEFAULT_GENERATION_POLICY.complexBatch, 2, 12), editBatch: num("TASK_BATCH_EDIT", DEFAULT_GENERATION_POLICY.editBatch, 5, 40), logicBatch: num("TASK_BATCH_LOGIC", DEFAULT_GENERATION_POLICY.logicBatch, 10, 80) };
}

/** slots → batches: a batch holds 1 unit of work (a simple question is 1/simpleBatch, a complex one 1/complexBatch) */
export function planBatches(slots: readonly SkeletonSlot[], policy: GenerationBatchPolicy = DEFAULT_GENERATION_POLICY): SkeletonSlot[][] {
  const out: SkeletonSlot[][] = [];
  let cur: SkeletonSlot[] = [];
  let load = 0;
  const w = (s: SkeletonSlot) => (s.complexity === "complex" ? 1 / policy.complexBatch : 1 / policy.simpleBatch);
  for (const s of slots) {
    const prev = cur[cur.length - 1];
    const sectionChange = prev && prev.section !== s.section;
    if (cur.length && (load + w(s) > 1 + 1e-9 || (sectionChange && load >= policy.closeAtSectionFill) || (sectionChange && prev.complexity !== s.complexity))) {
      out.push(cur); cur = []; load = 0;
    }
    cur.push(s); load += w(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** halve a batch (output / context limit): null when it is one question already */
export function splitSlots<T>(slots: readonly T[]): [T[], T[]] | null {
  if (slots.length < 2) return null;
  const mid = Math.ceil(slots.length / 2);
  return [slots.slice(0, mid), slots.slice(mid)];
}

/** existing questions → bulk-edit batches (complex ones — grids, long option lists, logic — count more) */
export function planEditBatches(survey: unknown, codes: readonly string[], policy: GenerationBatchPolicy = DEFAULT_GENERATION_POLICY, kind: EditKind | null = null): string[][] {
  const def = survey as SurveyDefinition;
  const size = kind === "logic" ? policy.logicBatch : policy.editBatch;
  const out: string[][] = [];
  let cur: string[] = [];
  let load = 0;
  for (const c of codes) {
    const q = def.questions.find((x) => String(x.code) === c);
    const heavy = !!q && ((q.rows?.length ?? 0) > 0 || (q.options?.length ?? 0) > 12 || !!q.displayLogic);
    const wt = (heavy ? 2.5 : 1) / size;
    if (cur.length && load + wt > 1 + 1e-9) { out.push(cur); cur = []; load = 0; }
    cur.push(c); load += wt;
  }
  if (cur.length) out.push(cur);
  return out;
}

/* ------------------------------------------------------------ the model's actions, made to fit */

/** ops a content batch may write (the skeleton owns blocks; nothing is deleted or moved by a generation) */
const CONTENT_FORBIDDEN = new Set(["create_block", "delete_block", "rename_block", "delete_question", "move_question", "create_randomizer", "create_branch", "create_loop", "create_quota", "delete_quota", "set_research", "propose_analysis_plan", "set_analysis_plan", "set_assessment", "add_language", "translate_questions"]);

export interface NormalizedBatch {
  actions: SurveyAction[];
  /** the slots the model wrote a question for */
  filled: string[];
  /** the slots it did not */
  missing: string[];
  /** what was dropped or corrected, said */
  notes: string[];
  /** actions the gate refused at coercion (shape errors) */
  rejected: string[];
}

/**
 * The i-th create_question takes the i-th slot: code, variable and block are the skeleton's, whatever the model
 * wrote (a model that wrote its own code "Q5" for slot Q137 had its later references to "Q5" rewritten to Q137
 * within the batch). Blocks, deletions, moves, flow containers and quotas are not a content batch's to write.
 */
export function normalizeBatchActions(raw: unknown, slots: readonly SkeletonSlot[], opts: { forbidden?: Set<string>; allowExtra?: boolean; place?: (slot: SkeletonSlot, created: Set<string>) => { after?: string; before?: string } } = {}): NormalizedBatch {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { actions?: unknown }).actions) ? (raw as { actions: unknown[] }).actions : [];
  const co = coerceSurveyActions(list, 1200);
  const forbidden = opts.forbidden ?? CONTENT_FORBIDDEN;
  const notes: string[] = [];
  const rename = new Map<string, string>();
  const out: SurveyAction[] = [];
  const created = new Set<string>();
  let i = 0;
  for (const a of co.actions) {
    if (forbidden.has(a.op)) { notes.push(`dropped ${a.op}: not part of this batch`); continue; }
    if (a.op === "create_question") {
      const slot = slots[i];
      if (!slot) { if (!opts.allowExtra) { notes.push(`dropped an extra question (“${String(a.text).slice(0, 60)}”): the batch has ${slots.length} slots`); continue; } out.push(a); continue; }
      i++;
      for (const k of [a.code, a.variable, a.ref]) if (k && k.toUpperCase() !== slot.code.toUpperCase()) rename.set(k.toUpperCase(), slot.code);
      const { after: _after, before: _before, ref: _ref, ...rest } = a as SurveyAction & { after?: string; before?: string; ref?: string };
      void _after; void _before; void _ref;
      const where = opts.place ? opts.place(slot, created) : {};
      created.add(slot.code.toUpperCase());
      out.push({ ...rest, op: "create_question", code: slot.code, variable: slot.variable, block: slot.block, ...where } as SurveyAction);
      continue;
    }
    out.push(a);
  }
  /* references inside the batch to the model's own codes → the slots' */
  const fixed = rename.size ? out.map((a) => rewriteRefs(a, rename)) : out;
  return { actions: fixed, filled: slots.slice(0, i).map((s) => s.code), missing: slots.slice(i).map((s) => s.code), notes, rejected: co.rejected.map((r) => `action ${r.index + 1}: ${r.reason}`) };
}

const TARGET_KEYS = ["target", "from", "to", "after", "question", "itemsFrom", "over"];
/** codes in an action's targets and expressions, renamed (word-bounded, case-insensitive) */
function rewriteRefs(a: SurveyAction, rename: Map<string, string>): SurveyAction {
  const words = [...rename.keys()].sort((x, y) => y.length - x.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return a;
  const re = new RegExp(`(?<![\\w.])(${words.join("|")})(?![\\w])`, "gi");
  const swap = (s: string) => s.replace(re, (w) => rename.get(w.toUpperCase()) ?? w);
  const o = structuredClone(a) as Record<string, unknown>;
  for (const k of TARGET_KEYS) if (typeof o[k] === "string" && !(o.op === "create_question" && k === "after") && rename.has((o[k] as string).toUpperCase())) o[k] = rename.get((o[k] as string).toUpperCase());
  for (const k of ["expression", "when", "check"]) if (typeof o[k] === "string") o[k] = swap(o[k] as string);
  if (typeof o.text === "string" && o.op !== "create_question") o.text = swap(o.text as string);
  if (typeof o.text === "string" && o.op === "create_question") o.text = (o.text as string).replace(/\{\{\s*([A-Za-z_][\w]*)/g, (m0, n: string) => (rename.has(n.toUpperCase()) ? m0.replace(n, rename.get(n.toUpperCase())!) : m0));
  return o as unknown as SurveyAction;
}

/* ------------------------------------------------------------ checking a batch on the draft */

/** ids that do not depend on the clock: the same batch on the same draft mints the same ids */
export function seededIds(seed: string): (prefix: string) => string {
  const h = hashString(seed).toString(36);
  let n = 0;
  return (prefix) => `${prefix}_${h}${(n++).toString(36)}`;
}

export interface GenerationBatchCheck {
  ok: boolean;
  errors: string[];
  /** the structured form, for a targeted repair */
  problems: DeliverableError[];
  warnings: string[];
  /** the draft after the batch (unchanged when the batch did not pass the schema) */
  def: SurveyDefinition;
  /** actions the gate accepted (the batch's output); refused ones are listed in errors */
  accepted: SurveyAction[];
}

/**
 * The batch through the engine's own gate on the current draft — the same `applySurveyActions` the Studio's Apply
 * runs — then the deliverable check scoped to the batch's codes. A refused action, a slot with no question, a
 * question in the wrong block or under another code, a missing option list, a duplicate of an existing question,
 * a reference to a question that does not exist: each is an error naming its code.
 */
export function checkBatch(draft: unknown, actions: readonly SurveyAction[], slots: readonly { code: string; block?: string; variable?: string }[], opts: { seed?: string; touchOnly?: string[]; assessment?: DeliverableExtraChecks["assessment"]; requireAssessment?: boolean } = {}): GenerationBatchCheck {
  const base = draft as SurveyDefinition;
  const r = applySurveyActions(base, actions as SurveyAction[], { ids: seededIds(opts.seed ?? "batch"), now: "2026-01-01T00:00:00.000Z" });
  const errors: string[] = [...r.errors];
  const problems: DeliverableError[] = r.results.filter((x) => !x.ok).map((x) => ({ kind: refusalKind(x.error ?? ""), message: `${x.description}: ${x.error ?? "refused"}`, repair: "content" as const, ...(codeOfAction(actions[x.index]) ? { code: codeOfAction(actions[x.index])! } : {}) }));
  const def = r.def;
  for (const s of slots) {
    const q = def.questions.find((x) => String(x.code).toUpperCase() === s.code.toUpperCase());
    if (!q) { errors.push(`${s.code}: no question was written for this slot.`); problems.push({ kind: "missing_code", code: s.code, message: `${s.code} was not written.`, repair: "content" }); continue; }
    if (s.variable && q.variableName !== s.variable) { errors.push(`${s.code}: its variable is ${q.variableName}, not ${s.variable}.`); problems.push({ kind: "duplicate_variable", code: s.code, message: `${s.code}: variable ${q.variableName} instead of ${s.variable}.`, repair: "content" }); }
    if (s.block) {
      const b = listBlocks(def.flow as unknown[]).find((x) => x.pages.some((p) => p.node.questionIds.includes(q.id)));
      if (!b || (b.title ?? "") !== s.block) { errors.push(`${s.code}: it is in “${b?.title ?? "no block"}”, not “${s.block}”.`); problems.push({ kind: "unplaced", code: s.code, message: `${s.code} is not in block ${s.block}.`, repair: "content" }); }
    }
  }
  /* only the batch's own questions may change (a bulk edit names them; a content batch creates them) */
  if (opts.touchOnly) {
    const allowed = new Set(opts.touchOnly.map((c) => c.toUpperCase()));
    for (const res of r.results) {
      if (!res.ok) continue;
      const outside = res.touched.map((id) => def.questions.find((q) => q.id === id) ?? base.questions.find((q) => q.id === id)).filter((q): q is Question => !!q && !allowed.has(String(q.code).toUpperCase()));
      if (outside.length) { errors.push(`${res.description}: changes ${outside.map((q) => q.code).join(", ")}, outside this batch.`); problems.push({ kind: "logic", code: String(outside[0].code), message: `${res.description} touches ${outside.map((q) => q.code).join(", ")}, outside this batch.`, repair: "content" }); }
    }
  }
  const scope = [...new Set([...slots.map((s) => s.code), ...(opts.touchOnly ?? [])])];
  if (r.valid) {
    const rep = validateSurveyDeliverable(def, { scope, unique: true, logic: true, runtime: false, scripts: false, ...(opts.requireAssessment ? { assessment: { requireExplanations: true, requireTopics: true } } : {}) }, { ...(opts.assessment ? { assessment: opts.assessment } : {}) });
    /* survey-wide findings that the batch did not cause are not the batch's to repair */
    const before = validateSurveyDeliverable(base, { scope, unique: true, logic: true, runtime: false, scripts: false, noDuplicateText: false });
    const had = new Set(before.errors.map((e) => e.message));
    for (const e of rep.errors) if (!had.has(e.message) && !problems.some((p) => p.message === e.message)) { problems.push(e); errors.push(e.message); }
  }
  const accepted = r.results.filter((x) => x.ok).map((x) => actions[x.index]);
  return { ok: r.valid && errors.length === 0, errors: [...new Set(errors)], problems, warnings: r.warnings, def: r.valid ? def : base, accepted };
}

/** what kind of problem a gate refusal is (for the repair's wording and routing) */
function refusalKind(error: string): DeliverableError["kind"] {
  if (/needs options|needs rows|no options|options? .*(?:missing|empty)/i.test(error)) return "missing_options";
  if (/already used|already exists|is already/i.test(error)) return "duplicate_code";
  if (/quota/i.test(error)) return "quota";
  if (/needs (?:a )?text|no text/i.test(error)) return "missing_text";
  return "logic";
}

function codeOfAction(a: SurveyAction | undefined): string | undefined {
  if (!a) return undefined;
  const o = a as unknown as Record<string, unknown>;
  for (const k of ["code", "target", "from"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return undefined;
}

/* ------------------------------------------------------------ the planned order, restored */

/**
 * The skeleton's order, deterministically: within each block, the planned codes present are put back in plan order
 * with `move_question … after` (a repaired question is created at the end of its block; this puts Q9 back between
 * Q8 and Q10). Questions the plan did not write keep their places. No moves when the order is already right.
 */
export function orderMoves(survey: unknown, plannedInOrder: readonly string[]): SurveyAction[] {
  const def = survey as SurveyDefinition;
  const rank = new Map(plannedInOrder.map((c, i) => [c.toUpperCase(), i]));
  const moves: SurveyAction[] = [];
  for (const b of listBlocks((def.flow ?? []) as unknown[])) {
    const current = b.pages.flatMap((p) => p.node.questionIds).map((id) => def.questions.find((q) => q.id === id)?.code).filter((c): c is string => !!c && rank.has(String(c).toUpperCase())).map(String);
    const desired = [...current].sort((x, y) => rank.get(x.toUpperCase())! - rank.get(y.toUpperCase())!);
    if (current.every((c, i) => c === desired[i])) continue;
    /* keep the longest run already in order; move only the others, each next to a neighbour already in place */
    const stay = new Set(longestIncreasing(current.map((c) => rank.get(c.toUpperCase())!)).map((i) => current[i]));
    const placed = new Set(stay);
    desired.forEach((c, i) => {
      if (stay.has(c)) return;
      const pred = desired.slice(0, i).reverse().find((x) => placed.has(x));
      const succ = desired.slice(i + 1).find((x) => placed.has(x));
      if (pred) moves.push({ op: "move_question", target: c, after: pred } as SurveyAction);
      else if (succ) moves.push({ op: "move_question", target: c, before: succ } as SurveyAction);
      placed.add(c);
    });
  }
  return moves;
}

/** indexes of one longest strictly increasing subsequence */
function longestIncreasing(xs: number[]): number[] {
  const tails: number[] = [], prev: number[] = new Array(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[tails[m]] < xs[i]) lo = m + 1; else hi = m; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.unshift(k);
  return out;
}

/**
 * Where a planned question goes: right after the nearest planned question of its block that is KNOWN to exist when
 * the step's actions are replayed (`known`: the batch's dependencies' codes and what the batch created before it),
 * else right before the nearest known one after it, else at the end of its block.
 */
export function slotPlacement(code: string, blockPlan: readonly string[], known: Set<string>): { after?: string; before?: string } {
  const i = blockPlan.findIndex((c) => c.toUpperCase() === code.toUpperCase());
  if (i < 0) return {};
  const pred = blockPlan.slice(0, i).reverse().find((c) => known.has(c.toUpperCase()));
  if (pred) return { after: pred };
  const succ = blockPlan.slice(i + 1).find((c) => known.has(c.toUpperCase()));
  return succ ? { before: succ } : {};
}

/* ------------------------------------------------------------ what a step needs to see of the draft */

/** "Q12 [single] Which brands have you heard of?" — one line per question, for a prompt (codes the step may reference) */
export function questionDigest(survey: unknown, codes?: readonly string[], max = 120): string[] {
  const def = survey as SurveyDefinition;
  const want = codes ? new Set(codes.map((c) => c.toUpperCase())) : null;
  const out: string[] = [];
  for (const q of questionsInOrder(def)) {
    if (want && !want.has(String(q.code).toUpperCase())) continue;
    if (out.length >= max) break;
    const opts = (q.options ?? []).slice(0, 8).map((o) => `${o.code}=${String(o.label).replace(/<[^>]+>/g, "").slice(0, 30)}`).join("; ");
    out.push(`${q.code} [${q.type}] ${normPlain(q.text).slice(0, 110)}${opts ? ` {${opts}${(q.options?.length ?? 0) > 8 ? "; …" : ""}}` : ""}`);
  }
  return out;
}
const normPlain = (s: string | undefined) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** the codes a set of actions reads (conditions, skip targets) — for dependency checks of a logic step */
export function referencedCodes(survey: unknown, actions: readonly SurveyAction[]): string[] {
  const def = survey as SurveyDefinition;
  const codes = new Set<string>();
  const names = new Set(def.questions.flatMap((q) => [String(q.code).toUpperCase(), q.variableName.toUpperCase()]));
  for (const a of actions) {
    const o = a as unknown as Record<string, unknown>;
    for (const k of ["target", "from", "to"]) if (typeof o[k] === "string" && names.has((o[k] as string).toUpperCase())) codes.add((o[k] as string).toUpperCase());
    for (const k of ["expression", "when"]) {
      const v = o[k];
      if (typeof v === "string") for (const w of v.match(/[A-Za-z_][\w]*/g) ?? []) if (names.has(w.toUpperCase())) codes.add(w.toUpperCase());
      else if (v && typeof v === "object") { const into = new Set<string>(); try { conditionRefs(def, v as never, into); } catch { /* not a tree */ } for (const id of into) { const q = def.questions.find((x) => x.id === id); if (q) codes.add(String(q.code).toUpperCase()); } }
    }
  }
  return [...codes];
}

/** near-duplicate texts among a set of questions (normalised equality) — deterministic, no model */
export function duplicateTexts(survey: unknown, codes?: readonly string[]): [string, string][] {
  const def = survey as SurveyDefinition;
  const want = codes ? new Set(codes.map((c) => c.toUpperCase())) : null;
  const seen = new Map<string, string>();
  const out: [string, string][] = [];
  for (const q of questionsInOrder(def)) {
    if (!isRespondentQuestion(q)) continue;
    const t = normText(q.text);
    if (t.length <= 12) continue;
    const prev = seen.get(t);
    if (prev && (!want || want.has(String(q.code).toUpperCase()))) out.push([prev, String(q.code)]);
    else if (!prev) seen.set(t, String(q.code));
  }
  return out;
}
