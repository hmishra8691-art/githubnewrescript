/**
 * QUALITATIVE SYNTHESIS IN WORDS (2026-10-22) — the sentences a researcher says
 * about their qualitative DATA (not the survey): "summarise the themes", "what
 * are the key insights for objective 2", "compare Mumbai vs Delhi participants",
 * "make a highlight reel of pricing complaints", "set up double coding with 20%
 * overlap", "what did Gen Z say about price?", "code new interviews
 * automatically", "run a group session from the guide".
 *
 * The engine only CLASSIFIES (deterministic, no model): the Studio reads the
 * request into a preview card — what would be done, how many model calls it
 * costs — and does it only when the researcher approves (the same preview →
 * Apply gate as every Intelligent Mode change). A sentence about the survey
 * itself ("add a question about price", "compare Q3 by Q5") is not matched.
 * Pure.
 */

import { interpretLiveSchedule, describeLiveSchedule, type LiveScheduleRequest } from "./liveSchedule.js";

export type QualRequest =
  | { op: "summarise_themes"; text: string; theme?: string }
  | { op: "insights"; text: string; objective?: number }
  | { op: "compare_groups"; text: string; a: string; b: string }
  | { op: "highlight_reel"; text: string; topic: string }
  | { op: "double_coding"; text: string; overlapPct: number; coder: "ai" | "colleague" }
  | { op: "ask"; text: string; question: string }
  | { op: "auto_code"; text: string; enabled: boolean }
  | { op: "group_session"; text: string; mode: "moderated" | "autonomous"; title?: string }
  /* G2 2026-10-22: live human-moderated sessions (focus groups / IDIs) scheduled in words — liveSchedule.ts */
  | LiveScheduleRequest;

/** words that place a sentence in the qualitative data, not the questionnaire */
/* not "findings" / "insights" alone: "summarise the findings" is the quantitative findings copilot's */
const QUAL = /\b(?:themes?|codes?|coding|codebook|transcripts?|interviews?|idis?|focus\s+groups?|participants?|interviewees?|respondents?\s+said|quotes?|verbatims?|excerpts?|qual(?:itative)?|group\s+sessions?)\b/i;
/** words that say the sentence is about the questionnaire */
const SURVEY_EDIT = /\b(?:add|insert|create|delete|remove|rename|move)\s+(?:a\s+|the\s+|an\s+)?(?:new\s+)?(?:question|block|option|page|quota|skip|logic|variable)\b|\bQ\d+\b/i;

const clean = (s: string) => s.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

export function interpretQualRequest(raw: string): QualRequest | null {
  const text = clean(String(raw ?? ""));
  if (!text || text.length > 400 || /\n/.test(raw)) return null;
  const t = text.toLowerCase();
  /* G2 2026-10-22: "schedule two focus groups of 6 next Tuesday 6 pm IST …" — before the survey-edit guard ("create" is a scheduling verb here) */
  const live = interpretLiveSchedule(raw);
  if (live) return live;
  if (SURVEY_EDIT.test(text)) return null;
  let m: RegExpExecArray | null;

  /* double-coding — "set up double coding with 20% overlap", "blind double-code 15 % of the transcripts with the AI" */
  if (/\b(?:double[\s-]?cod(?:e|ing)|second\s+coder|inter[\s-]?coder\s+(?:check|reliability)|intercoder\s+(?:check|reliability)|blind\s+cod(?:e|ing))\b/i.test(text)) {
    m = /(\d{1,3})\s*(?:%|percent|per\s*cent)/i.exec(text);
    const pct = m ? Math.max(1, Math.min(100, Number(m[1]))) : 20;
    const coder = /\b(?:colleague|another\s+(?:person|researcher|coder)|two\s+(?:people|researchers|humans)|human)\b/i.test(text) && !/\b(?:ai|the\s+model)\b/i.test(text) ? "colleague" : "ai";
    return { op: "double_coding", text, overlapPct: pct, coder };
  }

  /* highlight reel — "make a highlight reel of pricing complaints", "collect the best quotes about onboarding into a reel" */
  if ((m = /\b(?:highlight(?:s)?\s+reel|quote\s+reel|reel|highlights?)\b(?:\s+(?:of|on|about|for|with))?\s+(.{2,120})$/i.exec(text)) && /\b(?:make|create|build|put\s+together|collect|assemble|compile|show)\b/i.test(text)) {
    const topic = m[1].replace(/^(?:the|all|our)\s+/i, "").trim();
    if (topic && !/^(?:reel|highlights?)$/i.test(topic)) return { op: "highlight_reel", text, topic };
  }
  if ((m = /\b(?:collect|gather|pull)\s+(?:the\s+)?(?:best\s+)?(?:quotes|verbatims|clips)\s+(?:about|on|of)\s+(.{2,120}?)(?:\s+into\s+a\s+(?:reel|highlight\s+reel))?$/i.exec(text))) return { op: "highlight_reel", text, topic: m[1].trim() };

  /* compare groups — "compare Mumbai vs Delhi participants", "how do switchers differ from stayers" */
  if ((m = /\bcompare\s+(?:the\s+)?(.{2,40}?)\s+(?:vs\.?|versus|with|and|to|against)\s+(?:the\s+)?(.{2,40}?)(?:\s+(?:participants?|groups?|respondents?|interviewees?|segments?|people))?(?:\s+on\s+.+)?$/i.exec(text)) && (QUAL.test(text) || /\b(?:participants?|groups?|segments?|people)\b/i.test(text))) {
    const a = m[1].replace(/\s+(?:participants?|groups?|respondents?)$/i, "").trim(), b = m[2].trim();
    if (!/^(?:Q\d+|the\s+survey)$/i.test(a)) return { op: "compare_groups", text, a: cap(a), b: cap(b) };
  }
  if ((m = /\bhow\s+do(?:es)?\s+(?:the\s+)?(.{2,40}?)\s+differ\s+from\s+(?:the\s+)?(.{2,40}?)(?:\s+(?:participants?|groups?))?$/i.exec(text))) return { op: "compare_groups", text, a: cap(m[1].trim()), b: cap(m[2].trim()) };

  /* insights — "what are the key insights for objective 2", "key findings", "write the findings for objective two" */
  if (/\b(?:key\s+)?(?:insights?|findings|takeaways|conclusions)\b/i.test(text) && (QUAL.test(text) || /\bobjective\b/i.test(text)) && !/\b(?:report|deck|docx|pptx|word|powerpoint)\b/i.test(text)) {
    m = /\bobjective\s+(?:#|no\.?\s*)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(first|second|third|fourth|fifth)\s+objective\b/i.exec(text);
    const n = m ? (m[1] ? (Number(m[1]) || WORD_NUM[m[1].toLowerCase()]) : WORD_NUM[m[2].toLowerCase()]) : undefined;
    return { op: "insights", text, ...(n ? { objective: n } : {}) };
  }

  /* theme summaries — "summarise the themes", "write a summary of the price theme", "synthesise the interviews" */
  if (/\b(?:summari[sz]e|summary|summaries|synthesi[sz]e|synthesis|write\s+up)\b/i.test(text) && /\b(?:themes?|codes?|interviews?|transcripts?|focus\s+groups?|qual(?:itative)?\s+data|sessions?)\b/i.test(text)) {
    m = /\b(?:of|on|for|about)\s+(?:the\s+)?[“"']?([^“"']{2,40}?)[”"']?\s+theme\b/i.exec(text);
    const theme = m && !/^(?:each|every|all|the|my|our|main|key)$/i.test(m[1].trim()) ? m[1].trim() : undefined;
    return { op: "summarise_themes", text, ...(theme ? { theme } : {}) };
  }

  /* auto-coding — "code new interviews automatically", "turn off automatic coding" */
  if (/\b(?:auto(?:matic(?:ally)?)?[\s-]?cod(?:e|ing)|code\s+(?:new\s+|incoming\s+|completed\s+)?(?:interviews?|transcripts?|sessions?|sources?)\s+automatically)\b/i.test(text)) {
    return { op: "auto_code", text, enabled: !/\b(?:turn\s+off|stop|disable|switch\s+off|no\s+more)\b/i.test(text) };
  }

  /* a group session — "run a group session from the guide", "start a live text discussion with 50 people" */
  if (/\b(?:group\s+session|live\s+(?:text\s+)?(?:discussion|conversation|group)|remesh)\b/i.test(text) && /\b(?:run|start|set\s+up|create|launch|host)\b/i.test(text) && !/\bvideo\b/i.test(text)) {
    m = /\b(?:called|named|titled)\s+[“"']?(.{2,80}?)[”"']?$/i.exec(text);
    return { op: "group_session", text, mode: /\b(?:autonomous(?:ly)?|by\s+itself|without\s+(?:a\s+)?moderator|ai[\s-]moderated)\b/i.test(text) ? "autonomous" : "moderated", ...(m ? { title: m[1].trim() } : {}) };
  }

  /* a question about what participants said — "what did Gen Z say about price?" */
  if (/^(?:what|how)\s+(?:did|do|does)\s+.{2,60}?\s+(?:say|said|feel|think|talk)\b.*\b(?:about|of|on|regarding)\b/i.test(text) || /^what\s+(?:did|do)\s+(?:participants?|interviewees?|people)\b/i.test(text) || /\b(?:in|from)\s+the\s+(?:interviews|transcripts|focus\s+groups|group\s+sessions)\b.*\?$/i.test(raw.trim())) {
    /* "how did YOU feel about …" is a question to put to respondents, not one about the data */
    if (!/\bQ\d+\b/i.test(text) && !/^(?:what|how)\s+(?:did|do|does)\s+(?:you|we|i)\b/i.test(text)) return { op: "ask", text, question: text };
  }
  void t;
  return null;
}

/** what the card says the request is, before anything is done */
export function describeQualRequest(r: QualRequest): string {
  switch (r.op) {
    case "summarise_themes": return r.theme ? `Write an AI summary of the “${r.theme}” theme from its coded excerpts.` : "Write AI summaries of every theme from the coded excerpts.";
    case "insights": return r.objective ? `Write the key findings for objective ${r.objective} from the coded excerpts.` : "Write the study's key findings, objective by objective, from the coded excerpts.";
    case "compare_groups": return `Compare ${r.a} and ${r.b} participants theme by theme (counts by code, a quote from each).`;
    case "highlight_reel": return `Make a highlight reel of excerpts about “${r.topic}”.`;
    case "double_coding": return `Set up blind double-coding of ${r.overlapPct}% of each source's participant segments with ${r.coder === "ai" ? "you and the AI" : "you and a colleague"} as coders.`;
    case "ask": return `Answer “${r.question}” from the coded excerpts only, with citations.`;
    case "auto_code": return r.enabled ? "Code new transcripts and interviews automatically (as AI suggestions for review)." : "Stop coding new transcripts automatically.";
    case "group_session": return `Set up a ${r.mode} text group session from the guide${r.title ? ` called “${r.title}”` : ""}.`;
    case "schedule_live": return describeLiveSchedule(r);
  }
}
