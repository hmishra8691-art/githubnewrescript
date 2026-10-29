/**
 * PLAN FIRST OR ONE TURN? (durable tasks, 2026-10-25 — docs/DURABLE-TASKS-2026-10-25.md)
 *
 * A deterministic reading of how BIG the answer to a request will be — read before any model is called, next to
 * `requestScope` (what the request is about). The scope never looked at the size of the OUTPUT: a 650-character
 * Hindi brief asking for "100 questions, General Studies" was not a long brief (`isLongBrief` wants ≥ 1,500
 * characters or four list lines), so it ran as one generation call and hit the route's 165 s clock twice; "translate
 * the survey to Urdu" on a 78-question survey and "show for every question what was correct…" on 104 questions were
 * one call each and died the same way.
 *
 * The estimate predicts the units of work (questions to write, translate, explain or rework), the output tokens and
 * the number of steps, from the MESSAGE and the CURRENT SURVEY:
 *
 *   requested counts        "100 questions", "200–300 प्रश्न", "५० सवाल", "a 40-item quiz"
 *   whole-survey operations "all / every / each question", "सारे / सभी / हर प्रश्न", "تمام سوالات", "the whole survey"
 *                           × the survey's question count (translate, explain, answer key, reword, review each …)
 *   translation             "translate the survey to Urdu" × question count (or the range it names: "first 10")
 *   per-question extras     explanations, answer keys, correct answers, scoring per question
 *   multi-deliverable       a survey AND an answer key AND scoring AND a report AND a deck …
 *   long briefs             `isLongBrief` on a survey not yet built
 *
 * Non-trivial → a durable task (planned, persisted, executed in small steps). Trivial — one edit, a question about the
 * survey, a small proposal — stays on the single-turn path, unchanged. Pure; no I/O; cheap.
 */
import { isLongBrief, scopeCategories } from "./requestScope.js";

export type TaskEstimateKind = "generate" | "translate" | "per_question" | "rework_all" | "brief" | "multi" | "single";

export interface TaskEstimate {
  /** true: plan first and run as a durable task */
  task: boolean;
  kind: TaskEstimateKind;
  /** the machine-readable reason ("requested_count", "translate_survey", "per_question", "long_brief", "multi_deliverable", "forced", "small") */
  reason: string;
  /** the reasons, in words, for the log and the panel */
  reasons: string[];
  /** predicted units of work (questions written / translated / explained) */
  units: number;
  /** predicted output tokens of the whole answer */
  outputTokens: number;
  /** predicted number of steps (batches + plan/validate/report) */
  steps: number;
  /** a count the request named ("100 questions") */
  requestedCount?: number;
  /** a target language the request named */
  language?: string;
  /** a range the request limited itself to ("the first 10 questions") */
  range?: { from: number; to: number };
  /** the deliverables the request named */
  deliverables: string[];
  forced?: boolean;
}

export interface TaskEstimateInput {
  message: string;
  /** the survey as it is now (questions with their text/options are read for size) */
  survey?: { questions?: readonly unknown[] } | null;
  /** an explicit "Plan first" from the researcher: always a task */
  force?: boolean;
}

/** one call answers comfortably below this many output tokens inside the route's clock (~80 tok/s × ~75 s) */
export const SINGLE_TURN_OUTPUT_TOKENS = 6000;
/** a count of new questions at or above this is a task whatever else the message says */
export const TASK_MIN_QUESTIONS = 30;
/** translating this many questions or more is a task (inventory → batches → completeness) */
export const TASK_MIN_TRANSLATE = 10;
/** per-question work (explanations, answer keys, rewording) on this many questions or more is a task */
export const TASK_MIN_PER_QUESTION = 15;

const DEV_DIGITS = "०१२३४५६७८९";
const URDU_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
function asciiDigits(s: string): string {
  return s.replace(/[०-९۰-۹٠-٩]/g, (d) => String(Math.max(DEV_DIGITS.indexOf(d), URDU_DIGITS.indexOf(d), ARABIC_DIGITS.indexOf(d))));
}

const QWORD = "(?:questions?|qs|items?|mcqs?|multiple[- ]choice questions?|statements?|prashn|sawaa?l|प्रश्नों|प्रश्न|सवालों|सवाल|क्वेश्चन्स|क्वेश्चन|क्वेश्चंस|سوالات|سوالوں|سوال)";
const COUNT_RE = new RegExp(`(\\d{1,4})(?:\\s*(?:-|–|to|से|سے)\\s*(\\d{1,4}))?[\\s-]*\\+?[\\s-]*(?:[a-z\\u0900-\\u097f\\u0600-\\u06ff-]+\\s+){0,3}?${QWORD}(?![a-z])`, "giu");
const WORD_NUM: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, "a hundred": 100, "one hundred": 100, "two hundred": 200, "three hundred": 300, sau: 100, "सौ": 100, "पचास": 50 };
const WORD_COUNT_RE = new RegExp(`\\b(${Object.keys(WORD_NUM).filter((k) => /^[a-z ]+$/.test(k)).sort((a, b) => b.length - a.length).join("|")})\\s+(?:[a-z-]+\\s+){0,3}?${QWORD}|(सौ|पचास)\\s+${QWORD}`, "iu");

/** the number of questions/items a request asks for, if it names one (the largest of a range) */
export function requestedQuestionCount(message: string): number | undefined {
  const t = asciiDigits(message);
  let best: number | undefined;
  for (const m of t.matchAll(COUNT_RE)) {
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : 0;
    /* "Q1", "question 5", years and percentages are not counts */
    const before = t.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0);
    if (/q$/i.test(before)) continue;
    const n = Math.max(a, b);
    if (n >= 2 && n <= 2000 && (best == null || n > best)) best = n;
  }
  const w = WORD_COUNT_RE.exec(t);
  if (w) { const n = WORD_NUM[(w[1] ?? w[2] ?? "").toLowerCase()]; if (n && (best == null || n > best)) best = n; }
  return best;
}

const LANGS: [string, RegExp][] = [
  ["Urdu", /\burdu\b|उर्दू|اردو/i], ["Hindi", /\bhindi\b|हिंदी|हिन्दी/i], ["Bengali", /\bbengali\b|\bbangla\b|बंगाली|বাংলা/i], ["Tamil", /\btamil\b|तमिल/i],
  ["Telugu", /\btelugu\b|तेलुगु/i], ["Marathi", /\bmarathi\b|मराठी/i], ["Gujarati", /\bgujarati\b|गुजराती/i], ["Punjabi", /\bpunjabi\b|पंजाबी/i],
  ["Spanish", /\bspanish\b|español/i], ["French", /\bfrench\b|français/i], ["German", /\bgerman\b|deutsch/i], ["Arabic", /\barabic\b|अरबी|عربی|العربية/i],
  ["Chinese", /\bchinese\b|mandarin|中文/i], ["Japanese", /\bjapanese\b|日本語/i], ["Portuguese", /\bportuguese\b/i], ["Italian", /\bitalian\b/i], ["English", /\benglish\b|अंग्रेज़ी|अंग्रेजी|انگریزی/i],
];
const TRANSLATE = /\btranslat\w*|\blocali[sz]\w*|अनुवाद|ट्रांसलेट|ट्रांस्लेट|ट्रान्सलेट|ترجمہ|ترجمه|ٹرانسلیٹ|\b(?:anuvad|tarjuma)\b/i;
const WHOLE = /\b(?:all|every|each|entire|whole|complete|full)\b(?:\s+(?:the|of|of the|my|this))?\s*(?:\w+\s+)?(?:questions?|items?|survey|questionnaire|quiz|test|exam|paper)\b|\b(?:the|my|this)\s+(?:survey|questionnaire|quiz|test|exam|paper)\b|सारे|सभी|सब\s|हर\s|पूरे|पूरा|सर्वे\s*(?:को|का)|तमाम|تمام|ہر\s|پورے|پورا|\bsaare\b|\bsabhi\b|\bpoore?\b|\bhar\s+(?:question|prashn|sawal)/i;
const PER_Q = /\bexplanations?\b|\bexplain\b|\bsolutions?\b|\banswer[- ]?keys?\b|\bcorrect (?:answer|option)s?\b|\bwhat (?:was|is) (?:correct|right)\b|\bwhat i (?:selected|chose|answered)\b|\brationale\b|\bfeedback\b|\bscor(?:e|es|ing) (?:each|every|per)\b|व्याख्या|समझाओ|समझाइए|स्पष्टीकरण|सही उत्तर|सही जवाब|उत्तर कुंजी|आंसर की|وضاحت|صحیح جواب/i;
const REWORK = /\b(?:rewrite|reword|rephrase|simplify|shorten|improve|review|check|convert|recode|renumber|re-?code|add (?:an? )?(?:explanation|hint|image|instruction|validation|code|variable)s?)\b|दोबारा लिखो|सुधारो|बदलो/i;
const GEN = /\b(?:create|build|design|generate|draft|make|write|prepare|develop|add|banao|bana do|banana)\b|बनाओ|बना\s*दो|बनाइए|बनाएं|बनाना|तैयार|تیار|بناؤ|بنا\s*دو/i;
const DELIVERABLES: [string, RegExp][] = [
  ["survey", /\b(?:survey|questionnaire|quiz|test|exam|mcqs?|question paper)\b|सर्वे|प्रश्न ?पत्र|क्विज़|टेस्ट|परीक्षा/i],
  ["answer_key", /\banswer[- ]?keys?\b|\bcorrect answers?\b|उत्तर कुंजी|सही उत्तर/i],
  ["scoring", /\bscor(?:e|es|ing)\b|\bmarks?\b|\bgrading\b|अंक|स्कोर/i],
  ["explanations", /\bexplanations?\b|\bexplain\b|\bsolutions?\b|व्याख्या|स्पष्टीकरण/i],
  ["report", /\breports?\b|\bsummary report\b|\btopic[- ]wise\b|रिपोर्ट/i],
  ["deck", /\b(?:deck|slides?|presentation|pptx|powerpoint)\b/i],
  ["document", /\bword (?:doc|document|file)\b|\bdocx\b/i],
  ["translation", TRANSLATE],
  ["analysis_plan", /\banalysis (?:plan|framework)\b|\bcrosstabs?\b|\bbanners?\b/i],
  ["conjoint_maxdiff", /\bmax[- ]?diff\b|\bconjoint\b|\bcbc\b|\bbest[- ]worst\b/i],
  ["quotas_logic", /\bquotas?\b|\bskip logic\b|\bbranching\b|\bpiping\b|\brandomi[sz]\w*\b/i],
];

/** "the first 10 questions", "Q1 to Q20", "questions 5-15" */
function rangeOf(t: string): { from: number; to: number } | undefined {
  const a = /\b(?:first|top)\s+(\d{1,4})\s+(?:questions?|items?)\b|पहले\s+(\d{1,4})\s+(?:प्रश्न|सवाल)/i.exec(t);
  if (a) { const n = Number(a[1] ?? a[2]); return { from: 1, to: n }; }
  const b = /\bq(?:uestions?)?\s*(\d{1,4})\s*(?:-|–|to|through|से)\s*q?(\d{1,4})\b/i.exec(t);
  if (b) { const x = Number(b[1]), y = Number(b[2]); if (y >= x) return { from: x, to: y }; }
  return undefined;
}

/** a rough size of a question's own words (text + options), in characters — what a translation must write back */
function questionChars(q: unknown): number {
  if (!q || typeof q !== "object") return 80;
  const o = q as { text?: unknown; options?: unknown; rows?: unknown; columns?: unknown };
  let n = typeof o.text === "string" ? o.text.length : 60;
  for (const list of [o.options, o.rows, o.columns]) if (Array.isArray(list)) for (const x of list) n += typeof (x as { label?: unknown })?.label === "string" ? ((x as { label: string }).label.length + 12) : 12;
  return n;
}

const tokensOfChars = (c: number) => Math.ceil(c / 3.2);

/**
 * The estimate. `task` is true when the predicted answer does not fit one comfortable call or the request is a
 * whole-survey operation of real size; everything else stays single-turn.
 */
export function estimateTaskSize(input: TaskEstimateInput): TaskEstimate {
  const message = String(input.message ?? "").normalize("NFC").trim();
  const t = asciiDigits(message);
  const questions = Array.isArray(input.survey?.questions) ? input.survey!.questions! : [];
  const n = questions.length;
  const deliverables = DELIVERABLES.filter(([, re]) => re.test(t)).map(([d]) => d);
  const language = LANGS.find(([, re]) => re.test(t))?.[0];
  const range = rangeOf(t);
  const requested = requestedQuestionCount(t);
  const reasons: string[] = [];
  const out = (o: Omit<TaskEstimate, "deliverables" | "reasons"> & { reasons?: string[] }): TaskEstimate => ({ deliverables, ...o, reasons: o.reasons ?? reasons, ...(requested ? { requestedCount: requested } : {}), ...(language ? { language } : {}), ...(range ? { range } : {}) });
  const extrasPerQ = (deliverables.includes("answer_key") ? 40 : 0) + (deliverables.includes("explanations") ? 120 : 0) + (deliverables.includes("scoring") ? 15 : 0);

  if (!message) return out({ task: false, kind: "single", reason: "empty", units: 0, outputTokens: 0, steps: 0 });

  /* 1. translation of the survey (or a range of it) */
  if (TRANSLATE.test(t) && (language || /\blanguages?\b|भाषा|زبان/i.test(t))) {
    const named = /\bq\d+\b/i.test(t) && !range && !WHOLE.test(t);
    const scoped = range ? Math.max(0, Math.min(n || range.to, range.to) - range.from + 1) : named ? (t.match(/\bq\d+\b/gi) ?? []).length : n;
    const chars = (range ? questions.slice(range.from - 1, range.to) : named ? [] : questions).reduce<number>((s, q) => s + questionChars(q), 0) || scoped * 140;
    const outputTokens = Math.ceil(tokensOfChars(chars) * 1.6) + 200;
    const units = scoped;
    const steps = Math.max(1, Math.ceil(units / 15)) + 2;
    const task = !!input.force || units >= TASK_MIN_TRANSLATE || outputTokens > SINGLE_TURN_OUTPUT_TOKENS;
    reasons.push(`translate ${units} question${units === 1 ? "" : "s"}${language ? ` into ${language}` : ""} (~${outputTokens.toLocaleString("en")} output tokens)`);
    return out({ task, kind: task ? "translate" : "single", reason: input.force ? "forced" : task ? "translate_survey" : "small", units, outputTokens, steps: task ? steps : 1, ...(input.force ? { forced: true } : {}) });
  }

  /* 2. per-question work on the whole survey (explanations, correct answers, rework every question) */
  const whole = WHOLE.test(t);
  if (n > 0 && whole && (PER_Q.test(t) || REWORK.test(t)) && !(requested && GEN.test(t) && requested > 0 && !PER_Q.test(t))) {
    const units = range ? Math.max(0, Math.min(n, range.to) - range.from + 1) : n;
    const per = PER_Q.test(t) ? 160 + extrasPerQ : 110;
    const outputTokens = units * per + 300;
    const task = !!input.force || units >= TASK_MIN_PER_QUESTION || outputTokens > SINGLE_TURN_OUTPUT_TOKENS;
    reasons.push(`${PER_Q.test(t) ? "per-question explanations/answers" : "rework"} for ${units} questions (~${outputTokens.toLocaleString("en")} output tokens)`);
    return out({ task, kind: task ? (PER_Q.test(t) ? "per_question" : "rework_all") : "single", reason: input.force ? "forced" : task ? "per_question" : "small", units, outputTokens, steps: task ? Math.ceil(units / 10) + 2 : 1, ...(input.force ? { forced: true } : {}) });
  }

  /* 3. a requested count of new questions */
  if (requested && (GEN.test(t) || n < 3 || deliverables.includes("survey"))) {
    const per = 190 + extrasPerQ;
    const outputTokens = requested * per + 800;
    const multi = deliverables.filter((d) => d !== "survey").length;
    const task = !!input.force || requested >= TASK_MIN_QUESTIONS || outputTokens > SINGLE_TURN_OUTPUT_TOKENS || (requested >= 15 && multi >= 2);
    reasons.push(`${requested} new questions${multi ? ` with ${deliverables.filter((d) => d !== "survey").join(", ")}` : ""} (~${outputTokens.toLocaleString("en")} output tokens)`);
    const batch = requested > 150 ? 15 : requested > 60 ? 12 : 10;
    return out({ task, kind: task ? "generate" : "single", reason: input.force ? "forced" : task ? "requested_count" : "small", units: requested, outputTokens, steps: task ? Math.ceil(requested / batch) + 2 + multi : 1, ...(input.force ? { forced: true } : {}) });
  }

  /* 4. a pasted brief on a survey not yet built */
  if (isLongBrief(message) && n < 3) {
    const units = requested ?? 25;
    const outputTokens = units * 200 + 1500;
    reasons.push(`a long brief (${message.length.toLocaleString("en")} characters) to design from`);
    return out({ task: true, kind: "brief", reason: input.force ? "forced" : "long_brief", units, outputTokens, steps: Math.ceil(units / 10) + 3, ...(input.force ? { forced: true } : {}) });
  }

  /* 5. several heavy deliverables in one request */
  const heavy = deliverables.filter((d) => d !== "survey" && d !== "quotas_logic");
  if (heavy.length >= 3 && (GEN.test(t) || n >= 10) && scopeCategories(t).length >= 2) {
    const units = Math.max(n, requested ?? 0, 10);
    const outputTokens = units * 150 + heavy.length * 1500;
    reasons.push(`several deliverables: ${heavy.join(", ")}`);
    return out({ task: true, kind: "multi", reason: input.force ? "forced" : "multi_deliverable", units, outputTokens, steps: heavy.length + Math.ceil(units / 12) + 1, ...(input.force ? { forced: true } : {}) });
  }

  if (input.force) {
    reasons.push("Plan first was asked for");
    return out({ task: true, kind: "multi", reason: "forced", units: Math.max(1, requested ?? 1), outputTokens: 2000, steps: 2, forced: true });
  }
  return out({ task: false, kind: "single", reason: "small", units: requested ?? 1, outputTokens: 1500, steps: 1, reasons: ["a single edit, question or small proposal"] });
}

/** "Plan first: …", "/plan …", "पहले प्लान बनाओ" — the researcher's explicit request to plan before building */
export function saysPlanFirst(message: string): boolean {
  return /^\s*(?:\/plan\b|plan first\b|plan it first\b|make a plan first\b)|पहले\s*(?:प्लान|योजना)/i.test(message);
}
