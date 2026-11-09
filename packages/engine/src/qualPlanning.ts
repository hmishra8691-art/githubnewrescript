import type { AiInterviewFormat, QualResearchBrief } from "@rescript/schema";
import { fenceUntrusted, newFenceNonce, UNTRUSTED_DATA_RULE } from "./untrusted.js";

/**
 * RESEARCH CONTEXT → INTERVIEW PLAN (2026-11-08). The researcher explains WHAT they want to learn and WHY, in their
 * own words; the planner turns that into a structured study — objectives, themes with a depth each, questions and
 * probes, the format, the expected insights, what respondents are told — and asks about what is missing. The
 * researcher edits and APPROVES it; only then is it written as the guide (`create_qual_guide`) and the AI interview
 * settings (`configure_ai_interviews`) — the same two actions Intelligent Mode uses, through the same gate. No new
 * interview engine: the moderator that runs the result is the one in aiModerator.ts.
 *
 * LENGTH AND DEPTH ARE DERIVED, NOT FIXED (`interviewShape`): each theme's depth decides its questions, its follow-ups
 * and the minutes it needs (a deep theme ≈ a question with up to three probes; a brief one ≈ a question and at most one),
 * the format adjusts the pace (typing is slower than talking), and a plan that would tire respondents says so and
 * says what to cut — instead of a standard 20 questions or 30 minutes.
 *
 * Pure: the model call itself is the Studio route's (app/api/surveys/[id]/qual/plan); without a model the plan is
 * drafted by rules from the researcher's words (`draftPlanByRules`) and labelled as such.
 */
export type ThemeDepth = "deep" | "medium" | "brief";
export interface PlanQuestion { text: string; probes: string[]; conditional?: { ifMentions: string; ask: string }[] }
export interface PlanTheme { name: string; why?: string; depth: ThemeDepth; questions: PlanQuestion[] }
export interface InterviewPlan {
  title: string;
  objectives: string[];
  researchQuestions: string[];
  audience: string;
  themes: PlanTheme[];
  warmUp: string[];
  closing: string;
  format: AiInterviewFormat;
  formatWhy: string;
  expectedInsights: string[];
  /** to respondents */
  purpose: string;
  invitedBecause: string;
  clarifications: { question: string; why: string }[];
  source: "model" | "rules";
}
export interface PlanningInput { context: string; answers?: { question: string; answer: string }[]; format?: AiInterviewFormat | null }

/* ------------------------------------------------------------ length and depth */

/** minutes per primary question, with its follow-ups, when spoken */
const MIN_PER_QUESTION: Record<ThemeDepth, number> = { deep: 4.5, medium: 3, brief: 1.5 };
export const FOLLOW_UPS_FOR: Record<ThemeDepth, number> = { deep: 3, medium: 2, brief: 1 };
/** typing is slower than talking; a hybrid interview is somewhere between */
const PACE: Record<AiInterviewFormat, number> = { voice: 1, hybrid: 1.15, chat: 1.3 };

export interface InterviewShape {
  minutes: number;
  primaryQuestions: number;
  followUpsMax: number;
  perTheme: { name: string; depth: ThemeDepth; questions: number; followUps: number; minutes: number }[];
  /** deep themes (worth the most time) and brief ones (covered quickly) */
  deep: string[];
  brief: string[];
  warnings: string[];
}

export function interviewShape(plan: Pick<InterviewPlan, "themes" | "warmUp" | "format">): InterviewShape {
  const pace = PACE[plan.format] ?? 1;
  const perTheme = plan.themes.map((t) => {
    const q = t.questions.length;
    return { name: t.name, depth: t.depth, questions: q, followUps: q * FOLLOW_UPS_FOR[t.depth], minutes: Math.round(q * MIN_PER_QUESTION[t.depth] * pace * 10) / 10 };
  });
  const core = perTheme.reduce((a, t) => a + t.minutes, 0);
  const frame = 2 + plan.warmUp.length * 1.5 * pace + 1.5;
  const minutes = Math.max(5, Math.round(core + frame));
  const primaryQuestions = perTheme.reduce((a, t) => a + t.questions, 0) + plan.warmUp.length;
  const warnings: string[] = [];
  if (minutes > 60) warnings.push(`About ${minutes} minutes is too long for an AI interview people take on their own — split it into two studies, or make some themes brief.`);
  else if (minutes > 40) warnings.push(`About ${minutes} minutes: long for a self-paced interview; completion and answer depth usually drop after 30–40 minutes. Consider making ${perTheme.filter((t) => t.depth !== "deep").map((t) => t.name).slice(0, 2).join(" and ") || "some themes"} brief.`);
  if (primaryQuestions > 18) warnings.push(`${primaryQuestions} main questions is a lot to answer in depth — fewer, better questions with follow-ups usually give richer answers.`);
  if (perTheme.filter((t) => t.depth === "deep").length > 4) warnings.push("More than four deep themes: depth everywhere means depth nowhere — pick the ones that matter most.");
  if (!perTheme.length) warnings.push("No themes yet: say what you want to learn.");
  return { minutes, primaryQuestions, followUpsMax: perTheme.reduce((a, t) => a + t.followUps, 0), perTheme, deep: perTheme.filter((t) => t.depth === "deep").map((t) => t.name), brief: perTheme.filter((t) => t.depth === "brief").map((t) => t.name), warnings };
}

/* ------------------------------------------------------------ what is missing */

const AUDIENCE = /\b(?:customers?|users?|people|consumers?|patients?|parents?|students?|employees?|staff|buyers?|shoppers?|owners?|drivers?|travell?ers?|members?|subscribers?|respondents?|participants?|aged?|years? old|gen ?z|millennials?|households?|smb|businesses|managers?|doctors?|nurses?|teachers?|farmers?)\b|ग्राहक|लोग|उपयोगकर्ता/i;
const PURPOSE = /\b(?:why|because|so that|in order to|to (?:understand|learn|find out|decide|explore|test|validate|improve|design|launch|reduce|increase)|goal|aim|objective|decide|decision|hypothes[ie]s|problem|opportunity)\b|क्यों|ताकि|समझना/i;

/** the questions to ask the researcher before the plan is final — what a good brief has and this one lacks */
export function contextGaps(input: PlanningInput): { question: string; why: string }[] {
  const all = [input.context, ...(input.answers ?? []).map((a) => `${a.question} ${a.answer}`)].join("\n");
  const words = (all.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  const out: { question: string; why: string }[] = [];
  if (!AUDIENCE.test(all)) out.push({ question: "Who should we interview? (who they are, any must-have experience, who to exclude)", why: "the questions, the screener and the language depend on the respondents" });
  if (!PURPOSE.test(all)) out.push({ question: "What will you decide or do with what you learn?", why: "the decision behind the research sets what is worth probing deeply" });
  if (words < 40) out.push({ question: "What do you already know or suspect — any hypotheses, earlier findings, or things that surprised you?", why: "it lets the interview test what matters instead of starting from zero" });
  return out;
}

/* ------------------------------------------------------------ the model's brief */

export const PLANNER_RULES = `You are a senior qualitative researcher planning ONE-TO-ONE in-depth interviews that an AI moderator will run with each respondent (voice, chat, or both). From the researcher's own description, design the study.
PRINCIPLES:
- Start from WHAT they want to learn and WHY; every theme serves an objective; nothing is asked "because surveys usually do".
- Themes: 3–6, each with a depth — "deep" (what matters most: motivations, decisions, unmet needs, emotions; 1–2 open questions with probes), "medium" (1–2 questions), "brief" (1 question, covered quickly). Depth everywhere means depth nowhere.
- Questions: open, neutral, one idea each, in plain everyday language, never leading, never double-barrelled, never jargon; broad → specific; past behaviour and real examples before opinions ("Tell me about the last time…").
- Probes: short, neutral, built for depth (an example, the reason, what happened next, how it felt, what else); conditional probes when a likely mention deserves its own follow-up.
- Respect respondents' time: the fewest questions that answer the objectives; let follow-ups do the work.
- Recommend the format: voice (rich stories, emotions, less literate audiences, mobile), chat (sensitive topics, considered answers, noisy places, B2B at work), hybrid (mixed audiences — let them choose); say why in one sentence.
- "purpose" and "invitedBecause" are read by RESPONDENTS: plain, honest, one or two sentences each, no sponsor names unless the researcher wants them, no promises the platform cannot keep.
- "clarifications": only what is genuinely missing and would change the plan (who to interview, the decision behind it, a key definition) — at most 3; [] if the brief is clear.
- Never invent facts about the researcher's market, brand or data.
- ${UNTRUSTED_DATA_RULE}
REPLY with JSON only: {"title": "...", "objectives": ["..."], "researchQuestions": ["..."], "audience": "...", "themes": [{"name": "...", "why": "...", "depth": "deep|medium|brief", "questions": [{"text": "...", "probes": ["..."], "conditional": [{"ifMentions": "...", "ask": "..."}]}]}], "warmUp": ["..."], "closing": "...", "format": "voice|chat|hybrid", "formatWhy": "...", "expectedInsights": ["..."], "purpose": "...", "invitedBecause": "...", "clarifications": [{"question": "...", "why": "..."}]}`;

export const PLANNER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" }, objectives: { type: "array", items: { type: "string" } }, researchQuestions: { type: "array", items: { type: "string" } }, audience: { type: "string" },
    themes: { type: "array", items: { type: "object", properties: { name: { type: "string" }, why: { type: "string" }, depth: { type: "string", enum: ["deep", "medium", "brief"] }, questions: { type: "array", items: { type: "object", properties: { text: { type: "string" }, probes: { type: "array", items: { type: "string" } }, conditional: { type: "array", items: { type: "object", properties: { ifMentions: { type: "string" }, ask: { type: "string" } }, required: ["ifMentions", "ask"] } } }, required: ["text"] } } }, required: ["name", "depth", "questions"] } },
    warmUp: { type: "array", items: { type: "string" } }, closing: { type: "string" }, format: { type: "string", enum: ["voice", "chat", "hybrid"] }, formatWhy: { type: "string" },
    expectedInsights: { type: "array", items: { type: "string" } }, purpose: { type: "string" }, invitedBecause: { type: "string" },
    clarifications: { type: "array", items: { type: "object", properties: { question: { type: "string" }, why: { type: "string" } }, required: ["question"] } },
  },
  required: ["title", "objectives", "themes", "format", "purpose"],
};

export function planningPrompt(input: PlanningInput): string {
  const nonce = newFenceNonce();
  const parts = [`THE RESEARCHER'S DESCRIPTION:\n${fenceUntrusted(String(input.context ?? "").slice(0, 12_000), { source: "the researcher's description", nonce, maxChars: 12_000 })}`];
  const answered = (input.answers ?? []).filter((a) => a.answer.trim());
  if (answered.length) parts.push(`THEIR ANSWERS TO YOUR EARLIER QUESTIONS:\n${answered.map((a) => `Q: ${a.question}\nA: ${fenceUntrusted(a.answer.slice(0, 2000), { source: "the researcher's answer", nonce, maxChars: 2000 })}`).join("\n")}`);
  if (input.format) parts.push(`THE RESEARCHER WANTS THIS FORMAT: ${input.format} (keep it; still say what it suits)`);
  return parts.join("\n\n");
}

const s = (v: unknown, max = 600) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const arr = (v: unknown, max: number, len = 400) => (Array.isArray(v) ? v.map((x) => s(x, len)).filter(Boolean).slice(0, max) : []);

/** the model's JSON → a plan, every field checked and bounded; null when it holds no usable theme */
export function readPlan(raw: unknown, input: PlanningInput): InterviewPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const themes: PlanTheme[] = (Array.isArray(o.themes) ? o.themes : []).slice(0, 8).map((t) => {
    const x = (t ?? {}) as Record<string, unknown>;
    const depth = (["deep", "medium", "brief"] as const).includes(x.depth as ThemeDepth) ? x.depth as ThemeDepth : "medium";
    const questions = (Array.isArray(x.questions) ? x.questions : []).slice(0, 4).map((q) => {
      const y = (typeof q === "string" ? { text: q } : q ?? {}) as Record<string, unknown>;
      const conditional = (Array.isArray(y.conditional) ? y.conditional : []).map((c) => ({ ifMentions: s((c as Record<string, unknown>)?.ifMentions, 120), ask: s((c as Record<string, unknown>)?.ask, 300) })).filter((c) => c.ifMentions && c.ask).slice(0, 3);
      return { text: s(y.text, 400), probes: arr(y.probes, 4, 300), ...(conditional.length ? { conditional } : {}) };
    }).filter((q) => q.text);
    return { name: s(x.name, 80), ...(s(x.why, 300) ? { why: s(x.why, 300) } : {}), depth, questions };
  }).filter((t) => t.name && t.questions.length);
  if (!themes.length) return null;
  const format = input.format ?? ((["voice", "chat", "hybrid"] as const).includes(o.format as AiInterviewFormat) ? o.format as AiInterviewFormat : "hybrid");
  return {
    title: s(o.title, 120) || "Interviews",
    objectives: arr(o.objectives, 8),
    researchQuestions: arr(o.researchQuestions, 8),
    audience: s(o.audience, 400),
    themes,
    warmUp: arr(o.warmUp, 3, 300),
    closing: s(o.closing, 300) || "Is there anything else you would like to add that we have not talked about?",
    format,
    formatWhy: s(o.formatWhy, 300),
    expectedInsights: arr(o.expectedInsights, 8),
    purpose: s(o.purpose, 400),
    invitedBecause: s(o.invitedBecause, 300),
    clarifications: (Array.isArray(o.clarifications) ? o.clarifications : []).map((c) => ({ question: s((c as Record<string, unknown>)?.question, 300), why: s((c as Record<string, unknown>)?.why, 200) })).filter((c) => c.question).slice(0, 3),
    source: "model",
  };
}

/* ------------------------------------------------------------ without a model */

/**
 * A plan drafted by RULES from the researcher's words: each sentence or line naming something to learn becomes a
 * theme with an open question and neutral probes; words like "why", "motivation", "decide", "feel", "need" make it
 * deep, "awareness", "usage", "demographic" make it brief. Honest about being a starting point (`source: "rules"`).
 */
export function draftPlanByRules(input: PlanningInput): InterviewPlan {
  const text = [input.context, ...(input.answers ?? []).map((a) => a.answer)].join("\n");
  const sentences = text.split(/\n+|(?<=[.!?;।])\s+/).map((x) => x.trim()).filter((x) => x.length > 12);
  /* "we want to understand A, B, C and D" → four topics; any other sentence that names something to learn → one */
  const topics: { topic: string; sentence: string }[] = [];
  for (const sen of sentences) {
    const m = sen.match(/\b(?:understand|learn|explore|know|find out|investigate|uncover|discover)\s+(.+)$/i);
    if (m) {
      const tail = m[1].replace(/\b(?:so that|in order to|to decide|we will|which will)\b.*$/i, "").replace(/[.?!]+$/, "");
      for (const part of tail.split(/,\s*(?:and\s+)?|\s+and\s+(?=(?:how|why|what|whether|which|where|when|who)\b)/i)) if (part.trim().length > 3) topics.push({ topic: part.trim(), sentence: sen });
    } else if (/\b(?:motivat|percept|experience|behaviou?r|decision|needs?|barrier|attitude|feel|usage|journey|choose|switch|purchase)\b/i.test(sen) && !/\bwe (?:are|will)\b/i.test(sen)) topics.push({ topic: sen.replace(/[.?!]+$/, ""), sentence: sen });
  }
  /* to the respondent: "they / their / them" are "you / your / you" */
  const toYou = (x: string) => x.replace(/\bthey\b/gi, "you").replace(/\btheir\b/gi, "your").replace(/\bthem\b/gi, "you").replace(/\bthemselves\b/gi, "yourself").replace(/\bpeople\b/gi, "you");
  const nameOf = (x: string) => { const n = x.replace(/^(?:the|our)\s+/i, "").slice(0, 60); return n.charAt(0).toUpperCase() + n.slice(1); };
  const seen = new Set<string>();
  const themes: PlanTheme[] = [];
  for (const { topic, sentence } of topics) {
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const depth: ThemeDepth = /\b(?:why|motivat|decision|decide|feel|emotion|need|barrier|unmet|trust|choose|switch)/i.test(topic) ? "deep" : /\b(?:aware|usage|use|frequency|demograph|background|habit)/i.test(topic) ? "brief" : "medium";
    const t = toYou(topic).replace(/[.?!]+$/, "");
    const text = /^(?:why|how|what|whether|which|where|when|who)\b/i.test(t) ? `I'd like to understand ${t}. Could you tell me about your own experience of that?` : `Thinking about ${t}, could you tell me about your own experience?`;
    themes.push({ name: nameOf(topic), depth, why: sentence.slice(0, 200), questions: [{ text, probes: depth === "brief" ? [] : ["Can you give me a recent example?", "Why was that important to you?"] }] });
    if (themes.length >= 6) break;
  }
  if (!themes.length) themes.push({ name: "Experience", depth: "deep", questions: [{ text: "Tell me about your experience with this, from the beginning.", probes: ["Can you give me a recent example?", "What mattered most to you, and why?"] }] });
  return {
    title: themes.slice(0, 2).map((t, i) => (i ? t.name.charAt(0).toLowerCase() + t.name.slice(1) : t.name)).join(" and ").slice(0, 80) || "Interviews",
    objectives: themes.map((t) => `Understand ${t.name.toLowerCase()}`),
    researchQuestions: [],
    audience: (text.match(AUDIENCE) ? text.split(/\n|(?<=[.!?])\s+/).find((l) => AUDIENCE.test(l)) ?? "" : "").slice(0, 300),
    themes,
    warmUp: ["To start, could you tell me a little about yourself and how this fits into your everyday life?"],
    closing: "Is there anything else you would like to add that we have not talked about?",
    format: input.format ?? "hybrid",
    formatWhy: input.format ? "" : "Hybrid lets each respondent speak or type — the safest choice until you know your audience.",
    expectedInsights: themes.map((t) => `What drives ${t.name.toLowerCase()}, in respondents' own words`),
    purpose: "We are talking with people to understand their experiences and views, so that we can improve what we offer.",
    invitedBecause: "You were invited because your experience is relevant to this research.",
    clarifications: contextGaps(input),
    source: "rules",
  };
}

/* ------------------------------------------------------------ the approved plan → the study */

/**
 * The two actions that write the approved plan (applied through applySurveyActions — the same gate, preview and undo
 * as Intelligent Mode): the guide, then the AI interview settings with each theme's depth as its questions' probing.
 * The minutes are the researcher's (they may have adjusted the recommendation).
 */
/** the default words, stating only what the platform does (a recording is stored privately and only with the respondent's tick) */
export const DEFAULT_CONSENT = "Taking part is voluntary. You can skip any question or stop at any time. Your answers are used only for this research.";
export const DEFAULT_RECORDING_DISCLOSURE = "If you tick the recording box, your voice (or video) is stored privately for the research team. If you do not, only the words of your answers are kept.";

export function planToActions(plan: InterviewPlan, o: { minutes: number; consentStatement?: string; recordingDisclosure?: string }): Record<string, unknown>[] {
  const sections: Record<string, unknown>[] = [
    { title: "Introduction", kind: "opening", minutes: 2, script: `${plan.purpose} There are no right or wrong answers, and you can stop at any time.`.trim() },
    ...(plan.warmUp.length ? [{ title: "Warm-up", kind: "warm_up", minutes: Math.max(1, Math.round(plan.warmUp.length * 1.5)), questions: plan.warmUp }] : []),
    ...plan.themes.map((t) => ({ title: t.name, kind: "main", minutes: Math.max(1, Math.round(t.questions.length * MIN_PER_QUESTION[t.depth])), questions: t.questions.map((q) => ({ text: q.text, probes: q.probes, ...(q.conditional?.length ? { conditionalProbes: q.conditional } : {}) })) })),
    { title: "Close", kind: "closing", minutes: 2, questions: [plan.closing] },
  ];
  const consent = o.consentStatement?.trim() || DEFAULT_CONSENT;
  const recording = plan.format === "chat" ? "" : o.recordingDisclosure?.trim() || DEFAULT_RECORDING_DISCLOSURE;
  return [
    { op: "create_qual_guide", kind: "interview", replace: true, title: plan.title, durationMinutes: o.minutes, objectives: plan.objectives, consent: { statement: consent, ...(recording ? { recordingDisclosure: recording } : {}) }, sections },
    { op: "configure_ai_interviews", enabled: true, format: plan.format, targetMinutes: o.minutes, defaultProbing: "light", objectives: plan.objectives, resetProbing: true },
  ];
}

/** each question's probing from its theme's depth, once the guide exists (its question ids are known only then) */
export function probingFromPlan(plan: InterviewPlan, guideQuestions: { id: string; text: string }[]): { question: string; depth: "none" | "light" | "deep"; maxFollowUps: number }[] {
  const out: { question: string; depth: "none" | "light" | "deep"; maxFollowUps: number }[] = [];
  for (const t of plan.themes) for (const q of t.questions) {
    const g = guideQuestions.find((x) => x.text.trim() === q.text.trim());
    if (g) out.push({ question: g.id, depth: t.depth === "deep" ? "deep" : "light", maxFollowUps: FOLLOW_UPS_FOR[t.depth] });
  }
  return out;
}

/** the brief kept with the guide: the researcher's words, the respondent-facing purpose, the themes and the approval */
export function briefFromPlan(plan: InterviewPlan, input: PlanningInput, o: { minutes: number; approvedAt: string }): QualResearchBrief {
  return {
    context: [input.context, ...(input.answers ?? []).filter((a) => a.answer.trim()).map((a) => `${a.question} — ${a.answer}`)].join("\n").slice(0, 12_000),
    ...(plan.audience ? { audience: plan.audience } : {}),
    ...(plan.purpose ? { purpose: plan.purpose } : {}),
    ...(plan.invitedBecause ? { invitedBecause: plan.invitedBecause } : {}),
    themes: plan.themes.map((t) => ({ name: t.name, depth: t.depth, ...(t.why ? { why: t.why } : {}) })),
    expectedInsights: plan.expectedInsights,
    recommendedMinutes: o.minutes,
    approvedAt: o.approvedAt,
  };
}
