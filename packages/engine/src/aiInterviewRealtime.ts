import { MODERATOR_RULES, moderatorGuideBlock, type ModeratorPlan, type PreparedTurn } from "./aiModerator.js";

/**
 * REALTIME (SPEECH-TO-SPEECH) AI INTERVIEWS — THE ENGINE'S HALF (G1 2026-10-22).
 *
 * A realtime provider (OpenAI Realtime over WebRTC) hears the participant and speaks the moderator's turn
 * itself, so the moderator's words cannot be checked before they are heard. To keep the guide, the probes
 * and the safety rules in charge the provider is used in a GATED way:
 *
 *   - the session never answers on its own (`create_response: false`): the participant's transcribed
 *     words go to the runtime first, through the engine's rules (distress, abuse, stop, injection,
 *     contact details, caps, conditional probes) exactly like a text answer;
 *   - a RULES turn (check-in, boundary, closing, conditional probe, scripted fallback) is spoken from a
 *     verbatim instruction — the provider is told to say exactly that text, and its transcript is
 *     compared afterwards;
 *   - a MODEL turn is spoken by the provider under this turn's instructions (the guide, the allowed
 *     intents, the next step), and it reports what it did with one TOOL CALL (probe / next_question /
 *     check_in / end_interview, with the objectives covered). Its spoken transcript then goes through
 *     the same output checks as a written reply (`finishTurn`); a failure is FLAGGED and the scripted turn
 *     is spoken next as a correction. Unlike text and the voice conversation, this check is post hoc —
 *     the doc says so, and the Studio says so beside the option.
 */

export const REALTIME_TOOLS = [
  { type: "function", name: "probe", description: "You asked a follow-up question about the participant's last answer (or a clarifying question).", parameters: { type: "object", properties: { reason: { type: "string" }, covered: { type: "array", items: { type: "string" } }, clarify: { type: "boolean" } }, required: ["reason"] } },
  { type: "function", name: "next_question", description: "You moved on and asked the NEXT STEP of the guide.", parameters: { type: "object", properties: { reason: { type: "string" }, covered: { type: "array", items: { type: "string" } } }, required: ["reason"] } },
  { type: "function", name: "check_in", description: "The participant seemed distressed: you checked in and asked whether they want to stop or continue.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { type: "function", name: "end_interview", description: "The guide is finished: you thanked the participant and closed the interview.", parameters: { type: "object", properties: { reason: { type: "string" }, covered: { type: "array", items: { type: "string" } } }, required: ["reason"] } },
] as const;

const TOOL_INTENT: Record<string, string> = { probe: "probe", next_question: "next", check_in: "check_in", end_interview: "close" };

const SPOKEN_RULES = `YOU ARE SPEAKING ALOUD in a live voice interview. Say the reply as natural speech in the participant's language (no lists, no markdown), keep it under 60 words, then call EXACTLY ONE tool that names what you did (probe, next_question, check_in or end_interview) with the objectives covered. Never speak unless a response is requested. If you are told to say exact words, say exactly those words and call no tool.`;

/** the session's standing instructions (the guide; it speaks only when a response is requested) */
export function realtimeSessionInstructions(plan: ModeratorPlan): string {
  return [MODERATOR_RULES, SPOKEN_RULES, moderatorGuideBlock(plan)].join("\n\n");
}

/** one MODEL turn: the same rules, guide and turn context as a written turn, for the provider to speak */
export function realtimeTurnInstructions(plan: ModeratorPlan, prepared: Extract<PreparedTurn, { kind: "model" }>): string {
  return [prepared.request.system[0], SPOKEN_RULES, prepared.request.system[1], prepared.request.user,
    `ALLOWED TOOLS NOW: ${prepared.ctx.allowed.map((i) => (i === "probe" || i === "clarify" ? "probe" : i === "next" ? "next_question" : i === "close" ? "end_interview" : i === "check_in" ? "check_in" : i)).filter((v, i, a) => a.indexOf(v) === i).join(" | ")}`].join("\n\n");
}

/** one RULES turn: exact words to speak */
export function realtimeVerbatimInstructions(text: string): string {
  return `Say exactly the following words, warmly and naturally, in their language, and nothing else. Do not add, translate or change anything, and call no tool:\n"""${String(text).replace(/"""/g, "”")}"""`;
}

/** the provider's spoken turn + its tool call → the reply `finishTurn` checks (intent from the tool; none = no intent) */
export function realtimeReplyFrom(transcript: string, call: { name?: string; arguments?: unknown } | null | undefined): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  const raw = call?.arguments;
  if (typeof raw === "string") { try { args = JSON.parse(raw) as Record<string, unknown>; } catch { args = {}; } }
  else if (raw && typeof raw === "object") args = raw as Record<string, unknown>;
  const name = String(call?.name ?? "");
  const intent = name === "probe" && args.clarify === true ? "clarify" : TOOL_INTENT[name] ?? "";
  return { intent, say: String(transcript ?? "").replace(/\s+/g, " ").trim(), reason: typeof args.reason === "string" ? args.reason.slice(0, 200) : intent || "realtime turn", covered: Array.isArray(args.covered) ? args.covered.map(String) : [] };
}

/** did the provider say what it was told to say (a verbatim turn)? Word overlap ≥ 70% (speech transcripts differ in punctuation, case, numerals) */
export function spokeVerbatim(expected: string, transcript: string): boolean {
  const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const e = words(expected), t = new Set(words(transcript));
  if (!e.length) return true;
  /* scripts without spaces (CJK): compare characters */
  if (e.length <= 2 && expected.length > 12) { const ec = [...expected.replace(/\s/g, "")]; const tc = new Set([...transcript.replace(/\s/g, "")]); return ec.filter((c) => tc.has(c)).length / ec.length >= 0.7; }
  return e.filter((w) => t.has(w)).length / e.length >= 0.7;
}
