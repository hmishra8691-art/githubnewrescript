/**
 * Q5 — THE OBSERVER ROOM OF AN AI INTERVIEW (2026-11-22): what the research team does while watching one interview
 * live — never seen or heard by the participant:
 *
 *   chat       a private message to the other observers
 *   marker     a moment marked in the interview ("pricing objection"), tied to the turn it was made at
 *   question   a question for the AI moderator to ask: queued, then asked at the participant's next answer (as the
 *              moderator's own follow-up, in the guide's neutral voice), or refused with the reason
 *
 * Live groups (many participants, observers watching video) wait on the media server (roadmap Q2); this is the room
 * for one-to-one AI interviews, where the transcript is the live feed.
 */
export const OBSERVER_NOTE_KINDS = ["chat", "marker", "question"] as const;
export type ObserverNoteKind = (typeof OBSERVER_NOTE_KINDS)[number];
export interface ObserverNoteInput { kind: ObserverNoteKind; text: string; turnSeq?: number }

const MAX: Record<ObserverNoteKind, number> = { chat: 1000, marker: 200, question: 300 };

/** what an observer may never ask a participant through the moderator */
const CONTACT = /\b(?:e-?mail|phone|mobile|whatsapp|address|postcode|zip code|surname|full name|last name|date of birth|password|account number|card number|bank|social security|passport|instagram|facebook|linkedin|where (?:do|exactly do) you live)\b/i;
const LINK = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{7,}\d/i;

/** a question for the moderator: [] when it may be asked, else why not */
export function observerQuestionProblems(text: string): string[] {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  if (!t) return ["the question is empty"];
  if (t.length > MAX.question) out.push(`a question for the moderator is at most ${MAX.question} characters`);
  if (LINK.test(t)) out.push("a question may not contain a link, an e-mail address or a phone number");
  if (CONTACT.test(t)) out.push("the moderator never asks for contact or identity details");
  if ((t.match(/\?/g) ?? []).length > 2) out.push("ask one question at a time");
  return out;
}

/** the question as the moderator asks it: one line, ending with a question mark */
export const observerQuestionText = (text: string): string => { const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX.question); return /[?？؟]$/.test(t) ? t : `${t.replace(/[.!]+$/, "")}?`; };

export function parseObserverNote(body: unknown): ObserverNoteInput | { error: string } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const kind = OBSERVER_NOTE_KINDS.find((k) => k === o.kind);
  if (!kind) return { error: "kind is chat, marker or question" };
  const text = String(o.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { error: kind === "marker" ? "name the moment you are marking" : "write something first" };
  if (text.length > MAX[kind]) return { error: `${kind === "chat" ? "a message" : kind === "marker" ? "a marker" : "a question"} is at most ${MAX[kind]} characters` };
  if (kind === "question") { const p = observerQuestionProblems(text); if (p.length) return { error: `Not sent to the moderator: ${p.join("; ")}.` }; }
  const seq = Number(o.turnSeq);
  return { kind, text: kind === "question" ? observerQuestionText(text) : text, ...(Number.isInteger(seq) && seq >= 0 ? { turnSeq: seq } : {}) };
}
